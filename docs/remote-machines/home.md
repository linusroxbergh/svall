# A fleet whose home is a server

A fleet has one home, which runs its islands, map, notes, mission control, scribe, phone link and pushes. That home can be
an always-on Linux machine, with a Mac as its [worker that dials in](setup.md#a-worker-that-dials-its-home). The app on that Mac
then opens on the fleet as the server holds it, and robots keep working with the lid closed. This page uses `studio` for the server.

On this page "this Mac" is the machine the window runs on, and every other machine goes by name, the home included. A Mac
with no server reads as it always has.

## What the window shows

The window works through the home while it answers. Everything you do in it, a note, a new island, a new robot, goes
to studio, and a new robot starts there; **Move to this Mac** brings it here. Robots run where they run: a robot on this Mac
stays in this Mac's tmux, its Files edit in place as ever, and its card reads as here. **Move to studio** sends it back.
Mission control runs on the home and has no move button.

Settings → Machines lists the fleet's machines, the home first, each with its role and its robots. A worker that dials in is listed
too, as "dials in". What a machine does for you from there, and adding another, is for a home on this Mac.

## Terminals

Each terminal is an ssh of its own, except a robot's on this Mac, which is this Mac's tmux.

| The robot runs on | Its terminal |
| --- | --- |
| this Mac | this Mac's tmux |
| studio | an ssh over this Mac's daemon's ssh connection to studio |
| a Linux worker of studio | an ssh to studio, then an ssh from there over studio's connection to the worker |
| another Mac | none: "kanban runs on ada-laptop; open it there". Its status, notes and files show, and **Move to studio** sends it to the home, from where a second move brings it here |

sshd allows ten sessions per connection by default. A terminal past that opens a login of its own, without a prompt, on each hop.
No terminal starts while the first connection is down; it opens once the connection is back.

## When studio does not answer

The window goes on, on this Mac's own copy of the fleet, with a banner: **studio is not reachable**, the reason, and the time of the
copy it shows.

- Robots on this Mac are live, with their terminals.
- A robot on studio shows unknown, with the last screen studio sent. A robot on any other machine shows unknown.
- A change to a robot on this Mac, or a new island, is kept here and reaches studio once it answers, as in
  [While this Mac sleeps](placement.md#while-this-mac-sleeps). A change to a robot elsewhere is refused in words.
- A new robot starts on this Mac, inside a clone it has, with the note "started on ada-mac while studio was away", at most five
  until studio answers again.
- Moves, phone settings and what a machine's setup offers are hidden: only the home answers them.

When studio answers, the window goes back to it and reopens its terminals without a reload, and what you did here lands there once.
Each change is applied by the rules in [Moving a robot](placement.md#while-this-mac-sleeps). A server whose daemon restarts or dies does
the same within 15 seconds of answering, on the new port if it moved. Its robots never notice: they run in its tmux.

## What a person has to fix

These wait for you, since nothing changes by asking again. **Try again** in the banner asks once more; so does opening the app, and
starting its daemon. A wake does not.

- **this Mac cannot log in to studio**, a key or a host key: run `ssh <destination>` once in a terminal. The dial stops trying meanwhile, as
  a login refused every minute can get an account banned, and says so once in the log. Only ssh's own refusal reads as this: a network that
  comes and goes is tried again.
- **The server answers as another fleet or another machine**, such as an ssh alias that now leads elsewhere. The banner names both, and
  the window goes to no other home.

## Another release on studio

The app and the server speak one protocol, with no window between releases.

- **studio runs 0.21, this Mac 0.22**, with **Upgrade studio**. It installs this Mac's release there and restarts the fleet's daemon as the
  home; robots on studio keep running through it, and the window reconnects by itself. The app never upgrades the server without
  you asking. While the two differ, the window works on this Mac's copy, and this Mac's link to studio holds off as any worker's does.
- **studio runs 0.23, this Mac 0.22; update Svall on this Mac**: nothing passes until then.

## This Mac asleep

After 45 seconds studio marks this Mac unreachable, and its robots show unknown on the phone with their last screens. Robots on studio go on.
On wake this Mac dials again, its changes land, and the window reconnects. A reboot, or Quit, leaves it out of reach until the app opens.

## Quit

Quit stops this Mac's daemon and its tmux, as on any Mac: the robots here sleep and resume when you open Svall again. The question says so,
and that "studio's 7 robots keep running". Nothing on studio is touched.

## Limitations

- Svall Dev carries no companion, so **Upgrade** there needs one named by hand: `svall-dev host upgrade studio --release <archive> --allow-unsigned`.
- The retro reads the home's agent stores, so a robot on this Mac is not in it.
- A dev server on a far robot is not forwarded to this Mac.
