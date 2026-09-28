# M3b fix wave, round 3: report

Branch `experimental-remote-sessions`, from FIX_BASE `2acc4de6`. One commit:

| Item | Commit | Subject |
| --- | --- | --- |
| G2 | `fd2204af` | Preflight gives each running agent the revive its rest will record, launch flags read from its process, so a Claude running in bypass mode gets the claude_bypass warning |

`0658b854` (Task 36a done: `progress.md`, `task-36a-review.md`) landed between dispatch and this commit from elsewhere; it touches no code.

`$SP` = `/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/3739c9b8-51d0-4aa6-ac32-19bc0b56eee0/scratchpad`. Runs and logs: `$SP/fix3`. Every run had logging `claude` and `codex` stubs (`$SP/fix3/stubs`, exit 97) first on PATH; `$SP/fix3/stub-calls.log` was never created.

## G2: `claude_bypass` for a running Claude

**Cause.** The controller's `resumeFolders` reads the bypass flag from each carried slot's `revive.command`. At preflight a running terminal has no revive (the rest writes it at freeze), so only a Claude already dormant with a bypass revive was ever warned.

**Change.**
- `rest.ts`: `launchFlags` is exported. It is the rest's own reading of a terminal's launch flags: `startFlags` on the args of the agent process holding the pane.
- `source.ts` preflight: the classified terminals it already reads for `unapproved` now also give each running agent slot in the preflight manifest's snapshot the revive its rest will record, `reviveCommand(slot, launchFlags(t))`. That covers main and second terminals, and a launch the rest cannot repeat gets no flags, as at freeze. A dormant slot keeps the revive it has.
- Nothing else changes. The controller, `resumeFolders`, the destination's inspect and the protocol stay as R3 left them. The state is untouched; only the snapshot clone in the manifest changes. `tmux` is forbidden in a snapshot, so a running slot there showed neither window nor revive before. No other reader of the preflight manifest's `revive` exists in `packages/cli/src` or `apps/desktop/web/src`.

**Tests.**
- `source.test.ts`, "source preflight", new: "carries each running agent with the revive its rest will record, launch flags read from its process, so a bypass resume shows in either terminal".
  - ada's main pane runs `claude --dangerously-skip-permissions`, and its second pane runs `claude --permission-mode bypassPermissions`.
  - bo runs `claude --effort high`, and cy is dormant with a bypass revive.
  - Snapshot revives: `claude --dangerously-skip-permissions --resume …`, `claude --permission-mode 'bypassPermissions' --resume …`, `claude --effort 'high' --resume …` and cy's own.
  - `resumeFolders(manifest)` gives bypass `[c_ada true, c_ada true, c_bo false, c_cy true]`.
  - No blockers, the store unchanged, and no tmux action.
- `faults.test.ts`, new describe "a preflight of a Claude running in bypass mode". It runs end to end through the real controller, source daemon, destination daemon and Claude adapter; the fault suite's World is the only harness with all three real.
  - di running `claude --effort high` gets no `claude_bypass`.
  - di running `claude --dangerously-skip-permissions` gets `claude_bypass` for `c_di`.
  - Once trift's Claude settings hold `skipDangerousModePermissionPrompt: true`, none. No violations.

**RED**, against the unfixed source:
- `g2-red-source.txt`: `expected [ undefined, undefined, …(2) ] to deeply equal [ …(4) ]`. The three running slots had no revive; cy's dormant one did.
- `g2-red-faults.txt`: `expected [] to deeply equal [ 'c_di' ]`. The first assertion, no flag and no warning, passed. This is G2 as the machines showed it.

**GREEN**:
- `source.test.ts` 45/45, up from 44 (`g2-green-source.txt`).
- `faults.test.ts` 422/422, up from 421 (`g2-green-faults.txt`). The fault suite stays green.

## Verification

At `fd2204af`, nvm's Node 24.18.0 on PATH behind the stubs, `ARCHI_HOME`, `ARCHI_CHAR_ID`, `TMUX` and `TMUX_PANE` unset:
- `pnpm typecheck`: exit 0 (`final-typecheck.txt`).
- `pnpm vitest run --project protocol --project archid --project cli --project @archipelago/desktop-web`: exit 0, 191 files passed and 1 skipped, **3406 passed and 5 skipped** (`final-vitest.txt`). The two new tests are the only additions to FIX_BASE's suite.

## Concerns

1. **Flags are read at preflight.** A Claude restarted with other flags between preflight and freeze resumes as the freeze finds it, which the preflight did not warn about. The rest reads the same way at freeze, so the carried revive is always the freeze's.
2. **A launch the rest cannot repeat is not warned.** An example is `claude --dangerously-skip-permissions --disallowedTools Bash`. `startFlags` gives up, so the rest carries `claude --resume …` without the bypass flag, and the destination never shows the warning. The preflight agrees with that. Losing the flag at resume is the rest's existing rule, not this change.
