# Setting up a Linux machine

A fleet can run on one always-on Linux machine besides your Mac. That machine is also the fleet's **gateway**: it
keeps the record of which machine owns the fleet, so only one of the two ever runs it. This page covers what the
machine needs, how to add it, and how to look after it.

## Supported machines

| | Mac | Linux machine |
| --- | --- | --- |
| System | macOS 15 or newer | Ubuntu LTS, x86-64 or arm64. Ubuntu 24.04 is the tested release; a release other than an LTS is a warning, and any other system is refused. |
| Archipelago | The app, installed with `pnpm desktop:install` (see the [README](../../README.md#quickstart)) | Installed by `archi host add` from the Mac. It brings its own Node and needs no clone, pnpm or build tools. |
| Services | launchd, as for any fleet | systemd user services, with lingering on so the fleet keeps running after you log out |
| Tools | tmux, Git | tmux 3.x, Git, rsync 3.2.3 or newer, as Ubuntu 22.04 and later ship (`sudo apt install tmux git rsync`) |
| Network | Tailscale, and OpenSSH to the Linux account (Tailscale SSH works) | Tailscale |
| Agents | Claude Code 2.1.251 or newer and Codex 0.155.0 or newer, for the agents your fleet runs, each logged in on each machine | the same |

tmux 3.5 or newer is recommended on both, because Shift+Enter needs it; Ubuntu 24.04 ships 3.4, which works otherwise.

The Mac's bundled rsync is the one a handover uses; `archi doctor` checks it.

## The same home path

The Linux account's home must be the same path as your home on the Mac, such as `/Users/ada`. A fleet records full
paths everywhere: each character's folder, its Git worktrees, its agent's transcript, its browser tabs' `file:` URLs.
With the same home on both machines, every one of them means the same thing on either, and nothing is rewritten.

A symbolic link from `/Users/ada` to `/home/ada` is not enough: a process reports its resolved folder, and Git and the
agents record that. Make an account whose home really is that path, on the Linux machine:

```sh
sudo mkdir -p /Users
sudo useradd -m -d /Users/ada -s /bin/bash ada      # a new account
sudo usermod -d /Users/ada -m ada                   # or move an existing one you are not logged in as
```

The home path can be at most 59 bytes long, because the gateway's socket lives under it and a Unix socket path holds
at most 107. `archi host add` checks both and stops with these commands when the home is wrong.

A folder outside your home, such as `/Volumes/work/repo`, arrives at the same path on the other machine. The folder
that holds it (`/Volumes/work`) must exist there first, owned by the account.

## Turning it on

Everything for another machine in the app waits on one setting per fleet. Open the fleet's `fleet.json` (Settings →
Fleet config, or `~/.archipelago/fleet.json`) and set:

```json
"handover": { "enabled": true }
```

keeping any other keys in the `handover` object as they are. Then quit and reopen the app. Settings gains a
**Machines** section, the sidebar's foot a **Handover** button, and each character's card a **keep on this machine**
switch.

The `archi host`, `archi handover` and `archi fleet recover` commands work whether or not it is on.

## Adding the machine

In the app, open Settings → Machines → **Set up**, give the machine a name (lowercase letters, digits and dashes,
such as `studio`) and its ssh destination (such as `ada@studio`), and choose **Add machine**. From a terminal:

```sh
archi host add studio --ssh ada@studio
```

Both run the same steps and show each as it finishes:

1. **Connect.** One interactive ssh, so you can accept the host key and log in, then one control connection for the
   rest. From the app, ssh asks in a dialog.
2. **Prerequisites.** Ubuntu (a release other than an LTS is a warning) and its architecture, the home path,
   Tailscale, tmux, Git, rsync (older than 3.2.3 is a warning), systemd, free space (5 GiB or more) and lingering.
3. **Companion.** The Linux release matching this Mac's own release, checked against the digest this Mac's release
   pins and against its signature, copied over ssh and installed under `~/.local/share/archipelago` there.
4. **Service.** `archipelago-gateway.service` and `archipelago-archid@private.service` as systemd user units, started.
5. **Agent logins.** Claude Code and Codex on the machine: installed, Claude Code 2.1.251 or newer and Codex 0.155.0
   or newer, and logged in.
6. **Final probe.** The machine's own fleet answers through a forwarded port, its gateway answers, and tmux opens and
   closes a window there.
7. **Registry.** The machine is added to this Mac's list in `~/.config/archipelago/machines.json`.

It ends with **ready for handover**, or with a list of what is still for you to do. Archipelago never runs `sudo` and
never copies a login, so these are yours:

- A missing package: the action names the `apt` command, as `ssh ada@studio, then sudo apt install rsync`. An rsync
  older than 3.2.3 needs a newer one, which Ubuntu 22.04 and later ship.
- Lingering off: `ssh ada@studio, then loginctl enable-linger ada`. Without it the fleet stops when you log out.
- An agent not installed or not logged in: `ssh ada@studio`, install it, then `claude auth login` or `codex login`.
  Codex also asks once to trust Archipelago's hooks: start `codex` there and choose "Trust all and continue", or trust
  them with `/hooks`.

Adding the same machine again runs every check again and changes nothing that is already right.

### The companion release

`archi host add` installs the companion matching the Mac's release exactly: a handover needs the same release on both
machines. It takes it from the list the Mac's release carries, downloads it and checks its digest.

- A build made with `pnpm desktop:install` carries a companion for x86-64 Linux only. For an arm64 machine, build one
  from the same checkout and name it:

  ```sh
  pnpm release:companion --out /tmp/companions --arch arm64
  archi host add studio --ssh ada@studio --release /tmp/companions/archipelago-companion-<version>-linux-arm64.tar.gz --allow-unsigned
  ```

- `--release <archive>` installs that archive instead; `--allow-unsigned` accepts one without a signature, as every
  development build is. No release signing key exists yet, so every install today is unsigned; see
  [the security notes](../security/fleet-handover.md) for how releases are checked.

## Making it the fleet's gateway

A fleet moves only to the machine that is its gateway. After adding the machine, choose **Make it this fleet's
gateway** in the same panel, or:

```sh
archi host enable studio --fleet private
```

It creates the gateway's ownership record for the fleet, naming this Mac as the owner, and gives the machine its own
copy of the fleet (`archipelago-archid@<fleet>.service`, which starts read-only). The fleet stays on this Mac. Run it
once per fleet; `--fleet work` for a fleet named `work`. Then [hand the fleet over](handover.md).

## Looking after it

| Command | In the app | What it does |
| --- | --- | --- |
| `archi host list` | | Every machine in the registry, with its id and whether it is a gateway. |
| `archi host doctor <name>` | Check | The machine's own checks, plus whether it runs this Mac's release, its free space and its home path. A check marked ✗ fails and makes it exit 1; one marked ! is a warning. A fresh Ubuntu 24.04 warns on `tmux` (it ships 3.4), `gh` and `path`; none of these stops a handover. |
| `archi host upgrade <name>` | Upgrade | Installs this Mac's release there, restarts the gateway and every fleet's daemon, and checks each answers from the new release. If one does not, it goes back to the release before. |
| `archi host upgrade <name> --rollback [release]` | | Puts the machine back on the release before, or on the kept release named, restarts its units, and checks each fleet's daemon answers from it. |
| `archi host remove <name>` | Remove | Runs `archi uninstall --force` there and drops the machine from the registry. It refuses while the machine is the gateway of a fleet this Mac does not own, while it owns a fleet through any gateway, and while a handover holds any fleet here open, whatever its gateway; bring each back with `archi handover local` first. Its fleets and their files stay on that machine. |
| `archi host remove <name> --forget` | Forget | Drops the machine from the registry without reaching it, when it is gone. |

After you update Archipelago on the Mac (`git pull && pnpm desktop:install`), run `archi host upgrade <name>`: until
both machines run the same release, a handover stops with `incompatible_release`.

On the Linux machine itself:

- `archi setup --rollback [release]` puts the release before back, or the kept release named, restarts the units and
  checks each fleet's daemon answers from it. `archi setup` sets the machine up again from the release `current`
  names.
- `archi uninstall` refuses while the machine is a fleet's gateway, runs a fleet for its gateway, or holds a handover
  journal, since that would strand the fleet. `archi host remove` from the Mac checks the fleets that Mac knows of,
  then runs it with `--force`, which passes the refusal for a fleet another Mac keeps there too.
- Each fleet's own log is `archid.log` in its fleet home (`~/.archipelago` for the private fleet), beside the units'
  logs in `~/.local/share/archipelago/log`.
- `systemctl --user status archipelago-gateway archipelago-archid@private` shows the units.

## What is installed where

On the Linux machine, all under the account:

- `~/.local/share/archipelago/releases/<version>` and `current`, the release; `~/.local/bin/archi` points into it.
  Each install keeps the release before it, for a rollback, and removes older ones.
- `~/.config/systemd/user/archipelago-gateway.service`, and one `archipelago-archid@<fleet>.service` per fleet.
- `~/.local/share/archipelago/gateway/fleets/<fleet id>.json`, the ownership record of each fleet it is the gateway
  for, and `gateway/recoveries.ndjson`, the audit of every forced recovery.
- `~/.local/share/archipelago/log`, the units' logs.
- `~/.archipelago` (and `~/.archipelago-<name>`), the machine's copy of each fleet.

On the Mac:

- `~/.config/archipelago/machine.json`, this Mac's machine id, and `machines.json`, the registry. A registry that
  cannot be read is moved aside to `machines.json.broken-<time>` with a warning, and a command that then misses a
  machine names that copy.
- In each fleet home: `fleet.json` names the gateway, `owner.json` holds this machine's copy of the ownership record,
  and `controller/` holds the journal of a handover this Mac is running.
