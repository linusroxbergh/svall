# M3 residuals — R1–R4 (binding; controller ruling, verbatim from the ledger)

R1. replicas.ts:101 RSYNC_PARTIAL also matches ordinary dotfiles (.env.backup), so a destination-only file of that shape written before --resume is removed by the resumed --delete — ignore `.<name>.XXXXXX` only when `<dir>/<name>` is an incoming path. (The spec forbids deleting destination-only work.)

R2. The 192 MiB manifest cap doesn't bound handover.prepare (manifest + landed ≈ 2×), so a >~128 MiB manifest passes preflight/freeze and its prepare exceeds the 256 MiB request cap, closed 1009 and resent 4× — bound prepare at preflight (cap the manifest at half the request cap, or send landed by digest) and never resend on 1009. (Today it fails only after every terminal rested and every file copied.)

R3. The launcher's 50 ms poll reports a helper that listens and exits within one poll as "exited before it listened" (flakes cli handover.test "leaves the run to a helper it starts as itself"; hides the helper's result in the app) — relay the events file's last handover.result on child exit.

R4. `archi host remove` of a gateway is allowed while a handover is open (gatewayFleets ignores open transactions) and can uninstall the machine that just took the fleet — refuse while the gateway holds a transaction.

Verification: failing test first for each; the covering suites for what you touch; typecheck; then archid, cli and protocol full suites once at the end (web/Playwright/swift only if you touch them). Known load flakes (rerun alone, not findings): archid fleet.test.ts revive tests and "marks the agent working", e2e "two turns against a fake claude", processes.test.ts real-ps case, source.test.ts FIFO timer; cli cli.test.ts browser, ssh.test.ts spawn-count; web e2e/ide.spec.ts:136 and e2e/keys.spec.ts:3. After R3, cli handover.test "leaves the run to a helper it starts as itself" is no longer a known flake — it must pass reliably (run it 20× alone).
