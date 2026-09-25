# M2 gate — on-machine pass (brief)

Goal (plan M2 gate): "Provision a clean supported Ubuntu x86-64 account from the built app, with no
checkout, Node or pnpm. Create a remote-only test fleet, open twelve terminal surfaces, drop/reconnect
SSH, and verify the daemon survives logout and Mac app exit." Also owed here: Task 13's on-machine
pass of the real systemd user units, and Task 18's check that `host add` works without a tty.

You verify; you do not change product code. When something fails, capture the exact command, output
and the file:line you believe is responsible, and keep going with whatever else can still be proven.
A defect that blocks the rest ends the pass early with status BLOCKED.

## Authorised by the owner (and only this)
- Remote: linus-vault, `ssh 100.117.42.24` (you log in as `linus`, passwordless sudo). Ubuntu 24.04
  x86_64, tmux 3.4, Tailscale up.
- You may create ONE throwaway user `archi-m2` there with sudo: `adduser --disabled-password`,
  authorise the Mac's own public key for it (find which key `ssh -G 100.117.42.24` offers), and
  `loginctl enable-linger archi-m2`. At the end: stop its user services, disable linger, and
  `deluser --remove-home archi-m2`, then confirm the user and its processes are gone.
- Everything else under `linus` on the remote is read-only: never touch linus's files, services,
  fleets or crontab.
- NEVER run `tailscale serve`, `tailscale funnel` or `tailscale set`, and never change the existing
  serve mapping `/` → 127.0.0.1:8787. Before running `host add`, grep the code paths it executes to
  prove none of them call tailscale with a mutating subcommand; read-only `tailscale status` is fine.
  Check `ss -ltnp` first and make sure nothing the pass starts binds a port already in use (8787 in
  particular).
- Mac side: never touch the owner's real ~/.archipelago*, ~/Library/LaunchAgents, /Applications,
  ~/.ssh or ~/.local/bin. Use a temp HOME under your scratchpad, `ARCHI_APP_DEST` pointing into it,
  and `--no-launchctl` wherever setup runs. OpenSSH reads ~ from getpwuid, not $HOME, so ssh still
  uses the real ~/.ssh and known_hosts (which already knows 100.117.42.24's key) — read, never write.
- The zsh in this environment has an nvm `node` function that breaks under an overridden HOME: write
  every temp-HOME step as an `sh` script in your scratchpad that captures `$(command -v node)` first.
  The Bash guard refuses long compound commands; put them in scripts.

## Steps
1. Read the Task 12, 13, 15, 17a and 18 reports in the workspace (task-12-report.md … task-18-report.md,
   task-17-contract.md) to learn how the controller app and the linux-x64 companion archive are built
   and signed locally, and how `host add` finds the companion archive (`--release <archive>`).
2. Build the Mac controller app (bundled release inside Archipelago.app) and the linux-x64 companion
   archive from HEAD of this worktree. Install the app into the temp `ARCHI_APP_DEST`. From here on,
   every Mac-side command runs the app's bundled helper (`…/Contents/Resources/release/bin/archi`),
   never the checkout, tsx or pnpm.
3. Create `archi-m2` as above. Confirm it has no Node, pnpm or checkout on its PATH.
4. Run `archi host add m2 --ssh archi-m2@100.117.42.24 --release <companion archive>` (and whatever
   `host enable` / fleet flags the reports say a remote-owned test fleet needs) under the temp HOME,
   with stdin from /dev/null and no tty, as the Mac app would. Record every NDJSON step. Then
   `archi host doctor m2 --json`.
5. Make a remote-only test fleet: a fleet whose owner is the remote machine, served by the remote
   archid under systemd. Find the supported way in the code (setup on the remote with a profile, the
   gateway authority record naming the remote as owner, `--host m2` routing); report exactly what you
   had to do by hand, because a missing supported path is a finding.
6. Run `archi connect --json` for that fleet from the bundled helper. Prove the API works through the
   forward (fetch state with the token it printed, without printing the token into any file you keep).
7. Twelve terminal surfaces: create enough characters/terminals on the remote fleet through the API,
   then hold twelve concurrent remote attaches exactly as the app builds them
   (`ssh -S <controlSocket> -tt -- <dest> tmux -S <socket> attach -t <session>`, each under a pty,
   e.g. `script -q /dev/null …`) over the single master. Watch in particular for sshd's per-connection
   MaxSessions limit (default 10) — the 11th and 12th session over one master is the interesting case.
8. Drop and reconnect: kill the master (and separately the forward); confirm `archi connect` emits
   `connecting` then `online` again within its backoff and the attaches can be rebuilt.
9. Survives logout and Mac app exit: close stdin of `archi connect` (the app's quit), close every ssh
   session of archi-m2, confirm archid and the gateway still run under systemd (`systemctl --user`
   via a fresh login, `ps -u archi-m2`), then reconnect and see the same state.
10. Clean up both sides as authorised above; kill every ssh master and helper you started; remove the
    temp HOME. Confirm linus's serve mapping and services are exactly as before (compare
    `tailscale serve status` and `systemctl --user list-units` for linus before and after).

## Report
Write W/m2-onmachine-report.md: per step, the commands (tokens redacted), key output, PASS / FAIL /
NOT RUN, and for every FAIL the suspected file:line. End with a list of defects, each with severity
(Critical/Important/Minor) and evidence.
