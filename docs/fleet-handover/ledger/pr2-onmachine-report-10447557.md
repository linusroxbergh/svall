# PR #2 on-machine run at `10447557`: report

Status: **DONE_WITH_CONCERNS**.

svall PR #2 (`origin/worktree-port-pr-1` at `10447557`) ran between this Mac's test HOME and the `svall-m4` account on
linus-vault, both at `/Users/Shared/svall-m4`. It ran through the CLI only, unattended. The kit is `S` =
`/Users/Shared/svall-m4/kit`, with logs in `$S/logs/` (this run's are named `x-*` and `10447557-*`) and this run's
scripts in `$S/x/`.

- **Build and install.** Release `10447557`: app 0.13.0 (CFBundleVersion 976), protocol 24, stateSchema 9,
  transferSchema 1, authoritySchema 2. The Mac was installed on it, and `host upgrade m4` came back `ready` in 16 s.
  `host doctor m4` reported ready for handover with 6 warnings.
- **Round trip.** Mac → Linux completed at g5 in 14.1 s, and Linux → Mac at g6 in 13.0 s. Each agent answered on the
  Mac, then on Linux, then on the Mac again, under the same session id, and no character had a `resumeError`.
- **SMOKE by CLI.** These all passed:
  - §5: `shell_busy`, `character_pinned`, and an interrupted agent;
  - §6: divergence with archive;
  - §7: link cut before and after the commit;
  - §8: helper killed before and after the commit;
  - §9: ssh drop.
- **New in this head.** All exercised:
  - `--check` froze nothing.
  - `handover on` worked and `off` was refused.
  - `fleet recover --force-owner local` wrote nothing.
  - `handover status` after each kill named the right way on.
- **New defects:** three that block a handover for no reason (B1–B3) and five minor ones (M1–M5).
- **Not exercised:**
  - Tailscale itself was not disconnected, because that would cut the owner's own links. The link cut was emulated
    for the test HOME only (§4).
  - Nothing that needs the app was run: the sheet, the banner, re-attach in the app, and Cmd-Q.

Rules kept:
- No product change, nothing pushed, and PR #2 untouched.
- The owner's app, daemon, launchd job, `~/.svall`, `~/.ssh` and `/Applications` were not touched. Their svalld still
  runs (pid 2114) from their own plist.
- `~/.ssh/known_hosts` is unchanged: md5 `1f403c13…`, Sep 14, 7,796 B.
- No sudo was used, and no `tailscale` command was run.
- The logins were copied with `60-creds-copy.sh` at 08:35:42Z and deleted with `69-creds-delete.sh` at 09:03:45Z.
  Afterwards 0 files and 0 OpenCode rows remain on either machine.
- `release-scan.mjs --secrets-only` passes over the run's 75 log files.
- One exception: a 6-second `svall connect`, run to watch its master sweep, printed the test daemon's local
  connection token to this agent's console. That token is in no kit file (0 hits).

| Step | Result |
| --- | --- |
| 1. `rebuild.sh 10447557` | PASS: release `10447557`, 3 archives scanned `ok`, app 976; compare 0 DIFF before/after on both sides |
| 2. `host upgrade m4`, `host doctor m4` | PASS: `ready` in 16 s; doctor has no ✗, 6 warnings |
| 3. Round trip, real agents | PASS: g5 14.1 s, g6 13.0 s; 3/3 turns on Mac, Linux, Mac; no `resumeError` |
| 4a. `shell_busy` → `--terminate-shells` | PASS: blocked with nothing moved, then complete g7, restart notice on m4 |
| 4b. Divergence → `--archive` | PASS for the edited file; **B1**: two more roots blocked for `.git/index` only |
| 4c. Link cut mid-transfer → Resume | PASS: `interrupted`, safe `[resume, abort]`, 83 s after the cut; resume g9 9.9 s |
| 4c'. Link cut after the commit → Retry | PASS: `interrupted`, safe `[resume]`, 83 s after the cut; resume g11 1.8 s |
| 4d. Helper killed mid-transfer | PASS: status says Resume or Abort; resume g8 9.2 s; **M1** |
| 4d'. Helper killed in activate | PASS: status says only `--resume`; resume g10 1.8 s |
| 4e. ssh drop with the fleet on m4 | PASS (CLI): same agent and shell pids, scrollback kept, status answers 1 s after |
| 4f. Agent at work → `--interrupt-after` | PASS after `--terminate-shells`; the first run stopped `agent_unsettled` (as documented) |
| 4g. `--keep-here` | PASS: `character_pinned` "notes is kept on this machine" |
| 5. `--check`, `on`/`off`, `recover`, `status` | PASS; **B3** found by `--check`; **M2**, **M3** wording |
| 6. Repeat at the merged head | Waiting: the orchestrator says it lands after 10:30Z |
| 7. Teardown | Done: logins deleted, agents dormant, the Mac owns at g12, test account kept |

## 1. Build and installs (`logs/rebuild-10447557.out`, `logs/10447557-*`)

- **Snapshot.** Taken at 08:29:22Z. `build/10447557/summary.txt`: CFBundleShortVersionString 0.13.0, CFBundleVersion
  976, `codesign -v` ok. `release.json` reads `10447557` darwin-arm64, protocol 24, stateSchema 9, transferSchema 1,
  authoritySchema 2, node v24.21.0, unsigned. The app's x64 companion and release-build's differ by nothing once
  unpacked.
- **Mac.** `r3-mac.sh` ran at 08:32:02Z: 4c11f026 (731) was replaced by 10447557. Setup listed claude and codex as not
  signed in, as expected before the copy. The daemon came up as `10447557 protocol 24 stateSchema 9`, with ownership
  g4 on the Mac.
- **m4.** `host upgrade m4 --json` exited 0 in 16 s with the steps machine, master, release (the app's unsigned
  companion), upload, install, and probe "m4 answers on release 10447557".
  - Both units now run `10447557`: svalld 1222852 and gateway 1222862. `current` points at `10447557`, and
    `4c11f026` is kept.
  - The gateway record stayed at g4, naming the Mac, across the authoritySchema 1 → 2 upgrade.
- **Doctor warnings.** `host doctor m4` ended "ready for handover; 6 warnings". Before the login copy these were:
  - ! tmux 3.4;
  - ! claude not signed in;
  - ! codex not signed in;
  - ! path;
  - ! gh;
  - ! codex sandbox (AppArmor/bwrap).
- **Doctor checks.** "✓ opencode v2.0.27, signed in" (see B3), and the new "✓ machine id … was made on this
  machine".
- **Compares.** Before → mac, before → after, and linux before → after are each 0 DIFF.
- **Housekeeping.** After the reboot of Oct 21, LaunchServices had registered 9 test-HOME apps, including those under
  `kit/app.noindex` and `kit/build`. All 9 were unregistered, and 0 are registered now. `r3-mac.sh` only
  unregisters the installed copy.

## 2. Round trip with real agents (step 3)

Claude Code 2.1.296 was claude-r, Codex 0.162.1 was codex-r, and OpenCode 2.0.27 was opencode-r (on GPT-5.6 Luna,
OpenAI). They were revived from dormant on the Mac at 08:36Z. Each turn went through the Mac's `svall char run`
(`turn.sh`). Logs are `logs/x-turn-*`.

| Where (UTC) | claude-r | codex-r | opencode-r |
| --- | --- | --- | --- |
| Mac 08:36:44 | `OSPREY R10-MAC1` | `MANGO R10-MAC1` | `LYNX R10-MAC1` |
| Linux 08:38:17 | `OSPREY R10-LINUX` | `MANGO R10-LINUX` | `LYNX R10-LINUX` |
| Mac 08:39:10 | `OSPREY R10-MAC2` | `MANGO R10-MAC2` | `LYNX R10-MAC2` |
| Mac 09:02 (end) | `OSPREY R10-MAC-END` | `MANGO R10-MAC-END` | `LYNX R10-MAC-END` |

- **Session ids.** These were the same throughout: `2d38c2d0-…`, `01a13415-…` and `ses_ecbe1aa1…`. No resume hit a
  trust prompt, since the folders were trusted from earlier runs.
- **`--check --carry-unused`** (`x-check-2`) came back `ready`, with 10 roots, 267 files, 986,538 B and 3 sessions.
  Its warnings were `codex_sandbox`, `env_file`, `symlink_dangling` and `worktree_unused`.
  - The roots include `~/.local/share/opencode/worktree/752593/react-boilerplate`. That is a beta worktree OpenCode
    made during the owner's by-eye pass, and its process cwd is there. It was carried and resumed on both sides.
- **Mac → Linux** (`x-m2l`, 08:37:33Z): complete at **g5** (`647f3442-…`) in **14.1 s**.
  - Phases: begin +3.3 s, freeze +3.3, transfer +5.7, verify +9.1, prepare +9.1, ready +11.1, commit +11.4,
    activate +11.6, complete +13.1.
  - m4 then ran `claude --resume 2d38c2d0-…`, `codex resume --no-daemon … 01a13415-…` and `opencode --standalone -s
    ses_ecbe1aa1…`, with no `resumeError`. The Mac ran no agent.
- **Linux → Mac** (`x-l2m`, 08:38:47Z): complete at **g6** (`69db0ab7-…`) in **13.0 s**.
  - Its warnings were `env_file` and `symlink_dangling`.
  - Afterwards m4 had no tmux server and no agent.
- **Controller events files:** `logs/x-m2l.controller-events.ndjson` (72 lines) and `x-l2m.controller-events.ndjson`.
- **Compare** across the round trip (`cmp-x-r1-before-mac--x-r1-after-mac`, 53 DIFF). The differences are only:
  - `owner.json`;
  - the replica records (`roots.*` seal fields);
  - `restedBy`;
  - each agent's `lastPrompt`;
  - the session files growing.

  Git fields, files, docs, tabs and characters are all equal.
- **Codex's pid.** After every resume, Codex's pid reads `null` in `char list` until its first turn, while the process
  runs (M5).

## 3. SMOKE sections by CLI (step 4)

### Blockers and divergence (§5.1–5.2, §6)

- **Setup.** The shell `c_jal5kh` was revived and given `sleep 600`. Then `echo R10-EYE >> ~/src/beta/lib.txt` ran
  on m4.
- **`x-block-1`.** `blocked` at begin in 2.8 s. Ownership stayed g6 on the Mac, not frozen, and `sleep 600` kept
  running. The blockers:
  - `shell_busy`: "shell's terminal is running sleep 600"
  - `destination_diverged`: "/Users/Shared/svall-m4/src/beta changed while this machine did not own the fleet: 3
    changed (.git/index, .git/worktrees/beta-wt1/index, lib.txt). Recover the changes by hand, or archive it to
    continue"
  - `destination_diverged` for `src/alpha` and `dev`, for `.git/index` only. This is **B1**.
- **`x-block-1b`.** With the index modes put back to 644, only `lib.txt` and `shell_busy` remain.
- **`x-block-2`** (`--terminate-shells --archive r_5bb23911cdcbb288`): complete at **g7** in 13.6 s.
  - Every progress line of that root carries `archivedTo: /Users/Shared/svall-m4/src/beta.archived-2026-10-22T084115Z`.
  - That copy holds `lib.txt` with `R10-EYE`. The new `src/beta/lib.txt` is the Mac's.
  - The shell on m4 printed "Svall restarted this shell after a handover; whatever ran here before did not move.",
    and no `sleep 600` was left on the Mac.
  - The archived copy was deleted afterwards.

### Helper killed (§8.2–8.3)

- **Mid-transfer** (`x-kill-detach2`, Linux → Mac): `handover local --carry-unused --detach`, then `kill -9` of the
  helper (pid 91585) as `"phase":"transfer"` reached `controller/events.ndjson`. `handover status` then printed:

  ```
  Handover a65ce1d7-ab5f-4068-b6fe-832f84f683e9 open, at transfer: a65ce1d7-ab5f-4068-b6fe-832f84f683e9 is preparing and has not committed; it can go on, or be aborted back to 9856b4ae-31c8-4a3f-867a-8c5cc9c5b297.
    from m4 to linuss-macbook-pro, generation 7
    source journal: freeze; destination journal: none
  Safe: `svall handover --resume` or `svall handover --abort`.
  ```

  `--resume` completed at **g8** in 9.2 s, with 4/4 characters `ok`. The helper's `ssh -M` (pid 91629, PPID 1)
  outlived it (M1).
- **In activate** (`x-kill2`, Linux → Mac): status printed:

  ```
  Handover 443926cb-6546-4882-a23b-c3605c591320 committed, at activate: 443926cb-… is committed: the fleet belongs to bfa140ac-7b77-4db8-a093-81244f9a7d74 at generation 10, and only its activation can go on.
  Safe: `svall handover --resume`.
  ```

  The Mac already had the windows and m4 only `_keep`. `--resume` completed at **g10** in 1.8 s. Its master
  (pid 48963) leaked too.
- **`attach` right after `--detach`.** One extra run (`x-kill-attach`) exited 0 in 0.1 s and printed nothing. Its
  helper had stopped at Checks within about 3 s (B2).

### Link cut (§7), emulated

- **Why emulated.** Disconnecting Tailscale on this Mac cuts every link to linus-vault, the owner's included, so it
  was not done.
- **How.** `$S/x/cut.sh on` cuts the test HOME's link only:
  - New connections go through `$S/x/netcut/ssh`, which is first on PATH for the controller (`hox.sh`) and for the
    Mac daemon (restarted by `daemon-x.sh`). It adds `-o ProxyCommand=/bin/sleep 75`, so they wait for a banner that
    never comes.
  - Every live `ssh` naming `svall-m4@` or a `$TH/tmp` socket is SIGSTOPped, then SIGKILLed 45 s later, as
    ServerAlive 15 s × 3 would end it.
- **Limit.** The Mac daemon's own gateway mux master (`ssh: …/.config/svall/ssh/gw-51b29d693167 [mux]`) did not match
  that pattern, so the daemon's link to the gateway stayed up. The controller's links were cut.
- **Before the commit** (`x-drop`, Mac → Linux): cut at +6.1 s, as transfer began.
  - Retries came at +51.3 s (`svalld connection closed`), then at +62.6 s and +74.6 s with "ssh could not reach
    svall-m4@100.117.42.24: Connection timed out during banner exchange".
  - The run ended `interrupted` at +88.8 s, with safe `["resume","abort"]`, **83 s after the cut**.
  - Status during the cut was `unknown`: "the gateway cannot say whether … committed (…); nothing is safe until it
    answers." After the link came back it was `open`, with `--resume` or `--abort`.
  - `--resume` completed at **g9** in 9.9 s.
- **After the commit** (`x-drop2`, Mac → Linux): cut at +11.0 s, in activate.
  - Three retries, then `interrupted` at +94.0 s with safe `["resume"]` only, 83 s after the cut. Status said
    committed, "only its activation can go on".
  - m4's daemon had already started the agents.
  - `--resume` (Retry) completed at **g11** in 1.8 s.

### ssh drop with the fleet on m4 (§9, CLI part)

- **Before the cut:** `char run c_jal5kh 'echo R10-BEFORE-CUT $$'` printed pid 1328389. The agents ran as 1328449,
  1328451 and 1328453.
- **During a 90 s cut:** `svall status` failed after 20.4 s:

  > svall: the gateway m4 did not answer, and m4, which it last named as the owner, did not answer either: ssh
  > could not reach svall-m4@100.117.42.24: Connection timed out during banner exchange / Connection to UNKNOWN
  > port 65535 timed out. The gateway said: (the same ssh error again)

  `char read` gave the same.
- **After the link came back:** `status` answered 1 s later.
  - The agent pids were unchanged.
  - `echo R10-AFTER-CUT $$` printed the same pid, 1328389.
  - `char read` showed the earlier scrollback.
- **Not exercised:** the banner and the terminals' re-attach in the app.

### Agent at work (§5.3) and pinned (§5.5)

- **The task.** claude-r on m4 was asked to run `sleep 90`. Claude ran it in the background ("The harness blocks a
  plain sleep 90, so it's running in the background instead").
- **`x-int`** (`--interrupt-after 10s`, m4 → Mac): froze, interrupted, then stopped at 24.3 s with `agent_unsettled`
  and was aborted back to m4, which kept running. The message embeds Claude's whole shell-snapshot command line:
  "claude-r's terminal did not come to rest after it was interrupted: /bin/bash -c source
  /Users/Shared/svall-m4/.claude/shell-snapshots/snapshot-bash-….sh 2>/dev/null || true && shopt -u extglob … && eval
  'sleep 90' < /dev/null && pwd -P >| /tmp/claude-50e4-cwd still runs". That is as documented for a background
  command.
- **`x-int2`** (`--interrupt-after 10s --terminate-shells`): complete at **g12** in 35.1 s.
  - Claude resumed on the Mac with its conversation ("A restart stopped the first run before it finished, so sleep
    90 is running again in the background").
  - m4 ran nothing of the fleet afterwards.
- **Pinned.** After `char update c_txynl7 --keep-here`, `--check` was blocked with `character_pinned`: "notes is kept
  on this machine". `--no-keep-here` cleared it.

## 4. New commands at this head (step 5)

- **`svall handover m4 --check`.**
  - `x-check-1`, without the logins: `blocked`, and ownership stayed g4, not frozen, before and after. Its blockers:
    - `agent_logged_out`: "claude is not logged in on the destination";
    - the same for codex, and for opencode (B3);
    - `repository_unused`: "dev's terminal is in /Users/Shared/svall-m4/dev, which holds 2 Git repositories no
      character works in (delta, gamma), so the handover would carry them too; cd it to ~ or into the repository it
      works on, close dev, or leave them out with handover.exclude in fleet.json, such as /delta/".
  - With the logins and `--carry-unused` it came back `ready`.
- **`svall handover on`** printed "handover is on for this fleet", exit 0.
- **`svall handover off`** printed "svall: this fleet names a gateway, so handover stays on; `svall host remove` that
  machine first", exit 1. `fleet.json` was unchanged.
- **`svall fleet recover --force-owner local`**, with stdin `/dev/null` and no TTY, while the Mac owned the fleet at g4
  (`logs/x-recover-1.txt`):
  - It does not refuse because the gateway answers. It showed every generation (all 4) and planned "This writes a
    new authority on m4: linuss-macbook-pro owns this fleet at generation 5", with three risks.
  - The terminal gate then refused: "nothing was written: forcing ownership needs a person at a terminal outside any
    fleet's agents and tmux panes, and this run has no terminal", exit 1.
  - Ownership and the gateway record stayed at g4. This is as `handover.md` §"…recover" documents ("It writes only
    after you type the fleet id … Any other run shows the same and writes nothing"), not a gateway refusal.
- **`svall handover status` after a kill:** quoted in §3. The safe actions are right; the wording is M2.

## 5. Defects (not fixed)

### B1, Important: a `git status` in the fenced Linux copy blocks the next handover with `destination_diverged`

- **What happened.**
  - After Linux → Mac, `git status` ran in m4's fenced copy; it was this kit's snapshot. Git refreshed each index's
    stat cache and rewrote the files with **mode 664**. On m4, umask is `0002` and git is 2.43.0.
  - The handover had left them **644**, the Mac's mode (git 2.56.0). The m4 files were `src/alpha/.git/index`,
    `.git/worktrees/feat/index`, `src/beta/.git/index`, `.git/worktrees/beta-wt1/index` and `dev/{gamma,delta}/.git/index`,
    rewritten at 08:39:23Z.
  - The next Mac → Linux was blocked with:
    - "/Users/Shared/svall-m4/src/alpha changed while this machine did not own the fleet: 2 changed (.git/index,
      .git/worktrees/feat/index). Recover the changes by hand, or archive it to continue"
    - "/Users/Shared/svall-m4/dev changed while this machine did not own the fleet: 2 changed (delta/.git/index,
      gamma/.git/index). Recover the changes by hand, or archive it to continue"
    - `src/beta` was also flagged for its two index files, beside the real `lib.txt`.
  - `chmod 644` on those files alone cleared both blockers (`x-block-1b`).
- **Cause.**
  - `same()` in `packages/svalld/src/handover/divergence.ts:17` requires `a.mode === b.mode` before the index rule
    ("a Git index is what it stages") applies. So an index whose stages are unchanged but whose mode is 664 counts
    as changed.
  - Ubuntu's default umask is 002, so any git-aware prompt, editor or `git status` in the fenced copy triggers it.
- **Why it matters.**
  - The user is told to "Recover the changes by hand" when nothing changed.
  - The only way on is to archive every repository root of the fleet.

### B2, Important: a Claude whose cwd moved off its session's project folder blocks every handover until its next turn

- **What happened.**
  - claude-r's session `2d38c2d0-…` began in `src/alpha`. Its transcript is
    `~/.claude/projects/-Users-Shared-svall-m4-src-alpha/2d38c2d0-….jsonl`, which Claude keeps writing.
  - Claude now works in the worktree `src/alpha/.wt/react-boilerplate`, which it went into during the by-eye pass.
  - After each resume, the character's `transcriptPath` reads `…/-Users-Shared-svall-m4-src-alpha--wt-react-boilerplate/2d38c2d0-….jsonl`,
    which exists on neither machine. Every handover then stops at Checks with `transcript_missing`:
    "/Users/Shared/svall-m4/.claude/projects/-Users-Shared-svall-m4-src-alpha--wt-react-boilerplate/2d38c2d0-a6ab-4128-a21e-5193af95ae31.jsonl
    is not there".
- **How often.** It happened three times, in both directions: Linux → Mac at 08:41Z, Mac → Linux at 08:47Z, and the
  pinned check at 09:00Z. Each time, one Claude turn set the path back to `-src-alpha` and the check came back
  `ready`.
- **Cause, as far as read.**
  - The receiver takes `transcript_path` from every hook (`packages/svalld/src/hooks/receiver.ts:151`). Claude's
    SessionStart on `--resume` from another folder reports the cwd's project folder, while its later hooks report
    the real file.
  - The handover then reads that path (`packages/svalld/src/handover/sessions/records.ts:14`).
- **Why it matters.**
  - A Claude that entered a worktree is common: Claude's own worktree tool does it.
  - After one handover, the fleet cannot move again, in either direction, until that agent takes a turn.
  - The blocker gives no way on.

### B3, Important: OpenCode with no provider login passes doctor but blocks every handover

- **What happened.**
  - With the logins not yet copied, m4's `opencode auth list --standalone --format json` printed `[]` (exit 0).
  - `host doctor m4` then said "✓ opencode opencode v2.0.27, signed in".
  - `--check` was blocked with `agent_logged_out`: "opencode is not logged in on the destination". Once the copied
    `openai` row was there, the blocker went.
- **Cause.**
  - `AGENTS.opencode.loggedIn` is `() => true` (`packages/svalld/src/agents.ts:47`), with the comment "a fresh install
    runs on OpenCode Zen's free model without a login".
  - `probeAgent` instead needs a non-MCP provider row (`packages/svalld/src/handover/sessions/registry.ts:172`,
    `providerListed`).
- **Why it matters.** A fleet whose OpenCode runs on a free Zen model cannot be handed over. Doctor and `host add`
  report ready, so nothing says why until Checks.

### Minor

- **M1. A SIGKILLed helper's `ssh -M` outlives it.** This happened twice (pid 91629 with PPID 1, and pid 48963). It
  stays up through a `--resume`. Only `svall connect` sweeps it (`packages/cli/src/commands/connect.ts:39`), and
  running that removed it. In CLI-only use it stays connected to m4 until the network drops it.
- **M2. `handover status` names machines by raw id and repeats the transaction id.** Examples:
  - "…a65ce1d7-… is preparing and has not committed; it can go on, or be aborted back to
    9856b4ae-31c8-4a3f-867a-8c5cc9c5b297";
  - "the fleet belongs to bfa140ac-7b77-4db8-a093-81244f9a7d74 at generation 10".

  The none-open line is doubled: "No handover of this fleet is open: no handover of this fleet is open anywhere."
- **M3. Other duplicated or long wording.**
  - The unreachable-owner error repeats the same ssh error after "The gateway said:".
  - `agent_unsettled` embeds Claude's whole internal shell-snapshot command line.
- **M4. `svall handover --help` hides `on` and `off`.** Its Commands list shows only `status` and `attach`, though
  `handover on --help` works.
- **M5. Codex's pid is not shown after a resume.** `char list` shows `pid: null` for codex-r after every resume, on
  both machines, until its first turn, while `codex resume --no-daemon …` runs.

### Kit, not product

- **`66-rest-agents.sh`'s process count** matches any bare `claude` or `opencode`, so it counted the owner's 13 robots
  as "test-HOME agent processes". None was the test HOME's.

## 6. End state

- **The Mac owns the fleet at g12**, and nothing is frozen or open. `handover status` says none is open anywhere.
- **Mac processes.**
  - svalld 47563 runs on `10447557` on 127.0.0.1:47871, started by `mac-daemon-start.sh` with the normal PATH.
  - tmux runs `_keep` and shell `c_jal5kh`.
  - claude-r, codex-r and opencode-r are dormant with their `revive`. The other four shells are dormant.
  - The test ssh-agent is 8474. The daemon's own gateway mux master is 52250.
  - No helper, controller master or agent of the test HOME runs.
  - A stale socket file, `$TH/tmp/svall-502/48958-51b29d693167`, is left; its master was killed by the cut.
  - 0 test-HOME apps are registered with LaunchServices.
- **m4.** Both units run `10447557`, with `4c11f026` kept. The gateway record is at g12, naming the Mac. There is no
  tmux server or agent, and `handover/` is empty. The archived beta copy was deleted, and the index modes were put
  back to 644.
- **Logins.** None is left on either machine.
- **Kit additions.** `$S/x/` holds `cut.sh`, `netcut/ssh`, `xenv.sh`, `hox.sh`, `daemon-x.sh`, `at.sh` and
  `killhelper.sh`. `$S/run/agents.sh` holds the agent ids again, so `66-rest-agents.sh` runs.
- **The environment doc** (`pr2-onmachine-env.md`) still names `2ab80fda` and g2. Its "Where things are" should read
  `10447557` and g12.
- **The final compare** from the start of the run (`10447557-after` → `x-final`) is 60 DIFF on the Mac and 58 on
  Linux. They are owner.json, seals, sessions, `lastPrompt`, `restedBy`, agent status, and the live shell (Mac) and
  `revive.interrupted` (Linux). Git and files are equal.

## Concerns

1. **B1–B3 each stop a handover for no reason a user can act on.** B1 and B2 are hit in ordinary use: a git prompt in
   the fenced copy, or a Claude in a worktree. B3 hits every OpenCode on a free model.
2. **The link cut was emulated.** The daemon's gateway master stayed up, and the app-only paths are still unexercised:
   the sheet, the banner, re-attach in the app, and Cmd-Q.
3. **Step 6 is still owed.** Step 3 has to be repeated at the merged head, with a fresh login copy. The owner's Claude
   token had about 158 minutes left at the copy, and the script refuses with under 90.
