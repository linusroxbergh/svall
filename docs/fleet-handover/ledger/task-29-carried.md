# Task 29 — obligations carried from earlier reviews (binding)

Scope: `apps/desktop/web` and `apps/desktop/mac` only. Task 28a builds the `archi handover` helper in
`packages/cli` in parallel on fleet-handover-impl; build against task-28-29-contract.md and do not
touch `packages/`. A gap in the contract is reported, not patched on the CLI side. Test the Swift side
with a fake helper script that speaks the contract, and the page with a Playwright fixture that fakes
the bridge.

The helper and the sheet
1. Spawn and steer the helper exactly as the contract's "What the app does with it" says: a detached
   launcher, then `attach --json` whose stdin carries `choose`/`cancel`; relaunch reattaches or rebuilds
   from the events file plus `handover.status`; Resume/Abort spawn `--resume`/`--abort` detached and
   attach again. Quitting the app ends only `attach`.
2. The Handover control sits beside the fleet/owner badge (Corner) only while `fleet.json`'s
   `handover.enabled` is true (ledger, Task 18). Destinations: This Mac and the configured gateway.
3. Rest choices are read once per Freeze call: "Interrupt and carry" while Freeze still waits and
   "Continue waiting" after a blocked answer are both a `choose`, never an abort (Task 24, 27).
4. Blocker and warning rows show what the helper sent, naming the entity: an unknown file kind in a
   Claude session folder names the file (Task 22); a user's own lingering hook child that keeps an
   interrupted Claude unsettled is named, with the terminate choice explained (Task 24); on a pull
   (destination = This Mac) an `external_writer` names both sides when the local copy moved (Task 23);
   `config_difference` compares agent CLI versions only — do not present it as MCP/skills (Task 27);
   `codex_trust` says Codex asks to trust each moved folder on its first resume.
5. Keep on this machine: a toggle on the character (side card) through `char.update { keepHere }`; the
   `character_pinned` blocker names the character and points at the toggle (Task 25).

Reconnect
6. M2: after leaving a local owner, the page's 500 ms re-show sends `term.attach` to the old local
   daemon, which refuses (not owner), and the page records termFailed without retrying once the new
   owner is online. Retry the attach once the new owner's connection is online.
7. The owner reconnect builds on Task 17b's `RemoteConnection` (`online` without `owner-changed` is a
   rebuild; `owner-changed` re-resolves) and task-17-contract.md's `archi connect --json`.

Also here
8. M2 (host upgrade sheet, web `host.ts`): an upgrade that rolls back shows Companion → Final probe →
   Companion, because `rollback` is a Companion step. The rollback row must follow Final probe.
