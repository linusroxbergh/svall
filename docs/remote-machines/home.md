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

**New robot** asks for a folder, since the window's own mean nothing on studio. It lists the folders on studio where its robots work, the
clones in its default folder, dot folders aside, and the fleet's default and mission control folders, and takes any path there; `~` is studio's. studio checks
a typed path before the robot starts: "/home/linus/x is not a folder on studio". A link to a folder counts, as it does for
`svall robot new --cwd`. The **+** beside an island starts in the folder of a robot working on studio there, and with none opens **New robot** for
that island. A Mac home has no such field: a new robot starts beside the robot or island you selected.

Settings → Machines lists the fleet's machines, the home first, each with its role and its robots. A worker that dials in is listed
too, as "dials in". With the home on this Mac, each machine's ⋯ holds what it does for you, and Add machine adds another. A
window on a far home has ⋯ on the home's row alone, and no Add machine: its workers are that home's to add and remove.

## What opens on this Mac

A robot on this Mac keeps everything: Finder, a file in its own app, a folder in its context. For a robot on any other machine, and for a
file of studio's on the Resources shelf, Finder cannot reach the path, and a path of the same name on this Mac would be another file. So:

- **Finder**, **Show in Finder**, and opening a picture or PDF from a terminal are not offered. The card, the pane and the shelf say
  "on studio", and **Terminal there** opens a terminal on that machine with a `cd` to the folder typed at the prompt. A file or folder in the
  robot's context does the same when you click it. A machine this Mac has no ssh to, such as another Mac, offers no terminal and says so.
- **A dev server** the robot runs stays on its machine, as its card says. Forward the port by hand to open it in the app's browser.
- **Fleet config** in Settings opens studio's `fleet.json` in the shelf's editor, written on studio, through a link if the file is one. A file
  its daemon could not start on is refused, saying what in it is wrong, and so is another `id`, which would leave this window taking studio for
  a stranger. A save says that most of it takes effect when studio's daemon next starts. While studio does not answer the button is off, as
  this Mac's own `fleet.json` is not the fleet's.

The app's shell holds to this too: it opens such a path only for this machine, whatever the page asks.

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

The window goes on, on this Mac's own copy of the fleet, with a banner: **studio is not reachable** and the time of the copy it
shows; the cause is in svalld's log.

- Robots on this Mac are live, with their terminals.
- A robot on studio shows unknown, with the last screen studio sent. A robot on any other machine shows unknown.
- A change to a robot on this Mac, or a new island, is kept here and reaches studio once it answers, as in
  [While the home is away](placement.md#while-the-home-is-away). A change to a robot elsewhere is refused in words.
- A new robot starts on this Mac, inside a clone it has, with the note "started on ada-mac while studio was away", at most five
  until studio answers again. **New robot** lists this Mac's clones and says they are this Mac's.
- Moves, phone settings and what a machine's setup offers are hidden: only the home answers them.

When studio answers, the window goes back to it and reopens its terminals without a reload, and what you did here lands there once.
Each change is applied by the rules in [Moving a robot](placement.md#while-the-home-is-away). A server whose daemon restarts or dies does
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

- **studio runs an older Svall than this Mac (0.21, here 0.22); upgrade it to reach its robots**, with **Upgrade studio**. It installs this Mac's release there and restarts the fleet's daemon as the
  home, whichever name the fleet has here, and enrols nothing; robots on studio keep running through it, and the window reconnects by itself. The app never upgrades the server without
  you asking. While the two differ, the window works on this Mac's copy, and this Mac's link to studio holds off as any worker's does.
- **studio runs a newer Svall than this Mac (0.23, here 0.22); update Svall on this Mac**: nothing passes until then.

## Your agent setup

Your agent setup lives where the fleet lives. studio is the source, and every worker takes it from there, this Mac included: each time
studio links to this Mac and before every move here, only what changed on studio since the last time.

- **Your own files.** Each file a push is the first to take, the first push's and any later one's, is copied first under `~/.svall/mirror-backup/<date>/` (`~/.svall-<fleet>/` for a named fleet), laid out as under your home, for you alone, even where it held the same bytes. Settings → Agent setup names the folder. A file the mirror wrote keeps no copy, whatever you edit in it since, but where a tick goes over a key of your own in it.
- **What it leaves.** A push removes a file only once it has taken it, so one you held yourself lies in that folder first. The unit this Mac keeps is the whole entry: a server in a config file, a provider table, a config key's value or list. An entry holding a key of your own, in a field Svall reads as a key, stays whole while studio's is unticked, so what studio changes in it does not land, and it stays when studio drops it. In a table of entries, such as providers, where every child on both sides is a table, an entry only this Mac holds and the mirror did not write stays, with or without a key, and studio's are laid over it, each whole; one the mirror wrote and studio drops goes. Any other table is one value, and studio's replaces it. A tick on studio's side replaces the entry whole, the file copied to the folder first; an untick leaves studio's form, which is the reference for a server's key and empty elsewhere, with your key in the folder and the Agent setup pane naming it. A plugin's `.mcp.json` goes by the file: a key of yours in it lies only in the folder, from when the file was first taken, and one you fill in since is in no copy. A server the mirror copied whole and you edited in any way is yours: an untick or studio dropping it leaves it as you edited it, with any key the mirror copied in it, its row says so while studio lists it, and you remove it yourself; a later tick replaces it, the file copied first without the mirror's strings. A linked keyed file whose target you edited is yours too, ticked or not: nothing writes through the link, and its row says so, until you remove the link; the next tick then writes a plain file, and the target stays, with any key the mirror copied in it. A linked folder, such as `~/.claude/agents` under a dotfiles manager, doesn't count: the files in it read as plain ones, so an edit goes at studio's next change or an untick, in no copy. A server you, or an agent, edit so Svall cannot read it field by field stays yours too: while unticked it stops following studio, its row says so, and deleting it brings studio's back at the next push. An override under `mirror-overrides/` reads as such an edit, and stands only over a server this Mac still holds, unless it names a `command` or `url` of its own. An edit Svall can read leaves a server studio's: studio's next change to it replaces it, with no copy. A plugin or marketplace studio does not list stays in `installed_plugins.json`, `known_marketplaces.json` and `enabledPlugins`, as does a setting only this Mac has. A setting both hold is studio's, `permissions` among them; the folder keeps what you had when the file was first taken. `mirror-overrides/` in the fleet's home here stands over what comes, as on [any worker](setup.md#your-agent-setup-on-the-machine).
- **Editing it.** Settings → Agent setup opens studio's `CLAUDE.md`, `settings.json`, skills and rules in the app's editor, and saves them on studio. It offers this while the window reaches studio. A Mac that is its fleet's home has no such pane.
- **A home with no setup yet.** A server you made home from this Mac, or joined, has none of its own past what `svall setup` writes there. It pushes nothing onto this Mac until it does. Your window offers this Mac's first, through the copy below, with the same boxes for its keys, and `svall fleet join` asks at a terminal; **Not now** leaves studio empty, and the pane still copies it later. A home that holds a `CLAUDE.md`, a rule, a server, a setting or anything else of a person's is never offered this.
- **Copy my agent setup from this Mac to studio.** The same pane sends what is on this Mac now, once. Keys in config files stay on this Mac unless you tick them there, field by field; the ticks are this Mac's, and studio has no say in them. `CLAUDE.md`, rules, skills and agent profiles go as they are, anything written in them included. A key you untick stays on studio until the next copy. By the same rule as a push, studio keeps each file a copy is the first to take in its own `mirror-backup/<date>/`, and the copy's result names that folder when that copy kept any, each entry a tick went over, and what an untick left. The Agent setup pane forgets that line when you leave it.

A copy removes nothing on studio but a whole item or file you unticked, while it is still the copy, a key you unticked from a row it still lists, and Svall's rollback copies holding a key you unticked or changed. In a table, a part only studio holds stays, so a provider or a key only it has stays; a part both hold is this Mac's, whole, a list included. A whole item you edited on studio since stays as you edited it, with any key the mirror copied in it, until you remove it there, and the copy's result names it. It carries what changed on this Mac since the last one, so a file you edited on studio since stays unless this Mac's changed too.
The first copy has no last one: it replaces studio's same-named files, your edits there included, and those lie in studio's backup folder. It
sends this Mac's files as they are now: what a push replaced on this Mac lies in the backup folder here, so put back what you want from there first.

An untick, or a ticked key that changes, also removes Svall's own rollback copies beside a config file (`.claude.json.bak-<ts>`, `settings.json.bak-<ts>`) that hold the key, whole, as nothing else tells what was yours in one. `mirror-backup` is never touched.

Two Macs copying to one studio work against one history: a second Mac's first copy skips what the first sent and replaces edits made on studio since, in no backup. `svall uninstall` leaves your agent folders with the home's files in them, the keys the mirror copied, Svall's hooks and the rollback copies holding such a key taken out, but for a whole copy you edited or a key you moved, which it leaves and says so, and names `mirror-backup`, which it keeps unless you say yes. `--purge` deletes it with the fleet.

studio has no source setting, and nothing syncs by two hops. A Linux worker of studio takes studio's files as they stand, a copy from
this Mac included, overrides merged, at its next link or move.

## This Mac asleep

After 45 seconds studio marks this Mac unreachable, and its robots show unknown on the phone with their last screens. Robots on studio go on.
On wake this Mac dials again, its changes land, and the window reconnects. A reboot, or Quit, leaves it out of reach until the app opens.

## Quit

Quit stops this Mac's daemon and its tmux, as on any Mac: the robots here sleep and resume when you open Svall again. The question says so,
and that "studio's 7 robots keep running". Nothing on studio is touched.

## Starting on a server

The first run offers three things. **Run the fleet on this Mac** is what it always was. **Install Svall on a server and connect
this Mac** installs the companion as `svall host add` does and leaves the server a fleet's home, then joins it. **Connect to a
fleet already on a server** joins one a server already runs. Both server paths need Tailscale on both machines, and both join
before this Mac's fleet has ever started, so nothing here holds anything to lose. A server with no agent setup yet is offered
this Mac's as soon as the window reaches it ([your agent setup](#your-agent-setup)).

From a terminal, `svall fleet join <ssh>` makes a fleet that holds nothing a worker of the home there: it checks the home,
takes that fleet's id and a token the home issues, restarts as its worker and ends on the first snapshot. It refuses a fleet
that holds anything before it writes a thing, so name one that has never been opened: `svall -p <new fleet> fleet join <ssh>`. The
fleet keeps the name it has on each machine, and the home follows it there however the two are named (`--home-profile` names
the fleet on the home when it is not the private one).

## Changing home

Settings → Machines moves a fleet's home to a worker with **Make studio this fleet's home…**, and back with **Bring the fleet
back to this Mac…**. From a terminal: `svall fleet home` says where it runs, `svall fleet home set studio` moves it there and
`svall fleet home set local` brings it back.

A move carries the fleet's islands, notes, settings, phone pairing and push keys, and no robot: each runs where it ran and its
tmux is never touched. Mission control's robots run on the home, so they move first, each with a robot's own move. The check
names one at work before anything moves, with **Interrupt it now** ticked, as a robot's move sheet does: what it runs is
interrupted at once as it moves. Untick it and the move does not start while that robot is at work. From a terminal,
`svall fleet home set` refuses one at work unless `--interrupt-after` says when to interrupt it, 0 at once. The move pauses the home, copies the fleet, has the other machine take over, has the old home join it as a worker, and reconnects the
window. While the home is paused no write is taken, on the phone either, and robots go on working. Afterwards open the phone
once from its new QR code: it stays paired and pushes keep arriving. The new home turns its phone link on within seconds of
taking the fleet, if the old one served; if Tailscale refuses it there, the move stands, and Settings → Phone says why.

A move refuses until it can go through: the other machine linked, on the same release, with Tailscale, its clock within 5
minutes and room for the fleet; no robot moving, and no other worker, which you remove and add again from the new home.

### When a move stops

The fleet never has two homes, and nothing is deleted. The machine the fleet leaves writes a marker before anything can take
the fleet, and from then on it starts as a home only once the other machine has said for good that it did not take it. Whichever
machine stops, however it stops, what is left is one of these:

- **Nothing was marked.** The old home goes on as it was, and a later move gives up what was copied.
- **Marked, and not taken.** The window says "The fleet is moving to studio, and this Mac takes no changes until the move
  ends", where studio says the move stands, with **Finish the move** and **Abort** (`svall fleet home retry`, `svall fleet
  home abort`). The old home takes no writes until one of them ends it. An abort works
  only once the machine that would take the fleet refuses it for good, and that machine then refuses the move for good too.
- **Taken.** The new home runs the fleet, and the old home joins it as soon as it hears, however late, so an abort answers
  that the move went through. A new home whose daemon has started answers so too, as it may already have taken a write. The other machine's files stand as they were kept: see below.

A move that stops leaves mission control's robots that went ahead where they went: a banner names them, with **Bring them back**
(`svall fleet home crew-back`), and says which cannot return and why. A robot you placed on mission control yourself is no such
robot, and stays where it runs.

Going out, the Mac asks the server how the move ended, and believes only the machine and the fleet it marked for: a folder
renamed there, or an ssh name that now leads elsewhere, reads as no answer. Coming back, the server has no route to the Mac, so a
server left frozen waits for the Mac to tell it, and the Mac keeps trying. If that Mac is gone for good, nothing on the server ends
the wait. A Mac whose server was wiped or reinstalled waits the same way, as what answers there is no longer the machine it marked for: see Limitations.

Quit during a move ends the window. A Mac frozen for a move out keeps its daemon up, as the move has to end; a Mac the fleet is
coming back to stops as a worker does, and the old home waits until Svall opens again. A quit while the window drives a move it
has not marked yet calls the move off, and the dialog says so. A move is not a backup, and keeps what it replaced:
the old home's `state.json.home-<id>` and `docs.home-<id>` stay in its fleet home, and `adopt-<id>` holds what was staged until
the old home links to the new one. Files refuses every `adopt-<id>` folder and `workers.json.home-<id>`, as they hold the fleet's keys.
A link inside `docs/` is not carried, and neither is a name a tar cannot hold, which refuses the move and names the file. A note
written after the copy goes to the new home, and one the new home changed too is kept beside it as a conflict copy.

## Limitations

- A move refuses with a second worker of either kind, and Linux workers of a server home come later.
- A marked server whose Mac never comes back stays frozen.
- A marked Mac whose server was wiped or reinstalled stays frozen. If that server is gone for good, stop the Mac's daemon and remove `home-moving.json` from its fleet home by hand, and it starts as the home. Do this only then: while the server holds the fleet, it makes two homes.
- Svall Dev carries no companion, so **Upgrade** there needs one named by hand: `svall-dev host upgrade studio --release <archive> --allow-unsigned`.
- The retro reads the home's agent stores, so a robot on this Mac is not in it.
- A dev server on a far robot is not forwarded to this Mac.
- A Mac whose home dials it over Remote Login, set up with the CLI, has no route to the home's API. Its window lists this Mac's folders, its
  shelf shows this Mac's files with Finder, and **New robot** starts on this Mac. Fleet config is off, its tip naming the home, and the Phone tab
  is hidden.
