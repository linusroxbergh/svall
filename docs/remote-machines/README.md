# Remote machines

Svall can move a robot from your Mac to an always-on Linux machine, a **worker** of your fleet, and back: its
Claude Code, Codex or OpenCode conversation, its branch, its commits and its uncommitted changes. On the worker the
robot keeps working while the Mac sleeps, and the app on the Mac reaches it over ssh. The fleet stays on the Mac;
robots on different machines share its islands, cards and map.

| Page | What it covers |
| --- | --- |
| [Setting up a Linux machine](setup.md) | Supported machines, home paths, adding the machine as a worker, your agent setup there, turning a gateway into a worker, upgrading and removing it |
| [Moving a robot](placement.md) | Moving a robot there and back, the checks, what travels and what stays, the return, what a robot does while this Mac sleeps, what goes wrong, and limitations |
| [Moving a fleet](handover.md) | The whole-fleet handover of a fleet that names a gateway, which a later release removes |
| [Blockers, warnings and errors](errors.md) | Every code a handover or `svall host` reports, what it means and what to do |
| [Upgrading and downgrading](migration.md) | What the upgrade changes in your fleet homes, and how to go back |
| [Release notes](release-notes.md) | What this release adds |

## In short

1. Reach an account on the Linux machine with `ssh`; its home need not be your Mac's ([home paths](setup.md#home-paths)).
2. Settings → Machines → **Add machine**, or from a terminal `svall host add studio --ssh ada@studio`. It ends with
   "studio is ready. Robots you move there keep working while this Mac sleeps.", or with what is left to do.
3. **Move to studio** on a robot's card moves it there, and **Move to this Mac** brings it back. Or
   `svall robot move <id> --machine studio` and `--machine local`.

## How it is distributed

Svall.app carries the x86-64 and arm64 Linux companions `svall host add` installs. Releases are signed, and every
install checks the signature; [the security notes](../security/fleet-handover.md) cover how.
