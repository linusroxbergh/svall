F1 high machine.ts:28 — concurrent first machineId() calls mint two ids; loser returns an id not on disk (Bug Hunter)
F2 high ArchiHome.swift:21 — app seeds fleet.json with {} which FleetConfig rejects (id required); initConfig then refuses config.json beside it (Architect, Guardian, Bug Hunter)
F3 medium ownership/state.ts:34 — standalone repair only on read failure; a valid record naming a foreign machine stays read-only forever (Guardian, Bug Hunter)
F4 medium ownership/state.ts:41 — message names `archi fleet recover`, which does not exist (Guardian)
F5 medium handover/startup.ts:27 — quarantined journal surrenders durably; unfreeze() has no caller, so the fleet stays read-only after the broken journal was moved aside (Guardian)
F6 medium handover/service.ts:148 — abort's owner check only when a source journal exists; no journal → non-owner passes authorize (Guardian)
F7 medium main.ts:70 — machineId() throws unhandled on startup for an unparseable machine.json (Guardian)
F8 medium journal.ts:62 + state.ts:38 — quarantine renameSync unguarded; EACCES kills startDaemon instead of demoting (Guardian)
F9 medium cli/controller/paths.ts:54 — mapPortablePath skips the realpath containment check resolvePortablePath does (Bug Hunter)
F10 medium handover/service.ts:16 — HandoverService declares eight deps, reads two; Planner/Sessions/Authority types have no impl (Architect)
F11 medium cli/target.ts:10 — localMachineId wrapper and Target.machineId have no consumer (Architect)
F12 medium main.ts:65 — Store.load persists a migrated state.json before ownership loads (Architect) — covered by the M1 ruling; not validated
Lows (unvalidated, deferred): A5 atomic.ts middle man under handover/; A6 five repeated writable() guards; A7 desktops set duplicates viewers filter; A8 promote parses thrice; A9 async methods with sync bodies; A10 Phase vs HandoverPhase naming; A11 Second alias of TerminalSlot; A12 startup mode derived twice; B5 foreign-fleet journal still drives the service; B6/intent(a) node.json unreachable from the app; G8 handover.enabled unread; G9 registry casts.
Validator verdicts (floor 70 per his feedback that 80 cut real mediums): F1 keep high 90; F2 keep high 90; F3 keep medium 90; F4 keep medium 92; F5 keep medium 92.
F6 keep medium 85.
F9 keep medium 78 (mapPortablePath unused outside its test today; the containment check is owed by the first real destination-write caller, Task 23/26).
F7 keep low 78 (bin.ts logs and exits; no self-repair, remedy not named). F8 low 65 → below floor, dropped (pre-existing pattern shared with Store.load).
