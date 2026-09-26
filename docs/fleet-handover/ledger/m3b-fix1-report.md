# M3b fix wave, round 1: report

Branch `experimental-remote-sessions`, from FIX_BASE `a519b7e7`. Five commits, one per item:

| Item | Commit | Subject |
| --- | --- | --- |
| C1 | `f78bd73d` | The Claude config test runs under a HOME of its own, so a runner that does not move HOME leaves the real ~/.claude and ~/.claude.json alone |
| R1 | `75098fca` | A resumed agent counted up at a prompt stays watched until its session starts, and one that exits there first is left dormant with its carried resume and an error |
| R2 | `beee7781` | A resumed Claude that holds its pane silent for ten seconds counts as up at a prompt, its window kept with a notice to answer it there, instead of a minute's wait that ends with its window closed |
| R3 | `b3fa3ada` | Preflight warns where a carried Claude resumes in bypass mode on a destination whose Claude has not accepted that mode, and so opens on a warning with "No, exit" preselected |
| R4 | `30b8e445` | Claude's folder trust is looked up by NFC-composed paths as Claude does, so a folder whose name is stored decomposed gets no false trust warning |

`$SP` = `/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/3739c9b8-51d0-4aa6-ac32-19bc0b56eee0/scratchpad`.
- Test runs: `$SP/fix1`.
- Probes of the real Claude 2.1.283 and their logs: `$SP/r3`.

## What the real Claude 2.1.283 does about bypass mode (R3)

**Setup** as the G1 probes: a copy of `~/.local/share/claude/versions/2.1.283` (sha256 `d8cb1e5c…`) in a scratch HOME (`$SP/r3/home`), a scratch tmux server, `env -i` with `USER=archiscratch` and a scratch `CLAUDE_SECURESTORAGE_CONFIG_DIR`, logged out, a `SessionStart` hook logging each start. The credential exception was not used. The copied binary is deleted and no scratch process or tmux server is left.

**The bundled JS.** The warning is an onboarding step: it shows when the permission mode is `bypassPermissions` or `--allow-dangerously-skip-permissions` is given, unless `YB()`. `YB()` is `skipDangerousModePermissionPrompt` truthy in user, local, flag or policy settings (not project settings). `bypassPermissionsModeAccepted` in the config is read only by a start-up migration, which writes `skipDangerousModePermissionPrompt: true` into user settings and deletes the key. `n1t()` (policy or user settings) gates MCP approval, not this warning. Answering "Yes, I accept" writes `skipDangerousModePermissionPrompt: true` into user settings.

**On the binary** (`logs-r3.txt`, `logs-r3-repo.txt`, `logs-r3-repo2.txt`, `logs-r3-exit.txt`), in a trusted folder:
- The warning ("WARNING: Claude Code running in Bypass Permissions mode", `❯ No, exit` preselected, "Yes, I accept") shows about 2.3 s in for `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` and `--permission-mode bypassPermissions`, also on `--resume`. No SessionStart comes while it waits.
- It does not show when any of these holds `true`:
  - `skipDangerousModePermissionPrompt` in the config folder's `settings.json` (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`; with `CLAUDE_CONFIG_DIR` set, `~/.claude/settings.json` is ignored);
  - `bypassPermissionsModeAccepted` in the config Claude reads (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`); the run moved it into `settings.json` and deleted it, as the JS says;
  - `skipDangerousModePermissionPrompt` in `.claude/settings.local.json` of the cwd, or of the repository's main checkout (for a cwd anywhere in the main checkout or in one of its worktrees).
- It still shows for: either key `false`; `.claude/settings.json` (shared project settings); `settings.local.json` of a folder above the cwd outside a repository, of a folder between the cwd and its checkout's top, or of a worktree's top for a cwd inside that worktree.
- Taking "No, exit" at the warning runs `SessionEnd` with a fresh session id, not the resumed one, so the fleet's reducer leaves the carried agent alone. At the trust prompt no hook runs.
- Not tried: policy (managed) settings, which need root to write; `--settings`, which no revive carries.

**The adapter against the binary.** `claudeAdapter.acceptsBypass`, run through tsx on the same scratch HOME for 21 cases, agreed with the binary on all 21 (`logs-r3-crosscheck.txt`, `mismatches: 0`).

## C1: the test that could delete the real ~/.claude

**Change.** "reads ~/.claude.json for the ~/.claude config folder…" stubs `HOME` to a folder of its own and clears `CLAUDE_CONFIG_DIR`, then unstubs; its `finally` no longer removes anything under the home. The new bypass test that reads `~/.claude.json` does the same.

**Test.** `isolate.test.ts`, new: "leaves the HOME a runner that does not move it gives the tests that write a Claude config". It runs `vitest run test/handover/sessions.test.ts` from `packages/archid` without the root config (as `pnpm --filter @archipelago/archid exec vitest` does), with `HOME` a sentinel holding `.claude/projects/…/transcript.jsonl` and `.claude.json`, and requires that run to pass and the sentinel's `.claude` and `.claude.json` to be as they were.

**RED** (`c1-red.txt`): the sentinel's `.claude` was gone after the run: `Error: ENOENT: no such file or directory, scandir '/tmp/archi-sentinel-knOYme/.claude'`. **GREEN** (`c1-green.txt`): 2/2, and `sessions.test.ts` 33/33.

**The other tests that write under the home** (grep of every `*.test.ts` in archid, cli, web and the root for `os.homedir()`, `HOME` and the default-path helpers):
- `daemon.test.ts` (`~/.archipelago`, `~/.archipelago-files`, `~/.claude/.credentials.json` and `CLAUDE.md`, `~/.archipelago-later`), `cli.test.ts` (`~/.claude/settings.json` before its own assert, `~/Library/…`, `~/.local/…`) and `client.test.ts` (`~/.archipelago-work`) import `test/helpers.ts`, which throws at import unless HOME is an isolate home. Run the same way under a sentinel HOME holding `.claude/CLAUDE.md`, `.credentials.json` and `settings.json`, each failed to load ("no tests") and the sentinel was untouched (`c1-other-tests.json`). The review's "related" note on `daemon.test.ts` does not hold, so nothing was changed there.
- `setup.test.ts` and `controller/registry.test.ts` move HOME themselves.
- `sessions-live.test.ts` uses the real home on purpose, only with `ARCHI_LIVE_REMOTE` set, and removes only its own `.archi-probe-<tag>` paths and sessions.
- No other test writes or removes anything under the home.

## R1: a slot counted up at a prompt stays watched

**Change** (`destination.ts`).
- A slot whose row carries a prompt notice is watched from before its row is written until its session starts: a waiter for its session, and a look at its pane every 2 s (`WATCH_EVERY_MS`). The watch outlives the journal, so it goes on after Complete.
- While watched, `carrying()` is true, so the fleet's poll leaves its agent and resume command alone (it would drop the agent after two shell polls).
- The carried SessionStart ends the watch, and the terminal is the fleet's as any other.
- Its pane back at the shell, or its window gone, first: the slot is laid dormant with its carried revive (flags and all) and gets the error `<which> resumed <kind> session <id>, but <kind> exited back to its shell before that session started, so it is dormant again with that session; revive it and choose "Yes, I trust this folder" at its "Trust this folder?" prompt` (Codex: `…trust its folder at…`). The error goes on the record's `resumeError`, and on the journal row while the journal is open (`recordSlot` now sets `resumeError` whether or not the journal is still open).
- A later handover's rest (`restedBy` no longer this handover) ends the watch without touching the slot.

**Tests** (`destination.test.ts`).
- New: "keeps watching a Claude counted up at its trust prompt, and lays it dormant again with its carried resume and an error once it exits there". Still carried ten seconds on; after the pane goes back to bash, `kill c_bo`, dormant with `claude --effort 'high' --resume …`, the exact error, the row `ok: false`, no longer carried.
- New, real tmux and a real `Fleet` polling every 100 ms: "leaves a Claude that exits at its trust prompt after Complete dormant again with its carried session and an error, which the fleet does not take from it first". The stand-in `claude` exits six seconds in, after Complete; the agent is never dropped, and the character ends dormant with its revive and error.
- Changed: the G1 test now waits a tick after the SessionStart before it finds the terminal no longer carried.

**RED** (`r1-red.txt`): `AssertionError: expected false to be true` (not carried); `Error: waitFor: timed out` (the real fleet dropped the agent and nothing laid the slot dormant). **GREEN**: `destination.test.ts` 71/71, stable over 4 runs of the new tests.

## R2: a live Claude silent for ten seconds counts as up

**Change** (`destination.ts`).
- Every resumed agent now goes through `settles()`, with the settle time as a parameter. A Claude in a folder its config trusts gets `QUIET_MS` = 10 s. An untrusted Claude keeps 3 s, as does Codex.
- SessionStart first: started, no notice. Pane back at the shell, window gone, or no agent within `sessionStartMs` (60 s): dormant with its error, which now names what the pane showed (`claude did not come up within 60 s: its pane stayed at the shell prompt`).
- Held 10 s with no SessionStart: up, window kept, notice `claude has not started its session in bo's terminal and may be waiting at a prompt there; answer it there`, and R1's watch (its exit error ends `revive it to see`).
- The untimed wait is the only one left, so `waitStart` loses its timer.
- A window a dead daemon left running its agent is counted up at once as before, with no quiet notice, since its SessionStart may have gone with that daemon.

**Tests.**
- New: "counts a resumed Claude in a folder this machine trusts up after ten silent seconds in its pane, with a notice that it may wait at a prompt, and watches it" (answered between 10 and 11 s of the fake clock).
- New guard: "counts a resumed Claude in a folder this machine trusts up by a SessionStart that comes inside those ten seconds, with no notice". It passes on the R1 commit; with `QUIET_MS` at 3 s it and the test above fail (`r2-mutant.txt`).
- Changed, since a silent live Claude is now up: "names a resume that never comes up…", "leaves a terminal whose wake fails dormant with the launch flags…" and "leaves a resume that ends back at its shell…" now use a Claude that never comes up, and expect the settle's error text.
- `activateBy` moves the fake clock in half seconds for 20 s rather than 10.

**RED** (`r2-red.txt`, the final tests against the R1 source): 3 failed, among them `expected 80000 to be less than or equal to 11000`. **GREEN**: 73/73.

## R3: the `claude_bypass` preflight warning

**Change.**
- Protocol: `ResumeFolder.bypass` (optional), `handover.inspect`'s result `bypassWarned` (`{ kind, cwd }[]`, sent only when some resume asks for bypass), code `claude_bypass`. Additive within protocol 17, as `root` was.
- Session adapter: `asksBypass(command)` and `acceptsBypass(home, folder)`, on Claude only.
  - `asksBypass` knows the three spellings a revive keeps (`startFlags` keeps `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` and `--permission-mode 'bypassPermissions'`).
  - `acceptsBypass` follows the rule above, reading the config through the same `configOf` as `trusts`.
- `resumeFolders` sets `bypass` from each carried terminal's revive. The destination's inspect answers `bypassWarned`. The controller warns once per such character: `Claude warns that ada resumes in Bypass Permissions mode on trift, with "No, exit" preselected; choose "Yes, I accept" in that terminal`. The sheet hint says the same.
- Activation needs nothing more: R2's rule counts a Claude at this warning up at 10 s with its notice, and R1 watches it.
- `fleet-home.test.ts` lists `settings.json` in `claude.ts` as joined onto Claude's config folder, not a fleet home, beside `.config.json` and `.claude.json`.

**Tests.**
- `sessions.test.ts`, "Claude Code bypass mode": the flag spellings; the 12-case table above; the `~/.claude` layout reading `~/.claude.json`.
- `destination.test.ts`, inspect: bypass folders named until the repository's local settings, then the machine's own settings, accept the mode; no `bypassWarned` without a bypass resume.
- `cli/test/controller/handover.test.ts`: the warning and its text; `bypass: true` sent only for that resume; none once accepted.
- `apps/desktop/web/test/handover.test.ts`: the hint.

**RED** (`r3-red.txt`): `TypeError: claudeAdapter.asksBypass is not a function` (and `acceptsBypass`, twice); `expected undefined to deeply equal [ { kind: 'claude', … } ]`; `expected [] to deeply equal [ { code: 'claude_bypass', … } ]`; `.toMatch() expects to receive a string, but got undefined`. **GREEN**: sessions 36, destination 74, controller 70, web 24; protocol 137.

## R4: NFC

**Change.** `trusts` composes each real path it looks up (the cwd and each folder above it, the main checkout, the checkout's top) to NFC, as 2.1.283's `xn()` does.

**Test.** "trusts a folder whose name is stored decomposed by the composed key Claude 2.1.283 looks it up by": `Skår/Bäck` created decomposed, trusted by its composed key, its parent's, and its repository's.

**On the binary** (`logs-r4-nfc.txt`): in that decomposed folder, a composed key resumes and a decomposed key asks; the adapter agrees with both.

**RED** (`r4-red.txt`): `the folder itself: expected false to be true`. **GREEN**: sessions 37/37, destination 74/74.

## Verification

At `30b8e445`, in shells with nvm's Node 24.18.0 first on PATH and `ARCHI_HOME`, `ARCHI_CHAR_ID`, `TMUX` and `TMUX_PANE` unset.
- `pnpm typecheck`: exit 0 (`final-typecheck.txt`).
- `pnpm vitest run --project protocol --project archid --project cli --project @archipelago/desktop-web`: exit 0, 190 files passed and 1 skipped, **2978 passed and 5 skipped** (`final-vitest.txt`), 12 more than the wave's 2966: protocol 137, archid 1579 (2 skipped), cli 544 (3 skipped), web 718.
- Playwright was not run: the only web change is a hint string, covered by the unit test.

## Concerns

1. **The watch lives in the daemon's memory.** A daemon restarted while a Claude still waits at its prompt no longer watches it, and the fleet treats it as it did before this round: "No, exit" then leaves a plain shell with no agent and no revive.
2. **Policy settings are not read.** A machine whose managed settings set `skipDangerousModePermissionPrompt` gets a false `claude_bypass` warning. It only over-warns.
3. **The quiet notice cannot tell a prompt from a slow start.** A trusted Claude that takes more than 10 s to report its SessionStart (a long transcript, slow hooks) is counted up with the notice. Its window stays and its SessionStart later ends the watch, so only the notice is wrong.
4. **Wording.** An agent laid dormant by the watch is named as having exited "before that session started". A Claude whose process table reads as another program (a launcher) is not watched by its pane; its SessionStart still ends the watch.
