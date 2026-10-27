# Release notes: remote machines

This release lets a robot run on an always-on Linux machine as well as on your Mac, and move between the two. The
fleet stays on the Mac; the Linux machine is its worker.

## New

- **Add a Linux machine** from Settings → Machines, or with `svall host add <name> --ssh <destination>`. Svall
  checks the machine, installs its own companion there over ssh (with its own Node, no clone or build tools), makes it
  a worker of the fleet with a systemd user service, and ends with one line: ready, or what is left for you to do,
  such as logging the agents in. `svall host doctor`, `upgrade` and `remove` look after it, and
  `svall host upgrade <name> --rollback` puts it back on the release before.
- **Your agent setup on each machine.** Svall copies your Claude Code, Codex and OpenCode setup there, MCP servers and
  plugins included, and copies what changed before every move. A key travels only once you tick it for that machine,
  and a server that reads a variable asks you to set it there with `svall worker env`. See
  [Your agent setup on the machine](setup.md#your-agent-setup-on-the-machine).
- **Move a robot** there from its card, or with `svall robot move <id> --machine <name>`, and back with **Move to
  this Mac** or `--machine local`. It keeps its conversation, its branch, its commits and its uncommitted changes, and
  keeps working while the Mac sleeps. See [Moving a robot](placement.md).
- **While the Mac sleeps**, `svall` in a robot's terminal on a worker starts robots there, five at most until the Mac
  answers, and updates and closes them; the Mac takes in what they did once it is back. See
  [While this Mac sleeps](placement.md#while-this-mac-sleeps).
- **Robots on a worker** show their Files, Changes and Resources on the Mac, read-only; the phone reaches them through
  the Mac; the scribe and usage cover them; and a doc changed on both machines keeps the worker's version beside the
  Mac's as a conflict copy.

## Changed

- **The whole-fleet handover is gone**: robots move one by one, and a machine that was a fleet's gateway becomes its
  worker with `svall host upgrade <machine>`.
- Neither machine needs rsync.
- The app, `svall` and the daemons speak protocol 34, and the fleet state is at schema 12.
- A Linux machine runs this Mac's release: after Svall updates, `svall host upgrade <name>` updates each machine.

See [Upgrading and downgrading](migration.md) for the details and the way back.

## Requirements

- macOS 15 or newer, and Ubuntu LTS 22.04 or newer on x86-64 or arm64 with systemd user services and lingering.
- A Linux account whose home path is at most 89 bytes for the private fleet; it need not be your Mac's.
- Tailscale and ssh between the two, and Git on the Linux machine, which runs the tmux Svall brings.
- Claude Code 2.1.251 or newer, Codex 0.156.0 or newer and OpenCode 2.0.22 or newer, logged in on each machine.
  Logins never move.

## Not yet

- A stable phone URL that follows the fleet between machines, and forwarding a remote dev server's ports to the Mac.
- Moving a whole island at once.

Known limitations are listed in [Moving a robot](placement.md#limitations).
