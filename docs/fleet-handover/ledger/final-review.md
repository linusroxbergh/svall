# Final whole-branch review (2026-09-29)

Deep review of `4067bfea..3915b6d2` (PR #1), read from a `git archive` snapshot. Nine Opus panel reviewers (Bug Hunter,
Architect, Guardian × daemon / controller / app+release), an intent check against the spec's version-1 requirements, and a
triage of every ledgered deferred minor. Each candidate went to a fresh Sonnet validator (floor 70); the High and
security-relevant Medium ones then to Gemini (pal codereview, thinking high).

- Candidates, deduped: `final-review-candidates.md` (C01–C33 High/Medium, L01–L52 Low/Nit in groups G1–G7).
- Validator verdicts and Gemini's: `final-review-validation.md`. Dropped: L18 (traced false), L24 (ledgered R3), L25
  (replay folds in one step), L49 (accepted risk in the security doc). Everything else kept.
- Triage of the ledger's minors: `final-review-triage.md` — fixed 79, obsolete 20, must-fix 2 (now C32, C33), follow-up
  19, accept 103.

## Severity after validation and Gemini

- **Critical:** C03 — a resume from a machine that is neither source nor destination runs `rsync --delete` onto its own
  disk at the destination's paths.
- **High:** C01 (a revive in flight at freeze opens a window after the rest's snapshot), C02 (routed commands fail on the
  gateway machine), C04 (a failed window kill still marks the slot dormant), C19 (source Complete never deactivates, so a
  returning fleet never re-activates), C20 (the daemon skips the gateway identity check when no id parses).
- **Medium:** the rest of C05–C33 and L02, L03, L07, L10, L13, L16, L17, L20, L22, L23, L27, L38–L40, L42, L44, L45, L50.

## Intent findings and rulings

| # | Finding | Ruling |
| --- | --- | --- |
| I1 | `--interrupt-after` longer than the rest's 3-minute wait is silently capped | Fix: honor it (Fixer A). |
| I2 | A freeze blocker keeps the gateway transaction open while the source runs | Amend the spec (C2): the user answers without a new Begin; status offers abort if the helper dies. |
| I3 | The gateway authority version is never compared | Fix: preflight compares it (Fixer B). |
| I4 | "Supported Ubuntu" is an even-year `.04` check, not the manifest's list | Amend the spec (C2): an LTS passes, others warn; 24.04 is what is tested. |
| I5 | The end-to-end probe skips the gateway authority and a temporary tmux window | Fix (Fixer B). |
| I6 | Add Machine never offers a terminal for sudo/login steps | Amend the spec (C2) to what v1 does (it shows the command); an offered terminal is a follow-up. |
| I7 | Claude has no minimum version in the host checks | Fix (Fixer A: `AGENTS.claude.minVersion`). |
| I8 | Preflight compares only agent CLI versions, not skills/MCP/settings | Amend the spec (C2). |
| I9 | No user-run far rollback | Fix: `archi host upgrade <m> --rollback [release]` (Fixer B). |
| I10 | `relaySecret` shipped for a later-version feature | Remove it (Fixer A). |
| I11 | `release.json` records `agentAdapters: []` | Drop the field (Fixer C1). |
| I12 | M0 spike probes neither promoted nor marked manual | Mark them manual under `scripts/spikes/` (Fixer C1). |
| I13–I16 | Ruled deviations the spec never absorbed (kept worktree registrations, a lower gateway generation ignored, content-equal adoption, the path-field registry's scope) | Amend the spec (C2). |
| I17 | README/plan status stale | The orchestrator refreshes them at the end. |

## Fix waves (file ownership is exclusive within a wave)

1. **Wave 1, in parallel:** Fixer A (`packages/archid/**`, `packages/protocol/**`, the rows for its own new codes in
   `docs/remote-machines/errors.md`) — `final-fix-A.md`; Fixer C1 (`apps/desktop/**` except `web/src/handover.ts`'s type
   declarations, `scripts/**`, `.github/**`) — `final-fix-C1.md`.
2. **Wave 2:** Fixer B (`packages/cli/**`, the web type import and F1's display in `apps/desktop/web/src/handover.ts`,
   rows for its own codes) — `final-fix-B.md`.
3. **Wave 3:** Fixer C2 (`docs/**` outside the ledger, `README.md`, spec amendments, user-doc sweep) — `final-fix-C2.md`.
4. One scoped re-review of the whole fix range, split by area.

## Deferred as follow-ups (not fixed before merge)

L02 (the four copies of master→info→forward→client), L03 (fleet.json readers), L29 (blocker→choice map in three
places), L30 (script helpers), L31 (Swift profile-name derivations), L37 (`repairBrief` without a caller), L39 (shared
source/destination helpers), I6's offered terminal, and the triage's 19 follow-ups. Reason: behaviour-preserving
refactors across many files carry more regression risk right before merge than they remove.
