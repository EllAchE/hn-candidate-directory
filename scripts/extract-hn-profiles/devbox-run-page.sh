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
# tag, and a tag that has pushed is finished.
#
# Re-running a tag resumes it. The prepared batches and their maps are reused rather than prepared
# again, because a push changes what pending returns and a re-prepare mints new nonces that no
# draft already on the box can match. Each stage marks itself done under state/, drafts already on
# the box are pulled back before anything ships, and only batches still without a draft go out.
#
# One outcome per item. The pending endpoint only advances a row that is pushed, so after assembly
# every item this page read gets exactly one: a pushed draft, a retirement (`draft: null`, only for a
# comment Firebase confirms is gone) or a hold (`hold: true`). The holds are everything else --
# every page id minus the drafted-and-pushed minus the retired -- so a batch that came back empty, a
# missing or malformed draft, a dropped comment that is alive or unreachable, and anything no one
# anticipated all step out instead of heading every later page. A hold writes no profile and only
# raises this extractor's rank; a newer extractor reads the row again. Step-outs go out in the push
# stage with the drafts, never earlier, so a tag stays restartable with HNCD_FRESH until then.
#
#   HNCD_FRESH=1         discard this tag's unpushed run, here and on the box, and prepare again
#   HNCD_HOLD_MISSES=1   hold an item the final check flags even though it has a draft, instead of
#                        publishing it (default: push, report). Items with no draft are held either way.
#   HNCD_PASSES=1        skip the targeted second pass
#   HNCD_SSH_TIMEOUT     seconds any one ssh or scp may take (default 300)
#   HNCD_POLL_SECONDS    seconds one readiness poll waits on the box (default 2600)
#   HNCD_POLL_TRIES      fresh polls after one ends without an answer, before giving up (default 3)
set -uo pipefail

PAGE="${1:?usage: devbox-run-page.sh <page-tag>}"
HOST="${HNCD_HOST:?set HNCD_HOST to the worker origin}"
RUN="${HNCD_RUN_ROOT:-/tmp/claude/hncd}/$PAGE"
STATE="$RUN/state"
VM="${HNCD_VM:-dev-vm}"
ZONE="${HNCD_VM_ZONE:-us-central1-a}"
PROJECT="${HNCD_VM_PROJECT:-durable-alpha}"
REMOTE_DIR="hncd-backfill/$PAGE"
REMOTE_REPO="${HNCD_REMOTE_REPO:-hn-candidate-directory}"
LANES="${HNCD_LANES:-4}"
PASSES="${HNCD_PASSES:-2}"
SSH_TIMEOUT="${HNCD_SSH_TIMEOUT:-300}"
POLL_SECONDS="${HNCD_POLL_SECONDS:-2600}"
POLL_INTERVAL="${HNCD_POLL_INTERVAL:-10}"
POLL_TRIES="${HNCD_POLL_TRIES:-3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# One id for the queue read, the drafts and the step-outs: a step-out raises the rank to this
# extractor's, and a mismatch would leave the row pending for the one that was actually read.
EXTRACTOR_ID="claude-skill-v2"
AGENT_SPEC="$HERE/../../.claude/agents/hn-profile-extractor.md"

# The tag is spliced into remote shell commands and tmux session names.
[[ "$PAGE" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "page tag may only use letters, digits, '.', '_' and '-'" >&2; exit 2; }

# A dead IAP tunnel does not fail an ssh, it hangs it: on 2026-09-27 the Mac slept, the tunnel went,
# and the readiness poll sat for ten hours. Every remote call gets a local deadline. macOS ships no
# GNU timeout, so without coreutils this falls back to a perl watchdog that kills the whole group.
# Both move the command out of the terminal's foreground group, where an ssh reading the tty would
# be stopped rather than served, so stdin is closed.
bounded() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout -k 10 "$secs" "$@" </dev/null
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout -k 10 "$secs" "$@" </dev/null
  else
    perl -MPOSIX=:sys_wait_h -e 'my $t = shift; setpgrp(0, 0); my $pid = fork; defined $pid or die "fork: $!";
      if (!$pid) { exec @ARGV or exit 127 }
      $SIG{ALRM} = sub { $SIG{TERM} = "IGNORE"; kill "TERM", -$$;
        for (1 .. 10) { exit 124 if waitpid($pid, WNOHANG) > 0; sleep 1 } kill "KILL", $pid; exit 124 };
      alarm $t; waitpid($pid, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' "$secs" "$@" </dev/null
  fi
}
SSH=(gcloud compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap --project="$PROJECT")
gc() { bounded "$SSH_TIMEOUT" "${SSH[@]}" "$@"; }
gscp() { bounded "$SSH_TIMEOUT" gcloud compute scp --tunnel-through-iap --project="$PROJECT" --zone="$ZONE" "$@"; }
mark() { mkdir -p "$STATE" && : >"$STATE/$1"; }
reached() { [ -f "$STATE/$1" ]; }
# jq's `add` over objects keeps the last value per key; per-reason counts need a sum.
SUM='def sum_by(f): reduce (.[] | f // {}) as $m ({}; reduce ($m | to_entries[]) as $e (.; .[$e.key] += $e.value));'

# ids on stdin, one per line -> step-out payloads of at most 25 (the push endpoint's batch limit),
# numbered from 1. Sorted and de-duplicated, so the same ids always make the same files. Each entry
# carries its id's reason from the optional {id: reason} map, so the Worker records why it stepped
# out; an id the map does not name goes without one and is recorded as `unrecorded`.
#   write_stepouts <prefix> <jq entry for id $id> [reasons-json]
write_stepouts() {
  local prefix="$1" entry="$2" why="${3:-}" i=0 chunk
  [ -n "$why" ] || why='{}'
  jq -R -s -c --arg x "$EXTRACTOR_ID" --argjson why "$why" "[split(\"\\n\")[] | select(. != \"\")] | unique
    | [range(0; length; 25) as \$i | .[\$i:\$i+25]][] | {extractor:\$x, profiles:map(. as \$id | $entry + (if \$why[\$id] then {reason:\$why[\$id]} else {} end))}" \
    | while IFS= read -r chunk; do i=$((i + 1)); printf '%s\n' "$chunk" >"$prefix-$i.json"; done
}

mkdir -p "$RUN"

fresh_flag=""
[ "${HNCD_FRESH:-0}" = "1" ] && fresh_flag="--fresh"
plan=$(node "$HERE/hn-page-state.mjs" plan --run "$RUN" $fresh_flag) || exit 1
action=$(jq -r '.action' <<<"$plan" 2>/dev/null)
case "$action" in
  refuse) echo "$PAGE: refusing -- $(jq -r '.reason' <<<"$plan")" >&2; exit 1 ;;
  resume) echo "$PAGE: resuming -- $(jq -c '{batches, stages, pushed}' <<<"$plan")" ;;
  fresh) ;;
  *) echo "$PAGE: cannot plan the run: $plan" >&2; exit 1 ;;
esac

if [ "$action" = fresh ]; then
  # --- gate -------------------------------------------------------------------
  # Read only on a fresh run: pending has no cursor and a push changes what it returns, so a
  # resumed run rebuilding its batches from it would get a different page with new nonces.
  node "$HERE/hncd-api.mjs" pending --extractor "$EXTRACTOR_ID" --host "$HOST" >"$RUN/pending.json" || exit 1
  before=$(jq -r '.remaining' "$RUN/pending.json")
  echo "$PAGE: pending before = $before"
  [ "$before" = "0" ] && { echo "$PAGE: nothing to do"; exit 0; }

  # --- clear the previous run of this page ----------------------------------
  # Every per-batch artefact, not just drafts: the tail stages address batches by number, so a re-run
  # preparing fewer batches than the last one silently screens and pushes the previous run's files for
  # every surplus number. `resume-*` survives on purpose -- it is a content-keyed fetch cache, and
  # re-fetching every resume is the expensive part of a page. The box is cleared by the first ship,
  # which `wipe-remote` asks for until it has happened.
  rm -rf "$RUN/pass2" "$RUN/incoming" "$STATE"
  rm -f "$RUN"/batch-*.json "$RUN"/drafts-*.json "$RUN"/screened-*.json "$RUN"/check-*.json \
    "$RUN"/push-*.json "$RUN/misses-$PAGE.json" "$RUN/prepare.json" "$RUN/ship.tgz" "$RUN/d.tgz" \
    "$RUN"/retire-*.json "$RUN"/hold-*.json "$RUN/dropped.json" "$RUN/sources.json" "$RUN/holds.json"
  mark wipe-remote

  # --- prepare sealed batches -----------------------------------------------
  # The prepare step already names every pending item Algolia returned no text for -- usually a comment
  # its author later deleted -- and reducing its output to batches and items threw that list away, so a
  # page that went in with 100 and came out with 99 read as a clean run and the lost candidate was found
  # only by counting map entries by hand. An empty `dropped` prints too: it is what says nothing was lost.
  node "$HERE/hn-prepare-batch.mjs" --pending "$RUN/pending.json" --out "$RUN" --batch 5 \
    >"$RUN/prepare.json" || exit 1
  jq -c '{batches:(.batches|length), items:([.batches[].items]|add), dropped:.missing}' "$RUN/prepare.json"
fi

# Take the batch count from prepare's own output: a glob answers "what is on disk", which promotes
# a stray or half-written file into a batch number the rest of the run then polls the box for.
nb=$(jq -r '.batches | length' "$RUN/prepare.json" 2>/dev/null) || nb=""
[[ "$nb" =~ ^[0-9]+$ ]] || { echo "$PAGE: prepare.json lists no batches" >&2; exit 1; }
mark prepared

# --- push -------------------------------------------------------------------
# A marker covers exactly one push request, i.e. one payload file: `pushed-<n>` is push-<n>.json,
# the drafts of batch n (never more than one prepared batch of 5), and `pushed-retire-<k>` /
# `pushed-hold-<k>` are step-out payload k (at most 25 ids each). Payloads are written once --
# retirements when the source check lands, drafts and holds when assembly finishes -- and never
# rebuilt after, so a marker always names the request that actually went out. A run that dies
# mid-push resumes with the payloads it had not reached and never sends one twice; a crash between
# a landed request and its marker re-sends only that one, which the endpoint absorbs (a draft
# updates in place, a step-out only raises a rank that is already raised). The page is marked done
# only when every push landed.
payload_file() { case "$1" in *-*) echo "$RUN/$1.json" ;; *) echo "$RUN/push-$1.json" ;; esac; }
payloads() {
  local k n
  for ((k = 1; ; k++)); do [ -f "$RUN/retire-$k.json" ] || break; echo "retire-$k"; done
  for ((n = 1; n <= nb; n++)); do [ -f "$RUN/push-$n.json" ] && echo "$n"; done
  for ((k = 1; ; k++)); do [ -f "$RUN/hold-$k.json" ] || break; echo "hold-$k"; done
}
# `other` carries every outcome not named, so an outcome nobody anticipated is counted instead of
# vanishing from the tally line.
push_stage() {
  local p out
  rm -f "$STATE/push-failed"
  for p in $(payloads); do
    reached "pushed-$p" && { echo "$PAGE: $p already pushed" >&2; continue; }
    if out=$(node "$HERE/hncd-api.mjs" push --file "$(payload_file "$p")" --host "$HOST" 2>/dev/null); then
      mark "pushed-$p"
      jq -c '{pending, o:([.results[]?.outcome] | group_by(.) | map({(.[0]): length}) | add)}' <<<"$out"
    else
      echo "$PAGE: push of $p failed" >&2
      mark push-failed
    fi
    sleep 1
  done | jq -s -c "$SUM"'sum_by(.o) as $o | {pending_after:(.[-1].pending), created:($o.created//0), updated:($o.updated//0), retired:($o.retired//0), held:($o.held//0), invalid_draft:($o.invalid_draft//0), blocked:($o.blocked_by_status//0), suppressed:($o.skipped_suppressed//0), other:($o | del(.created, .updated, .retired, .held, .invalid_draft, .blocked_by_status, .skipped_suppressed))}'

  if reached push-failed; then
    echo "$PAGE: some pushes failed; re-run this tag to retry only those" >&2
    exit 1
  fi
  mark pushed
  echo "$PAGE: pushed; this tag is finished"
}

# --- check what prepare dropped against Firebase, once --------------------------------------------
# Absent from Algolia is not proof of deletion (a thread listing can simply miss an item), so only
# the ids hn-check-sources marks deleted, dead, missing or textless become retirements; the alive and
# `unreachable` ones are held at assembly. The answer is kept in sources.json and turned into
# retire-<k>.json once, so a resumed run pushes the same retirements instead of asking Firebase again.
# A check that fails outright is not marked, and the next run of the tag asks again -- until assembly,
# which freezes the outcomes and holds whatever went unchecked.
if ! reached sources-checked && ! reached assembled; then
  rm -f "$RUN"/retire-*.json "$RUN/dropped.json" "$RUN/sources.json"
  if [ "$(jq '.missing // [] | length' "$RUN/prepare.json")" -gt 0 ]; then
    jq --slurpfile p "$RUN/prepare.json" '($p[0].missing | map(tostring)) as $ids
      | {remaining, items:[(.items // [])[] | select((.hnItemId | tostring) as $i | $ids | index($i))]}' \
      "$RUN/pending.json" >"$RUN/dropped.json"
    if out=$(node "$HERE/hn-check-sources.mjs" --pending "$RUN/dropped.json" --out "$RUN/sources.json") \
      && [ -s "$RUN/sources.json" ]; then
      echo "$PAGE: dropped sources $out"
      jq -r '.ids // {} | keys[]' "$RUN/sources.json" | write_stepouts "$RUN/retire" '{hnItemId:$id, draft:null}' \
        "$(node "$HERE/hn-page-state.mjs" retire-reasons --sources "$RUN/sources.json")"
      mark sources-checked
    else
      echo "$PAGE: could not check the dropped items' sources; re-run before assembly to retry, or they are held" >&2
      rm -f "$RUN/sources.json"
    fi
  else
    mark sources-checked
  fi
fi

# --- one outcome per item ---------------------------------------------------------------------------
# Holds every page id without a pushed draft or a retirement, from the payloads already written, and
# prints why per reason. Written once, at the `assembled` marker, like every other payload.
assemble_holds() {
  local out
  if ! out=$(node "$HERE/hn-page-state.mjs" holds --run "$RUN" --batches "$nb"); then
    echo "$PAGE: ABORT -- cannot settle one outcome per item: ${out:-no answer}" >&2
    return 1
  fi
  printf '%s\n' "$out" >"$RUN/holds.json"
  jq -r '.held[]' <<<"$out" | write_stepouts "$RUN/hold" '{hnItemId:$id, hold:true}' "$(jq -c '.heldBy // {}' <<<"$out")"
  jq -c '{page, drafted:.pushed, retired, held:(.held|length)} + .reasons' <<<"$out" | sed "s/^/$PAGE: outcomes /"
}

# A page that is nothing but deletions still clears itself. Without a Firebase answer it stops, so
# the next run can ask again rather than hold what may be retirable.
if [ "$nb" -eq 0 ]; then
  if ! reached assembled; then
    reached sources-checked || { echo "$PAGE: no batches prepared, and the dropped items are unchecked" >&2; exit 1; }
    rm -f "$RUN"/hold-*.json "$RUN/holds.json"
    assemble_holds || exit 1
    mark assembled
  fi
  [ -n "$(payloads)" ] && { push_stage; exit 0; }
  echo "$PAGE: no batches prepared"
  exit 1
fi

# --- resumes, pass 1: the link on each comment's own Résumé/CV line -----------
# Sealed into the batch in place, so the extractor, the pronoun screen and assembly all see the
# same text. A miss here is normal (LinkedIn, a viewer wall, a scanned PDF) and is only reported.
if ! reached attached-p1; then
  for n in $(seq 1 "$nb"); do
    node "$HERE/hn-attach-resumes.mjs" --batch "$RUN/batch-$n.json" --out "$RUN"
  done | jq -s -c "$SUM"'{attached:([.[].attached]|add), fetched:([.[].fetched]|add), misses:sum_by(.misses)}' \
    | sed "s/^/$PAGE: resumes pass 1 /"
  mark attached-p1
fi

# --- extract remotely -------------------------------------------------------
# Everything that frames the model travels with the batches -- the batch script, the codex module and
# the agent definition -- so the box extracts against this checkout's spec rather than whatever its
# own clone happens to be on. The box still cds into that clone, but only for the claude path, whose
# subagent the harness discovers from the project directory.
# tmux, not `setsid nohup`: both survive the ssh channel closing, but a tmux session can be
# inspected and killed by name afterwards, and a stalled pool is otherwise invisible.

# bound <local-dir> <map-dir> <n> <drafts-file>: the drafts carry only nonces this prepare minted.
bound() {
  node "$HERE/hn-page-state.mjs" bind --batch "$1/batch-$3.json" --map "$2/batch-$3.map.json" \
    --drafts "$4" >/dev/null 2>&1
}

# missing <local-dir> <map-dir> "<batch numbers>": the numbers with no bound draft here, after
# discarding any local draft that does not bind.
missing() {
  local n out=""
  for n in $3; do
    if [ -e "$1/drafts-$n.json" ] && ! bound "$1" "$2" "$n" "$1/drafts-$n.json"; then
      echo "$PAGE: discarding drafts-$n.json in $1 -- it does not bind to this prepare" >&2
      rm -f "$1/drafts-$n.json"
    fi
    [ -e "$1/drafts-$n.json" ] || out+="$n "
  done
  echo "${out% }"
}

# pull <local-dir> <remote> <session> <map-dir> "<batch numbers>": bring back every draft on the box
# that binds to this prepare and has no bound copy here. A local draft is never overwritten -- pass 2
# merges into the pass-1 file in place, and the box's copy is the older one.
pull() {
  local local_dir="$1" remote="$2" session="$3" maps="$4" nums="$5" out n f
  out=$(gc --command="if cd ~/$remote 2>/dev/null && ls drafts-*.json >/dev/null 2>&1; then tar czf /tmp/d-$session.tgz drafts-*.json && echo packed; else echo none; fi" 2>/dev/null)
  case "$out" in
    *packed*) ;;
    *none*) return 0 ;;
    *) echo "$PAGE: could not list drafts on the box (${out:-no answer})" >&2; return 1 ;;
  esac
  gscp "$VM:/tmp/d-$session.tgz" "$local_dir/d.tgz" >/dev/null || return 1
  rm -rf "$local_dir/incoming" && mkdir -p "$local_dir/incoming" || return 1
  tar xzf "$local_dir/d.tgz" -C "$local_dir/incoming" || return 1
  for n in $nums; do
    f="$local_dir/incoming/drafts-$n.json"
    [ -e "$f" ] || continue
    [ -e "$local_dir/drafts-$n.json" ] && bound "$local_dir" "$maps" "$n" "$local_dir/drafts-$n.json" && continue
    if bound "$local_dir" "$maps" "$n" "$f"; then mv "$f" "$local_dir/drafts-$n.json"
    else echo "$PAGE: the box's drafts-$n.json does not bind to this prepare; extracting it again" >&2
    fi
  done
  rm -rf "$local_dir/incoming"
}

# poll <remote> <session> "<batch numbers>": wait for the named drafts or an idle pool. Wait in one
# remote loop rather than one ssh per poll -- the round trip costs more than the check. Give up when
# the pool is gone, not only when every draft landed: a batch the model never answered leaves no
# file and would otherwise hang here for the full timeout. Only the numbers asked for are counted,
# so a leftover draft for any other batch cannot make the pool look finished. A poll that ends
# without an answer -- a dropped tunnel, or a pool still busy -- is retried with a fresh ssh, and
# never taken as done: proceeding would assemble a page with batches silently missing.
poll() {
  local remote="$1" session="$2" nums="$3" count iters try out
  count=$(wc -w <<<"$nums" | tr -d ' ')
  iters=$(( (POLL_SECONDS + POLL_INTERVAL - 1) / POLL_INTERVAL ))
  for try in $(seq 1 "$POLL_TRIES"); do
    out=$(bounded $((POLL_SECONDS + SSH_TIMEOUT)) "${SSH[@]}" --command="for i in \$(seq 1 $iters); do n=0; for b in $nums; do [ -s ~/$remote/drafts-\$b.json ] && n=\$((n+1)); done; [ \$n -ge $count ] && { echo \"extracted \$n/$count\"; exit 0; }; tmux has-session -t $session 2>/dev/null || { echo \"pool idle at \$n/$count\"; exit 0; }; sleep $POLL_INTERVAL; done; echo \"still running at \$n/$count\"" 2>/dev/null)
    case "$out" in
      *extracted*|*"pool idle"*) echo "$PAGE: $out"; return 0 ;;
    esac
    echo "$PAGE: poll $try/$POLL_TRIES ended without an answer (${out:-no output}); polling again" >&2
  done
  echo "$PAGE: the box never answered; re-run this tag to pick up where it stopped" >&2
  return 1
}

#   remote_extract <local-dir> <remote-subdir> <tmux-name> "<batch numbers>" <map-dir>
remote_extract() {
  local local_dir="$1" remote="$2" session="$3" nums="$4" maps="$5" todo out n wipe="" clear=""
  local framing="devbox-extract-batch.sh hn-codex-extract-batch.mjs hn-profile-extractor.md"

  # Every prepare run mints fresh nonces, so a draft left over from an earlier run of the same page
  # tag cannot match the batch being shipped now -- each of its items assembles as `unknown_nonce`
  # and pushes nothing. The readiness poll only counts drafts, so the leftovers also make the pool
  # look finished before it starts: re-running 20260913-p13 reported `extracted 14/14` having
  # genuinely extracted 3, and silently dropped the other 11 batches. So a fresh prepare clears both
  # ends before its first ship (`wipe-remote`), and a resumed one keeps only drafts that bind: every
  # nonce in them must be in this prepare's batch and map, or the file is discarded and re-extracted.
  if reached wipe-remote; then
    rm -f "$local_dir"/drafts-*.json
    wipe="tmux kill-session -t hncd-$PAGE 2>/dev/null; tmux kill-session -t hncd-$PAGE-p2 2>/dev/null; rm -rf ~/$REMOTE_DIR; "
  else
    # A pool the last runner launched may still be working; wait it out rather than start a second
    # one over the same batches.
    out=$(gc --command="tmux has-session -t $session 2>/dev/null && echo running || echo stopped" 2>/dev/null)
    case "$out" in
      *running*) echo "$PAGE: $session is still running on the box; waiting for it"
                 poll "$remote" "$session" "$(missing "$local_dir" "$maps" "$nums")" || return 1 ;;
      *stopped*) ;;
      *) echo "$PAGE: could not reach the box (${out:-no answer})" >&2; return 1 ;;
    esac
    pull "$local_dir" "$remote" "$session" "$maps" "$nums" || return 1
  fi

  todo=$(missing "$local_dir" "$maps" "$nums")
  if [ -z "$todo" ]; then
    echo "$PAGE: every batch in $session already has drafts"
    return 0
  fi
  [ "$todo" = "${nums% }" ] || echo "$PAGE: $session extracting only batches $todo"

  for n in $todo; do clear+="\$HOME/$remote/drafts-$n.json \$HOME/$remote/batch-$n.json "; done
  ( cd "$local_dir" \
    && cp "$HERE/devbox-extract-batch.sh" "$HERE/hn-codex-extract-batch.mjs" "$AGENT_SPEC" . \
    && tar czf ship.tgz $framing $(for n in $todo; do echo "batch-$n.json"; done) ) || return 1
  if tar tzf "$local_dir/ship.tgz" | grep -q '\.map\.'; then
    echo "$PAGE: ABORT -- a nonce->id map reached the tarball"; return 1
  fi
  gscp "$local_dir/ship.tgz" "$VM:/tmp/ship-$session.tgz" >/dev/null || return 1

  out=$(gc --command="${wipe}mkdir -p ~/$remote && rm -f $clear && tar xzf /tmp/ship-$session.tgz -C ~/$remote && rm -f /tmp/ship-$session.tgz && cd ~/$REMOTE_REPO && tmux new-session -d -s $session \"export HNCD_RUN_DIR=\\\$HOME/$remote; printf '%s\\\\n' $todo | xargs -P $LANES -I{} bash \\\$HNCD_RUN_DIR/devbox-extract-batch.sh {} > \\\$HNCD_RUN_DIR/run.log 2>&1\" && echo launched" 2>/dev/null)
  case "$out" in *launched*) ;; *) echo "$PAGE: could not launch $session (${out:-no answer})" >&2; return 1 ;; esac
  [ -n "$wipe" ] && rm -f "$STATE/wipe-remote"

  poll "$remote" "$session" "$todo" || return 1
  pull "$local_dir" "$remote" "$session" "$maps" "$todo" || return 1
}

if ! reached extracted-p1; then
  remote_extract "$RUN" "$REMOTE_DIR" "hncd-$PAGE" "$(seq 1 "$nb" | tr '\n' ' ')" "$RUN" || exit 1
  mark extracted-p1
fi

# --- pass 2: model-chosen links, and resume items that still lack a name or employer ------------
# Preparing pass 2 attaches resumes into the pass-1 batch in place, and merging rewrites the pass-1
# drafts, so neither may run twice over the same batch: a second look would select a different set.
if [ "$PASSES" -ge 2 ] && ! reached merged-p2; then
  if ! reached prepped-p2; then
    mkdir -p "$RUN/pass2"
    for n in $(seq 1 "$nb"); do
      [ -s "$RUN/drafts-$n.json" ] || continue
      reached "p2prep-$n" && continue
      node "$HERE/hn-check-drafts.mjs" --batch "$RUN/batch-$n.json" --drafts "$RUN/drafts-$n.json" --out "$RUN/check-$n.json" >/dev/null
      node "$HERE/hn-attach-resumes.mjs" --batch "$RUN/batch-$n.json" --out "$RUN" \
        --drafts "$RUN/drafts-$n.json" --retry "$RUN/check-$n.json" --write "$RUN/pass2/batch-$n.json" \
        && mark "p2prep-$n"
    done | jq -s -c "$SUM"'{fetched:([.[].fetched]|add), misses:sum_by(.misses), retried_items:([.[].written]|add)}' \
      | sed "s/^/$PAGE: resumes pass 2 /"
    mark prepped-p2
  fi

  nums=$(cd "$RUN/pass2" && ls batch-*.json 2>/dev/null | sed -E 's/batch-([0-9]+)\.json/\1/' | tr '\n' ' ')
  if [ -n "${nums// /}" ]; then
    if ! reached extracted-p2; then
      remote_extract "$RUN/pass2" "$REMOTE_DIR/pass2" "hncd-$PAGE-p2" "$nums" "$RUN" || exit 1
      mark extracted-p2
    fi
    for n in $nums; do
      [ -s "$RUN/pass2/drafts-$n.json" ] || { echo "$PAGE: pass 2 batch $n produced no drafts; keeping pass 1's" >&2; continue; }
      node "$HERE/hn-merge-drafts.mjs" --base "$RUN/drafts-$n.json" --over "$RUN/pass2/drafts-$n.json" --out "$RUN/drafts-$n.json"
    done | jq -s -c '{merged_batches:length, replaced:([.[].replaced]|add)}' | sed "s/^/$PAGE: pass 2 /"
  else
    echo "$PAGE: pass 2 had nothing to retry"
  fi
  mark merged-p2
fi

# --- strict miss check: an empty field the source answers is a miss, reported per page ----------
# Everything from here to the push is derived from the drafts, rebuilt until assembly finishes and
# frozen after it, so the payloads the push markers name never change under them.
if reached assembled; then
  echo "$PAGE: payloads already assembled; pushing what has not landed"
else
  rm -f "$RUN"/screened-*.json "$RUN"/check-*.json "$RUN"/push-*.json "$RUN/misses-$PAGE.json" \
    "$RUN"/hold-*.json "$RUN/holds.json"
  for n in $(seq 1 "$nb"); do
    [ -s "$RUN/drafts-$n.json" ] || { echo "$PAGE: batch $n produced no drafts; its items are held" >&2; continue; }
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
    # Taking a flagged draft out here is all HNCD_HOLD_MISSES does: it then has no push, so the
    # outcome step below holds it with everything else that has none.
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
      --extractor "$EXTRACTOR_ID" --out "$RUN/push-$n.json" 2>/dev/null | jq -c '{p:.profiles, r:(.rejected|length), t:(.trimmed|length), s:(.skipped|length)}'
  done | jq -s -c '{assembled:([.[].p]|add), rejected:([.[].r]|add), trimmed:([.[].t]|add), skipped:([.[].s]|add)}'
  assemble_holds || exit 1
  mark assembled
fi

push_stage
