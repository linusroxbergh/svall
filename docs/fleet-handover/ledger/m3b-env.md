# M3b environment (Task 40b; for Tasks 41–42 and the M3b gate)

Written by Task 40b on 2026-09-26 at HEAD `0b72b15a`. archi-m3 and the M3 Mac leftovers are gone; this environment
replaces them. Task 40b stopped BLOCKED before its first handover (see `task-40-smoke-report.md`, defect D1), so **no
handover of this fleet has ever begun**: the Mac owns it at generation 0 and m3b holds an empty read-only replica.

`$S` below is the Task 40b scratchpad:
`/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/3739c9b8-51d0-4aa6-ac32-19bc0b56eee0/scratchpad/t40`

## Where things are

| | |
| --- | --- |
| Build | worktree HEAD `0b72b15a`, release `ghostty-kit-24-g0b72b15a-dirty` (unsigned). `git describe --tags` picks up the `ghostty-kit` release tag, and `-dirty` is the coordinator's uncommitted `progress.md`. `$S/build.sh` (desktop:install's build steps, prebuilt GhosttyKit, Node 24.21.0 in the release), log `$S/logs/03-build.log` |
| Test HOME (`TH`) | `/Users/Shared/archi-m3b` on the Mac (0700), the same path as archi-m3b's home on linus-vault |
| `ARCHI_APP_DEST` | `$TH/Applications` (the app is `$TH/Applications/Archipelago.app`) |
| Helper | `$TH/Applications/Archipelago.app/Contents/Resources/release/bin/archi` (bundled node `…/release/node/bin/node`, `$BNODE` in `env.sh`) |
| Installed release | `archi -p private setup --no-launchctl --allow-unsigned --release <app>/Contents/Resources/release` → `$TH/.local/share/archipelago/current` → `releases/ghostty-kit-24-g0b72b15a-dirty`; plist `$TH/Library/LaunchAgents/io.github.linusroxbergh.archipelago.archid.plist`, never loaded |
| TMPDIR | `$TH/tmp/` (ssh control sockets go to `$TH/tmp/archi-502/<hash>`) |
| Companion archive | `$S/companion/archipelago-companion-ghostty-kit-24-g0b72b15a-dirty-linux-x64.tar.gz` (46,162,771 B, sha256 `7aba8970…b056b2`) |
| Remote | host `m3b` = `archi-m3b@100.117.42.24`, machine `51cf5316-f3d9-447c-8855-58a6521effd2`, uid/gid 1002, linger on, home `/Users/Shared/archi-m3b` (`/Users` and `/Users/Shared` made for it, root 0755), release under `~/.local/share/archipelago` |
| Mac machine | `linuss-macbook-pro` (the test HOME's own id) `05b3af33-8eae-4be7-ae90-4f2d1318c398` |
| Fleet | `private`, id `d85abac7-4346-4b6a-8e86-d24a4053d294`, gateway `m3b` (`host list`: gateway yes) |
| Mac fleet home (`FH`) | `$TH/.archipelago`, daemon on `127.0.0.1:47871` (harness: `03c-setup.sh` moved node.json off 47800, which the owner's live daemon holds) |
| Linux fleet home | `/Users/Shared/archi-m3b/.archipelago`, made by the second `host enable` (outcome `created`); `archipelago-archid@private.service` on `127.0.0.1:47800`, read-only replica, no tmux server; `archipelago-gateway.service` holds the authority record (the Mac owns at generation 0) |
| Moved-aside home | `/Users/Shared/archi-m3b/.archipelago.t40-aside`: the fleet home `host add` made, which the tmux 3.4 listing defect (D1) gave a nameless recovered character; host enable refused it, and its own action was to move it aside. Evidence copies in `$S/evidence/`. Safe to delete |
| Path roots (Mac registry `$TH/.config/archipelago/machines.json`) | `home=/Users/Shared/archi-m3b` for both machines, written by `host add`; nothing else declared |
| Ownership | the Mac at generation 0; `archi handover status`: none open anywhere |

## Wrappers (all `sh`; the Mac ones source `$S/env.sh`: unsets ARCHI_HOME/ARCHI_CHAR_ID/TMUX/TMUX_PANE, sets HOME, ARCHI_APP_DEST, TMPDIR and the Finder PATH `/usr/bin:/bin:/usr/sbin:/sbin`)

- `$S/a.sh <archi args>`: the bundled helper, stdin `/dev/null`.
- `$S/ho.sh <label> <handover args>`: `archi handover … --json` in the foreground; `logs/<label>.ndjson|.stderr`.
- `$S/api.sh <method> [json]`: one RPC to the Mac daemon. `$S/rapi.sh <method> [json]`: the same on m3b through
  `~/m3b-tools/api.mjs`. `$S/chars.sh`: one line per character of the Mac state. Tokens are never printed.
- `$S/mac-daemon-start.sh`: starts the Mac daemon as its plist would (`env -i`, the plist's PATH, cwd `$TH`); pid in
  `$S/run/archid.pid`, log `$FH/archid.log`. Stop: `kill $(cat $S/run/archid.pid)`.
- `$S/st.sh` (Mac) and `$S/rst.sh` (m3b): a setup tmux of its own, not the fleet's, for answering Codex's trust screens.
- `$S/snap.sh mac|linux <label>` → `$S/snaps/<label>-<side>.json`; `$S/cmp.sh <from> <to>` runs `bin/compare.mjs`.
- `$S/05h-replica-fence.sh` (m3b refuses mutations), `$S/09-token-grep.sh`, `$S/linus-diff.sh [label]` (linus-vault's
  stable state against the before-state).

## Snapshots and comparison

- `bin/snap.mjs` and `bin/spec-{mac,linux}.json` as in M3, with one root (`home`) at the same path on both sides.
- `bin/compare.mjs` is A2's with four additions: `agentProfile` and `dormantAfterHours` are compared; a slot dormant on
  the source and the destination is `expected`; a Codex slot's rollout path must equal the source's. With identical
  roots every path maps to itself, so any `rewrite` line is now a finding.
- Snapshots: `s0-fixture-mac` (before notes went dormant) and `s1-before-mac` (the last good state).

## Fixture (Mac)

Islands `m3b repos` `i_k46lzs` (file context ref `$TH/notes/f1.txt`) and `m3b dirs` `i_6crr3l`; scribe off. Ids are in
`$S/run/chars.tsv`.

| name | id | cwd | notes |
| --- | --- | --- | --- |
| notes | `c_4jdink` | `$TH/notes` | plain folder; **idle-closed** (see below) |
| alpha-main | `c_d4e995` | `$TH/src/alpha` | + second terminal (a shell) |
| alpha-feat | `c_2kp1rw` | `$TH/src/alpha/.wt/feat` | nested worktree; agent profile `m3b-role` (custom, in `$FH/agent-profiles/`) |
| beta-main | `c_dy5zy3` | `$TH/src/beta` | `node_modules/` default-excluded |
| beta-wt1 | `c_9y8x8f` | `$TH/src/beta-wt1` | sibling worktree |
| beta-wt2 | `c_27vxwy` | `$TH/src/beta-wt2` | sibling worktree |
| real-codex | `c_ts2fmw` | `$TH/real/codex-x` | real Codex 0.156.1, session `01a0ddbd-67eb-7b41-8ec8-a30797ef4a8f`, one turn (`• MANGO`) |

- Graph alpha: nested worktree `.wt/feat` (in `info/exclude`), committed link `link-to-f1` (0755), a repo `.env`.
  Graph beta: sibling worktrees `beta-wt1`, `beta-wt2`. Each graph has uncommitted edits, a partly staged index, an
  untracked file and a stash (`$S/05d-git-fixture.sh`).
- Every mocked character has one finished turn and was looked at (`char.seen`).
- **notes is idle-closed.** `dormancy.set 1` h, then at 13:35:11Z `notes dormant after 1 h idle`. It keeps `agent`
  (session `a238f2dd-59c9-472e-a080-8935c84ab154`, transcript
  `$TH/.claude/projects/-Users-Shared-archi-m3b-notes/a238f2dd-….jsonl`, and the dead pid 58292) and
  `revive: claude --resume a238f2dd-…`. The fleet's idle limit is now **0 (keep every agent running)**, so the rest of
  the fixture stays live until someone changes it. Do not open notes before the handover that is meant to carry it
  dormant.
- alpha-feat's profile `m3b-role` exists only in the Mac's `$FH/agent-profiles/`. The release seeds none (D2), and m3b
  has no such folder.

## Mocked agent

`$TH/.m3b-mock/claude` on both machines (A2's `claude.mjs`, extensionless beside a `package.json` of
`{"type":"module"}`, and it now posts its own pid with each hook, as `agent-hook.mjs` does). Reached as `claude`
through `~/.local/bin/claude`: on the Mac it execs the app's bundled node, on m3b `~/.local/share/archipelago/current/node/bin/node`.
In `ps` it is `…/node /Users/Shared/archi-m3b/.m3b-mock/claude`, which both the rest classifier and the idle close's
`startFlags` read as claude (a `.mjs` name would keep idle close from ever closing it, `dormancy.ts:46-47`; without a
pid it finds no process, `fleet.ts:434`). `$TH/.zprofile`/`.zshrc` keep `$TH/.local/bin` ahead of path_helper's
`/usr/local/bin`; the owner's real `/usr/local/bin/claude` never ran under the test HOME.

## Real Codex and credentials

- Mac: `$TH/agents/codex` (a copy of the owner's `0.156.1-aarch64-apple-darwin`), `$TH/.local/bin/codex`;
  `$TH/.codex/auth.json` (a copy of the owner's, 0600); `$TH/.codex/config.toml` with
  `check_for_update_on_startup = false`, trust for `$TH/real/codex-x` and the 8 Archipelago hooks (answered in `st.sh`).
  `$TH/.claude.json` has `hasCompletedOnboarding`. No Claude credential on the Mac.
- m3b: `~/agents/codex` (a copy of linus's `0.156.1-x86_64-unknown-linux-musl`), `~/.local/bin/codex`;
  `~/.codex/auth.json` and `~/.claude/.credentials.json` (copies of linus's, 0600; the Claude one is most likely dead,
  M3 Part C R4b-1, and nothing here used it); `~/.codex/config.toml` like the Mac's, trusting
  `/Users/Shared/archi-m3b/real/codex-x` (the folder was made for the trust screen, then removed) and the 8 hooks.
  With both sides trusting, preflight gives no `codex_trust` warning.

## Harness on m3b (not product)

- `~/.m3-no-node/` stubs for npm, npx, pnpm, corepack, tsx (exit 127) and the `.bashrc` line putting them first;
  the node stub is renamed `node.t40-disabled`, because Codex's hook runs `node` from PATH.
- `~/.m3b-mock/`, `~/.local/bin/{claude,codex}`, `~/agents/codex`, `~/m3b-tools/` (api, chars, snap tools).
- `~/.archipelago.t40-aside` (above). Nothing else was done by hand: no fleet id edit, no owner.json move.

## Left running

Mac:
- archid, pid in `$S/run/archid.pid` (49234), log `$FH/archid.log`; its tmux server `/opt/homebrew/bin/tmux -S
  $FH/tmux.sock` (49278) and control client (49281). There are 8 windows: `_keep`, alpha-main (+ `c_d4e995-2`),
  alpha-feat, beta-main, beta-wt1, beta-wt2 and real-codex. That is 5 mocked agents and 1 Codex (pid 91960), with notes
  dormant.
- No ssh master, helper or setup tmux is left. `caffeinate` was stopped at the end of 40b.

m3b (archi-m3b, lingering):
- `archipelago-archid@private.service` (MainPID 1908883, a replica with no tmux server) and
  `archipelago-gateway.service` (MainPID 1894670), both active and enabled.

## Before-state

- linus-vault: `$S/baseline/linus-before.txt` (full) and `linus-state-before.txt` (stable subset), taken at the start of
  40b while archi-m3 still existed. `tailscale serve status`: `https://linus-vault.prawn-turtle.ts.net (tailnet only)`
  `|-- / proxy http://127.0.0.1:8787` (linus's `bun`, pid 1627). `127.0.0.1:47800` was archi-m3's archid and is now
  archi-m3b's. Re-take with `$S/linus-diff.sh <label>`; at the end of 40b the only difference is archi-m3 → archi-m3b in
  the linger directory and passwd.
- Mac: `$S/baseline/mac-before.txt`: `~/.ssh/known_hosts` md5 `1f403c1326762e931fcf90aa00a04d27` (mtime Sep 14),
  `~/Library/LaunchAgents` mtime 2026-09-26 11:49:14 +0200, `/Applications/Archipelago.app` 2026-09-26 11:42:14 +0200
  (the owner's own install). The last changed during 40b, at 15:15:32 +0200, to main's build `54133b7b`, which has no
  bundled release, so it was not 40b. 40b never opened the owner's `~/.archipelago*`, `~/.claude` or `~/.local/bin`, and read
  `~/.codex` only for the copies above.

## Teardown recipe (not run; the environment stays for Tasks 41–42 and the M3b gate)

- Mac: `sh $S/teardown-mac.sh` (kills archid and the tmux server, any master or helper of `$TH`, then removes
  `/Users/Shared/archi-m3b`, which takes the app, the release, the Codex credential and binary copies with it).
- m3b: `ssh archi-m3b@100.117.42.24 'sh -s' < $S/teardown-remote-user.sh`, then
  `ssh 100.117.42.24 'sh -s' < $S/teardown-remote-root.sh` (disable linger, terminate-user, `deluser --remove-home`,
  `rm -r` what deluser leaves, `/tmp/claude-1002` if a real Claude ran, then `rmdir /Users/Shared /Users`), then
  `… < $S/check-remote-gone.sh`, then `$S/linus-diff.sh final` against the before-state.
