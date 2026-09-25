# Task 22 fix round 1 — findings (verbatim from the review at aee1884) and controller rulings

## Important 1 — file-history and the whole session folder are carried and remapped without spike evidence (claude.ts:102-105, keys remapped via claude.ts:29,31)
- What's wrong: Besides the proven transcript and `subagents/`, this carries every file under `<project>/<id>/` and all of `file-history/<id>/`. Unknown file kinds go verbatim through the non-JSON path (claude.ts:78), so a new sidecar kind is carried rather than refused.
- Why it matters: On real sessions here, `trackedFileBackups` keys point at `~/.claude/CLAUDE.md`, `~/.claude/skills/…`, `~/.claude/projects/…` (memory files), `~/.archipelago/docs/…` and `~/.zshrc`. Those backups get copied, and their keys are rewritten into the destination's agent home and home root. A `/rewind` on the destination could then write the source's versions over files the spec keeps machine-local ("user-wide skills … and shell dotfiles are machine-local").
- Reviewer's fix: Allow-list the proven kinds: `subagents/*.jsonl` and `subagents/*.meta.json`. Refuse any other file under `<id>/` so the adapter fails closed. Drop `file-history/` unless a live probe shows it is needed. If it stays, carry only backups whose tracked path lies under a carried root, and never remap keys into the agent home.

## Important 2 — installSession has no filesystem injection (registry.ts:45,53-86, delivery rule)
- What's wrong: It calls `fs.readFileSync`, `fs.mkdirSync` and `writeDurable` directly. The one failure path that matters cannot be injected: sidecars written, then the transcript write fails, then a retry.
- Why it matters: Reading the code, the retry looks idempotent (equal copies are skipped, missing ones written), but nothing proves it. Every other new entry point here takes injected dependencies (`SessionFs`, `ScanFs`, `ProbeDeps`).
- Reviewer's fix: Take a small deps parameter (read, mkdir, `DurableStages`). Add a test that fails the transcript write and then shows a clean retry.

## Promoted minor (controller ruling) — installSession accepts any relative path under the agent home (registry.ts:61,73)
It only rejects absolute paths and `..`. A buggy or hostile manifest naming `CLAUDE.md`, `skills/x/SKILL.md` or `hooks.json` would be written there if absent — fails open against the spec's machine-local rule. Accept only paths inside the adapter's session layout (Claude: `projects/<slug>/<id>.jsonl` and the allow-listed files under `projects/<slug>/<id>/`; Codex: the rollout under `sessions/`), with a test.

## Controller rulings for Important 1
- Drop `file-history/` entirely (not proven by the spikes; its keys reach machine-local files). A resumed conversation is still the same conversation; `/rewind` to pre-handover checkpoints is not carried. Say so in the report.
- Before choosing the allow-list, survey the real Claude sessions on this Mac read-only (the reviewer did: ~393 sessions in the last 10 days) and list every kind of file found under `<project>/<id>/` with counts. Then: `subagents/*.jsonl` and `subagents/*.meta.json` are carried and rewritten as now; `tool-results/*` files are carried verbatim only if the survey confirms they are session-specific tool output the transcript refers to (state how the transcript refers to them and whether that reference is a path that must be remapped); every other kind under `<id>/` fails closed with a typed blocker naming the file.
- If the survey shows that more than ~5% of recent real sessions would then be blocked by an unknown kind, stop and report DONE_WITH_CONCERNS with the kinds and counts, so the controller can rule.
