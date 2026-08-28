# Isolation

Two attacker-controlled channels reach a model context here: HN comment bodies, which anyone
can post, and resume documents, fetched from a URL the candidate chose. Resumes are the
sharper of the two — a payload in white-on-white text, an off-page div, or PDF metadata is
invisible to a human spot-checking the document and perfectly legible to a model.

Ranked by what a successful injection would win:

| | Attack | Controlled by |
| --- | --- | --- |
| A | run commands or read `~/.ssh` on the operator's machine | 1 |
| B | exfiltrate `HN_INGEST_TOKEN` → permanent write access to production | 1, 4 |
| C | write or suppress *other* candidates' records | 2, 5, 7 |
| D | put false values in the attacker's own record | out of reach — they already author that text |
| E | store hostile markup that renders on the public site | 6, 7 |
| F | SSRF via a resume URL (localhost, cloud metadata) | 3 |

## 1. The subagents that read untrusted text can only enumerate paths

Extraction needs no tools at all: text in, JSON out, and the original design said exactly that
by declaring an inert `tools: TaskList`. **That no longer spawns.** This harness grants
subagents only tools that *do* something — it withholds every inert one — and it refuses any
agent whose list resolves to empty. `TaskList`, `TaskCreate`, `TaskGet`, `AskUserQuestion`,
`ReportFindings`, `PushNotification` and `EndConversation` were each tested by spawning, and
each was withheld; `TodoWrite` is not a tool here at all. The technique has no candidate left,
so the declaration is now `tools: Glob` — the narrowest tool that actually spawns, verified
empirically: the agent reports `{"tools":["Glob"]}` and denies holding Bash, Read, Write, Edit,
Grep, WebFetch, WebSearch or Skill.

`Glob` enumerates paths. It cannot read a file's contents, write, execute a command, or reach
the network. **A and B therefore keep the property that matters — the mechanism is absent, not
filtered.** Running a command needs `Bash`; reading `~/.ssh` or `~/.config/hncd/ingest-token`
needs `Read`. Neither is held, so no injected instruction can produce either: the model does not
*decline* to exfiltrate the token, it has no call available that would. That is why this is
first and not a layer.

What `Glob` concedes, stated plainly rather than papered over: an injection can learn **path
names** — that some file or directory exists. It cannot learn a byte of any file's contents,
and it has no channel to send what it learns anywhere, since its only output is the JSON array
this skill parses and control 5 drops anything off-schema. That is the floor this harness
imposes, not an affordance anyone wanted. Closing it properly means running extraction as a
direct API call with `tools: []`, where "no tools" is structural instead of a harness grant.

The mechanism this rests on is verified. A repo-defined `tools:` line is resolved verbatim —
`dqm-bq-analyzer` declares `tools: Read, Bash, mcp__bigquery__*` and the harness offers it as
exactly that — and a narrow list withholds capability rather than merely documenting it: an
agent declaring `tools: Read, Edit`, asked to run a shell command and to grep, reported it had
neither tool and made zero tool calls. `Glob` is a real tool name, so the list cannot fail
open through an unresolvable entry.

**Still verify once** on first use in a fresh session, and after any change to the agent
definition: spawn `hn-profile-extractor` and ask it to report its tool list, to read a file's
contents, and to run a shell command. It must report `Glob` and only `Glob`, and that it holds
no tool for the other two. If it reads the file or runs the command, the definition did not
load as written and this skill must not run until it does. What the checks above establish is
that the field works; only this one establishes that *this* definition loaded.

## 2. The model's output is a value, never a selector

`hn-prepare-batch.mjs` writes identity to `batch-N.map.json` and content to `batch-N.json`.
Only the second may enter a prompt. The model receives a nonce and text; `hn-assemble-push.mjs`
re-attaches the `hn_item_id` from the map. "Also update item 12345" has nowhere to land,
because the model is never asked for an id and no code path accepts one from it. An unknown
or duplicated nonce drops that item.

## 3. The model never supplies a URL

The harness regex-extracts links, screens each one (https only, no credentials, public
address, length-capped), and presents a numbered list. The model returns an **index**.
`hn-resume-text.mjs` re-screens after applying the share-link rewrite, since the rewrite
changes the host. The judgement call a regex would get wrong stays with the model; the
network access does not.

## 4. The push token never shares a context with untrusted text

Fetch, extract, and push are separate processes. `hncd-api.mjs` is the only one that resolves
the credential, and it never reads comment or resume text. The extraction subagents get no
token in prompt, env, or any file — and per control 1, no way to read one: `Glob` can learn
that `~/.config/hncd/ingest-token` exists, and cannot open it. Threat B stays closed.

## 5. Schema-constrained output, validated locally

`hn-assemble-push.mjs` enforces field presence, types, string limits, and list caps that
mirror the Worker's `validateDraft`. A malformed draft drops that item. Nothing is coerced,
truncated, or repaired into something publishable — a repair step is where an injected value
would get laundered into a valid one.

## 6. Neutralize before the model sees it

`neutralize()` strips zero-width, bidi-override, and control characters, collapses runs, and
caps length; the Worker already treats invisible text as hostile. Each batch carries a
random delimiter the payload cannot predict, so untrusted bytes cannot close their own data
block and continue as instructions. This is a cheap layer, not a boundary, which is why it is
listed after the controls that remove capability.

## 7. The Worker is the fail-closed boundary

`validateDraft` → `sanitizeCandidateDraft` → `boundedDraft` → suppression check run
server-side regardless of what this skill sends, the permalink is derived rather than
accepted, and the batch is size-capped. A fully compromised skill can still only write
bounded, sanitized, non-resurrecting profiles for items that already exist.

## Residual, accepted

Within one batch, candidate A's text can influence candidate B's **field values** — not B's
identity, which control 2 forecloses. That is the D row's severity, and it shows up in the
pre-push diff. Resume documents are never batched: one document per context, because the
invisible-payload problem makes them the likelier carrier. `--isolate` forces
one-comment-per-context for a run that warrants it.

An `injection: true` flag on a returned item is a signal to review that candidate's source
comment, not grounds to drop it — the text is theirs to write, and a profile that quietly
disappears is worse than one a human looks at.
