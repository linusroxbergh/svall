# Fixer W — the remote window: unreachable at open, recovery after Upgrade, arm64 wording

Worktree `/Users/linusroxbergh/linus_laboratory/svall/.claude/worktrees/fix2-window-recovery`, branch
`fix2-window-recovery`. Read `ledger/inspiration-fix-common.md` first.

Exclusive files: `apps/desktop/web/src/**` (App.tsx, host.ts, handover.ts, HandoverSheet.tsx,
HostSetup.tsx, store/*, bridge.ts and their CSS), `apps/desktop/web/test/**`, `apps/desktop/web/e2e/**`,
`apps/desktop/mac/Sources/Svall/ShellRouter.swift`, `apps/desktop/mac/Sources/Svall/RemoteConnection.swift`,
`apps/desktop/mac/Tests/SvallTests/**`. Don't touch `packages/cli`, `docs/remote-machines/*` or the
security doc.

## W1. A window opened while its box is unreachable says so

`loaded` is set only by a snapshot (`web/src/store/fleet.ts:64`). In `App.tsx:62-79` the unloaded branch
shows "Starting the fleet…", then "svalld not running" plus "run svall setup" / the Mac's log — wrong for
a remote fleet. The connection banner (`App.tsx:83`, text from `web/src/host.ts:81-92`) renders only in
the loaded branch. Fix: when the connection state is remote-away (connecting, unreachable, version,
auth, host key …), the unloaded screen shows that state and its recovery text instead of the local
"svalld not running"/setup advice. Local startup is unchanged. Test first (dom test and/or Playwright,
whichever the existing tests for this screen use).

## W2. After a successful Upgrade, the window reconnects; the version message links to Upgrade

- A `version` error is not retried (`cli connection.ts:21-24`), so the helper goes idle. After an
  Upgrade from Settings → Machines succeeds, nothing restarts it: `ShellRouter.swift:387-390` re-sends
  shell info only for ops that rewrite fleet config (enable/remove). Fix: after a successful `upgrade`
  (and `upgrade --rollback`, if the app offers it) for a machine, restart the connect helper of a window
  whose remote connection is idle (any idle helper is fine if scoping to the fleet's gateway is not
  readily available — say which you chose). No automatic upgrade anywhere.
- The viewing banner for a version mismatch (`web/src/host.ts:88`: "<box> is on another version: …")
  and the handover preflight blocker that says "Upgrade X under Settings → Machines" (`web/src/handover.ts:342-344`)
  get an action that opens the existing Machines dialog (HostSetup) with that machine filled in. Reuse
  the existing Upgrade flow; add no new installer entry point. Must also work from W1's unloaded screen.
- Tests: Swift test that a successful upgrade restarts an idle helper (see the existing
  ShellRouter/RemoteConnection tests and `FakeHelper.swift`); web test that the action opens HostSetup
  for the named machine.

## W3. Add Machine doesn't promise arm64

`HostSetup.tsx:97` says the machine needs "Ubuntu LTS on x86-64 or arm64". The app adds only x86-64
(it can't pass `--release`; build.sh builds the x64 companion only); arm64 needs the CLI
(`docs/remote-machines/setup.md:103-110`). Reword to say the app adds an x86-64 machine and an arm64 one
is added with `svall host add … --release` as setup.md describes. Update any test that pins that text.
