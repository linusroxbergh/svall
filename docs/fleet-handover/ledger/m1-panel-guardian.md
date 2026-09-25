G1 high error-handling apps/desktop/mac/Sources/Archipelago/ArchiHome.swift:21 — configPath() seeds fleet.json with {}; FleetConfig requires id, so the daemon cannot load it and initConfig then refuses config.json beside it. (dup of A3)
G2 medium error-handling packages/archid/src/ownership/state.ts:34 — standalone fleet whose valid owner.json names a foreign machine (e.g. machine.json lost/relocated → new machine id) never repairs; every fleet becomes permanently read-only.
G3 medium i18n packages/archid/src/ownership/state.ts:41 — error tells the user to run `archi fleet recover`, which does not exist.
G4 medium error-handling packages/archid/src/handover/startup.ts:27 — quarantined journal surrenders durably and nothing ever calls unfreeze(), so a local fleet stays read-only across restarts after the broken journal was moved aside.
G5 medium security packages/archid/src/handover/service.ts:148 — abort's ownership check only engages when a source journal is on disk; with no journal a non-owner passes authorize.
G6 medium error-handling packages/archid/src/main.ts:70 — machineId() throws unhandled on daemon startup for an unparseable machine.json.
G7 medium error-handling packages/archid/src/handover/journal.ts:62 — quarantine renameSync unguarded (also state.ts:38); an EACCES on the rename kills startDaemon instead of demoting to read-only.
G8 low architecture packages/protocol/src/handover.ts:67 — handover.enabled is written but consulted nowhere.
G9 low type-safety packages/cli/src/controller/registry.ts:82 — `as MachineRecord` / `as MachineId` casts instead of checks.
