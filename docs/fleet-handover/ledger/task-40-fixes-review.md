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

## Fix round 1

**Verdict: Approved.** Critical 0, Important 0, Minor 2.

Reviewed a30024da..4354a256 on c25a2f25 against `task-40-fix1-findings.md` (R1–R6), the report
`task-40-fix1-report.md` and the smoke's N1/N2. Every R-item is addressed. Each commit touches only its item's files,
and each new test fails with its commit's source reverted. m1–m5 are closed. The two new findings are both in R5, and
neither blocks the next smoke.

### Findings

**m6 (R5, the implementer's concern 1). On an upgrade, the far machine now runs the uploaded archive's own `archi`
before any check against a pinned signer, so its signature check vouches for itself.**
`packages/cli/src/controller/host.ts:444-450`, `packages/cli/src/controller/install.ts:136-141`.
- `bootstrapSetup` unpacks the upload and runs `<staging>/releases/<v>/bin/archi setup --release …`. That archi's
  `allowedSigners()` is `$ARCHI_RELEASE_ROOT/release/allowed_signers`, which is the file inside the archive being
  checked (`scripts/install-release.mjs:20-24`).
- Before R5, the installed release's `archi` checked the upgrade against the signers it had pinned. That is the design
  `install-release.mjs:20` states ("an installed release carries the signers its own upgrades are checked against").
  It is also the spec's rule (`spec.md:284-286`): installers verify with `ssh-keygen -Y verify` against a pinned
  allowed-signers entry before the archive is unpacked.
- **Is it a real integrity regression?** Against that rule, yes: the far side's check is now circular, and code from
  the archive runs before any pinned check. In practice nobody can exploit it who does not already hold the user's
  account:
  - the controller still refuses an archive its own pinned signers do not vouch for (`inspectCompanion` and
    `requireCompatible`) before the upload;
  - the upload goes over the authenticated ssh master;
  - a compromised controller has a shell on the far machine anyway.

  What is lost is the second, independent check, and a key rotation now rests on the controller's signers alone. That
  makes it Minor, not Important.
- **What it should be:** keep the new release's own setup, which fixes N1, but authenticate with system tools first.
  Before running anything from staging, run on the far machine, in `<staging>/releases/<v>`:
  - `ssh-keygen -Y verify -f <archiBase>/current/release/allowed_signers -I archipelago-release -n archipelago-release -s SHA256SUMS.sig < SHA256SUMS`;
  - then `sha256sum -c --strict --quiet SHA256SUMS`.

  An `--allow-unsigned` upgrade skips the signature step and keeps the digest check. An installed release with no
  `release/allowed_signers` falls back to the controller's check and says so. Test it with the exec-mode far machine:
  an archive signed by a key the installed release does not list is refused before any staged file runs.
- If the controller's check is meant to be the only one, amend `spec.md:284-286` to say so for every companion
  install, as `inspectCompanion`'s comment already does for `host add`.

**m7 (R5, the implementer's concern 3). The install step still says `ok` with setup's last output line.**
`packages/cli/src/controller/host.ts:450`, with `packages/cli/src/commands/setup.ts:190`.
- Setup prints `done` first and its warnings after it, so the last line is usually an unrelated warning, as N1's
  `! path … is not on PATH` was.
- When the new release's own setup puts the old release back, its line `the daemon did not answer: current -> …` sits
  above that warning, and the step still reports `ok`.
- The probe and rollback steps now report the truth, so the result and actions are right. Only the first line the user
  reads is wrong.
- Fix: run setup with `--json`. Show its `release … -> …` line, and mark the step `warn` when `done` holds
  `the daemon did not answer`.

### The R-items, verified

| Item | What was checked | Failed without the fix (re-run by me) |
| --- | --- | --- |
| R4 (m5) | `refused.replace(/\.$/, '')` before the suffix; the test pins both endings | 1 |
| R1 (m1) | setup builds `realPreflightDeps(t.home, platform)` once and uses `findAgents(pre.agentPath ?? pre.pathEnv)`, as doctor does; macOS is unchanged (`agentPath` is undefined there) | 1 |
| R2 (m2) | `wakeSlot` takes the carried revive before opening, and all three `lay()` calls put it back while the agent's session is unchanged; the `lay()` docstring is true again | 1 |
| R3 (m3, m4) | each field is `#{s/\\\\/(<token>)/:f}`, then the decode of `\ooo`, `\a \b \f \r \v` and `\$`, then the placeholder goes back to `\`; the 3.4 shape now escapes `$` | 2; against `adcee29c^`'s `tmux.ts`, 4, the real-tmux session test under the empty locale included |
| R6 (N2) | `setupUser` skips `installHomeTemplate` when `owner.json` names another machine; the test checks the tree is byte- and mtime-identical, that `ReplicaStore.claim` answers `replica`, and that the owner's own setup refreshes | 1 |
| R5 (N1) | bootstrap install by the new release; the probe requires `system.info.release` to be the new one; the rollback runs the new `archi setup --rollback <before>`; `current` is read back into the action; `--rollback ../x` is refused | 5 (4 host, 1 cli) |

- **R3's container evidence** (`t40x/tmux34`):
  - `run-new.mjs` carries the committed `listing()` and `unescape`.
  - On real tmux 3.4 with no LANG, 16 of 16 paths come back exact, where HEAD before R3 read 7 of 16. The 16 include
    `a$b`, `$work`, `a${b}`, `a\b`, `back\slash\037\$x`, and bell/CR/DEL.
  - The Mac's 3.7c reads 16 of 16 with both builds.
  - The escape set agrees with what 3.4's vis prints: C escapes only for `\a \b \f \r \v`, tab and newline as they
    are, octal for the rest.
  - The decode is a no-op on 3.7c, because every backslash has been swapped out before tmux prints.
- **R6's reach.** Mission control's folder is written only by setup and by the owner's `begin()` → `ensureHome()`, so
  the rule covers every writer.
  - `machineId()` runs only after `owner.json` parses, so setup mints no id on a fresh machine.
  - Concern 5 (an all-zero owner counts as elsewhere) is right: that daemon owns nothing, and its `begin()` refreshes
    the folder once the gateway names it.
- **R5's tests** are at the controller level, as briefed:
  - the exec-mode far machine has a real `current` link, and a per-release `archi` whose setup keeps an install only
    while the new daemon speaks its protocol;
  - the protocol-bump upgrade ends `ready` with no rollback;
  - the no-answer case goes back to the named 1.2.2, not the mtime-newest 1.2.1;
  - the setup-rolled-back case is caught by the release check.

### The implementer's concerns, judged

1. The far machine verifying against the archive's own signers: **m6**, above.
2. The gateway is not restarted on rollback. This was so before R5, and it is outside R5. Leave it, and track it with
   the Linux upgrade work.
3. The install line: **m7**, above.
4. **A daemon death mid-wake loses the flags.** Acceptable to leave:
   - The unit's `KillMode=process` keeps tmux alive across a daemon death, so on restart the pane usually still holds
     the agent and nothing is laid.
   - The flags are lost only when the resumed agent also died meanwhile.
   - The spec's rule for a failed resume (dormant, transcript, visible error) still holds.
   - If it is to be closed, the cheap way needs no new state. `doRevive` and `doOpenSecond` (`fleet.ts:752`, `:785`)
     could keep `revive` while the slot is carried, as reconcile already does through `carried()`, and the next
     reconcile after activation records the slot clears it.
5. and 6. Agreed, no action.

### Tests run (HEAD c29e530a, in a scratch copy)

| Command | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm vitest run --project protocol --project archid --project cli --project @archipelago/desktop-web --project scripts` | 189 files passed, 2 failed, 1 skipped; 2973 passed, 2 failed, 6 skipped |

- `cli.test` `--version` fails only because the scratch copy has no `.git`.
- `fleet.test` "ends an agent idle past the limit and resumes it with the flags it was started with" failed once
  under load average 9 (`agent` undefined after the revive). It then passed 3 of 3 alone. It sits in the known
  fleet.test revive-flake family, and round 1 does not touch it.
- The worktree holds an uncommitted edit to `ledger/task-41-brief.md` that is not this review's. This review
  appended only this section.
