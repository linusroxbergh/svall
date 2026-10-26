# Upgrading and downgrading

What changes on your Mac and your Linux machines when you install this release over an older one, and how to go back.
On the Mac the upgrade happens by itself when Svall updates, or with `git pull && pnpm desktop:install` for Svall
Dev; a Linux machine takes it with `svall host upgrade`.

## Upgrading from 0.18

On its first start, each fleet's daemon on the Mac migrates `state.json` from version 11 to 12, which drops each
robot's keep-on-this-machine mark, and keeps the file as it was beside it as `state.json.v11-<time>`. The app,
`svall` and the daemons of this release speak protocol 32; an update installs all of them together.

Then run `svall host upgrade <machine>`, or **Upgrade** under Settings → Machines, for each Linux machine 0.18 set up.
It installs this Mac's release there, and goes back to the release before if the fleet's daemon there does not answer
from it. A machine that was a fleet's gateway then becomes its worker: `fleet.json` names no gateway,
`svall-gateway.service` is stopped and removed there unless another fleet keeps it, and each folder an earlier
handover copied there is named with its size and left in place ([A machine that was a fleet's
gateway](setup.md#a-machine-that-was-a-fleets-gateway)). A machine 0.18 added without making it a gateway becomes the
fleet's worker the same way. Until then no robot of a fleet that names a gateway moves: "this fleet has a gateway;
svall host upgrade studio makes it this fleet's worker".

The upgrade refuses while the fleet runs on the machine, as after a handover to it: "this fleet runs on studio,
where a handover moved it; bring it back to this Mac with svall handover local, then upgrade studio again". So
every robot is on this Mac when the machine becomes a worker, and stays there until you move it.

## Going back to 0.18

1. **Move every robot back to this Mac** with **Move to this Mac** or `svall robot move <id> --machine local`.
   0.18 has no workers.
2. **Quit the app and stop each fleet's daemon**, as in [step 2 below](#going-back-to-014-or-earlier).
3. **In each fleet home, put the kept state back:** `cp "$(ls -t state.json.v11-* | head -1)" state.json`. The fleet
   comes back as it was when you upgraded; islands, robots and notes changed since are lost. Without it, 0.18's
   daemon does not start: "state.json is version 12, newer than this svalld reads (11): update svall", followed by
   the copy to move back. A fleet first made on this release has no kept copy, and 0.18 cannot open it.
4. **Install 0.18.**

After `svall host upgrade` a fleet has no gateway: the upgrade removed it from `fleet.json` and removed
`svall-gateway.service` from the machine, and kept neither. 0.18 runs that fleet on this Mac and never contacts the
machine. To hand the fleet over to it again, set the machine up as 0.18 does: before step 2, run `svall uninstall
--force` on the machine over ssh (it takes the fleet's home there with it, `~/.svall`, or `~/.svall-<fleet>` for a
named fleet) and `svall host remove <machine> --forget` on this Mac; after step 4 run 0.18's `svall host add` and
`svall host enable <machine> --fleet <fleet>`. Or put back backups of the machine's account and of `fleet.json` from
before the upgrade.

## Upgrading from 0.14 or earlier

### `config.json` becomes `fleet.json` and `node.json`

The first time a fleet's daemon starts on the new release (or `svall setup` runs for the private fleet), it splits the
fleet's `config.json` in two:

1. `config.json` is renamed `config.json.bak`, byte for byte (a link stays a link), before anything is read out of
   it.
2. `node.json` gets what belongs to this machine: `port`, `host`, `shell`, `agentsOff` and
   `mobile.httpsPort`.
3. `fleet.json` gets every other key it knows and a new fleet `id`. It has no `handover` block, which moving robots to
   a worker does not need ([Moving a robot](placement.md)).
4. A key neither file knows stays only in `config.json.bak`.

The [README's configuration table](../../README.md#configuration) says which key lives in which file. From then on
`config.json` is not read. A dotfile manager such as stow or home-manager may link it back to the file
`config.json.bak` links to; that link is left alone, with a line in the daemon's log, so link `fleet.json` and
`node.json` from your dotfiles instead. Any other `config.json` beside `fleet.json`, such as the one an older
release's `svall setup` writes, is moved to `config.json.unread-<time>` unread when the daemon starts or `svall setup`
runs, and the daemon's log or setup's output names it; copy anything you still want from it into the new files.
`svall doctor` warns of one still there. A `config.json.bak` already in the way stops the split before anything is
written, until you keep one of the two; the daemon's log and `svall doctor` both say so.

### State schema 12 and protocol 32

- On its first start, the daemon migrates `state.json` to version 12, where a second terminal has a folder of its own.
  The file as it was stays beside it as `state.json.v8-<time>`, or `.v7-` from a release before OpenCode support.
- The app, `svall` and the daemons of one release speak protocol 32 to each other. An app or `svall` from an older
  release cannot reach a newer daemon; an update installs all of them together.
- Each daemon writes `owner.json` in its fleet home, which says this Mac owns the fleet, and `~/.config/svall/`
  gets `machine.json`, this Mac's id. A fleet with no gateway starts even where `~/.config/svall` cannot be written
  or holds a broken `machine.json`: its daemon runs as the machine its `owner.json` names, and its log says what to
  fix. A fleet with a gateway does not: its daemon exits at each start, with the fix in its log, until it can use
  `~/.config/svall` again.

### Named fleets

- Each fleet home is split and migrated by its own daemon, on its next start, and gets its own `fleet.json`,
  `node.json`, id and `owner.json`.
- Remote machines are set up per fleet: `svall -p <name> host add <host>` makes the machine that fleet's worker, and
  `svall -p <name> robot move …` moves its robots. On Linux each fleet runs as `svall-svalld@<name>.service`.
- `host`, `handover`, `gateway`, `fleet`, `connect`, `connection-info` and `version` are now commands, and no longer
  name a fleet, even with `-p`. `svall setup` names each fleet home made under one of them, such as
  `~/.svall-host`, and the `mv` to a name that reaches it again. A `config.json` whose `name` is one of them splits
  without it, so the fleet goes by its default name until you name it in Settings; `svall setup` lists each one.

## Going back to 0.14 or earlier

An older release refuses a fleet this release has migrated, and its install would put a fresh configuration in place
of yours. Going back therefore means putting back the copies the upgrade kept. Svall 0.14.0 is the last release
before remote machines (protocol 24, state schema 8). Its state checks are 0.9.0's, and its schema adds one optional
field to 0.9.0's.
What follows was checked by running Svall 0.5.1 (protocol 19) and Svall 0.3.2 (protocol 18, state schema 7) against a
fleet this release had migrated, in a temporary home:

- **The older daemon does not start.** Svall 0.5.1's log says `state.json is version 9, newer than this svalld reads
  (8): …; or, to go back to the fleet as this version last saw it, move ~/.svall/state.json.v8-<time> to
  ~/.svall/state.json; svalld starts once it is fixed`, the message 0.9.0 to 0.14.0 print too, and it waits without
  touching the state. A release before OpenCode support says `newer than this svalld reads (7)`, and names a
  `state.json.v7-<time>` copy only when there is one.
- **The older `svall setup`** finds no `config.json` and writes an empty one, so the fleet would start on the default
  port with default settings. Upgrading again over it moves that file aside unread and starts on `fleet.json` and
  `node.json`.

With the steps below, Svall 0.5.1 started the fleet as it was before the upgrade. 0.12.0 was not run this way; its state
and configuration code differs from 0.5.1's only by optional state fields.

1. **Bring every fleet home.** Every robot on a worker moves back first (`svall robot move <id> --machine local`).
   A fleet that has a gateway must be on this Mac with no handover open:
   `svall [-p <fleet>] handover local`, then `svall handover status` shows none. An older build knows nothing of
   ownership and would run its own copy wherever the fleet is.
2. **Quit the app and stop each fleet's daemon:**

   ```sh
   launchctl bootout gui/$(id -u)/io.github.linusroxbergh.svall.svalld
   launchctl bootout gui/$(id -u)/io.github.linusroxbergh.svall.svalld.<name>    # for each named fleet
   ```

3. **In each fleet home** (`~/.svall`, and `~/.svall-<name>` for each named fleet), set the new files aside
   and put the kept copies back:

   ```sh
   cd ~/.svall
   mkdir handover-aside && mv fleet.json node.json owner.json handover-aside/
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

To keep what changed since the upgrade instead of going back to the kept copy, set `"version": 9` at the top of
`state.json` to `8` in step 3 rather than copying a kept one. Svall 0.5.1 read this release's state that way in the
same test; 0.12.0's schema has stars and robots as well. The older build leaves out any island or robot it cannot
read, and keeps the file as it read it beside `state.json` as `state.json.broken-<time>`. A robot whose second
terminal is dormant (a `second` with no `tmux`) is one, since the older build has no dormant second terminal; remove
each such `second` as you relabel, and the robot comes back without it:

```sh
jq '.version = 8 | del(.robots[].second | select(.tmux == null))' state.json > state.json.8 && mv state.json.8 state.json
```

For a release before OpenCode support, relabel to `7` instead. That release also leaves out every OpenCode robot,
which it cannot read; Svall 0.3.2 started the rest of the fleet that way.

### Upgrading again

Put back the files you set aside before you install the newer release, in each fleet home:

```sh
cd ~/.svall
mv config.json config.json.bak && mv handover-aside/* . && rmdir handover-aside
```

The fleet keeps its id, its gateway and its generation, and the state is migrated again. A setting changed in
`config.json` while on the older release is not carried over; copy it into `fleet.json` or `node.json`. If you leave
`config.json` instead, it is split again into a fleet with a new id, which its gateway holds no record of: run `svall
host upgrade <host>`, which makes that machine the fleet's worker.
