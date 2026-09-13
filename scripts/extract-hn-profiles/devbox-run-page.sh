#!/usr/bin/env bash
# One backfill page, end to end: gate and prepare here, extract on the dev box, assemble and
# push here. The credential and the nonce->id maps never leave this machine; see the skill's
# "Running step 3 elsewhere" section for why that split is the whole point.
#
# A page is however many rows the pending endpoint hands back -- it has no cursor, so the next
# page is only released by pushing this one. That makes the loop strictly serial: one page per
# invocation, and the page tag only has to be unique per run.
set -uo pipefail

PAGE="${1:?usage: devbox-run-page.sh <page-tag>}"
HOST="${HNCD_HOST:?set HNCD_HOST to the worker origin}"
RUN="${HNCD_RUN_ROOT:-/tmp/claude/hncd}/$PAGE"
VM="${HNCD_VM:-dev-vm}"
ZONE="${HNCD_VM_ZONE:-us-central1-a}"
PROJECT="${HNCD_VM_PROJECT:-durable-alpha}"
REMOTE_DIR="hncd-backfill/$PAGE"
REMOTE_REPO="${HNCD_REMOTE_REPO:-hn-candidate-directory}"
LANES="${HNCD_LANES:-4}"
HERE="$(cd "$(dirname "$0")" && pwd)"

gc() { gcloud compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap --project="$PROJECT" "$@"; }

mkdir -p "$RUN"

# --- gate -------------------------------------------------------------------
node "$HERE/hncd-api.mjs" pending --host "$HOST" >"$RUN/pending.json" || exit 1
before=$(jq -r '.remaining' "$RUN/pending.json")
echo "$PAGE: pending before = $before"
[ "$before" = "0" ] && { echo "$PAGE: nothing to do"; exit 0; }

# --- prepare sealed batches -------------------------------------------------
node "$HERE/hn-prepare-batch.mjs" --pending "$RUN/pending.json" --out "$RUN" --batch 5 \
  | jq -c '{batches:(.batches|length), items:([.batches[].items]|add)}' || exit 1
nb=$(cd "$RUN" && ls batch-*.json 2>/dev/null | grep -vc '\.map\.')
[ "${nb:-0}" -gt 0 ] || { echo "$PAGE: no batches prepared"; exit 1; }

# --- ship: batches only, never the maps -------------------------------------
( cd "$RUN" && tar czf ship.tgz $(ls batch-*.json | grep -v '\.map\.') ) || exit 1
if tar tzf "$RUN/ship.tgz" | grep -q '\.map\.'; then
  echo "$PAGE: ABORT -- a nonce->id map reached the tarball"; exit 1
fi
gcloud compute scp --tunnel-through-iap --project="$PROJECT" --zone="$ZONE" \
  "$RUN/ship.tgz" "$VM:/tmp/ship-$PAGE.tgz" >/dev/null || exit 1

# --- extract remotely -------------------------------------------------------
# tmux, not `setsid nohup`: both survive the ssh channel closing, but a tmux session can be
# inspected and killed by name afterwards, and a stalled pool is otherwise invisible.
gc --command="mkdir -p ~/$REMOTE_DIR && tar xzf /tmp/ship-$PAGE.tgz -C ~/$REMOTE_DIR && rm -f /tmp/ship-$PAGE.tgz && cd ~/$REMOTE_REPO && tmux new-session -d -s hncd-$PAGE \"export HNCD_RUN_DIR=\\\$HOME/$REMOTE_DIR; seq 1 $nb | xargs -P $LANES -I{} ./scripts/extract-hn-profiles/devbox-extract-batch.sh {} > \\\$HNCD_RUN_DIR/run.log 2>&1\" && echo launched" >/dev/null 2>&1

# Wait in one remote loop rather than one ssh per poll -- the round trip costs more than the
# check. Give up when the pool is gone, not only when every draft landed: a batch the model
# never answered leaves no file and would otherwise hang here for the full timeout.
gc --command="for i in \$(seq 1 220); do n=\$(ls ~/$REMOTE_DIR/drafts-*.json 2>/dev/null | wc -l); [ \"\$n\" -ge $nb ] && { echo \"extracted \$n/$nb\"; break; }; ps -eo cmd | grep -qE 'devbox-extract-batch\.sh [0-9]+\$' || { echo \"pool idle at \$n/$nb\"; break; }; sleep 10; done" 2>/dev/null

# --- pull drafts and land ---------------------------------------------------
gc --command="cd ~/$REMOTE_DIR && tar czf /tmp/d-$PAGE.tgz drafts-*.json" >/dev/null 2>&1
gcloud compute scp --tunnel-through-iap --project="$PROJECT" --zone="$ZONE" \
  "$VM:/tmp/d-$PAGE.tgz" "$RUN/d.tgz" >/dev/null || exit 1
tar xzf "$RUN/d.tgz" -C "$RUN" || exit 1

# Screen before assembling, not after: a summary that genders a candidate the source never
# gendered is dropped here, while the nonce still links it to its own text. Counting the leaks
# after the push would only tell you which real people you had already published a guess about.
for n in $(seq 1 "$nb"); do
  [ -s "$RUN/drafts-$n.json" ] || { echo "$PAGE: batch $n produced no drafts" >&2; continue; }
  node "$HERE/hn-screen-pronouns.mjs" --batch "$RUN/batch-$n.json" --drafts "$RUN/drafts-$n.json" \
    --out "$RUN/screened-$n.json" | jq -c --arg n "$n" '{batch:$n} + {dropped}' | grep -v '"dropped":\[\]' || true
done
screened=$(for n in $(seq 1 "$nb"); do [ -s "$RUN/screened-$n.json" ] && jq '[.[] | select(.draft.summary != null)] | length' "$RUN/screened-$n.json"; done | jq -s add)
echo "$PAGE: summaries surviving the pronoun screen = ${screened:-0}"

for n in $(seq 1 "$nb"); do
  [ -s "$RUN/screened-$n.json" ] || continue
  node "$HERE/hn-assemble-push.mjs" --batch "$RUN/batch-$n.json" --drafts "$RUN/screened-$n.json" \
    --out "$RUN/push-$n.json" 2>/dev/null | jq -c '{p:.profiles, r:(.rejected|length), t:(.trimmed|length), s:(.skipped|length)}'
done | jq -s -c '{assembled:([.[].p]|add), rejected:([.[].r]|add), trimmed:([.[].t]|add), skipped:([.[].s]|add)}'

for n in $(seq 1 "$nb"); do
  [ -f "$RUN/push-$n.json" ] || continue
  node "$HERE/hncd-api.mjs" push --file "$RUN/push-$n.json" --host "$HOST" 2>/dev/null \
    | jq -c '{pending, o:([.results[]?.outcome] | group_by(.) | map({(.[0]): length}) | add)}'
  sleep 1
done | jq -s -c '{pending_after:(.[-1].pending), updated:([.[].o.updated//0]|add), retired:([.[].o.retired//0]|add), invalid_draft:([.[].o.invalid_draft//0]|add), blocked:([.[].o.blocked_by_status//0]|add), suppressed:([.[].o.skipped_suppressed//0]|add)}'
