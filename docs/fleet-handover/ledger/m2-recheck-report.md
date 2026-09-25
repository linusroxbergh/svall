# M2 gate — on-machine re-check after the fix wave

Status: **DONE_WITH_CONCERNS**

All twelve R-items pass at `349d161`. Every fix the wave claimed for these items holds on the real machine.
The concerns are three new Minor findings (listed under Defects). None of them blocks the gate.

| Item | Fix | Result |
| --- | --- | --- |
| R1 | F15 | PASS |
| R2 | F17 | PASS |
| R3 | F18 | PASS |
| R4 | F19 | PASS |
| R5 | F3 | PASS |
| R6 | F29 | PASS |
| R7 | F5 | PASS |
| R8 | F4 | PASS |
| R9 | F11 | PASS |
| R10 | F12 | PASS |
| R11 | F16 | PASS (it needed a controller of the same release; see R11) |
| R12 | cleanup | PASS |

`$S` below stands for the scratch directory
`/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/81a5d143-473b-4b4a-8147-d28e03ccff44/scratchpad/m2-recheck`.
It holds every script, `logs/` (the output of each step), `run/` (the driver's redacted event and API logs) and `baseline/`.
The temp HOME, the installed app, the scratch builds and the socket directory were deleted at cleanup.

## Setup

| | |
| --- | --- |
| Build | `$S/build.sh` builds the web and mobile pages, then runs `apps/desktop/mac/build.sh release`. Since F27, that script also builds the linux-x64 companion into `build/companions` and pins it in the bundled `release.json` by a `file:` URL and sha256 (checked: the URL and digest match the archive). `git describe --dirty` = `349d161` before and after. `git status` was clean. |
| Mac | Same as the first pass: temp HOME `$S/home`, `ARCHI_APP_DEST=$S/home/Applications`, Finder PATH (no Node on it), `TMPDIR=/private/tmp/claude-502/m2r/` (a short symlink into `$S/tmp`). Every Mac command ran the bundled helper `…/Archipelago.app/Contents/Resources/release/bin/archi`. |
| Remote | linus-vault. Throwaway user `archi-m2` (uid 1002), created by `create-user.sh` and given linger. Its `~/.bashrc` puts failing stubs for `node`, `npm`, `npx`, `pnpm`, `corepack` and `tsx` first on PATH (`stub-node.sh`); after that, `node -v` exits 127. |
| Tailscale | Checked in this build's `lib/archi.mjs` and `lib/archid.mjs`, and in source. `tailscale serve` is reached only from `serve()` and `unserve()` (`packages/archid/src/mobile.ts:67,72`). Those run only from the `mobile.set` API method (`api/methods.ts:51`) and `archi mobile`. This pass called neither. There is no `funnel` and no `tailscale set` anywhere. Before the pass, 47800 was free and 8787 was held by linus's `bun`. The gateway listens only on a unix socket. |

## R1 (F15): `host add` starts the gateway; `doctor` reports it; `enable` works with no H1 — PASS

The command ran with no tty and stdin from `/dev/null` (`$S/04-host-add.sh`):

```
archi host add m2 --ssh archi-m2@100.117.42.24 --release <archipelago-companion-349d161-linux-x64.tar.gz> --allow-unsigned --json </dev/null
tty: not a tty; exit 1 after 9 s (result "actions": only the claude/codex warnings); stderr empty
service  ok "archipelago-archid@private.service: loaded, active (running), enabled; archipelago-gateway.service: loaded, active (running), enabled"
identity ok "349d161, machine 70c58727-…"   (the step F13 renamed)
probe ok · registry ok
```

- Remote state (`remote-state.sh`): both units are `enabled enabled` and `active running`. `gateway/authority.sock` is 0600 in a 0700 directory. archid listens on `127.0.0.1:47800`.
- The upload was deleted from the remote (F14): `~/.cache/archipelago` is empty.
- No hand step was needed.

`archi host doctor m2 --json` exited 0 and now carries a gateway row:

```
ok gateway - archipelago-gateway.service: loaded, active (running), enabled
ok systemd, archid "running on port 47800", linger, hooks, release "349d161, protocol 10; this controller runs 349d161, protocol 10"
```

`host enable` for a local test fleet (`$S/r1-enable.sh`):

- The fleet is the profile `~/.archipelago-m2local`. It is a copy of the far fleet.json with a fresh id, `65d3b931-…`.
- `archi host enable m2 --fleet m2local --json` gave `authority ok "m2 holds fleet 65d3b931-… for a1b9374b-… (this Mac) at generation 0"`, `fleet ok`, result `ready`, exit 0.
- fleet.json now names `gatewayMachineId 70c58727-…`. No master was left behind.
- H1 was not run.

## R3 (F18): hooks and the statusline name a node under `current` — PASS

`r3-hooks.sh` checked the remote `~/.claude/settings.json`. All 7 commands (6 hooks and the statusline) name `n='/home/archi-m2/.local/share/archipelago/current/node/bin/node'`. That path exists and is executable, and it resolves to `releases/349d161/node/bin/node`. No staging directory is left.

## Remote-owned fleet: H2–H4 as before (H1 no longer needed)

- `05b-remote-hand.sh`, as archi-m2:
  - The gateway unit was left exactly as `host add` left it: `active running enabled`.
  - `owner get` for the far fleet `4484c6f8-…` gave `not_found`.
  - **H2**: `gateway owner create` with `initialOwnerMachineId` 70c58727 gave generation 0.
  - **H3**: `gatewayMachineId` was added to the far fleet.json, and archid was restarted. archid went 3345946 → 3350308, and the **tmux server stayed 3345965**. `connection-info` reports generation 0.
- **H4** (`05c-mac-hand.sh`): the Mac's `~/.archipelago/fleet.json` was set to the far fleet plus `gatewayMachineId`. Then `archi status --json` exited 0, and `route.json` = `{ownerMachineId: 70c58727…, generation: 0}`. No master was left behind.
- The driver (`driver.mjs`, unchanged from the first pass) spawned `archi connect --json`:
  - `connecting m2` at +61 ms, `online` at +914 ms on port 58250, with controlSocket `…/m2r/archi-502/972df0db8094`.
  - `system.info` and `state.get` answered through the forward.
  - `setup12` with count 4 made an island, four plain-shell characters and four `term.attach`.
  - Four surfaces were held, each built as `AttachCommand.build` now writes it. The socket and session are quoted twice (F24): `ssh -S '<sock>' -tt -- 'archi-m2@…' tmux -S ''\''/home/archi-m2/.archipelago/tmux.sock'\''' attach -t ''\''v-c_81cra6'\'''`. All four came up over the one master: one TCP connection, and remote sshd `archi-m2@pts/5,pts/6,pts/7,pts/8`.

## R7 (F5): keepalive and connect timeout on the master — PASS

```
33266 33254 ssh -M -S /private/tmp/claude-502/m2r/archi-502/972df0db8094 -N -o BatchMode=yes -o ControlPersist=no
            -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10 -- archi-m2@100.117.42.24
```

## R4 (F19): no ARCHI_RELEASE_ROOT in the panes — PASS

`r4-env.sh`:

- archid has `ARCHI_RELEASE_ROOT` in its environment, from the shim (count 1).
- The tmux server's `/proc/<pid>/environ` does not have it (0).
- `tmux show-environment -g ARCHI_RELEASE_ROOT` gives `unknown variable`.
- None of the nine panes have it: `_keep`, the four character panes, and the four `v-` viewer panes. Each pane carries only `ARCHI_HOME` and `ARCHI_CHAR_ID`.

## R5 (F3): `archi status` and `host doctor` leave the helper's master alone — PASS

`r5-share.sh` ran while the helper held master 33266, forward 58250 and four attaches. The same temp HOME and TMPDIR were used.

```
archi status --json      -> exit 0; master 33266 "Master running"; listener 58250 = ssh 33266; API ok; attaches alive 4; sockets: 972df0db8094 only
archi host doctor m2     -> exit 0; same, all four checks unchanged
35 s later (a helper tick): no helper event at all; API ok; attaches alive 4; helper stderr empty
```

`r5-sockets.sh` ran both commands at once and sampled `ps` every 50 ms:

```
33266 (ppid 33254 helper)  …/972df0db8094
36363 (ppid 36347 status)  …/56b98cd4c64c   then 36376 (same process, same socket)
36364 (ppid 36350 doctor)  …/36c6be6ca646
after: masters 33266 only; sockets 972df0db8094 only
```

Each process got its own socket, and each process's master was gone afterwards. By contrast, at `11f3f3d` each of these commands had ended the app's master (first pass §8c).

## R6 (F29): a cancelled forward is noticed — PASS

`r6-cancel-forward.sh`:

```
ssh -S <sock> -O cancel -L 127.0.0.1:58250:127.0.0.1:47800 -- archi-m2@… at 21:12:40.2  -> exit 0, listener gone
connecting m2 21:13:08.5 · online 21:13:09.3 on port 58344 (29 s, within the 30 s tick) · API probe ok, 4 characters
```

- To recover, the helper ends the whole master. Old master 33266 is gone; new master 37343 uses the same socket path.
- As a result, all four attaches ended with `Shared connection … closed` (see Defects, Minor 1).
- A fresh `term.attach` for each character brought all four back (`reattach.sh`). That is the page's `term.exited` path from F28.

## R8 (F4): SIGTERM on `host doctor` leaves no master — PASS

`r8-sigterm-doctor.sh` and `r8b-sigterm-midrun.sh`. In the mid-run form, the signal lands while the doctor's remote command (`ssh -S <its sock> … -- archi-m2@… '/home/archi-m2/.local/share/archipelago/…'`) is running:

```
TERM (as the master opened)  exit 143; its master gone
TERM mid-run  exit 143; its master gone        TERM mid-run  exit 143; gone
INT  mid-run  exit 130; gone                   HUP  mid-run  exit 129; gone
orphaned ssh -M (ppid 1): none, every time; sockets left: only the helper's; helper master 37343 alive throughout
```

No stray `archi doctor` process was left on the remote either.

## R2 (F17): a daemon crash and a restart leave tmux alone — PASS

`r2-crash-restart.sh`, as archi-m2, with four surfaces attached from the Mac:

```
before:          archid 3350308, tmux server 3345965, 4 character windows, 5 sessions, 5 clients
                 panes c_81cra6=3353036 c_9gexmr=3353053 c_a69dcc=3353085 c_rg4du1=3353069
kill -9 3350308  -> archid 3370681 NRestarts=1 active; tmux server 3345965; same 4 pane pids; 4 of 4 alive; 5 clients
systemctl --user restart -> archid 3370843; tmux server 3345965; same 4 pane pids; 4 of 4 alive
Mac: all four attaches stayed up through both
```

- After the crash, only one control client is left (`-C attach-session`, owned by the new archid). The old one is gone.
- The first pass saw the tmux server replaced and 12 → 0 windows after the same `kill -9`.
- The tmux server still sits in the archid unit's cgroup, which systemd logs every time (see Defects, Minor 2).

## R11 (F16): `host upgrade` restarts both units and probes the new release — PASS

- A second companion was built from the same tree under another release name: `build-companion.mjs --version 349d161-m2b`.
- First attempt: the app's 349d161 controller refused it at the `release` step. The message was "… is release 349d161-m2b, not this controller's 349d161; a handover needs the same release on both machines" (`install.ts:71`). That is by design: a machine is upgraded to the controller's own release.
- So a matching controller was built with `build-controller.mjs --version 349d161-m2b`, as an app update would bring. Its `bin/archi` ran against the same temp HOME and registry (`r11b-upgrade.sh`):

```
machine ok · master ok · release ok "349d161-m2b … (unsigned)" · upload ok · install ok · probe ok "m2 answers on release 349d161-m2b"; result ready, 9 s
archid   3370843 (releases/349d161 node)  -> 3388976 (releases/349d161-m2b node), started 23:16:17
gateway  3345970 (releases/349d161 node)  -> 3388985 (releases/349d161-m2b node), started 23:16:17
current -> releases/349d161-m2b; archi version "349d161-m2b"; the upload deleted from ~/.cache
system.info through the (old) helper's forward: release "349d161-m2b"
host doctor: release ok "349d161-m2b, protocol 10; this controller runs 349d161-m2b"; gateway ok; systemd ok
tmux server 3345965 and the four pane pids unchanged across the upgrade
```

## R10 (F12): removing a gateway refuses and lists the fleet — PASS

`r10-remove-refused.sh`. At this point `~/.archipelago` names m2 as its gateway, and its route names m2 as owner. `~/.archipelago-m2local` also names m2.

```
archi host remove m2 --json          -> machine ok; fleet fail "m2 is the gateway for ~/.archipelago, which another machine owns",
                                        action "disable handover for ~/.archipelago first, then remove m2"; result actions
archi host remove m2 --forget --json -> the same refusal
```

- Both fleet.json files, `machines.json` and `route.json` were unchanged (md5).
- m2 is still in the registry.
- Sampled at 50 ms, no ssh to m2 was started beyond the helper's own processes.

## R9 (F11): `--forget` on a reachable machine touches nothing there — PASS

`r9-forget.sh`, run after the driver quit (`quit.sh`: helper exit 0 in 34 ms, not escalated; no master, forward or socket left):

- H4 was undone first: the Mac's hand-made copy of the far fleet (`~/.archipelago`) was deleted. Otherwise R10's refusal applies.

```
archi host remove m2 --forget --json -> machine ok; fleet ok "~/.archipelago-m2local stop naming m2 as their gateway";
   uninstall skip "m2 is left untouched"; registry ok "m2 is forgotten; the machine was left untouched"; result actions (exit 1)
```

- `r9-remote-snap.sh` took a remote snapshot before and after. `diff` found them **identical**. The snapshot covers:
  - unit files and their md5s, and active state, MainPIDs and NRestarts of both units
  - `current` and the release trees
  - the shims and the fleet home listing
  - the md5s of fleet.json, owner.json, token and node.json
  - both gateway records
  - the archid, gateway and tmux pids, and the character windows
- No ssh process to the machine ran during the forget.
- The remote sshd journal shows archi-m2 logins only at 21:17:33.27Z (the before snapshot) and 21:17:38.18Z (the after snapshot). The forget ran at 21:17:35 and made none.
- On the Mac, m2 left the registry, and `~/.archipelago-m2local` dropped its `gatewayMachineId`. That is F12's clear path for a fleet this Mac owns.

## R12: cleanup — PASS

Remote (`delete-user.sh`, run as linus):

- The user services were stopped and linger disabled; after `terminate-user`, archi-m2 had 0 processes. Then `deluser --remove-home`.
- As in the first pass, deluser left `/home/archi-m2/.archipelago/tmux.sock`, so `/home/archi-m2` was removed by hand.
- Final checks:
  - no user, passwd or group entry; `users` is back to `linus,ofm`
  - no `/home/archi-m2` and no `/run/user/1002`; the linger directory holds only `linus`
  - 0 uid-1002 processes, and 0 uid-1002 files in /tmp, /var/tmp, /run, linger or cron; no crontab, no mail spool
  - nothing on 47800; `/home` lists linus, ofm and Tdarr, as in the baseline
- linus's state: `diff baseline/linus-before.txt baseline/linus-after.txt` is empty. It covers `tailscale serve status --json` (still `/ → http://127.0.0.1:8787`), user services, timers, sockets and targets, unit files, the crontab digest, `~/.config/systemd/user`, the linger directory and the uid ≥ 1000 users.

Mac (`mac-cleanup.sh`):

- Left from this pass: 0 `ssh -M`, 0 helper or driver processes, 0 ssh to 100.117.42.24, 0 `script` or `sleep 86400`.
- Removed: the temp HOME (with the app), `$S/tmp`, the `m2r` symlink and the scratch builds (`companion`, `companion-b`, `controller-b`).
- `~/.ssh/known_hosts` md5 is unchanged (`1f403c13…`). `~/Library/LaunchAgents`, `~/.local/bin`, `/Applications/Archipelago.app` and `~/.config/archipelago` have the same mtimes as before.
- The real `~/.archipelago` directory mtime moved from 23:06:46 to 23:18:47. That is the owner's own running daemon (tsx archid started 19:58) writing its home; its mtime had also moved between the two passes. Every archi command in this pass ran under the temp HOME.
- `ssh -M … -- trift` (pid 52191, a vitest fake-ssh from 17:35) was there before the pass. It is not mine and was left alone.

Token hygiene: every token in `$S` reads `<redacted>`. No token was put on an argv or in any file kept here. The remote token files went with the user.

Worktree: `git status` is clean, and `describe` gives `349d161`. `vendor/ghostty` is empty again, and `GhosttyKit.xcframework` points back at the main checkout.

## Defects

No Critical or Important defects. Three new Minor findings:

1. **Minor — a lost forward costs every terminal.** When `alive()` finds the forward gone (F29, `packages/cli/src/controller/connect.ts:101`), `hold()` returns `dead` (`:121`). `live.close()` (`:198`) then sends `-O exit` to the whole master (`:102-105`) rather than re-adding the forward. So R6's reconnect also ended all four attaches, which live and healthy, rode the master. Recovery then depends on F28's `term.exited` → re-attach, which re-shows only the terminal in view. A forward dies on its own only through `-O cancel`, hence Minor. A fix would re-run `master.forward()` when only the port check fails.
2. **Minor — the tmux server stays in the archid unit's cgroup.** `KillMode=process` (`packages/archid/systemd/archipelago-archid@.service.in:17`) keeps tmux alive, as R2 proves. But at every start and stop, systemd logs "Found left-over process … (tmux: server) in control group … This usually indicates unclean termination" and "Unit process … remains running after unit stopped". It also charges tmux's memory to the daemon's unit. Starting tmux in its own scope (e.g. `systemd-run --user --scope`) would silence this, and it would keep a later `KillMode` change from reaching tmux.
3. **Minor — a routed one-shot command logs in twice.** `archi status` opened two masters in turn on the same socket (36363 then 36376, both under pid 36347; before that, 34919 then 34928). The gateway lookup closes its master before the owner connection opens one. Both go to m2, so every routed command pays two SSH handshakes. This is not a fix-wave regression, and it is harmless.

Carried, unchanged, not in the fix list (not re-diagnosed):

- `host add` and `host upgrade` still show the `install` step as `ok` with the "shims … not on PATH" warning as its detail.
- More than 10 surfaces on one master (first-pass defect 3) was not re-run: this pass held four.

Not a defect: `host upgrade` refuses a companion whose release differs from the controller's own. So a machine can be upgraded only after the app is. That is the stated rule ("a handover needs the same release on both machines").
