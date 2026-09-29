# Final review fix wave — Fixer B (controller and CLI)

You own `packages/cli/**`, the event-type import and F1's display in `apps/desktop/web/src/handover.ts`, and rows for
codes you add in `docs/remote-machines/errors.md` (its test reads codes from the code). Wave 1 is done: Fixer A
(`final-fix-A-report.md`) exported helpers for you — the gateway identity and owner-frame parsers, the fleet.json
patch writer in archid `config.ts`, and the NDJSON event types in `@archipelago/protocol`; Fixer C1
(`final-fix-C1-report.md`) exported one archive staging/verification function from `scripts/install-release.mjs`. Use
them rather than keeping local copies.

Each item's claim and evidence: `final-review-candidates.md` (by id) and `final-review-validation.md`. Test first for
every behaviour change; one commit per item where practical.

## Critical / High

- **C03** a resume or abort from a machine that is neither the journal's source nor its destination stops with a
  Stopped naming the machine to run it from, before any transfer (check in `adopt`/`resume`, and assert in `transfer()`
  that exactly one party is remote). Test the Linux→Linux-resumed-from-the-Mac shape.
- **C02** `resolveOwner` on the gateway machine asks the local authority socket (as reach.ts `authorityOp` does), not
  ssh; a test with `gatewayId === registry.localId`.

## Medium

- **C06** the far profile comes from the resolved target (a named fleet chosen by `ARCHI_HOME` included), not only `-p`,
  everywhere it is passed (connect, routed commands, handover, fleet recover).
- **C07** `host enable`, `host remove` and `fleet recover` patch fleet.json with A's writer (raw keys, through a
  symlink, file mode kept).
- **C08 + L11** a protocol-mismatch `SshError('version')` is not retried and becomes the `incompatible_protocol` blocker;
  `transient()` derives from connection.ts's allow-list (`RETRIED`) plus the non-SshError exclusions, and reuses its
  delays.
- **L13** a machine-id mismatch in `remoteConnectionInfo` throws `MachineMismatch` (identity_mismatch blocker, not a
  retried transient).
- **C09** `host enable` refuses when fleet.json names a different gateway still in the registry (the documented
  "gateway set up again" flow replaces the registry entry first, so it stays open).
- **C10** a machines.json that was moved aside is named (warning at load, and in the "not a machine in the registry"
  errors).
- **C20 (cli part)** `identify` / `remoteOwner` use A's parsers.
- **C18 (cli part)** `inspectCompanion` uses C1's staging function; keep the GNU tar test in `host.test.ts` passing.
- **C16 (cli part)** after a same-name reinstall, `host upgrade`'s rollback message must not call the new tree "the one it ran before" (C1's report has the suggested change).
- **C25** drop `export` from the seven unused exports.
- **C32** bare `archi setup` on an installed release works (it sets up from `current`), so every "run `archi setup`" hint
  in doctor, the daemon's missing-agent error and the docs holds; test it.
- **L07** fleet-recover's controller-journal read uses `fileStore(...).read()` (or its comment says what it does).
- **L10** drop `runHandover`'s owner pre-check; preflight returns identity_mismatch right after `gateway.get()` when
  source and destination are the same, through the `ssh_interactive`-aware path.
- **L16** a transfer that fails before any entry reports `result.failure.error`.
- **L17** `host add`'s rsync step warns (with the action) below `MIN_RSYNC`, like the tmux step.
- **L20** `handover attach` answers with the run's held choices (carry them on `handover.blocked` or `handover.status`).
- **L34** `host add`/`upgrade` reuse a digest-matched companion from the cache before fetching the pinned URL, so a dev
  build's deleted `file:` archive doesn't break Add machine.
- **C11 (cli and web import)** `events.ts` / `recovery.ts` and `apps/desktop/web/src/handover.ts` import the event types
  from `@archipelago/protocol` instead of declaring them.
- **39b F1** an archived copy's location stays on the root's row: emit it in a field that later progress lines keep
  (e.g. `archivedTo` on the root entity), and show it in the sheet.
- **I3** preflight compares the gateway's authority schema version with this release's and blocks with
  `incompatible_protocol` (naming the gateway) when they differ.
- **I5** `host add`'s end-to-end step also asks the gateway authority (when the machine is or has a gateway) and opens
  and closes a temporary tmux window on the far machine.
- **I9** `archi host upgrade <machine> --rollback [release]` runs the far `archi setup --rollback` and checks every
  restarted fleet daemon, as an upgrade does.

## Low

L01 (gateway.ts `send` → `client.call`), L04 (one `currentRunFrom()`), L05 (import `ARCHIVABLE`), L06
(`rememberOwner`), L08 (`stateDir` required), L09 (drop unread journal fields), L12 (move `Check`/`REFUSED` out of
commands), L14 (`observe` in parallel, no double status), L15 (resolve `fleetHome` when the Side is built), L19 (parse
blockers with `z.array(Blocker)`), L21 (the CLI formats bytes base 1000 like the sheet).

## Verify

`pnpm typecheck`; `pnpm vitest run --project protocol --project archid --project cli --project @archipelago/desktop-web
--project scripts`; `pnpm test:faults` (one seed); the arm64 integration round trip from `docs/integration.md` once at
the end (colima: start if stopped, stop after, context back to `desktop-linux`). Every shell:
`unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"; unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`.
