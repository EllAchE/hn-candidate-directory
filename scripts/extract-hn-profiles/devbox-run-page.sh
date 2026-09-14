#!/usr/bin/env bash
# One backfill page, end to end: gate, prepare and fetch resumes here, extract on the dev box,
# check, assemble and push here. The credential and the nonce->id maps never leave this machine;
# see the skill's "Running step 3 elsewhere" section for why that split is the whole point.
#
# Two extraction passes. The first reads every item with the resume from its `Résumé/CV:` line
# already sealed into the batch. The second is targeted: items whose draft named a link the label
# missed, plus items that had a resume and still came back without a name or employer, which is
# the miss the strict check exists to catch. Nothing on the box fetches: resumes are attached here,
# through the unblocker, and travel inside the sealed batch like the comment text does.
#
# A page is however many rows the pending endpoint hands back -- it has no cursor, so the next
# page is only released by pushing this one. That makes the loop strictly serial: one page per
# invocation, and the page tag only has to be unique per run.
#
#   HNCD_HOLD_MISSES=1   keep an item the final check flags out of the push (default: push, report)
#   HNCD_PASSES=1        skip the targeted second pass
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
PASSES="${HNCD_PASSES:-2}"
HERE="$(cd "$(dirname "$0")" && pwd)"

gc() { gcloud compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap --project="$PROJECT" "$@"; }
# jq's `add` over objects keeps the last value per key; per-reason counts need a sum.
SUM='def sum_by(f): reduce (.[] | f // {}) as $m ({}; reduce ($m | to_entries[]) as $e (.; .[$e.key] += $e.value));'

mkdir -p "$RUN"

# --- gate -------------------------------------------------------------------
node "$HERE/hncd-api.mjs" pending --host "$HOST" >"$RUN/pending.json" || exit 1
before=$(jq -r '.remaining' "$RUN/pending.json")
echo "$PAGE: pending before = $before"
[ "$before" = "0" ] && { echo "$PAGE: nothing to do"; exit 0; }

# --- prepare sealed batches -------------------------------------------------
# The prepare step already names every pending item Algolia returned no text for -- usually a comment
# its author later deleted -- and reducing its output to batches and items threw that list away, so a
# page that went in with 100 and came out with 99 read as a clean run and the lost candidate was found
# only by counting map entries by hand. An empty `dropped` prints too: it is what says nothing was lost.
node "$HERE/hn-prepare-batch.mjs" --pending "$RUN/pending.json" --out "$RUN" --batch 5 \
  | jq -c '{batches:(.batches|length), items:([.batches[].items]|add), dropped:.missing}' || exit 1
nb=$(cd "$RUN" && ls batch-*.json 2>/dev/null | grep -vc '\.map\.')
[ "${nb:-0}" -gt 0 ] || { echo "$PAGE: no batches prepared"; exit 1; }

# --- resumes, pass 1: the link on each comment's own Résumé/CV line -----------
# Sealed into the batch in place, so the extractor, the pronoun screen and assembly all see the
# same text. A miss here is normal (LinkedIn, a viewer wall, a scanned PDF) and is only reported.
for n in $(seq 1 "$nb"); do
  node "$HERE/hn-attach-resumes.mjs" --batch "$RUN/batch-$n.json" --out "$RUN"
done | jq -s -c "$SUM"'{attached:([.[].attached]|add), fetched:([.[].fetched]|add), misses:sum_by(.misses)}' \
  | sed "s/^/$PAGE: resumes pass 1 /"

# --- extract remotely -------------------------------------------------------
# The batch script travels with the batches, so the box runs this checkout's framing rather than
# whatever its own clone happens to be on; it still cds into that clone for the agent definition.
# tmux, not `setsid nohup`: both survive the ssh channel closing, but a tmux session can be
# inspected and killed by name afterwards, and a stalled pool is otherwise invisible.
#   remote_extract <local-dir> <remote-subdir> <tmux-name> "<batch numbers>"
remote_extract() {
  local local_dir="$1" remote="$2" session="$3" nums="$4" count
  count=$(wc -w <<<"$nums" | tr -d ' ')
  ( cd "$local_dir" && cp "$HERE/devbox-extract-batch.sh" . && tar czf ship.tgz devbox-extract-batch.sh $(ls batch-*.json | grep -v '\.map\.') ) || return 1
  if tar tzf "$local_dir/ship.tgz" | grep -q '\.map\.'; then
    echo "$PAGE: ABORT -- a nonce->id map reached the tarball"; return 1
  fi
  gcloud compute scp --tunnel-through-iap --project="$PROJECT" --zone="$ZONE" \
    "$local_dir/ship.tgz" "$VM:/tmp/ship-$session.tgz" >/dev/null || return 1

  gc --command="mkdir -p ~/$remote && tar xzf /tmp/ship-$session.tgz -C ~/$remote && rm -f /tmp/ship-$session.tgz && cd ~/$REMOTE_REPO && tmux new-session -d -s $session \"export HNCD_RUN_DIR=\\\$HOME/$remote; printf '%s\\\\n' $nums | xargs -P $LANES -I{} bash \\\$HNCD_RUN_DIR/devbox-extract-batch.sh {} > \\\$HNCD_RUN_DIR/run.log 2>&1\" && echo launched" >/dev/null 2>&1

  # Wait in one remote loop rather than one ssh per poll -- the round trip costs more than the
  # check. Give up when the pool is gone, not only when every draft landed: a batch the model
  # never answered leaves no file and would otherwise hang here for the full timeout.
  gc --command="for i in \$(seq 1 260); do n=\$(ls ~/$remote/drafts-*.json 2>/dev/null | wc -l); [ \"\$n\" -ge $count ] && { echo \"extracted \$n/$count\"; break; }; ps -eo cmd | grep -qE 'devbox-extract-batch\.sh [0-9]+\$' || { echo \"pool idle at \$n/$count\"; break; }; sleep 10; done" 2>/dev/null

  gc --command="cd ~/$remote && tar czf /tmp/d-$session.tgz drafts-*.json" >/dev/null 2>&1
  gcloud compute scp --tunnel-through-iap --project="$PROJECT" --zone="$ZONE" \
    "$VM:/tmp/d-$session.tgz" "$local_dir/d.tgz" >/dev/null || return 1
  tar xzf "$local_dir/d.tgz" -C "$local_dir" || return 1
}

remote_extract "$RUN" "$REMOTE_DIR" "hncd-$PAGE" "$(seq 1 "$nb" | tr '\n' ' ')" || exit 1

# --- pass 2: model-chosen links, and resume items that still lack a name or employer ------------
if [ "$PASSES" -ge 2 ]; then
  mkdir -p "$RUN/pass2"
  for n in $(seq 1 "$nb"); do
    [ -s "$RUN/drafts-$n.json" ] || continue
    node "$HERE/hn-check-drafts.mjs" --batch "$RUN/batch-$n.json" --drafts "$RUN/drafts-$n.json" --out "$RUN/check-$n.json" >/dev/null
    node "$HERE/hn-attach-resumes.mjs" --batch "$RUN/batch-$n.json" --out "$RUN" \
      --drafts "$RUN/drafts-$n.json" --retry "$RUN/check-$n.json" --write "$RUN/pass2/batch-$n.json"
  done | jq -s -c "$SUM"'{fetched:([.[].fetched]|add), misses:sum_by(.misses), retried_items:([.[].written]|add)}' \
    | sed "s/^/$PAGE: resumes pass 2 /"

  nums=$(cd "$RUN/pass2" && ls batch-*.json 2>/dev/null | sed -E 's/batch-([0-9]+)\.json/\1/' | tr '\n' ' ')
  if [ -n "${nums// /}" ]; then
    remote_extract "$RUN/pass2" "$REMOTE_DIR/pass2" "hncd-$PAGE-p2" "$nums" || exit 1
    for n in $nums; do
      [ -s "$RUN/pass2/drafts-$n.json" ] || { echo "$PAGE: pass 2 batch $n produced no drafts" >&2; continue; }
      node "$HERE/hn-merge-drafts.mjs" --base "$RUN/drafts-$n.json" --over "$RUN/pass2/drafts-$n.json" --out "$RUN/drafts-$n.json"
    done | jq -s -c '{merged_batches:length, replaced:([.[].replaced]|add)}' | sed "s/^/$PAGE: pass 2 /"
  else
    echo "$PAGE: pass 2 had nothing to retry"
  fi
fi

# --- strict miss check: an empty field the source answers is a miss, reported per page ----------
for n in $(seq 1 "$nb"); do
  [ -s "$RUN/drafts-$n.json" ] || { echo "$PAGE: batch $n produced no drafts" >&2; continue; }
  node "$HERE/hn-check-drafts.mjs" --batch "$RUN/batch-$n.json" --drafts "$RUN/drafts-$n.json" --out "$RUN/check-$n.json"
done | jq -s -c "$SUM"'{items:([.[].items]|add), with_resume:([.[].withResume]|add), retired:([.[].retired]|add), flagged:([.[].flagged]|add), missing:sum_by(.missing)}' \
  | sed "s/^/$PAGE: misses /"
jq -s '[.[].flagged[]]' "$RUN"/check-*.json >"$RUN/misses-$PAGE.json"
echo "$PAGE: flagged items listed in $RUN/misses-$PAGE.json"

# Screen before assembling, not after: a summary that genders a candidate the source never
# gendered is dropped here, while the nonce still links it to its own text. Counting the leaks
# after the push would only tell you which real people you had already published a guess about.
for n in $(seq 1 "$nb"); do
  [ -s "$RUN/drafts-$n.json" ] || continue
  node "$HERE/hn-screen-pronouns.mjs" --batch "$RUN/batch-$n.json" --drafts "$RUN/drafts-$n.json" \
    --out "$RUN/screened-$n.json" | jq -c --arg n "$n" '{batch:$n} + {dropped}' | grep -v '"dropped":\[\]' || true
  if [ "${HNCD_HOLD_MISSES:-0}" = "1" ] && [ -s "$RUN/check-$n.json" ]; then
    jq --slurpfile c "$RUN/check-$n.json" '[.[] | select(.nonce as $x | ($c[0].flagged | map(.nonce) | index($x)) == null)]' \
      "$RUN/screened-$n.json" >"$RUN/screened-$n.held.json" && mv "$RUN/screened-$n.held.json" "$RUN/screened-$n.json"
  fi
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
