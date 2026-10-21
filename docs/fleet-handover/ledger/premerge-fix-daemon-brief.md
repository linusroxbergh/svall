# Fixer daemon — M1 (start without ~/.config/svall) and S4 (no send into a freeze)

Worktree `/Users/linusroxbergh/linus_laboratory/svall/.claude/worktrees/pm-fix-daemon`, branch `pm-fix-daemon`.
Read `ledger/premerge-fix-common.md` and items M1 and S4 of `ledger/pr2-premerge-review.md` first.

Exclusive files: `packages/svalld/src/main.ts`, `packages/svalld/src/machine.ts`, `packages/cli/src/commands/version.ts`,
`packages/svalld/src/fleet/prompts.ts`, and tests under `packages/svalld/test/` and `packages/cli/test/` for them.

## M1. A fleet with no gateway starts when ~/.config/svall cannot be used

`start()` calls `machineId()` for every fleet (`main.ts:152`); an unwritable or non-directory `~/.config`, or a corrupt
`machine.json`, makes svalld exit 1, and 0.9.0 starts in all three cases.

- When `machineId()` throws and `config.gatewayMachineId` is unset, log the error and run on owner.json's
  `ownerMachineId` if it parses, else a fresh UUID. A fleet that names a gateway still fails as today.
- For EACCES/ENOTDIR, the log line says how to fix it (e.g. `sudo chown -R $USER ~/.config`).
- Grep every other `machineId()`/`configDir` call svalld can reach for a no-gateway fleet in normal use (RPCs such as
  system.info, connection info, the handover service) and make sure none throws there; pass the chosen id where it is
  already threaded rather than adding new reads.
- `svall version` (`packages/cli/src/commands/version.ts:13`) throws the same way. Its human output names the problem
  in place of the id; `--json` (which `host add` reads on the far machine) keeps failing, so an identity cannot be faked.
- Tests first: a daemon start with `~/.config` chmod 555, with `~/.config` a file, and with a corrupt machine.json —
  each RED (exits) then GREEN (starts, same id across two starts); one with a gateway named stays failing.

## S4. A direct `char.run` holds its prompt when the fleet froze during the composer read

`Prompts.run` (`fleet/prompts.ts:55-57`) sends after `await this.free(...)` with no `writable()` re-check; only
`deliverHeld` re-checks (`:106`, `:116`). Change the condition to send only when `free && !held && writable()`, and
hold the prompt otherwise (so `deliverHeld` delivers it after an unfreeze or drops it on deactivate), returning what a
held prompt returns. Test first, modelled on the review's repro: mock `tmux.screen` to freeze ownership on its first
call and return the `claude-empty` pane; `fleet.run(c.id,'go',true)` must type nothing. Leave the Enter window
(`tmux.ts:225`) and `Fleet.settle()` alone; they are follow-ups.
