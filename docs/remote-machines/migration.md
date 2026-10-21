# Upgrading and downgrading

What changes on your Mac when you install the release with remote machines over an older one, and how to go back.
The upgrade happens by itself when Svall updates, or with `git pull && pnpm desktop:install` for Svall Dev; nothing
here needs doing unless you downgrade.

## What the upgrade changes

### `config.json` becomes `fleet.json` and `node.json`

The first time a fleet's daemon starts on the new release (or `svall setup` runs for the private fleet), it splits the
fleet's `config.json` in two:

1. `config.json` is renamed `config.json.bak`, byte for byte (a link stays a link), before anything is read out of
   it.
2. `node.json` gets what belongs to this machine: `port`, `host`, `shell`, `agentsOff`, `integrations` and
   `mobile.httpsPort`.
3. `fleet.json` gets every other key it knows and a new fleet `id`. It has no `handover` block, so handover stays off
   until you [turn it on](setup.md#turning-it-on).
4. A key neither file knows stays only in `config.json.bak`.

The [README's configuration table](../../README.md#configuration) says which key lives in which file. From then on
`config.json` is not read. A dotfile manager such as stow or home-manager may link it back to the file
`config.json.bak` links to; that link is left alone, with a line in the daemon's log, so link `fleet.json` and
`node.json` from your dotfiles instead. Any other `config.json` beside `fleet.json`, such as the one an older
release's `svall setup` writes, is moved to `config.json.unread-<time>` unread when the daemon starts or `svall setup`
runs, and the daemon's log or setup's output names it; copy anything you still want from it into the new files.
`svall doctor` warns of one still there. A `config.json.bak` already in the way stops the split before anything is
written, until you keep one of the two; the daemon's log and `svall doctor` both say so.

### State schema 9 and protocol 24

- On its first start, the daemon migrates `state.json` to version 9, where a second terminal has a folder of its own.
  The file as it was stays beside it as `state.json.v8-<time>`, or `.v7-` from a release before OpenCode support.
- The app, `svall` and the daemons of one release speak protocol 24 to each other. An app or `svall` from an older
  release cannot reach a newer daemon; an update installs all of them together.
- Each daemon writes `owner.json` in its fleet home, which says this Mac owns the fleet, and `~/.config/svall/`
  gets `machine.json`, this Mac's id. Nothing asks a gateway until you [set one up](setup.md). A fleet with no
  gateway starts even where `~/.config/svall` cannot be written or holds a broken `machine.json`: its daemon runs as
  the machine its `owner.json` names, and its log says what to fix. A fleet with a gateway does not: its daemon exits
  at each start, with the fix in its log, until it can use `~/.config/svall` again.

### Named fleets

- Each fleet home is split and migrated by its own daemon, on its next start, and gets its own `fleet.json`,
  `node.json`, id and `owner.json`.
- Remote machines are set up per fleet: `handover.enabled` in that fleet's `fleet.json`, `svall host enable <host>
  --fleet <name>`, and `svall -p <name> handover …`. On Linux each fleet runs as `svall-svalld@<name>.service`.
- `host`, `handover`, `gateway`, `fleet`, `connect`, `connection-info` and `version` are now commands, and no longer
  name a fleet, even with `-p`. `svall setup` names each fleet home made under one of them, such as
  `~/.svall-host`, and the `mv` to a name that reaches it again. A `config.json` whose `name` is one of them splits
  without it, so the fleet goes by its default name until you name it in Settings; `svall setup` lists each one.

## Downgrading

An older release refuses a fleet this release has migrated, and its install would put a fresh configuration in place
of yours. Going back therefore means putting back the copies the upgrade kept. The release before this one is Svall
0.13.0 (protocol 23, state schema 8). Its state checks are 0.9.0's, and its schema adds one optional field to 0.9.0's.
What follows was checked by running Svall 0.5.1 (protocol 19) and Svall 0.3.2 (protocol 18, state schema 7) against a
fleet this release had migrated, in a temporary home:

- **The older daemon does not start.** Svall 0.5.1's log says `state.json is version 9, newer than this svalld reads
  (8): …; or, to go back to the fleet as this version last saw it, move ~/.svall/state.json.v8-<time> to
  ~/.svall/state.json; svalld starts once it is fixed`, the message 0.9.0 to 0.13.0 print too, and it waits without
  touching the state. A release before OpenCode support says `newer than this svalld reads (7)`, and names a
  `state.json.v7-<time>` copy only when there is one.
- **The older `svall setup`** finds no `config.json` and writes an empty one, so the fleet would start on the default
  port with default settings. Upgrading again over it moves that file aside unread and starts on `fleet.json` and
  `node.json`.

With the steps below, Svall 0.5.1 started the fleet as it was before the upgrade. 0.12.0 was not run this way; its state
and configuration code differs from 0.5.1's only by optional state fields.

1. **Bring every fleet home.** A fleet that has a gateway must be on this Mac with no handover open:
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

   The fleet comes back as it was when you upgraded. Islands, characters and notes changed since are lost, and so is
   any setting changed since in `fleet.json` or `node.json`, unless you copy it into `config.json`. A fleet first made
   on this release has no kept copies, and the older build cannot open it; move its fleet home aside instead.

4. **Install the older Svall**, or for Svall Dev run `pnpm desktop:install` in a clone at that version.

`~/.config/svall` is not read by the older build.

A Linux machine you set up can stay as it is; the older build never contacts it. To remove it, run `svall host remove
<name>` before step 2.

To keep what changed since the upgrade instead of going back to the kept copy, set `"version": 9` at the top of
`state.json` to `8` in step 3 rather than copying a kept one. Svall 0.5.1 read this release's state that way in the
same test; 0.12.0's schema has stars and robots as well. The older build leaves out any island or character it cannot
read, and keeps the file as it read it beside `state.json` as `state.json.broken-<time>`. A character whose second
terminal is dormant (a `second` with no `tmux`) is one, since the older build has no dormant second terminal; remove
each such `second` as you relabel, and the character comes back without it:

```sh
jq '.version = 8 | del(.characters[].second | select(.tmux == null))' state.json > state.json.8 && mv state.json.8 state.json
```

For a release before OpenCode support, relabel to `7` instead. That release also leaves out every OpenCode character,
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
host enable` for it again.
