# Task 36 — systematic fault injection and single-owner model tests (brief)

Plan: `docs/fleet-handover/plan.md` Task 36. Spec `docs/fleet-handover/spec.md` is binding, in particular "Ownership
authority", "State machine", "Failure and recovery"; the controller/helper contract is `ledger/task-28-29-contract.md`;
delivery rules `ledger/review-constraints.md`. Worktree
`/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`.

The invariant under test: at most one side can create, input to or attach a terminal, at every instant, through any
crash, restart, lost or duplicated message; before Commit only the source may revive; after Commit only the destination
may activate; the source never reactivates on its own after Commit.

## Split

36a (first): Do items 1, 2 (daemon side: `packages/archid/test/handover/faults.test.ts`), 4 and 5, report
`task-36a-report.md`. 36b (after 36a's review): items 2 (controller side: `packages/cli/test/controller/faults.test.ts`),
3 and 6, report `task-36b-report.md`. Your dispatch names your half.

## Build on what exists

- `packages/cli/test/controller/handover.test.ts` already has a table-driven fault world (Task 27): a `Fault` of kind
  `death | lost | dropped | partition` struck at every op index of a probe run (see `opIndex`, the loop over `kinds`
  near the end). Extend it; do not build a second framework beside it.
- The daemon side (`packages/archid/src/handover/` — `service.ts`, `source.ts`, `destination.ts`, `journal.ts`,
  `durable.ts`, `replicas.ts`, `rest.ts`, `startup.ts`; `packages/archid/src/ownership/`) and the gateway authority
  (`packages/archid/src/gateway/`) are where the daemon-side boundaries live.

## Do

1. `packages/archid/src/handover/failpoints.ts`: a registry of named failpoints, a no-op unless a test or dev build arms
   one (never reachable from a release's config or the wire). Name a failpoint before and after every authority write,
   local journal write, terminal kill, rsync root, verification, prepared-state write, Commit response, state promotion
   and activation, on each side that has one.
2. `packages/archid/test/handover/faults.test.ts` and `packages/cli/test/controller/faults.test.ts`: for each failpoint,
   crash there, restart controller / source / destination / gateway from disk (real durable files in a temp dir, the
   injected clock and processes), derive the legal action from `archi handover status`'s logic, take it, and assert the
   invariant above at every step. The registry is exhaustive: a test fails when a failpoint exists that no case covers,
   and a new transaction boundary without a failpoint is caught by review of the list (say how you made that hard to
   miss).
3. Concurrency and messages: concurrent Begin / Resume / Abort from two controllers; duplicated and reordered responses;
   an unknown Commit response (must query the authority, never abort the source).
4. Gateway loss before Begin, during Freeze, after Ready, after Commit and during Complete.
5. The split-brain case the plan names: a stale source owner cache plus a surrendered journal at startup — the source
   must come up fenced.
6. A randomized order run of the fault suites (seeded; print the seed on failure), then the full suite.

## Verify

`pnpm vitest run --project archid --project cli`, the fault suites repeated with several seeds, `pnpm typecheck`.
Known load flakes are listed in `docs/fleet-handover/README.md`.

Every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH";
unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`; single files as `pnpm test <path>` from the root.

## Rules

Test first: a failpoint case that exposes a real defect is a finding — fix it in its own commit with the failing case as
its test, and list it in the report. Argv-only subprocesses; durable 0600 writes; no `~/.archipelago`, `~/Library`,
`~/.claude`, `~/.codex`, `~/.ssh`, `/Users/Shared/archi-m3b` or linus-vault; no bare `git stash`; don't rm gitignored
build output. Comments only where behaviour is not self-evident, 1–2 lines, describing what the code does now. Commit
subjects: one plain sentence, repository style, no attribution lines. Commit as you go; do not push.

## Report

`docs/fleet-handover/ledger/task-36-report.md` (uncommitted): the failpoint list by side and phase, how exhaustiveness is
enforced, the scenario matrix with results, every defect found and its fix, seeds run, verification counts, concerns.
End your reply with one status line: DONE, DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT, the commit range, and the
counts.
