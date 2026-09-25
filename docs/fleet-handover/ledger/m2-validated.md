# M2 validator results (floor 70)
V2: D17 keep medium 75 — reload registry per resolution (or on a missing gateway id).
V2: D9 keep high 75 — removeHost refuses listing fleets naming it as gateway, or clears gatewayMachineId where this Mac owns the fleet, or add host disable.
V2: I5 keep medium 70 (intent) — no supported path to a Linux-owned fleet from the Mac; needs a supported attach path or a gate amendment.
V2: D13 below floor (medium 50) — only reachable after M3 moves fleet.json onto the gateway; carry to Task 26/28 (local authority socket when gatewayId === localId).
V2: D24 below floor (medium 50) — no harm in M2; carry to M3: refuse enable when fleet.json names another gateway, require owner.json to name this Mac unfrozen before create.
V6: D5 keep high 85 — when the route is .local, answer the page's `connection` ask with a fresh ArchiHome.connection() (fallBack and helper alike); helper's stored value only for .remote.
V6: D18 below floor (medium 60) — owner-change closeAll never tells the page; carry to Task 29 (report term.exited per closed surface or drop page terminals on owner-changed).
V6: D19 below floor (medium 50) — new endpoint never replaces a live local socket; carry to Task 29 (force reconnect when url/token differ).
V6: D22 below floor (low 40) — helper exit before first online leaves a local window dead; deferred.
V6: D26 below floor (medium 60) — quit can block main 20–70 s with an unreachable gateway (helper traps SIGTERM; unbounded waitUntilExit); deferred with the 17b minor — cheap to fold into the fix wave (bounded wait then SIGKILL).
V5: D4 keep high 85 — parse far doctor stdout whatever the exit code; throw only when stdout isn't a report; test with an exit-1 doctor.
V5: I7 keep high 80 (intent) — --forget skips the remote uninstall entirely; test forgetting a reachable machine makes no remote call.
V5: A19 keep low 75 — rename addHost's machine-id step (e.g. 'identity') and keep each phase contiguous (registry too).
V5: D15 below floor (medium 60) — host list gateway column always no; deferred (set record.gateway in enableHost or derive it).
V5: D25 below floor (medium 50) — far doctor/version JSON cast unvalidated; deferred (zod schemas).
V5: I14 below floor (medium 60, intent) — endToEnd lacks gateway authority / temp tmux window / path mapping; carried (gateway ask cheap once D1 lands).
V5: I15 below floor (medium 60, intent) — non-LTS only warns; 18.04 passes as LTS but can't run Node 22; deferred to Task 37/38.
V5: A21 below floor (low 45); A22 below floor (low 50) — deferred.
V3: D1 keep high 90 — enable --now GATEWAY_UNIT in startUnit; gateway in companion doctor/serviceOutcome; drop the template's plan-narrating comment.
V3: D2 keep high 90 — restart archid + gateway units when a release was replaced, before probing; probe compares the daemon's own system.info release.
V3: D7 keep high 90 — KillMode=process in the archid template (verified in an ubuntu:24.04 systemd container: default kills tmux + panes on crash; process keeps them).
V3: D8 keep medium 70 — hook/statusline node from path.join(o.release,'node','bin','node') when 'release' in o; test a bootstrap from a staging copy.
V3: D23 keep medium 75 — unset ARCHI_RELEASE_ROOT in the env archid hands tmux (set-environment -gu after server start, or strip from exec env).
V4: I9 keep high 90 (security) — the all-zero placeholder is a small-order Ed25519 point: signatures are forgeable without a key (verified: ssh-keygen -Y verify accepted forgeries on OpenSSH 10.3p1 and 9.6p1; verifyRelease accepted a forged release). Ship a comment-only allowed_signers (ssh-keygen refuses it, exit 255) until the real key exists; test that fails on the zero/placeholder key.
V4: D10 keep high 75 (security) — verify the --release archive on the Mac (unpack, verifyRelease + sshVerify against the controller's own allowedSigners) before upload; set `signed` from that result.
V4: I10 keep high 75 (intent) — launch.ts runFrom { release: <prefix>/current } when isRelease(); setup/desktop-install rewrite existing profile plists onto current.
V4: D12 below floor (medium 65) — Mac uninstall leaves releases/current/companions; deferred (cheap: move prefix cleanup out of the linux-only branch).
V4: G13 below floor (low 60) — remote companion tarball never removed; deferred (cheap).
V4: D16 dropped (documented manual entry point used for Task 12's signed-install proof).
V4: I16 dropped (the accepted Task 12 fix-round change).
V1: D3 keep high 90 — reproduced against a scratch localhost sshd: process B's open+close killed A's master, -L listener and an in-flight run. Stop sharing masters across processes (per-process socket, e.g. include the pid, or refuse to adopt a socket this process didn't spawn); close() exits only an owned master; connectRemote cancels its forward when its client closes.
V1: D21 keep medium 75 — SIGTERM/SIGINT/SIGHUP handler for `archi host …` (and any master-opening command) that closes open masters, then exits (Task 18 ruling obligation).
V1: G14 keep low 70 — announce() returns LOCAL when route.ownerMachineId === registry.localId.
V1: D6 below floor (medium 60) — no ServerAlive; deferred, but a one-line argv change (ServerAliveInterval=15, CountMax=3, ConnectTimeout=10) — fold in cheaply.
V1: D14 below floor (medium 50) — CLI gateway ask stalls 20 s on a black-holed gateway; ConnectTimeout above bounds it.
V1: D20 below floor (medium 55) — gateway `timeout` frame → other; same one-line mapping as `disconnected` — fold in cheaply.
V7: I11 keep medium 75 — refuse Finder reveal/open only in .remote (or treat .pending as local when the last connecting owner is local); show a pending refusal on the connect screen if one remains.
V7: D11 keep medium 70 — quote remote socket/session twice for the far shell; remote test with a spaced socket and a quote in the session name.
V7: I4 keep medium 70 (intent) — first ssh from the app has no tty: host-key/password prompts fail 255.
V7: I3 below floor (medium 65, intent) — no build can provision through the app (no companions map, HostArgs has no release).
V7: I6 dropped — verified: ssh falls back to a direct connection when the master refuses past MaxSessions; twelve surfaces open.
V7: I12 dropped — remote-owner display must stay truthful; flag-off local users can't reach it.
V7 note: its scratch sshd folder collided with V1's concurrent experiment at 21:58:50; V1's D3 verdict also rests on code reading (ssh.ts:115/196-200), so it stands.
