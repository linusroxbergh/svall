# M2 gate — on-machine pass report

Status: **DONE_WITH_CONCERNS**

Every step ran. The gate's main path works on the real machine:

- The built app's bundled helper provisioned a clean Ubuntu 24.04 x86-64 account in 9 s, with no tty.
- A remote-owned fleet was reached through `archi connect --json`, and its API answered through the forward.
- Twelve remote terminals were attached. Two master drops were recovered.
- The daemon and gateway survived logout and the app quitting. The same fleet came back with the same pane processes.

Five defects (one Critical, three Important, one Minor), plus four Minor findings, were found. Two of the Important ones break the M2 gate criteria as written ("drop/reconnect SSH" and "twelve terminal surfaces"). The Critical one is Linux-only: any daemon restart or crash kills every terminal in the fleet.

Scratch: `/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/81a5d143-473b-4b4a-8147-d28e03ccff44/scratchpad/m2-onmachine`. In the rest of this report, `$S` stands for that path. It holds the scripts, `logs/` (per-step output) and `baseline/` (before/after state of linus's account). The temp HOME and the driver's run directories were deleted at cleanup; the key lines are quoted below.

## Environment

| | |
| --- | --- |
| Build | worktree HEAD `11f3f3d`; `git describe --dirty` = `11f3f3d` before, during and after the build; `git status` clean at the end |
| Mac | temp HOME `$S/home`, `ARCHI_APP_DEST=$S/home/Applications`, `PATH=/usr/bin:/bin:/usr/sbin:/sbin` (the PATH of a Finder-launched app, so no Node on it), `TMPDIR=/private/tmp/claude-502/m2t/` (a symlink into `$S/tmp`, kept short so control-socket paths fit the 104-byte limit). The tool shell has no controlling tty (`ps` shows `??`; `/dev/tty` gives "Device not configured"). |
| Remote | linus-vault, Ubuntu 24.04.2 LTS, kernel 6.8, x86_64, tmux 3.4, rsync 3.2.7, git 2.43, systemd 255, sshd `MaxSessions 10` |
| Throwaway user | `archi-m2`, uid 1002, created and deleted by this pass |
| ssh key | `ssh -G` + `-v` show `~/.ssh/id_rsa` (RSA SHA256:zGoxc1k…) is the key the remote accepts; its `.pub` was authorised for archi-m2 |

## Step 1 — read the reports: DONE

Read tasks 12, 13, 15, 16b, 17a and 18, the Task 17 contract, the M2 intent and rulings, known-minors and progress.

`host add` finds the companion archive from `--release <archive>`. The build is unsigned: `allowed_signers` is still the placeholder, and no `ARCHI_RELEASE_KEY` is set. So `--allow-unsigned` is required.

## Step 2 — build and install: PASS

```
$S/build.sh
  pnpm --filter @archipelago/desktop-web build; … build:mobile
  (temporary symlinks vendor/ghostty/{macos,zig-out} -> main checkout, removed after; GhosttyKit.xcframework link restored)
  apps/desktop/mac/build.sh release        -> Build complete!, Archipelago.app with Contents/Resources/release (darwin-arm64, 11f3f3d)
  node scripts/build-companion.mjs --out $S/companion --arch x64
       -> archipelago-companion-11f3f3d-linux-x64.tar.gz (45,093,156 B, "signed": false)
$S/02-install.sh   cp -R Archipelago.app $ARCHI_APP_DEST/; <app>/Contents/Resources/release/bin/archi version --json
  {"release":"11f3f3d","machineId":"59aa2339-…","protocol":10,…,"runtime":{"node":"v22.23.2","platform":"darwin","arch":"arm64"}}
  which node on this PATH: none
```

From here on, every Mac-side command ran `$ARCHI_APP_DEST/Archipelago.app/Contents/Resources/release/bin/archi`. None ran from the checkout, tsx or pnpm.

`archi setup` was not run on the Mac. The app's helper runs from inside the bundle, and nothing in this pass needs a local daemon.

## Step 3 — create archi-m2: PASS (with a caveat about Node)

```
(as linus) sudo adduser --disabled-password --gecos "" archi-m2
           sudo install -d -m 700 -o archi-m2 -g archi-m2 /home/archi-m2/.ssh; tee authorized_keys (id_rsa.pub); chmod 600
           sudo loginctl enable-linger archi-m2
  -> uid=1002(archi-m2) … Linger=yes; ssh -o BatchMode=yes archi-m2@100.117.42.24 works
```

- No pnpm, tsx, archi or checkout is on archi-m2's PATH.
- **Caveat:** the machine itself ships Node in `/usr/bin/node` and `/usr/local/bin/node` (plus npm/npx). I could not remove them; that would change linus's machine.
- To make "no Node" true for the account, archi-m2's own `~/.bashrc` got a first line that puts `~/.m2-no-node` first on PATH. That directory holds stubs for `node`, `npm`, `npx`, `pnpm`, `corepack` and `tsx`, each of which prints an error and exits 127. After that, `command -v node` resolves to the stub and `node -v` exits 127.
- Evidence that the companion never needed the system Node:
  - `host add` ran every remote command through that shell and passed.
  - `/proc/<archid>/exe` is `…/releases/11f3f3d/node/bin/node`.
  - The bin shims exec `$ARCHI_RELEASE_ROOT/node/bin/node`.

## Step 4 — `host add` with no tty, then `host doctor`: PASS

Proof that no tailscale mutation is reachable, checked in the shipped bundles (`lib/archi.mjs`, `lib/archid.mjs`):

- `tailscale serve …` is called only from `serve()`/`unserve()`.
- Those are reached only from the `mobile.set` API method (dispatch `"mobile.set": (p,{mobile}) => mobile.set(p.enabled)`) and from `archi mobile on|off`.
- `host add` runs only `command -v tailscale`.
- `doctor`, `setup`, `connect`, `uninstall` and `gateway` contain no tailscale call.
- No `funnel` or `tailscale set` exists anywhere.
- Before the pass, `ss -ltnp` showed 47800 free, and 8787 was held by linus's `bun`.

```
$S/04-host-add.sh   (tty: not a tty; stdin /dev/null)
archi host add m2 --ssh archi-m2@100.117.42.24 --release $COMPANION --allow-unsigned --json </dev/null
exit 1 after 9s   (stderr empty; exit 1 = result "actions", only the two agent warnings)
name ok · ssh ok "accepted an interactive login" · master ok · os ok "Ubuntu 24.04 x64 (LTS)"
home ok "/home/archi-m2 for archi-m2" · tools ok "tailscale, tmux, git, rsync, systemctl, loginctl"
tmux warn "tmux 3.4: Shift+Enter needs tmux 3.5 …" · rsync ok "3.2.7" · space ok "210.6 GiB" · linger ok "on for archi-m2"
release ok "11f3f3d for linux-x64 from the archive you named (unsigned)"
upload ok "… -> /home/archi-m2/.cache/archipelago/companion-11f3f3d.tar.gz"
install ok "! shims  /home/archi-m2/.local/bin is not on PATH, so your shell will not find archi; add it in your shell profile"
service ok "archipelago-archid@private.service: loaded, active (running), enabled"
machine ok "11f3f3d, machine f84f88e8-3e73-48fd-9610-07d1904f9ad7"
claude warn / codex warn "not installed" (actions: ssh archi-m2@…, then install …)
probe ok "m2 answers on its own private fleet" · registry ok "m2 is machine f84f88e8-…"
{"result":"actions","actions":["ssh archi-m2@100.117.42.24, then install Claude Code","ssh …, then install the Codex CLI"]}

archi host doctor m2 --json   -> exit 0: tmux warn, node ok v22.23.2, claude warn, shims warn, gh warn, archid ok "port 47800",
                                 systemd ok, linger ok, hooks ok, codex skip, release ok "11f3f3d, protocol 10; …", space ok
archi host list --json        -> linuss-macbook-pro (this machine) + m2 linux-x64 gateway "no"
```

On the remote:

- `archipelago-archid@private.service` is enabled and running. `archipelago-gateway.service` is **disabled**.
- archid listens on `127.0.0.1:47800`.
- `current -> releases/11f3f3d`.
- The unit file matches Task 13's template and passes `systemd-analyze --user verify`.

Task 18's check: `host add` works without a tty. **PASS.** The host key was already in `~/.ssh/known_hosts`. The unknown-host-key path was **NOT RUN**, because it would need a write to the owner's `known_hosts`.

As the controller noted: the app's Add Machine carries no `--release`, so the CLI was driven with `--release … --allow-unsigned`.

## Step 5 — a remote-only test fleet: PASS, but only by hand (known gaps 1 and 2)

There is no supported path, so the fleet is archi-m2's own `private` fleet (id `15863dbd-023c-4917-8776-41fb914f008d`). It is the only remote fleet that setup puts under systemd. `archi setup` refuses any other profile: `archi setup configures the private fleet`.

First, the gap as it shows up:

```
(Mac) ~/.archipelago/fleet.json := the remote fleet.json (same id), no gatewayMachineId yet
archi host enable m2 --fleet private --json
  authority fail "the gateway authority did not answer on /home/archi-m2/.local/share/archipelago/gateway/authority.sock:
                  Error: connect ENOENT …/authority.sock"   (action = the same raw text); exit 1; fleet.json unchanged
```

Hand steps, exactly:

- **H1** (remote, as archi-m2): `systemctl --user enable --now archipelago-gateway.service` → active (running), `authority.sock` 0600 in a 0700 dir.
- **H2** (remote, as archi-m2): `~/.local/share/archipelago/current/bin/archi gateway owner create --fleet 15863dbd-… --params '{"initialOwnerMachineId":"f84f88e8-…"}'`. Before this, `get` answered `not_found`. After it: `{"result":{"record":{"fleetId":"15863dbd-…","generation":0,"ownerMachineId":"f84f88e8-…"}}}`. `host enable` cannot do this step: it always seeds the Mac as owner.
- **H3** (remote, as archi-m2; this makes the remote fleet a consistent gated fleet): add `"gatewayMachineId":"f84f88e8-…"` to `~/.archipelago/fleet.json`, then `systemctl --user restart archipelago-archid@private.service`. After that, `connection-info --json` reports `"generation": 0`.
- **H4** (Mac temp HOME): `~/.archipelago/fleet.json` = the remote fleet.json plus `"gatewayMachineId":"f84f88e8-…"`. `connect`, `--host` and `connectRemote` all need a local fleet.json carrying the far fleet id (`packages/cli/src/controller/connection.ts:130`, `:237-242`).

Result, with no `--host`: `archi status --json` resolved m2 through the gateway, read the fleet, and wrote `~/.archipelago/controller/route.json` (0600) = `{ownerMachineId: f84f88e8-…, generation: 0}`. No master was left behind.

## Step 6 — `archi connect --json` and the API through the forward: PASS

A small Node driver (`$S/driver.mjs`, run by the bundled node) stands in for `ControllerProcess.swift`:

- It spawns `<app>/…/release/bin/archi connect --json`. There is no `-p`, exactly as the app does for `~/.archipelago`.
- It reads the NDJSON and keeps the token in memory only.
- It logs events with the token replaced by `<redacted>`.
- On `online`, it calls `system.info` and `state.get` over `ws://127.0.0.1:<port>`.

```
connecting {"owner":"m2"}                       t=117 ms
online {"host":"127.0.0.1","port":56356,"token":"<redacted>","remote":{"name":"m2","destination":"archi-m2@100.117.42.24",
        "controlSocket":"/private/tmp/claude-502/m2t/archi-502/998df2cbbf65"}}   t=1052 ms
API: machineId f84f88e8-… (m2), release 11f3f3d, 1 island, 0 characters
```

Token hygiene: at the end, the token (read into a shell variable over ssh, never printed) was searched for. It was in 0 files in the scratchpad, 0 in the temp HOME, 0 in this session's tool-output store and 0 in the remote logs. It was never in any argv.

## Step 7 — twelve terminal surfaces: PASS (twelve live), with an Important defect

Setup: `island.create` plus 12 × `char.create` (plain shells) through the forward, then 12 × `term.attach` → `{socket: /home/archi-m2/.archipelago/tmux.sock, session: v-c_…}`.

Each surface was started exactly as `AttachCommand.build` writes it, under its own pty:

```
sleep 86400 | script -q /dev/null /bin/sh -c "ssh -S '/private/tmp/claude-502/m2t/archi-502/998df2cbbf65' -tt -- 'archi-m2@100.117.42.24' tmux -S '/home/archi-m2/.archipelago/tmux.sock' attach -t 'v-c_xii4db'"
```

All twelve came up. Only ten of them rode the master:

```
attach 1–10:  prompt drawn
attach 11,12: "mux_client_request_session: session request failed: Session open refused by peer", then a prompt
remote: sshd 3005174 (the master) pts/13..22 → 10 × tmux attach;  sshd 3010678 pts/23 → 1;  sshd 3010747 pts/24 → 1
Mac:    TCP to :22 — the master (pid 92708) plus ssh 8161 and ssh 8471 (the 11th and 12th, each its own connection)
tmux:   13 clients (fleet control client + 12)
```

With the master full, the helper's 30 s re-resolution (`archi gateway owner get` via `master.run`) is also refused on the master and falls back to a fresh login. The sshd journal shows `Accepted publickey for archi-m2` followed by `session closed` at 21:54:13, 21:54:43, 21:55:13 and 21:55:44. Before the master filled there were none. → **Defect 3.**

## Step 8 — drop and reconnect

### 8a. Kill the master: helper PASS, surface rebuild FAIL

```
kill -9 <ssh -M pid> (19:56:43.0Z) -> 10 mux attaches end "Shared connection to 100.117.42.24 closed."; 11, 12 (direct) stay up
connecting m2 19:56:44.723Z · online (new forward 58132, same socket path) 19:56:45.490Z · API probe ok, 12 characters
second kill (20:02:07.0Z, stale socket file left by SIGKILL): connecting 20:02:19.823Z · online 20:02:20.608Z (13.6 s, the 30 s tick)
```

The helper recovers within its tick (≤ 30 s), as the contract says.

The surfaces cannot be rebuilt the way the app rebuilds them. Re-running the same attach commands (what `SurfaceManager.rebuild()` does, since it re-shows the stored `attach`) fails for all twelve:

```
can't find session: v-c_xii4db
Shared connection to 100.117.42.24 closed.
remote: tmux sessions 13 -> 1 (only "fleet"); the 12 character windows are intact in "fleet"
```

- `term.attach`'s `v-<id>` session gets `destroy-unattached on` once a client attaches (`packages/archid/src/tmux/tmux.ts:73`).
- A master drop detaches every client, so tmux destroys every viewer session.
- Calling `term.attach` again for each id recreated the sessions, and twelve fresh attaches all came up. This was verified after both kills.

→ **Defect 4.** In the app, recovery then depends on the page's `term.exited` → re-show path (`apps/desktop/web/src/terminals.ts:71-75`), which re-shows only the terminal in view (`inView`, line 37). This part is owed to the by-eye pass.

### 8b. Cancel the forward while the master lives: FAIL

```
ssh -S <sock> -O cancel -L 127.0.0.1:58132:127.0.0.1:47800 -- archi-m2@100.117.42.24   -> exit 0, listener gone
API probe on 58132 -> "ws error: Received network error or non-101 status code."
helper events over the next 75 s (two ticks): none; helper stderr: empty; master still alive
```

`hold()` only asks `live.alive()`, which is `master.check()` (`packages/cli/src/controller/connect.ts:79`, `:99`). A dead forward is never noticed. → **Defect 5.**

The test was recovered by killing the master (8a's second kill).

### 8c. Extra: a CLI command while the app is online: FAIL

```
master before: 23864; archi status --json (from the same user/TMPDIR, as a Terminal would) -> exit 0
master after: none; 10 of 12 surfaces "Shared connection … closed"; helper: connecting 20:03:20.973Z, online 20:03:21.667Z
archi host doctor m2 --json (what the Machines panel's Check runs)  -> master 39769 -> none
```

→ **Defect 2.**

## Step 9 — survives logout and Mac app exit: PASS (plus a Critical finding on crash)

```
before: archid MainPID 2999505 (started 21:51:13), gateway 2999280 (21:51:11), tmux server 2999522, NRestarts 0, 12 character windows
app quit (driver closes the helper's stdin, waits ≤ 1 s, then SIGTERM): helper exit 0 after 35 ms, not escalated;
    no ssh -M, no forward listener, socket dir empty, no mux clients, helper stderr empty
(as linus) loginctl sessions of archi-m2: none left; sshd processes of archi-m2: 0; State=lingering
fresh login: archipelago-archid@private.service MainPID=2999505 NRestarts=0 ExecMainStartTimestamp=21:51:13 active/running
             archipelago-gateway.service       MainPID=2999280 NRestarts=0 active/running; tmux 12 character windows
reopen (new driver): connecting m2 +128 ms, online +1082 ms; state.get: 12 characters t1..t12, same ids, islands [mission control, m2 pass]
pane processes: c_skdyit 3006914, c_ymy81p 3006883, … all started 21:53:11 (the originals); 12 fresh attaches alive
```

### Task 13, real units: a daemon crash takes the whole fleet down

```
(archi-m2) kill -9 2999505 at 22:05:36
after: MainPID=3069219 NRestarts=1 active at 22:05:38 (Restart=always, RestartSec=2 work)
tmux server 2999522 -> 3069233 (new); character windows 12 -> 0; the original pane processes: 0 alive
every attached surface: "[server exited]"; state.get: 12 characters, none with tmux (dormant)
journal: "Main process exited, code=killed, status=9/KILL" … "Scheduled restart job, restart counter is at 1"
```

The same happened on the plain `systemctl --user restart` in H3: the tmux server pid changed from 2990751 to 2999522. The tmux server lives in the unit's cgroup:

```
0::/user.slice/…/app-archipelago\x2darchid.slice/archipelago-archid@private.service
```

The unit has `KillMode=control-group`. → **Defect 1.**

Also checked, and fine: `systemd-analyze --user verify` passes on both units; the gateway log is written; the archid unit's own log file stays empty (archid logs to `~/.archipelago/archid.log`).

## Step 10 — cleanup: PASS

- The second driver quit: helper exit 0 in 36 ms. All attach processes and their subshells were stopped.
- `archi host remove m2 --json` (the supported teardown) gave: uninstall ok `kept /home/archi-m2/.archipelago; archi uninstall --purge deletes them`, registry ok, result `ready`.
  - On the remote, both units were stopped and removed. The release and the shims were removed. No archid, gateway or tmux process was left.
  - `~/.local/share/archipelago/gateway` (the authority record) and the fleet home were kept.
- Remote, as linus: user services stopped (none left), `loginctl disable-linger archi-m2`, `terminate-user`, `deluser --remove-home archi-m2`.
  - deluser removed the user and its group, and archi-m2's membership in `users`.
  - It **left `/home/archi-m2/.archipelago/tmux.sock`**: the tmux server had been SIGKILLed by the cgroup and never unlinked its socket, and deluser skips sockets. I removed `/home/archi-m2` by hand with `sudo rm -r -- /home/archi-m2`.
  - Final state: `id archi-m2` gives no such user. No passwd or group entry. No `/home/archi-m2`, no `/run/user/1002`. No linger file (only `linus`). 0 processes with uid 1002. No crontab, no mail spool. No uid-1002 files in `/tmp`, `/var/tmp` or the linger/crontab dirs. Nothing on 47800.
- linus, compared with the baseline taken before anything ran: `diff baseline/linus-before.txt baseline/linus-after.txt` shows no difference. It covers:
  - `tailscale serve status --json`: still `/ → http://127.0.0.1:8787`
  - user services/timers/sockets/targets, and user unit files
  - crontab digest, `~/.config/systemd/user`, the linger dir, and the users with uid ≥ 1000
- Mac:
  - No ssh master, helper, driver, `script` or `sleep` of mine is left.
  - The temp HOME (with the installed app), `$S/tmp`, the driver run directories and the `/private/tmp/claude-502/m2t` symlink are all removed.
  - `~/.ssh/known_hosts` md5 is unchanged (`1f403c13…`).
  - The owner's `~/Library/LaunchAgents`, `~/.local/bin`, `/Applications/Archipelago.app` and `~/.config/archipelago` have the same mtimes as before. The real `~/.archipelago*` was never opened.
  - One `ssh -M … -- trift` from a vitest fake-ssh temp dir (pid 52191) was already running before this pass. It is not mine and was left alone.
- Worktree: `git status` is clean at `11f3f3d`. The ghostty temp links are gone, and `GhosttyKit.xcframework` points back at the main checkout. The build outputs are the gitignored `apps/desktop/mac/build`, `apps/desktop/web/dist`, `dist-mobile` and `.build`.

## Defects

1. **Critical — on Linux, any stop, restart or crash of archid kills the fleet's tmux server, and with it every terminal and agent.**
   - Where: `packages/archid/systemd/archipelago-archid@.service.in:7-18` sets no `KillMode`, so the default `control-group` applies. The daemon starts the tmux server (`packages/archid/src/tmux/tmux.ts:96`), which therefore stays in the unit's cgroup.
   - Evidence: `kill -9` of the MainPID → `NRestarts=1`, tmux server replaced, 12 → 0 character windows, the original pane processes gone, surfaces print `[server exited]`. A plain `systemctl --user restart` also replaced the tmux server.
   - Why it matters: on the Mac the tmux server outlives archid. Here a crash, a rollback restart (`probeOrRollback`), or the restart an upgrade needs to pick up a new release, destroys all running work.
   - Suggested direction: `KillMode=process`, or start tmux in its own scope or unit.

2. **Important — a second `archi` process adopts the app helper's control master and shuts it down.**
   - Where: `SshMaster.start` reuses any live socket at `$TMPDIR/archi-<uid>/<sha(dest)>` (`packages/cli/src/controller/ssh.ts:113-119`). `close()` sends `ssh -O exit` whenever this process's refs reach 0 (`:196-201`), whoever spawned the master.
   - Evidence: `archi status --json`, and `archi host doctor m2` (the Machines panel's Check), each ended the app's master. 10 of 12 surfaces closed. The helper rebuilt at its next tick.
   - A Finder-launched app and a Terminal shell share the same per-user TMPDIR on macOS, so this happens in normal use.

3. **Important — more than 10 remote surfaces go past sshd's default `MaxSessions 10` on the single master.**
   - What happens: the 11th and 12th attach print `mux_client_request_session: session request failed: Session open refused by peer` into the terminal. ssh then silently falls back to a separate TCP connection with a fresh authentication. Those terminals survive a master drop and are not tracked by the helper. Where keys do not work, they would prompt for a password or host key inside the terminal.
   - Knock-on effect: while the master is full, every 30 s helper tick also becomes a full SSH login (journal: `Accepted publickey` every 30 s).
   - Where: `apps/desktop/mac/Sources/Archipelago/SurfaceManager.swift:28` puts every attach on the one `controlSocket`; `packages/cli/src/controller/connect.ts:56-89` holds one master.
   - Fix options: a master per 10 sessions, or detect the refusal.

4. **Important — rebuilding surfaces after a reconnect re-attaches to viewer sessions that tmux has already destroyed.**
   - Where: `SurfaceManager.rebuild()` (`apps/desktop/mac/Sources/Archipelago/SurfaceManager.swift:152-157`) re-shows each surface with its stored `attach`. But `v-<id>` gets `destroy-unattached on` on first attach (`packages/archid/src/tmux/tmux.ts:73`), so the drop destroyed it.
   - Evidence: all 12 rebuilt attaches printed `can't find session: v-c_…` (tmux sessions 13 → 1). A fresh `term.attach` per id fixed all 12, twice.
   - Recovery in the app depends on the page's `term.exited` → re-show, and that re-shows only the in-view terminal (`apps/desktop/web/src/terminals.ts:37`, `:71-75`).

5. **Minor — the helper never notices a forward that dies while its master lives.**
   - Where: `alive()` is only `master.check()` (`packages/cli/src/controller/connect.ts:79`, used at `:99`).
   - Evidence: after `-O cancel` of the advertised forward, the API port refused connections and the helper emitted nothing for 75 s.
   - Rated Minor because a forward only dies on its own through `-O cancel`. But the gate step "kill the forward → connecting, online again" fails as written.

Also found (Minor):

- **Minor — `host add`'s `install` step reports `ok` with a warning as its detail.** The detail is the last line of setup's output: `! shims /home/archi-m2/.local/bin is not on PATH …` (`packages/cli/src/controller/host.ts:324`). Doctor then repeats it as a `shims` warn. On a stock Ubuntu account, `~/.profile` adds `~/.local/bin` only for login shells, and only when the directory already existed at login.
- **Minor — `host add` leaves the 45 MB uploaded archive** at `~/.cache/archipelago/companion-<v>.tar.gz`. Only the staging dir is removed (`packages/cli/src/controller/install.ts:113-121`).
- **Minor — `host remove` of a machine that is a local fleet's gateway neither refuses nor warns** (`packages/cli/src/controller/host.ts:456-485`). Every later command on that fleet then fails with `fleet.json names gateway f84f88e8-…, which is not a machine in the registry`. It also leaves the far `~/.local/share/archipelago/gateway` records behind, which may be deliberate.
- **Minor — when the gateway unit is down, `host enable`'s action is the raw socket error** (`connect ENOENT …/authority.sock`) with no remedy (`host.ts:505-512`). This is close to the known-minor for the unreachable-gateway action.

Known gaps confirmed on the machine, not re-diagnosed (the controller's heads-up):

- The gateway unit is rendered but never enabled (`packages/archid/src/linux/setup.ts:100-117`). `host enable` fails, and `host doctor` has no gateway check.
- There is no supported way to create a remote-owned fleet. Hand steps H1–H4 above.
- The app's Add Machine carries no `--release`, and the unsigned build forces `--allow-unsigned`.
- tmux 3.4 on Ubuntu 24.04 means Shift+Enter is lost (warned, as ruled).
