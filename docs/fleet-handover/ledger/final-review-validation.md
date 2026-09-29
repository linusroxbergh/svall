C17 keep medium 85 — installRelease/rollbackRelease never delete a release; releasesKept only lists (install-release.mjs:108)
C06 keep medium 85 — profileFlag() only -p; remoteConnectionInfo adds -p only when set (program.ts:54, connection.ts:112)
C11 keep medium 75 — HandoverLine.decode checks only event; applyEvent reads data unguarded; types hand-duplicated, no contract test
C14 keep medium 85 — openConfig skips the remote notice; local fleet.json edits lost at handover back
C18 keep medium 80 — verification twice (install-release.mjs stage vs install.ts inspectCompanion), drifted order, verifySignature twice
C12 keep medium 80 — shell.info only on .connection; onExit sends only hostDone (ShellRouter.swift:219-221, 346-349)
C10 keep medium 75 — registry.recovered read only by tests (registry.ts:58-67)
C09 keep medium 78 — enableHost never compares the named gateway before seeding (host.ts:663-687)
C19 keep medium 85 — runComplete never deactivates; activate() ??= short-circuits (source.ts, fleet.ts:121-123, 264-266)
C01 keep high 80 — settle() ignores reviving/openingSecond; rest snapshots once (fleet.ts:157-159, 725; rest.ts:245, 354)
C16 keep medium 80 — same-version reinstall: rollbackTo points at the new tree (install-release.mjs:60-100, host.ts:487-510)
C05 keep medium 75 — agent-ready rests without checking agent.commands (rest.ts:167 vs :184, fleet.ts endIdleAgents)
C07 keep medium 80 — host enable/remove write parsed FleetConfig via writeDurable rename (host.ts:596-609, 684-685)
C20 keep high 75 — daemon gateway client skips identity when no machineId matches (client.ts:180-181 vs connection.ts:44)
C13 keep medium 75 — helper onExit before online leaves route .pending (RemoteConnection.swift:49-52)
C21 keep medium 70 — mintMachineId writeFileSync wx, no temp/fsync; createDurable unused (machine.ts:26-29)
C04 keep medium 65 — killWindow swallows errors; lay() marks dormant unconditionally (tmux.ts:230-232, rest.ts:353-354)
C03 keep high 80 — adopt() no party check; transfer roles mark destination local; push with delete on uninvolved machine (handover.ts:228, 526, 533, 966-976; transfer.ts:263)
C26 keep medium 75 — validate.ts:21-31 duplicates replicas.ts:135-145
C29 keep low 70 — HelloResult unused
C24 keep medium 85 — uninstall.ts:154,168-175 no ownership/handover check
C23 keep medium 85 — Linux unit lacks CLAUDE_CONFIG_DIR/CODEX_HOME; spec.md:470 requires both machines
C22 keep medium 80 — watch() loops 2 s, exits only on heard or restedBy change (destination.ts:650-694)
C25 keep medium 85 — seven exports unused outside their files
C28 keep medium 85 — Store.replace only in tests
C08 keep medium 85 — transient() retries SshError('version'); ends interrupted not incompatible_protocol (handover.ts:113, 267-271, 793-798)
C30 keep medium 85 — scrollback capture unreachable; RestedTerminal fields unread (source.ts:36-53, 328; main.ts:147-152)
C02 keep high 85 — resolveOwner dials askGateway for the local record (connection.ts:206, 229, 279; registry.ts:33-40)
C31 keep medium 70 — three Swift NDJSON child wrappers, three stop policies
C27 keep medium 75 — handover.status roots from never-written progress; characters/roots unread
C15 keep medium 70 — AttachCommand dials the real destination; the CLI's M7 fix names archi-remote.invalid; NOTE: the 38b-accepted 'surfaces past MaxSessions ride their own login' depends on this fallback
C33 keep medium 75 — sealAs returns [] without a seal record; receiving record left after abort (destination.ts:840-858, replicas.ts:286, divergence.ts:108-109)
C32 keep medium 70 — bare archi setup throws on an installed release; hints in doctor, README, errors.md, fleet.ts
L48 keep low 60 | L49 drop (accepted risk) | L50 keep medium 65 (reserved names orphan profiles) | L51 keep low 55 | L52 keep nit 60
G1: L01 keep low 65 | L02 keep medium 65 | L03 keep medium 60 | L04 keep low 55 | L05 keep low 60 | L06 keep low 65 | L07 keep medium 60
G2: L08 keep low 50 | L09 keep low 60 | L10 keep medium 85 (parked M3 A11) | L11 keep low 60 | L12 keep low 60 | L13 keep medium 70 | L14 keep low 55 | L15 keep nit 30
G3: L16 keep medium 80 | L17 keep medium 75 | L18 DROP (traced: failed let-go before commit gives safe [abort]) | L19 keep low 65 | L20 keep medium 70 | L21 keep nit 60
G5: L29–L36 all kept low/nit (L32 confidence 45)
GEMINI (pal codereview, thinking high): confirmed all 10 sent; C03 → critical; C04 → high; C19 → high (round trip: activate() returns the stale promise, no control client/poll on return); C01, C02, C20 high; C05, C15, C33, C13 medium. C15: gemini claims a live master past MaxSessions does not fall back to its own login — contradicts the M2 on-machine observation ("Session open refused by peer" then own login), so the fix must keep terminals 11+ working.
G6: L37 keep low 90 | L38 keep medium 80 | L39 keep medium 70 | L40 keep medium 75 | L41 keep low 65 | L42 keep medium 75 | L43 keep low 70 | L44 keep medium 75 | L45 keep medium 80 (provisioned log dir not 0700) | L46 keep low 80 | L47 keep nit 65
G4: L22 keep medium 75 | L23 keep medium 75 | L24 DROP (ledgered m3-residuals R3) | L25 DROP (replay folds in one step) | L26 keep low 35 | L27 keep medium 75 | L28 keep nit 35
