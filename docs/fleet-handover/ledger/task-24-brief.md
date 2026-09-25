### Task 24: Classify and rest every terminal safely

**Depends on:** Tasks 7, 10

**Files:**

- Create: `packages/archid/src/handover/processes.ts`, `rest.ts`
- Modify: tmux wrapper to expose pane pid/current command/client detach
- Modify: `packages/archid/src/fleet.ts`, `terminals.ts`
- Create: `packages/archid/test/handover/processes.test.ts`, `rest.test.ts`

**Interfaces:** `ProcessTable`, terminal classifications `agent-ready/agent-working/agent-blocked/
shell-ready/foreground`, explicit choices and settle result.

**Steps:**

- [ ] Build a portable process tree snapshot from `ps` output keyed by tmux pane pid; keep parsing
  isolated and fixture-tested for macOS/Linux shapes.
- [ ] Classify both terminal slots using agent hook status plus actual foreground descendants.
- [ ] Recheck classifications after Freeze, before any interrupt or kill.
- [ ] Wait for working agents with events; blocked agents require answer/interrupt/cancel choice.
- [ ] Send Escape only for explicit interrupt policy, then wait for hook/process confirmation.
- [ ] Terminate a foreground shell only for explicit per-terminal/global choice; record what was
  terminated in the journal.
- [ ] Detach external tmux viewers, kill windows only after every chosen terminal settled, capture
  cwd/optional scrollback, and mark both slots dormant with resume commands.
- [ ] Abort before killing anything when the post-freeze recheck discovers an unapproved blocker.

**Verify:** `pnpm vitest run --project archid test/handover/processes.test.ts test/handover/rest.test.ts`

**Commit:** `Handover rests agents and refuses unapproved shell processes`

