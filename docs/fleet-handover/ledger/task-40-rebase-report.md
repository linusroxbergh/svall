# Task 40a: the fleet handover branch rebased onto main

Branch `experimental-remote-sessions`, rebased from 45856c9b onto `origin/main` 615da858 (#2–#17). The four
commits are kept: the feature (43d2a586 → 8d321c0d), the three docs commits (6c9b50bd, 35c6c78e, bac3290b), then one follow-up,
`The fleet handover branch runs on current main` (fe22ba68), at the tip. Not pushed. Uncommitted: this report.

`git rebase origin/main` stopped once, in the feature commit: 44 files in content conflict. The docs commits
applied clean. The feature commit does not typecheck on its own (main's `paths.config` in `bin.ts`, the
unclassified `dormancy.set`); the follow-up makes the tree green. The v8 shape digest was folded into the
feature commit afterwards (`rebase --autosquash`), so no placeholder is left in it.

## Conflicts, grouped

**Protocol** (`messages.ts`, `state.ts`, tests `messages`, `state-version`)
- `PROTOCOL_VERSION` 15, one above main's 14. `char.update` takes main's `agentProfile` and the branch's `keepHere`.
- State stays at v8 on main's migration framework; `emptyState()` is v8 and keeps main's `DORMANT_AFTER_HOURS`.
  Main changed v7's shape without a version bump (agentProfile, panePath, promptId, background,
  dormantAfterHours), so `state-version.test.ts` records main's v7 digest `113fc38c0ad02fe7` and a new v8 digest
  `650e1236d86ab9a7` (v7 plus the branch's fields). Main's 6→7 lift is untouched; 6 and 7 still take `liftV8`.

**Config** (`archid/src/config.ts`, plus `cli doctor.ts`)
- Main's `InvalidConfig` and its one-line zod message kept; `parseConfig(text, file, schema)` now takes the
  schema, and the branch's `read(file, schema)` goes through it, so every fleet.json/node.json/config.json error
  is an `InvalidConfig`.
- Doctor's new `config` check reads fleet.json and node.json, or a config.json not yet split, with their
  schemas (main read config.json alone).

**Daemon** (`fleet.ts`, `reconcile.ts`, `store.ts`, `main.ts`, `api/methods.ts`, `api/server.ts`, `links/git.ts`, `profile.ts`)
- fleet: the branch's `Deps` (ownership, refreshLinks) plus main's `processes`; `terminal()` keeps main's
  name-based messages and the branch's dormant-second check; the poll keeps the branch's `carried` settle and
  skip, and main's `panePath` rule, `ending` guard and dropped in-memory pane-path map; the re-attach also clears
  `resumeError`; `updateCharacter` takes `agentProfile` and `keepHere`; `doRevive` takes main's prompt and
  activity reset and also clears `resumeError`.
- reconcile: `reviveCommand(slot, flags)` and `markSlotDormant(slot, flags)` carry main's launch flags;
  main's "nothing runs until the revive" status reset moved into `markSlotDormant`, so a dormant second
  terminal gets it too; `markDormant(c, flags)` wraps it. A reconcile leaves an already-dormant character's
  revive alone (main's rule) and still clears `resumeError`/`revive` on re-attach (the branch's).
- store: main's kept-copy hint for a newer state.json, after the branch's durable temp cleanup.
- main.ts: `loadConfig(paths)` and main's early `Store.load`; `fleetKeys` imported beside `installedScripts`;
  the API gets `agentProfiles`, the branch's live `origins`, `ownership` and `handover`.
- methods/server: `Ctx`/`Opts` carry both `agentProfiles` and `ownership`/`handover`.
- git: the branch's `GitRunner`; `resolveRepo` keeps main's fallback for a repository before its first commit
  (`symbolic-ref` when the rev-parse fails after printing the paths).
- profile: main's `BUNDLE_ID`, `LAUNCHD_LABEL` under io.github.linusroxbergh and the `OLD_*` ids; the branch's
  reserved commands.

**Setup, uninstall, launch** (`archid setup.ts`, `uninstall.ts`, `cli setup.ts`, `uninstall.ts`, `launch.ts`, `scripts/desktop-install.sh`)
- archid setup: main's `daemonPath` (adds the folder claude/codex are found in), `plistText`, `plistRun`,
  `plistCurrent`, now over the branch's `RunFrom` (`daemonProgram` for a release or a checkout). The branch's
  `launchdPath` is gone; `moveProfileAgents` writes through `plistText`. `shimsCurrent(shimDir, from)`
  generalises main's "runs this checkout" to "runs this checkout or this release"; one `unxml`.
- uninstall: main's `appQuit`/`quitApp`, codex-file removal and old labels; the branch's systemd units,
  releases and release shims. `runUninstall` takes both `app` and the Linux options.
- cli setup: main's old-id move (`moveOldIds`) before the branch's release install and platform setup, main's
  sign-in warning (macOS only); `--check` compares shims and plist against what `archi setup` with the same
  flags would run (the installed `current` with `--release`, else this checkout), and skips the plist and old
  ids on Linux.
- launch: the branch's imports plus main's refusal beside an old-label agent.
- desktop-install.sh: main's GhosttyKit fetch/build, SDK checks and pid-by-pid window close; the branch's
  unconditional release setup, now after the app is installed (main's order: sign-ins move once the new app is
  in place). Main's "set up when out of date" detection is moot and gone. `--check` passes `--release` so it
  judges the release install; `pnpm -s archi` became `pnpm --silent archi` (pnpm 12 rejects `-s`).

**Web** (`TerminalArea`, `selectors`, `Sidebar`, `map/Token`, `SettingsCard`, `UtilityDock`, `bridge.ts`, `styles.css`)
- Main dropped the `dormant` display status and the `isDormant` selector; the branch's `resumeErrorOf` stays.
  `slotStatus` applies main's rule (a window-less slot shows working/blocked as idle) to both slots.
- TerminalArea: main's quiet wake (auto-revive after a second in view, held after a lost window) and the
  branch's handover rest (`resting`, renamed from the branch's `held`). The auto-wake also waits while a
  handover rests the fleet and for a slot a handover could not resume (`failed`); those, a dormant second
  terminal and main's held case show the Revive button, with the resume error when there is one.
- Sidebar and token: main's quiet look, plus a "resume failed" label (sidebar, `.sb-sub` restored) and chip
  (token) whose title is the error, shown only while the fleet asks for handover.
- SettingsCard: main's Dormancy row and the branch's Machines section. UtilityDock: main's `tabs` ref with the
  branch's owner badge and Handover tab. bridge.ts: the branch's host/handover messages and main's `quit.answer`.

**Swift** (`Bridge.swift`, `ShellRouter.swift`)
- The branch's host/handover messages and main's `quit.answer`/`quitAsk`, `shellCutout(rects, passive)`,
  `notifyPost(promptId)`; the branch's `.quit` (terminate from the page) is gone, as main quits through the
  shell's own guard.

**Tests, README, .gitignore**
- Test harnesses: main's `started`/`cleanup` start pattern with the branch's `ownerOf` ownership; main's
  `Workspace(refused(), docs[])` signature; `processes` in the fleet harness; main's cleanup plus the
  `ARCHI_RELEASE_ROOT` reset in tmux tests.
- setup/uninstall/doctor tests: main's new labels with the branch's node.json/fleet.json and `program`;
  doctor's config test covers fleet.json, node.json and an unsplit config.json.
- README: the branch's fleet.json/node.json table with main's new label and "waits for it to change" line;
  main's LaunchAgents path with the branch's release lines. `.gitignore`: both.

## Integration checks

**Ownership guard.** Main added one RPC method, `dormancy.set`; it is a `mutation`. The other new surface is
parameters on classified methods (`char.answer` promptId, `char.create`/`char.update` agentProfile) and new
behaviour behind them: a dormant claude woken by `char.run` (mutation), phone and desktop wake through
`char.revive` (terminal), profile rename through `docs.rename` (mutation). `classification` is a
`Record<MethodName, …>`, so typecheck failed until it was classified, and the fence tests in
`ownership.test.ts` now call `dormancy.set` on an inactive replica and a frozen source and see `not_owner` and
`frozen`.

**Idle close vs rest/activation.**
- `endIdleAgents` runs from the poll, which returns on a non-writable daemon, but it awaits `ps` and each
  agent's exit; it now checks `writable()` again before each close, so a freeze that lands meanwhile stops it.
  New test: a freeze during the `ps` wait leaves the agent's window up (fails without the check).
- An idle-closed character keeps its agent (main ignores the closing window's SessionEnd), so the inventory
  carries its transcript. `importState` used to recompute every revive command, which drops main's launch
  flags; a terminal this handover did not rest now keeps the revive it went dormant with. New test in
  `sessions.test.ts` (fails without it).
- Activation still wakes only terminals this handover rested; an idle-closed one stays dormant on the
  destination until opened, and the daemon refuses its revive before Commit (replica/frozen).
- The page's quiet wake waits while `holdsTerminals` (the handover is resting or moving the fleet) and for a
  slot with a resume error; two new DOM tests.

**Secrets in Files.** Main's `fleetKeys` (token, mobile-key, .env, vapid.json, push.json) now also holds the
branch's `relay-secret` (written by prepare). config.json was never refused, and fleet.json/node.json hold no
secret, so they stay readable as config.json was; owner.json, machine.json, the journals and the controller
registry hold no token. The daemon test reads fleet.json and node.json and is refused relay-secret.

**Bundle ids.** Every macOS id the branch names comes from `profile.ts` (`LAUNCHD_LABEL`, `profileLabel`);
Info.plist and Swift read `Bundle.main.bundleIdentifier`. desktop-install.sh restarts
`io.github.linusroxbergh.archipelago.archid*`. Tests the branch wrote against `com.archipelago.archid.work`
(profile agents moving onto a release) use the new label. systemd units keep `archipelago-archid@<fleet>` and
`archipelago-gateway`. Only historical ledger files still say com.archipelago.

**Agent profiles.** `agentProfile` (a name) is in `NOT_PATHS`; `agent.promptId` and `second.agent.promptId`
too; main's `panePath` is `forbidden` (the tmux pane's own path, re-read on the new machine), stripped from the
exported snapshot, with the forbidden-field test extended. `agent.background` is a boolean literal. The
fleet home gains `agent-profiles/`, `<id>.prompt` and `state.json.v7-*` copies; none is carried (the fleet home
stays on its machine), which the classification test does not yet cover (Task 42).

**Quit guard / crash recovery.** Quit goes Quit menu or chord → `applicationShouldTerminate` → the page names
unsaved docs → `applicationWillTerminate` → `router.closeAll()` → `HandoverSession.stop()`, which closes only
the attach's stdin; nothing sends `handover.abort` or `.cancel`. A crashed page reloads through `reset()`, which
leaves the handover session alone, and the new page attaches again.

**Stale fixtures.** `service.test.ts` (protocol 10, stateSchema 7) and cli `controller/handover.test.ts`
(stateSchema 7) now use `PROTOCOL_VERSION` and `emptyState().version`.

## Follow-up commit (ports no conflict forced)

- `bin.ts` waits on fleet.json, node.json, config.json(.bak) and state.json instead of main's `paths.config`;
  `initConfig`'s two config.json refusals are `InvalidConfig`, so launchd's daemon waits for a fix too.
- `guard.ts` `dormancy.set`; `paths.ts` `fleetKeys` + relay-secret; `portable-path.ts` classifications;
  `validate.ts` kept revives; `fleet.ts` the freeze check and the dormant second's promptId/background reset
  on open.
- Tests: legacy/setup `program` and `RunFrom`, the profile-agent label, the daemon Files test, the
  selectors test for a window-less second terminal, the e2e handover specs (dormant label → resume-failed
  label/chip, `data-dormant` → state poll, and with handover off a failed resume wakes like any dormant one),
  new tests listed above, the two stale fixtures, README's dev tip (`node.json`).

## Verification (base 615da858)

`pnpm install --frozen-lockfile`: no lockfile change (main added no dependency). All runs on the final tree fe22ba68.

| Command | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm vitest run --project protocol` | 10 files, 137 passed |
| `pnpm vitest run --project archid` | 80 files passed, 1 skipped; 1515 passed, 4 skipped |
| `pnpm vitest run --project cli` | 30 files, 515 passed, 3 skipped |
| `pnpm vitest run --project @archipelago/desktop-web` | 63 files, 684 passed |
| `pnpm vitest run --project scripts` | 2 files, 22 passed |
| `swift test --package-path apps/desktop/mac` | 65 tests, 0 failures, no warnings in our sources |
| `pnpm --filter @archipelago/desktop-web exec playwright test` | 151 passed (3.3 min), exit 0; the runner now exits on its own |

No known load flake fired. Skips are environment-gated (live ssh, no rsync 3, no Ghostty). The first full
e2e run failed one handover test on main's removed `data-dormant`, fixed in the follow-up; the spec then
passed alone (11) and in the full run above. `archi setup --check`, with and without `--release`, was run once
against a temporary HOME and exited 0.

## Unsure / worth a look

- Agent profiles and entity docs stay behind: a moved character's `agentProfile` names a file the destination
  lacks, so its brief goes without the role until the profile is copied; the destination seeds only the
  default profiles. Task 42 should carry `agent-profiles/` with the docs.
- `importState` keeps the source's revive for a terminal it did not rest; a revive written by an older build
  (for example codex without `-c tui.resume_cwd=session`) travels as it was. Kept flags are plain words, but
  a codex `--local-provider`/`-p` value could name something machine-local.
- A rested terminal still resumes without the launch flags its agent ran with (the rest never read them);
  main now reads them for idle close (`startFlags`), and the rest could do the same.
- The resume-failed label/chip is new UI on main's quiet look, shown only with handover on; with handover off a
  failed resume auto-wakes like any dormant character.
- `restartHint` still names launchctl on Linux (unchanged by this rebase).
- Linux daemon lock still uses macOS `O_EXLOCK` (Task 42).
