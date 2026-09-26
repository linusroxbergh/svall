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
