# Final review fix wave — Fixer C2 (spec and docs)

You own `docs/**` outside `docs/fleet-handover/ledger/` and `docs/fleet-handover/README.md` (the orchestrator refreshes
that), plus the root `README.md`. Code is done: waves 1–2 fixed the review's findings (`final-fix-A-report.md`,
`final-fix-C1-report.md`, `final-fix-B-report.md`). Make the spec match what was built and the user docs match the code.
Check every sentence you write against the code, not other docs.

## Spec amendments (`docs/fleet-handover/spec.md`) — rulings the spec never absorbed

The intent findings in `final-review.md` (I2, I4, I6, I8, I13–I16) and the review candidates' evidence say exactly what
the code does. Amend the spec to describe it, briefly, in the section each belongs to:

- I2 a blocker found at freeze unfreezes the source and keeps the gateway transaction open for the user's answer;
  `status` offers abort if the helper dies.
- I4 a supported Ubuntu is an LTS release (even-year `.04`); another release warns; 24.04 is the tested one.
- I6 Add Machine shows the command to run in a terminal for sudo, agent login and hook trust; it opens no terminal.
- I8 preflight's configuration difference compares agent CLI versions; skills, MCP and settings are named, not compared.
- I13 uncarried worktree registrations whose worktree exists on the destination are kept.
- I14 a gateway record with a lower generation never rolls ownership back at daemon start.
- I15 an existing destination root with no replica record whose content equals the incoming content is adopted as a
  replica.
- I16 the path-field registry covers the persisted schemas (FleetState, FleetConfig, NodeConfig, MachineRecord, the
  transfer manifest); RPC params are validated where received.
- Also: I3 (the gateway authority version is compared at preflight), I9 (`archi host upgrade --rollback`), and any other
  behaviour waves 1–2 changed that the spec states differently (read the three fix reports).

## User docs (`docs/remote-machines/`, `apps/desktop/mac/SMOKE.md`, `docs/integration.md`, `docs/security/…`)

- The 39b mismatches (`task-39b-report.md`): the give-up time after a dropped link (measured 47.5–144 s), the login
  recheck (now at each preflight, see A's F2), `handover attach` exiting at once when stdin is at EOF, a fenced copy
  answering `handover_committed`.
- New or changed behaviour from waves 1–2: `archi uninstall`'s refusals (C24), the background-commands blocker (C05),
  `--interrupt-after` honored beyond the rest's wait (I1), `host upgrade --rollback` (I9), the authority version blocker
  (I3), bare `archi setup` on an installed release (C32), remote terminal surfaces when the helper's master is gone
  (C15, C1's decision), release pruning (C17), the rsync version warning (L17), the file-count bound, the spike probes'
  new home (I12).
- The known-limitations list stays accurate (fold in anything the fixes changed).
- `errors.md`: every row's recovery still works after the fixes (its test checks codes exist, not that the prose is
  right).

## Verify

`pnpm vitest run --project scripts --project cli` (the catalogue test lives there) and `pnpm typecheck`; every command,
flag and path in what you changed checked against the code. Every shell:
`unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"; unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`.
