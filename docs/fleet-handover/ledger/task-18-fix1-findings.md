# Task 18 — fix round 1 findings (review at 22295e3)

## Important (from the review)

1. Check (doctor) shows nothing. `archi host doctor --json` does not emit step events; it prints one
   pretty-printed `HostReport` `{machine, checks:[{name,status,detail}]}` through `printResult`
   (packages/cli/src/commands/host.ts:87, format.ts:14). `HostProcess.steps(in:)`
   (ControllerProcess.swift:252) decodes each line as a `Step` needing `step` and `status`, so every
   line is dropped. Exit 0 → empty checklist plus "ready for handover" (HostSetup.tsx:21); exit 1 →
   only "Check stopped (exit 1)". Fix: collect stdout at exit for `.doctor` and map each `checks[]`
   entry to a row (`step: name, status, detail`), or send the report as its own message. Test with
   doctor's real output shape.
2. The Machines modal is covered by native surfaces in the real app. `isVeiled`
   (apps/desktop/web/src/selectors.ts:136) lists keysOpen, resourcesOpen, missionPrompt,
   namingCharacter, closingCharacter, scribeAsk — not `hostOpen`. Add it.
3. Connection banner reaches local-only users with no flag gate. App.tsx:41,70 renders
   `connection-banner` for any state but online, including `owner: 'local'`; the helper reports
   `connecting` and `daemon_down` for a local owner, and RemoteConnection.swift:45 publishes `error`
   kind `other` whenever the helper exits. Render it only when `owner !== 'local'` or
   `shell.handoverEnabled` is true, and show one banner, not the connection banner stacked on the
   existing "archid connection lost" banner.

## Controller rulings folded into this round

4. `enable` stays — the spec's Add Machine step 10 creates the gateway's authority record for each
   local fleet the user enables for the machine. Its label "Hand this fleet over"
   (HostSetup.tsx:107) misdescribes it: relabel to what it does (makes this machine the fleet's
   gateway; moves nothing). The page stops deriving the profile (`fleetProfile`, host.ts:70, which
   turns `/tmp/x/.archipelago-work` into `work`); the Swift shell supplies the fleet itself from
   `ArchiHome` when it builds the argv.
5. Remove asks before it runs, as Forget does — it uninstalls Archipelago on the remote in one click.
6. The cancel test is not load-bearing: `testCancellingStopsAChildThatWouldOtherwiseKeepRunning`
   (HostProcessTests.swift:76) uses the default tail `exec cat > /dev/null`, but HostProcess gives
   the child /dev/null stdin, so it exits on its own (10/10 runs). Use `then: "exec sleep 30"`.
7. "Preserve actionable stderr without leaking tokens" (brief):
   - `withoutTokens` (host.ts:4) leaves `?token=abc`, `&token=abc` (the app's own
     `?port=…&token=…` form) and `ARCHI_TOKEN=abc` unmasked. Mask them; test each form.
   - `stderrTail` is replaced by each chunk rather than appended (ControllerProcess.swift:226) and
     stderr is not drained at exit, so the last line can be dropped or truncated. Keep a bounded
     tail of whole lines and drain at exit.
8. "ready for handover" shows after any clean run, including remove, upgrade and enable. Show it only
   when an `add` finishes clean, or a doctor run reports every check ok.
