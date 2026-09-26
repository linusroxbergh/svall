# Task 40 review: the second rebase and the fix wave

**Part 1, the second rebase (615da858..b22e6e85 → 86fcac4d..63f254ab): Approved.**
**Part 2, the fix wave (44730499..f1bceb6b, F1–F12): Approved.**
Critical 0, Important 0, Minor 5 (1 in part 1, 4 in part 2).

Nothing from main (#18, #20–#23) or from the branch was dropped. Every integration item the rebase brief names is
in the code. Every fix item does what its brief asks and stays inside its item. Each item's new tests fail when that
item's source change is reverted, and they pass at the tip. F8's listing splits every row on a real tmux 3.4 and on
3.7c. The container evidence matches the committed code. The five findings are small, and none blocks the second
smoke.

## Findings

### Critical

None.

### Important

None.

### Minor

**m1 (part 1). On Linux, `archi setup` looks for claude and codex on the ssh PATH, not the PATH the unit runs with.**
`packages/cli/src/commands/setup.ts:130-136`, which feeds `setupLinux` at `packages/archid/src/linux/setup.ts:128-131`.
- `host add` runs `archi setup` over ssh (`controller/install.ts:141`). That shell's PATH lacks `~/.local/bin`, as the
  smoke's D4 showed. So `findAgents(process.env.PATH)` finds neither CLI there.
- In the same run, the preflight uses the unit's PATH (`doctor.ts:422`) and reports both CLIs found.
- The result: setup writes the Claude hooks only when `~/.claude` already exists, and Codex's only when `~/.codex`
  exists. The daemon's start repairs Codex, because `main.ts:95-101` searches the unit's PATH. Nothing repairs
  Claude.
- `host doctor` then fails `hooks: not installed in ~/.claude/settings.json: archi setup`, and running `archi setup`
  over ssh again misses the same way.
- Before the rebase, `setupLinux` always wrote the Claude hooks. The smoke did not show this because the copied
  credentials had created `~/.claude`.
- Fix: in `setupCommand`, build `realPreflightDeps(t.home)` once and use `findAgents(pre.agentPath ?? pre.pathEnv)`,
  as `doctorCommand` does (`doctor.ts:433,446`). Add a Linux test in which the agents are only on the unit's PATH.

**m2 (F3). A wake that fails drops the launch flags of the revive the terminal carried.**
`packages/archid/src/handover/destination.ts:637-645`.
- `lay()` says it "leaves a terminal dormant with the agent and resume command it carries". But
  `markDormant(cur)` and `markSlotDormant(cur.second)` rebuild the revive as a bare `claude --resume <id>` or
  `codex resume … <id>`.
- So after a failed resume, the revive the user starts from the "resume failed" chip or the phone runs without
  `--dangerously-skip-permissions`, `--effort`, codex `-m`/`-s` and so on. That goes against the amended spec line
  (`spec.md:496`).
- The fix report lists this as concern 3 and calls it main's behaviour after any failed revive. Main never had a
  carried revive to keep, though, and the docstring now says something the code does not do.
- Fix: keep the slot's `revive` when `lay()` makes it dormant (save it before the call and put it back while the
  agent's session is unchanged). Add a destination test with a failing wake of a rested terminal that carried flags.

**m3 (F8). On tmux 3.4, names and paths are kept as tmux prints them, with its escapes.**
`packages/archid/src/tmux/tmux.ts:59-66, 207-214`.
- 3.4 prints a control character as `\ooo`, and `$` followed by another character as `\$`. It does not escape a
  backslash. The evidence:
  - the container run `t40f/tmux34/real-34.out`: c_2, c_3, c_4 and c_6 differ, `a$b` → `a\$b`;
  - `probe4-34.out`: `$x` → `\$x`, and `a\b` → `a\b`.
- The listing splits correctly, but these values come through as text that is no real path.
- On the Linux gateway, `attachSlot` takes `w.path` on every poll (`reconcile.ts:47`, `fleet.ts:369`). A second
  terminal in `…/$work` therefore gets `second.cwd = …/\$work`. The main slot takes the same text once its pane path
  changes (`fleet.ts:391`). The return handover then carries a cwd that exists on neither machine.
- A stray window's name is read escaped too. Directories like this are rare, so this is Minor.
- Fix: the one the fix report suggests. Have tmux replace each backslash in `window_name` and `pane_current_path`
  with a placeholder made per listing (`#{s/…/…/:…}`). Then decode `\ooo` and `\$`, and put the placeholder back as
  a backslash. After the substitution the only backslashes in the output are tmux's own escapes, so the decode is
  safe on 3.7c as well.

**m4 (F8 tests). The 3.4 test shape leaves out the `$` escape, and the session test passes on the code before the fix.**
`packages/archid/test/tmux-listing.test.ts:47, 72`.
- The `3.4` shape escapes control characters only. Real 3.4 also turns `$x` into `\$x`, so the unit tests do not
  cover what 3.4 does to a `$`.
- `reads every session` passes in both shapes with `tmux.ts` as it was at adcee29c^ (the tab-separated
  `listSessions`), because 3.4 prints a tab as is. So the new session listing has no test that fails
  without it.
- Fix: add `$` to the 3.4 shape and to a name in the rows. Give one session a name with a tab, or list sessions in
  the real-tmux test under the empty locale, where both versions print a tab as `_` without `-u`.

**m5 (F5). Doctor's refusal line has a stray period.**
`packages/cli/src/commands/doctor.ts:167`, `packages/archid/src/config.ts:54-61`.
- `configRefusal`'s text ends in a full stop, and doctor appends `; a stopped archid waits for it to be fixed`. The
  line reads "…and delete it.; a stopped archid waits…" (and "…and start again.; …").
- Fix: drop the full stop before appending, or append a separate sentence.

## Part 1: the second rebase, verified clean

- **Range-diff** (`git range-diff 615da858..b22e6e85 86fcac4d..63f254ab`):
  - all eight commits pair up. The three docs commits and three ledger commits are `=`.
  - 0233fa99 and db22a428 differ only where main's code moved under them. 63f254ab is new.
  - Every changed hunk in the range-diff was read. Examples: README (main's `mainAgent`/`home`/`scribe` rows with the
    File column, and `--replace-settings` in main's reworded paragraph), `isVeiled` and `setFleet` (both sides'
    fields), and `Deps`/`main.ts` (`ownership` beside `agentsFound`). Also `setupUser`/`runSetup` (main's optional
    settings and `agents` beside `RunFrom`, `replaceSettings` and `moveProfileAgents`), doctor's `run(cmd, args,
    { path, env })`, the protocol version and the digests.
- **Nothing dropped, checked mechanically.**
  - For every file either side touched, each line either side added was looked up in 63f254ab. Every miss was a line
    the resolution rewrote on purpose: config.json → fleet.json, the joined `isVeiled`/`setFleet`/`Deps` lines,
    `saveMainAgent(paths)`, protocol 17 and the digests, doctor's run signature, and the desktop-install check/setup
    lines. Each was read and is right.
  - The files where (old branch → result) differs from (base → main) are exactly the 23 files `git merge-tree` lists
    plus the 17 of the tip commit. The same holds the other way round.
  - `api/bundle.ts` stays deleted, and main did not touch it.
- **`mainAgent` sits in fleet.json.**
  - `FleetConfig.mainAgent` is optional, and `NodeConfig` has no `mainAgent`. The protocol test checks both.
  - A legacy split routes it into fleet.json (config-migration test).
  - `saveMainAgent(paths)` splits first. It keeps every other key, refuses a file that does not parse, and writes a
    linked file where the link points, with its mode.
  - `configuredMainAgent` reads without writing.
  - `mainAgent.set` and `archi agent` both write fleet.json.
  - The destination's `adopt` takes the incoming fleet.json in place, and `begin()` → `syncAgents()` recomputes
    `mainAgent`/`agentsFound` from the destination's own PATH.
- **Adapters side by side.**
  - Main's `AGENTS` drive doctor (on `agentPath` on Linux, with the fleet's keys), setup and `archi agent`.
  - The branch's session adapters and `probeAgent` are untouched.
  - `found` in doctor uses `agentPath ?? pathEnv`.
- **Fence.** `island.reorder` and `mainAgent.set` are both `mutation` (`guard.ts`).
  - `ownership.test` asserts that the classification keys equal `methods`.
  - It calls every mutation with `{}` params. Both methods are refused `not_owner` on a replica and `frozen` on a
    frozen source, which shows the fence runs before param validation.
- **Setup for installed CLIs only.**
  - `runSetup` (the release path) and `setupLinux` apply main's rule, and a missing `CODEX_HOME` is made
    (linux-setup test).
  - The one gap is where the Linux CLI takes its `agents` from (m1).
- **`desktop-install.sh` and its test.**
  - The script has main's one-column output.
  - `--check --release …` runs before the build. The test's stubbed pnpm sees it.
  - Setup always runs with `--allow-unsigned --release …`, after the app is copied.
  - Main's `SETUP` detection and `HOME_DIR` are gone. Setup's `!` lines are shown and its output goes to the log.
- **Versions.**
  - `PROTOCOL_VERSION` is 17, against main's 16.
  - State stays at v8. The v7 digest `3604be063be8ab2b` equals main's own test.
  - `liftV8` spreads the raw state, so main's `island.order`, `mainAgent`, `agentsFound` and `scribeAgent` survive
    migration.
  - No branch code reads `scribe.agent`, which is now optional.

## Part 2: the fix wave, verified clean

- **Shape.** There is one commit per item, and each touches only its item's files. Subjects follow the repository
  style. F5–F12 were rebased at 16:59:58 so that F5 could take its fixture; the content matches the report.
- **Failing first, re-run by me.** In a scratch copy of the tree, each item's source files were set to the commit's
  parent and its tests to the commit, then run:

  | Item | Failed without the fix |
  | --- | --- |
  | F1 | 2 (sessions: the second slot and the agentless case; fleet: the term-2 SessionEnd) |
  | F2 | 1 |
  | F3 | 3 |
  | F4 | 1 |
  | F5 | 1 (`config: ok` for both layouts) |
  | F6 | 2 |
  | F8 | 2 (the real-tmux listing under an empty locale, and the 3.4 window shape; see m4) |
  | F9 | 1 (`ENOENT … releases/0.0.0-test/agent-profiles`) |
  | F10 | 2 |
  | F11 | 6 |
  | F12 | 1 |

  F7 is tests only, and its items match M7 one for one.
- **F1.**
  - The SessionEnd guard now covers either slot while its window is gone.
  - `importState` keeps a revive only for a slot that still has an agent.
  - `lay()`'s `markSlotDormant` also benefits: the kill's SessionEnd no longer clears a second slot's agent.
- **F2.**
  - `exportSnapshot` removes `agent.pid` and `second.agent.pid`.
  - It is the only way state leaves the machine (`inventory.ts:166`), and `importState` runs it again.
- **F3.**
  - The rest takes `startFlags` from ps for the process holding the pane, and captures them before any terminate.
    A launch that cannot be repeated resumes bare.
  - Import keeps the revive whether the handover rested the terminal or it was already dormant.
  - `portableRevive` drops `-p`, `--profile` and `--local-provider` together with their values, `--profile=work`
    included: `startFlags` splits it (probed).
  - The spec amendment is one sentence and matches the code, apart from m2 after a failed wake.
- **F4 and F5.** `attachSlot` keeps the old `cwd`. `configRefusal` is the one helper that `initConfig` and doctor both
  call.
- **F6.**
  - `plistRun` returns the first `ProgramArguments` string, and a real `launchdPlist` survives the round trip.
  - Nothing else reads the old `.tsx` field or the old ok text.
- **F8, the formats.** I grepped every `-F` and `-p` format. Only `listWindows` and `listSessions` carry names or
  paths. `hasWindow`, `attachSession` and `newWindow` read only ids, capture-pane is not a format, and the control
  client parses only ids and `%output`.
- **F8, the container evidence.**
  - `t40f/tmux34/run-new.mjs` holds the committed `listing()` and `-u`; `run-old.mjs` has neither.
  - On real tmux 3.4 in `ubuntu:24.04` with no LANG, the new code lists 7 of 7 windows with exact ids, panes and
    names. The old code lists one garbage row.
  - Paths differ only as described in m3.
- **F9.**
  - `agent-profiles` is in `DIRS` and in `stageAssets`.
  - The full release-build test ran here and compares `hooks`, `home`, `systemd` and `agent-profiles` with the
    checkout.
  - `agent-profiles.ts` resolves `../agent-profiles` from `lib/`, which is the release root.
- **F10.**
  - Reconcile adopts no row without a name, a pane and a path.
  - The store checks each character a patch touches before it commits, so on a throw neither the file nor any
    listener sees a change.
  - Hook numbers are filtered before they reach state (`num` finite, `pid` a positive integer), and every value
    reconcile writes is a string or a finite number, so no current path trips the guard.
- **F11.**
  - The probes run as `env 'PATH=<unitPath>' <bin> …`, the same PATH that `host doctor` and the unit use.
  - The binary, `versionOk` floor, `loginArgs`/`loggedIn` and `loginHint` come from main's `AGENTS`.
  - `env`'s 127 means not installed. The login-shell `WHICH` for agents is gone.
- **F12.**
  - The name comes from `--match 'v[0-9]*'`, so a `ghostty-kit` tag no longer names builds.
  - `build.sh` takes `describeVersion()`, so the app, the controller and the companion share one name.
  - `release-stage.mjs` has no main guard, so importing it from `node -e` runs nothing else.
  - Rollback orders releases by mtime, not by name.

## Tests run (HEAD 9be818f5, in a scratch copy, plus one test in the worktree)

| Command | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm vitest run --project protocol --project archid --project cli --project @archipelago/desktop-web --project scripts` | 190 files passed, 1 failed, 1 skipped; 2968 passed, 1 failed, 6 skipped |
| `pnpm test packages/cli/test/cli.test.ts -t "prints the commit"`, in the worktree | 1 passed |

The one failure is `cli.test` "prints the commit it runs from for --version", which needs `.git` and the scratch copy
has none. It passes in the worktree. Swift, Playwright and `desktop:install` were not run, because another agent is
building from this worktree. colima was not started. The container evidence was read, not re-run.

## Notes, not findings

- `--oss` is a kept switch, while `--local-provider` is now dropped. A resume of
  `codex --oss --local-provider lmstudio` becomes `codex --oss` on the destination, which uses that machine's default
  local provider. This follows the ruling. `dormancy.ts:37`'s comment ("values name entries in … config.toml") fits
  `-p` and `--profile` only.
- A second terminal's SessionEnd that lands before the poll sees its window gone still clears the agent, and then
  `loseSecond` drops the slot. F1 covers the other order, as M1 asked. Main's manual close has the same race.
- These rebase items are already in the rebase report's "Unsure" list and left as they are:
  - `archi agent` with no daemon on a replica writes a fleet.json that the next handover overwrites;
  - doctor asks Codex about hook trust through this process's PATH, so on a companion it answers "couldn't ask";
  - preflight does not warn when the destination lacks the fleet's main agent;
  - the scribe model is read once, when the daemon starts.
- This review wrote only this file. The worktree's `git status` was clean before and after.
