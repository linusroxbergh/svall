# Upgrading and downgrading

What changes on your Mac and your Linux machines when you install this release over an older one, and how to go back.
On the Mac the upgrade happens by itself when Svall updates, or with `git pull && pnpm desktop:install` for Svall
Dev; a Linux machine takes it with `svall host upgrade`.

## Upgrading from 0.18 or 0.19

From 0.18, each fleet's daemon on the Mac migrates `state.json` from version 11 to 12 on its first start, which drops
each robot's keep-on-this-machine mark, and keeps the file as it was beside it as `state.json.v11-<time>`. A fleet on
0.19 is at version 12 already. The app, `svall` and the daemons of this release speak protocol 34; an update installs
all of them together.

Then run `svall host upgrade <machine>`, or **Upgrade to this Mac's release** in the machine's ⋯ menu under Settings →
Machines, for each Linux machine. It installs this Mac's release there, goes back to the release before if the fleet's
daemon there does not answer from it, and makes the machine the fleet's worker. A machine that was a fleet's gateway
becomes its worker the same way: `svall host upgrade <machine>` stops and removes `svall-gateway.service` there. Until a
machine runs this release, a move to it refuses: "studio runs X, this Mac Y; upgrade it under Machines".

The keys an older release wrote in `fleet.json` (`gatewayMachineId`, `handover`) and `machines.json` (`gateway`) are
read and ignored.

## Going back to 0.19 or 0.18

1. **Move every robot back to this Mac** with **Move to this Mac** or `svall robot move <id> --machine local`.
2. **Remove each Linux machine** with `svall host remove <machine>`. An older release cannot read the `machines.json`
   this release writes: its `svall` moves the file aside as `machines.json.broken-<time>` and starts a list of this Mac
   alone.
3. **Quit the app and stop each fleet's daemon**, as in [step 2 below](#going-back-to-014-or-earlier).
4. **Going back to 0.18, put the kept state back** in each fleet home: `cp "$(ls -t state.json.v11-* | head -1)"
   state.json`. The fleet comes back as it was when you upgraded; islands, robots and notes changed since are lost.
   Without it, 0.18's daemon does not start: "state.json is version 12, newer than this svalld reads (11): update
   svall", followed by the copy to move back. A fleet first made on 0.19 or later has no kept copy, and 0.18 cannot
   open it. 0.19 reads the state as it is.
5. **Install the older release**, then add each machine again with its `svall host add`.

## Upgrading from 0.14 or earlier

### `config.json` becomes `fleet.json` and `node.json`

The first time a fleet's daemon starts on the new release (or `svall setup` runs for the private fleet), it splits the
fleet's `config.json` in two:

1. `config.json` is renamed `config.json.bak`, byte for byte (a link stays a link), before anything is read out of
   it.
2. `node.json` gets what belongs to this machine: `port`, `host`, `shell`, `agentsOff` and
   `mobile.httpsPort`.
3. `fleet.json` gets every other key it knows and a new fleet `id`.
4. A key neither file knows stays only in `config.json.bak`.

The [README's configuration table](../../README.md#configuration) says which key lives in which file. From then on
`config.json` is not read. A dotfile manager such as stow or home-manager may link it back to the file
`config.json.bak` links to; that link is left alone, with a line in the daemon's log, so link `fleet.json` and
`node.json` from your dotfiles instead. Any other `config.json` beside `fleet.json`, such as the one an older
release's `svall setup` writes, is moved to `config.json.unread-<time>` unread when the daemon starts or `svall setup`
runs, and the daemon's log or setup's output names it; copy anything you still want from it into the new files.
`svall doctor` warns of one still there. A `config.json.bak` already in the way stops the split before anything is
written, until you keep one of the two; the daemon's log and `svall doctor` both say so.

### State schema 12 and protocol 34

- On its first start, the daemon migrates `state.json` to version 12, where a second terminal has a folder of its own.
  The file as it was stays beside it as `state.json.v8-<time>`, or `.v7-` from a release before OpenCode support.
- The app, `svall` and the daemons of one release speak protocol 34 to each other. An app or `svall` from an older
  release cannot reach a newer daemon; an update installs all of them together.
- `~/.config/svall/` gets `machine.json`, this Mac's id. One that does not parse stops the daemon while
  `machines.json` lists a worker, and the log says to restore it from backup, as each worker knows this Mac by that
  id; with no worker listed the daemon runs as a fresh id its log names. `svall host` says to delete the file to mint
  a new machine id, or restore it from backup.

### Named fleets

- Each fleet home is split and migrated by its own daemon, on its next start, and gets its own `fleet.json`,
  `node.json` and id.
- Remote machines are set up per fleet: `svall -p <name> host add <machine> --ssh <destination>` makes the machine
  that fleet's worker, and `svall -p <name> robot move …` moves its robots. On Linux each fleet runs as
  `svall-svalld@<name>.service`.
- A fleet cannot be named for a command `svall` keeps, such as `host`, `connection-info` or `version`, even with
  `-p`. `svall setup` names each fleet home made under one of them, such as `~/.svall-host`, and the `mv` to a name
  that reaches it again. A `config.json` whose `name` is one of them splits without it, so the fleet goes by its
  default name until you name it in Settings; `svall setup` lists each one.

## Going back to 0.14 or earlier

An older release refuses a fleet this release has migrated, and its install would put a fresh configuration in place
of yours. Going back therefore means putting back the copies the upgrade kept. Svall 0.14.0 is the last release
before remote machines (protocol 24, state schema 8). Its state checks are 0.9.0's, and its schema adds one optional
field to 0.9.0's.
What follows was checked by running Svall 0.5.1 (protocol 19) and Svall 0.3.2 (protocol 18, state schema 7) against a
fleet this release had migrated, in a temporary home:

- **The older daemon does not start.** Svall 0.5.1's log says `state.json is version 12, newer than this svalld reads
  (8): …; or, to go back to the fleet as this version last saw it, move ~/.svall/state.json.v8-<time> to
  ~/.svall/state.json; svalld starts once it is fixed`, the message 0.9.0 to 0.14.0 print too, and it waits without
  touching the state. A release before OpenCode support says `newer than this svalld reads (7)`, and names a
  `state.json.v7-<time>` copy only when there is one.
- **The older `svall setup`** finds no `config.json` and writes an empty one, so the fleet would start on the default
  port with default settings. Upgrading again over it moves that file aside unread and starts on `fleet.json` and
  `node.json`.

With the steps below, Svall 0.5.1 started the fleet as it was before the upgrade. 0.12.0 was not run this way; its state
and configuration code differs from 0.5.1's only by optional state fields.

1. **Move every robot back to this Mac** with `svall robot move <id> --machine local`.
2. **Quit the app and stop each fleet's daemon:**

   ```sh
   launchctl bootout gui/$(id -u)/io.github.linusroxbergh.svall.svalld
   launchctl bootout gui/$(id -u)/io.github.linusroxbergh.svall.svalld.<name>    # for each named fleet
   ```

3. **In each fleet home** (`~/.svall`, and `~/.svall-<name>` for each named fleet), set the new files aside
   and put the kept copies back:

   ```sh
   cd ~/.svall
   mkdir svall-aside && mv fleet.json node.json svall-aside/
   mv config.json.bak config.json
   cp "$(ls -t state.json.v[78]-* | head -1)" state.json
   ```

   That takes the newest kept copy. Going back to a release before OpenCode support (0.3.x or earlier) after
   upgrading through 0.5 or later, copy the newest `state.json.v7-*` instead.

   The fleet comes back as it was when you upgraded. Islands, robots and notes changed since are lost, and so is
   any setting changed since in `fleet.json` or `node.json`, unless you copy it into `config.json`. A fleet first made
   on this release has no kept copies, and the older build cannot open it; move its fleet home aside instead.

4. **Install the older Svall**, or for Svall Dev run `pnpm desktop:install` in a clone at that version.

`~/.config/svall` is not read by the older build.

A Linux machine you set up can stay as it is; the older build never contacts it. To remove it, run `svall host remove
<name>` before step 2.

### Upgrading again

Put back the files you set aside before you install the newer release, in each fleet home:

```sh
cd ~/.svall
mv config.json config.json.bak && mv svall-aside/* . && rmdir svall-aside
```

The fleet keeps its id, and the state is migrated again. A setting changed in `config.json` while on the older
release is not carried over; copy it into `fleet.json` or `node.json`. If you leave `config.json` instead, it is split
again into a fleet with a new id, which no worker knows: run `svall host upgrade <host>` for each machine, which makes
it the new fleet's worker.
