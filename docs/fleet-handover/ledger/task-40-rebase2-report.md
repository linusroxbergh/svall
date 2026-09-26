# Task 40a, second rebase: the fleet handover branch on main 86fcac4d

Branch `experimental-remote-sessions`, rebased from 615da858 onto `origin/main` 86fcac4d (#18 main-agent
onboarding, #20–#23). All eight commits are kept: the feature (8d321c0d → 0233fa99), the three docs commits
(4b6e6793, a54db4b2, dc0fa7b2), the first follow-up (fe22ba68 → db22a428), the three ledger commits (1d2fc52e,
2312eca6, d37f636c), then one new commit at the tip, `The fleet handover branch runs on current main's agent
adapters` (63f254ab). Not pushed. Uncommitted: this report.

`git rebase origin/main` stopped twice: 22 files in the feature commit, and `archid/test/fleet.test.ts` in db22a428
(main's hook-receiver lines beside the follow-up's `ownership` return). The docs and ledger commits applied clean.
As before, the feature commit does not typecheck on its own; db22a428 and 63f254ab make the tree green. The v8 shape
digest went into the feature commit directly.

`origin/main` moved to 3217f2c0 (#24, "Let the arranged fleet fill more of the map", 5 files) while this ran. The
brief names 86fcac4d, so the branch stays on it; `git merge-tree` shows #24 merging with the branch without a
conflict.

## Conflicts, grouped

**Protocol** (`messages.ts`, tests `messages`, `state-version`)
- `PROTOCOL_VERSION` 17, one above main's 16. The version test keeps main's `island.reorder` and `mainAgent.set`
  assertions ahead of the branch's handover tests.
- State stays v8. Main changed v7's shape again without a bump (`island.order`, `mainAgent`, `agentsFound`,
  `scribeAgent`), so `state-version.test.ts` records main's v7 digest `3604be063be8ab2b` and a new v8 digest
  `0b0e161c0ff61a03`. `state.ts` itself merged clean.

**Config** (`archid/src/config.ts`, `protocol/src/handover.ts`, `cli doctor.ts`, `archid/test/config.test.ts`)
- Main's `Config` changes moved into `FleetConfig`: `home.command` optional (the crew falls back to the main
  agent's `crewCommand`), `mainAgent` optional, `scribe.agent` optional. `NodeConfig` is unchanged.
- `saveMainAgent(paths, agent)` writes fleet.json (main: config.json), splitting a config.json first through
  `initConfig`; it keeps main's rules (every other key kept, a file that does not parse refused, a linked file
  written where it points with its mode). `fleet.setMainAgent` calls it with the daemon's paths.
- New `configuredMainAgent(paths)`: fleet.json's `mainAgent`, or an unsplit config.json's, without splitting
  anything. Doctor's preflight reads the main agent through it (main called `loadConfig(config.json)`).
- config.test: main's home-default assertions without a `command`, against fleet.json.

**Daemon** (`fleet.ts`, `main.ts`, `setup.ts`, `mobile.ts`, `profile.ts`, `package.json`)
- fleet: `Deps` carries the branch's `ownership`/`refreshLinks` and main's `agentsFound`.
- main.ts: the branch's ownership load, then `new Fleet({ …, ownership, agentsFound })`.
- setup: `setupUser` takes an optional `settings` (main) and the branch's `RunFrom`, installed node and
  `writeShims`; `runSetup` takes main's `agents` beside the branch's `RunFrom`/`replaceSettings`.
- mobile: main's shorter refusal, naming fleet.json.
- profile: main's reserved `agent` added to the branch's reserved commands.
- package.json: main's `./agents` and `./claude` exports; `./bundle` stays gone (the branch deleted `api/bundle.ts`,
  and nothing imports it).

**CLI** (`doctor.ts`, `setup.ts`, `program.ts`, `test/doctor.test.ts`)
- doctor: `run(cmd, args, { path, env })` carries both the branch's agent PATH and main's fleet keys. Main's
  per-CLI `agentChecks` (version floor, login probe) run on `agentPath` on Linux, as the branch's claude check did;
  with no CLI at all the `agents` check fails on macOS and only warns on Linux (the branch's "a companion is
  provisioned before anyone logs an agent in"). Main's `codexCheck` (`codex hooks`, trust through
  `codex app-server`) replaces the branch's codex version check. `realPreflightDeps(home, platform)`. The command
  finds agents on `agentPath` when there is one, else PATH. The branch's rsync, systemd, gateway and linger checks
  stay.
- setup: main's grouped `--check` output and exit code, over the branch's `--release` judgement (`current` or this
  checkout), Linux skips (plist, old ids, sign-ins) and `setupPlatform`; `agents` goes to both platforms.
- program: main's `agent` command; the branch still has no `Client` import (it connects through `connectFor`).
- doctor.test: the fake's `run` records both PATH and env; main's `keys`/`mainAgent`/`found`/`trust` and the
  branch's `platform`/`agentPath`/`rsync` options.

**Web** (`SettingsCard`, `PhonePanel`, `selectors`, `store/fleet.ts`)
- SettingsCard: main's `MainAgent` row (its tip names fleet.json) and the branch's `Machines`; the Fleet config
  button's title is main's trimmed style over the branch's list.
- PhonePanel: main's shorter copy, naming fleet.json.
- `isVeiled` takes main's `deletingIsland` and the branch's `hostOpen`/`handoverOpen`; `setFleet` prunes main's
  `deletingIsland` and clears the branch's `awaitingOwner`.

**Tests, README, install script** (`setup.test`, `README.md`, `scripts/desktop-install.sh`)
- setup.test: main's AGENTS.md and Codex skill assertions, then the branch's `--replace-settings` steps.
- README: main's main-agent paragraph and home-folder text (with `archi setup --replace-settings`), and the
  branch's File column with main's `mainAgent` row in fleet.json.
- desktop-install.sh: main's one-column output (`step`, `bar`, `quiet`, the check file and exit), over the
  branch's rules: `--check --release …` judges the release install, and setup always runs with `--allow-unsigned
  --release …` after the app is in place. Main's `SETUP` detection and `HOME_DIR` stay gone. Setup's output goes
  to the log, and its `!` lines are shown, as main does.

## Integration checks

**Where `mainAgent` lives.** fleet.json. It is the fleet's intent, like `scribe.agent` and `home.command`, which
already travel in fleet.json; what each machine has installed is not stored in either file (`agentsFound` is read
from PATH at every start), so "absent: the only CLI installed, else claude" is decided on whichever machine runs
the fleet. A config.json's `mainAgent` splits into fleet.json (config-migration test). `archi agent <name>` with no
daemon writes fleet.json; with one, the daemon does.

**Adapters, side by side.** Main's `AGENTS` (binary, version floor, login probe, crew command) drives doctor,
setup and `archi agent`. The branch's session adapters (`handover/sessions/`, version ranges per transcript
format) and `probeAgent` drive `system.info` and preflight; `host add`'s probes (`controller/host.ts`) run over
ssh. All three work. Where they could share code (for Task 41b and F11):
- `probeAgent` and `host.ts` run the same `--version`, `claude auth status` and `codex login status` that
  `AGENTS[k].bin`/`loginArgs`/`loggedIn` describe; they could run the adapter's argv and read it with its
  `loggedIn`, as doctor now does.
- `versionOf` (`sessions/records.ts`) and main's `parseVersion`/`versionOk` both read `x.y.z`; once 41b makes the
  session adapters minimum-only, their minimum could be `AGENTS[k].minVersion` checked with `versionOk`, which
  also holds pre-releases below the floor.
- `host.ts` finds CLIs with a remote `WHICH`; main's `findAgents(pathEnv)` is the local form of the same question,
  and doctor's `agentPath` is the unit's PATH that F11 wants `host add` to use.

**RPC methods.** #18 added `mainAgent.set` and #20 `island.reorder`; both are `mutation` in `guard.ts`
(typecheck failed until they were). The fence tests call every classified mutation on an inactive replica and a
frozen source, so both are refused for the right reason. `setMainAgent` writes fleet.json, which a handover
carries, so a refused call during a freeze is what keeps the two machines' fleet.json the same.

**Setup for installed CLIs, release and Linux.** `runSetup` keeps main's rule on the release path (the CLI passes
`agents` through `setupPlatform`). `setupLinux` read the Claude settings and Codex hooks unconditionally; it now
takes `agents` and applies the same rule (Claude when on PATH or its folder exists, Codex likewise, a missing
`CODEX_HOME` made for its hooks). New test in `linux-setup.test.ts`, failing without the change. The daemon's
start-time Codex hook install (main) also runs on a Linux private fleet, with the unit's PATH.

**desktop-install.sh and its test.** Main's test drove its `SETUP` detection, which the branch drops; the harness
now echoes only `BUILD_GHOSTTY`, and "sets up again only when a check asks" became "checks the release install
that setup puts in place on every run" (the stubbed `pnpm` sees `setup --check --release …`). The window-closing
and failure tests pass unchanged.

**New state fields and path classification.** `mainAgent`, `scribeAgent` and `agentsFound` are enums, which the
path walker skips as it skips `agent.kind`; `island.order` is a number. The classification tests pass for that
reason, not by omission. `agentsFound` rides in the snapshot but is recomputed by `syncAgents` when the destination
activates (after `adopt` has taken the incoming fleet.json in place).

**Mission control folder.** Main's start now also writes `AGENTS.md`, `.agents/skills` and `.codex/rules` into
`home.cwd`, which the handover carries as its `home` root; all of it is rewritten from the template on the
destination's start, and an `AGENTS.md.bak-*` travels as the user's file.

## Tip commit (ports no conflict forced)

- `guard.ts`: `island.reorder`, `mainAgent.set`.
- `archi agent`: fleet.json through `saveMainAgent(paths)` and `configuredMainAgent` (main read and wrote
  config.json, which the CLI's `connect` refuses once fleet.json exists).
- `linux/setup.ts`: installed CLIs only.
- Comments in `agents.ts`, `context/launch.ts` and `fleet.ts` that named config.json now name fleet.json.
- Tests: `saveMainAgent` on fleet.json (plus a config.json split first and `configuredMainAgent`), `agent.test`
  on paths, fleet.test's main-agent tests on fleet.json, `islands.test` given ownership, `destination.test`'s state
  home through `Home.parse`, protocol's FleetConfig defaults (`mainAgent`, `home.command`, `scribe.agent` absent;
  node.json drops `mainAgent`), config-migration routes `mainAgent`, cli.test edits fleet.json instead of writing a
  config.json beside it, the two Linux doctor tests on main's agent checks, desktop-install as above, and the
  Linux setup test.

## Verification (base 86fcac4d)

`pnpm install --frozen-lockfile`: no lockfile change. All runs on the final tree 63f254ab.

| Command | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm vitest run --project protocol` | 10 files, 137 passed |
| `pnpm vitest run --project archid` | 82 files passed, 1 skipped; 1547 passed, 3 skipped |
| `pnpm vitest run --project cli` | 33 files, 536 passed, 3 skipped |
| `pnpm vitest run --project @archipelago/desktop-web` | 64 files, 706 passed |
| `pnpm vitest run --project scripts` | 2 files, 26 passed |
| `swift test --package-path apps/desktop/mac` | 65 tests, 0 failures, no warnings in our sources |
| `pnpm --filter @archipelago/desktop-web exec playwright test` | 153 passed (3.2m), exit 0, on the third full run; see below |

No known load flake fired in vitest. Skips are environment-gated (live ssh, no rsync 3, no Ghostty). Playwright
took three full runs, with the machine's load average between 5 and 10 and another worktree's e2e run holding port
5173 in between:
- run 1: 151 passed, 2 failed: `e2e/drag.spec.ts:82` (island resize landed at w 10, not 9) and
  `e2e/resources.spec.ts:243` (the shelf opened on another root);
- run 2: 152 passed, 1 failed: `e2e/resources.spec.ts:243` again;
- run 3: 153 passed.

Neither test is in the known-flake list, and the branch changes neither the map geometry nor the resources shelf.
Alone, `drag.spec.ts:82` failed once, then passed 3 of 3, and the whole drag spec passed 42 of 42 at
`--repeat-each=3`; `resources.spec.ts:243` passed alone and 3 of 3 in the resources spec at `--repeat-each=3` (81
passed). Main 86fcac4d, extracted with `git archive`, passed `drag.spec.ts:82` alone (1, then 3 of 3) and its full
suite (136 passed, exit 0). The resources failure is a race in main's code and test: the side card's Resources
button falls back to `sources[0]` while the page's resource listing (reloaded when the fleet's listing key moves) has
not yet taken the new character's root, and the test clicks it right after creating the character; the e2e runs
share one daemon, and the branch's extra handover and host specs run before it and grow the fleet the listing scans,
which plausibly widens the window (not proven).

`archi setup --check`, with and without `--release`, and `archi agent`, were run once against a temporary HOME:
both checks printed main's grouped Tools/Agents/Setup output and exited 0; `archi agent` said Claude Code.

## Unsure / worth a look

- `archi agent <name>` talks to the local daemon only (main's design). With the fleet on another machine, a local
  replica refuses it as `not_owner`; with no local daemon it writes the local fleet.json, which the next handover
  back overwrites. Routing it through `connectFor` like the other fleet commands would reach the owner.
- A fleet whose `mainAgent` names a CLI the destination lacks starts mission control's crew with that CLI there
  (`crewCommand` does not check `agentsFound`, as on main). Preflight blocks only on CLIs a carried session needs;
  it could warn about the main agent too.
- Doctor asks Codex about hook trust with `codex` from this process's PATH, not `agentPath`; on a Linux companion
  over ssh it may answer "couldn't ask". F11 could pass the unit's codex.
- The Linux `agents` check warns instead of failing, so `archi setup` on a box with neither CLI goes through; host
  add then reports the missing CLIs as its own warnings.
- `scribeModel(config.scribe, …)` is read once when the Fleet is built (main's shape); a scribe model a handover
  brings in applies from the destination daemon's next start. The agent itself follows `scribeAgent` per pass.
- `origin/main` is now 3217f2c0 (#24); a later rebase picks it up without a conflict.
- `e2e/resources.spec.ts:243` and `e2e/drag.spec.ts:82` flaked under load (above); the resources one could be made
  to wait for the page's listing before it clicks, or the button could wait for it.
