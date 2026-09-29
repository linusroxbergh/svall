# Release notes: remote machines

This release lets a fleet run on an always-on Linux machine as well as on your Mac, and move between the two. It is
off by default: each fleet turns it on with `"handover": { "enabled": true }` in its `fleet.json`, and a fleet that
does not works exactly as before.

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
  stashes, and each Claude Code and Codex conversation. Agents resume from their transcripts, shells reopen in their
  folders, and the app reconnects to the fleet where it now runs.
- **The checks come first.** Nothing moves until they pass, and each blocker says what to do: finish or interrupt a
  working agent, end a busy shell's command, archive a folder in the way. A folder changed on the other machine while
  it did not own the fleet is never overwritten.
- **A handover survives interruptions.** Closing the app, a dropped link or a killed process leaves it where it
  stopped, and the sheet or `svall handover status` says whether Resume or Abort is safe. Before the commit an abort
  gives the fleet back; after it, only the new machine goes on.
- **Keep a character on this machine** from its card, or `svall char update <id> --keep-here`, and a handover waits
  for it.
- **Disaster recovery**: `svall fleet recover --force-owner <machine>` writes a new ownership record when the gateway
  is lost for good, after showing everything each machine holds.

## Changed

- A fleet's settings are split into `fleet.json`, which travels with the fleet, and `node.json`, which stays with the
  machine. Your `config.json` is split on the daemon's first start and kept as `config.json.bak`.
- The fleet state moves to schema 8 and the protocol to 19; the old state is kept beside it.
- `pnpm desktop:install` installs a release under `~/.local/share/svall`, and `svall` and the daemons run from it
  instead of the clone, keeping the release before for `svall setup --rollback` and removing older ones.
- `svall setup` no longer replaces an edited mission control `.claude/settings.json`; `--replace-settings` does.
- `host`, `handover`, `gateway`, `fleet`, `connect`, `connection-info` and `version` are commands now, and no longer
  name a fleet; `svall setup` names each fleet made under one of them and the `mv` that renames it.
- `svall uninstall` refuses while it would strand a fleet: a handover open, a fleet this machine runs for its gateway,
  or fleets it is the gateway of. `--force` goes ahead anyway.

See [Upgrading and downgrading](migration.md) for the details and the way back.

## Requirements

- macOS 15 or newer, and Ubuntu LTS on x86-64 or arm64 with systemd user services and lingering.
- The Linux account's home must be the same path as yours on the Mac, such as `/Users/ada`.
- Tailscale and ssh between the two, and tmux, Git and rsync 3.2.3 or newer on the Linux machine.
- Claude Code 2.1.251 or newer and Codex 0.155.0 or newer, logged in on each machine. Logins never move.

## Not yet

- A signed, notarized download of the Mac app, and a release signing key: the app is built from source, and every
  companion it installs is unsigned, checked by the digest the app's own build pins.
- A stable phone URL that follows the fleet between machines, and forwarding a remote dev server's ports to the Mac.
- More than one Linux machine per fleet, moving a single character or island, and machines whose home paths differ.

Known limitations are listed in [Moving a fleet](handover.md#known-limitations).
