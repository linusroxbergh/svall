# M3 on-machine environment (shared by Parts B and C)

Written by Part A2 on 2026-09-24 at HEAD 0248e2ac. Part A's environment (temp HOME `m3h`, `m3w`, `m3a`, the
first archi-m3) was torn down and rebuilt from scratch; nothing below needed a hand step on product state.
Parts B and C append what they change at the end.

`$S` below is the Part A2 scratchpad:
`/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/458d4622-7488-4208-9faa-1ee5a901238b/scratchpad/m3-onmachine-a2`
(Part A's scratchpad `…/scratchpad/m3-onmachine` is kept for its logs only; its scripts point at the removed paths.)

## Where things are

| | |
| --- | --- |
| Build | worktree HEAD `0248e2ac`, release `0248e2ac`, unsigned; `$S/build.sh`, log `$S/logs/build.log` |
| Temp HOME (`TH`) | `/private/tmp/claude-502/m3h2` (short real path: tmux and hook sockets live under it, 104-byte socket cap) |
| `ARCHI_APP_DEST` | `$TH/Applications` (the app is `$TH/Applications/Archipelago.app`) |
| Helper | `$TH/Applications/Archipelago.app/Contents/Resources/release/bin/archi` (bundled node: `…/release/node/bin/node`, `$BNODE` in `env.sh`) |
| Installed release | `archi -p private setup --no-launchctl --allow-unsigned --release <app>/Contents/Resources/release` → `$TH/.local/share/archipelago/current` → `releases/0248e2ac`; plist in `$TH/Library/LaunchAgents`, never loaded |
| TMPDIR | `/private/tmp/claude-502/m3b/` (a symlink to `$S/tmp`); ssh control sockets go to `…/m3b/archi-502/<hash>` |
| Companion archive | `$S/companion/archipelago-companion-0248e2ac-linux-x64.tar.gz` (45,212,768 B, sha256 `465a31ff…6983e23`) |
| Remote | host `m3` = `archi-m3@100.117.42.24`, machine `9af1ccb4-d5b0-4221-9aa6-92b086cfe623`, uid 1002, linger on, release `0248e2ac` under `~/.local/share/archipelago` |
| Mac machine | `linuss-macbook-pro` (the temp HOME's own id) `85df863e-4846-475b-8683-c063ba7ec859` |
| Fleet | `private`, id `d86e3f1a-a148-4f12-aeb0-820e8f9b0323`, gateway `m3` (set by `host enable m3 --fleet private`; `host list` shows `gateway: yes`) |
| Mac fleet home (`FH`) | `$TH/.archipelago`, daemon on `127.0.0.1:47871` (harness: `$S/03c-port.sh` moved node.json off 47800, which the owner's live daemon holds) |
| Linux fleet home | `/home/archi-m3/.archipelago`, daemon `archipelago-archid@private.service` on `127.0.0.1:47800`; gateway `archipelago-gateway.service`, socket `~/.local/share/archipelago/gateway/authority.sock`. `host enable` re-keyed the pristine private fleet `host add` made (was `a0a4e00f-…`) |
| Path roots (Mac registry `$TH/.config/archipelago/machines.json`) | Mac: `home=$TH`, `work=$TH/code` (a symlink to `/private/tmp/claude-502/m3w2`: the root declared through a symlink). m3: `home=/home/archi-m3`, `work=/home/archi-m3/code` (created by `$S/05b-path-roots.sh` with the registry entry; preflight blocks `path_root_missing` without it) |
| Ownership at the end of A2 | the Mac owns it at generation 6, no transaction open anywhere (`archi handover status`: none) |

## Wrappers (all `sh`, all source `$S/env.sh`: unsets ARCHI_HOME/ARCHI_CHAR_ID/TMUX, sets HOME, ARCHI_APP_DEST, TMPDIR, the Finder PATH `/usr/bin:/bin:/usr/sbin:/sbin`)

- `$S/a.sh <archi args>`: the bundled helper, stdin `/dev/null`.
- `$S/ho.sh <label> <handover args>`: `archi handover … --json` in the foreground; `logs/<label>.ndjson|.stderr`.
- `$S/hod.sh <label> <handover args>`: the app's launcher (`--json --detach`); its own attach ends at once (stdin EOF). Follow the run with `$S/attach.sh <label>` (attach `--json`, stdin held open through a FIFO until the result). To cancel from outside, write `{"cancel":true}` as a line into attach's stdin (the FIFO `$S/run/attach-in-<pid>`).
- `$S/08e-linux-to-mac.sh <label> [args]`: `handover local --json` under `bin/watch-forward.mjs` (records the master's `-O forward` listener and the helper's WS through it into `logs/<label>-forward.log`; stream in `logs/<label>.ndjson`).
- `$S/api.sh <method> [json]`: one RPC to the Mac daemon. `$S/rapi.sh <method> [json]`: the same on m3 via `~/m3-tools/api.mjs`. Tokens never printed.
- `$S/mac-daemon-start.sh`: starts the Mac daemon as its plist would (`env -i` with ARCHI_HOME, PATH, HOME, LANG, USER, SHELL, TMPDIR, SSH_AUTH_SOCK); pid in `$S/run/archid.pid`; log `$FH/archid.log`. Stop: `kill $(cat $S/run/archid.pid)`; "asleep": SIGSTOP/SIGCONT that pid.
- `$S/06i-mac-fenced.sh`, and `ssh archi-m3@100.117.42.24 'sh -s -- <charId>' < $S/linux-fenced.sh`: ownership, tmux windows, agent count, and revive/second/attach/run attempts on the side that should be fenced.
- `ssh archi-m3@100.117.42.24 'sh -s' < $S/far-fleet.sh`: m3's fleet.json id/gateway, owner.json, unit state, log tail. `… < $S/replicas.sh`: every replica record (path, state, tx, baseline size, kept).
- `$S/07h-abort-transfer.sh`: an abort during Transfer (a writer churns `$TH/notes/churn.txt` → `external_writer` after 3 passes → aborted) while m3's `~/.archipelago/handover` is listed every 0.3 s. **Leaves `churn.txt` on m3's `~/notes` newer than any manifest; the next handover to m3 then blocks `destination_diverged` on notes until `--archive <notes root id>`** (A2 defect 1).
- `$S/poll.sh <label>` (background; `touch $S/run/poll-stop` ends it): ssh/rsync command lines and manifest sizes into `logs/<label>-procs.txt|-sizes.txt`.
- `$S/07e-mac-checks.sh`: beta-unused status (O6), the three symlinked-root sessions (O5/O7: path, record count, cwds, prompts), link modes (O2), git case rules (O8) on the Mac.

## Snapshots and comparison

- `$S/snap.sh mac <label>` / `$S/snap.sh linux <label>` → `$S/snaps/<label>-<side>.json` (spec files `$S/bin/spec-mac.json`, `spec-linux.json`; content as in Part A: API state, fleet/owner.json, every file under the listed dirs, per-checkout Git state with `--no-optional-locks`, every transcript and sidecar). The remote side copies `bin/{api,snap}.mjs` and `spec-linux.json` to `~/m3-tools`.
- `$BNODE $S/bin/compare.mjs <from.json> <to.json>`: maps paths through the matching roots (plus the Mac `work` real path `/private/tmp/claude-502/m3w2`, read as the declared root on either side, plus the agent homes). A2 taught it: canonical JSON key order; O8 (a `.git/config` or config listing that differs only in `core.ignorecase`/`core.precomposeunicode` is `expected`); worktrees no character uses (`beta-unused`, `zeta-b`) not carried / kept on their own machine (O6) are `expected`; destination-local `node_modules` is `expected`; a transcript at the slug of the cwd's real path counts. The one DIFF every clean compare still prints is `home:docs/deep: dir mode 755 <-> 775` (an intermediate parent m3 creates with Ubuntu's umask; not a carried root).
- `$S/compare-all.sh` re-runs every comparison below into `logs/`.
- Snapshots: `s1-before-mac`, `s1-after-linux`, `s2-before-linux`, `s2-after-mac`, `s3-before-mac`, `s3-after-linux`, `s4-before-linux`, `s4-after-mac`, `s5-before-mac`, `s5-after-linux`, `s6-before-linux`, `s6-after-mac` (the last good state; the Mac owns the fleet at generation 6).

## Fixture

Fourteen characters (ids in `$S/run/chars.tsv`), all running the mocked claude, each with at least one finished turn:

| island | name | id | cwd (Mac) | graph |
| --- | --- | --- | --- | --- |
| m3 repos `i_bru4fc` | alpha-main (+ second terminal) | c_5kdnba | `$TH/src/alpha` | alpha main; committed link `link-to-f1` |
| | alpha-feat | c_roop4l | `$TH/src/alpha/.wt/feat` | alpha, nested worktree inside the main checkout (`.wt/` in info/exclude) |
| | alpha-pkg | c_lu4e18 | `$TH/src/alpha/pkg` | alpha |
| | beta-main | c_bzxm09 | `$TH/src/beta` | beta main (`node_modules/` default-excluded) |
| | beta-wt1, beta-wt2 | c_7pnpf3, c_1fv5p3 | `$TH/src/beta-wt1`, `$TH/src/beta-wt2` | beta, sibling worktrees |
| | beta-sub | c_d5132k | `$TH/src/beta/sub` | beta |
| | gamma-main, gamma-wt | c_hvewbh, c_90kyng | `$TH/code/gamma`, `$TH/code/gamma-wt` (real `/private/tmp/claude-502/m3w2/…`) | gamma, `extensions.worktreeConfig` with per-worktree `m3.role` |
| m3 dirs `i_xpjzbj` | notes (+ second terminal, a `file://$TH/notes/f2.txt` tab) | c_d0yp2x | `$TH/notes` | none; holds `bulk/` (64,000 files, 250 MB) |
| | scratch | c_ii9wuz | `$TH/code/scratch` | none, in the symlinked root |
| | deep | c_zum114 | `$TH/docs/deep/dir` | none |
| | delta-wt | c_2vxa04 | `$TH/src/delta-wt` | delta (main checkout `$TH/src/delta` used by no character, carried as a repo root); committed link `link-to-d` |
| | zeta-main | c_xh57kk | `$TH/src/zeta-main` | zeta: bare `$TH/src/zeta.git` (a **gitdir** root) + worktrees `zeta-main` and `zeta-b` (made on m3, used by no character, holds a stash `zeta-b untracked`; exists only on m3) |

- Each graph has uncommitted edits, an untracked file, a partly staged index and a stash (alpha `.env` too). `beta-unused` is a registered worktree no character uses; it lives on the Mac and kept its registration through three round trips (O6). `zeta-b` lives on m3 and kept its registration there through Linux → Mac → Linux.
- The symlinked-root sessions (gamma-main, gamma-wt, scratch) carry turns from both machines: gamma-main's transcript at `$TH/.claude/projects/-private-tmp-claude-502-m3w2-gamma/5fa5d5a3-….jsonl` holds 10 records.
- alpha-main's session has `subagents/agent-a1.jsonl` (a Claude-shaped record) and `tool-results/toolu_01.txt` sidecars.
- Links: all committed links were made at the macOS default 0755; **after the returns they are 0777 on the Mac** (A2 defect 2). To re-test a 0755 link Mac → Linux, add a new one.
- The m3 repos island has a file context ref `$TH/notes/f1.txt`. The scribe is off (`scribe.set false`).
- m3 also holds `~/notes.archived-2026-09-23T224005Z` (A2's O3 test: an occupied notes) and `~/notes.archived-2026-09-23T224755Z` (the diverged notes after the O9 abort). Leave them.
- The bulk folder makes each handover take 90–110 s (manifest ~15 MB at the source, ~20 MB at the controller). Part B may delete `$TH/notes/bulk` while the Mac owns the fleet; the next handover's `--delete` removes it on m3 too.

## Mocked agent

`$S/bin/claude.mjs` (as in Part A), reached as `claude` through a wrapper that execs the bundled node: on the Mac `$TH/.local/bin/claude`, on m3 `~/.local/bin/claude` → `~/.m3-fake/claude.mjs` with `~/.local/share/archipelago/current/node/bin/node`. In `ps` it is `node …/claude.mjs`, which the rest classifier reads as `claude`. It answers `--version` (`2.1.260 (Claude Code)`), `auth status`, print/usage; in a terminal it posts SessionStart/UserPromptSubmit/Stop/SessionEnd to `$ARCHI_HOME/hooks.sock`, writes Claude 2.1.x records to `<config>/projects/<slug of the real cwd>/<id>.jsonl`, and `--resume <id>` fails like the real CLI when that file is missing. `char run <id> <text>` gives it a turn; a line `block` sends a permission Notification.

The Mac's `/usr/local/bin/claude` is the owner's real Claude; nothing here may run it. The daemon's PATH has `$TH/.local/bin` first and `$TH/.zprofile`/`.zshrc` put it back ahead of path_helper. Check with `ps` that every agent is `…/claude.mjs`.

On m3, `~/.bashrc` starts with `PATH=$HOME/.m3-no-node:$PATH` (stubs for node, npm, npx, pnpm, corepack, tsx that exit 127). `~/.local/bin` is on PATH for login shells only; the unit's PATH has it (`…/current/node/bin:~/.local/bin:/usr/local/bin:/usr/bin:/bin`), and `host doctor` now reports `claude ok 2.1.260`.

## Setup on m3 that is harness, not product (all by A2; nothing else was done by hand)

- `~/.m3-no-node/` and the `.bashrc` line; `~/.m3-fake/claude.mjs` and `~/.local/bin/claude`; `~/m3-tools/` (snapshot tools, `stage-watch.txt` from the O9 run).
- `~/code` (the `work` path root's folder).
- `git stash push -u` in `~/src/zeta-b`, the action the `worktree_unused` blocker names.
- No fleet id edit, no owner.json move, no move of `~/.archipelago/home`, no chmod on links.

## Left running (Part C stops these)

Mac:
- archid, pid in `$S/run/archid.pid` (42680 at the end of A2), log `$FH/archid.log`.
- its tmux server `/opt/homebrew/bin/tmux -S $TH/.archipelago/tmux.sock` (pid 32701) with `_keep`, 14 character windows and 2 second terminals; the daemon's control client (pid 44555); 14 mocked-agent node processes.
- no ssh master, helper or attach is left.

m3 (as archi-m3, lingering):
- `archipelago-archid@private.service` (node, 127.0.0.1:47800, MainPID 1703691) with its tmux server (`_keep` only) and control client; `archipelago-gateway.service` (MainPID 1701156); the user's systemd manager and session services.

## Before-state (for Part C)

- linus-vault: Part A's baseline, taken before any M3 user existed, copied to `$S/baseline/linus-before.txt` (full) and `$S/baseline/linus-state-before.txt` (the stable subset). Re-take with `ssh 100.117.42.24 'sh -s' < $S/linus-state.sh` and `diff`.
  - `tailscale serve status`: `https://linus-vault.prawn-turtle.ts.net (tailnet only)` / `|-- / proxy http://127.0.0.1:8787` (8787 held by linus's `bun`, pid 1627). 47800 was free before.
  - After A2's teardown the stable diff was only Ubuntu's `update-notifier-release.service` (activating → dead). At the end of A2 it is that plus `archi-m3` in the linger dir and passwd, and `127.0.0.1:47800` (archi-m3's archid). The serve mapping is unchanged.
- Mac: `~/.ssh/known_hosts` md5 `1f403c1326762e931fcf90aa00a04d27` and the mtimes of `~/Library/LaunchAgents`, `/Applications/Archipelago.app`, `~/.ssh/known_hosts` (`$S/baseline/known_hosts.md5`, `$S/baseline/mac-mtimes.txt`), unchanged since Part A. `~/.archipelago`, `~/.claude`, `~/.codex`, `~/.local/bin` change on their own through the owner's live fleet; this pass never opened them.
- Outside `$S`, A2 created `/private/tmp/claude-502/m3h2` (temp HOME), `/private/tmp/claude-502/m3w2` (the `work` root's target) and the symlink `/private/tmp/claude-502/m3b`; Part C removes all three.
- Teardown recipe (A2 used it; `$S/teardown-*.sh`, `$S/check-remote-gone.sh`): Mac: kill archid, `tmux -S … kill-server`, kill masters/helpers, remove the three paths. m3: as archi-m3 stop and disable the archipelago units and `tmux kill-server`; as linus `loginctl disable-linger archi-m3`, `terminate-user`, `deluser --remove-home archi-m3`. deluser leaves `/home/archi-m3/.archipelago/tmux.sock` behind (as in M2); A2 removed the leftover `/home/archi-m3` with `sudo rm -r`, then checked no user, group, home, `/run/user/1002`, linger entry, uid-1002 process or file.

---

## Part B changes (2026-09-24)

Part B's scratchpad (`$B`): `/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/458d4622-7488-4208-9faa-1ee5a901238b/scratchpad/m3-onmachine-b`.
It sources `$S/env.sh` through `$B/benv.sh`. The report is `W/m3-onmachine-B-report.md`.

- **Ownership now:** the Mac owns the fleet at **generation 44**, and no transaction is open anywhere (`archi handover
  status`: none; both daemons have no journal; the gateway record has no transaction). The Mac has 16 windows and 14
  mocked agents. m3 has `_keep` only.
- **Fixture:** `$TH/notes/bulk` (64,000 files) was deleted on the Mac after B3d, as A2 allowed. The next Mac → Linux
  `--delete` removed it on m3, so handovers now take 12–20 s. Nothing else in the fixture changed: `$B/snaps/final-mac.json`
  equals `b01-mac.json` (0 DIFF), and `final-mac` is the last good snapshot.
- **Processes restarted by the fault injections:**
  - The Mac archid is now **pid 81104**. `$S/run/archid.pid` is current: `mac-daemon-start.sh` rewrites it.
  - m3's `archipelago-archid@private.service` has MainPID 154986, and `archipelago-gateway.service` MainPID 196330.
    Both are active and enabled.
  - Both machines' tmux servers are the original ones.
- **Temp HOME registry:** C4 pointed m3's `ssh` in `$TH/.config/archipelago/machines.json` at `archi-m3@192.0.2.1` for
  about 2 minutes, then restored it byte for byte (md5 `ba0a1133fe78a59938bf136cafefbe44`, as before).
- **Harness, Part B only:**
  - `$B/shim/ssh`, a pass-through `ssh` that holds one gateway op's answer. It is only on a helper's PATH when a cell
    sets `HOLD_OP`, and nothing else uses it.
  - `$B/cell.sh <cell>` / `runcell.sh` / `bg.sh` / `waitcell.sh`, the per-cell injector (`bin/cell.mjs`, `bin/plans.mjs`).
  - `$B/c4.sh`, `$B/flip.sh`, `$B/bsnap.sh`, `$B/bcmp.sh`.
  - Samplers and control shells end with each cell.
- **Left running by Part B:** nothing. There is no ssh master, helper, attach, connect, caffeinate or sampler of this
  part on the Mac, and no stray process of it on m3 (checked with `ps` on both machines at the end).
- **m3 by hand:**
  - B2k's first run killed the whole archid unit. The 14 characters it left dormant were revived with `char.revive` and
    `char.second` (`$B/logs/B2k-r.manual-revive.log`).
  - After A8k2, Enter was pressed in the four panes where D6 had left the resume command typed
    (`$B/logs/A8k2.manual-enter.log`).
  - Both ended clean against the last good snapshot.
- **Before-state checks:**
  - linus-vault's stable state against Part A's baseline: the same three differences as at the end of A2
    (update-notifier, archi-m3 in linger/passwd, `127.0.0.1:47800`). The serve mapping is unchanged.
  - The Mac's `~/.ssh/known_hosts` md5 is unchanged.

---

## Part C changes (2026-09-24, stopped at NEEDS_CONTEXT before real Claude on the Mac)

Part C's scratchpad (`$C`): `/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/458d4622-7488-4208-9faa-1ee5a901238b/scratchpad/m3-onmachine-c`
(`cenv.sh` = A2's env.sh with `REL=e96ee59b`; `benv.sh` = Part B's harness pointed at `$C`; report `W/m3-onmachine-C-report.md`).

- **Release `e96ee59b`** on both machines: the app is replaced in `$TH/Applications`, and `current` is `releases/e96ee59b`
  on the Mac (setup, no launchctl) and on m3 (`archi host upgrade m3`). The companion is
  `$C/companion/archipelago-companion-e96ee59b-linux-x64.tar.gz`.
- **Mac archid:** restart with `$C/mac-daemon-restart.sh`, which keeps its cwd in `$TH`, where agent probes run. The pid
  is still in `$S/run/archid.pid`. m3's archid has MainPID 716443 and the gateway 636787.
- **Ownership:** the Mac at **g54**, no transaction. The Mac has 17 windows: the 14 mocks, 2 second terminals, and
  **real-codex `c_99tug7`** (`$TH/real/codex-x`, a real Codex 0.156.1 session `01a0d2cd-…`, three turns). m3 has
  `_keep` only. The last good snapshot is `$C/snaps/x2-mac.json`, but A2's compare.mjs only understands Claude
  transcripts, so the Codex session lines in it are not meaningful.
- **Agents:** the credentials, binary copies, wrappers and Codex trust are as listed in the C report's "Environment
  left". `claude` on m3 dispatches: the mock in the fixture folders, the real 2.1.280 elsewhere. On the Mac it is
  the plain mock until real Claude can log in there.
- **Harness on m3:** `~/.m3-no-node/node` was renamed `node.part-c-disabled`, because Codex's hook runs `node` from PATH.
- **Cleanup still owed**, as the "Teardown recipe" above. Also remove `$TH/agents` and the credential copies. They go
  with the temp HOME and with archi-m3's home.

### Part C, second stop (2026-09-24 ~11:25 UTC, HEAD 2415ab4c)

- **Release:** `2415ab4c` on both machines (`$C/cenv.sh` has `REL=2415ab4c`). m3's archid has MainPID 1119122 and the
  gateway 1119132.
- **Ownership:** **m3 at g57**, no transaction. m3 runs the 14 mocks, real-codex `c_99tug7` and real-claude `c_8cnba6`
  (`~/real/claude-c`, logged out). The Mac has `_keep` only.
- **Claude:**
  - The Mac's `claude` is the dispatching wrapper (real 2.1.280 outside the fixture folders), logged out.
  - archi-m3's copied credential cannot be refreshed, and Claude emptied it.
  - Handovers either way block `agent_logged_out` until the destination's Claude is logged in.
- **Codex trust lab:** `trustlab/` folders in both homes. Both `config.toml` files are restored to their base.
- **Cleanup still owed:** as in the C report's "Environment at this stop".
