# M3b fix wave: review

Commits `7bfb1666..1a07a72c` (m1 `69b5411b`, G1 `1a07a72c`). Brief `m3b-fixes-review-brief.md`.

**Verdict: Needs fixes.** Findings: 1 Critical, 0 Important, 2 Minor.

The product changes are right:
- Claude's `trusts` matches what 2.1.283 does.
- The `claude_trust` warning, the ~3 s activation with its notice, and the binding SessionStart all work.
- m1 leaves the running daemon's log alone.
- Every new test fails without its change.

The one blocker is in a test. It deletes the real `~/.claude` and `~/.claude.json` when it runs outside the root vitest config.

`$SP` = `/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/3739c9b8-51d0-4aa6-ac32-19bc0b56eee0/scratchpad`.
- My scratch copy and runs are in `$SP/rv-m3b` (`runs/reverts.txt`, `runs/mutants.txt`, `runs/full.txt`, `runs/typecheck.txt`).
- Nothing in the worktree changed apart from this file.

## Findings

### Critical

**C1. `sessions.test.ts` deletes the real `~/.claude` folder and `~/.claude.json` when run without the root config.**

Where: `packages/archid/test/handover/sessions.test.ts:195-216`.
- The test writes into `path.join(os.homedir(), '.claude')` and `~/.claude.json`.
- Its `finally` then runs `fs.rmSync(home, { recursive: true, force: true })` and `fs.rmSync(beside)`.
- Only `test/isolate.ts` moves HOME. It is a setupFile of the root `vitest.config.ts:15`, and `packages/archid` has no config of its own.

Evidence (the scratch copy, with HOME pointed at a sentinel folder):
- Before the run, the sentinel HOME held `.claude/projects/-Users-x-proj/transcript.jsonl` and `.claude.json`.
- I ran `pnpm --filter @archipelago/archid exec vitest run test/handover/sessions.test.ts -t "reads ~/.claude.json"`. That is the invocation the memory notes agents have used.
- The run reported **1 passed**, and the sentinel HOME was left empty: both `.claude/` (transcript included) and `.claude.json` were gone.
- Against the owner's HOME, that is every Claude transcript, memory folder, setting and hook, plus the global config. The run still reports green.

Fix:
- Stub HOME to a temp folder at the start of the test (`vi.stubEnv('HOME', tmp())`), derive `home` and `beside` from it, and call `vi.unstubAllEnvs()` in `finally`. This works because `claudePaths()` reads `os.homedir()` on each call, and that follows HOME.
- At minimum, first assert `os.homedir().startsWith('/tmp/archi-home-')`, as `cli.test.ts:96,135` do.
- Related, but not in this diff: `daemon.test.ts:184-187` overwrites `~/.claude/CLAUDE.md` and `.credentials.json` with the same exposure.

### Minor

**m-a. Answering Claude's preselected "No, exit" after the notice leaves the character a bare shell, without its session.**
- `destination.ts:578-583` writes an ok row with the notice. From then on `carrying()` is false (`destination.ts:673-678`).
- If the user takes the preselected "No, exit", claude exits to the shell.
- The fleet's tick then deletes the slot's agent after two shell polls (`fleet.ts:352-358`). The revive that opened the window had already cleared `revive` (`fleet.ts:752`).
- The result: no agent, no revive and no `resumeError`. The session comes back only through `claude --resume` or `--continue` typed by hand.
- Before this wave, the same slot stayed dormant with its revive and error.
- The spec's "Failure and recovery" says characters that fail to resume "remain dormant with their transcript and a visible error".

Fix: keep a slot whose row carries a notice watched until its SessionStart binds. If its pane returns to the shell first, lay it dormant with its revive and a `resumeError` naming the answer, for example `claude exited at its trust prompt; revive it and choose "Yes, I trust this folder"`. The bypass prompt under item 4 needs the same, since its preselected answer is also "No, exit".

**m-b. Keys are compared without Claude's NFC normalisation.**
- `claude.ts:33-46` compares `realPath()` output with the config's keys byte for byte.
- 2.1.283 normalises the cwd it looks up to NFC (`function xn(t){return t.normalize("NFC")}`, used by `oS`, `Nce` and `iS`), and so the keys it writes too.
- On macOS, a folder whose name is stored decomposed reads as untrusted. That covers names with å, ä or ö created through Finder or Cocoa, or migrated from HFS+.
- The effect is a false `claude_trust` warning on every handover. It also gives a false notice whenever that Claude's SessionStart takes longer than the 3 s settle.
- It only over-warns.

Fix: `.normalize('NFC')` each candidate key in the walk and `realPath(folder.repo)`.

## Item 4: prompts that still stall activation

**Recommendation: a general activation rule, plus one preflight warning (bypass).**

1. **General rule.** A kind that reports SessionStart on resume (Claude) should watch its pane during the wait, as `settles()` (`destination.ts:615-645`) already does for Codex:
   - **SessionStart arrives:** started, as now.
   - **Pane back at the shell, window gone, or no claude:** failed, and dormant with its revive and `resumeError`. This fails at once instead of at 60 s.
   - **claude holds the pane N s with no SessionStart:** up. The row is ok, the window stays, and the notice reads e.g. `claude has not started its session in bo's terminal and may be waiting at a prompt there; answer it there`. The trust notice stays when `trusts` is false.
   - **N ≈ 10 s.** A trusted SessionStart measured ~1.8 s, and prompts appear at ~2.3 s. 60 s ties up a pool worker and ends with the window closed.

   Implementation: parameterise `settles()` by settle time and notice, and route `reports` kinds through it. Pair it with m-a.

   This covers:
   - the unapproved `.mcp.json` server;
   - the bypass warning;
   - parent-only trust with project permissions;
   - any later prompt that comes before SessionStart;
   - the report's concern 3 under-warn (a second terminal in another checkout);

   and none of it needs Claude's settings modelled.

2. **Preflight: warn only for bypass.** Warn when a carried Claude revive command holds `--dangerously-skip-permissions` (F3 keeps it) and the destination's Claude has not accepted bypass mode.
   - The bundled JS gates bypass on `le().bypassPermissionsModeAccepted`, which lives in the same `.claude.json` `trusts` reads, plus a second check, `n1t()`.
   - The settings schema describes `skipDangerousModePermissionPrompt` as "Whether the user has accepted the bypass permissions mode dialog".
   - Confirm on the binary which of the two suppresses the prompt.
   - It is worth a warning because the preselected answer is "No, exit".

   No warning is needed for:
   - **MCP approvals.** They are spread across user, project and local settings and the `.claude.json` project entry. The preselected "Continue without using this MCP server" does no harm.
   - **Parent-only trust with permissions.** It needs a parent key set by hand or inherited, because Claude's own "Yes" writes the checkout's key. The preselected "No, continue without these permissions" does no harm.

   The general rule catches both at activation.

3. **Spec.** "Characters that fail to resume remain dormant with their transcript and a visible error." A Claude alive in its pane at a prompt has not failed to resume. Part C's ruling already reads the spec this way for Codex: "A slot whose process exits or never appears within the wait still fails" (`m3-onmachine-C-fixes.md` Q1). So the rule is allowed on two conditions:
   - the row carries a visible notice;
   - an agent that exits before its SessionStart still ends dormant with its revive and error.

   Today the second condition holds only inside the wait (m-a).

4. **Codex today, in the same situation:**
   - Every Codex resume goes through `settles()`: codex holding its pane for 3 s counts as up and keeps its window.
   - A notice is added only when `codex.trusts` is false. So a Codex stopped at any other prompt is `ok` with no notice.
   - A Codex that exits back to its shell, or never comes up, within the wait is failed and dormant with its error.
   - Codex never waits 60 s on a live agent. The rule brings Claude to the same behaviour, and adds the notice Codex lacks.

## Verified clean

**G1 `trusts` against the binary.** I read 2.1.283's bundled JS (`$SP/g1/js.txt`).
- `iN()` trusts when `CLAUDE_CODE_SANDBOXED` is set. Otherwise it trusts `projects[MTe()]`, which is the main checkout, or the cwd outside a repository.
- Otherwise `oS()` walks from the NFC cwd up to the git root holding it (`iS` stops at `r`), or up to `/`. Keys match exactly.
- `Lo()` reads `<config dir>/.config.json` when it exists. Otherwise it reads `.claude.json` in `CLAUDE_CONFIG_DIR || homedir()`.
- `claude.ts` agrees on all of these: the main-checkout key, the walk bounded by `root`, real paths, `CLAUDE_CONFIG_DIR`, the legacy file, and `~/.claude` → `~/.claude.json`.
- Where it differs, it only over-warns:
  - `CLAUDE_CODE_SANDBOXED`;
  - Claude takes any truthy value, the adapter only `true`;
  - NFC (m-b);
  - a `.claude-<suffix>.json` used only with a custom or non-prod OAuth URL (`w3()`).
- `resumeFolder` sets `repo` and `root` together (`registry.ts:91-95`). The primary terminal's `c.repo` follows its cwd (`links/refresh.ts:35,58`).

**Preflight.**
- Every kind's folder goes to `inspect` with its `root`.
- The warnings come per kind (`handover.ts:159-172,888-889`) and are de-duplicated by `settle`.
- The CLI message and the sheet hint name "No, exit" and "Yes, I trust this folder".

**Activation.**
- `reports = sessionStartOnResume && trusted` (`destination.ts:560-561`).
- An untrusted Claude goes through `settles()` and is up after holding its pane 3 s. The unit test asserts ≤5 s on the fake clock, the kept window, the notice, and no `kill`.
- A SessionStart after the row finds no waiter and no carried terminal, so the fleet's reducer binds its pid and transcript. The real-tmux test shows this with a real `Fleet`.
- A trusted folder keeps the 60 s wait and its error (`destination.test.ts:836`).
- No `await` falls between `settles` returning and `recordSlot`, so no hook can land in between.

**Protocol 17, the `{kind, cwd}` shape: safe.**
- The controller calls `inspect` even when releases differ (`handover.ts:229,821-838`).
- The client does not validate results (`client.ts:128-143`). So a mismatched peer yields no trust warnings rather than an error.
- `incompatible_release` (`source.ts:65`) blocks that preflight anyway.
- An old daemon's non-strict `ResumeFolder` strips `root`.
- No bump is needed.

**m1.**
- The lock comes before any read or write of the home (`main.ts:95-99`). Both locks throw `AlreadyRunning`, and `bin.ts:43-46` writes only stderr and exits 1.
- On Linux the unit's own log is separate (`linux/setup.ts:41-42`).
- Under launchd, `StandardErrorPath` is the fleet's `archid.log` (`setup.ts:140-141`). But launchd runs one instance per label, and even there the refusal is now one line, not a stack.

**Tests fail without their change.** Each revert or mutant ran in the scratch copy, and the file was restored and compared afterwards.

| Change reverted or mutated | Fails |
| --- | --- |
| `claude.ts` (no `trusts`) | 5: both sessions trust tests, Claude inspect, unit and real-tmux trust activation |
| `destination.ts` | 4: Codex and Claude inspect, unit and real-tmux trust activation |
| cli `handover.ts` | 3: both trust preflight tests and the roots/differences test |
| web `handover.ts` | 1 |
| `registry.ts` (no `root`) | 2: both cli trust tests |
| `bin.ts` and `main.ts` | 2: the new bin test and home-lock |
| no main-checkout key | 2 |
| walk past the checkout (both bounds removed) | 2 |
| no realpath of cwd | 1 |
| no legacy `.config.json` | 1 |
| `~/.claude` layout reading `<home>/.claude.json` | 1 |
| notice without `up === 'running'` (the "guard" test) | 4 |
| bin also logs the refusal | 2 |
| no `trustAnswer` | 2 |

Scope:
- One commit per item, with plain subjects and no attribution.
- Nothing goes wider than the items. The `fleet-home` ELSEWHERE entry and the prepare-test expectation follow from the scene's Claude config.
- Comments stay within 1–2 lines.

**Suites.**
- `pnpm typecheck`: exit 0.
- `pnpm vitest run --project protocol --project archid --project cli --project @archipelago/desktop-web`, run in the scratch copy: 2965 passed, 5 skipped and 1 failed.
  - The failure is `cli.test.ts` "prints the commit it runs from for --version" (`expected 'unknown\n'`), because the copy has no `.git`.
  - That test passes in the worktree. That makes 2966 passed and 5 skipped, as reported.

## Fix round 1

Commits `a519b7e7..30b8e445`: C1 `f78bd73d`, R1 `75098fca`, R2 `beee7781`, R3 `b3fa3ada`, R4 `30b8e445`. Findings
`m3b-fix1-findings.md`, report `m3b-fix1-report.md`.

**Verdict: Needs fixes.** Findings: 0 Critical, 2 Important (one pre-existing, outside the round), 2 Minor.
- All five items are addressed.
- Each fails without its change.
- Each commit stays within its item.
- No test file writes under the home, however it is run.
- The blocker is C1's own guard test. It fails whenever the suite runs outside an AI-agent shell.

The runs are in `$SP/rv-m3b`: `runs/fix1-reverts.txt`, `runs/rootcfg-all.json`, `runs/nocfg-*.json`, `perfile/`, and `sent-*.txt`. The worktree is unchanged apart from this section.

### Important

**I1. C1's guard test fails in a plain terminal and in CI** (`packages/archid/test/isolate.test.ts:26-28`).
- The child vitest gets `CI: '1'`. std-env then turns colour on, so its summary reads `Test Files \x1b[22m \x1b[1m\x1b[32m1 passed…`, and `/Test Files +1 passed \(1\)/` fails.
- It passes only where vitest detects an AI agent (`CLAUDECODE` or `AI_AGENT`), whose reporter prints no colour. That is why it passed for the implementer and in my agent shell.
- Evidence (scratch copy, `vitest run packages/archid/test/isolate.test.ts` under `env -i`):

  | Environment | Result |
  | --- | --- |
  | `TERM=xterm-256color TERM_PROGRAM=ghostty` | 1 failed |
  | minimal | 1 failed |
  | `+ CLAUDECODE=1` | 2 passed |
  | `+ AI_AGENT=…` | 2 passed |
  | `+ NO_COLOR=1` | 2 passed |

  So the owner's own `pnpm test` in Ghostty goes red on this test.
- Fix: `NO_COLOR: '1'` in the child env. Or drop the stdout match, and check the exit code with `--reporter=json`.

**I2 (pre-existing, not from this round). The suite runs whatever `claude` and `codex` are on PATH.** On this Mac, those are the real `~/.local/bin/claude` → 2.1.283 and `~/.local/bin/codex`. `test/isolate.ts:9-11` gives doubles only for `gh` and `tailscale`.

I ran every archid and cli test file alone, with logging `claude`/`codex` doubles first on PATH. Two files called them:
- **`ownership.test.ts`** starts real daemons (`main.ts:145` `agentProber(realProbeDeps())`). They run `claude --version`, `claude auth status`, `codex --version` and `codex login status`.
- **`fleet.test.ts:143-167`** spies on `tmux.sendLine` but calls through. So `claude --resume 3f2b8c1e-… --add-dir '/tmp'` is typed into a real tmux pane.
  - On this Mac that starts Claude Code under isolate's temp HOME, but with the user's login keychain, which is not under HOME.
  - A plain `claude --resume …` pane also comes up.

This breaks the standing "never run the real claude or codex" rule for every suite run, mine included:
- My first-review full run used the normal PATH.
- The implementer's runs did the same.
- This round's runs used the doubles.

Fix: `isolate.ts` puts `claude` and `codex` doubles in its `bin`, as it does for `gh`, answering `--version` with a supported release.

### Minor

**m1. For Codex, R1's watch lasts until the first turn** (`destination.ts` `watch`). Codex sends its SessionStart with the session's first turn, not on resume (Part C Q1). An untrusted Codex counted up at its trust prompt is therefore watched until the user's first prompt in that terminal. That has two effects:
- A user who answers the prompt and then quits codex before prompting gets:
  - the window closed;
  - the character laid dormant;
  - an error telling them to trust the folder they just trusted.
- Every such terminal gets a tmux listing and a full `ps` every 2 s, for as long as it stays unprompted.

Fix: in the loop, end a trust-prompt watch once `this.trusted(folder)` holds, since the prompt was answered "Yes".

**m2. The watch's error always names the trust prompt, even when a later prompt was the one exited.** An untrusted Claude that resumes with `--dangerously-skip-permissions` has two prompts before its SessionStart: the trust prompt and the bypass warning (I inferred this from the code and the probes; I did not run it). If "No, exit" is taken at the bypass warning, the error still says `revive it and choose "Yes, I trust this folder" at its "Trust this folder?" prompt`. The recovery (revive) is right; only the guidance is wrong.

Fix: word the error generically once trust holds (`revive it and answer its prompt`), or name the bypass warning when `bypass` is set.

### The implementer's concerns

1. **Watch in memory: accept for now.**
   - The gap needs an archid restart while tmux lives, between activation and the user's answer, followed by "No, exit". It is the pre-round outcome: a bare shell, with the transcript intact.
   - A reboot is fine: tmux dies too, and the restart lays the slot dormant with its revive.
   - A durable fix needs a persisted marker on the slot, e.g. an optional `resumePending: <sessionId>`. SessionStart would clear it, and the fleet's two-poll shell streak would lay the slot dormant with its revive instead of dropping the agent. That is an additive state field, worth doing only if restarts mid-handover prove common.
2. **Managed settings unread: accept.** It only over-warns: preflight shows a false `claude_bypass`, and activation still gets the SessionStart with no notice. Reading `/Library/Application Support/ClaudeCode/managed-settings.json` (or `/etc/claude-code/managed-settings.json`) would be two lines, but it can't be checked against the binary without root.
3. **Slow trusted Claude gets the quiet notice: accept.** The text is hedged ("may be waiting at a prompt"), the window stays, and the SessionStart ends the watch. The owner's machine is often loaded, so expect the notice on the occasional slow start.

### Items: verified

**C1.**
- `sessions.test.ts` stubs `HOME` and clears `CLAUDE_CONFIG_DIR`, then unstubs. Its `finally` removes nothing under the home. R3's bypass test does the same.
- `test/helpers.ts:14` has thrown at import off an isolate home since `93acd830`. That covers `daemon.test.ts`, `cli.test.ts` and `client.test.ts`, so my first-review note on `daemon.test.ts` does not hold.
- Dynamic check. The sentinel HOME held `.claude/{settings.json,CLAUDE.md,.credentials.json,projects/…}`, `.claude.json`, `.codex/*`, `.archipelago*/*`, `Library/*`, `.local/*`, `.ssh/*`, `.config/archipelago/*` and dotfiles. It was compared by name, size, mtime and mode after each run:
  - archid and cli run from their package folders with no root config (no isolate): 33 and 22 files ran, 491 and 247 passed;
  - all 193 files of every project under the root config;
  - each of the 117 archid and cli files alone.
  - In all three, no test changed the sentinel.
  - The only write was the vitest runner's own `Library/Application Support/vitest/.vitest-secret-token` (vitest's API token, `index.DzobfTyw.js`). That is the runner, not a test, and every `pnpm test` writes it into the real `~/Library`.
- `sessions-live.test.ts` is the one deliberate exception. It uses `os.userInfo().homedir` and the real CLIs, but only with `ARCHI_LIVE_REMOTE` set.

**R1.**
- The watch starts before the row is written, with no `await` in between.
- `carrying()` is true while watched, so the fleet's shell streak (`fleet.ts:352-358`) leaves the agent alone.
- A carried SessionStart ends the watch, and the fleet still binds it (`onSocketEvent` applies hooks whatever `carried` says).
- A shell or a closed window ends it with `lay(s, carried)`, which restores the flagged revive, and a `resumeError`. `recordSlot` writes the record even after Complete.
- A later handover's `restedBy` ends it.
- The error on the journal row flips to `ok: false`, so a retried activation would wake that slot again. That is acceptable.

**R2.**
- Every resume goes through `settles()`:
  - a trusted Claude gets 10 s;
  - an untrusted Claude and Codex get 3 s;
  - "never came up" is still bounded by `sessionStartMs`.
- A SessionStart inside the settle is `started`, with no notice, whatever the pane reads as. So a Claude that ProcessTable misreads still works.
- Error texts now name what the pane showed.

**R3.**
- The rule matches the 21-case cross-check against the binary (`$SP/r3/logs-r3-crosscheck.txt`, `mismatches: 0`):
  - the config's `bypassPermissionsModeAccepted`;
  - the config folder's `settings.json`;
  - `settings.local.json` of the cwd or of the main checkout.
- `asksBypass` covers the switches `startFlags` keeps, plus `--permission-mode 'bypassPermissions'` (`shq` always quotes).
- The controller warns only resumes that carry `bypass`.
- `bypass` and `bypassWarned` are optional. An old daemon strips `bypass`, and the release check blocks that pairing anyway.
- Nit, over-warn only: the local-settings half reads the destination's copy at preflight, before the carried root lands.

**R4.**
- `trusts` composes the cwd, each parent, the main checkout and the top to NFC.
- The decomposed-name test fails without it.

**Failing first.** Each commit's tests ran against that commit's tree, with its own source reverted to its parent (`revert2.py`):

| Item | Fails | Failures |
| --- | --- | --- |
| C1 (sessions.test reverted) | 1 | `ENOENT … archi-sentinel-…/.claude` |
| R1 | 3 | unit ×2, real tmux ×1 |
| R2 | 3 | among them `expected 80000 to be less than or equal to 11000` |
| R3 | 6 | sessions ×3, destination, controller, web |
| R4 | 1 | `the folder itself: expected false to be true` |

The copy was confirmed equal to the worktree afterwards.

**Scope.**
- One commit per item, with plain subjects and no attribution.
- R3's `fleet-home.test.ts` entry (`settings.json`) follows from `acceptsBypass`.
- Comments stay within 2 lines.

**Suites** (scratch copy at HEAD, logging `claude`/`codex` doubles on PATH).
- `pnpm typecheck`: exit 0.
- Root config under the sentinel HOME, four projects: protocol 137, archid 1578, cli 542, web 718, so 2975 passed and 3 failed.
  - The three failures:
    - `isolate.test.ts` (I1; `env -i` has no agent variable);
    - `cli.test.ts --version` (the copy has no `.git`);
    - `ssh.test.ts` spawn count, a known load flake that passes alone (24 passed, 1 skipped).
  - That makes 2978, as reported.

## Fix round 2

Commits `6773202b..039b2130`: I1 `57cf032a`, I2 `b242977e`, m1 `95721d4d`, m2 `039b2130`. Findings
`m3b-fix2-findings.md`, report `m3b-fix2-report.md`.

**Verdict: Approved.** Findings: 0 Critical, 0 Important, 2 Minor.
- All four items are addressed.
- Each fails without its change.
- Each commit stays within its item.
- No test ran a claude or codex other than isolate's doubles, and the guard test passes with no agent variables.

About my runs:
- Every run had my own logging `claude`/`codex` stubs (exit 97) first on PATH, with `~/.local/bin` left off PATH. The real CLIs were never run.
- The runs are in `$SP/rv-m3b`: `runs/r2-*.json`, `runs/r2-reverts.txt` and `stub2-*.log`.
- The worktree is unchanged apart from this section.

### Minor

**n1. Inside tmux panes, isolate's doubles come after the system paths.**
- Tests' tmux servers start their shell as a login `-sh`. Its `/etc/profile` runs `path_helper`, which moves `/usr/local/bin`, `/usr/bin`, … `/pkg/env/global/bin` and `/Library/Apple/usr/bin` in front of the inherited PATH.
- In a scratch tmux, a pane given `PATH=/tmp/isolatebin:…` got `/tmp/isolatebin` 12th.
- On this Mac this is harmless. `/usr/local/bin/claude` is a dangling link (→ `~/.claude/local/claude`), so `fleet.test.ts`'s typed resume still reaches the double, and the full run below logged no stub call.
- On a machine with a live `claude` or `codex` in `/usr/local/bin` (Intel Homebrew, an npm prefix of `/usr/local`), that typed `claude --resume …` would run the real CLI.
- Fix: `isolate.ts` writes `<home>/.profile` with `PATH="<bin>:$PATH"; export PATH`. The login `sh` reads it after `/etc/profile`. Checked in a scratch tmux: the bin comes first again.

**n2. The `watch` JSDoc is 4 lines** (`destination.ts:625-630`), against the delivery rule of 1–2. Trim it to what the code can't show: the watch ends at SessionStart, or at trust for an agent that starts no session until its first turn.

### Items: verified

**I1.**
- The child gets `NO_COLOR: '1'`.
- The plain-environment full run below passes all three `isolate.test.ts` tests. That run had no `CLAUDECODE`, `AI_AGENT` or `CLAUDE_CODE*`, with `TERM=xterm-256color TERM_PROGRAM=ghostty COLORTERM=truecolor`.

**I2.**
- `test/isolate.ts` puts `claude` and `codex` doubles in its bin. They answer:
  - a supported release;
  - logged in;
  - a failed resume with the real CLIs' texts.
- The new test checks by reading PATH, before anything runs, that both resolve into the isolate home. Run without the root config, it fails at its HOME assertion before spawning anything.
- `sessions-live.test.ts` stays behind `ARCHI_LIVE_REMOTE`, with isolate's bin filtered out of its PATH. I checked this by reading only; I did not run it.

**Proof that the full suite calls no claude or codex outside isolate's doubles.** My logging stubs were first on PATH, with no agent variables:

| Run | Result | Stub calls |
| --- | --- | --- |
| root config, all 193 files | 3006 passed, 1 failed, 5 skipped | none |
| archid and cli run from their package folders, no root config | 492 and 247 passed; the new isolate test fails at its HOME assertion | none |

- The one failure in the root-config run is `cli.test.ts --version`: the copy has no `.git`.
- The sentinel HOME was unchanged after both runs.
- With `test/isolate.ts` reverted, the same stubs caught 6 calls from `ownership.test.ts` and `fleet.test.ts`: `claude --version`, `claude auth status`, `codex --version`, `codex login status`, and two typed `claude --resume 3f2b8c1e-…`.

**m1: agree with ending the watch at trust for Codex only.**
- The split follows the adapter's `sessionStartOnResume`, not a kind name, which is the right discriminator.
- **Claude:** its SessionStart comes ~0.5 s after the answer. Keeping the watch until then is what covers a later prompt that preselects "No, exit" (the bypass warning), which is why R1 exists. It costs a few looks.
- **Codex:** it starts no session until its first turn, so without an end at trust the watch runs indefinitely.
- **What is left for Codex:**
  - A Codex that quits after trusting and before its first prompt goes back to the fleet's two-poll shell streak. The result is a bare shell with the transcript intact. That quit is deliberate, and none of Codex's own prompts preselects an exit.
  - A Codex whose user answers its trust prompt "No" never becomes trusted, so it is still watched until its first turn, as in round 1. That is rare and acceptable.
- The re-read of trust on each look goes through the probe cache (`agents()`, 60 s TTL).

**m2.**
- Once `trusted(asked)` holds, the error ends `revive it and answer the prompt it waits at`.
- "No, exit" at the trust prompt itself writes no trust, so it keeps the trust wording.
- R2's quiet watch keeps `revive it to see`.

**Failing first.** Each commit's tests ran on that commit's tree with its change reverted to its parent, in the plain environment with the stubs (`revert3.py`):

| Item | Failures | Stub calls |
| --- | --- | --- |
| I1 | the guard test: ANSI `RUN` for `Test Files +1 passed` | none |
| I2 | the doubles test, and the six real-CLI calls above landed in my stubs | 6 |
| m1 | 1: still carried after trust | none |
| m2 | 1: the `resumeError` named the trust prompt | none |

The copy was confirmed equal to the worktree afterwards.

**Scope.**
- One commit per item, with plain subjects and no attribution.
- The I2 commit's `sessions-live.test.ts` change is the PATH filter the doubles make necessary.
- Other than n2, the comments stay within 2 lines.

**Suites** (scratch copy at HEAD, plain environment, stubs first).
- `pnpm typecheck`: exit 0.
- Four projects: protocol 137, archid 1582 (2 skipped), cli 544 (3 skipped, one of them the no-`.git` `--version` test), web 718. That makes 2981, as reported.
- The scripts project passes 26.
