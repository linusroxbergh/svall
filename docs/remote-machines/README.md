# Remote machines

Svall can move a fleet from your Mac to an always-on Linux machine and back: its islands, characters, the
repositories and worktrees they work in, and each Claude Code, Codex or OpenCode conversation. On the Linux machine
the fleet keeps working while the Mac sleeps, and the app on the Mac reaches it over ssh. Only one of the two runs
the fleet at a time; the Linux machine, as the fleet's gateway, keeps the record of which.

The app shows it once you turn it on for a fleet, with `"handover": { "enabled": true }` in that fleet's `fleet.json`.
The `svall host`, `svall handover`, `svall gateway` and `svall fleet recover` commands work whether or not it is on.

| Page | What it covers |
| --- | --- |
| [Setting up a Linux machine](setup.md) | Supported machines, home paths, turning it on, adding the machine, making it the gateway, upgrading and removing it |
| [Moving a fleet](handover.md) | Handing over from the app or `svall handover`, what moves and what stays, agents and their versions, what restarts, recovery and known limitations |
| [Blockers, warnings and errors](errors.md) | Every code a handover or `svall host` reports, what it means and what to do |
| [Upgrading and downgrading](migration.md) | What the upgrade changes in your fleet homes, and how to go back |
| [Release notes](release-notes.md) | What this release adds |

## In short

1. On the Linux machine, make an account whose home is the same path as yours on the Mac, such as `/Users/ada`.
2. Turn on Settings → The fleet → **remote machines (experimental)**.
3. Settings → Machines → **Add machine**, then **Make it this fleet's gateway**. Or from a terminal:

   ```sh
   svall host add studio --ssh ada@studio
   svall host enable studio --fleet private
   ```

4. **Handover** at the foot of the sidebar moves the fleet there, and **This Mac** brings it back. Or
   `svall handover studio` and `svall handover local`.

## How it is distributed

Svall.app carries the x86-64 and arm64 Linux companions `svall host add` installs. Releases are signed, and every
install checks the signature; [the security notes](../security/fleet-handover.md) cover how.
