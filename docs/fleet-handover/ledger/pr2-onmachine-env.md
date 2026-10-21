# PR #2 on-machine environment (for the owner's by-eye pass)

The Mac test HOME and the `svall-m4` account on linus-vault, both at `/Users/Shared/svall-m4`, both on `2ab80fda`:
svall PR #2 on Svall 0.12.0, branch `pr2-v3` (report `pr2-rebuild-012-report.md`). The round trip that built the fleet
ran at `a84bf57d` (report `pr2-onmachine-report.md`). The private fleet's generations: Mac → Linux was 1, Linux → Mac
2. **The Mac owns it at generation 2**, and no handover is open anywhere.

**Read "Opening the test build" before opening anything.** The test app shares the owner's launchd label, and is safe
to open only with their own Svall quit and its job unloaded.

`S` below is the kit, `$TH/kit` = `/Users/Shared/svall-m4/kit` (0700): scripts in `$S/` and `$S/bin/`, logs in
`$S/logs/`, snapshots in `$S/snaps/`, the daemon's pid in `$S/run/`, builds in `$S/build/`, `$S/rel/` and
`$S/app.noindex/`. It is inside the test HOME, so it survives a reboot and goes with `teardown-mac.sh`.

## Where things are

| | |
| --- | --- |
| Builds | `2ab80fda`, unsigned, by `$S/r2-build.sh` from a `git archive` snapshot in `$S/build/<id>/src`. Release archives (`release-build.sh`, scanned) in `$S/rel/<id>/`; the app (`SVALL_RELEASE_NAME=<id> pnpm app:build`) in `$S/app.noindex/<id>/Svall.app`; summary `$S/build/<id>/summary.txt`. `$S/app.noindex/a84bf57d/Svall.app` is the round trip's app, kept for a rollback |
| Test HOME (`TH`) | `/Users/Shared/svall-m4` on the Mac (0700), the same path as `svall-m4`'s home on linus-vault |
| App | `$TH/Applications/Svall.app`, build `2ab80fda` (0.12.0, CFBundleVersion 724; protocol 23, state schema 9). Not registered with LaunchServices. Opening it registers it again, and so does macOS by itself now and then (the installed copy, and `Claude Code URL Handler.app` beside it); `close-test-app.sh` and `r3-mac.sh` unregister both, and `lsregister -dump \| grep svall-m4` shows whether they are |
| CLI | `$TH/.local/bin/svall`, the shim setup wrote; it runs the app's `Contents/Resources/runtime/svall.mjs`. The controller release (host and handover) is `Contents/Resources/release`, with the x64 companion in its `companions/` |
| Mac fleet home (`FH`) | `$TH/.svall` (private fleet `fa4f67ae-9e75-4965-845d-186e82d61c5e`, `handover.enabled`), daemon on 127.0.0.1:47871 (`node.json`; the owner's daemon holds 47800) |
| Plist | `$TH/Library/LaunchAgents/io.github.linusroxbergh.svall.svalld.plist`, never loaded (`setup --no-launchctl`) |
| TMPDIR | `$TH/tmp/` (ssh control sockets under it) |
| ssh | `svall-m4` accepts only `$TH/.ssh/id_ed25519`, which the test HOME's own ssh-agent at `$TH/tmp/agent.sock` holds (`$S/agent-start.sh` starts it; wrappers set `SSH_AUTH_SOCK` to it). ssh still reads the owner's `~/.ssh/config` and `known_hosts`, which already held linus-vault's host key, so nothing is written there |
| Mac machine | `linuss-macbook-pro`, `bfa140ac-7b77-4db8-a093-81244f9a7d74` (the test HOME's own id, `$TH/.config/svall/machine.json`) |
| Remote | host `m4` = `svall-m4@100.117.42.24`, machine `9856b4ae-31c8-4a3f-867a-8c5cc9c5b297`, uid/gid 2001, linger on. `current` → `2ab80fda`, `a84bf57d` kept (an upgrade keeps the release before it and drops older ones). Units `svall-svalld@private.service` (on a free port: linus-vault's 47800 is taken) and `svall-gateway.service`; the gateway's record is at generation 2, naming the Mac |
| Linux fleet home | `/Users/Shared/svall-m4/.svall`: a fenced read-only copy at generation 2 with a replica of every carried folder, no tmux server and no agent |

## Opening the test build (decide first)

The test fleet is the test HOME's **private** fleet. The app's daemon control goes by launchd label, and the label
(`io.github.linusroxbergh.svall.svalld`) is per user, not per HOME, so it is the owner's own:

- **Opening the window** runs `launchctl kickstart gui/501/<label>` (`FleetDaemon.start`, `FleetDaemon.swift:22`). That
  starts whichever job holds the label.
- **A launch-time setup refresh** (`setup --if-needed --login-shell`, `AppDelegate.swift:83`) that finds the plist out
  of date runs `launchctl bootout gui/501 <test plist>` and then `bootstrap` (`launchd.ts:107`). That unloads the
  owner's job and loads the test one under its label.
- **A quit** while the fleet is on m4, or with the page down, runs `launchctl kill SIGTERM gui/501/<label>`, killing the
  owner's daemon.
- **Moving the test plist aside** stops all three, but the app then opens on its setup screen only, and Set up does the
  same as the refresh.

So pick one of these:

**(a) With your own Svall stopped for the duration.**
1. Quit your Svall. Every robot of your fleet goes to sleep until you open it again.
2. `launchctl bootout gui/$(id -u)/io.github.linusroxbergh.svall.svalld`.
3. `sh $S/open-test-app.sh`. It refuses while your Svall is open or your job is loaded, starts the test daemon (with
   the test ssh-agent) if it is down, then runs the app binary with `CFFIXED_USER_HOME=$TH` (which `NSHomeDirectory()`
   follows), `HOME=$TH`, `TMPDIR=$TH/tmp/`, the Finder PATH and `SSH_AUTH_SOCK=$TH/tmp/agent.sock`, and nothing else
   of your environment. Its output goes to `$S/logs/app/app.out`.
4. When done, quit it (⌘Q), then `sh $S/close-test-app.sh`. It boots the test job out of the label (only when that
   job's plist is in `$TH`), and unregisters the test HOME's apps from LaunchServices.
5. `open /Applications/Svall.app`. Your app loads its own job again.

The test app's own launchd start of the test plist gets launchd's environment, which lacks the test ssh-agent. Its
daemon could not reach m4. `open-test-app.sh` starts the daemon first, so launchd's second copy exits on the daemon
lock. If you quit the test app with the fleet on the Mac (which stops the test daemon), open it again with the script,
never by itself.

Not run by me: it would have stopped the fleet this run worked in.

**(b) With a named test fleet.** I make a second fleet in the test HOME, such as `m4` (`$TH/.svall-m4`, label
`io.github.linusroxbergh.svall.svalld.m4`), give m4 its copy with `host enable m4 --fleet m4`, build the same fixture
and hand it over once. Its launchd calls never reach your job, and your Svall keeps running. About an hour, plus a
credential window for its agents' first turns.

Never open the test build with `HOME=… open …`, `open -a Svall`, `open -b io.github.linusroxbergh.svall` or a bare
`svall` from the test HOME. The first opens your fleet; the others may resolve to either app, and
`$TH/Applications/Svall.app` (CFBundleVersion 724) is a newer build than yours (721).

### What to look at (SMOKE.md against this environment)

Agents: the test homes hold no login. Before SMOKE §2–§4, log Claude, Codex and OpenCode in on both test accounts
yourself, or approve another credential copy. The three real-agent characters are dormant with their sessions:
choose each to revive it, or `sh $S/sv.sh char revive <id>`. Claude, on its first start in a folder on a machine,
stops at "Trust this folder?" with "No, exit" preselected.

- **§1 Provisioning.** m4 is already added and is the gateway. Run **Check**, then **Add machine** again with the same
  name and destination (`svall-m4@100.117.42.24`): every step runs again (it also reinstalls the release and restarts
  both units, D2).
- **§2 The fleet** is built (below). It has three islands besides mission control, the two repositories with their
  worktrees and changes, the shell with a second terminal and browser tabs, and a file in a context.
- **§3–§4 Handover → m4 and → This Mac.**
  - `dev`'s terminal stops each one at Checks with `repository_unused` until **Carry the folder whole**.
  - Watch claude-r after its trust prompt on m4. D1: its prompt line takes typing, but anything sent through Svall
    (`char run`, the phone) stays queued until it restarts.
- **§5 Blockers.**
  - Foreground: `sh $S/sv.sh char run c_jal5kh 'sleep 600'`.
  - Working agent: give claude-r a long task.
  - OpenCode MCP: add an `mcp` entry in `$TH/src/beta/opencode.json`.
  - Pinned: `sh $S/sv.sh char update c_txynl7 --keep-here`.
- **§6 A changed copy.** `ssh svall-m4@100.117.42.24` won't reach it from your own shell (the account takes only the
  test key). Use `SSH_AUTH_SOCK=$TH/tmp/agent.sock ssh svall-m4@100.117.42.24 'echo EYE >> ~/src/beta/lib.txt'` with
  the fleet on the Mac, then Handover → m4.
- **§7, §9 Network.** Disconnecting Tailscale on the Mac cuts every link to linus-vault, yours included.
- **§8 Controller killed.** The helper's pid is in `sh $S/sv.sh handover status`. With the fleet on m4, the test app's
  quit runs `launchctl kill` on the label, which (a) leaves harmless only while your job is booted out.
- **§10 Clean up.** Skip SMOKE's commands (they name a `smoke` fleet in your own home); use the teardown below.

## Wrappers (all `sh`; the Mac ones source `$S/env.sh`, whose `tenv` runs a command with `env -i`: `HOME=$TH`, `TMPDIR`, `SVALL_APP_DEST=$TH/Applications`, `SSH_AUTH_SOCK=$TH/tmp/agent.sock`, PATH `$TH/.local/bin:$TH/.opencode/bin:/usr/bin:/bin:/usr/sbin:/sbin`)

- `$S/sv.sh <svall args>`: the test HOME's `svall`, stdin `/dev/null`. `$S/api.sh <method> [json]`: one RPC to the Mac
  daemon (`bin/api.mjs`; tokens never printed). m4 has `~/m4-tools/api.mjs`.
- `$S/mac-daemon-start.sh` / `mac-daemon-stop.sh`: the Mac daemon as its plist would start it, pid in
  `$S/run/svalld.pid`, log `$FH/svalld.log`. `$S/agent-start.sh` starts the test ssh-agent if it is down.
- `$S/ho.sh <label> <handover args>`: `svall handover … --json` into `logs/<label>.ndjson` (each line with its arrival
  in ms) and `logs/<label>.summary.txt`.
- `$S/state.sh mac|linux`: one line per character (window, agent, session, pid and argv, `revive`, tabs), the
  ownership, `handover/` and `controller/`, the tmux windows, and on linux the agent processes.
- `$S/scr.sh mac|linux <charId> [lines]`: a character's first pane. `$S/tk.sh mac|linux <charId> <send-keys args>`: raw
  keys into it, for agent prompts.
- `$S/turn.sh <charId> <text>`: `char run`, `char wait`, the screen and the agent fields.
- `$S/snap.sh mac|linux <label>` writes `snaps/<label>-<side>.json` (`bin/snap.mjs`), and `$S/cmp.sh <a> <b>` runs
  `bin/compare.mjs` into `logs/cmp-<a>--<b>.txt`.
- `$S/12-upgrade.sh <label> [host upgrade args]` with `$S/units-far.sh` (each unit's pid and release, `current`, kept
  releases, the fleet daemon's release and ownership, its tmux server, and the gateway's record).
- **A rebuild at a new commit**, one run: `sh $S/rebuild.sh <commit>`. Each step logs to `logs/<id>-<n>-<step>.log`, and
  the run stops at the first that fails:
  - `r1-health.sh <label>` (read-only): `system.info`, `ownership.get`, how many test HOME apps LaunchServices
    holds, `state.sh mac`, `units-far.sh`, and `snap.sh` on both sides.
  - `r2-build.sh <commit>`: the build above. It refuses when `build/<id>` exists.
  - `r3-mac.sh <id>`: stops the daemon and keeps the installed app in `app.noindex/<its release>/` unless a copy is
    there. Then `11-install.sh <id>` and `mac-daemon-start.sh`, and it unregisters the test HOME's apps.
  - `r4-m4.sh <id>`: `12-upgrade.sh` (`host upgrade m4 --json`), `host doctor m4`, and a check of m4's `current`.
  - Last, `cmp.sh` of the Mac before/after the Mac step and the end, and of linux before/end.
- **A rollback to `a84bf57d`** (not run): `sh $S/r3-mac.sh a84bf57d`, then `sh $S/12-upgrade.sh rb --rollback
  a84bf57d --json`.
- `$S/60-creds-copy.sh` / `69-creds-delete.sh`: the credential copy and its removal, as the brief allows. The copy
  refuses with under 90 minutes on Claude's token. Neither prints a value; `bin/oc-cred.mjs` moves OpenCode's `openai`
  row. The copy reads the owner's OpenCode database from `$HOME_OWNER_OC`, which `env.sh` does not set.
- Build-once scripts, not rerun: `10-repos.sh`, `20-fleet.sh`, `21-extras.sh`, `mac-agents.sh`, `remote-agents.sh` and
  `create-user.sh`. `21-extras.sh` and `create-user.sh` hold their heredocs' unexpanded text (`$TH`, `$IR`, `$CB`,
  `$CSH`, `'$PUB'`; `21-extras.sh`'s `api()` passes a literal `$@`), so neither runs as is.
- `$S/66-rest-agents.sh`: lays the three real agents dormant with their sessions, by closing their windows while the
  Mac daemon is down. It reads their ids from `$S/run/agents.sh`, which the kit no longer holds.
- `$S/rst.sh <tmux args>`: a private setup tmux on m4 (socket `m4setup`), not the fleet's.
- `$S/linus-diff.sh <label>`: linus-vault's stable state against `$S/baseline/linus-before.txt`, as the default ssh
  user. The kit holds no `baseline/`, so it has nothing to compare against; "Before-state" below says what it held.
- `$S/open-test-app.sh`, `$S/close-test-app.sh`: above.

## Snapshots

`bin/snap.mjs` covers the carried folders:
- `src/alpha`, `src/beta`, `src/beta-wt1`, `src/beta-unused`, `dev`, `work` and `notes`, plus `.svall/home`,
  `.svall/docs` and `.svall/agent-profiles`. Every file is hashed, with its mode and link target; `.git` directories
  are left out.
- Git fields for the 7 checkouts.
- The state (islands and characters, without tmux ids and timestamps), `fleet.json` and `owner.json`.
- The roots: each replica record under `.svall/replicas/`, with its baseline hashed.
- The terminals: the fleet tmux server's windows, each with its folder and command.
- The Claude transcripts, Codex rollouts and Svall's OpenCode logs and exports.

Files are in `$S/snaps/`, named `2ab80fda-<label>-<side>`: `before` (on `a84bf57d`), `mac` (the Mac on `2ab80fda`,
m4 still on `a84bf57d`), `after` (both on `2ab80fda`) and `final` (as left), each for `mac` and `linux`. Every
compare against `before` is 0 DIFF.

## Fixture (Mac)

Islands: `m4 repos` `i_dk0tvc` (file context `$TH/notes/f1.txt`), `m4 agents` `i_5739iq`, `m4 shells` `i_5bw6rt`. The
scribe is off.

| name | id | cwd | notes |
| --- | --- | --- | --- |
| alpha-feat | `c_puc0a2` | `$TH/src/alpha/.wt/feat` | shell in the nested worktree |
| beta-main | `c_oplsf1` | `$TH/src/beta` | shell; holds the character doc |
| shell | `c_jal5kh` | `$TH/work/shell` | shell with a second terminal; tabs `file://$TH/work/shell/page.html` and `https://example.com/m4?tab=2` (active) |
| dev | `c_0vh9kf` | `$TH/dev` | shell in a folder holding the repos `gamma` and `delta` no character works in: `repository_unused` |
| notes | `c_txynl7` | `$TH/notes` | shell with the file context `work/shell/page.html` |
| claude-r | `c_19dqxb` | `$TH/src/alpha` | Claude Code 2.1.296, session `2d38c2d0-a6ab-4128-a21e-5193af95ae31` (code word OSPREY, 62 records). **Dormant**, `revive: claude --resume 2d38c2d0-…` |
| codex-r | `c_4ec0eg` | `$TH/src/beta-wt1` | Codex 0.162.1, session `01a13415-24aa-70f0-a209-4726f9dc73dd` (MANGO, 46 records). **Dormant**, `revive: codex resume -c tui.resume_cwd=session 01a13415-…` |
| opencode-r | `c_z4a88x` | `$TH/src/beta` | OpenCode 2.0.27, session `ses_ecbe1aa12ffeY1NGovvpfW40DK` (LYNX, model "Cat Jam Free"). **Dormant**, `revive: opencode -s ses_ecbe1aa1…` |

- **Repo alpha.** It has a nested worktree `.wt/feat` (branch `feat`, in `info/exclude`), a committed link
  `link-to-f1`, and a repo `.env`. `main` and `feat` each hold a partly staged index, unstaged edits and an untracked
  file; the stash `alpha stash` is shared.
- **Repo beta.** It has a sibling worktree `beta-wt1` (branch `wt1`) and `node_modules/` (excluded).
  - `beta-unused` (branch `unused-br`) is a registered worktree no character uses. It is clean, stays registered on
    the Mac, and is not carried.
  - The stashes are `beta stash` and `beta-wt1 stash`. beta and `beta-wt1` each hold staged, unstaged and untracked
    changes.
- **Entity docs** (keys in the text):

  | Tier | Doc | Key |
  | --- | --- | --- |
  | fleet | `$FH/docs/fleet/m4-fleet.md` | M4-FLEET-KESTREL |
  | island `i_dk0tvc` | `$FH/docs/islands/i_dk0tvc/m4-island.md` | M4-ISLAND-PLOVER |
  | character `c_oplsf1` | `$FH/docs/characters/c_oplsf1/m4-character.md` | M4-CHARACTER-WREN |
  | repo beta | `$FH/docs/repos/beta-5bb23911/m4-repo.md` | M4-REPO-HERON |

- **Leftovers.** Claude's first, turn-less session `723af8ce-…` sits on the Mac only. m4 keeps the Codex setup
  rollout `01a1341f-…`.

## Agents

- **Mac.**
  - Claude 2.1.296: `$TH/.local/share/claude/versions/2.1.296` (a copy of the owner's), linked from
    `$TH/.local/bin/claude`.
  - Codex 0.162.1: the GitHub release's darwin binary at `$TH/.local/bin/codex`.
  - OpenCode 2.0.27: `opencode.ai/files/bin/2.0.27/opencode-darwin-arm64.zip`, sha256 checked, at
    `$TH/.opencode/bin/opencode`, with a link in `$TH/.local/bin`.
  - `$TH/.zprofile` and `.zshrc` put both folders first and set `DISABLE_AUTOUPDATER=1`. `$TH/.claude.json` has
    `hasCompletedOnboarding`, and its folders are trusted (`src/alpha`); Codex trusts `src/beta` and its hooks.
- **m4.**
  - Claude 2.1.296 from the native installer.
  - Codex 0.162.1 as the packaged build in `~/.codex/packages/standalone/0.162.1` (the bare binary will not start
    without `--no-daemon`), linked from `~/.local/bin/codex`.
  - OpenCode 2.0.27 in `~/.opencode/bin`.
  - `~/.bashrc` sets `DISABLE_AUTOUPDATER=1` and the PATH. Claude and Codex trust `src/alpha` and `src/beta`, and
    Codex trusts its hooks. `~/m4-tools/` holds `api.mjs`, `oc-cred.mjs` and `codex-setup/`.
- **No login is left on either machine.** The copies of the owner's logins were made at 07:05:18Z and deleted at
  07:24:53Z. `host doctor` and `system.info` still read OpenCode as signed in, with no `openai` row in either home. Running Codex by hand on m4 starts its own `app-server` daemon; stop it afterwards (`pkill -u svall-m4 -f
  "codex app-server"`).

## Left running

- **Mac:**
  - svalld from `$S/run/svalld.pid` (1514), on `2ab80fda`;
  - tmux server 21066 (tmux 3.7c, as both builds carry) with control client 1558, running 7 windows: `_keep`, the 5
    shells and shell's second terminal;
  - the test ssh-agent 41834;
  - no app, ssh master, helper or agent of the test HOME.
- **m4** (`svall-m4`, lingering): `svall-svalld@private.service` (2339700, "starting read-only": the Mac owns the fleet
  at generation 2) and `svall-gateway.service` (2339711), both on `2ab80fda`; no tmux server.

## Before-state

- **linus-vault:** the before-state was taken as the default ssh user before `svall-m4` existed, into
  `$S/baseline/linus-before.txt`; the kit holds no copy. It held passwd, groups, linger, loginctl, `/Users`,
  listeners, `tailscale serve status` (`/ proxy http://127.0.0.1:8787`), linus's user units and home listing, and
  `archi-m3b`'s processes. Against it, linus-vault differed only by `svall-m4`, its listener and `/tmp/claude-2001`.
- **`archi-m3b`** was on linus-vault, lingering, with `archipelago-archid@private` and `archipelago-gateway` running
  `d0602dc` and its home at `/Users/Shared/archi-m3b`. Left alone, and not looked at from `svall-m4`.
- **Mac** (the owner's, which the environment never writes):
  - `~/.ssh/known_hosts` md5 `1f403c1326762e931fcf90aa00a04d27` (Sep 14, 7,796 B);
  - `~/Library/LaunchAgents` (Oct 11);
  - `/Applications/Svall.app` 0.12.0, build 721 (Oct 17), and its svalld pid 27628 since Oct 17.

## Teardown (not run; the environment stays for the by-eye pass)

m4 first: its scripts and the test key are in `$TH`, which the Mac step removes.

1. **m4:**
   1. `SSH_AUTH_SOCK=$TH/tmp/agent.sock ssh svall-m4@100.117.42.24 'sh -s' < $S/teardown-remote-user.sh`: it stops
      the units and every process of the account.
   2. `ssh 100.117.42.24 'sh -s' < $S/teardown-remote-root.sh`, as the default user, with sudo only for `svall-m4`.
      - It disables the linger and ends the account's processes.
      - It runs `userdel -r` and removes `/Users/Shared/svall-m4`, `/tmp/claude-2001` and the linger file.
      - `/Users/Shared` and `/Users` stay, since `archi-m3b`'s home is there.
   3. `ssh 100.117.42.24 'sh -s' < $S/check-remote-gone.sh`.
   4. linus-vault against the before-state: `ssh 100.117.42.24 'sh -s' < $S/linus-state.sh`, read by hand, as there
      is no `baseline/` for `linus-diff.sh`.
2. **Mac, last:** quit any test app, then `sh $S/teardown-mac.sh`.
   - It stops the test daemon, its tmux server and ssh-agent, boots any test job out of the label, and unregisters
     the test HOME's apps.
   - It then removes `/Users/Shared/svall-m4`, which takes the apps, agents, keys, fleet and the kit with it.
