# Upgrading and downgrading

What changes on your Mac when you install the release with remote machines over an older one, and how to go back.
The upgrade happens by itself with `git pull && pnpm desktop:install`; nothing here needs doing unless you downgrade.

## What the upgrade changes

### `config.json` becomes `fleet.json` and `node.json`

The first time a fleet's daemon starts on the new release (or `archi setup` runs for the private fleet), it splits the
fleet's `config.json` in two:

1. `config.json` is renamed `config.json.bak`, byte for byte, before anything is read out of it.
2. `node.json` gets what belongs to this machine: `port`, `host`, `shell` and `mobile.httpsPort`.
3. `fleet.json` gets everything else and a new fleet `id`. It has no `handover` block, so handover stays off until you
   [turn it on](setup.md#turning-it-on).

The [README's configuration table](../../README.md#configuration) says which key lives in which file. From then on
`config.json` is not read. One put back beside `fleet.json` stops the daemon until you move what you want from it into
the new files and delete it; the daemon's log and `archi doctor` both say so. A `config.json.bak` already in the way
stops the split the same way, before anything is written.

### State schema 8 and protocol 17

- On its first start, the daemon migrates `state.json` to version 8, where a second terminal has a folder of its own.
  The file as it was stays beside it as `state.json.v7-<time>` (or `.v6-`).
- The app, `archi` and the daemons of one release speak protocol 17 to each other. An app or `archi` from an older
  release cannot reach a newer daemon; `pnpm desktop:install` updates all of them together.
- Each daemon writes `owner.json` in its fleet home, which says this Mac owns the fleet, and `~/.config/archipelago/`
  gets `machine.json`, this Mac's id. Nothing asks a gateway until you [set one up](setup.md).

### `archi` and the daemons run from an installed release

Before, `~/.local/bin/archi` was a script that ran the clone through `tsx`, and launchd ran each fleet's daemon from
the clone too. Now `pnpm desktop:install` installs a release and points everything at it:

- the release goes to `~/.local/share/archipelago/releases/<version>`, with `current` naming the one in use;
- `~/.local/bin/archi` and `archipelago` become links to `current/bin/archi`;
- every fleet's launchd agent, the private one and each named fleet's, runs `current/bin/archid`;
- Claude Code's hooks keep the Node they already name while it is there, and otherwise run the release's own.

The clone is needed only to update. Each install keeps the release before it and removes older ones; `archi setup
--rollback` puts the release before back and restarts every fleet's daemon on it. `archi setup` run from the
installed release keeps everything on `current`; run from a clone without `--release`, it still points the shims and
the daemon at that clone, for development.

`archi setup` also no longer replaces a mission control `.claude/settings.json` you edited; `archi setup
--replace-settings` does, keeping a copy.

### Named fleets

- Each fleet home is split and migrated by its own daemon, on its next start, and gets its own `fleet.json`,
  `node.json`, id and `owner.json`.
- Remote machines are set up per fleet: `handover.enabled` in that fleet's `fleet.json`, `archi host enable <host>
  --fleet <name>`, and `archi -p <name> handover …`. On Linux each fleet runs as `archipelago-archid@<name>.service`.
- `host`, `handover`, `gateway`, `fleet`, `connect`, `connection-info` and `version` are now commands, and no longer
  name a fleet, even with `-p`. `archi setup` names each fleet home made under one of them, such as
  `~/.archipelago-host`, and the `mv` to a name that reaches it again.

## Downgrading

An older release refuses a fleet this release has migrated, and its install would put a fresh configuration in place
of yours. Going back therefore means putting back the copies the upgrade kept. This was checked by running a build
from before remote machines (protocol 16, state schema 7) against a private fleet and a named fleet this release had
migrated, in a temporary home:

- **The older daemon does not start.** Its log says `state.json is version 8, newer than this archid reads (7): …; or,
  to go back to the fleet as this version last saw it, move ~/.archipelago/state.json.v7-<time> to
  ~/.archipelago/state.json; archid starts once it is fixed`, and it waits without touching the state.
- **The older `archi setup`**, which its `pnpm desktop:install` runs, finds no `config.json` and writes an empty one,
  so the fleet would start on the default port with default settings.
- **It writes its `archi` script through the link** this release left in `~/.local/bin`, into the installed release's
  own `bin/archi`, unless the link is removed first.
- **It points the private fleet's launchd agent back at the clone**, but leaves each named fleet's agent running this
  release from `~/.local/share/archipelago/current`, which would migrate that fleet again.

With the steps below, the older build started both fleets as they were before the upgrade.

1. **Bring every fleet home.** A fleet that has a gateway must be on this Mac with no handover open:
   `archi [-p <fleet>] handover local`, then `archi handover status` shows none. An older build knows nothing of
   ownership and would run its own copy wherever the fleet is.
2. **Quit the app and stop each fleet's daemon:**

   ```sh
   launchctl bootout gui/$(id -u)/io.github.linusroxbergh.archipelago.archid
   launchctl bootout gui/$(id -u)/io.github.linusroxbergh.archipelago.archid.<name>    # for each named fleet
   ```

3. **In each fleet home** (`~/.archipelago`, and `~/.archipelago-<name>` for each named fleet), set the new files aside
   and put the kept copies back:

   ```sh
   cd ~/.archipelago
   mkdir handover-aside && mv fleet.json node.json owner.json handover-aside/
   mv config.json.bak config.json
   cp "$(ls -t state.json.v7-* | head -1)" state.json
   ```

   The fleet comes back as it was when you upgraded. Islands, characters and notes changed since are lost, and so is
   any setting changed since in `fleet.json` or `node.json`, unless you copy it into `config.json`. A fleet first made
   on this release has no kept copies, and the older build cannot open it; move its fleet home aside instead.

4. **Remove what the older setup would write through, or leave running this release:**

   ```sh
   rm ~/.local/bin/archi ~/.local/bin/archipelago
   rm ~/Library/LaunchAgents/io.github.linusroxbergh.archipelago.archid.*.plist    # named fleets' agents only
   ```

   Each named fleet gets its agent back the first time you open it with `archi <name>`.

5. **Install the older release:** in a clone at that version, `pnpm desktop:install`.

`~/.local/share/archipelago` and `~/.config/archipelago` are not read by the older build. Claude Code's hooks may still
name the release's Node; if you delete `~/.local/share/archipelago`, run `archi setup` once more so they name yours.

A Linux machine you set up can stay as it is; the older build never contacts it. To remove it, run `archi host remove
<name>` before step 2.

To keep what changed since the upgrade instead of going back to the kept copy, set `"version": 8` at the top of
`state.json` to `7` in step 3 rather than copying `state.json.v7-*`. The older build read this release's state that way
in the same test, every character included. It leaves out any island or character it cannot read, and keeps the file
as it read it beside `state.json` as `state.json.broken-<time>`.

### Upgrading again

Put back the files you set aside before you install the newer release, in each fleet home:

```sh
cd ~/.archipelago
rm config.json && mv handover-aside/* . && rmdir handover-aside
```

The fleet keeps its id, its gateway and its generation, and the state is migrated again. A setting changed in
`config.json` while on the older release is not carried over; copy it into `fleet.json` or `node.json`. If you leave
`config.json` instead, it is split again into a fleet with a new id, which its gateway holds no record of: run `archi
host enable` for it again.
