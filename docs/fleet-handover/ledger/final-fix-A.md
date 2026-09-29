# Final review fix wave — Fixer A (daemon and protocol)

You own `packages/archid/**` and `packages/protocol/**`, plus rows for codes you add in
`docs/remote-machines/errors.md` (its test reads codes from the code). Another fixer (C1) works at the same time in
`apps/desktop/**`, `scripts/**` and `.github/**`; don't touch those. Fixer B (`packages/cli/**`) comes after you and
builds on the helpers marked **for B** below — export them and say so in your report.

Each item's claim and evidence: `final-review-candidates.md` (by id) and `final-review-validation.md` (validator and
Gemini verdicts). Test first for every behaviour change; one commit per item where practical.

## High

- **C01** `fleet.ts:157` — `settle()` must also wait for in-flight `reviving` and `openingSecond`; and `doRevive` /
  `doOpenSecond` must check the fleet is still writable after their wait (`ending`) and before opening a window, so
  nothing admitted before a freeze opens a window after the rest's snapshot. Add a fault-suite or source test that
  reproduces the late window.
- **C04** `rest.ts:354` — confirm the window is gone after the kill (tmux's own "can't find window" counts as gone);
  if it is still live, stop the rest with the journal in place for abort/resume, never mark it dormant.
- **C19** `source.ts` `runComplete` — deactivate the fleet once Complete has installed the committed record (as
  `adopt` does), so a returning fleet runs `begin()` again; test a round trip without a daemon restart.
- **C20** `gateway/client.ts:180` — refuse an answer with no machine id. **For B:** export one identity parser and one
  owner-frame parser (and use `shq` rather than a fourth quoter) that the controller's `identify` / `remoteOwner` will
  call, so both sides refuse the same answers.

## Medium

- **C05** `rest.ts:167` — an idle agent with `run_in_background` commands still running is not rested silently: rest
  it by terminating only if the user chose Terminate, otherwise an `agent_unsettled` blocker naming the commands, and
  preflight reports it too.
- **C21** `machine.ts` — mint with `createDurable`; keep the EEXIST read-back.
- **C22** `destination.ts:650` — the trust-prompt watch backs off (to about a minute) and ends when the handover's
  journal closes (Complete) or after a bound; re-read the Claude config only when its mtime changes.
- **C23** Linux `archid` unit — carry `CLAUDE_CONFIG_DIR` and `CODEX_HOME` as the Mac plist does (captured from the
  account's login shell, since setup runs over non-interactive ssh); extend the doctor's daemon-env check to Linux.
- **C24** `uninstall.ts` — refuse, unless forced, when a fleet home holds a handover journal, owns a fleet under a
  gateway, or the gateway prefix holds fleet records; name `archi handover local` / `host remove` in the message.
- **C26** one path-validation helper for `validate.ts` and `replicas.ts`.
- **C27** drop `SourceJournal.progress` and `handover.status`'s `roots`/`characters` (nothing writes or reads them).
- **C28** delete `Store.replace` and its tests. **C29** drop `HelloResult` (or type the hello reply with it, no
  `capabilities`). **C30** drop the rest's unreachable scrollback capture and the unread `RestedTerminal` fields.
- **C33** `destination.ts:858` — an abort before prepare must not leave a root's replica record at `receiving`: revert
  or seal it at its pre-transfer generation, so an outside change later is not a false `destination_diverged`.
- **C11 (protocol part)** — move the helper↔app NDJSON event types (`SafeAction`, `CharacterResult`, `Outcome`,
  `Standing`, `Verdict`, `EntityData`, `Names`, `HandoverEvent` as `packages/cli/src/controller/events.ts` and
  `recovery.ts` define them) into `@archipelago/protocol` as types. **For B** (cli imports them) and for the web app.
- **C07 (helper part)** — **for B:** export from `config.ts` one "patch fleet.json" writer that keeps the file's raw
  keys, writes through a symlink with the file's mode (as `saveMainAgent` does); use it in `setGateway`.
- **L38** one `writeJsonAtomic` (the durable one); rename or remove the jsonfile.ts copy and update `push/store.ts`.
- **L40** one excluded-by-ancestor helper for divergence/git-graph/inventory. **L41** one divergence description.
- **L42** `source.ts` reads fleet.json through config.ts (InvalidConfig, not a bare ZodError).
- **L44** `Character` extends `TerminalSlot`; drop the `Second` alias.
- **L45** `provision.ts` reuses `writeUnits` (log dir 0700) and reads owner.json through `OwnerCache`.
- **L48** `initConfig` / `splitLegacy` write only the keys the source held (defaults apply at load).
- **L50** doctor (or setup) reports an existing `~/.archipelago-<name>` whose name is now reserved, with the rename.
- **L51** `writeDurable` / `writeTemp` unlink the temp on failure.
- **L46** drop the unused 'journal' authority class and the stale "not implemented yet" fallback (make the deps required).
- **L47, L52** (nits) rename `committed-destination`; one `STATE_SCHEMA_VERSION` constant; fix guard.ts:83's comment.
- **I1** `rest.ts:216` — `--interrupt-after` longer than the rest's wait is honored (the wait extends to it), not capped.
- **I7** `agents.ts` — Claude gets the same minimum version the session adapter needs (`sessions/claude.ts` MIN), so
  host checks and preflight agree.
- **I10 / L43** remove `relaySecret` (prepare param, path, fleetKeys entry, write) — it belongs to a later version.
- **39b F2** a fixed agent login is seen at the next preflight, not up to 60 s later (probe fresh at preflight).
- **39b F3** a Retry that fails again must leave the character dormant with its session and revive, retryable (the
  spec's "one dormant, retryable character"), never a plain shell.
- **37c/39b D1** after a handover, a live terminal no longer keeps its carried `revive` in the state (it is dropped once
  the terminal is live and the handover no longer needs it); keep ed25ada8's guarantee that a retry after a destination
  crash still has its flags.

## Verify

`pnpm typecheck`; `pnpm vitest run --project protocol --project archid --project cli --project scripts`; the fault suites
(`pnpm test:faults`, one seed) — protocol stays 17 (unreleased; field removals inside 17 are fine). Every shell:
`unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"; unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`.
