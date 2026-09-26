# M3b environment (Task 40b; for Tasks 41–42 and the M3b gate)

Written by Task 40b's second run on 2026-09-26 at HEAD `9be818f5` (report `task-40-smoke2-report.md`). The fleet has
made one round trip: the Mac → Linux handover was generation 1 and the Linux → Mac return generation 2. **The Mac owns
it at generation 2**, and no transaction is open anywhere.

`$S` below is the second run's scratchpad:
`/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/3739c9b8-51d0-4aa6-ac32-19bc0b56eee0/scratchpad/t40s2`.
The first run's `…/scratchpad/t40` beside it keeps that run's logs and snapshots.

## Where things are

| | |
| --- | --- |
| Build | worktree HEAD `9be818f5`, release **`9be818f5`** (unsigned; named after the commit). `$S/build.sh` (desktop:install's build steps, prebuilt GhosttyKit, Node 24.21.0 in the release, protocol 17, stateSchema 8), log `$S/logs/01-build.log` |
| Test HOME (`TH`) | `/Users/Shared/archi-m3b` on the Mac (0700), the same path as archi-m3b's home on linus-vault |
| `ARCHI_APP_DEST` | `$TH/Applications` (the app is `$TH/Applications/Archipelago.app`) |
| Helper | `$TH/Applications/Archipelago.app/Contents/Resources/release/bin/archi` (bundled node `…/release/node/bin/node`, `$BNODE` in `env.sh`) |
| Installed release | `archi -p private setup --no-launchctl --allow-unsigned --release <app>/Contents/Resources/release` → `$TH/.local/share/archipelago/current` → `releases/9be818f5` (the older `ghostty-kit-24-g0b72b15a-dirty` is still in `releases/`); plist `$TH/Library/LaunchAgents/io.github.linusroxbergh.archipelago.archid.plist`, never loaded |
| TMPDIR | `$TH/tmp/` (ssh control sockets go to `$TH/tmp/archi-502/<hash>`) |
| Companion archive | `$S/companion/archipelago-companion-9be818f5-linux-x64.tar.gz` (46,179,169 B, sha256 `f4ee28f38326d9b8…`) |
| Remote | host `m3b` = `archi-m3b@100.117.42.24`, machine `51cf5316-f3d9-447c-8855-58a6521effd2`, uid/gid 1002, linger on, home `/Users/Shared/archi-m3b` (`/Users` and `/Users/Shared` made for it, root 0755). Release `9be818f5` under `~/.local/share/archipelago` (installed by `archi host upgrade`, which exited 1: report N1); `ghostty-kit-24-g0b72b15a-dirty` is still in `releases/` |
| Mac machine | `linuss-macbook-pro` (the test HOME's own id) `05b3af33-8eae-4be7-ae90-4f2d1318c398` |
| Fleet | `private`, id `d85abac7-4346-4b6a-8e86-d24a4053d294`, gateway `m3b` (`host list`: gateway yes) |
| Mac fleet home (`FH`) | `$TH/.archipelago`, daemon on `127.0.0.1:47871` (node.json moved off 47800, which the owner's live daemon holds) |
| Linux fleet home | `/Users/Shared/archi-m3b/.archipelago`, `archipelago-archid@private.service` on `127.0.0.1:47800`, now a read-only replica with sealed replicas of every root at generation 2 (`~/notes`, `~/src`, `~/real`, `~/.archipelago/home`), and a tmux server holding only `_keep`. `home.archived-2026-09-26T151618Z` there is the old-template home that `--archive` moved aside (report N2); safe to delete. `archipelago-gateway.service` holds the authority record |
| Path roots (Mac registry `$TH/.config/archipelago/machines.json`) | `home=/Users/Shared/archi-m3b` for both machines, written by `host add`; nothing else declared |
| Ownership | the Mac at generation 2; `archi handover status`: none open anywhere |

## Wrappers (all `sh`; the Mac ones source `$S/env.sh`: unsets ARCHI_HOME/ARCHI_CHAR_ID/TMUX/TMUX_PANE, sets HOME, ARCHI_APP_DEST, TMPDIR and the Finder PATH `/usr/bin:/bin:/usr/sbin:/sbin`)

- `$S/a.sh <archi args>`: the bundled helper, stdin `/dev/null`.
- `$S/ho.sh <label> <handover args>`: runs `archi handover … --json` in the foreground and writes
  `logs/<label>.ndjson|.stderr`.
- `$S/watch-manifest.sh <label>` (background during a handover): copies the controller's and the Mac daemon's
  manifests, which Complete clears, into `evidence/<label>/`. Stop it with `touch evidence/<label>/stop`. Read them with
  `$BNODE $S/bin/pids.mjs <files>`.
- RPC wrappers (tokens are never printed):
  - `$S/api.sh <method> [json]`: one RPC to the Mac daemon;
  - `$S/rapi.sh <method> [json]`: the same on m3b, through `~/m3b-tools/api.mjs`;
  - `$S/chars.sh`: one line per character of the Mac state, with each slot's pid and revive.
- `ssh archi-m3b@100.117.42.24 'sh -s' < <script>` runs these on m3b:
  - `$S/far-checks.sh`: ownership, characters, windows, agent argv, state pids against `/proc`, profiles, home and log;
  - `$S/linux-fenced.sh`: the Linux side after the fleet left it;
  - `$S/notes-wake.sh`: opens the dormant notes.
- `$S/mac-fenced.sh`: the Mac after the fleet left it.
- `$S/mac-daemon-start.sh` starts the Mac daemon as its plist would (`env -i`, the plist's PATH, cwd `$TH`). Its pid goes
  to `$S/run/archid.pid` and its log to `$FH/archid.log`. `$S/mac-daemon-restart.sh` restarts it.
- `$S/st.sh` (Mac) and `$S/rst.sh` (m3b): a setup tmux of its own, not the fleet's, for answering Codex's trust screens.
- `$S/snap.sh mac|linux <label>` writes `$S/snaps/<label>-<side>.json`, and `$S/cmp.sh <from> <to>` runs `bin/compare.mjs`.
- Checks: `$S/09-token-grep.sh`, and `$S/linus-diff.sh [label]` (linus-vault's stable state against the before-state).
- Do not write a redirection-only command such as `$UNSET 2>/dev/null` in zsh: it runs `cat` on stdin.

## Snapshots and comparison

- `bin/snap.mjs` and `bin/spec-{mac,linux}.json` as in M3, with one root (`home`) at the same path on both sides. The
  spec lists `home:real`, so `real/flags` and `real/codex-p` are covered.
- `bin/compare.mjs` is A2's plus four checks:
  - `agentProfile` and `dormantAfterHours` are compared;
  - a slot dormant on both sides is `expected`;
  - a Codex slot's rollout path must equal the source's.

  With identical roots, any `rewrite` line is a finding. It does not record link modes.
- Snapshots:
  - `s2-before-mac`: the last state before the round trip;
  - `s2-after-linux` and `s3-before-linux`: m3b as owner;
  - `s3-after-mac`: the current state.

  `s2-before-mac → s3-after-mac` is 1 DIFF: notes' revive, since it was woken on Linux and came back live.

## Fixture (Mac)

Islands: `m3b repos` `i_k46lzs` (file context ref `$TH/notes/f1.txt`, so its agents get `--add-dir $TH/notes`) and
`m3b dirs` `i_6crr3l`. The scribe is off, and `dormantAfterHours` is **0** (keep every agent running). Ids are in
`$S/run/chars.tsv`.

| name | id | cwd | notes |
| --- | --- | --- | --- |
| notes | `c_4jdink` | `$TH/notes` | idle-closed at 13:35Z, carried dormant to Linux, woken there, now live again (session `a238f2dd-59c9-472e-a080-8935c84ab154`, 6 records: Mac, Linux, Mac) |
| alpha-main | `c_d4e995` | `$TH/src/alpha` | its second terminal runs the mocked claude (session `35bbee19-0e88-4881-a4a8-b02bf8885f16`) |
| alpha-feat | `c_2kp1rw` | `$TH/src/alpha/.wt/feat` | nested worktree; agent profile `m3b-role` (custom, only in the Mac's `$FH/agent-profiles/`) |
| beta-main | `c_dy5zy3` | `$TH/src/beta` | `node_modules/` default-excluded |
| beta-wt1 | `c_9y8x8f` | `$TH/src/beta-wt1` | sibling worktree |
| beta-wt2 | `c_27vxwy` | `$TH/src/beta-wt2` | sibling worktree |
| real-codex | `c_ts2fmw` | `$TH/real/codex-x` | real Codex 0.156.1, session `01a0ddbd-67eb-7b41-8ec8-a30797ef4a8f`, 46 records (`MANGO` → `MANGO-LINUX` → `MANGO-LINUX-MAC`) |
| flags | `c_ku8ri5` | `$TH/real/flags` | mocked, started `claude --effort high --dangerously-skip-permissions --model x`; it resumes with `--effort high --dangerously-skip-permissions` |
| real-codex-p | `c_z2jbwx` | `$TH/real/codex-p` | real Codex, started `codex -p t40 -m gpt-6-astra`, session `01a0de47-a05d-7b20-a108-5e27532bb402`, 46 records (`KIWI` → `…-LINUX` → `…-LINUX-MAC`); after the round trip it runs `-m gpt-6-astra` without the Mac-only profile |

- Graph alpha: nested worktree `.wt/feat` (in `info/exclude`), committed link `link-to-f1`, a repo `.env`.
- Graph beta: sibling worktrees `beta-wt1` and `beta-wt2`.
- Each graph has uncommitted edits, a partly staged index, an untracked file and a stash (`t40/05d-git-fixture.sh`).
- The links are `lrwxrwxrwx` since the return (A2 defect 2).
- `$FH/agent-profiles` holds the six bundled profiles, which the new daemon seeded after the harness set the folder
  aside, plus `m3b-role.md`, put back.
- m3b's `~/.archipelago/agent-profiles` holds the six bundled profiles only. It was seeded when m3b first owned the
  fleet, and `m3b-role` never travels (Task 42).

## Mocked agent

`$TH/.m3b-mock/claude` on both machines is A2's `claude.mjs`, extensionless beside a `package.json` of
`{"type":"module"}`. It posts its own pid with each hook.

- It is reached as `claude` through `~/.local/bin/claude`. On the Mac that execs the app's bundled node; on m3b,
  `~/.local/share/archipelago/current/node/bin/node`.
- In `ps` it is `…/node /Users/Shared/archi-m3b/.m3b-mock/claude`, which the rest, the idle close and `startFlags` read
  as claude.
- `$TH/.zprofile` and `.zshrc` keep `$TH/.local/bin` ahead of `/usr/local/bin`. The owner's real `/usr/local/bin/claude`
  never ran under the test HOME.

## Real Codex and credentials

- **Mac:**
  - Codex: `$TH/agents/codex` (a copy of the owner's `0.156.1-aarch64-apple-darwin`), reached as `$TH/.local/bin/codex`.
  - Credential: `$TH/.codex/auth.json`, a copy of the owner's, 0600.
  - `$TH/.codex/config.toml`: `check_for_update_on_startup = false`, trust for `$TH/real/codex-x` and `$TH/real/codex-p`,
    and the 8 Archipelago hooks trusted. The pre-run-2 copy is `$S/run/mac-codex-config.before.toml`.
  - Profile `t40` is `$TH/.codex/t40.config.toml` (`model_reasoning_effort = "low"`). Codex 0.156.1 refuses `--profile`
    beside a legacy `[profiles.<name>]` table.
  - `$TH/.claude.json` has `hasCompletedOnboarding`. There is no Claude credential on the Mac.
- **m3b:**
  - Codex: `~/agents/codex` (a copy of linus's `0.156.1-x86_64-unknown-linux-musl`), reached as `~/.local/bin/codex`.
  - Credentials: `~/.codex/auth.json` and `~/.claude/.credentials.json` (the owner's Mac login, from Task 41), 0600.
  - `~/.codex/config.toml` like the Mac's, trusting `real/codex-x` and `real/codex-p` and the 8 hooks. There is no
    profile `t40`.
  - Task 41's `~/agents/claude-2.1.283` and `~/probe/` are there too. Neither is part of the fleet.
- The release upgrade left both `hooks.json` files byte-identical, so the hook trust held.

## Harness on m3b (not product)

- `~/.m3-no-node/` holds stubs for npm, npx, pnpm, corepack and tsx (exit 127), with the `.bashrc` line putting them
  first. The node stub is renamed `node.t40-disabled`, because Codex's hook runs `node` from PATH.
- `~/.m3b-mock/`, `~/.local/bin/{claude,codex}`, `~/agents/codex`, and `~/m3b-tools/` (api, chars and snap tools, plus
  the last `out.json`).

## Left running

- **Mac:**
  - archid, pid in `$S/run/archid.pid` (156, on `releases/9be818f5`), log `$FH/archid.log`;
  - its tmux server `/opt/homebrew/bin/tmux -S $FH/tmux.sock` (49278) and control client (14840);
  - 11 windows: `_keep`, the 9 characters and `c_d4e995-2`;
  - 8 mocked agents and 2 real Codex (real-codex, real-codex-p), all idle.
  - No ssh master, helper, watcher or setup tmux is left, and `caffeinate` is stopped.
- **m3b** (archi-m3b, lingering):
  - `archipelago-archid@private.service` (MainPID 2563672) and `archipelago-gateway.service` (MainPID 2562286), both
    on `9be818f5`, active and enabled;
  - the fleet's tmux server (`/usr/bin/tmux -u`, `_keep` only), left from its time as owner.

## Before-state

- **linus-vault:** `$S/baseline/linus-before.txt` (full) and `linus-state-before.txt` (stable subset), both taken at
  the start of 40b while archi-m3 still existed.
  - `tailscale serve status`: `https://linus-vault.prawn-turtle.ts.net (tailnet only)` / `|-- / proxy
    http://127.0.0.1:8787` (linus's `bun`).
  - `127.0.0.1:47800` was archi-m3's archid and is now archi-m3b's.
  - Re-take with `$S/linus-diff.sh <label>`. At the end of the second run the only difference is archi-m3 → archi-m3b
    in passwd and the linger directory.
- **Mac:** `$S/baseline/mac-before.txt`.
  - `~/.ssh/known_hosts` md5 `1f403c1326762e931fcf90aa00a04d27` (mtime Sep 14), unchanged.
  - `~/Library/LaunchAgents` mtime 2026-09-26 11:49:14 +0200, unchanged.
  - `/Applications/Archipelago.app` is the owner's own install. It changed outside 40b, last at 15:51:36 +0200 to build
    `3217f2c0`, which has no bundled release.
  - 40b never opened the owner's `~/.archipelago*`, `~/.claude` or `~/.local/bin`, and read `~/.codex` only for the
    copies above.

## Teardown recipe (not run; the environment stays for Tasks 41–42 and the M3b gate)

- **Mac:** `sh $S/teardown-mac.sh`. It kills archid, the tmux server, and any master or helper of `$TH`, then removes
  `/Users/Shared/archi-m3b`, which takes the app, the release, the Codex credential, the binary copies and Task 41's
  `probe/` with it. Task 41's probe session in the owner's `~/.claude/projects/-Users-Shared-archi-m3b-probe-claude/` is
  outside it (see `task-41-probe-report.md`).
- **m3b:**
  1. `ssh archi-m3b@100.117.42.24 'sh -s' < $S/teardown-remote-user.sh`;
  2. `ssh 100.117.42.24 'sh -s' < $S/teardown-remote-root.sh`: disables linger, runs terminate-user and
     `deluser --remove-home`, runs `rm -r` on what deluser leaves and on `/tmp/claude-1002` (a real Claude ran there in
     Task 41), then `rmdir /Users/Shared /Users`;
  3. `… < $S/check-remote-gone.sh`;
  4. `$S/linus-diff.sh final` against the before-state.
