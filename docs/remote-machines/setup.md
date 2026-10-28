# Setting up a Linux machine

An always-on Linux machine can be a **worker** of your fleet: robots you [move there](placement.md) keep working
while your Mac sleeps. The fleet itself stays on the Mac, its **home**: islands, map, notes, phone and mission
control. A fleet can have several workers, and a machine can be a worker of several fleets. This page covers what the
machine needs, how to add it, and how to look after it.

## Supported machines

| | Mac | Linux machine |
| --- | --- | --- |
| System | macOS 15 or newer | Ubuntu LTS 22.04 or newer, x86-64 or arm64. Ubuntu 24.04 is the tested release; a release other than an LTS is a warning, and an older Ubuntu or any other system is refused. |
| Svall | The app (see the [README](../../README.md#quickstart)) | Installed by `svall host add` from the Mac. It brings its own Node and tmux and needs no clone, pnpm or build tools. |
| Services | launchd, as for any fleet | systemd user services, with lingering on so the fleet keeps running after you log out; `svall host add` turns it on |
| Tools | tmux, Git | Git (`sudo apt install git`) |
| Network | Tailscale, and OpenSSH to the Linux account with a key ssh can use without asking (Tailscale SSH works); a password gets only past the first login | Tailscale |
| Agents | Claude Code 2.1.251 or newer, Codex 0.156.0 or newer and OpenCode 2.0.22 or newer, for the agents your fleet runs, each logged in on each machine | the same, each at the Mac's release or newer, since a move refuses a machine whose agent is older |

On the Mac, tmux 3.5 or newer is recommended, because Shift+Enter needs it. The Linux machine runs the tmux 3.7c Svall
brings, as Ubuntu 24.04 ships 3.4.

## Home paths

The Linux account's home need not be your home on the Mac. A move puts each of a robot's paths under the home it
leaves at the same place under the home it lands in, so `/Users/ada/code/app` on the Mac is `/home/ada/code/app` on
Linux, and `/Users/ada/code/app` again once the robot comes back. A robot's repository lands at its main checkout's
place there, as the worker's own clone. A path outside your home, such as `/Volumes/work/repo`, keeps its path.

The home path can be at most 89 bytes long (less for a named fleet), because the fleet's hook socket under it, a Unix
socket, holds a path of at most 107 bytes. `svall host add` checks it.

## Adding the machine

In the app, open Settings → Machines → **Add machine**, give the machine a name (lowercase letters, digits and dashes,
such as `studio`) and its ssh destination (such as `ada@studio`), and choose **Add machine**. From a terminal:

```sh
svall host add studio --ssh ada@studio
```

Both run the same steps and show each as it finishes. The app shows them in these groups:

1. **Reaching it.** One interactive ssh, so you can accept the host key and log in, then one control connection for
   the rest, which needs a key ssh can use without asking. From the app, ssh asks in a dialog.
2. **What it needs.** Ubuntu (a release other than an LTS is a warning) and its architecture, the home path,
   Tailscale, Git, systemd, free space (under 5 GiB is a warning) and lingering, which it turns on where it is off.
3. **Svall there.** The Linux release matching this Mac's own release, checked against the digest this Mac's release
   pins and against its signature, copied over ssh and installed under `~/.local/share/svall` there, and the tmux it
   brings checked. Then `svall-svalld@private.service` as a systemd user unit, its machine id, and the release it
   answers from, and **Worker**: the machine becomes this fleet's worker, with a token this Mac issues, and the unit
   restarts as `svalld --worker`, which accepts this Mac alone.
4. **Agents there.** Claude Code, Codex and OpenCode on the machine: installed, Claude Code 2.1.251 or newer, Codex
   0.156.0 or newer and OpenCode 2.0.22 or newer, logged in (for OpenCode, `opencode auth list` names a model provider),
   and with Svall's hooks in place (for OpenCode, Svall's plugin), and for Codex a sandbox that starts, as the machine's
   own `svall doctor` finds them; and `gh`'s login. Each agent is asked on the `PATH` and with the `CLAUDE_CONFIG_DIR`,
   `CODEX_HOME` and `XDG_*` folders the Svall daemon runs with, which setup takes from your login shell there.
   **Agent versions** compares each with this Mac's, as its own daemon finds it.
5. **Your agent setup.** A row for each part of [your agent setup](#your-agent-setup-on-the-machine) that waits on
   you there: a key to tick, a variable to set, a login, a program to install.
6. **Trying it out.** The machine's own fleet answers through a forwarded port, says it serves this fleet as a
   worker, and tmux opens and closes a window there. Then the machine is added to this Mac's list in
   `~/.config/svall/machines.json`, and this Mac's daemon links to it.

It ends in one line: "studio is ready. Robots you move there keep working while this Mac sleeps.", or "studio has
2 things to fix", followed by them. Each failed step counts, and so does each warning with an action. A warning with
no action, such as `gh` not logged in there, is advice and does not count. Your agent setup is never a thing to fix,
as a move goes ahead without it: what of it will not work on the machine yet follows in a short list, a line each
with its name, what it lacks and the one thing to do from this Mac:

```
studio is ready. 3 parts of your agent setup will not work there yet:
  linear  keys not copied (env.LINEAR_API_KEY)  → svall host consent studio claude:mcp:linear on
  notion  not logged in                         → ssh -L 3118:localhost:3118 ada@studio, then MCP_OAUTH_CALLBACK_PORT=3118 claude, /mcp
  uvx     not installed; context7 needs it      → ssh ada@studio, then curl -LsSf https://astral.sh/uv/install.sh | sh
Set them up now? [Y/n]
```

A list with nothing to do about any of it, such as servers that only run on a Mac, says "will not work there" without
"yet"; so do a move's list and the app's footer.

When one of them is a key to copy or a command to run there, `svall host add` and `svall host upgrade` in a terminal
then ask whether to set them up now: yes asks for each key in turn whether to copy it there, which it does only on a
yes, and prints each command to run on the machine once. In the app each such row has its box or button in the list.
A run exits 1 while something is left to fix. In the app, a step that failed with nothing named to do offers
**Try again**; after a check, **Check** at the top runs it once more. Svall never runs `sudo`, never runs an agent's installer and never
copies a login, so these are yours.

In the app a check shows the step under way, then what needs you, by phase; the checks that went fine and your agent
setup are folded behind one line each, and the footer counts warnings. A row whose fix is an agent's own update
(`claude update`, `codex update`, `opencode upgrade`) offers **Update**, which runs it there and checks the machine
again; a check that finds the machine on another release offers **Upgrade** on that row. Each other fix that is one
command offers **Open terminal**: a terminal on the machine opens in the panel, over an ssh of its own that asks
nothing and forwards no ssh agent, with the command typed at its prompt. Press Return to run it, or change it first;
click a link it prints to open it in your browser. When you exit or choose **Done**,
or close the panel with ×, the terminal hangs up and the panel checks the machine again, once it is in this Mac's
list. **Open a terminal there**, in the machine's ⋯ menu, opens one with nothing typed. From a terminal on the Mac,
each action names the command and the machine to run it on:

- A missing package: the action names the `apt` command, as `ssh ada@studio, then sudo apt install git`.
- Lingering the system would not turn on: `ssh ada@studio, then sudo loginctl enable-linger ada`. Svall turns it on
  itself where polkit lets an account do so, as on Ubuntu Server; a machine without polkit refuses. Without it the
  fleet's robots there stop when you log out.
- An agent not installed that no fleet on this Mac runs, as a robot's, mission control's or the scribe's agent,
  is only noted, once every fleet here has started at least once.
- An agent not installed or not logged in: `ssh ada@studio`, install it with its vendor's command and run
  `svall setup`, which writes Svall's hooks for an agent installed since, then `claude auth login`, `codex login` or
  `opencode auth login`. Claude Code prints a link and asks for the code the browser then shows. Codex's login waits
  for the browser on port 1455 of the machine: its terminal in the app forwards port 1455 of this Mac there, and
  quits saying so when another program holds that port; over your own ssh, use `ssh -L 1455:localhost:1455`, or
  `codex login --device-auth`. OpenCode runs OpenCode Zen's free models with no login. A move to the machine needs a
  model provider's login or key there, as `opencode auth list` shows, unless OpenCode on this Mac has none either.
  Codex also asks once to trust Svall's hooks: start `codex` there and choose "Trust all and continue", or trust
  them with `/hooks`.
- An agent at another release than this Mac's: the side behind, and the vendor's update to run there,
  `ssh ada@studio, then claude update`, or `on this Mac, run claude update`. `codex update` and `opencode upgrade` do
  the same for Codex and OpenCode. An update goes to the latest release, so the other machine may then be behind.
- Svall's hooks not installed, out of date, turned off or not trusted: the action names what the machine's own
  `svall doctor` says to do there.
- Codex's sandbox kept from starting by AppArmor, as on Ubuntu 24.04, where a Codex robot would ask before each
  command: the action installs the AppArmor profile that lets `bwrap` make its user namespace,
  `sudo apt install bubblewrap apparmor-profiles`, then
  `sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/` and
  `sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict`, which the app types as one line for you to run
  with your own `sudo` password. A sandbox that fails for another reason names it;
  run `codex sandbox -- true` there to see it.

Adding the same machine again runs every check again and changes nothing that is already right. For another fleet,
add the machine from that fleet: `svall -p work host add studio --ssh ada@studio` makes it a worker of `work` too, with
its own `svall-svalld@work.service`.

### Your agent setup on the machine

Once the machine is in this Mac's list, Svall copies your agent setup there. It copies it again each time this Mac
links to the machine and before every move, one way, and only what changed on this Mac since the last copy:

- **Claude Code:** `settings.json`, merged key by key; `CLAUDE.md`, `skills/`, `rules/`, `agents/`, `commands/` and
  `keybindings.json`; your plugins and their marketplaces; and the MCP servers in `~/.claude.json`, yours and those of
  each project whose folder the machine has.
- **Codex:** `config.toml`, merged key by key, with its MCP servers; `AGENTS.md`; and `~/.agents/skills`. Its
  `notify`, `[desktop]`, `[marketplaces]` and `[plugins]` stay on this Mac, and the machine keeps its own
  `[projects]` and `[hooks]`.
- **OpenCode:** `opencode.json` or `opencode.jsonc`, merged key by key, with its MCP servers; and its commands, skills,
  agents, plugins and `AGENTS.md`.

A path under your home on this Mac lands under the home there. Svall's own hooks, statusline and OpenCode plugin on
the machine are never replaced. Logins never travel: log each agent, and `gh`, in on the machine.

**Keys.** A key in your setup travels only once you tick it for that machine. Keys are an MCP server's `env` values,
its headers, and a key in its URL or arguments, plus the key fields of `settings.json` (among them the headers a
marketplace in `extraKnownMarketplaces` sends and the query of its URL, which are emptied in `known_marketplaces.json`
too until ticked), `config.toml` and the OpenCode config. A reference with a default, `${LINEAR_API_KEY:-lin_…}`,
holds its default as a key. Each server or file that holds one is a row under **Your agent setup**, such as "copy
linear's keys to studio", with a box and the keys masked (`env.LINEAR_API_KEY lin…f2`). A key in an argument is named
by the flag before it, its own `--flag=` or `KEY=`, or its URL's scheme and host, such as `args[--api-key]` or
`args[https://example.com].token`, and every argument of one name is that one key, as an `env` key is, so a tick
follows its name when the arguments move. Unticked, the server is copied without them: each `env` key becomes the
agent's reference to a variable of the same name (`${LINEAR_API_KEY}` for Claude Code, `{env:LINEAR_API_KEY}` for
OpenCode, the name in the server's `env_vars` for Codex), so the server reads that variable from its environment on
the machine, which robots there take from the fleet's `.env` (below); a key in its headers, URL or arguments is left
out; a reference with a default keeps the reference alone. The row stays until you tick it or the machine has its own
key: a key for that server in the overrides (below) counts, and so does the variable an `env` key reads set there with
`svall worker env LINEAR_API_KEY`; the row then reads "studio has its own keys". While this Mac is linked to the
machine, ticking or unticking changes the copy there at once, whatever runs there; otherwise the change is saved, and
takes effect when studio links. An untick while this Mac cannot read the file that holds the key is saved too, and the
copy stays on studio until this Mac can read that file again; while studio still holds a copy you unticked, the row
reads "still on studio; check studio again", and the list names it "unticked; still on studio". A file there that holds a ticked key is readable by your account alone. A
server or plugin config with settings Svall cannot copy one by one is a row "copy notion to studio as it is", and is
copied only once ticked, its file as it is, keys included. So is a file whose keys Svall cannot leave out: a plugin's LSP config (`.lsp.json`, `lspServers` in its
`plugin.json`, or a file its marketplace entry names) with a key in a server's `env`, a marketplace's
`marketplace.json` whose entries set `headers` or `headersHelper`, and a subagent, in `agents/`, a plugin's `agents/`
or a file a plugin's `plugin.json` or marketplace entry names in `agents`, whose `mcpServers` defines a server with a
key or settings Svall cannot copy one by one, or that names `mcpServers` in a way Svall does not read. Until ticked, each stays on
this Mac.
From a terminal, `svall host doctor studio` lists what will not work there, and `svall host consent studio <item>
<on|off> [--field <field>]` ticks one: `<item>` is its row's name after `mirror:`, such as `claude:mcp:linear`;
`--field env.LINEAR_API_KEY` ticks that key alone, and `off` unticks every key of the item. `--json` gives every row.
After a move, the parts of one robot's setup that will not work where it lands are listed for it
([Moving one](placement.md#moving-one)).

Fleets that share a machine share its agent files there: a key ticked in one fleet is on the machine for all of them,
so tick or untick it in each fleet that uses the machine.

**Variables.** A server can read a variable, as `"GITHUB_TOKEN": "${GITHUB_TOKEN}"` in its `env` does, or hold an
empty value for one. That is a row "set GITHUB_TOKEN on studio" until the machine's daemon has the variable.
**Open terminal** types `svall worker env GITHUB_TOKEN` there. It asks for the value without showing it, or takes it
from a pipe, and keeps it in the fleet's `.env` on the machine. Robots that start there afterwards have it.

**Logins and programs.** A Claude Code server that signs in with OAuth is a row "log in once on studio". **Open
terminal** types `MCP_OAUTH_CALLBACK_PORT=3118 claude` there and forwards port 3118 of this Mac there; run it, type
`/mcp` and sign in. A server that names its own callback port gets plain `claude` and that port forwarded instead,
and an `mcp-remote` server the port that follows its URL. Over your own ssh, forward the port with
`ssh -L 3118:localhost:3118`. A Codex or OpenCode server's login is listed with the command to run there, and the row stays
whether or not you did; those logins pick their own port, so sign in there over an ssh tunnel of your own to the
port the login names. A server whose program the machine lacks is a
row "install uvx on studio". A server that runs only on a Mac, such as the Chrome extension, is listed and not copied.

**The machine's own settings.** Files under `mirror-overrides/` in the fleet's home on the machine (`~/.svall` for the
private fleet, `~/.svall-<fleet>` for another) are merged over Svall's copy, last, and Svall never changes them. Their
folders `claude/`, `codex/`, `opencode/` and `home/` stand for `~/.claude`, `~/.codex`, `~/.config/opencode` and the
home. In `claude/.claude.json`, only `mcpServers` counts, merged over the copied servers by name.
`claude/settings.json`, `codex/config.toml` and `opencode/opencode.json` merge key by key, and any other file replaces
the copy. Keep there
what the machine should have of its own, such as its own key for a server. Any other edit made on the machine stays
until that setting changes on this Mac, but a copied server you delete there, or a ticked key you change there, is
written back at the next copy; a key of the machine's own belongs in the overrides.

Comments in `config.toml` and `opencode.jsonc` on the machine do not survive a merge. Svall writes both back without
them, and `opencode.jsonc` as plain JSON under its own name.

Claude Code also writes `~/.claude.json`, from the copy it holds in memory. If a Claude Code running on the machine
saves just after Svall's copy, it can drop a server Svall added or bring back a key Svall removed. The next copy, at
the next move, tick or link, writes the server again or removes the key again.

**An API key in your shell.** A move checks each agent's login in the Svall daemon's systemd environment, with the
fleet's `.env` keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) added as a robot gets them, not in your shell. An agent's
terminal starts your shell, so an API key exported only in `~/.bashrc` or `~/.profile` works for the agent while the
check says it is not logged in. Put the key in the fleet's `.env`, which the checks read each time, with
`svall worker env ANTHROPIC_API_KEY` on the machine, or in `~/.config/environment.d/agents.conf` as `NAME=value`
lines and then run `systemctl --user daemon-reload` and `systemctl --user restart svall-svalld@private`.

### The companion release

`svall host add` installs the companion matching the Mac's release exactly: a move needs the same release on both
machines. It takes the one Svall.app carries for the machine's architecture, x86-64 or arm64, checks it against the
digest the app's release pins, and checks its signature against the keys the app's release lists. The `release` step
says whether the companion is signed, and `svall host doctor` says it of the machine's release and the Mac's.

- `--release <archive>` installs that archive instead. A signed one must be signed by a key the Mac's release lists;
  `--allow-unsigned` accepts one without a signature. See [the security notes](../security/workers.md) for how
  releases are checked.
- Svall Dev runs release `dev` and carries no companion, so its worker runs one built from the same checkout as
  release `dev`: `node scripts/build-companion.mjs --out <dir> --arch x64 --version dev`, then
  `svall-dev host add studio --ssh ada@studio --release <dir>/svall-companion-dev-linux-x64.tar.gz --allow-unsigned`.

## Looking after it

Settings → Machines lists every machine with its ssh destination and the release and result of its last check, each
with **Check** and a ⋯ menu: **Upgrade to this Mac's release**, **Open a terminal there**, **Remove**, which waits
while robots are placed there, and **Forget**, offered only while the machine cannot be reached. With no machine, it
says what a machine is.

| Command | In the app | What it does |
| --- | --- | --- |
| `svall host list` | Settings → Machines | Every machine in the registry, with its ssh destination, release, last check and id. |
| `svall host doctor <name>` | Check | The machine's own checks, plus whether it runs this Mac's release, whether it serves this fleet as a worker, its free space and its home path, then the rows of [your agent setup there](#your-agent-setup-on-the-machine); `host list` shows when it last ran and what it found, your agent setup aside. A check marked ✗ fails and makes it exit 1; one marked ! is a warning. It ends as `host add` does: ready, or the things to fix there, with their names, then what of your agent setup will not work there yet. Each failed check counts, and so does each warning with an action outside your agent setup. A fresh Ubuntu 24.04 warns on `gh` and `path`, and where Codex is installed on `codex sandbox`; none of these stops a move, and `gh` is advice that does not count. |
| `svall host upgrade <name>` | Upgrade to this Mac's release, in the ⋯ menu | Installs this Mac's release there, restarts every fleet's daemon, and checks each answers from the new release. If one does not, it goes back to the release before. It then makes the machine this fleet's worker, unless it is one already, and ends with your agent setup there as `host add` does, asking the same. On an Ubuntu older than 22.04 it installs nothing. A fleet's tmux server running through the upgrade, such as one on Ubuntu's own tmux, keeps its tmux while a robot runs in it, and starts over on the new release's at a daemon start with none. Robots running there keep running, and while an older companion's tmux runs them, what is copied in their terminals may not reach the Mac. |
| `svall host upgrade <name> --rollback [release]` | Roll back, after an upgrade that failed | Puts the machine back on the release before, or on the kept release named, restarts its units, and checks each fleet's daemon answers from it. It refuses, changing nothing, while a fleet there keeps its state at a newer schema than that release reads, or runs a tmux server that release could not reach. |
| `svall host remove <name>` | Remove, in the ⋯ menu | Runs `svall uninstall` there, which first takes back what [your agent setup](#your-agent-setup-on-the-machine) copied there with keys (see `svall uninstall` below), shows what it took back, and ends with a warning to do by hand where it could not take a key back or a copy changed there since; it drops the machine from the registry, its last check from `checks.json` and its ticks from every fleet on this Mac. It refuses while a robot of a fleet here runs on the machine or is moving to it ("2 robots are on linus-vault: ada, bo; move them back first"). Its fleets and their files stay on that machine. |
| `svall host remove <name> --forget` | Forget, in the ⋯ menu while the machine cannot be reached | Drops the machine, its last check and its ticks without reaching it, when it is gone. Keys the mirror copied there stay there. |

After you update Svall on the Mac, run `svall host upgrade <name>`: until both machines run the same release, a move
refuses with "studio runs X, this Mac Y; upgrade it under Machines". Robots already there keep running meanwhile.

On the Linux machine itself:

- `svall setup --rollback [release]` puts the release before back, or the kept release named, restarts the units and
  checks each fleet's daemon answers from it. `svall setup` sets the machine up again from the release `current`
  names.
- `svall uninstall` ends the robots that run there, so move them back first. Before it removes Svall, it takes back
  what each fleet's mirror copied there with keys, each while it is as the mirror wrote it: a copied key becomes what
  an untick leaves (an `env` key the agent's reference to its variable, a key in a URL or argument the rest of it, any
  other key emptied), a server copied as it is leaves its config file, a key in `known_marketplaces.json`, a
  `marketplace.json` or a subagent is taken out where it lies there, even where an entry added above it moved it, and
  the file stays, another file the mirror wrote holding a ticked key, such as a plugin's server file or a subagent
  whose `mcpServers` Svall cannot read or whose server has settings Svall cannot copy one by one, is deleted, and a copy a daemon
  left unapplied in the fleet's `cache` goes. A key, server or file changed on the machine since the mirror wrote it
  stays, named in what it prints, and so does every key in a config file there that no longer parses, as do the
  fleet's `.env` and its `mirror-overrides/`, which are the machine's own.
- Each fleet's own log is `svalld.log` in its fleet home (`~/.svall` for the private fleet), beside the units'
  logs in `~/.local/share/svall/log`.
- `systemctl --user status svall-svalld@private` shows the fleet's unit.

## What is installed where

On the Linux machine, all under the account:

- `~/.local/share/svall/releases/<version>` and `current`, the release, with the tmux the fleet's terminals run in
  (`bin/tmux`); `~/.local/bin/svall` points into it. Each install keeps the release before it, for a rollback, and
  removes older ones.
- `~/.config/systemd/user/svall-svalld@<fleet>.service`, one per fleet the machine is a worker of, running
  `svalld --worker`. Each fleet's unit carries the `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`,
  `XDG_DATA_HOME` and `OPENCODE_DB` the account's login shell sets. Its `PATH` holds the release's `bin`,
  `~/.local/bin` and `~/.opencode/bin`, where OpenCode's installer puts it.
- `~/.config/opencode/plugins/svall.js` (under `XDG_CONFIG_HOME` when the login shell sets it), Svall's OpenCode
  plugin, when OpenCode is installed and the fleet does not turn it off.
- `~/.local/share/svall/log`, the units' logs.
- `~/.cache/svall`, where `svall host add` and `upgrade` upload and unpack a release.
- `~/.svall` (and `~/.svall-<name>`), each fleet's home there: `worker.json`, which names this Mac, the fleet and
  the token this Mac issued; `.env`, the variables its robots there get, mode 600, written by `svall worker env`;
  `cache/docs`, a copy of the fleet's notes; `cache/mirror-state.json`, what the agent setup mirror last wrote there,
  as hashes; `cache/mirror-vars.json`, the names of the variables the copied setup reads; `journal/`, what happened
  there that this Mac has not taken yet, and each move's journal; `mirror-overrides/`, settings of the machine's own
  that the agent setup this Mac copies there never replaces; and the robots' tmux server, hooks socket and
  transcripts. The clones the robots work in are under the account's home, at each main checkout's
  place.

On the Mac:

- `~/.config/svall/machine.json`, this Mac's machine id, `machines.json`, the registry, and `checks.json`, each
  machine's last check. A registry that cannot be read is moved aside to `machines.json.broken-<time>` with a
  warning, and a command that then misses a machine names that copy.
- In each fleet home: `workers.json`, the token each worker was issued, `mirror-consent.json`, the keys ticked for
  each machine, and `journal/moves/`, each move's journal.
