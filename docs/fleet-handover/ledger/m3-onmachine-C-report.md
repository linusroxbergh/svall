# M3 gate on-machine pass, Part C: rebuild and re-check, real Claude and Codex, cleanup

Status: **BLOCKED** (step 0, step 1, Codex both ways, R1–R3 done; the real Claude handover is blocked on the Mac by this session's permission guard and on m3 by a dead copied credential; cleanup not run)

`$S` = the A2 scratchpad (`…/scratchpad/m3-onmachine-a2`), `$B` = Part B's (`…/scratchpad/m3-onmachine-b`),
`$C` = this part's: `/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/458d4622-7488-4208-9faa-1ee5a901238b/scratchpad/m3-onmachine-c`.
`caffeinate -i` ran for the whole part (its own process, plus each background cell under `caffeinate -i`).

## Step 0: rebuild, upgrade, re-check Part B's failures

### 0a. Build and install: PASS

- `$C/build.sh` (A2's `build.sh`) at `e96ee59b`: app and `archipelago-companion-e96ee59b-linux-x64.tar.gz`
  (45,214,153 B, sha256 `4a37c672…eb262f7`). Worktree clean before and after. Log `$C/logs/build.log`.
- `$C/00a-install.sh`: the app replaced in the same `ARCHI_APP_DEST` (`$TH/Applications`); `archi version --json` →
  release `e96ee59b`, protocol 10, stateSchema 7. `archi -p private setup --no-launchctl --allow-unsigned --release
  <app>/Contents/Resources/release` → `current -> releases/e96ee59b`; node.json kept (port 47871); plist rewritten in
  `$TH/Library/LaunchAgents`, not loaded.
- `$C/00b-upgrade.sh`: `archi host upgrade m3 --release <archive> --allow-unsigned --json` → machine, master, release
  (`e96ee59b … unsigned`), upload, install, probe (`m3 answers on release e96ee59b`) all ok, result ready, 8 s. archid
  154986 → 636778 and gateway 196330 → 636787, both on `releases/e96ee59b`; m3's tmux server 2159002 unchanged.
  `host doctor m3`: release ok `e96ee59b … this controller runs e96ee59b`, claude ok 2.1.260 (the mock), codex skip.
- `$C/00c-mac-restart.sh`: Mac archid 81104 (0248e2ac) SIGTERMed; 68447 started as its plist would, on `e96ee59b`.
  Ownership: the Mac at g44, 16 windows, 14 mocked agents, no journal.
- Snapshot `c00-mac` against Part B's last good `final-mac`: **0 DIFF** (4 rewrite, 1 expected). The fleet and fixture
  are as Part B left them.

### 0b. Re-runs

Part B's harness copied into `$C` (`bin/cell.mjs`, `plans.mjs`, `runcell.sh`, `bg.sh`, `bsnap.sh`, `bcmp.sh`, `flip.sh`;
`B` pointed at `$C`, so logs, run files and snapshots land here). Two plans added: `B2kU` (B2k's first run on purpose:
`systemctl --user kill -s SIGKILL archipelago-archid@private.service` with the default kill-whom, so archid, the fleet's
tmux server and all 14 agents die mid-rest) and `B2kU2` (the same, then the helper SIGKILLed 0.3 s later, so the fleet is
left for `handover --resume`). Every cell's log, stream, samples and summary are in `$C/logs/<cell>.*`.

| Cell / item | Part B | Now (e96ee59b) | Result |
| --- | --- | --- | --- |
| A2d (P1, P4) M→L, master drop at the first source freeze row | claim hung on the dead WS; cancelled after 150 s; helper lingered >5 min | no stall: transfer began 0.9 s after the drop, no retry event, complete g45 in 13.6 s, 14/14 ok; helper exited 0 in the same ms as its result | **PASS** |
| B1d (P1) L→M, drop pinned at `changed begin` | freeze sent into the dead WS, 930 s timeout | freeze went out 5 ms after SIGCONT on a new connection; complete g46 in 14.7 s, 14/14 ok | **PASS** |
| A8k2 (P2) M→L, m3 archid main SIGKILL 0.3 s into activate | complete g37 with 10 of 14; 4 at a shell with the resume typed; `agent`/`revive` dropped | kill landed with 7 windows open and 3 agents started; `retry activate #1/#2`; complete g47 with **14 of 14 ok**; 16 windows / 14 agents, no plain shell left; the four beta windows are new panes (replaced), the others kept; compare clean (no `agent`/`revive` DIFF) | **PASS** |
| B2kU (P3) L→M, the whole unit killed mid-rest | resume failed at once every time (`tmux list-panes … no server running`) | the helper's own freeze retry (#1 closed, #2 ECONNRESET) reached the restarted frozen-source daemon, which rested a fleet with no server; complete g50 with `characters: []`; every character dormant on the Mac with its session and `revive` (`claude --resume <id>`) | **PASS** (as ruled: carried dormant) |
| B2kU2 (P3's own test) same, then helper killed | — | status `open`, safe [resume, abort], m3 `frozen surrendered journal=source:freeze`, Mac fenced; `--resume` → complete g52 in 12 s, `characters: []`, all dormant with `revive` | **PASS** (as ruled) |
| P5 foreground `handover local --json \| head -n 2` | helper died of an unhandled EPIPE | head took 2 lines and exited; the helper wrote on, took the EPIPE silently, ran through its journals: exit 0, empty stderr, events file ends `handover.result complete g48` 14/14 ok; status none | **PASS** |
| P4 across all runs | A2d lingered >5 min | no run lingered: the harness's 15 s linger watch never fired in any cell; every foreground helper exited with its result | **PASS** |

Details:
- **A2d.** `ACTION drop: SIGKILL master(s) 69868` at +3294 ms, `changed transfer` at +4165 ms, result at +13604 ms, helper
  ended `{"code":0}` at +13604 ms. Invariant held (commit 09:17:42.174). Status none; the Mac refused revive/attach
  `handover_committed`. Compare `c00-mac → A2d-m3-linux`: only the standing `docs/deep` dir-mode note.
- **B1d.** Helper SIGSTOPped at `changed begin`, master 71606 killed, SIGCONT; `changed freeze` 5 ms later, no retry,
  complete g46. m3 refused revive/attach after. Compare clean.
- **A8k2.** m3 samples (`$C/logs/A8k2.m3-samples`): `win=4 agents=0` → `win=7 agents=3` at the kill, held while
  archid restarted, then `win=5` (two unstarted windows closed), `12/7`, `16/11`, `16/14`. The restarted daemon logged
  `handover ae31aa69… is at activate on this machine`. Panes afterwards: `c_5kdnba`, `-2`, `c_roop4l`, `c_lu4e18` keep the
  first daemon's pane pids (651559–651593); the beta characters run in new panes (652051–652070). Every character's
  pane runs `node` (the mock), the two second terminals `bash`. No hand step. Compare `B1d-mac-mac → A8k2-m3-linux` clean.
- **B2kU.** The kill took archid, tmux and every agent (m3 `win=0 agents=0` from then). The result lists no characters,
  as ruled in the fix round ("carried dormant; costs a hand revive"). The compare shows exactly that and nothing else:
  per character `revive: undefined -> "claude --resume <id>"` and `main: no live window`, the two second terminals
  `revive: ""`; no `agent`/session DIFF. By hand (`$C/revive-mac.sh`: 14 `char.revive`, 2 `char.second`, log
  `logs/B2kU.manual-revive.log`) → 16/14; compare `flip1-linux → B2kU-fixed-mac` clean.
- **B2kU2.** State after the kills: gateway tx 13838c80 `preparing`, m3 `frozen surrendered journal=source:freeze` with
  0 windows, controller journal at freeze. Status `open`, `continue`, safe [resume, abort] (`… is preparing and has not
  committed; it can go on, or be aborted`). `--resume` completed g52. Same dormant arrival and the same hand revive
  (`logs/B2kU2.manual-revive.log`); compare `flip2-linux → B2kU2-fixed-mac` clean. The killed helper left its master
  (orphan, D4 — parked, not in this wave); the harness killed it.
- **P5.** `$C/00p5-epipe.sh`, log `logs/P5.log`, the run's events `logs/P5.events.ndjson`. Mac 16/14 and m3 0/0 after;
  compare `A8k2-m3-linux → P5-mac` clean.
- Plain handovers between cells (`flip.sh`): `flip1` Mac → m3 g49 and `flip2` Mac → m3 g51, 14 s each, compares clean.

Invariant: held in all five injected cells (0.3 s samplers on both machines: no destination window before the commit,
no source window after it). Every fenced side refused revive and attach.

Step 0 leaves the Mac owning the fleet at **g52** with 16 windows and 14 mocked agents, no transaction anywhere, and
`B2kU2-fixed-mac` as the last good snapshot.

## Step 1: credentials and agents on both sides

### Versions against the supported range (`sessions/claude.ts:5` 2.1.251–2.1.280, `sessions/codex.ts:5` 0.155.1–0.156.1)

| | Claude Code | Codex |
| --- | --- | --- |
| linus-vault, linus's install | 2.1.280 (in range, the maximum) | 0.156.1 (in range, the maximum) |
| Mac, the owner's current install | **2.1.281** (`~/.local/bin/claude` → `versions/2.1.281`, auto-updated Sep 23 21:40): **out of range** | 0.156.1 (in range) |
| Mac, older versions kept by the installer | 2.1.276, 2.1.277, 2.1.278, **2.1.280** | 0.155.1 |

**Out-of-range check: PASS.** With the Mac's `claude` probe answering the owner's 2.1.281, `archi handover m3` stopped at
preflight, nothing begun (`logs/ver281.ndjson`): blocker `incompatible_adapter "no session adapter was tested with this
machine's claude 2.1.281; claude 2.1.251 to 2.1.280 are"`, plus the warning `config_difference "claude 2.1.281 runs on
linuss-macbook-pro and 2.1.280 on m3 …"`. The Mac side therefore uses a copy of 2.1.280 from here on.

### linus-vault (archi-m3): PASS

- linus's home is `drwxr-x---`, so archi-m3 cannot run his binaries in place: per-user copies were made.
- `$C/01a-remote-creds.sh` (as linus, sudo): `~/.claude/.credentials.json` and `~/.codex/auth.json` copied into
  archi-m3's home, `chown archi-m3`, 0600, md5 equal to the source (contents never printed). Claude 2.1.280
  (`versions/2.1.280`) → `~archi-m3/agents/claude/claude`; the Codex release dir `0.156.1-x86_64-unknown-linux-musl` →
  `~archi-m3/agents/codex`. linus's four source files: same mode, owner and mtime before and after
  (`logs/01a-linus-before.txt`, `logs/01a-remote-creds.log`).
- `$C/01b-remote-wrappers.sh` (as archi-m3): `~/.local/bin/claude` now runs the mock in the fixture's folders (`~/src`,
  `~/code`, `~/notes`, `~/docs`) and the real 2.1.280 (with `DISABLE_AUTOUPDATER=1`) anywhere else; `~/.local/bin/codex`
  runs the copy; `~/.codex/config.toml` gets `check_for_update_on_startup = false` (both pin the copied versions). Probes
  from `~`: `2.1.280 (Claude Code)`, `loggedIn: true, authMethod claude.ai`; `codex-cli 0.156.1`, `Logged in using
  ChatGPT`. From `~/src/alpha`: the mock's `2.1.260`.
- `systemctl --user restart archipelago-archid@private.service` → archid wrote `~/.codex/hooks.json` (`codex hooks ->
  …`, `run /hooks in Codex once to trust the Archipelago hook, or it will not fire`).
- The spec's "agent login and Codex hook trust in an offered SSH terminal" (Add Machine step 8), done by hand in a tmux
  of its own (`~/.m3c-setup.sock`, not the fleet's) in a neutral folder `~/onboard` (not a parent of any carried root):
  - Codex: `Trust this folder?` → trust `~/onboard`; `Hooks need review: 7 hooks are new or changed` → `Trust all and
    continue`. `config.toml` now holds `[projects."/home/archi-m3/onboard"] trust_level = "trusted"` and seven
    `[hooks.state."…/hooks.json:<event>:0:0"] trusted_hash`. Codex warns that its Linux sandbox (bubblewrap) cannot
    create user namespaces on this Ubuntu; not a handover matter.
  - Claude: the first interactive start ran Claude's onboarding (theme, then `Select login method`). **Reaching that
    login step emptied the copied credentials** (`claudeAiOauth.accessToken`/`refreshToken` became empty strings,
    `expiresAt 0`; the file went 2747 → 2519 B) before any choice was made; `auth status` then said `loggedIn: false`.
    Whether it also revoked the refresh token server-side is not known; linus's own file on linus-vault is untouched.
    `hasCompletedOnboarding` was then set in archi-m3's `~/.claude.json`, the credentials copied again (the same
    authorised copy, `01c-remote-recopy-claude.sh`, md5 equal), and Claude started straight into the folder trust
    dialog (trusted `~/onboard`) as `Claude Max`, logged in.
- Harness: A2's `~/.m3-no-node/node` stub (exit 127) was set aside (`node.part-c-disabled`), because Codex's hook
  command runs `node` from PATH (`codex/install.ts:20`, deliberately no absolute path) and the stub would fail every
  Codex hook. On a clean host the pane inherits archid's PATH, whose first entry is the release's own node. The
  npm/npx/pnpm/tsx/corepack stubs stay. (linus-vault also has a system `/usr/local/bin/node`.)

### Mac temp HOME: Codex PASS; Claude **NEEDS_CONTEXT**

- `$C/01d-mac-agents.sh`: `$TH/.codex` (0700) with a copy of the real `~/.codex/auth.json` (0600, md5 equal) and
  `config.toml` `check_for_update_on_startup = false`; copies of the owner's Claude 2.1.280 and 2.1.281 into
  `$TH/agents/claude-280|281/claude` and of Codex `0.156.1-aarch64-apple-darwin` into `$TH/agents/codex`; wrappers in
  `$TH/.local/bin` as on m3 (the fixture folders, including the `work` root's real path `m3w2`, keep the mock).
  `$TH/.claude.json` got `hasCompletedOnboarding` first, so no Claude start there can reach the onboarding login step
  that emptied archi-m3's credentials (on the Mac that would be the owner's keychain item).
- `$C/mac-daemon-restart.sh`: archid restarted with its cwd in `$TH` (agent probes run there; it had inherited the
  worktree as cwd) → it wrote `$TH/.codex/hooks.json`. Codex set up by hand in `$TH/onboard` through a tmux of its own:
  folder trusted, `Trust all and continue` for the 7 hooks. `codex login status`: `Logged in using ChatGPT`.
- **Claude cannot log in under the temp HOME.** `claude auth status` → `loggedIn: false`. The brief expects it to read
  the login keychain, but macOS derives the user's keychain search list from `$HOME`: `security list-keychains` with
  `HOME=$TH` lists only `/Library/Keychains/System.keychain`, and `security find-generic-password -s "Claude
  Code-credentials"` (attributes only) finds the item with the real HOME and `could not be found` with `HOME=$TH`. The
  owner has no `com.apple.security.plist`; the default list is `$HOME/Library/Keychains/login.keychain-db`.
  Every way to make it log in is outside the authorised list, so this part stopped there (see the end of this report).

## Step 2: real sessions handed both ways

The Mac's `claude` is the plain mock again for this step (`run/mac-claude-wrapper.orig`), since the real Claude cannot
log in there (step 1); m3's `claude` dispatches as described. Codex is real on both machines.

### 2a. Codex, Mac → Linux (`logs/x1-mac-to-linux.*`)

- `02a-codex-char.sh`: `archi char new --island i_xpjzbj --cwd $TH/real/codex-x --name real-codex --agent codex` →
  `c_99tug7`. Codex opened at `Trust this folder? /private/tmp/claude-502/m3h2/real/codex-x`; answered `Trust and
  continue` by hand (a normal first start). Before any prompt the character carried `hint: codex-silent`.
- One turn: `archi char run c_99tug7 "Reply with exactly the word MANGO and nothing else."` → `• MANGO`; the state
  then held `agent.kind codex`, `sessionId 01a0d2cd-b132-7400-b0d8-2174fed20f82`, the rollout
  `$TH/.codex/sessions/2026/09/24/rollout-…-01a0d2cd-….jsonl` (15 records).
- `archi handover m3` (foreground `--json`): preflight **warned** `codex_trust "Codex asks whether to trust its folder
  the first time real-codex resumes on m3; answer it in that terminal"` (and `config_difference` for the two claudes);
  15 roots, 15 sessions. Complete **g53 in 74 s**, 14 ok and:
  `c_99tug7 ok:false "real-codex's terminal resumed codex session 01a0d2cd-…, which did not report its SessionStart
  within 60 s, so it is dormant again with that session; Codex was most likely waiting at its "Trust this folder?"
  prompt; revive it and answer that prompt there"`.
- **Trust prompt: activation does not pass it; it stalls there for the full 60 s, then lays the character dormant
  with a visible error** (as designed since the P2 fix round). During the wait m3's pane showed `Trust this folder?
  /home/archi-m3/real/codex-x`. After Complete, m3's state: no `tmux`, `agent` kept (session id, transcript at
  `/home/archi-m3/.codex/sessions/…`), `revive: codex resume 01a0d2cd-…`. The error text lives only in the handover's
  result and events (and m3's archid.log); the character itself carries no error once the journal closed.
- By hand: `char.revive` on m3 → the trust prompt again → Enter → the resumed TUI showed the carried turn
  (`› Reply with exactly the word MANGO…  • MANGO`). A turn on Linux, `archi char run c_99tug7 "What single word did
  you reply with in your previous answer? Reply with that word followed by -LINUX."` (through the Mac's helper) →
  **`• MANGO-LINUX`**. The same session id and rollout file grew 15 → 29 records; no second rollout. **`codex resume`
  continues the carried session: PASS.**
- Carried rollout: records 0–14 on m3 equal the Mac's record for record apart from the Mac → Linux home path in
  `session_meta`, `world_state` and `turn_context` (`run/x0-codex-mac.jsonl` vs `run/x1-codex-linux.jsonl`).
  The snapshot compare (`cmp-x1`) prints two DIFFs for the Codex session that are the harness's (A2's compare.mjs looks
  for a Claude transcript path and compares records by a truncated print); the fixture's 14 characters compare clean.

### 2b. Codex, Linux → Mac (`logs/x2-linux-to-mac.*`)

- `archi handover local`: preflight warned `codex_trust "… the first time real-codex resumes on linuss-macbook-pro …"`,
  although the Mac's `config.toml` already trusts `$TH/real/codex-x`. Complete **g54 in 76 s**, 14 ok, and c_99tug7
  **`ok:false`** with the same text: `… did not report its SessionStart within 60 s … Codex was most likely waiting at
  its "Trust this folder?" prompt …`.
- **There was no trust prompt.** 6 s into activate the Mac pane showed Codex resumed and idle at its prompt with both
  carried turns on screen (`• MANGO`, `• MANGO-LINUX`). The activation waited 60 s for a SessionStart that never came,
  then laid the character dormant, closing that running Codex.
- **SessionStart is not sent on `codex resume`.** Revived by hand on the Mac (folder trusted, no prompt): 30 s later the
  character's `agent.lastActivityAt` was still 1790243419961 (the Linux turn). A SessionStart for the same session
  sets it to now (`agent/reducer.ts:11-17`), so none arrived. On creation Codex likewise carried `hint:
  codex-silent` until its first prompt. Codex 0.156.1 runs its SessionStart hook with the first turn, not at start.
- By hand: a turn on the Mac, `"List the words you replied with in your two previous answers, separated by a space, then
  add -MAC."` → **`• MANGO MANGO-LINUX-MAC`**: both earlier turns remembered, same session id, the one rollout grew
  29 → 44 records. **`codex resume` continues the carried session on the Mac too: PASS.**
- Rollout on return: records 0–28 equal m3's apart from paths in structured fields (`session_meta`, `turn_context`,
  `event_msg`, `world_state…local.cwd`). The text blobs the model saw (`environment_context`, permission and skills
  instructions, `world_state` filesystem and skills bodies) keep the path of the machine that wrote them, in both
  directions (records 2/5 keep the Mac path on Linux; 18–20 keep the Linux path on the Mac). The next turn writes a
  fresh context with the current path (records 33–36). This reads as intended (history is left as it was) and the
  turns worked; noted, not a defect.
- Snapshot compare `x1-linux → x2-mac`: the fixture's 14 characters clean; the Codex session lines are the harness's
  (see 2a).

### Real-agent checks so far

| Check | Codex | Claude |
| --- | --- | --- |
| versions vs supported range | 0.156.1 both sides: in range | m3 2.1.280 in range; the owner's Mac 2.1.281 **out of range**, and preflight blocks it (PASS) |
| activation passes the folder trust prompt | **no**: stalls 60 s, then dormant with a visible error (as designed; warned at preflight) | NOT RUN |
| `resume` continues the carried session, Mac → Linux | **PASS** (after a hand revive and trust) | NOT RUN |
| `resume` continues the carried session, Linux → Mac | **PASS** (after a hand revive) | NOT RUN |
| SessionStart reports the carried session id | **FAIL**: Codex sends no SessionStart on resume, so activation never sees it (C-D1) | NOT RUN |

The Mac now owns the fleet at **g54**: 14 mocked characters plus real-codex (revived by hand, idle, 17 windows), no
transaction anywhere; m3 holds only its daemons and `_keep`.

## Stopped here: NEEDS_CONTEXT (real Claude on the Mac)

The Claude half of step 2 and all of step 3 (cleanup) are NOT RUN. The environment is left running for them.

**What blocks it.** Claude under the temp HOME cannot log in (step 1). The brief authorises "Claude on the Mac reads the
login keychain (no copy needed)". But macOS derives the keychain search list from `$HOME`, so with `HOME=$TH` it sees
only the System keychain. Claude must be logged in on the Mac for two reasons:
- the real session's first turn is made there;
- Linux → Mac preflight blocks `agent_logged_out` when the destination's claude is logged out.

**What was checked, touching nothing of the owner's.** With a logging stand-in for `security` first on its PATH (it
records only the subcommand and the argument count, and answers "not found"), temp-HOME Claude 2.1.280 ran
`security find-generic-password` (6 args) twice for `auth status`. So Claude finds `security` through PATH
(`run/secshim/security`, `logs/secshim.log`).

**Options, none of them in the authorised list:**
- **A.** Put a `security` wrapper on the temp-HOME Claude's PATH only. It runs `/usr/bin/security` with
  `HOME=/Users/linusroxbergh` and refuses `delete-generic-password`.
  - Effect: the temp-HOME Claude reads the owner's `Claude Code-credentials` item exactly as the owner's own Claude
    does. On a token refresh it writes the new token back to that item, so the owner's Claude stays consistent.
  - `$TH/.claude.json` already has `hasCompletedOnboarding`, so Claude's onboarding login step cannot run. On archi-m3
    that step emptied the copied credentials.
  - This is the closest match to the brief's intent.
- **B.** Give the temp HOME a keychain search list naming the owner's login keychain: a `com.apple.security.plist`
  or a `Library/Keychains/login.keychain-db` symlink, both inside `$TH`.
  - Same reach as A.
  - Less certain: securityd might treat the path as another keychain and put up an unlock dialog on the owner's
    screen.
- **C.** Copy the Mac's Claude credential into `$TH/.claude/.credentials.json`, 0600, gone with the temp HOME.
  - The brief rules this out ("no copy").
  - A refresh inside the temp HOME would rotate the refresh token and log out the owner's own Claude on this Mac.
- **D.** Skip real Claude on the Mac and record the Claude checks as NOT RUN.

Once one is chosen, the remaining work is:
1. Set the Mac's `claude` back to the dispatching wrapper (`cp $C/run/mac-claude-wrapper.dispatch
   $TH/.local/bin/claude`; `agents/claude-current` already points at 2.1.280).
2. `archi char new … --cwd $TH/real/claude-c --agent claude`, one turn, then Mac → Linux → Mac. On each side, check
   the activation row, the pane, and one turn.
3. Step 3 cleanup.

## Defects (so far)

1. **Important (C-D1): no carried Codex character is ever activated.**
   - Codex 0.156.1 sends no SessionStart when `codex resume <id>` starts. It runs that hook with the session's first
     turn.
   - The destination waits up to 60 s for a SessionStart carrying the session id, for every agent kind
     (`packages/archid/src/handover/destination.ts:526` `waitStart`, `SESSION_START_MS` at `:73`). So every Codex
     character ends the handover `ok:false`.
   - Then `lay()` closes the window even when Codex is up and idle at its prompt.
   - The error blames the trust prompt (`:532-535`) even when none was shown.
   - Evidence:
     - x2: the folder was trusted, and Codex was resumed and idle 6 s into activate. It still failed after 60 s.
     - A hand revive left `lastActivityAt` unchanged for 30 s.
     - On creation, `hint: codex-silent` stayed until the first prompt.
   - Effect: after every handover the user revives each Codex character by hand. The resumed session itself is fine.
2. **Minor (C-D2): the `codex_trust` preflight warning fires whether or not the destination already trusts the
   folder.** x2 warned "the first time real-codex resumes on linuss-macbook-pro", while the Mac's `config.toml` held
   `trust_level = "trusted"` for that path.
3. **Minor (C-D3): the "visible error" of a failed resume does not outlive the handover.**
   - After Complete, neither machine's `state.json` holds the error for c_99tug7. The character is dormant with
     `revive`, and the text is only in the handover result, the controller's `events.ndjson` (rewritten by the next
     run) and archid.log.
   - The spec says such characters "remain dormant with their transcript and a visible error". The app's sheet was not
     checked.

Not a product defect, but a risk for the owner: Claude Code's onboarding login step empties the credentials it finds
(on archi-m3 the copied `.credentials.json` tokens became empty strings before any choice was made). On the Mac, that
would be the owner's keychain item. Every Claude start in a fresh HOME needs `hasCompletedOnboarding` set first.

## Environment left (for the rest of Part C)

- **Build:** release `e96ee59b` on both machines. The Mac archid is pid in `$S/run/archid.pid`, cwd `$TH`, restarted
  with `$C/mac-daemon-restart.sh`. m3's archid (MainPID 716443) and gateway (636787) run on `e96ee59b`.
- **Ownership:** the Mac at g54, no transaction anywhere. The Mac holds 17 windows (14 mocked characters, 2 second
  terminals, real-codex `c_99tug7`), 14 mocks and 1 real Codex, idle. m3 has `_keep` only.
- **Credentials:**
  - archi-m3: `~/.claude/.credentials.json` and `~/.codex/auth.json` (0600, copies of linus's); `~/.claude.json` with
    `hasCompletedOnboarding`.
  - Mac: `$TH/.codex/auth.json` (0600).
  - All go with archi-m3's home and the temp HOME.
- **Agent copies and wrappers:**
  - m3: `~archi-m3/agents/{claude,codex}`; `~/.local/bin/claude` dispatches (the original is
    `~/.m3-fake/claude-wrapper.orig`); `~/.local/bin/codex`; `~/.m3-no-node/node.part-c-disabled`.
  - Mac: `$TH/agents/{claude-280,claude-281,codex}`, with `claude-current` → `claude-280`.
  - Mac `$TH/.local/bin/claude` is the plain mock now; the dispatching one is `$C/run/mac-claude-wrapper.dispatch`.
    `$TH/.local/bin/codex` runs the real copy.
- **Codex trust:**
  - m3 trusts `~/onboard` and `~/real/codex-x`, plus the 7 hooks.
  - The Mac trusts `$TH/onboard` and `$TH/real/codex-x`, plus the 7 hooks.
- **Left running:** no master, helper, attach or sampler of this part, and no setup tmux on either machine.
  `caffeinate` was stopped at the hand-back.
- **Before-state:**
  - linus-vault's stable state against Part A's baseline shows the same three differences as at the end of A2 and B:
    update-notifier; archi-m3 in linger and passwd; `127.0.0.1:47800` (`logs/linus-state-now.txt`). The serve mapping
    is unchanged.
  - The Mac's `~/.ssh/known_hosts` md5 is unchanged (`1f403c13…`).
- **Owner's files read (never written):**
  - Mac: `~/.codex/auth.json`, `~/.local/share/claude/versions/2.1.280|2.1.281`, and
    `~/.codex/packages/standalone/releases/0.156.1-aarch64-apple-darwin`, all copied.
  - linus-vault: linus's two credential files and two binaries, copied with sudo. Mode, owner and mtime are unchanged.

---

# Part C, resumed on the owner's decision (option C) and the Q1–Q3 fix wave (HEAD 2415ab4c)

The owner chose option C for real Claude on the Mac: a copy of the Mac's Claude credential in the temp HOME, 0600,
deleted with it, the refresh-token rotation risk accepted. The Q1–Q3 fix wave (W/m3-onmachine-C-fixes.md, report
W/m3-onmachine-C-fixes-report.md) landed at `2415ab4c`. `caffeinate -i` runs again for the rest of the part.

## R1. Rebuild and upgrade to 2415ab4c: PASS

- `$C/build.sh` at `2415ab4c` (worktree clean before and after): `archipelago-companion-2415ab4c-linux-x64.tar.gz`,
  45,216,178 B (`logs/build2.log`).
- `$C/00a-install.sh` (`logs/00a-install2.log`): the app replaced in `$TH/Applications`, `archi version` release
  `2415ab4c`; setup → `current -> releases/2415ab4c`; node.json kept (47871).
- `$C/00b-upgrade.sh` (`logs/00b-upgrade2.log`): `archi host upgrade m3 --release <archive> --allow-unsigned` → probe ok
  `m3 answers on release 2415ab4c`, result ready, 8 s. archid 716443 → 1119122 and gateway 636787 → 1119132, both on
  `releases/2415ab4c`. `host doctor m3`: release ok, claude ok 2.1.280 (the real one, from `~`), codex ok 0.156.1
  "hooks installed".
- `$C/mac-daemon-restart.sh`: the Mac archid runs `releases/2415ab4c` from `$TH`; `system.info` release `2415ab4c`,
  claude 2.1.260 (the mock from `$TH`) and codex 0.156.1, both logged in with hooks. 17 windows, 14 mocks, 1 real Codex.

## R2. Codex (c_99tug7) handed both ways on 2415ab4c: PASS

Both folders were already trusted on both machines (from 2a/2b).

| Run | Result | Codex row | Stall | Window | Turn after |
| --- | --- | --- | --- | --- | --- |
| x3 Mac → Linux (`logs/x3-mac-to-linux.*`) | complete **g55 in 17 s** (x1 took 74 s), 15/15 ok, no `codex_trust` warning | `{"id":"c_99tug7","ok":true}`, no notice, no error | none: the pane ran `codex` within 1 s of `changed activate`, and the run completed a few seconds later | kept: m3 `@35/%35` after Complete, `resumeError` absent | `"Repeat your last answer exactly, then add -AGAIN-LINUX."` → `• MANGO MANGO-LINUX-MAC-AGAIN-LINUX` |
| x4 Linux → Mac (`logs/x4-linux-to-mac.*`) | complete **g56 in 18 s** (x2 took 76 s), 15/15 ok, no `codex_trust` warning | `{"id":"c_99tug7","ok":true}` | none: the pane went `zsh` → `codex` in 2 s | kept: Mac `@528/%528`, no `resumeError` | `"… add -BACK-ON-MAC."` → `• MANGO MANGO-LINUX-MAC-AGAIN-LINUX-BACK-ON-MAC` |

- The same session id `01a0d2cd-…` and the one rollout throughout: 44 → 58 records (m3) → 72 (Mac). No second rollout on
  either machine.
- Snapshot `x2-mac → x4-mac`: the fixture clean. The one DIFF is the harness's Claude-shaped transcript check on the
  Codex character (see 2a).
- **C-D1 fixed on the machines. C-D2 fixed for trusted folders:** no warning either way. The untrusted side is R3.

## R3. When real Codex 0.156.1 shows its folder screen, and what the product says: PASS (they agree)

**Setup.** Each case is a fresh `codex` start in a new folder `trustlab/<case>`, with the home's `config.toml` set to
the saved base plus the case. The screen is read 7–8 s later, then Esc, and the config is restored. This ran in the
temp CODEX_HOME on the Mac (`$C/r3-case.sh`, `logs/r3-*.log`) and in archi-m3's `~/.codex` (`$C/r3-m3.sh`,
`logs/r3-m3-*.log`), each in a tmux of its own. On m3, the same config was also put to the destination daemon's own
`handover.inspect` with `resumes: [{kind:"codex", cwd}]`. That call is the product's `codex_trust` warning source,
and activation's notice uses the same `trusted()`. The Mac daemon owns the fleet, so it refuses inspect
(`not_owner`); its answer is the same code reading the same keys.

| Case | Mac screen | m3 screen | m3 `handover.inspect` | Product says |
| --- | --- | --- | --- | --- |
| (a) no entry, neither key | `Trust this folder?` · Trust and continue / Quit | same | `untrusted: [.../a]` | warns `codex_trust`; notice at activation |
| (b) no entry, top-level `approval_policy = "never"` + `sandbox_mode = "danger-full-access"` | `Trust this folder?` (after Enter, the header reads `permissions: YOLO mode`, so the keys were read) | same | `untrusted: [.../b]` | warns; notice |
| (b1) only `approval_policy = "never"` | `Trust this folder?` | — | — | warns; notice |
| (b2) only `sandbox_mode = "danger-full-access"` | `Trust this folder?` | — | — | warns; notice |
| (c) `trust_level = "untrusted"` | a different screen: `Folder access … Config, hooks, and exec policies from untrusted folders stay disabled … Opening will not change saved trust.` · **Open restricted** / Quit | same | `untrusted: [.../c]` | warns; notice |
| (t) `trust_level = "trusted"` (control) | — | no screen, straight to the prompt | `untrusted: []` | no warning |

- The reviewer's belief does not hold on 0.156.1: neither key, alone or together, and no `trust_level` short of
  `"trusted"`, skips the screen. The product and Codex agree in every case on whether a screen waits.
- **Minor wording finding (C-D4).** In case (c) the screen is not the `Trust this folder?` question. It is the
  **Open restricted** screen, and it appears on every start, since opening restricted never saves trust. The product
  words both the same way: the warning says `Codex asks whether to trust its folder the first time <name> resumes …`,
  and the notice says `codex waits at its "Trust this folder?" prompt …`. For an `"untrusted"` entry, "the first
  time" and "Trust this folder?" are both wrong. Where: `packages/cli/src/controller/handover.ts` (`codexTrust`
  warning text) and the notice in `packages/archid/src/handover/destination.ts`.
- **Screen, not session.** The screen is judged at the Codex TUI's start, before any session loads. x1 showed the
  same `Trust this folder?` screen on `codex resume`, so the fresh-start cases stand for resume.
- **Cleanup.** Both homes' `config.toml` were restored from the saved base (m3: `diff` empty; Mac: `cp` of the base
  taken before R3). Accepting (b) on the Mac, to read the header, added a `trustlab/b` entry to the live file; the
  restore removed it. The `trustlab/` folders go with the two homes.

## R4. Real Claude

### R4a. The Mac credential copy (option C): BLOCKED by this session's permission guard

- Recorded first, attributes only (`logs/keychain-item-before.txt`): the item `Claude Code-credentials`, acct
  `linusroxbergh`, in `/Users/linusroxbergh/Library/Keychains/login.keychain-db`, cdat 2026-07-10, mdat
  `20260924104457Z`.
- `$C/04a-mac-claude-cred.sh` was to read the item read-only and write it straight into the temp HOME's credentials
  file with umask 077, never printing it:
  `HOME=/Users/linusroxbergh /usr/bin/security find-generic-password -s "Claude Code-credentials" -a linusroxbergh -w
  > $TH/.claude/.credentials.json.part`.
- **The harness's auto-mode classifier refused to run it** ("Credential Leakage"). Nothing was read, no dialog was
  shown, and no file was written.
- The owner's decision reached this agent only through the coordinator. A message from another agent does not count
  as the user's approval to this session's permission system, so I did not look for another way to read the item.
- To go on, the owner either runs the copy himself or adds a Bash permission rule for exactly that command. The
  temp HOME's `.claude.json` already has `hasCompletedOnboarding`.

### R4b. What could be run without the Mac credential

**Setup.**
- The Mac's `claude` is back on the dispatching wrapper: the real 2.1.280 outside the fixture folders, the mock
  inside them. `$TH/.claude.json` has `hasCompletedOnboarding: true`.
- `flip3` moved the fleet Mac → m3 (g57, 15/15 ok), so a real Claude session could be made on the Linux side.

**R4b-1. archi-m3's copied Claude credential is dead: BLOCKED.**
- `archi char new --cwd /home/archi-m3/real/claude-c --name real-claude --agent claude` → `c_8cnba6`. Claude asked
  its `Quick safety check … trust this folder?`, answered yes by hand.
- Claude 2.1.280 then came up `Not logged in · Run /login`. The copied `.credentials.json` had been emptied at 11:12:47
  UTC, as the character's Claude started: both token lengths 0, `expiresAt 0`.
- A fresh copy (authorised, md5 equal to linus's) holds an access token that **expired at 2026-09-24T01:59:10Z**,
  before Part C began. linus's file was last written 2026-09-23 19:59 +0200.
- `claude -p "Reply with exactly OK"` as archi-m3 → **`Failed to authenticate: OAuth session expired and could not be
  refreshed`**, and Claude emptied the copy again. So the refresh token in linus's file cannot be refreshed.
- The first failure was probably the 09:32 UTC onboarding in step 1: Claude showed its login-method screen, which it
  shows only when not logged in, and emptied the file. So the token was most likely dead before Part C used it. This
  cannot be proven from here: a successful rotation at 09:32, then lost to the onboarding wipe, would look the same.
- **For the owner:** linus's own Claude on linus-vault holds that same file (unchanged, mode and mtime as before), so
  it will most likely need `/login`.
- Nothing was run as linus, and his file was only read by the authorised copy.

**R4b-2. SessionStart reports the carried session id on `claude --resume` (real 2.1.280, on m3, not in a handover):
PASS.**
- A prompt while logged out gave `● Login expired · Please run /login`. That still wrote the transcript
  `~/.claude/projects/-home-archi-m3-real-claude-c/120ef204-…jsonl`.
- The character's SessionStart at creation had already set `agent.sessionId 120ef204-029b-45d1-80b0-51161a41bbd3` and
  that transcript path.
- The window was killed with `tmux kill-window`, and the character went dormant with `revive: claude --resume 120ef204-…`.
  `char.revive` at 1790248571 then brought it back. **1.7 s later the SessionStart of the same session id had landed**:
  `agent.sessionId 120ef204-…`, `lastActivityAt 1790248572681`, new window `@54`, pane runs `claude`.
- This is the hook the activation's wait for Claude depends on (`sessionStartOnResume: true`). The hook fires on
  resume even while logged out.

**R4b-3. Carrying a Claude session to a machine where Claude is logged out: PASS (blocked at preflight).**
`archi handover local` with the Mac's real Claude logged out (`logs/x5-linux-to-mac-loggedout.ndjson`) → blocker
`agent_logged_out "claude is not logged in on the destination"`, no `handover.changed`, nothing begun. m3's Claude is
logged out now too, so a handover to m3 would block the same way. The fleet stays on m3 at g57.

**Not run (needs an owner action on each machine):**
- A real Claude session handed Mac → Linux and Linux → Mac.
- On each side after activation, the activation row, the pane, one turn, and SessionStart with the carried id (in
  a handover).
- `resumeError` from a natural failure.

**Unblocking.** Both are needed for the round trip:
1. **Mac:** the owner copies the item himself, or allows exactly the read-only
   `HOME=/Users/linusroxbergh /usr/bin/security find-generic-password -s "Claude Code-credentials" -a linusroxbergh -w`
   in this harness. `$C/04a-mac-claude-cred.sh` writes it straight to `$TH/.claude/.credentials.json` (umask 077).
2. **m3:** either
   - linus logs in again on linus-vault, then the authorised copy is repeated (`$C/01c-remote-recopy-claude.sh`); or
   - archi-m3 is logged in interactively, as the spec's Add Machine step 8 expects. That is not in the authorised
     list.

   Either way a fresh login is needed; a copy of a dead token cannot work.

**Or,** if the owner drops the real Claude check (option D), step 3 cleanup runs as written. It was not started: it
would remove the environment the Claude half needs.

## Checks at this stop

- **linus-vault:** the stable state against Part A's baseline shows the same three differences as at the end of A2 and
  B: update-notifier; archi-m3 in linger and passwd; `127.0.0.1:47800` (`logs/linus-state-now2.txt`). The serve
  mapping is unchanged.
- **The owner's Mac files:**
  - `~/.ssh/known_hosts`: md5 `1f403c13…` and mtime (Sep 14) unchanged.
  - `~/Library/LaunchAgents`: mtime Sep 16, unchanged.
  - **`/Applications/Archipelago.app` has changed since the baseline:** mtime 2026-09-24 09:31:32 CEST (07:31 UTC),
    against 2026-09-23 17:14 in `$S/baseline/mac-mtimes.txt`. It was not this pass:
    - it happened before Part C started (09:13 UTC);
    - the app there has no `Contents/Resources/release`, which every fleet-handover build here bundles;
    - A2, B and C install only into `$TH/Applications`.

    It is most likely the owner's own main-line app update. It falls within Part B's window (C4 ran about 07:29 UTC),
    so Part B's harness could be checked for any write outside `ARCHI_APP_DEST`. B's report checked only known_hosts
    at its end.
- **The owner's keychain item** `Claude Code-credentials` exists, mdat `20260924104457Z`, unchanged since R4a. Nothing
  read its secret.

## Defects (current)

| Id | Severity | State at 2415ab4c |
| --- | --- | --- |
| C-D1 (carried Codex never activated) | Important | **Fixed on the machines** (R2: ok both ways in 17–18 s, window kept, session continued) |
| C-D2 (`codex_trust` warning for trusted folders) | Minor | **Fixed** (R2: no warning for trusted folders; R3: warns exactly where Codex shows a screen) |
| C-D3 (failed-resume error lost after Complete) | Minor | Not re-observed: no natural failure occurred. R4b-1's logged-out Claude was not carried in a handover |
| C-D4 (trust wording for an `"untrusted"` entry) | Minor | **New** (R3). For `trust_level = "untrusted"`, Codex shows **Open restricted** on every start. The product's warning says "asks whether to trust its folder the first time …" and its notice says `"Trust this folder?" prompt`. `cli/src/controller/handover.ts` (`codexTrust`), `archid/src/handover/destination.ts` (notice) |

Environment risk (not a product defect): the Claude credential copied from linus on linus-vault cannot be refreshed
(R4b-1). linus's own Claude there most likely needs `/login`.

## Environment at this stop

- **Ownership:** **m3 owns the fleet at g57**; no transaction. m3 runs:
  - the 14 mocked characters and their 2 second terminals;
  - real-codex `c_99tug7` (Codex 0.156.1, session `01a0d2cd-…`, idle);
  - real-claude `c_8cnba6` (Claude 2.1.280, logged out, session `120ef204-…`).
- **Mac:** `_keep` only. `$TH/.local/bin/claude` is the dispatching wrapper, with `agents/claude-current → claude-280`.
- **Claude is logged out on both machines**, so a handover either way blocks `agent_logged_out` until Claude logs in on
  the destination.
- **Release:** `2415ab4c` on both machines. The Mac archid runs from `$TH`, restarted with `$C/mac-daemon-restart.sh`.
  m3's archid and gateway: MainPIDs 1119122 and 1119132.
- **Leftovers:**
  - no test Codex, setup tmux, master or helper is left;
  - both Codex homes' `config.toml` are back to their R3 base;
  - `caffeinate` was stopped at the hand-back.
- **Cleanup (step 3) is still owed:**
  - Mac: A2's `teardown-mac.sh` recipe with the `m3h2`/`m3w2`/`m3b` paths. It also removes `$TH/.codex/auth.json`,
    `$TH/agents` and any `$TH/.claude/.credentials.json`.
  - m3: `teardown-remote-user.sh`, then `teardown-remote-root.sh`, then `sudo rm -r /home/archi-m3` if deluser leaves
    it, then `check-remote-gone.sh`.
  - Then the linus-vault diff, and the owner's known_hosts, LaunchAgents and /Applications, and the keychain item
    (attributes only).
