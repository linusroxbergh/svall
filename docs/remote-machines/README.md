# Remote machines

Svall can move a fleet from your Mac to an always-on Linux machine and back: its islands, characters, the
repositories and worktrees they work in, and each Claude Code or Codex conversation. On the Linux machine the fleet
keeps working while the Mac sleeps, and the app on the Mac reaches it over ssh. Only one of the two runs the fleet at
a time; the Linux machine, as the fleet's gateway, keeps the record of which.

It is off until you turn it on for a fleet, with `"handover": { "enabled": true }` in that fleet's `fleet.json`.

| Page | What it covers |
| --- | --- |
| [Setting up a Linux machine](setup.md) | Supported machines, the same home path, turning it on, adding the machine, making it the gateway, upgrading and removing it |
| [Moving a fleet](handover.md) | Handing over from the app or `svall handover`, what moves and what stays, agents and their versions, what restarts, recovery and known limitations |
| [Blockers, warnings and errors](errors.md) | Every code a handover or `svall host` reports, what it means and what to do |
| [Upgrading and downgrading](migration.md) | What the upgrade changes in your fleet homes, and how to go back |
| [Release notes](release-notes.md) | What this release adds |

## In short

1. On the Linux machine, make an account whose home is the same path as yours on the Mac, such as `/Users/ada`.
2. Turn handover on in the fleet's `fleet.json` and reopen the app.
3. Settings → Machines → **Set up**: add the machine, then **Make it this fleet's gateway**. Or from a terminal:

   ```sh
   svall host add studio --ssh ada@studio
   svall host enable studio --fleet private
   ```

4. **Handover** at the foot of the sidebar moves the fleet there, and **This Mac** brings it back. Or
   `svall handover studio` and `svall handover local`.

## How it is distributed

Svall.app carries the x86-64 Linux companion `svall host add` installs ([arm64](setup.md#the-companion-release) takes
one more command). There is no release signing key yet, so every companion installed today is unsigned;
[the security notes](../security/fleet-handover.md) cover how releases are checked.
