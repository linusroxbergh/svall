# Task 40b: on-machine smoke of the rebased build

Status: **BLOCKED** at step 4. The rebased build cannot run a fleet on Ubuntu 24.04: main's tmux window listing
separates its fields with control characters, and Ubuntu's tmux 3.4 prints those as the text `\037` (D1, Critical).
On linus-vault the daemon therefore parses no window at all. A Linux daemon that owns a fleet adopts its own `_keep`
window as a nameless "recovered" character, and it would mark every carried character dormant on its first poll.
Steps 6 and 7, the round trip, were not started. Everything that could be proven without a Linux daemon owning the
fleet was run:

- the build;
- archi-m3's removal;
- archi-m3b with the same home path;
- `host add`, `host enable` and `host doctor`;
- the full Mac fixture, with the idle close, a custom agent profile and a real Codex turn;
- the preflight over the real ssh and gateway path, stopped on purpose before Begin;
- the replica's fence.

The run also found that the release ships none of the six bundled agent profiles (D2, Important).

HEAD `0b72b15a`. W = `docs/fleet-handover/ledger`. `$S` =
`/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/3739c9b8-51d0-4aa6-ac32-19bc0b56eee0/scratchpad/t40`.
Every script and log named below is there, and the environment is described in `W/m3b-env.md`. `caffeinate -i` ran for
the whole pass. No command carried a token, and both daemons' 48-character tokens appear in no log, snapshot or
controller file (`logs/09-token-grep.log`).

| Step | Result |
| --- | --- |
| 1 before-state | PASS |
| 2 remove archi-m3 and the Mac leftovers | PASS |
| 3 build, install, setup | PASS (found D2) |
| 4 archi-m3b, host add / enable / doctor | FAIL, then PASS after the action enable named (found D1) |
| 5 fixture and snapshot | PASS; the agent profile needed a hand-made file (D2) |
| 6 Mac → Linux | NOT RUN (BLOCKED by D1) |
| 7 Linux → Mac | NOT RUN (BLOCKED by D1) |
| 8 environment left, `W/m3b-env.md` | DONE |

## Step 1: before-state: PASS

- linus-vault (`baseline.sh`, `linus-state.sh` as linus; `baseline/linus-before.txt`, `linus-state-before.txt`):
  - `tailscale serve status`: `https://linus-vault.prawn-turtle.ts.net (tailnet only)` / `|-- / proxy
    http://127.0.0.1:8787`, where 8787 is linus's `bun` (pid 1627).
  - `ss -ltnp`: 47800 was held by archi-m3's archid; 47801 and 47871 were free.
  - linus's `systemctl --user list-units` and unit files are recorded; the crontab md5 is `2ad198fb…`.
  - Users: linus, ofm and archi-m3 (uid 1002); linger for archi-m3 and linus; tmux 3.4, rsync 3.2.7, git 2.43.0.
- Mac (`baseline/mac-before.txt`):
  - `~/.ssh/known_hosts` md5 `1f403c1326762e931fcf90aa00a04d27`, mtime 2026-09-14;
  - `~/Library/LaunchAgents` mtime 2026-09-26 11:49:14 +0200;
  - `/Applications/Archipelago.app` mtime 2026-09-26 11:42:14 +0200 (the owner's own install);
  - `ssh -G 100.117.42.24` offers `~/.ssh/id_rsa` first, and the server accepts it.

## Step 2: remove archi-m3 and the Mac leftovers: PASS

- As archi-m3 (`m3-teardown-user.sh`): both archipelago units stopped and disabled, and `tmux kill-server` on its fleet
  socket. One orphaned `claude --resume 120ef204-…` from M3 Part C was still running; terminate-user ended it.
- As linus (`m3-teardown-root.sh`):
  - `loginctl disable-linger archi-m3` and `terminate-user`: 0 processes after 1 s;
  - `deluser --remove-home archi-m3`: exit 0;
  - deluser left `/home/archi-m3/.archipelago/tmux.sock` (as in M2 and A2), so `sudo rm -r /home/archi-m3`.
- `m3-check-gone.sh` then found 9 more uid-1002 entries: `/tmp/claude-1002/…`, empty scratchpad folders that the real
  Claude of M3 Part C had made. I removed them with `sudo rm -r /tmp/claude-1002`, since a new uid 1002 would
  otherwise inherit them.
- After that: no user or group, `users` back to `linus,ofm`, no `/home/archi-m3`, no `/run/user/1002`, only linus in
  the linger directory, 0 uid-1002 processes, 0 uid-1002 files in `/tmp /var/tmp /run /var/spool /var/mail
  /var/lib/systemd /home /dev/shm`, no crontab, and 47800 free.
- Mac: `/private/tmp/claude-502/m3w2` and the link `/private/tmp/claude-502/m3b` were already gone, like `m3h2`.
  Nothing else under `/private/tmp/claude-502` was touched.

## Step 3: build, install, setup: PASS

**Build** (`build.sh`, `logs/03-build.log`). It runs desktop:install's build steps without installing anything:

- `scripts/ghostty-kit.sh fetch` (kit `332b2aef…-r1`);
- `pnpm install --frozen-lockfile`;
- the web and phone builds;
- `apps/desktop/mac/build.sh release`, with node v24.18.0 and pnpm 12.6.0.

Results:

- The release bundles Node v24.21.0, protocol 15, stateSchema 8.
- The companion is `archipelago-companion-ghostty-kit-24-g0b72b15a-dirty-linux-x64.tar.gz` (46,162,771 B, sha256
  `7aba8970…b056b2`).
- The worktree's tracked files are unchanged, and the gitignored GhosttyKit link was put back to its old target.

**The release is named `ghostty-kit-24-g0b72b15a-dirty`.** `git describe --tags` now finds the `ghostty-kit` release
tag, and the coordinator's uncommitted `progress.md` makes it dirty. The name matches on both machines, so nothing
broke (Note 1).

**Install and setup** (`03a-install.sh`, `03b-agents.sh`, `03c-setup.sh`, `logs/03*`):

- The app went into `$TH/Applications`. `archi version --json` gives the release above, protocol 15, stateSchema 8 and
  node v24.21.0, and there is no node on the Finder PATH.
- `archi -p private setup --no-launchctl --allow-unsigned --release <app>/Contents/Resources/release` wrote:
  - the release, `current` and the hook scripts;
  - fleet.json (`handover.enabled: false`) and node.json;
  - tmux.conf;
  - the plist under `$TH/Library/LaunchAgents`, never loaded;
  - Claude and Codex hooks, the shims, and the home CLAUDE.md, rules and skills.
- `archi setup --no-launchctl --check` from the installed helper answers `this is an installed release, not a
  checkout` (exit 1). This is noted, not a finding.
- Harness only: node.json's port was moved to 47871, and the daemon was started as its plist would start it
  (`mac-daemon-start.sh`: `env -i`, the plist's own PATH, cwd `$TH`). It listened on 47871.

**First daemon log line of note** (the same line appears on m3b):
`error agent profiles: Error: ENOENT: no such file or directory, lstat
'/Users/Shared/archi-m3b/.local/share/archipelago/releases/ghostty-kit-24-g0b72b15a-dirty/agent-profiles'`. This is
D2: the fleet is seeded with no agent profiles.

## Step 4: archi-m3b, host add, host enable, host doctor: FAIL, then PASS after the action enable named

**Create** (`04a-create-user.sh` as linus; `logs/04a-create-user.log`):

- `sudo mkdir -p /Users/Shared` (root 0755);
- `adduser --disabled-password --home /Users/Shared/archi-m3b archi-m3b`: uid/gid 1002, shell bash, home 0750 with
  skel;
- `~/.ssh/authorized_keys` = `~/.ssh/id_rsa.pub`, md5 `41dbdcf5…` on both sides;
- `loginctl enable-linger`: `Linger=yes`;
- as archi-m3b over ssh, HOME is `/Users/Shared/archi-m3b`.

**PATH** (`04b-stub-node.sh`, `04c-path-check.sh`): PASS. The machine has `/usr/bin/node` and `/usr/local/bin/node`,
so the account's shells get A2's failing stubs first. In both login and non-login shells, `node -v` exits 127 and
pnpm, npm and tsx are stubs. archi, claude and codex are not found, and the home holds only skel files.

**Agents** (`04d-remote-creds.sh` as linus, `04e-remote-agents.sh` as archi-m3b):

- linus's `~/.codex/auth.json` and `~/.claude/.credentials.json` were copied, chowned and set to 0600. The md5s are
  equal, and the contents were never printed.
- linus's Codex `0.156.1-x86_64-unknown-linux-musl` was copied to `~/agents/codex`, because `/home/linus` is 0750.
- linus's three files have the same mode, owner and mtime before and after.
- `~/.local/bin/codex` is the copy, and `~/.local/bin/claude` runs the mock with the release's node.

**`archi host add m3b --ssh archi-m3b@100.117.42.24 --release <archive> --allow-unsigned --json </dev/null`**
(no tty; `logs/04f-host-add.ndjson`): exit 1 after 9 s with `result: actions`.

- These steps passed: name, ssh, master, os, `home "/Users/Shared/archi-m3b for archi-m3b"`, tools, rsync, space,
  linger, release, upload, install, service (both units active and enabled), identity (`51cf5316-…`), probe
  (`m3b answers on its own private fleet`), and registry.
- Warnings:
  - tmux 3.4 (Shift+Enter);
  - `claude is not installed on this machine` and the same for codex, although both are in `~/.local/bin` where their
    installers put them. This is the known deferred sibling of O10: add's probes use the non-login shell (D4).
- The registry holds `pathRoots.home = /Users/Shared/archi-m3b` for both machines, so no other root was needed.

**`archi host enable m3b --fleet private --json`: FAIL** (`logs/04g-enable-doctor.log`):
```
{"step":"authority","status":"ok","detail":"m3b holds fleet d85abac7-… for 05b3af33-… at generation 0"}
{"step":"fleet","status":"fail","detail":"m3b cannot take a copy of this fleet: /Users/Shared/archi-m3b/.archipelago holds
 fleet b2b13f88-…, and it holds 1 character, so it is not this fleet's to replace","action":"ssh archi-m3b@100.117.42.24
 and move that fleet home aside, then run archi host enable m3b --fleet private again"}
```
- The fresh fleet that `host add` had just made held one character: `c_vmqbdj` on a `recovered` island, with no
  name, no cwd and no agent.
- m3b's archid.log from its first start:
  ```
  error rename @0\037e93398141f7087f2%0\037e93398141f7087f21894665\037e93398141f7087f2_keep\037…sleep\037…\036e93398141f7087f2
   -> c_vmqbdj: Error: Command failed: /usr/bin/tmux -S …/tmux.sock -f …/tmux.conf rename-window -t @0\037e933…
  can't find window: @0\037e933…
  ```
  This is D1. The daemon's own `_keep` window came back from `list-panes` as a single unsplit row. Reconcile adopted
  it as a stray, and `provision.ts:55-56` then counts that stray as a character in use.
- Reproduced by hand (`04h-linux-tmux-probe.sh`, read only on the fleet's tmux server, the same argv as `listWindows`).
  In `od -c` of the output the separator is four characters, `\ 0 3 7`. The Mac's tmux 3.7c prints the byte 037 for
  the same format.
- On that fleet, the daemon's own API call `char.create {islandId, cwd: ~/t40-probe, name: probe}` answers
  `{"code":"internal","message":"Cannot read properties of undefined (reading 'toLowerCase')"}` (`fleet.ts:521`
  reads `c.name` of the nameless stray, D3). No character can be made on that fleet.

**The action enable named, then `host enable` again: PASS** (`04i-move-aside.sh`, `logs/04j-enable-again.log`):

- As archi-m3b: stop `archipelago-archid@private.service`, `tmux kill-server` on the fleet socket,
  `mv ~/.archipelago ~/.archipelago.t40-aside`, `rmdir ~/t40-probe`.
- Enable then reported `fleet ok "m3b holds this fleet in /Users/Shared/archi-m3b/.archipelago, made for it, under
  archipelago-archid@private.service; … names m3b as the gateway"`, `result ready`.
- m3b's log shows `owner.json is missing and a gateway holds this fleet …` → `starting read-only` → `took the
  gateway's record: 05b3af33-… owns this fleet at generation 0`.
- As a replica it runs no tmux server, so D1 has nothing to misparse there.
- The old home, with the stray, is kept as evidence (`evidence/m3b-aside-state.json`, `m3b-aside-archid.log`).

**`archi host doctor m3b --json`: PASS** (exit 0; `logs/04g-host-doctor.json`):

- ok: node v24.21.0, claude `2.1.260 (Claude Code)` (the mock), config (fleet.json and node.json), archid on 47800,
  hook receiver, systemd, gateway, linger, hooks, codex (`codex-cli 0.156.1; hooks installed`), release (`… protocol
  15; this controller runs …`) and space.
- warn: tmux 3.4, `~/.local/bin` not on PATH, and gh not logged in.
- **`host list --json`:** m3b `"gateway": "yes"`.

**The replica's fence** (`05h-replica-fence.sh`, `logs/05h-replica-fence.log`): PASS. On m3b, `dormancy.set`
(main's new method), `scribe.set` and `island.create` are refused `not_owner "this machine cannot change a fleet
another machine owns"`, and `char.revive` is refused `not_owner "… cannot open a terminal in a fleet another machine
owns"`.

## Step 5: fixture on the Mac: PASS

**Git** (`05d-git-fixture.sh`, `logs/05d-git-fixture.log`):

- alpha is `src/alpha`, with a nested worktree `.wt/feat` (in `info/exclude`), a committed link `link-to-f1` at 0755,
  and a repo `.env`.
- beta is `src/beta`, with sibling worktrees `src/beta-wt1` and `src/beta-wt2`, and a default-excluded
  `node_modules/`.
- Each graph has uncommitted edits, a partly staged index (`MM`), an untracked file and a stash.

**Characters** (`05a-early.sh`, `05e-fleet-fixture.sh`): scribe off; islands `m3b repos` (with a file context ref)
and `m3b dirs`. Six mocked characters, each with one finished turn and a `char.seen`:

- notes, in a plain folder;
- alpha-main, with a second terminal;
- alpha-feat (the nested worktree);
- beta-main;
- beta-wt1 and beta-wt2 (the siblings).

The ids are in `W/m3b-env.md`. `ps` shows six `…/node /Users/Shared/archi-m3b/.m3b-mock/claude` processes. Nothing
ran `/usr/local/bin/claude`.

**Mock changes** (harness, needed to exercise main's idle close; `W/m3b-env.md` "Mocked agent"):

- The mock now sends its pid with each hook, as `agent-hook.mjs` does. Idle close finds the agent by `agent.pid`
  (`fleet.ts:434`), and A2's mock sent none. notes' first agent, started before this change, was closed and started
  again (`05b`, `05c`).
- The mock is named `claude`, not `claude.mjs`, because `startFlags` only accepts `node …/claude`
  (`dormancy.ts:46-47`).

**Idle close (main #15/#16): PASS on the Mac.**

- Setup: `dormancy.set {"hours":1}` (whole hours are the least it takes); notes' last turn and look were at
  12:34:48Z. The background `watch-notes.sh` read its state every 20 s.
- `archid.log`: `13:35:11.698Z info notes dormant after 1 h idle`.
- State afterwards (`logs/05i-after-idle.log`):
  - no window;
  - `agent` kept (claude, session `a238f2dd-…`, transcript
    `$TH/.claude/projects/-Users-Shared-archi-m3b-notes/a238f2dd-….jsonl`, 2 records);
  - `revive: claude --resume a238f2dd-…`;
  - the mock process (pid 58292) gone.
- The watcher then set `dormancy.set {"hours":0}`, so no other character closes. The other five mocks and Codex stay
  live.
- The kept agent still records the dead pid 58292, main's `Agent.pid` that Task 42 strips at export.
- Its arrival on Linux was not run (step 6).

**Agent profile (main #14): PARTIAL.**

- `archi char new … --agent-profile reviewer` (the CLI help's own example) → `archi: no agent profile reviewer;
  there are: m3b-role`, exit 1. The six bundled profiles never reached the fleet (D2).
- A custom profile was made the product's way: `docs.create {id: "r:$FH/agent-profiles", path: "m3b-role.md"}`, the
  root `resources.get` names for new profiles.
- alpha-feat was then created with `--agent-profile m3b-role`. `archi char show` opens with `Agent profile: m3b-role
  — follow this role. / M3B-ROLE: you are the Task 40b test reviewer; …`.
- What happens to it on Linux was not run (step 6). The preflight below gave no warning that `m3b-role` is missing on
  m3b, which holds no `agent-profiles/` at all. That gap is already routed to Task 42 (D5).

**Real Codex** (`05f-codex-char.sh`, `logs/05f-codex-char.log`):

- `$TH/real/codex-x` was trusted first in a setup tmux of its own (`st.sh`): `Trust this folder?` → Trust and
  continue, then `Hooks need review: 8 hooks are new or changed` → Trust all and continue.
- `archi char new --island i_6crr3l --cwd $TH/real/codex-x --name real-codex --agent codex` → `c_ts2fmw`.
- `archi char run c_ts2fmw "Reply with exactly the word MANGO and nothing else."` → `• MANGO`.
- State: `agent.kind codex`, `sessionId 01a0ddbd-67eb-7b41-8ec8-a30797ef4a8f`, rollout
  `$TH/.codex/sessions/2026/09/26/rollout-2026-09-26T14-42-52-01a0ddbd-….jsonl`, pid 91960, model gpt-6-astra.
- For the round trip, m3b trusts the same path and the 8 hooks. They were answered the same way in archi-m3b's own
  setup tmux (`rst.sh`) in a folder made for it and then removed.
- Before that, the node stub was renamed `node.t40-disabled`, since Codex's hook runs `node` from PATH.

**Snapshot.** `snap.sh mac s0-fixture` (8 dirs, 5 checkouts, 7 sessions, 7 characters) and `s1-before-mac` after the
idle close, the last good state. A self-compare gives 0 DIFF. `s0-fixture → s1-before` shows exactly the idle close:
`dormantAfterHours 1 -> 0`, notes' revive, and notes with no window.

**Preflight over the real path, stopped before Begin on purpose** (`ho.sh 06a-preflight-probe m3b`, then again as
`06b-preflight-trusted`):

- One root was occupied on m3b (`~/notes/occupied-by-t40.txt`) so that preflight would block and nothing would begin.
- In 2 s the helper went connection-info → gateway → both daemons, and answered:
  - summary: 7 roots, 197 files, 132,184 B, 7 sessions;
  - blockers: only `destination_occupied /Users/Shared/archi-m3b/notes already exists …`;
  - warnings: `env_file` for alpha, and `codex_trust` for real-codex. In 06b, once m3b trusted the folder, the
    `codex_trust` warning was gone (C-D2's fix holds).
- After each run: `archi handover status` is `no handover of this fleet is open anywhere`, the Mac owns at generation
  0, and no master is left. The occupying folder was removed.

## Step 6: Mac → Linux: NOT RUN (BLOCKED by D1)

After Commit, m3b would own the fleet and start its tmux server. From then on every `listWindows` on m3b returns rows
that do not split, which breaks the following:

- Activation looks up each slot's window by id (`destination.ts:590`, `holding()`). It finds none, so every character
  reads as `gone`.
- The poll finds no window under any character's id. It marks each carried character dormant (`fleet.ts:372-374`), so
  the agents keep running in windows the daemon no longer knows.
- `reconcileNow` adopts every window, `_keep` included, as a nameless stray (`reconcile.ts:96-150`). From then on
  `char.create` fails (`fleet.ts:521`).
- Going back, a Linux source's freeze classifies terminals from the same listing (`source.ts:189-190`, `rest.ts:222`),
  so the return could not rest its terminals either.

Running it would have left the fleet stranded on m3b with a corrupted state, against step 8's "Mac owns the fleet, no
transaction open". Not run:

- the compare;
- the fences;
- `codex resume` under the carried id;
- the idle-closed character's arrival and wake;
- the agent profile on Linux.

## Step 7: Linux → Mac: NOT RUN (BLOCKED by D1)

## Step 8: environment left running, `W/m3b-env.md`: DONE

- The Mac owns the fleet at generation 0, and no transaction is open anywhere.
- The Mac daemon runs the fixture: 8 windows (`_keep`, 5 mocked characters, alpha-main's second terminal, real-codex),
  5 mocks, 1 Codex, and notes dormant.
- m3b runs its replica archid and its gateway.
- `W/m3b-env.md` has:
  - paths, wrappers, ids, fixture, credentials and harness;
  - what runs where;
  - the before-state;
  - the teardown recipe (scripts written, not run).
- **Checks at the end** (`logs/08-final-checks.log`):
  - linus-vault's stable state against the before-state differs only in archi-m3 → archi-m3b, in the linger
    directory and passwd.
  - The serve mapping is unchanged (`/ proxy http://127.0.0.1:8787`). 47800 is archi-m3b's archid, where archi-m3's
    was before.
  - The Mac's `~/.ssh/known_hosts` md5 and mtime are unchanged, and so is `~/Library/LaunchAgents`.
  - **`/Applications/Archipelago.app` changed at 15:15:32 +0200. It was not this pass:** it is build `54133b7b`
    (main's merge of PR #21) with no `Contents/Resources/release`, while this pass installed only into `$TH/Applications`.
  - No master, helper or setup tmux is left on either machine; `handover status` shows none open; `caffeinate` is
    stopped.

## Defects

1. **D1, Critical: on Ubuntu 24.04 (tmux 3.4) the daemon parses no tmux window, so no fleet can run on the Linux
   gateway.**
   - Cause: `listWindows` (`packages/archid/src/tmux/tmux.ts:199-215`) builds its `-F` format with `\x1f<token>`
     between fields and `\x1e<token>` after each row. tmux 3.4 prints those bytes as the four-character text `\037` and
     `\036`. `split(sep)` and `split(end)` then never match, and each row becomes one `windowId` with every other field
     undefined.
   - Evidence:
     - `logs/04h-linux-tmux-probe.log`: `od -c` of the exact listing shows `@ 0 \ 0 3 7 0 1 2 …`. The Mac's tmux
       3.7c prints the byte `037`.
     - m3b's first-start log shows the rename failure above.
     - `evidence/m3b-aside-state.json` holds the stray `c_vmqbdj` with no name or cwd.
   - Effects seen: a fresh fleet on m3b adopts its own `_keep` window as a nameless character, and `host enable`
     refuses that fleet (`linux/provision.ts:55-56`).
   - Effects read from the code: every Linux-owned fleet marks all characters dormant on each poll
     (`fleet.ts:372-374`), activation finds no window (`handover/destination.ts:590`), and a Linux source cannot rest
     (`handover/source.ts:189`, `rest.ts:222`).
   - Origin: main's code. It is in the fresh history's root `45856c9b` and came onto the branch with the 2026-09-25
     squash. The pre-squash branch used `\t` (`2415ab4c`), and nothing ran on Linux since the squash.
   - Fix direction: a printable separator (for example tab plus the token), or undo tmux's `\ooo` escapes before
     splitting; plus a listing test against tmux 3.4 (the `ubuntu:24.04` container Task 42 plans).
2. **D2, Important: the release carries none of the bundled agent profiles, so no fleet on a release install, Mac or
   Linux, gets them.**
   - Cause: `agent-profiles.ts:13` resolves `../agent-profiles` from `lib/archid.mjs`, and `scripts/release-stage.mjs:184-186`
     copies `packages/archid/hooks`, `home` and `systemd` into the release, but not `packages/archid/agent-profiles`.
   - Evidence:
     - both daemons log `error agent profiles: Error: ENOENT … releases/<rel>/agent-profiles` at start, and
       `$FH/agent-profiles` is never made;
     - `archi char new … --agent-profile reviewer` → `no agent profile reviewer; there are: m3b-role` (after a
       hand-made profile; before it, "none").
   - Main runs archid from the checkout, and this branch runs every install from the release (desktop:install
     included), so main's #14 presets are lost on the branch. Task 40a's integration check covered state and the fleet
     home, not the release staging.
3. **D3, Minor (amplifies D1): a listing row that does not parse is adopted and persisted as a character with no name
   and no cwd, and one such character breaks `char.create` for the whole fleet.**
   - Where: `reconcile.ts:100` and `:150` (`name: w.name`, undefined), then `fleet.ts:521` `c.name.toLowerCase()`.
   - Evidence: `char.create` → `internal: Cannot read properties of undefined (reading 'toLowerCase')`. The persisted
     `state.json` holds a character with neither field, although the schema requires both.
4. **D4, Minor (known, deferred since A2): `host add`'s claude and codex probes use the non-login shell.** Add says
   "not installed" and ends `actions`, while `host doctor` finds both in `~/.local/bin` (claude 2.1.260, codex
   0.156.1).
5. **D5, Minor (known, Task 42): a character's agent profile does not travel, and preflight does not say so.** The
   preflight for alpha-feat (`m3b-role`) gave no warning, although m3b has no `agent-profiles/`.

Notes, not defects:

1. The release and companion are named `ghostty-kit-24-g0b72b15a-dirty`. `git describe --tags` now meets the
   GhosttyKit release tag `ghostty-kit`, so every build names itself after that tag, main's included.
2. The plist's PATH starts with the node of the helper that ran setup (`$TH/Applications/Archipelago.app/…/node/bin`),
   not `current/node/bin`. That is main's `daemonPath` fed `process.execPath`, which puts a node on the panes' PATH
   for Codex's hook, but not the release's own.
3. Closing a character's window by hand (not idle close) drops its agent through the mock's SessionEnd, and the revive
   is then a plain shell. This matches main's rule that only idle close keeps the agent.
4. The M3 home's leftover `/tmp/claude-1002` shows that a real Claude run leaves files outside the home that
   `deluser --remove-home` does not remove. The teardown recipe now covers it.

Status: BLOCKED — D1 (Critical): Ubuntu's tmux 3.4 prints main's control-character listing separators as `\037`, so
the rebased daemon parses no window on Linux (`tmux.ts:199-215`). Steps 6–7 were not run; the environment is left up
with the Mac owning the fleet at generation 0.
