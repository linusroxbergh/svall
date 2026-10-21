# Release notes: remote machines

This release lets a fleet run on an always-on Linux machine as well as on your Mac, and move between the two. The
app's controls for it are off by default: each fleet turns them on with `"handover": { "enabled": true }` in its
`fleet.json`. The `svall host`, `svall handover`, `svall gateway` and `svall fleet recover` commands work whether or
not `handover.enabled` is on.

## New

- **Add a Linux machine** from Settings → Machines, or with `svall host add <name> --ssh <destination>`. Svall
  checks the machine, installs its own companion there over ssh (with its own Node, no clone or build tools), sets up
  systemd user services and lists anything left for you to do, such as logging the agents in. `svall host doctor`,
  `upgrade` and `remove` look after it, and `svall host upgrade <name> --rollback` puts it back on the release
  before.
- **Make it a fleet's gateway** with `svall host enable <name> --fleet <fleet>`. The gateway keeps the record of which
  machine owns the fleet, so only one ever runs it.
- **Hand the fleet over** with the Handover button or `svall handover <name>`, and back with **This Mac** or
  `svall handover local`. Characters, islands, notes, browser tab URLs, entity docs and agent profiles move; so do the
  repositories the characters work in, with their worktrees, staged and unstaged changes, untracked files and
  stashes, and each Claude Code, Codex and OpenCode conversation. Agents resume from their transcripts, shells reopen
  in their folders, and the app reconnects to the fleet where it now runs.
- **The checks come first.** Nothing moves until they pass, and each blocker says what to do: finish or interrupt a
  working agent, end a busy shell's command, archive a folder in the way, carry a terminal's folder whole when it
  holds repositories no character works in. A folder changed on the other machine while it did not own the fleet stops
  the handover before the copy starts; one changed there while the copy runs is overwritten.
- **A handover survives interruptions.** It carries on while the app is closed, with this Mac's daemon and terminals
  left running for it. A dropped link or a killed process leaves it where it stopped, and the sheet or
  `svall handover status` says whether Resume or Abort is safe. Before the commit an abort gives the fleet back; after
  it, only the new machine goes on.
- **Keep a character on this machine** from its card, or `svall char update <id> --keep-here`, and a handover waits
  for it.
- **Disaster recovery**: `svall fleet recover --force-owner <machine>` writes a new ownership record when the gateway
  is lost for good, after showing everything each machine holds.

## Changed

- A fleet's settings are split into `fleet.json`, which travels with the fleet, and `node.json`, which stays with the
  machine. Your `config.json` is split on the daemon's first start and kept as `config.json.bak`.
- The fleet state moves to schema 9 and the protocol to 23; the old state is kept beside it.
- `host`, `handover`, `gateway`, `fleet`, `connect`, `connection-info` and `version` are commands now, and no longer
  name a fleet; `svall setup` names each fleet made under one of them and the `mv` that renames it.
- `svall uninstall` refuses while it would strand a fleet: a handover open, a fleet this machine runs for its gateway,
  or fleets it is the gateway of. `--force` goes ahead anyway.
- A second terminal running Claude Code, Codex or OpenCode stays when Svall quits, the robot is put to sleep, or its window closes, and opening
  Terminal 2 resumes that session; nothing reopens it by itself. Quit the agent and exit the shell to remove it.
- The daemon keeps this Mac's id in `~/.config/svall/machine.json`. A fleet with no gateway starts even when that file
  cannot be written or read.
- The window of a fleet with a gateway runs a small `svall connect` helper that reaches the fleet wherever it runs; a
  fleet with no gateway opens on this Mac without one.
- The app download is about 100 MB: it carries the Linux companion `svall host add` installs.

See [Upgrading and downgrading](migration.md) for the details and the way back.

## Requirements

- macOS 15 or newer, and Ubuntu LTS on x86-64 or arm64 with systemd user services and lingering.
- The Linux account's home must be the same path as yours on the Mac, such as `/Users/ada`.
- Tailscale and ssh between the two, and tmux, Git and rsync 3.2.3 or newer on the Linux machine.
- Claude Code 2.1.251 or newer, Codex 0.156.0 or newer and OpenCode 2.0.22 or newer, logged in on each machine.
  Logins never move.

## Not yet

- A release signing key: every companion the app installs is unsigned, checked by the digest the app's own release
  pins.
- A stable phone URL that follows the fleet between machines, and forwarding a remote dev server's ports to the Mac.
- More than one Linux machine per fleet, moving a single character or island, and machines whose home paths differ.

Known limitations are listed in [Moving a fleet](handover.md#known-limitations).
