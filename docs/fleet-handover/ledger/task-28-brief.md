### Task 28: Add handover CLI, status, resume and disaster recovery

**Depends on:** Task 27

**Files:**

- Create: `packages/cli/src/commands/handover.ts`, `fleet-recover.ts`
- Modify: `packages/cli/src/main.ts`, output formatting, target routing
- Create: `packages/cli/test/handover.test.ts`, `fleet-recover.test.ts`

**Steps:**

- [ ] Add `archi handover <host|local>`, `status`, `--resume`, `--abort`,
  `--interrupt-after`, `--terminate-shells`, per-root archive approval and `--json` NDJSON.
- [ ] Resolve `local` to invoking machine id and reject handover to current owner.
- [ ] Print blockers before Begin; in noninteractive mode exit nonzero rather than prompting.
- [ ] In interactive mode render wait/interrupt/terminate/archive choices with exact affected
  characters/paths.
- [ ] Add `fleet recover --force-owner` only through gateway access, show all journals/generations,
  require typed fleet name/id confirmation, and write a recovery audit record.
- [ ] Ensure Ctrl-C follows Task 27 semantics and reports how to resume.

**Verify:** `pnpm vitest run --project cli test/handover.test.ts test/fleet-recover.test.ts && pnpm typecheck`

**Commit:** `The CLI can hand over, resume and safely recover a fleet`

