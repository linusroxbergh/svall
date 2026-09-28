# M3b environment (for the owner's by-eye pass and what follows the M3b gate)

Written by the M3b gate's re-check after its fix wave on 2026-09-28 at HEAD `46978368` (report `m3b-gate-report.md`,
"Re-check after the fix wave"). The fleet has made three round trips:
- 40b's was generations 1 and 2;
- the gate's was generations 3 and 4;
- the re-check's Mac → Linux was generation 5, and its Linux → Mac generation 6.

**The Mac owns it at generation 6**, and no transaction is open anywhere.

`$G` below is the gate's scratchpad:
`/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/3739c9b8-51d0-4aa6-ac32-19bc0b56eee0/scratchpad/m3bg`.
The re-check's logs are in `$G/logs/r/`. Task 40b's `…/scratchpad/t40s2` and `…/t40` beside it keep those runs' logs and
snapshots.

## Where things are

| | |
| --- | --- |
| Build | release **`4697836`** (unsigned; protocol 17, stateSchema 8, Node 24.21.0), built by `$G/build-r.sh` in `$G/src`: a `git archive` snapshot of `46978368` with that commit's git metadata and the worktree's gitignored vendor caches. Log `$G/logs/r/01-build.log`. The gate's `32ee1745` came from `$G/build.sh` in the worktree |
| Test HOME (`TH`) | `/Users/Shared/archi-m3b` on the Mac (0700), the same path as archi-m3b's home on linus-vault |
| `ARCHI_APP_DEST` | `$TH/Applications` (the app is `$TH/Applications/Archipelago.app`) |
| Helper | `$TH/Applications/Archipelago.app/Contents/Resources/release/bin/archi` (bundled node `…/release/node/bin/node`, `$BNODE` in `env.sh`) |
| Installed release | `$TH/.local/share/archipelago/current` → `releases/4697836` (`32ee1745`, `9be818f5` and `ghostty-kit-24-g0b72b15a-dirty` are still in `releases/`); plist `$TH/Library/LaunchAgents/io.github.linusroxbergh.archipelago.archid.plist`, never loaded |
| TMPDIR | `$TH/tmp/` (ssh control sockets go to `$TH/tmp/archi-502/<hash>`) |
| Companion archive | `$G/companion/archipelago-companion-4697836-linux-x64.tar.gz` (46,184,473 B, sha256 `75f4c3efeda351c5…`); the gate's `…-32ee1745-…` is beside it |
| Remote | host `m3b` = `archi-m3b@100.117.42.24`, machine `51cf5316-f3d9-447c-8855-58a6521effd2`, uid/gid 1002, linger on, home `/Users/Shared/archi-m3b`. Release `4697836` (installed by `archi host upgrade`), with `32ee1745`, `9be818f5` and `ghostty-kit-24-g0b72b15a-dirty` still in `releases/` |
| Mac machine | `linuss-macbook-pro` (the test HOME's own id) `05b3af33-8eae-4be7-ae90-4f2d1318c398` |
| Fleet | `private`, id `d85abac7-4346-4b6a-8e86-d24a4053d294`, gateway `m3b` |
| Mac fleet home (`FH`) | `$TH/.archipelago`, daemon on `127.0.0.1:47871` (node.json is off 47800, which the owner's live daemon holds) |
| Linux fleet home | `/Users/Shared/archi-m3b/.archipelago`, `archipelago-archid@private.service` on `127.0.0.1:47800`, a read-only replica with sealed replicas of every root at generation 6, and a tmux server holding only `_keep`. `agent-profiles.archived-2026-09-26T193825Z` (the bundle m3b seeded before profiles travelled) and `home.archived-2026-09-26T151618Z` (40b) are safe to delete. `archipelago-gateway.service` holds the authority record |
| Path roots | none; both machines' registry records carry `home=/Users/Shared/archi-m3b` |
| Ownership | the Mac at generation 6; `archi handover status`: none open anywhere |

## Opening the test build's app (by-eye pass)

From a plain Terminal on the Mac, with the Mac test daemon running (it is; see "Left running"):

```sh
sh /private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/3739c9b8-51d0-4aa6-ac32-19bc0b56eee0/scratchpad/m3bg/open-test-app.sh
```

It runs the app's binary directly with:

- `CFFIXED_USER_HOME=/Users/Shared/archi-m3b`. `NSHomeDirectory()` follows only this variable, not `HOME`. The app
  therefore takes its fleet home, machine registry, preferences, window frame and WebKit data from the test HOME.
- `HOME=/Users/Shared/archi-m3b` for the bundled `archi connect` it starts.
- `TMPDIR=$TH/tmp/`.
- The Finder PATH.
- Every `ARCHI_*`, `TMUX*`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `ZDOTDIR` removed, so a shell inside the owner's
  Archipelago passes nothing of his fleet to it.

It opens as a second "Archipelago" beside the owner's own, which keeps running. Quit it with ⌘Q in its window.

The gate checked this on `32ee1745` (`$G/logs/60-app-open.log`) and the re-check again on `4697836` (`$G/logs/r/80-app-open.log`):

- the test app claimed `$TH/.archipelago/app.pid`;
- its helper ran with the test HOME, and its page connected to the test daemon on 47871;
- WebKit data went to `$TH/Library/WebKit`;
- the owner's app, his preferences plist and his WebKit stores were untouched.

Do not use instead:

- **`HOME=… open …` or `HOME=…` alone.** The app would open `~/.archipelago`, the owner's own fleet.
- **`archi` or `archi <profile>` from the test HOME.** Its launch path asks launchctl for the owner's own agent label,
  then runs `open -a Archipelago`, which LaunchServices may resolve to either app.
- **`open -a Archipelago` or `open -b io.github.linusroxbergh.archipelago` while the test app exists.** Both apps share
  the bundle id. Open the owner's own app by its path, `/Applications/Archipelago.app`.

Both apps share the bundle id, so macOS notifications from the test app show as "Archipelago".

## Wrappers (all `sh`; the Mac ones source `$G/env.sh`: unsets ARCHI_HOME/ARCHI_CHAR_ID/TMUX/TMUX_PANE, sets HOME, ARCHI_APP_DEST, TMPDIR and the Finder PATH `/usr/bin:/bin:/usr/sbin:/sbin`)

- `$G/a.sh <archi args>`: the bundled helper, stdin `/dev/null`.
- `$G/ho.sh <label> <handover args>`: runs `archi handover … --json` in the foreground and writes
  `logs/<label>.ndjson|.stderr`. `$G/ho-ts.sh` does the same and also writes `logs/<label>.times`, each stream line's
  arrival in seconds with its event, phase, character and notice (`bin/ts.pl`).
- `$G/watch-manifest.sh <label>` (background during a handover): copies the controller's and the Mac daemon's
  manifests, which Complete clears, into `evidence/<label>/`. Stop it with `touch evidence/<label>/stop`. Read them with
  `$BNODE $G/bin/pids.mjs <files>`.
- RPC wrappers (tokens are never printed):
  - `$G/api.sh <method> [json]`: one RPC to the Mac daemon;
  - `$G/rapi.sh <method> [json]`: the same on m3b, through `~/m3b-tools/api.mjs`;
  - `$G/chars.sh`: one line per character of the Mac state, with each slot's pid and revive.
- `$BNODE $G/bin/docs.mjs <fleetHome> create|read` finds the four gate docs as Resources rows (`resources.get`), then
  reads them with `fs.read` and prints beta-main's brief lines. m3b has a copy in `~/m3b-tools/`.
- `$BNODE $G/bin/sess.mjs <agentHome> <cwd> <sessionId>` prints a Claude session's files and records. m3b has a copy.
- `ssh archi-m3b@100.117.42.24 'sh -s' < <script>` runs these on m3b:
  - `$G/far-checks.sh`: ownership, characters, windows, agent argv, state pids against `/proc`, profiles, docs and log;
  - `$G/linux-fenced.sh` (`sh -s -- <charId>`): the Linux side after the fleet left it;
  - `$G/notes-wake.sh`: opens the dormant notes;
  - `$G/40r-lock-linux.sh`: the second-archid check, with fingerprints of `archid.log` and the unit log (`40-lock-linux.sh`
    is the gate's);
  - `~/m3b-tools/r-watch.sh <label> <charId>…` (run there): every 0.5 s, each character's window, the prompt its pane
    shows and its state, into `~/m3b-tools/<label>.watch`; `touch ~/m3b-tools/<label>.stop` ends it.
- On the Mac:
  - `$G/mac-fenced.sh`: the Mac after the fleet left it, then the same after a restart of its archid;
  - `$G/52-mac-after.sh <label>`: the Mac as owner;
  - `$G/41r-lock-mac.sh`: the second-archid check, with `archid.log` fingerprinted (`41-lock-mac.sh` is the gate's);
  - `$G/34-turns.sh mac|linux <suffix>`: turns for real-claude and both Codex characters, then their files;
  - `$G/r-turns.sh mac|linux <suffix> <charId>…`: a code-word turn for each real Claude named, then its files and state.
- `$G/mac-daemon-start.sh` starts the Mac daemon as its plist would (`env -i`, the plist's PATH, cwd `$TH`). Its pid
  goes to `$G/run/archid.pid` and its log to `$FH/archid.log`. `$G/mac-daemon-restart.sh` restarts it.
- `$G/st.sh` (Mac) and `$G/rst.sh` (m3b): a setup tmux of its own, not the fleet's, for answering Codex's trust screens.
- `$G/snap.sh mac|linux <label>` writes `$G/snaps/<label>-<side>.json`, and `$G/cmp.sh <from> <to>` runs `bin/compare.mjs`.
- Checks: `$G/09-token-grep.sh`, and `$G/linus-diff.sh [label]` (linus-vault's stable state against the 40b
  before-state).
- Do not write a redirection-only command such as `$UNSET 2>/dev/null` in zsh: it runs `cat` on stdin.
- **Making a character dormant with its session.** Close its window while archid is down (stop it, kill the window,
  wait for the agent to exit, then run `mac-daemon-start.sh`), as `$G/66-real-claude-rest.sh` does. The restarted
  archid then marks it dormant with its `revive`, but without launch flags, since no process is left to read them from.
  A `tmux kill-window` with archid up lets the agent's SessionEnd clear the session instead.

## Snapshots and comparison

- `bin/snap.mjs` and `bin/spec-{mac,linux}.json` cover one root, `home`, at the same path on both sides.
  - Folders: `src/alpha`, `src/beta`, `src/beta-wt1`, `src/beta-wt2`, `src/beta-unused`, `notes`, `real` (so
    `real/claude-r`, `real/claude-r/bypass`, `real/claude-t`, `real/flags`, `real/codex-*`), `.archipelago/home`,
    `.archipelago/agent-profiles` and
    `.archipelago/docs`.
  - Git checkouts: those five plus `src/alpha/.wt/feat`.
- `bin/compare.mjs` is 40b's. Its `rewrite` lines on the beta checkouts' `worktree list` are beta-unused's registration,
  which is not carried: they are equal once it is dropped.
- Snapshots:
  - the gate: `s4-before-mac`, `s4-after-linux`, `s5-before-linux`, `s5-after-mac`;
  - the re-check: `s6-before-mac` (its original), `s6-after-linux`, `s7-before-linux`, `s7-after-mac` (the current
    state).

  `s6-before-mac → s7-after-mac` is 1 DIFF: mission control's island at `y 13 → 14`, which m3b's owner start re-seated
  (`settleHome`).

## Fixture (Mac)

Islands: `m3b repos` `i_k46lzs` (file context ref `$TH/notes/f1.txt`, so its agents get `--add-dir $TH/notes`) and
`m3b dirs` `i_6crr3l`. The scribe is off, and `dormantAfterHours` is **0**. Ids are in `$G/run/chars.tsv`.

| name | id | cwd | notes |
| --- | --- | --- | --- |
| notes | `c_4jdink` | `$TH/notes` | carried dormant, woken on Linux, live again (session `a238f2dd-59c9-472e-a080-8935c84ab154`, 10 records) |
| alpha-main | `c_d4e995` | `$TH/src/alpha` | its second terminal runs the mocked claude (session `35bbee19-0e88-4881-a4a8-b02bf8885f16`) |
| alpha-feat | `c_2kp1rw` | `$TH/src/alpha/.wt/feat` | nested worktree; agent profile `m3b-role` (custom; travels with `agent-profiles/`) |
| beta-main | `c_dy5zy3` | `$TH/src/beta` | `node_modules/` default-excluded; holds the character doc |
| beta-wt1 | `c_9y8x8f` | `$TH/src/beta-wt1` | sibling worktree |
| beta-wt2 | `c_27vxwy` | `$TH/src/beta-wt2` | sibling worktree |
| real-codex | `c_ts2fmw` | `$TH/real/codex-x` | real Codex 0.156.1, session `01a0ddbd-67eb-7b41-8ec8-a30797ef4a8f`, 76 records (`… GATE-LINUX GATE-MAC`) |
| flags | `c_ku8ri5` | `$TH/real/flags` | mocked, resumes with `--effort high --dangerously-skip-permissions` |
| real-codex-p | `c_z2jbwx` | `$TH/real/codex-p` | real Codex, session `01a0de47-a05d-7b20-a108-5e27532bb402`, 76 records; runs `-m gpt-6-astra` without the Mac-only profile `t40` |
| real-claude | `c_ruypft` | `$TH/real/claude-r` | real Claude Code 2.1.283, session `cff60418-f7bb-44cf-85ce-f9bb153978cd` (code word OSPREY; 66 records: Mac, Linux, Mac). **Dormant** with `revive: claude --resume cff60418-…` |
| real-claude-t | `c_jmyxcs` | `$TH/real/claude-t` | real Claude, session `10542a51-6750-490a-89cc-3bee4522534d` (code word FALCON; 53 records: Mac, Linux, Mac). Its folder was untrusted on both machines until answered. **Dormant** with `revive: claude --resume 10542a51-…` |
| real-claude-b | `c_aosb44` | `$TH/real/claude-r/bypass` | real Claude started `claude --dangerously-skip-permissions`, session `b65e21cb-6b39-4b2e-9f64-727dc5b4ef3f` (code word LYNX; 53 records). **Dormant** with `revive: claude --resume b65e21cb-…`: the rest that closed its window dropped the flag |

No Claude login copy is left, so reviving any real-Claude character starts Claude logged out.

- Graph alpha: nested worktree `.wt/feat` (in `info/exclude`), committed link `link-to-f1`, a repo `.env`.
- Graph beta: sibling worktrees `beta-wt1` and `beta-wt2`.
  - **beta-unused** (`$TH/src/beta-unused`, branch `unused-br`) is a registered worktree no character uses. It is clean,
    and its change is the stash `beta-unused stash`, `stash@{0}` of beta.
  - It stays registered on the Mac (O6). m3b's copy of beta has no registration for it, but keeps `unused-br` and the
    stash.
- Each graph has uncommitted edits, a partly staged index, an untracked file and a stash.
- The links are `lrwxrwxrwx` since the first return (A2 defect 2).
- Entity docs (made with `docs.create`, keys in the text):

  | Tier | Doc | Key |
  | --- | --- | --- |
  | fleet | `$FH/docs/fleet/m3b-fleet.md` | FLEET-KESTREL |
  | island `i_k46lzs` | `$FH/docs/islands/i_k46lzs/m3b-island.md` | ISLAND-PLOVER |
  | character `c_dy5zy3` | `$FH/docs/characters/c_dy5zy3/m3b-character.md` | CHARACTER-WREN |
  | repo beta | `$FH/docs/repos/beta-d3942f1e/m3b-repo.md` | REPO-HERON |

- `$FH/agent-profiles` holds the six bundled profiles and `m3b-role.md`; m3b's copy is the same (sealed replica).

## Agents

- **Mocked Claude:**
  - `$TH/.m3b-mock/claude` on both machines is A2's `claude.mjs`, extensionless beside a `package.json` of
    `{"type":"module"}`, reporting 2.1.260. It posts its own pid with each hook.
  - `~/.local/bin/claude` dispatches on both machines. In `$TH/real/claude-r/` and `$TH/real/claude-t/` it runs the
    real Claude:
    `agents/real-claude/claude`, a link named `claude` to `agents/claude-2.1.283`, with `DISABLE_AUTOUPDATER=1`.
    Everywhere else it runs the mock, through the app's bundled node on the Mac and `current/node/bin/node` on m3b.
  - Both daemons' agent probes run outside those folders, so they see the mock.
  - The mock-only wrappers are kept as `$G/run/mac-claude-wrapper.mock` and m3b's `~/.m3b-mock/claude-wrapper.mock`.
- **Real Claude 2.1.283:**
  - Mac: `$TH/agents/claude-2.1.283`, a copy of the owner's `~/.local/share/claude/versions/2.1.283`.
  - m3b: `~/agents/claude-2.1.283` (from Task 41).
  - Both `.claude.json` files have `hasCompletedOnboarding` and trust `real/claude-r` and `real/claude-t`.
  - Both Claudes have accepted bypass mode (`skipDangerousModePermissionPrompt: true` in `~/.claude/settings.json`,
    beside Archipelago's hooks). m3b's was answered in the re-check, so a new bypass check needs that key removed there
    first.
  - m3b's pre-gate `.claude.json` is `~/.m3b-mock/claude.json.before-gate`.
  - **No Claude credential is left on either machine.** The re-check's copies of the owner's login were deleted at
    07:29:39Z on 2026-09-28, and no real Claude runs.
  - `$TH/Applications/Claude Code URL Handler.app` is one real Claude made under the test HOME.
- **Real Codex 0.156.1:**
  - Mac: `$TH/agents/codex`, with `$TH/.codex/auth.json` (0600) and `config.toml` trusting `real/codex-x`,
    `real/codex-p` and the 8 hooks. Profile `t40` is `$TH/.codex/t40.config.toml`.
  - m3b: `~/agents/codex`, with `~/.codex/auth.json` and the same trust. There is no `t40`.
- `$TH/.zprofile` and `.zshrc` keep `$TH/.local/bin` ahead of `/usr/local/bin`. The owner's real
  `/usr/local/bin/claude` never ran under the test HOME.

## Harness on m3b (not product)

- `~/.m3-no-node/` holds stubs for npm, npx, pnpm, corepack and tsx (exit 127), with the `.bashrc` line putting them
  first. The node stub is renamed `node.t40-disabled`, because Codex's hook runs `node` from PATH.
- `~/.m3b-mock/`, `~/.local/bin/{claude,codex}`, `~/agents/{codex,claude-2.1.283,real-claude/}`, and `~/m3b-tools/`
  (api, chars, snap, docs and sess tools, `r-watch.sh` and the re-check's `r31.watch`, the lock checks' before and after
  files, and the last `out.json`).
- Task 41's `~/probe/` is there too. It is not part of the fleet.

## Left running

- **Mac:**
  - archid, pid in `$G/run/archid.pid` (43149, on `releases/4697836`), log `$FH/archid.log`;
  - its tmux server `/opt/homebrew/bin/tmux -S $FH/tmux.sock` (49278) and control client (43170);
  - 11 windows: `_keep`, the 9 live characters and `c_d4e995-2`. The three real-Claude characters have none;
  - 8 mocked agents and 2 real Codex, all idle;
  - no test app, ssh master, helper, watcher or setup tmux; `caffeinate` is stopped.
- **m3b** (archi-m3b, lingering):
  - `archipelago-archid@private.service` (MainPID 295623) and `archipelago-gateway.service` (MainPID 295632), both on
    `4697836`, active and enabled;
  - the fleet's tmux server (`_keep` only).

## Before-state

- **linus-vault:** `$G/baseline/linus-before.txt` (full) and `linus-state-before.txt` (stable subset), taken at the
  start of 40b while archi-m3 still existed.
  - `tailscale serve status`: `https://linus-vault.prawn-turtle.ts.net (tailnet only)` / `|-- / proxy
    http://127.0.0.1:8787` (linus's `bun`).
  - `127.0.0.1:47800` was archi-m3's archid and is now archi-m3b's.
  - Re-take with `$G/linus-diff.sh <label>`. At the end of the re-check the differences are archi-m3 → archi-m3b in
    passwd and the linger directory, Ubuntu's snap loop-device targets, and one of linus's own listeners
    (`192.168.0.100:35459`) gone.
- **Mac:** `$G/baseline/mac-before.txt` and `mac-before-gate.txt`.
  - `~/.ssh/known_hosts` md5 `1f403c1326762e931fcf90aa00a04d27` (mtime Sep 14), unchanged.
  - `~/Library/LaunchAgents` mtime 2026-09-26 11:49:14 +0200, unchanged.
  - `/Applications/Archipelago.app` is the owner's own install. It now reads build `4067bfea`, mtime 2026-09-28
    08:27:52 +0200: a reinstall outside these passes, which install only into `$TH/Applications`.
  - The gate and the re-check read the owner's keychain item `Claude Code-credentials` as authorised (the re-check three
    times, two of them left unused for too little time), and `~/.archipelago/app.pid` once. Neither wrote anything of
    his.

## Teardown recipe (not run; the environment stays for the by-eye pass)

- **Mac:** `sh $G/teardown-mac.sh`. It kills archid, the tmux server, and any master or helper of `$TH`, then removes
  `/Users/Shared/archi-m3b`, which takes the app, the release, the Codex credential and the binary copies with it.
  `$G/src` (the re-check's build snapshot) goes with the scratchpad.
  - Quit a test app that is still open first.
  - Task 41's probe session in the owner's `~/.claude/projects/-Users-Shared-archi-m3b-probe-claude/` is outside the
    test HOME (see `task-41-probe-report.md`).
- **m3b:**
  1. `ssh archi-m3b@100.117.42.24 'sh -s' < $G/teardown-remote-user.sh`;
  2. `ssh 100.117.42.24 'sh -s' < $G/teardown-remote-root.sh`: disables linger, runs terminate-user and
     `deluser --remove-home`, runs `rm -r` on what deluser leaves and on `/tmp/claude-1002` (a real Claude ran there),
     then `rmdir /Users/Shared /Users`;
  3. `… < $G/check-remote-gone.sh`;
  4. `$G/linus-diff.sh final` against the before-state.
