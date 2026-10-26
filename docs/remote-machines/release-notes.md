# Release notes: remote machines

This release lets a robot run on an always-on Linux machine as well as on your Mac, and move between the two. The
fleet stays on the Mac; the Linux machine is its worker.

## New

- **Add a Linux machine** from Settings → Machines, or with `svall host add <name> --ssh <destination>`. Svall
  checks the machine, installs its own companion there over ssh (with its own Node, no clone or build tools), makes it
  a worker of the fleet with a systemd user service, and ends with one line: ready, or what is left for you to do,
  such as logging the agents in. `svall host doctor`, `upgrade` and `remove` look after it, and
  `svall host upgrade <name> --rollback` puts it back on the release before.
- **Move a robot** there from its card, or with `svall robot move <id> --machine <name>`, and back with **Move to
  this Mac** or `--machine local`. It keeps its conversation, its branch, its commits and its uncommitted changes, and
  keeps working while the Mac sleeps. See [Moving a robot](placement.md).
- **A machine that was a fleet's gateway** becomes its worker with `svall host upgrade <name>`.

## Changed

- **The fleet handover** is left for a fleet that still names a gateway, until `svall host upgrade` makes that machine
  its worker; a later release removes it. `svall handover <name>` and `svall handover local` run it, and refuse while
  any robot runs on a worker or is moving to one. The Handover button, `svall host enable` and **keep on this
  machine** (`svall robot update --keep-here`) are gone: no machine becomes a gateway, and robots move one
  by one instead.
- The fleet state moves to schema 12, which drops each robot's keep-on-this-machine mark, and the protocol to 31; the
  old state is kept beside it.
- A Linux machine runs this Mac's release: after Svall updates, `svall host upgrade <name>` updates each machine.

See [Upgrading and downgrading](migration.md) for the details and the way back.

## Requirements

- macOS 15 or newer, and Ubuntu LTS 22.04 or newer on x86-64 or arm64 with systemd user services and lingering.
- A Linux account whose home path is at most 65 bytes; it need not be your Mac's.
- Tailscale and ssh between the two, and Git and rsync 3.2.3 or newer on the Linux machine, which runs the tmux
  Svall brings.
- Claude Code 2.1.251 or newer, Codex 0.156.0 or newer and OpenCode 2.0.22 or newer, logged in on each machine.
  Logins never move.

## Not yet

- A stable phone URL that follows the fleet between machines, and forwarding a remote dev server's ports to the Mac.
- Moving a whole island at once.

Known limitations are listed in [Moving a robot](placement.md#limitations) and [Moving a fleet](handover.md#known-limitations).
