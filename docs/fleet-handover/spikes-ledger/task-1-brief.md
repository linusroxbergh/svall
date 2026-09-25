### Task 1: Prove Claude session portability

**Depends on:** none

**Files:**

- Create: `packages/archid/test/fixtures/handover/claude/README.md`
- Create: `packages/archid/test/handover/claude-portability.test.ts`
- Create: `scripts/probe-claude-handover.mjs`
- Modify if required: fleet handover spec and this plan

**Steps:**

- [x] Record the exact supported Claude Code version and create a throwaway session in a temporary
  home, including one tool call, one cwd change and one subagent/sidechain when supported.
- [x] Inventory the session JSONL, project slug, sidecars and every absolute path without copying
  credentials or real conversation data into the repository.
- [x] Copy the session to a second temporary home with a different username/path, rewrite only the
  required fields, and run `claude --resume <id>` interactively against the copied session.
- [x] Reduce the result to a sanitized fixture that preserves structural variants and path fields.
- [x] Write a vitest probe that discovers the required files from `transcriptPath`, rewrites the
  fixture, and asserts no source-home path remains in classified path fields.
- [x] Document the supported version range and the exact login/hook check commands discovered by
  the probe. If resume cannot be made deterministic, change the product contract before Task 22.

**Verify:** `pnpm vitest run --project archid test/handover/claude-portability.test.ts`

**Commit:** `A fixture proves a Claude session can cross homes`

