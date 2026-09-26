# M3b fix wave, round 2: report

Branch `experimental-remote-sessions`, from FIX_BASE `6773202b`. Four commits, one per item:

| Item | Commit | Subject |
| --- | --- | --- |
| I1 | `57cf032a` | The isolation guard test reads its child vitest's summary without colour, so it passes in a plain terminal and in CI as well as under an agent |
| I2 | `b242977e` | Tests find doubles of claude and codex first on PATH, so a daemon's agent probe and a resume typed into a pane never run the real CLIs |
| m1 | `95721d4d` | A resumed Codex counted up at its trust prompt is watched only until its folder is trusted, since it starts its session only with its first turn |
| m2 | `039b2130` | A resumed Claude that answered its trust prompt and then exits at a later prompt is told to answer the prompt it waits at, not to trust its folder |

`$SP` = `/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/3739c9b8-51d0-4aa6-ac32-19bc0b56eee0/scratchpad`. Runs and logs: `$SP/fix2`.

Every run in this round had logging `claude` and `codex` stubs (`$SP/fix2/stubs`, exit 97, append to `$SP/fix2/stub-calls.log`) first on PATH, and the owner's `claude` shell function unset. The real CLIs were never run.

## I1: the guard test in a plain terminal

**Change.** The child vitest in `isolate.test.ts` gets `NO_COLOR: '1'` beside `CI: '1'`.

**RED** (`i1-red.txt`), `CLAUDECODE`, `AI_AGENT` and `CLAUDE_CODE` unset, `TERM=xterm-256color TERM_PROGRAM=ghostty`: `expected '\n\u001b[1m\u001b[30m\u001b[46m RUN \…' to match /Test Files +1 passed \(1\)/`.

**GREEN**: 3/3 (with I2's test) with both agent variables unset under the Ghostty-like env, with `FORCE_COLOR=1`, under `env -i` with only HOME, PATH, USER and TMPDIR (`i1-green-envi.txt`), and with `CLAUDECODE=1` or `AI_AGENT=x` alone.

## I2: doubles of claude and codex

**Change** (`test/isolate.ts`). Two shell doubles in isolate's `bin`, beside `gh` and `tailscale`:
- `claude`: `--version` answers `2.1.283 (Claude Code)`; `auth …` answers `{"loggedIn":true}`; any `--resume <id>` fails, exit 1, with `No conversation found with session ID: <id>` on stderr (the text and exit 2.1.283's bundled JS gives for an explicit id it cannot find: `Kn(1)`); anything else fails, exit 1, saying it is a test double.
- `codex`: `--version` answers `codex-cli 0.156.1`; `login …` answers `Logged in using ChatGPT`, exit 0; `resume … <id>` fails, exit 1, with `no rollout found for thread id <id>` (as the Codex fixture README records); anything else fails.

`sessions-live.test.ts`, the one test that needs the real CLIs, stays behind `ARCHI_LIVE_REMOTE`. Its child env drops isolate's `bin` from PATH, so it still finds the real ones when enabled (checked with a throwaway test that the filtered PATH resolves `claude` outside the isolate home; the file was removed). Without the gate it still skips (2 skipped).

**Test** (`isolate.test.ts`, new): "puts doubles of claude and codex first on PATH, a supported release logged in that holds no session to resume".
- It first asserts HOME is an isolate home and that `claude` and `codex` resolve to `<home>/bin`, found by reading PATH without running anything. A run without `isolate.ts` fails there, before anything is spawned.
- Then `probeAgent` through `realProbeDeps()`, as a daemon probes: claude 2.1.283 and codex 0.156.1, adapter 1, logged in.
- Then the two resumes and their exact failures.

**RED** (`i2-red.txt`): the path assertion, `[…/fix2/stubs/claude, …/fix2/stubs/codex]` for `[<home>/bin/claude, <home>/bin/codex]`; nothing ran (stub log empty). **GREEN** (`i2-green.txt`): 3/3.

**Proof nothing reaches the real CLIs.**
- With `test/isolate.ts` put back to `HEAD~` for one run (`i2-before-*.txt`, `i2-before-stub-calls.log`), `ownership.test.ts` and `fleet.test.ts` called the stubs 6 times: `claude --version`, `claude auth status`, `codex --version`, `codex login status`, `claude --resume 3f2b8c1e-… --add-dir /tmp` and `claude --resume 3f2b8c1e-…` (the second from another resume typed by `fleet.test.ts`, cwd `/tmp`).
- With the change: both files pass (26 and 89) and the stubs got no call.
- The full four-project run below also left the stub log empty (no `stub-calls.log` was created).

## m1: a Codex trust watch ends at trust

**Change** (`destination.ts`). A terminal counted up at its trust prompt now hands the watch the folder it was asked to trust (`asked`). On each look, once that folder is trusted, a watch for an agent that sends no SessionStart on resume (`sessionStartOnResume` false, i.e. Codex) ends there, leaving the terminal to the fleet. Claude's continues to its SessionStart (see m2).

**Test** (`destination.test.ts`, new): "stops watching a Codex counted up at its trust prompt once its folder is trusted, since Codex starts its session only with its first turn". Codex silent at its trust prompt, still carried 10 s on; its folder written trusted into `config.toml`; 2 s later no longer carried; no tmux look after that (`listWindows` counted over 10 s); back at bash it is not killed, gets no `resumeError`, and its row stays ok.

**RED** (`m1-red.txt`): `expected true to be false` (still carried after trust). **GREEN**: `destination.test.ts` 75/75.

## m2: the error once trust holds

**Change** (`destination.ts`). The watch reads `trusted(asked)` on each look. If the agent leaves its pane after that folder became trusted, the error ends `revive it and answer the prompt it waits at` instead of naming the trust prompt. "No, exit" at the trust prompt itself writes no trust, so it keeps the trust wording. A watch that never had a trust prompt (R2's quiet one) keeps `revive it to see`.

**Test** (`destination.test.ts`, new): "keeps watching a Claude that answered its trust prompt, and names no trust prompt once it exits at a later one". Revive `claude --dangerously-skip-permissions --resume …`, untrusted; trust written into `.claude.json`; still carried 10 s on (so Claude's watch does not end at trust, as m1's does for Codex); back at bash: dormant with its flagged revive and `… exited back to its shell before that session started, so it is dormant again with that session; revive it and answer the prompt it waits at`, no mention of trust.

**RED** (`m2-red.txt`): `resumeError` was `…; revive it and choose "Yes, I trust this folder" at its "Trust this folder?" prompt`. **GREEN** (`m2-green.txt`): 76/76.

## Verification

At `039b2130`, nvm's Node 24.18.0 on PATH behind the logging stubs, `ARCHI_HOME`, `ARCHI_CHAR_ID`, `TMUX` and `TMUX_PANE` unset.
- `pnpm typecheck`: exit 0 (`final-typecheck.txt`).
- `pnpm vitest run --project protocol --project archid --project cli --project @archipelago/desktop-web`: exit 0, 190 files passed and 1 skipped, **2981 passed and 5 skipped** (`final-vitest.txt`), 3 more than round 1's 2978. The stubs got no call.

## Concerns

1. **m2's wording is generic.** It does not name the Bypass Permissions warning when the revive asks for bypass; "answer the prompt it waits at" covers it and any other startup prompt.
2. **A Codex that quits after answering trust and before its first prompt** is left to the fleet as before R1: two shell polls drop its agent, and its session comes back only by a hand `codex resume`. The review's m1 fix accepts this.
3. **The claude double answers `auth` with only `loggedIn`.** The probe then takes the default config folder, which is what the tests expect; a test wanting `configDirectory` would need its own stand-in.
