### Task 22: Implement versioned agent-session adapters

**Depends on:** Tasks 1, 2, 19

**Files:**

- Create: `packages/archid/src/handover/sessions/types.ts`, `registry.ts`, `claude.ts`, `codex.ts`
- Create: `packages/archid/test/handover/sessions.test.ts`
- Add versioned sanitized fixtures produced by Tasks 1–2

**Interfaces:** `SessionAdapter.supports/discover/rewrite/validate`; adapter registry keyed by agent
kind and tested CLI version range; session manifest entries separate from repository roots.

**Steps:**

- [ ] Implement exact-path discovery from the character's recorded `transcriptPath`, honoring
  `CLAUDE_CONFIG_DIR`/`CODEX_HOME` at both ends.
- [ ] Include only session-specific JSONL/sidecars/subagent data proven by spikes; do not mirror whole
  user project/session directories.
- [ ] Rewrite only adapter-known path-bearing fields and fail closed on a structurally new variant.
- [ ] Place artifacts in the destination CLI's expected id lookup layout and update imported
  `agent.transcriptPath` before activation.
- [ ] Add preflight capability/version/login/hook checks and missing-transcript blockers.
- [ ] Add a distinct repair API that can generate a new-session brief later; do not use it in normal
  handover or claim it is the same conversation.

**Verify:** all versioned fixture tests plus optional real-agent integration probes gated by env.

**Commit:** `Supported agent conversations have versioned handover adapters`

