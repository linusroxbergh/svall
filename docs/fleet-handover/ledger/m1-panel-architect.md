A1 medium dead-code packages/archid/src/handover/service.ts:16 — HandoverService carries eight unused deps (store, fleet, paths, log, clock, planner, sessions, authority); only journal and ownership are read; Planner/Sessions/Authority types have no impl/consumer.
A2 medium dead-code packages/cli/src/target.ts:10 — localMachineId wrapper and Target.machineId have no consumer; test asserts object spread.
A3 medium error-handling apps/desktop/mac/Sources/Archipelago/ArchiHome.swift:21 — configPath() seeds fleet.json with {} but FleetConfig requires id, so loadConfig throws and initConfig will not repair an existing file.
A4 medium architecture packages/archid/src/main.ts:65 — Store.load persists a migrated state.json before ownership is loaded (line 70), so a replica rewrites its snapshot.
A5 low architecture packages/archid/src/atomic.ts:5 — durable primitive filed under handover/, atomic.ts is a middle man.
A6 low architecture packages/archid/src/fleet.ts:90 — writable()/isOwner() guards repeated at 97,191,232,275,730,760 (shotgun surgery); gate Store.update once.
A7 low simplification packages/archid/src/api/server.ts:80 — desktops set duplicates viewers.filter(kind==='app').
A8 low simplification packages/archid/src/store.ts:61 — promote reads/parses the snapshot three times.
A9 low simplification packages/archid/src/ownership/state.ts:89 — freeze/surrender/unfreeze/installCommitted are async with synchronous bodies.
A10 low naming packages/archid/src/handover/service.ts:39 — local Phase type (RPC set) collides in meaning with HandoverPhase (journal set).
A11 low simplification packages/protocol/src/state.ts:120 — Second is an exact alias of TerminalSlot.
A12 low simplification packages/archid/src/handover/startup.ts:22 — startup mode decided twice from the same journal; enterStartupMode re-derives.
