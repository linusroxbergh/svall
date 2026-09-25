# M1 deep review — bbcbe8e..9d271d4 (validator floor 70)

## Standards findings
High
- F1 machine.ts:28 — concurrent first machineId() calls mint two ids; the loser returns an id not on disk (90, safe-correctness): open machine.json with 'wx' and re-read on EEXIST.
- F2 ArchiHome.swift:21 — the Fleet-config button seeds fleet.json with {} which FleetConfig rejects; the daemon never starts and initConfig never repairs an existing file (90, safe-correctness): open only if present, never create.
Medium
- F3 ownership/state.ts:34 — standalone fleet with a valid record naming a foreign machine stays read-only forever (90, risky-behavior-change): take the fleet back at generation 0 when no gateway is configured, log it.
- F4 ownership/state.ts:41 — message names `archi fleet recover`, which does not exist (92, safe-correctness).
- F5 handover/startup.ts:27 — a quarantined journal surrenders durably and nothing ever unfreezes; a local fleet stays read-only after the broken journal was moved aside (92, risky-behavior-change).
- F6 handover/service.ts:148 — abort's owner check only fires when a source journal exists (85, safe-correctness).
- F9 cli/controller/paths.ts:54 — mapPortablePath lacks the realpath containment resolvePortablePath has; unused outside its test today (78) → carried to the first destination-write caller (Task 23/26).
- F10 handover/service.ts:16 — eight declared deps, two read; Planner/Sessions/Authority types have no impl (95, simplify).
- F11 cli/target.ts:10 — localMachineId and Target.machineId have no consumer (92, simplify).
Low
- F7 main.ts:70 — an unparseable machine.json stops the daemon with no remedy named (78).
- F8 dropped (65): unguarded quarantine rename mirrors the pre-existing Store.load pattern.
- Unvalidated lows (deferred): A5 durable primitive filed under handover/ with atomic.ts as middle man; A6 writable() guard repeated at five Fleet sites; A7 desktops set duplicates viewers filter; A8 promote parses the snapshot thrice; A9 four async methods with sync bodies; A10 Phase vs HandoverPhase naming; A11 Second alias of TerminalSlot; A12 startup mode derived twice; B5 a foreign-fleet journal still drives the service; G8 handover.enabled read nowhere; G9 registry casts.
Ruled, not fixed: F12 Store.load persists a migrated state.json before ownership (M1 ruling: stays until Task 26).

## Intent findings (plan Tasks 5–11 + spec)
- Missing — Task 5 step 6 "expose node.json through diagnostics": nothing names node.json; the Settings button title still says "Port…" → fix wave (archi doctor lists node.json; retitle the button).
- Wrong — Task 7 / spec "a second terminal no longer disappears merely because its window is absent": a plain-shell second is deleted; authorised by the Task 7 ruling, which contradicts the spec sentence → surfaced to him, ruling stands.
- Wrong — M1 gate "start no tmux windows": a replica starts the tmux server and its _keep holder window because ensureServer runs before the gate → fix wave.
- Missing — startup writes machine-local files before ownership is known → M1 ruling (machine-local scaffolding allowed; the state.json migration persist stays until Task 26).
