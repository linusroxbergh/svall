# Final on-machine check (brief)

After the final review's fix waves, on the M3b environment (`ledger/m3b-env.md`: the Mac test HOME and `archi-m3b` on
linus-vault, both at `/Users/Shared/archi-m3b`). Task 39b's ruling owes one round trip on the final build; `host upgrade
--rollback` (added in the fix wave) has never run on a real machine.

## Do

1. Build and scan a release from a `git archive` snapshot of the branch HEAD you are given (`scripts/release-build.sh`,
   as Tasks 37c and 39b did — `task-39b-report.md` has the steps); install it on the Mac test HOME and `archi host
   upgrade m3b` (every fleet daemon on m3b must come back on the new release).
2. `archi host upgrade m3b --rollback` to the release m3b ran before, check every fleet daemon and the gateway run it,
   then upgrade again to the new release.
3. Hand the fleet Mac → Linux → Mac with the release's helper; compare state, repos (HEAD, branch, index, stash, working
   changes, worktrees), entity docs, sessions and ownership as the earlier runs did; take a turn in the real Claude
   (OSPREY) on Linux and back on the Mac, and in one real Codex, each under its own session id.
4. Leave the environment for the owner's by-eye pass: the Mac owns the fleet, nothing open anywhere, no credential copy
   on either machine; update `m3b-env.md` (release, generation) and commit that one file by explicit path.

Credential rule, for the real-Claude step: read `Claude Code-credentials` from the Mac keychain straight into the test
account's `~/.claude/.credentials.json` (0600, never printed or logged) right before the step, only with ≥90 min left on
`claudeAiOauth.expiresAt`, finish inside it, delete every copy after; if under 90 min, wait and check again later —
never refresh it from a test account.

## Rules

On the Mac, everything for the test fleet runs under the test HOME through `$G/env.sh`; `HOME=… open …` or a bare
`archi` reaches the owner's own fleet or app — use the wrappers only. On linus-vault work only as `archi-m3b`; never
the owner's account `linus`, never sudo, never `tailscale serve/funnel/set`. Never touch the owner's `~/.archipelago`,
`~/Library`, `~/.claude`, `~/.claude.json`, `~/.codex` or `~/.ssh`, and never run the owner's `/usr/local/bin/claude`.
Report a product defect with evidence; don't fix it. Keep logs and scripts in your own scratchpad.

## Report

`ledger/final-onmachine-report.md` (uncommitted): the release id and scan, both upgrades and the rollback (each fleet
daemon's release), both directions (generation, duration, characters carried), the compare, the agents' turns,
credential copy/delete times (never the token), defects, the environment's end state, concerns.
