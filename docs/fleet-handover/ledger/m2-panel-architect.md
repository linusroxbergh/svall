# M2 panel — Architect (opus). Paths relative to the impl worktree.
A1 high · packages/archid/src/linux/setup.ts:104 — gateway unit written but never enabled/started; host enable → disconnected; remote routing via gateway can't work. Fix: enable --now GATEWAY_UNIT in startUnit; gateway check in companion doctor/serviceOutcome; drop the plan-narrating template comment. (= I1)
A2 high · packages/archid/src/linux/setup.ts:146 — Linux upgrade never restarts archid (enable --now no-op; unit text unchanged; shim pins pwd -P); probe checks the old daemon yet claims "answers on release <new>". Fix: restartUnit archid (+gateway) when a release was replaced; probe compares the daemon's own release. (= I2)
A3 medium · apps/desktop/mac/Sources/Archipelago/SurfaceManager.swift:28 — remote attach quotes tmux args for the local shell only; ssh rejoins remote words for the far shell, so a spaced socket path splits and metacharacters are interpreted remotely. Fix: quote twice for remote (quote(quote(x))) + spaced-socket test.
A4 medium · packages/archid/src/uninstall.ts:69 — Mac uninstall leaves ~/.local/share/archipelago/{releases,current,companions} (prefix cleanup only inside the linux-only removeUnits).
A5 medium · packages/cli/src/controller/connection.ts:179 — resolveOwner can't resolve on the gateway machine itself (always ssh via gateway.record.ssh; local record has none) → every archi command there fails once a Linux gateway owns a fleet (M3). Fix: local socket when gatewayId === localId.
A6 medium · packages/cli/src/controller/connection.ts:275 — every archi command on a gatewayed fleet pays a fresh ssh round trip to the gateway (connectFor → resolveOwner, no memo); unreachable gateway stalls ~20 s (no ConnectTimeout; OPEN_TIMEOUT 20 s). risky-behavior-change.
A7 medium · packages/cli/src/commands/host.ts:77 — `host list` gateway column always "no" (record.gateway never set; enableHost writes only fleet.json).
A8 medium · scripts/install-release.mjs:146 — standalone main()/options()/argv[1] CLI has no caller. simplify.
A9 low · connection.ts:25 — remote archi path built in four places (archiExe, controller/host.ts:169, install.ts:126,132).
A10 low · packages/archid/src/gateway/bin.ts:8 — ~/.local/share/archipelago prefix spelled four times.
A11 low · packages/cli/src/controller/install.ts:96 — classifies ssh exits nobody reads (Runner.step drops the kind).
A12 low · controller/install.ts:30 — tarball release detection duplicated with install-release.mjs stage().
A13 low · packages/cli/src/commands/gateway.ts:20 — authority frame typed three times + seven-way switch over wrappers.
A14 low · connection.ts:100 — nested ternaries build an error to throw (also AppDelegate.swift:204).
A15 low · connection.ts:21 — exports with no outside consumer (RETRIED, routeFile, StepError, AUTHORITY_ERROR_CODES array, startGatewayFromEnv, SshMaster.cancelForward, AuthorityServer.address).
A16 low · apps/desktop/web/src/host.ts:41 — HostRun.args stored, never read.
A17 low · scripts/release-manifest.mjs:56 — entriesDigest written, never verified.
A18 low · web host.ts:79 — connection message token-masked twice.
A19 low · web host.ts:13 — step name "machine" means two things; Add machine checklist shows a second Connect phase between Service and Agent logins.
A20 low · controller/host.ts:9 — controller imports Check type from commands/doctor.
A21 low · packages/archid/src/profile.ts:6 — host/gateway/connect/connection-info not reserved as profile names.
A22 low · packages/cli/src/main.ts:24 — global --host silently ignored by doctor/mobile/setup/host/connect/connection-info.
A23 low · commands/setup.ts:32 — rollback-and-restart reporting duplicated with linux/setup.ts:170-176.
A24 low · linux/setup.ts:42 — dev archi tsx/main.ts pair spelled twice.
A25 low · connection.ts:64 — three strict fleet.json readers (localFleetId, fleetConfig, controller/host.ts:487 readFleet).
A26 low · connection.ts:116 — retry predicate and backoff spelled several times (withReconnect, fromCachedRoute:199, connect.ts wait()).
A27 low · Bridge.swift:78 — connectionState data clump.
A28 low · controller/host.ts:225 — endToEnd repeats connectRemote's tunnel/client sequence.
A29 low · commands/setup.ts:10 — production installer lives under scripts/ with hand-written .d.mts types reached by ../../../../ climbs.
A30 low · scripts/build-controller.mjs:36 — rsync source download re-implements release-stage download non-atomically (truncated tarball sticks).
