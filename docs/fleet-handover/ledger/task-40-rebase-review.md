# Task 40a review: the rebase onto current main

**Verdict: Approved.** Critical 0, Important 0, Minor 7.

Reviewed 615da858..fe22ba68 against 45856c9b..809d5b4e: `git range-diff`, a three-way read of every file
`git merge-tree` lists as conflicting, the follow-up commit fe22ba68 line by line, and the spec's terminal-record
and freeze rules. Nothing either side added is missing from the merge. The seven findings are integration gaps
that no conflict marker shows, and test gaps. None blocks Task 40b.

## Findings

### Critical

None.

### Important

None.

### Minor

**M1. A dormant second terminal can travel with a resume command but no session.**
`packages/archid/src/handover/validate.ts:148-152`, `packages/archid/src/fleet.ts:925`.
- Main's side: a dormant main terminal ignores the SessionEnd its closing window sends
  (`fleet.ts:927-928`: "a dormant character keeps the agent its revive resumes").
- Branch's side: `loseSecond` makes a second terminal that ran an agent dormant, but a late SessionEnd for
  term 2 still goes through `apply` (`fleet.ts:925`), and `applyHook` deletes the agent. The revive command stays.
- Merged result: the follow-up keeps any non-empty revive a handover did not rest, whether or not the slot still
  has an agent (`validate.ts:148`). The inventory carries a transcript only for a slot with an agent
  (`inventory.ts:241`). On the destination, opening that second terminal runs `claude --resume <id>` for a session
  that was never copied. Before the follow-up, the revive was recomputed to `''` and the terminal opened as a
  plain shell.
- Fix: keep the revive only when the slot still has an agent (`t?.agent && t.restedBy !== … && t.revive?.command`).
  Also extend main's dormant-SessionEnd guard to the second slot, so a closed second terminal keeps its agent
  and its transcript travels.

**M2. `agent.pid` still travels, and main's idle close now acts on it.**
`packages/archid/src/handover/portable-path.ts:254`, `packages/archid/src/fleet.ts:433-445`,
`packages/archid/src/dormancy.ts:105-107`.
- Spec (binding), `spec.md:495`: "Before export, all `tmux.windowId`, `paneId` and agent pid fields are removed."
  `exportSnapshot` strips `tmux`, `second.tmux` and `panePath`, but not `pid`. This predates the rebase and is
  already Task 42's second step.
- New with main's idle close: `endIdleAgents` looks up `agent.pid` in `ps`, and `exited(pid)` SIGKILLs that pid
  after 60 s. Codex does not send a SessionStart on resume (`sessionStartOnResume: false`), and the reducer only
  learns a pid when it has none (`reducer.ts`, last pid rule). So a codex agent woken on the destination keeps
  the source machine's pid.
- Usually that pid matches nothing and the agent is never idle-closed there. If it happens to be another codex
  process on the destination, the idle close kills that unrelated process.
- Fix: as Task 42 plans, delete `agent.pid` and `second.agent.pid` in `exportSnapshot`, in code, since the
  classification walker skips numbers. Add an assertion to the forbidden-field test. Land it before the flag
  goes on.

**M3. A kept revive carries launch flags that may only mean something on the source.**
`packages/archid/src/handover/validate.ts:148`, `packages/archid/src/dormancy.ts` (`FLAGS.codex.kept`).
- Spec, `spec.md:495-496`: "`revive.command` is `claude --resume <id>` or `codex resume <id>`."
- Merged result: an idle-closed terminal keeps main's flags. That includes codex `-p/--profile` and
  `--local-provider`, whose values name entries in the source machine's `~/.codex/config.toml`. On a destination
  without that profile, the resume fails.
- Fix: drop codex `-p/--profile/--local-provider` from a kept revive in `importState`, or recompute it without
  them. Then change the spec line to say which launch flags a kept revive may carry.

**M4. `attachSlot` copies an empty tmux path into `second.cwd`.**
`packages/archid/src/reconcile.ts:47`, applied on every poll at `fleet.ts:366`.
- Main's side (af5aeffc): tmux reports no path while a setuid program such as sudo runs in a pane, so the poll
  and reconcile move `cwd`/`panePath` only for a non-empty `w.path`.
- Branch's side: `attachSlot` sets `cwd: w.path` unconditionally. The rest already guards the same value
  (`rest.ts:336`, `if (path) slot.cwd = path`).
- Merged result: a second terminal whose window closes while sudo runs is left dormant with `cwd: ''`. It then
  reopens with `tmux new-window -c ''` (`fleet.ts:742`). `second.cwd` is a portable path
  (`portable-path.ts:125`), so the handover blocks on a path no root holds.
- Fix: `cwd: w.path || slot?.cwd` in `attachSlot`.

**M5. `archi doctor`'s config check passes both configs the daemon refuses to start with.**
`packages/cli/src/commands/doctor.ts:121-134`, `packages/archid/src/config.ts:59-63`.
- Follow-up: `initConfig`'s two refusals are now `InvalidConfig`, so the launchd daemon waits instead of
  restarting.
- Doctor reads only fleet.json and node.json once fleet.json exists, or config.json alone before the split. It
  reports `✓ config` for:
  - a config.json lying beside fleet.json ("is not read any more"), which main's `archi setup` writes as `{}`;
  - a config.json with a config.json.bak in the way.
  The cause shows only in the log tail.
- Fix: repeat both refusals in doctor's `config()`, or move them into one pure helper in `config.ts` that both
  call.

**M6. Doctor's `daemon path` check never checks a release install's program.**
`packages/cli/src/commands/doctor.ts:196-207`, `packages/archid/src/setup.ts:251`.
- Main's side: the check fails only when the plist's `…/node_modules/.bin/tsx` is gone. `plistRun` matches only
  that path.
- Branch's side: a release plist runs `<release>/bin/archid` and has no tsx.
- Merged result: a missing `current/bin/archid` passes, and the ok line still says "its checkout is there".
- Fix: have `plistRun` return the first `ProgramArguments` string, check that it exists, and say "its program is
  there".

**M7. Tests for the follow-up's behaviour are thin.**
- `sessions.test.ts:667` covers the kept revive only for the main slot. Add a second-slot case, and the
  agentless case from M1.
- `config-migration.test.ts` checks both refusal messages but not that they throw `InvalidConfig`, the class that
  makes `bin.ts` wait. Add `toThrow(InvalidConfig)`.
- No test covers `plistCurrent` for a release, a `shimsCurrent` release shim that links elsewhere, or
  `archi setup --check --release`. `cli.test.ts` only runs `--check` without `--release`. A scratch probe showed
  all three behave correctly.
- `resumeErrorOf` (`apps/desktop/web/src/selectors.ts:57`) is the only thing that hides the new "resume failed"
  label and chip (`Sidebar.tsx:119`, `map/Token.tsx:52`) with the flag off. Only one e2e test covers it, and only
  for the sidebar. Add a selectors test: flag off gives undefined, a slot with a window gives undefined, and a
  dormant slot with the flag on gives the error.

## Integration checks verified clean

- **Nothing dropped.** Every conflicting file was read three ways. The following were checked:
  - Daemon (`fleet`, `reconcile`, `main`, `store`, `api/*`, `links/git`, `config`, `profile`, `setup`,
    `uninstall`, `bin`): both sides' behaviour is present.
  - Protocol, Swift (`Bridge`, `ShellRouter`, auto-merged `SurfaceManager`, `build.sh`) and web (`TerminalArea`,
    `selectors`, `Sidebar`, `Token`, `SettingsCard`, `UtilityDock`, `bridge.ts`, `styles.css`): the same.
  - CLI (`setup`, `uninstall`, `launch`, `doctor`, `char`), `desktop-install.sh`, README and `.gitignore`: the same.
  - Test titles: every one either side had is present or renamed, not lost.
- **Ownership guard.**
  - `dormancy.set` is main's only new method, and it is a `mutation`. `classification` is a
    `Record<MethodName, …>`, and the test asserts the keys equal `methods`.
  - The fence tests call every mutation and terminal method on an inactive replica and on a frozen source, so
    `dormancy.set` is refused for the right reason.
  - The other surfaces main added sit behind classified methods: dormant-claude wake through `char.run`, phone
    and page wake through `char.revive`, and profile rename through `docs.rename`.
  - Both dispatch paths pass `ownership`: the phone HTTP POST and the socket.
- **Idle close vs rest, activation, carried terminals and a handover in flight.**
  - `tick` returns on a daemon that is not writable. `endIdleAgents` checks again after `ps` and after each close
    (`fleet.ts:438`).
  - The tick is tracked, so a freeze's `settle()` waits out a close in flight before the rest starts.
  - `drowsy` needs a live window, so a dormant, carried or rested terminal is never closed.
  - `doRevive` resets `lastActivityAt`, so a woken terminal is not closed again straight away.
  - An idle-closed character keeps its agent through main's SessionEnd guard and the frozen guard, so the
    inventory carries its transcript. It is not `restedBy`, so activation leaves it dormant. A replica or frozen
    daemon refuses its revive.
  - The page's quiet wake waits while `holdsTerminals` and for a slot with a resume error. With the flag off both
    are false, so main's behaviour is unchanged.
  - The new freeze test (`fleet.test.ts:488`) fails without the check.
- **Secrets in Files.**
  - `fleetKeys` is main's list plus `relay-secret`. It feeds `refused()` for every `~/.archipelago*` home.
  - fleet.json, node.json, config.json.bak, owner.json, machine.json, machines.json, the journals, replicas, the
    controller route and registry hold no token.
  - The daemon test reads fleet.json and node.json and is refused `relay-secret`.
- **Bundle ids.**
  - Outside the ledger, `com.archipelago` appears only in the `OLD_*` constants, their migration and uninstall
    tests, one warning string and old spike docs.
  - Info.plist, Swift (`Bundle.main.bundleIdentifier`), launchd labels and `desktop-install.sh` use
    `io.github.linusroxbergh`. systemd units keep `archipelago-archid@<fleet>` and `archipelago-gateway`.
  - `moveOldIds` runs before `moveProfileAgents` rewrites the moved plists onto `current`.
- **Agent profiles vs path classification.**
  - `agentProfile`, `agent.promptId` and `second.agent.promptId` are in `NOT_PATHS`.
  - `panePath` is FORBIDDEN and stripped (`inventory.test.ts` asserts it).
  - `background` and `dormantAfterHours` are not strings, so the walker skips them correctly. The walker fails on
    any unlisted string, so the test is green because every field is listed.
- **Quit guard vs detach.**
  - Quit menu or chord → `applicationShouldTerminate` → `quit.ask`/`quit.answer` → `applicationWillTerminate` →
    `closeAll` → `HandoverSession.stop()`. That closes the attach's stdin, then SIGTERMs the attach alone.
  - No quit path sends `handover.abort` or `.cancel`. The only `handover.cancel` is the sheet's own Cancel.
  - Crash recovery's `reset()` leaves the handover session alone, and the reloaded page attaches again.
- **Follow-up behaviours.**
  - Idle-sweep re-check: correct, tested, and needed by the rebase.
  - Kept idle-close revive: correct for the main slot and tested. See M1, M3 and M7.
  - Wake-on-open waits during a handover: correct, and two DOM tests fail without it.
  - "Resume failed" label and chip: correct, and required by `spec.md:597` once main removed the "dormant" label.
    See M7.
  - desktop-install order: release setup runs after the app is in place, which `moveOldIds` needs. `--silent` is
    right for pnpm 12.
  - `setup --check`: compares against `current` with `--release` and against this checkout without it, and skips
    the plist and old ids on Linux.
  - `bin.ts`: waits on fleet.json, node.json, config.json(.bak) and state.json.
  - Doctor's config lines: see M5 and M6.
- **Protocol, state and flag.**
  - `PROTOCOL_VERSION` is 15.
  - A v7 file carrying every field main 615da858 writes today was run through `migrateState` at fe22ba68:
    `migrated: true`, `dropped: []`, and the result deep-equals the input apart from version 8 and `second.cwd`.
    That v7 fixture also passes main's own `FleetState` as it stands.
  - v6 and v7 both lift through `liftV8`. `emptyState()` is v8 with main's `DORMANT_AFTER_HOURS`.
  - `handover.enabled` defaults to false in `FleetConfig`, in `ArchiHome.swift` and in the page.

## Tests run on fe22ba68

| Command | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm vitest run --project protocol` | 10 files, 137 passed |
| archid ownership, reconcile, dormancy, fleet, store, api | 6 files, 190 passed |
| archid handover destination, source, rest, service; links, daemon, bin | 7 files, 224 passed |
| archid handover inventory, sessions, destination; daemon; config-migration | 5 files, 162 passed |
| archid/cli setup, uninstall, legacy, config, linux-setup, doctor, launch, char, `test/desktop-install` | 13 files, 185 passed |
| web terminal-area, selectors, bridge, bridge-swift, handover, store, terminals, tokens, utility-dock, settings-card, sidecard, map, boot, character-view, notifications, quit | 16 files, 235 passed |

Swift, Playwright and `desktop:install` were not run, because another agent is building from this worktree.

## Notes, not findings

- A rested terminal still resumes as `claude --resume <id>` without the flags its agent ran with. That matches
  the spec, but it differs from main's idle close, which keeps them.
- During the review, `docs/fleet-handover/ledger/progress.md` changed and `task-41-brief.md` and `task-42-brief.md`
  appeared. Another agent made those changes; this review wrote only this file.
