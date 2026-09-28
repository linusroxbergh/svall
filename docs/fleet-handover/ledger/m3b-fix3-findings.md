# M3b fix wave, round 3 (findings)

From the machines: `ledger/m3b-gate-report.md` "## Re-check after the fix wave" (G2, with logs). FIX_BASE = HEAD at
dispatch. Rules as `m3b-fixes.md`; report `ledger/m3b-fix3-report.md` (uncommitted). The bypass gate itself is
`m3b-fix1-report.md` R3 (21/21 against the real binary); the fault suite (`faults.test.ts`) must stay green.

- **G2 (Important)** `claude_bypass` never fires for a Claude running when the handover starts: the check reads the
  bypass flag from the terminal's saved revive command (`packages/archid/src/handover/sessions/registry.ts` ~103), and
  preflight runs on live state (`packages/cli/src/controller/handover.ts` ~238), where a running terminal has no revive
  until Freeze. Read a live terminal's launch flags the way the rest does (from its agent process, as `dormancy.ts`'s
  `startFlags` / the rest's flag reading), so preflight warns for running and dormant Claude characters alike, main and
  second terminals. Test first: a running Claude started with `--dangerously-skip-permissions` (and with
  `--permission-mode bypassPermissions`) on a destination that has not accepted bypass gets the warning; a running one
  without the flag does not.
