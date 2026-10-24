# Setting up a Linux machine

A fleet can run on one always-on Linux machine besides your Mac. That machine is also the fleet's **gateway**: it
keeps the record of which machine owns the fleet, so only one of the two ever runs it. This page covers what the
machine needs, how to add it, and how to look after it.

## Supported machines

| | Mac | Linux machine |
| --- | --- | --- |
| System | macOS 15 or newer | Ubuntu LTS, x86-64 or arm64. Ubuntu 24.04 is the tested release; a release other than an LTS is a warning, and any other system is refused. |
| Svall | The app (see the [README](../../README.md#quickstart)) | Installed by `svall host add` from the Mac. It brings its own Node and needs no clone, pnpm or build tools. |
| Services | launchd, as for any fleet | systemd user services, with lingering on so the fleet keeps running after you log out; `svall host add` turns it on |
| Tools | tmux, Git | tmux 3.x, Git, rsync 3.2.3 or newer, as Ubuntu 22.04 and later ship (`sudo apt install tmux git rsync`) |
| Network | Tailscale, and OpenSSH to the Linux account with a key ssh can use without asking (Tailscale SSH works); a password gets only past the first login | Tailscale |
| Agents | Claude Code 2.1.251 or newer, Codex 0.156.0 or newer and OpenCode 2.0.22 or newer, for the agents your fleet runs, each logged in on each machine | the same |

tmux 3.5 or newer is recommended on both, because Shift+Enter needs it; Ubuntu 24.04 ships 3.4, which works otherwise.

The Mac's bundled rsync is the one a handover uses; `svall doctor` checks it.

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

The home path can be at most 65 bytes long, because the gateway's socket lives under it and a Unix socket path holds
at most 107. `svall host add` checks both and stops with these commands when the home is wrong.

A folder outside your home, such as `/Volumes/work/repo`, arrives at the same path on the other machine. The folder
that holds it (`/Volumes/work`) must exist there first, owned by the account.

## Turning it on

Everything for another machine in the app waits on one setting per fleet: Settings → The fleet → **remote machines
(experimental)**. Turned on, Settings gains a **Machines** section, the sidebar's foot a **Handover** button, and each
character's card a **keep on this machine** switch, without reopening the app. It stays on while the fleet names a
gateway, and is set where the fleet runs. The switch runs `svall handover on` (or `off`), which writes
`"handover": { "enabled": true }` into the fleet's `fleet.json`, keeping the other keys, so the setting moves with the
fleet; set by hand there, it takes effect when the app opens again. While the fleet runs on another machine the
switch is greyed out, as the app reads this Mac's copy of `fleet.json`: `svall handover on` in a terminal on the Mac
turns it on there, from the next time the app opens.

The `svall host`, `svall handover`, `svall gateway` and `svall fleet recover` commands work whether or not it is on.

## Adding the machine

In the app, open Settings → Machines → **Add machine**, give the machine a name (lowercase letters, digits and dashes,
such as `studio`) and its ssh destination (such as `ada@studio`), and choose **Add machine**. From a terminal:

```sh
svall host add studio --ssh ada@studio
```

Both run the same steps and show each as it finishes:

1. **Reaching the machine.** One interactive ssh, so you can accept the host key and log in, then one control
   connection for the rest, which needs a key ssh can use without asking. From the app, ssh asks in a dialog.
2. **What the machine needs.** Ubuntu (a release other than an LTS is a warning) and its architecture, the home path,
   Tailscale, tmux, Git, rsync (older than 3.2.3 is a warning), systemd, free space (5 GiB or more) and lingering,
   which it turns on where it is off.
3. **Svall on the machine.** The Linux release matching this Mac's own release, checked against the digest this
   Mac's release pins and against its signature, copied over ssh and installed under `~/.local/share/svall` there.
4. **Running Svall there.** `svall-gateway.service` and `svall-svalld@private.service` as systemd user units, started.
5. **Agent logins.** Claude Code, Codex and OpenCode on the machine: installed, Claude Code 2.1.251 or newer, Codex
   0.156.0 or newer and OpenCode 2.0.22 or newer, logged in (for OpenCode, `opencode auth list` names a model provider),
   and with Svall's hooks in place (for OpenCode, Svall's plugin), and for Codex a sandbox that starts, as the machine's
   own `svall doctor` finds them. Each agent is asked on the `PATH` and with the `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and
   `XDG_*` folders the Svall daemon runs with, which setup takes from your login shell there.
6. **Trying it out.** The machine's own fleet answers through a forwarded port, its gateway answers, and tmux opens and
   closes a window there.
7. **This Mac's list of machines.** The machine is added to this Mac's list in `~/.config/svall/machines.json`.

It ends by saying the machine is added, or with a list of what is still for you to do. In the app, a step that
failed with nothing named to do offers **Try again** (**Check again** after a check). Once it is added, **Make it
this fleet's gateway** (`svall host enable <name> --fleet <fleet>`) readies it for handover. Svall never runs `sudo`,
never runs an agent's installer and never copies a login, so these are yours.

In the app, each of them that is one command offers **Open terminal**: a terminal on the machine opens in the panel,
over an ssh of its own that asks nothing and forwards no ssh agent, with the command typed at its prompt. Press Return
to run it, or change it first; ⌘-click a link it prints to open it in your browser. When you exit or choose **Done**,
or close the panel with ×, the terminal hangs up and the panel checks the machine again, once it is in this Mac's
list. **Terminal** beside **Check** opens one with
nothing typed. From a terminal on the Mac, each action names the command and the machine to run it on:

- A missing package: the action names the `apt` command, as `ssh ada@studio, then sudo apt install rsync`. An rsync
  older than 3.2.3 needs a newer one, which Ubuntu 22.04 and later ship.
- Lingering the system would not turn on: `ssh ada@studio, then sudo loginctl enable-linger ada`. Svall turns it on
  itself where polkit lets an account do so, as on Ubuntu Server; a machine without polkit refuses. Without it the
  fleet stops when you log out, and a handover to the machine stops at its checks until it is on.
- An agent not installed or not logged in: `ssh ada@studio`, install it with its vendor's command and run
  `svall setup`, which writes Svall's hooks for an agent installed since, then `claude auth login`, `codex login` or
  `opencode auth login`. Claude Code prints a link and asks for the code the browser then shows. Codex's login waits
  for the browser on port 1455 of the machine: its terminal in the app forwards port 1455 of this Mac there, and
  quits saying so when another program holds that port; over your own ssh, use `ssh -L 1455:localhost:1455`, or
  `codex login --device-auth`. OpenCode runs OpenCode Zen's free models with no login. A handover to the machine needs a
  model provider's login or key there, as `opencode auth list` shows, unless OpenCode on the machine the fleet comes
  from has none either and its agent has answered there: then the checks only warn.
  Codex also asks once to trust Svall's hooks: start `codex` there and choose "Trust all and continue", or trust
  them with `/hooks`.
- Svall's hooks not installed, out of date, turned off or not trusted: the action names what the machine's own
  `svall doctor` says to do there.
- Codex's sandbox kept from starting by AppArmor, as on Ubuntu 24.04, where a Codex character would ask before each
  command: the action installs the AppArmor profile that lets `bwrap` make its user namespace,
  `sudo apt install bubblewrap apparmor-profiles`, then
  `sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/` and
  `sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict`, which the app types as one line for you to run
  with your own `sudo` password. A sandbox that fails for another reason names it;
  run `codex sandbox -- true` there to see it.

Adding the same machine again runs every check again and changes nothing that is already right.

### An API key in your shell

A handover checks each agent's login in the Svall daemon's systemd environment, with the fleet's `.env` keys
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) added as a character gets them, not in your shell. An agent's terminal starts
your shell, so an API key exported only in `~/.bashrc` or `~/.profile` works for the agent while the check says it is
not logged in. Put the key in the fleet's `.env`, which the checks read each time, or in
`~/.config/environment.d/agents.conf` as `NAME=value` lines and then run `systemctl --user daemon-reload` and
`systemctl --user restart svall-svalld@private`.

### The companion release

`svall host add` installs the companion matching the Mac's release exactly: a handover needs the same release on both
machines. It takes the one Svall.app carries, checks it against the digest the app's release pins, and checks its
signature against the keys the app's release lists. The `release` step says whether the companion is signed, and
`svall host doctor` says it of the machine's release and the Mac's.

- Svall.app carries a companion for x86-64 Linux only. For an arm64 machine, take the one of the same release from
  its GitHub release, the tag `v<version>` that `svall version` shows:

  ```sh
  curl -fLO https://github.com/linusroxbergh/svall/releases/download/v<version>/svall-companion-v<version>-linux-arm64.tar.gz
  svall host add studio --ssh ada@studio --release svall-companion-v<version>-linux-arm64.tar.gz
  ```

- A local `pnpm app:build` without `SVALL_RELEASE_KEY` is unsigned, and is named by `git describe`. Build its arm64
  companion from the same checkout under that name, and add `--allow-unsigned`:

  ```sh
  pnpm release:companion --out /tmp/companions --arch arm64 --version <name>
  svall host add studio --ssh ada@studio --release /tmp/companions/svall-companion-<name>-linux-arm64.tar.gz --allow-unsigned
  ```

- `--release <archive>` installs that archive instead. A signed one must be signed by a key the Mac's release lists;
  `--allow-unsigned` accepts one without a signature. See [the security notes](../security/fleet-handover.md) for how
  releases are checked.

## Making it the fleet's gateway

A fleet moves only to the machine that is its gateway. After adding the machine, choose **Make it this fleet's
gateway** in the same panel, or:

```sh
svall host enable studio --fleet private
```

It creates the gateway's ownership record for the fleet, naming this Mac as the owner, and gives the machine its own
copy of the fleet (`svall-svalld@<fleet>.service`, which starts read-only). The fleet stays on this Mac. Run it
once per fleet; `--fleet work` for a fleet named `work`. Then [hand the fleet over](handover.md).

## Looking after it

Settings → Machines lists every machine with its ssh destination, the fleets on this Mac it is the gateway of, and the
release and result of its last check, each with the buttons below.

| Command | In the app | What it does |
| --- | --- | --- |
| `svall host list` | Settings → Machines | Every machine in the registry, with its id, the fleets on this Mac it is the gateway of, and its last check. |
| `svall host doctor <name>` | Check | The machine's own checks, plus whether it runs this Mac's release, its free space and its home path; `host list` shows when it last ran and what it found. A check marked ✗ fails and makes it exit 1; one marked ! is a warning. It ends with ready and the number of warnings, or the checks that block a handover. A fresh Ubuntu 24.04 warns on `tmux` (it ships 3.4), `gh` and `path`, and where Codex is installed on `codex sandbox`; none of these stops a handover. |
| `svall host upgrade <name>` | Upgrade | Installs this Mac's release there, restarts the gateway and every fleet's daemon, and checks each answers from the new release. If one does not, it goes back to the release before. |
| `svall host upgrade <name> --rollback [release]` | Roll back, after an upgrade that failed | Puts the machine back on the release before, or on the kept release named, restarts its units, and checks each fleet's daemon answers from it. It refuses, changing nothing, while a fleet there keeps its state at a newer schema than that release reads. |
| `svall host remove <name>` | Remove | Runs `svall uninstall` there and drops the machine from the registry. It refuses while the machine is the gateway of a fleet this Mac does not own, while it owns a fleet through any gateway, and while a handover holds any fleet here open, whatever its gateway; bring each back with `svall handover local` first. The uninstall there passes only the gateway records of this Mac's fleets, so the machine still refuses for anything else, such as another Mac's fleet. Its fleets and their files stay on that machine. |
| `svall host remove <name> --forget` | Forget | Drops the machine from the registry without reaching it, when it is gone. |

After you update Svall on the Mac, run `svall host upgrade <name>`: until
both machines run the same release, a handover stops with `incompatible_release`. While the machine runs a fleet of
this Mac, the first update you ask for waits and says so: an update can leave that fleet out of the Mac's reach until
the machine runs the same release, and `host upgrade` installs only the Mac's own. Bring the fleet back with
`svall handover local` first, or ask again to update now and then upgrade the machine.

On the Linux machine itself:

- `svall setup --rollback [release]` puts the release before back, or the kept release named, restarts the units and
  checks each fleet's daemon answers from it. `svall setup` sets the machine up again from the release `current`
  names.
- `svall uninstall` refuses while the machine is a fleet's gateway, runs a fleet for its gateway, or holds a handover
  journal, since that would strand the fleet. `svall host remove` from the Mac checks the fleets that Mac knows of,
  then runs it with `--force-fleet` for each of them that names the machine as its gateway, so it still refuses for a
  fleet another Mac keeps there. To remove a machine two Macs use, bring the other Mac's fleet home and run
  `svall host remove <name> --forget` there, then `svall uninstall --force` here and
  `svall host remove <name> --forget` on the first Mac.
- Each fleet's own log is `svalld.log` in its fleet home (`~/.svall` for the private fleet), beside the units'
  logs in `~/.local/share/svall/log`.
- `systemctl --user status svall-gateway svall-svalld@private` shows the units.

## What is installed where

On the Linux machine, all under the account:

- `~/.local/share/svall/releases/<version>` and `current`, the release; `~/.local/bin/svall` points into it.
  Each install keeps the release before it, for a rollback, and removes older ones.
- `~/.config/systemd/user/svall-gateway.service`, and one `svall-svalld@<fleet>.service` per fleet. Each fleet's
  unit carries the `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `OPENCODE_DB` the
  account's login shell sets. Both units' `PATH` holds `~/.local/bin` and `~/.opencode/bin`, where OpenCode's
  installer puts it.
- `~/.config/opencode/plugins/svall.js` (under `XDG_CONFIG_HOME` when the login shell sets it), Svall's OpenCode
  plugin, when OpenCode is installed and the fleet does not turn it off.
- `~/.local/share/svall/gateway/fleets/<fleet id>.json`, the ownership record of each fleet it is the gateway
  for, and `gateway/recoveries.ndjson`, the audit of every forced recovery.
- `~/.local/share/svall/log`, the units' logs.
- `~/.svall` (and `~/.svall-<name>`), the machine's copy of each fleet.

On the Mac:

- `~/.config/svall/machine.json`, this Mac's machine id, `machines.json`, the registry, and `checks.json`, each
  machine's last check. A registry that
  cannot be read is moved aside to `machines.json.broken-<time>` with a warning, and a command that then misses a
  machine names that copy.
- In each fleet home: `fleet.json` names the gateway, `owner.json` holds this machine's copy of the ownership record,
  and `controller/` holds the journal of a handover this Mac is running.
