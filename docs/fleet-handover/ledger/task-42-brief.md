# Task 42 — carry main's newer fleet data and fence the Linux daemon (brief)

Plan: `docs/fleet-handover/plan.md` Task 42. Spec (`docs/fleet-handover/spec.md`) is binding, in particular
"Product contract" (entity docs are preserved), "Same paths" (every path field, process-bound field and fleet-home
entry is classified), "Transfer inventory" and "Terminal records". Delivery rules:
`docs/fleet-handover/ledger/review-constraints.md`. Worktree
`/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`. Task 41 has landed: paths travel unchanged, so repo-doc keys (a hash of the repo's
absolute path) stay valid on the destination.

## Do

1. Entity docs: add the fleet's docs (fleet, island, character and repo docs under `<fleetHome>/docs/`) to the
   transfer inventory, so a moved fleet's docs are found by the same keys on the destination. Treat them like the
   other fleet-home data the handover already carries (replica records, divergence, `--delete` rules).
2. Agent profiles: a character names a profile file under `<fleetHome>/agent-profiles/` (main's #14). Carry the
   profiles a moved fleet uses — or the whole folder, if that is what the spec's rules make simplest and safe — so a
   moved character keeps its profile. The Task 40 rebase report ("Worth a look") has the detail.
3. The Task 40 fix wave already strips `agent.pid` and `second.agent.pid` at export (F2). Check no other pid or
   process-bound field main's state gained still travels.
4. Classification: extend the path-field classification test to process-bound fields (pids, tmux ids, pane paths)
   and add a test that lists every entry a fleet home can hold (read the code that writes into the fleet home:
   archid, cli, setup, mobile, scribe, usage, browser store, hooks, handover, controller) and classifies each as
   travelling or machine-local. An entry the code writes but the list does not classify fails CI. Machine-local
   entries are stripped or left behind at export.
5. The single-daemon lock on Linux: `lockHome` in `packages/archid/src/main.ts` opens `daemon.lock` with macOS's
   `O_EXLOCK`, which Linux ignores, so a second archid for the same fleet starts there. Make the lock hold on Linux
   too, released by the kernel however the daemon dies (e.g. an abstract-namespace unix socket bound to a name
   derived from the fleet home's real path, or an `flock` held by a child) — your choice, with the reason in the
   report. macOS keeps `O_EXLOCK`.

## Tests (each failing first)

- a moved fleet's entity docs and agent profiles are found by the same keys/paths on the destination (fake-dependency
  handover tests);
- a live stale pid on the destination cannot make the reducer ignore a new session;
- an unclassified state field or fleet-home entry fails the classification tests;
- a second daemon for the same fleet refuses to start on macOS (unit/integration test) and on Linux: run the same
  test in an `ubuntu:24.04` container (`docker` via colima is available on this Mac; start colima if it is stopped
  and say so) with Node 24, and record the command and output in the report.

## Verify

`pnpm vitest run --project protocol --project archid --project cli`, `pnpm typecheck`, then the Linux lock test.
Known load flakes are listed in `docs/fleet-handover/README.md`; rerun them alone.

Every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"; unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`. Single test files
as `pnpm test <path>` from the root.

## Rules

Test first; argv-only subprocesses; persistent JSON writes durable (temp, fsync, rename, 0600 where the delivery rules
say). No `~/.archipelago`, `~/Library`, `~/.claude`, `~/.codex`, `~/.ssh` or linus-vault. No bare `git stash`; don't
rm gitignored build output. Comments only where behaviour is not self-evident, 1–2 lines, describing what the code
does now. Commit subjects: one plain sentence, repository style, no attribution lines. Commit as you go; do not push.

## Report

`docs/fleet-handover/ledger/task-42-report.md` (uncommitted): what changed per step, the fleet-home classification
table, tests added (failing-first evidence), the Linux lock run, verification counts, concerns. End your reply with
one status line: DONE, DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT, the commit range, and the counts.
