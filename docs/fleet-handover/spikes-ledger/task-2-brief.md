### Task 2: Prove Codex session portability

**Depends on:** none

**Files:**

- Create: `packages/archid/test/fixtures/handover/codex/README.md`
- Create: `packages/archid/test/handover/codex-portability.test.ts`
- Create: `scripts/probe-codex-handover.mjs`
- Modify if required: fleet handover spec and this plan

**Steps:**

- [ ] Create a throwaway Codex session under a temporary `CODEX_HOME`, including a tool call and cwd
  metadata, then locate it from the session id and hook-provided `transcriptPath`.
- [ ] Copy it to a second home/path and prove `codex resume <id>` finds the moved rollout.
- [ ] Identify every path-bearing session metadata field and any date/index files required for id
  lookup. Do not assume the rollout alone is sufficient.
- [ ] Sanitize a representative fixture and add tests for discovery, rewrite and unsupported shapes.
- [ ] Record the supported Codex version range and exact login/hook checks. Amend the design if an
  exact-session resume cannot be supported without copying credentials.

**Verify:** `pnpm vitest run --project archid test/handover/codex-portability.test.ts`

**Commit:** `A fixture proves a Codex session can cross homes`

