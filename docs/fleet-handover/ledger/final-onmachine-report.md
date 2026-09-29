# Final on-machine check: report

Status: **DONE_WITH_CONCERNS**.

Release `d0602dc`, built from a `git archive` snapshot of `d0602dcc`, was installed on the Mac test HOME and upgraded
onto m3b. m3b was then rolled back to `896fc01` with `archi host upgrade m3b --rollback`, the first real run of that
command, and upgraded again. The fleet went Mac → Linux (generation 37, 17.2 s) and Linux → Mac (generation 38, 20.5 s)
with the release's helper, 13/13 live characters `ok` each way. The original snapshot compares clean against the
environment as left. Real Claude (OSPREY) and real Codex each answered on Linux and back on the Mac under their own
session ids.

- **One new defect, Minor (R1).** A successful `--rollback` ends "ready for handover" while the machine runs a
  release other than this Mac's.
- **D1 is fixed on the machines.** No live terminal kept a carried `revive` past the next poll, without a restart.

`$F` = `/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/89928d60-3853-43e3-b6cb-3e149e9baba0/scratchpad/fin`
(scripts in `$F/` and `$F/bin/`, logs in `$F/logs/`, snapshots in `$F/snaps/`); `$G` and `$C` as in `W/m3b-env.md`
(W = `docs/fleet-handover/ledger`).

Rules:
- The product was not changed.
- Work on linus-vault ran only as archi-m3b.
- The Mac side ran only under the test HOME, through the wrappers.
- The credential was never printed.
- No daemon token is in any log (`70-token-grep.log`: 0 hits for both tokens), and `release-scan.mjs
  --secrets-only` passes over `$F/logs` (46 files) and `$F/snaps` (8).

| Step | Result |
| --- | --- |
| Build and scan | PASS: `d0602dc`, three archives `ok` |
| Mac install | PASS: `current` → `d0602dc`, the daemon restarted on it |
| `host upgrade m3b` | PASS: `ready` in 12 s, both units on `d0602dc` |
| `host upgrade m3b --rollback` | PASS: `ready` in 2 s, both units and the fleet's daemon on `896fc01`; R1 |
| `host upgrade m3b` again | PASS: `ready` in 12 s, both units on `d0602dc` |
| Mac → Linux | PASS: complete g37, 17.2 s, 13/13 `ok` |
| Linux → Mac | PASS: complete g38, 20.5 s, 13/13 `ok` |
| Compare (state, repos, docs, sessions, ownership) | PASS: only the known archived folder, and two Codex `revive`s read before the next poll |
| Real turns | PASS: `OSPREY FIN-LINUX`, `OSPREY FIN-MAC2`; Codex `…FIN-LINUX`, `…FIN-MAC`; one session id each |
| Environment left | Mac owns at g38, nothing open, no credential copy; `W/m3b-env.md` committed |

## 1. Build

`$F/build.sh`, `logs/01-build.log`, 06:58:06–06:59:08Z on 2026-09-29.

- **The snapshot.** It was made with `git -C <worktree> archive d0602dcc`. After `git init`, a fetch of `d0602dcc` from
  the main repository and `git reset --mixed`, `git status` was empty before and after the build, and `git describe`
  read `d0602dc`.
- **Vendor caches.** The worktree's `vendor/ghostty-kit` (`332b2aef…-r1`, current), `vendor/node` and `vendor/rsync`
  were copied in. The rsync tarball is in the worktree's cache now.
- **The release command.** `scripts/release-build.sh --version d0602dc --url-base
  https://github.com/linusroxbergh/archipelago/releases/download/d0602dc`, with `ARCHI_RELEASE_KEY` unset, so the
  release is unsigned. It carries protocol 17, stateSchema 8, transferSchema 1, authoritySchema 1 and Node v24.21.0.

| Archive | Bytes | sha256 | Scan |
| --- | --- | --- | --- |
| `archipelago-companion-d0602dc-linux-x64.tar.gz` | 46,233,877 | `977873776c6cc13a…` | ok, 277 files |
| `archipelago-companion-d0602dc-linux-arm64.tar.gz` | 45,913,220 | `5e7705b8f820f5cf…` | ok, 277 files |
| `archipelago-controller-d0602dc-darwin-arm64.tar.gz` | 42,480,246 | `2393486a69a37580…` | ok, 281 files |

- **The scan** ran inside `release-build.sh` and once more by hand: exit 0, no hit.
- **The app** was built as 39b did, and its `Contents/Resources/release` was replaced by the controller archive's
  tree. `diff -r` is empty, `codesign -v` valid, build `d0602dc`.

## 2. Installs, upgrades and the rollback

**Mac install** (`$F/11-install.sh`, `logs/11-install.log`, 06:59:47Z).
- The release's own helper ran `archi -p private setup --no-launchctl --allow-unsigned --release <app release>`: exit
  0, and `current` → `releases/d0602dc`.
- It kept `896fc01` and removed the older five, as setup.md says: `32ee1745`, `4697836`, `890b1df`, `9be818f5` and
  `ghostty-kit-24-g0b72b15a-dirty`.
- `node.json`, the Codex hooks, the Claude settings and the plist are unchanged. The hooks run `current/node`, so the
  pruning left them working.
- The daemon restarted on `d0602dc` (pid 15094): `system.info` reads `d0602dc`, protocol 17, and nothing is open.

Each m3b run below logs every `archipelago-*` unit's pid and argv, `current`, the kept releases, the installed `archi
version`, the fleet daemon's `system.info` and the gateway's answer (`$F/units-far.sh`).

| Run | Log | Command | Result | archid@private | gateway | Kept |
| --- | --- | --- | --- | --- | --- | --- |
| before | | | | 667595 on `896fc01` | 667604 on `896fc01` | 6 releases |
| u1 | `12-upgrade-u1.log` | `host upgrade m3b --release <x64 companion> --allow-unsigned --json` | `ready`, 12 s: release, upload, install ok, probe "m3b answers on release d0602dc" | 2695387 on `d0602dc` | 2695396 on `d0602dc` | `896fc01 d0602dc` |
| rb1 | `13-rollback-rb1.log` | `host upgrade m3b --rollback --json` | `ready`, 2 s: rollback ok, probe "m3b answers on release 896fc01" | 2699942 on `896fc01` | 2699951 on `896fc01` | the same |
| rb2 | `13-rollback-rb2.log` | `host upgrade m3b --rollback 896fc01` (text) | `ready for handover`, exit 0 | 2706057 on `896fc01` | 2706066 on `896fc01` | the same |
| u2 | `12-upgrade-u2.log` | as u1 | `ready`, 12 s | 2708271 on `d0602dc` | 2708280 on `d0602dc` | the same |

- **u1.** m3b's mission-control home tree, Codex hooks and Claude settings are unchanged. The daemon restarted
  read-only at generation 36. `host doctor m3b` fails nothing: `release` is ok, with warnings for tmux 3.4, path and
  gh.
- **rb1, the first real rollback.**
  - The far `archi setup --rollback` (the `d0602dc` one) reported `current -> …/896fc01; systemctl --user restart
    archipelago-archid@private.service; systemctl --user restart archipelago-gateway.service; the private fleet's
    daemon answers from release 896fc01`.
  - `archi version` and the daemon's `system.info` read `896fc01`. The gateway answers with the record at generation
    36, and the daemon restarted read-only at 36.
  - `host doctor m3b` then fails `release` ("896fc01, protocol 17; this controller runs d0602dc, protocol 17"). R1 is
    about this.
- **rb2, the named form in text mode.**
  - `--rollback 896fc01` printed ✓ machine, ✓ master, ✓ rollback, ✓ probe, then "ready for handover".
  - The rollback step's detail has no per-fleet line: the far `archi` is now `896fc01`'s, whose `setup --rollback`
    predates that check. The controller's own probe still checked the fleet's release.
- **Two refusals.**
  - `--rollback 890b1df`, a release the install had pruned: ✗ rollback "archi setup --rollback 890b1df exited 1:
    archi: no release at …/releases/890b1df to go back to", exit 1, and m3b stayed on `896fc01`.
  - `--rollback --release x`: "--rollback installs nothing, so it takes no --release or --allow-unsigned".
- **u2.** The install replaced the same-named `d0602dc` tree and kept `896fc01`. `host doctor m3b`'s `release` is ok
  again.

## 3. The round trip

The start `a0-mac` equals 39b's last snapshot `f2-after-mac` but for the 13 `revive` fields that 39b's final archid
restart cleared.

### Mac → Linux (`logs/31-m2l.log`, `fin-m2l.*`)

- **Before.** real-claude was revived on the Mac and took a turn (§4), then `b1-before-mac` was taken.
- **Run.** `archi handover m3b --json`, plain ssh with no link proxy (`NOSHIM=1 bin/drive.mjs`), started at 07:08:23Z.
- **Result.** Complete, **generation 37** (transaction `b6265d3d-…`), in **17.2 s**.
- **Preflight.** 16 roots, 246 files, 1,347,354 B and 15 sessions. There were 0 blockers. The warnings were
  `env_file` (alpha), `worktree_unused` (beta-unused) and `claude_trust` for the mocks.
- **Carried.** 13/13 characters with live terminals `ok`, including real-claude and both Codex characters, with alpha-main's
  and shell's second terminals. real-claude-t and real-claude-b were carried dormant. The stream has no `notice` or
  `error`.

After it (`logs/33-after-linux.log`):
- **m3b owns at g37.** It runs 15 windows, 10 mocks and 2 real Codex. Every state pid is a process there with its own
  `--resume` argv: the flags character's `--effort high --dangerously-skip-permissions`, `--add-dir …/notes`, and Codex's
  `-m gpt-6-astra` for real-codex-p.
- **Terminals.** Every live terminal reads `revive=null` (D1 fixed). The shell's two terminals print the restart
  notice under bash in `work/shell`, and the browser tabs are carried.
- **Docs and profile.** The four entity docs are `FOUND` through m3b's own API by key, with the same hashes. beta-main's
  brief lists all four tiers, and alpha-feat's brief opens with `Agent profile: m3b-role`.
- **The Mac is fenced.**
  - All 16 character probes and `docs.create` answer `handover_committed`, as handover.md now says: revive, second,
    attach and run for alpha-main, notes, real-claude-t and real-claude-b.
  - It runs no tmux server: C19's deactivate stopped even `_keep`.
  - It runs no agent, and `route.json` names m3b at 37.

### Linux → Mac (`logs/41-l2m.log`, `fin-l2m.*`)

- **Before.** The Linux turns (§4) came first, then `b2-before-linux` was taken.
- **Run.** `archi handover local --json`, started at 07:10:01Z.
- **Result.** Complete, **generation 38** (transaction `18b2fa8b-…`), in **20.5 s**.
- **Preflight.** 16 roots, 240 files, 1,384,680 B and 15 sessions, with 0 blockers. The warnings were `env_file` and
  `claude_trust`.
- **Carried.** 13/13 `ok`, with no `notice` or `error`.

After it (`logs/52-after-mac.log`):
- **The Mac owns at g38.** It runs 15 windows, 10 mocks and 2 real Codex, and every state pid is a Mac process with
  its `--resume` argv.
- **Docs, profile and O6.** The docs and profile are as above. O6 holds: beta-unused is still registered at
  `unused-br`, clean, with both stash entries.
- **m3b is fenced.** 10 probes answer `handover_committed`. It runs no tmux server and no agent process, and
  `handover/` is empty.
- `handover status`: none open anywhere. No ssh master or helper is left.

### Compares (`$F/cmp.sh`, `logs/cmp-*.txt`)

| Compare | DIFF | What they are |
| --- | --- | --- |
| `b1-before-mac → b1-after-linux` | 2 | the Mac-only `work/failer.archived-2026-09-28T234918Z` and its file (39b's archive, not a root). 3 rewrite (beta-unused's registration, O6), 26 expected |
| `b1-after-linux → b2-before-linux` | 0 | records added by the Linux turns |
| `b2-before-linux → b2-after-mac` | 4 | the same archived folder (2), and real-codex's and real-codex-p's `revive` (below) |
| `b1-before-mac → b2-after-mac` | 2 | the two Codex `revive`s only; 0 rewrite, 5 expected |
| `a0-mac → c9-end-mac` (as found → as left) | 0 | real-claude +33 records, real-codex +30, real-codex-p +2 |
| 39b's `d1-before-mac → c9-end-mac` | 2 | the archived folder |

- **Every Git field is equal** in every compare, for `src/alpha`, `src/alpha/.wt/feat`, `src/beta`, `src/beta-wt1` and
  `src/beta-wt2`: HEAD, `status --porcelain=v2 --branch` with untracked files, `ls-files -s`, stash, `worktree list`,
  refs, config (O8 aside) and `fsck`.
- **So are** every file under the roots, the entity docs, the agent profiles, the islands and characters, and the
  browser tabs.
- **The two Codex `revive`s are poll latency, not D1.**
  - `b2-after-mac` was taken right after the result.
  - The two Codex activation rows came 1.3 s and 0.7 s before it (`fin-l2m.times` +19242 and +19816 against
    +20546). The poll that drops a carried `revive` runs every 3 s (`fleet.ts:163`, `:421`).
  - real-codex read `revive=null` at 07:10:51Z, before any daemon restart (`logs/51-mac-turns.log`).
  - On the way out, every terminal was already clear in the snapshot taken right after the result.

## 4. The agents' turns

Each turn went through the Mac's helper, which routes to the owner. Each turn prints its pane, its session file and
records, its process and its state (`$F/turn.sh`).

| Where | Agent | Answer | Session file | Process |
| --- | --- | --- | --- | --- |
| Mac, before the move (07:07:59Z) | real-claude `cff60418-…` | `OSPREY FIN-MAC` | 100 → 108 records | 85177 `…/real-claude/claude --resume cff60418-…` |
| Linux (07:09:28Z) | real-claude | `OSPREY FIN-LINUX` | 110 → 117 | m3b 2734494, the same argv |
| Linux (07:09:37Z) | real-codex `01a0ddbd-…` | `MANGO-LINUX-MACGATE-LINUXGATE-MACFIN-LINUX` | 118 → 132 | m3b 2734401 `codex resume -c tui.resume_cwd=session 01a0ddbd-…` |
| Mac (07:10:41Z) | real-claude | `OSPREY FIN-MAC2` | 119 → 127 | 89868, the same argv |
| Mac (07:10:48Z) | real-codex | `…GATE-MACFIN-LINUXFIN-MAC` | 133 → 147 | 89766 |

- **real-claude** has one transcript on each side, named after the session, and every record's `sessionId` is
  `cff60418-…`. It holds 129 records now, and its last answer is "OSPREY FIN-MAC2".
- **real-codex** answered in the same rollout file, and no new rollout appeared on either side. m3b keeps 2 rollouts,
  the two characters'; the Mac keeps 3, the same as before. Its state kept `01a0ddbd-…` throughout.
- **The rest.** real-claude was laid dormant with its session by closing its window while archid was down
  (`$F/66-real-claude-rest.sh`). The Mac archid then restarted as pid 91360.

## 5. Credential

- **First read, 07:03:10Z.** `expiresAt` was 07:13:43Z, 10 minutes away, so the Mac copy was deleted at once and
  nothing went to m3b (`logs/60-creds.log`).
- **The wait.** A loop read only `expiresAt`, piped from the keychain, until 07:07:32Z. By then the owner's own Claude
  had refreshed the login, and 479 minutes were left.
- **Copied at 07:07:46Z** straight into both test homes' `~/.claude/.credentials.json`: 0600, 15,645 B, equal
  (`logs/61-creds.log`).
- **Used.** The real-Claude steps ran from 07:07:46 to 07:10:51Z.
- **Deleted.** Both copies were gone at 07:11:16Z and shown absent the same second (`logs/66-rest-creds.log`).
- **Now.** No `.credentials.json*` is on either machine, and no real Claude runs.

## 6. Defects (not fixed)

1. **R1, Minor: a rollback ends "ready for handover" while the machine runs a release other than this Mac's.**
   - After rb1 and rb2, `archi host upgrade m3b --rollback [896fc01]` ended with result `ready` and exit 0. In text
     mode it printed "ready for handover".
   - m3b then ran `896fc01` against this Mac's `d0602dc`, and `host doctor m3b` failed `release`.
   - setup.md says that until both machines run the same release, a handover stops with `incompatible_release`. The
     machine is not ready for a handover. That stop was not reproduced here.
   - Where it comes from:
     - `rollbackHost` (`packages/cli/src/controller/host.ts:550`) has no step that compares the far release with
       `d.controller.release`;
     - `reporter` (`packages/cli/src/commands/host.ts:59-60`) prints "ready for handover" for every `ready`;
     - errors.md "Host commands" says the same line ends every host command, `upgrade --rollback` included.
   - A user rolling back a bad companion is told the machine is ready, then meets `incompatible_release` at the next
     handover.
   - Fix direction: end a rollback with a `warn` naming the release it now runs, and say that a handover needs
     `archi host upgrade <name>`, or a Mac on that release.

Notes, not defects:
- A rollback run while the far machine is already on an older release uses that release's `setup --rollback` (rb2).
  With `896fc01` that means no per-fleet daemon check there. The controller's probe still checks the private fleet's
  release.
- A rollback to a pruned release fails with the missing path. Its action, "read the daemon log there", does not help
  here, and nothing names the releases that are kept.

## 7. Doc check (`docs/remote-machines/`)

Checked and found right:
- **setup.md.** Each install keeps the release before it and removes older ones, on the Mac and on m3b. The `host
  upgrade --rollback` row: it puts back the release before, or the one named, restarts the units, and checks each
  fleet's daemon.
- **errors.md.** The `machine`, `master`, `rollback` and `probe` rows for `upgrade --rollback`, the refusal of
  `--release` with `--rollback`, and the doctor's `release` check.
- **handover.md.** The fenced copy answers `handover_committed` after a handover. So do the restart notice, the dormant
  characters staying dormant, Codex's resume argv, what moves and what stays, and "Retry it from the row" (not
  exercised).

The only mismatch is R1's: errors.md promises "ready for handover" at the end of `upgrade --rollback`, as the code
prints it.

## 8. End state (`logs/90-end-state.log`)

- **Ownership.** The Mac owns at **generation 38**, not frozen. No transaction is open at the gateway, the Mac or
  m3b. `handover status`: none open anywhere.
- **The Mac.**
  - archid 91360 runs `d0602dc`, started by `$G/mac-daemon-start.sh` with the plist's PATH and no shim.
  - Its tmux server is 89638 with control client 91380. It runs 15 windows: `_keep`, 12 live characters and 2 second
    terminals.
  - 10 mocks and 2 real Codex are idle. The three real Claudes are dormant with their sessions.
  - The release kept besides `d0602dc` is `896fc01`.
- **m3b.**
  - The units are archid 2708271 and gateway 2708280 on `d0602dc`, with `896fc01` kept.
  - There is no tmux server (the source stops its fleet at Complete), no agent, and `handover/` is empty.
- **Nothing is open or left.** There is no test app, ssh master, helper, link proxy, watcher or `caffeinate` of this
  run, and no credential copy. There is no `fail-resume` flag, and both Codex logins are in place.
- **Archived replicas left by 39b.** m3b has `$TH/notes.archived-2026-09-28T234456Z`, and the Mac has
  `$TH/work/failer.archived-2026-09-28T234918Z`.
- **The test app** (`logs/80-app-open.log`) opened as build `d0602dc`. It claimed `$TH/.archipelago/app.pid`,
  connected to 47871 with its helper, kept its WebKit data in `$TH/Library/WebKit`, and quit.
- **The owner's files** (stat only). `~/.ssh/known_hosts` (Sep 14, 7,796 B), `~/Library/LaunchAgents` (Sep 26) and
  `/Applications/Archipelago.app` (Sep 28, `4067bfea`) are unchanged.
  - His preferences plist changed today, written by his own app.
  - LaunchServices opened that app at 09:03:10 +0200 as a user-interactive launch; no command of this run opens it.
  - The plist read 09:05:17 (1,567 B) both before and after the test app's open at 09:05:26, then 09:11:47.
- **`W/m3b-env.md`** was updated and committed: release, generation 38, the kept releases, `$F`, the snapshots, "Left
  running", and the by-eye items that D1, F1 and F3's fixes change.

## Concerns

1. **R1's end line is what a user reads after a rollback.** The mismatch surfaces only at the next handover.
2. **Only one round trip ran on the final build.** The fix wave's other changes were not exercised on the machines:
   - F1's `archivedTo` row, F2's fresh login probe, and F3's Retry that lays a terminal dormant again (by-eye items 7
     and 8 now say what to expect);
   - C05's background-command blocker, and C03's third-machine refusal;
   - the link and kill cells.
3. **The rollback ran between two releases with the same schemas** (protocol 17, stateSchema 8, authoritySchema 1).
   A rollback across a state-schema change, which would meet a state newer than the older daemon reads, is not
   exercised and not warned about.
4. **The installs pruned the environment's older releases** on both machines. Only `896fc01` is kept beside
   `d0602dc`; the older builds survive in the scratchpads (`$C`, `$G/c37`).
