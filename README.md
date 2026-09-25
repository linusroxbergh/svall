# Archipelago

> [!NOTE]
> **Alpha 0.1**: early and changing fast. Expect rough edges.

A macOS map of your Claude Code and Codex agents. Every terminal is a character
on an island, so you can see at a glance which agents are working, waiting on
you or done.

![The map: islands of characters, the islands panel on the left and a character's side card on the right](assets/archipelago_overview.jpg)

- Islands group your characters, say one per project, on a map or a board.
  Each card shows its agent's status, how full its context window is, its
  model and links such as its PR and ticket.
- Each terminal is a tmux window, so quitting the app or restarting the daemon
  loses nothing. After a reboot, reviving a character resumes its session with
  `claude --resume` or `codex resume`.
- Context carries over. Give an island or character instructions, and links,
  files or folders to read. Agents leave notes for the next agent, per fleet,
  repository, island or character. Each session starts with a short brief of
  all of it plus its repository, open PR and ticket, and gets a diff when any
  of it changes.
- Resources gathers the instructions, skills, MCP servers, plugins and hooks
  that Claude Code and Codex give your agents, globally and per repository,
  and opens each in an editor.
- Every terminal has a browser, a file editor and the working tree's changes
  beside it.
- The scribe names each character and keeps its note current with what its
  agent is doing.
- Mission control has buttons that start a helper agent to update or report on
  the fleet.
- A macOS banner tells you when an agent is blocked or done, with Approve and
  Deny on it.
- Your phone gets the fleet and any terminal over Tailscale, with push
  notifications.
- The `archi` CLI scripts the fleet: make characters, send prompts, wait for
  them.

A daemon (`archid`) runs each fleet; the app, the CLI and the phone are its
clients.

## Quickstart

Archipelago builds on macOS 15.6 or newer with the Command Line Tools for
Xcode 26 or newer, which Homebrew installs. On an Apple Silicon Mac the install
downloads the terminal engine prebuilt, and the clone, its dependencies and the
build take about 750 MB of disk. An Intel Mac also needs Xcode; see
[Building Ghostty from source](#building-ghostty-from-source).

1. Install the tools and the [Claude Code CLI](https://code.claude.com/docs/en/setup).
   Claude Code works with a Claude subscription or an Anthropic API key; see
   [Using API keys](#using-api-keys).

       brew install node tmux pnpm gh   # skip node if you have 24 or newer
       gh auth login                    # clones the private repository, downloads the terminal engine and resolves PR links

   If `xcrun --show-sdk-version` prints a version below 26, update the Command
   Line Tools in System Settings → General → Software Update, or Xcode if
   `xcode-select -p` points into it. If your pnpm came
   from somewhere other than Homebrew, `pnpm --version` must show 12 or newer.
   Update it the way you installed it, such as `npm i -g pnpm@latest` or
   `pnpm self-update`.

   For characters that run Codex, also install the
   [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) 0.155 or newer. An
   OpenAI API key is enough; you don't need a ChatGPT subscription.

2. Clone and install:

       git clone https://github.com/linusroxbergh/archipelago && cd archipelago
       pnpm desktop:install

   The installer lists anything missing before it builds. Without admin
   rights, run `ARCHI_APP_DEST=~/Applications pnpm desktop:install` instead. If
   your shell can't find `archi` afterwards, add `~/.local/bin` to your PATH:

       echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # then open a new terminal

3. Run `archi`, or open Archipelago from Spotlight. `+ New island` on the
   sandbar at the bottom makes an island, and Cmd+T makes a character on it: a
   shell that becomes an agent when you type `claude` or `codex`. On first
   launch, the app asks before the scribe makes paid agent calls. The first
   mission control button you press opens a terminal where Claude Code asks you
   to trust `~/.archipelago/home`.

Keep the clone where it is, because `archi` and the daemon run from it. If you
move it or clone it again, `pnpm desktop:install` in the new place points them
there. Setup's hooks do nothing
outside Archipelago. [What setup changes](#what-setup-changes) lists every file
setup writes, and `archi uninstall` removes them.

### Using API keys

Archipelago runs the Claude Code and Codex CLIs and has no AI account or
billing of its own. The provider whose key you use bills the API calls. The
installer checks that `claude` is installed but doesn't need a Claude
subscription or login, so you can run Codex characters and leave the Claude
scribe off.

For Claude Code, create an [Anthropic API key](https://console.anthropic.com/settings/keys)
and put it in the private fleet's `.env` (another fleet's is
`~/.archipelago-<fleet>/.env`):

    mkdir -p ~/.archipelago
    touch ~/.archipelago/.env
    chmod 600 ~/.archipelago/.env
    nano ~/.archipelago/.env

Add `ANTHROPIC_API_KEY=your-key` on its own line. Don't put the key in this
repository or in a shell command that history keeps. New character shells and the headless Claude scribe read it: create a
character and type `claude`, or run
`archi char new --island <island> --cwd <path> --claude`. A shell that is
already running keeps its old environment, so after changing the file, create
a new character or revive a dormant one. Claude Code may ask once before it
uses an API key in an interactive session; see its
[environment variable reference](https://code.claude.com/docs/en/env-vars).

For Codex, sign the Codex CLI in with an
[OpenAI API key](https://platform.openai.com/api-keys) before you start a Codex
character. With `OPENAI_API_KEY` set in your normal terminal, run:

    printenv OPENAI_API_KEY | codex login --with-api-key
    codex login status

Codex keeps the login for later `codex` and `codex exec` runs. Then type
`codex` in a character, or run
`archi char new --island <island> --cwd <path> --agent codex`. See the
[Codex authentication guide](https://learn.chatgpt.com/docs/auth). An
`OPENAI_API_KEY` in the fleet's `.env` also reaches new character shells, but
the saved CLI login is the documented setup.

The scribe is optional and uses Claude whatever CLI your characters run. For a
Codex-only fleet, replace the `{}` that setup wrote in
`~/.archipelago/config.json` with this, and restart the daemon (see
[Configuration](#configuration)) before you turn the scribe on:

    { "scribe": { "agent": "codex" } }

Mission control's helper buttons start Claude and use its skills, so they need
a Claude login or an Anthropic key. Codex characters work without them. Leave
the scribe off to avoid its extra API calls. The Usage panel shows
subscription limits, not API spending.

### Updating

    git pull && pnpm desktop:install

If pnpm says it failed to switch versions, update pnpm to 12 or newer the way
you installed it (`brew upgrade pnpm`, `npm i -g pnpm@latest`, or
`pnpm self-update` run outside the clone) and try again. If it says the Node
version is unsupported, run `brew upgrade node`.

### When something breaks

Run `archi doctor`. It checks what the fleet needs and prints the end of the
daemon's log, `~/.archipelago/archid.log`. Send its output, and what you were
doing, as an issue on
[linusroxbergh/archipelago](https://github.com/linusroxbergh/archipelago/issues).

### Migrating from Herdr

Ask your agent to move your Herdr workspaces into Archipelago. It reads them
with `herdr workspace list` and `herdr agent list`, then makes each workspace
an island (`archi island create`) and each agent pane a character in the same
directory, running the same agent
(`archi char new --island <island> --cwd <dir> --agent <claude|codex>`).
Only Claude and Codex panes are supported; other agents are untested.
`herdr --skill` and `archi <command> --help` cover the rest.

### Building Ghostty from source

The installer downloads GhosttyKit, the terminal engine, prebuilt for the
Ghostty version this checkout pins. It builds GhosttyKit from source instead
when the download fails: on an Intel Mac, when `gh` isn't signed in (run
`gh auth login` and install again), or when no build of that version has been
published. That needs Xcode 26 or newer from the App Store (the Command Line
Tools alone are not enough). Open Xcode once to accept its license, then run:

    sudo xcode-select -s /Applications/Xcode.app
    xcodebuild -downloadComponent MetalToolchain
    brew install zig@0.15

The first build takes several minutes and about 1.2 GB of disk.

## Concepts

- **Fleet**: one daemon, one tmux server, one window. `archi` opens the
  private fleet; `archi work` creates a separate one (any lower-case name
  works; `archi -p <name>` makes one whose name reads like a mistyped
  command).
- **Island**: a group of characters. Mission control is the fixed one at the
  bottom.
- **Character**: one terminal. Type `claude` or `codex` in it and the map
  tracks the agent: `working`, `idle`, `blocked` (waiting on you), `done`, or
  `dormant` (its tmux window is gone; opening it resumes it). An agent left
  idle for 12 hours goes dormant on its own, to free the memory it holds;
  Settings → dormant after changes the wait or turns it off.
- **Scribe**: a minute after an agent stops with new work, a headless
  `claude -p` (or `codex exec`, if configured) writes the character's name,
  note and links, and the island's description. A name you gave only gains a
  PR or ticket in front, and a note you wrote stays. An agent that keeps
  working gets a pass about every ten minutes too. Passes start at most once a
  minute, so a busy fleet can run up to 60 an hour. Each pass uses the chosen
  CLI's login, which costs money on an API key. A new fleet asks before
  turning it on, and you can turn it off in settings.

## The desktop app

- **Map**: double-click a card to open its terminal; Cmd+Enter switches
  between half and full size. Drag cards between islands, or onto water to make
  a new island. Drag an island's label to move it and its corner to resize it.
  On mission control, `arrange` packs the fleet into the window,
  `+ New island` and `+ New character` add an island or a crew member, and the
  other buttons start a helper agent with a prompt, which spends your Claude
  usage. `update info` also runs the scribe over every character; while the
  scribe is off, its agent says so and stops.
- **Board** (Cmd+M): islands as a folder tree, with the selected character's
  terminal beside it and its island's characters as tabs. Drag a character
  onto an island to move it, or onto another character to swap them.
- **Side card** (Cmd+I): the character's note, agent profile and
  instructions, context, docs, last prompts, model, directory and context
  use. Links open in the character's browser or your default one.
- **Browser** (Cmd+2; Cmd+B puts it beside the terminal on the board): tabs
  survive a relaunch, and the agent can read them. You sign in once per fleet:
  import Chrome's cookies once (macOS asks first), or fill logins from
  1Password (Cmd+Shift+P; needs the 1Password CLI with its app integration).
- **Files** (Cmd+3): an editor for the character's directory, with Cmd+S to
  save and Cmd+F to find and replace. If the agent rewrites a file you haven't
  changed, it reloads. Create, rename and delete files in the terminal.
- **Changes** (Cmd+4): each file's diff against HEAD, or against the point
  where the branch left main.
- **Resources** (Cmd+Shift+R, or the lighthouse islet): what `~/.claude`,
  `~/.codex`, this fleet's docs and each repository give your agents, each
  opening in an editor.
  `~/.claude.json` and `~/.codex/auth.json` hold tokens and are never opened.
- **Settings** (Cmd+,): zoom, terminal opacity, scribe, notifications, phone,
  browser and keyboard. `Usage`, next to it, shows your Claude plan's session
  and weekly limits without using any.

### Keyboard

Terminals are Ghostty surfaces and read `~/.config/ghostty/config`. The app
takes the chords below and passes everything else to the terminal. Rebind or
clear any of them under *The keyboard* in settings. A chord your Ghostty config
binds stays with Ghostty until you claim it there.

| Keys | Action | Keys | Action |
| --- | --- | --- | --- |
| Cmd+T | New character | Cmd+W | Close it (asks first) |
| Cmd+J | Next character | Cmd+K | Previous character |
| Cmd+Shift+J | Next island | Cmd+M | Map or board |
| Cmd+I | Side card | Cmd+Enter | Card size |
| Cmd+1 to 4 | Terminal, browser, files, changes | Cmd+B | Browser beside the terminal |
| Cmd+L | Address bar | Cmd+G | Mission control |
| Cmd+Shift+R | Resources | Cmd+Shift+P | Fill a login from 1Password |
| Cmd+, | Settings | Cmd+- / = / 0 | Zoom |
| Cmd+Shift+A | Arrange the fleet | Cmd+U | First link beside the terminal |

Ctrl+click opens a link in the character's browser. Selecting text copies it.
A browser tab you're typing in keeps Cmd+B, Cmd+I, Cmd+U, Cmd+K and Cmd+Enter
for the site. Each terminal attaches to its character's tmux session, so your
Ghostty `initial-command` and `input` are ignored.

## The `archi` CLI

    archi status                                  # every island and character
    archi island create feature
    archi char new --island feature --cwd ~/repo --claude
    archi char run <id> "review the failing tests in src/api"
    archi char wait <id> --until done,blocked     # exits 0 on a match, 2 on timeout, 3 when gone
    archi char read <id> --transcript --lines 20
    archi char revive <id>                        # a dormant character, resumed
    archi char show <id>                          # everything, and the brief its agent gets

- A name works wherever an id does. `--json` prints machine-readable output,
  `-p <fleet>` targets another fleet, and `--term 2` a split character's second
  terminal.
- `--instructions` on an island or character is for the agent only, such as
  "merge without asking".
- `--agent-profile <name>` on a character gives its agent a role: one of the
  `.md` files in the fleet's `agent-profiles` folder. Six ship with a new fleet
  (architect, debugger, explorer, planner, reviewer, verifier); Resources lists
  them under the fleet, where you edit them or write your own.
- `--context "<url or path>[ label]"` attaches links, files or folders, and
  `--pin` marks one to read first.
- `archi <command> --help` lists the rest.

## Phone

    archi mobile          # serve over Tailscale and print a QR (also a switch in settings)
    archi mobile off

- Open the link (`https://<mac>.<tailnet>.ts.net`) on your phone, then choose
  Share → Add to Home Screen. You get every island and character as a list,
  and a character's terminal full screen with Esc, Tab, Ctrl-C and arrow keys
  above the keyboard.
- `⚙` → *Notify this phone* sends a push when an agent is blocked or done. Tap
  a blocked one to approve or deny it.
- The tailnet needs MagicDNS and HTTPS certificates, both turned on in
  Tailscale's admin console. The certificate puts the Mac's tailnet name in a
  public log.
- Tailscale gives the page a trusted certificate and vouches for who connects,
  so no token reaches the phone. Only your own tailnet login gets in. To let
  others in, list their logins and yours in `mobile.logins` and restart the
  daemon.
- Each fleet is its own Home Screen app: the private fleet on port 443 and the
  next on 8443. A third fleet needs `mobile.httpsPort: 10000`.

## Configuration

A fleet keeps everything in its home: `~/.archipelago` for the private fleet
and `~/.archipelago-<name>` for the others, unless `ARCHI_HOME` says otherwise.
Its `config.json` takes:

| Key | What it does |
| --- | --- |
| `port`, `host` | Where the daemon listens, `47800` on `127.0.0.1` by default. Any address off loopback sends the API token in plain text. |
| `defaultCwd` | Where a new character starts when no character beside it gives it a directory (default `~`). |
| `shell` | The shell a terminal runs, if not your login shell. |
| `linear` | `{ "workspace": "acme", "teamKeys": ["ENG"] }` links a branch named after a Linear issue to that issue. |
| `home` | Mission control: `cwd` for its crew, the `command` that starts an agent (default `claude --model sonnet`), and `actions`, one `{ "label", "prompt" }` per button. |
| `scribe` | `model` (default `sonnet`), and `"agent": "codex"` to run the scribe on your Codex plan instead. |
| `mobile` | `logins` to let in (only yours when empty), extra page `origins` allowed to open a socket, a `pushContact` (https: or mailto:) for push services, and `httpsPort`. |

- The daemon reads `config.json` when it starts.
  `launchctl kickstart -k gui/$(id -u)/io.github.linusroxbergh.archipelago.archid`
  restarts the private fleet's daemon; use
  `io.github.linusroxbergh.archipelago.archid.<name>` for another fleet. While
  the file doesn't parse, the daemon logs why and waits for it to change;
  `archi doctor` shows the error too.
- Mission control's folder (default `~/.archipelago/home`, shared by every
  fleet) holds its instructions in `.claude/rules/archipelago.md` and the
  `archi-*` skills its buttons call. `archi-organise` and `archi-rename` have
  no button: list them in `home.actions` beside the two defaults
  (`/archi-update-info` and `/archi-status`) to get one. Every daemon start
  refreshes the instructions and skills. Its
  `CLAUDE.md`, for your own rules, and `.claude/settings.json` are yours to
  edit. Only `archi setup` replaces an edited settings file, and it keeps a
  `.bak-*` copy.
- The daemon runs under launchd, without your shell's environment. The
  fleet's `.env` gives the Claude scribe every value in it, and gives **new**
  character shells only `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. Keep the
  file private (`chmod 600`); see [Using API keys](#using-api-keys).

### Codex

A character running `codex`, typed in or started with
`archi char new --agent codex`, gets the same status, context gauge, revive,
brief and scribe as Claude Code.

- Setup writes Archipelago's hook into `~/.codex/hooks.json` whenever
  `~/.codex` exists, but Codex runs only hooks you trust. Start `codex`, type
  `/hooks` and trust it, and do so again whenever it changes. Until then the
  character stays a plain shell with a warning.
- Codex needs its CLI on PATH; the Codex desktop app alone doesn't put it
  there.

## What setup changes

`pnpm desktop:install` runs `archi setup`, which you can also run on its own
without the app (`--check` only checks). It changes nothing while something it
needs is missing. It writes:

- `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`): a hook on
  Claude Code's session, prompt, tool, notification and stop events, which
  exits before starting Node outside a character, and a statusline wrapper
  that keeps your own statusline running inside it. Every change keeps a
  `.bak-<time>` copy.
- `~/.codex/hooks.json`, when Codex is installed: the same hook and backup.
- `~/Library/LaunchAgents/io.github.linusroxbergh.archipelago.archid*.plist`,
  one per fleet, which keeps each daemon running.
- `~/.local/bin/archi` and `archipelago`: shims into the clone.
- `~/.archipelago` and `~/.archipelago-<name>`: each fleet's state, config,
  log, hook scripts, tmux.conf and tmux server, plus, in `~/.archipelago/home`,
  the mission control folder they share.
- `/Applications/Archipelago.app`, from `pnpm desktop:install`.

On a Mac set up under the older `com.archipelago` ids, setup first quits the
app and moves each fleet's launchd agent, and the app's sign-ins, caches and
preferences, to the ids above. macOS then asks again before it shows
notifications. Sign-ins the new id already has, from a build run before the
update, are never merged: setup leaves both folders, and `archi setup --check`
names them.

### Uninstall

    archi uninstall

This quits the app, removes the hooks (your own statusline stays), the launchd
agents, the shims and each fleet's phone link, and stops the fleets' tmux
servers so no agent keeps running out of sight. It then asks before deleting
the fleet homes, the app, and its sign-ins, caches and preferences in `~/Library`;
`--purge` deletes them without asking. The clone and the settings backups
stay.

Run it before you delete the clone: the launchd agents and `archi` point into
it, and launchd would otherwise restart the missing daemon every ten seconds.

## What leaves your Mac

Archipelago has no telemetry, analytics or crash reporting. The main ways data
leaves the Mac, beyond what your agents send:

- The scribe sends the end of each agent's transcript to Claude (or Codex) on
  your login or API key, with what the map shows of the character and its
  island: names, notes, links, directories and branches.
- Mission control's buttons start Claude agents, and the Usage panel asks
  Claude Code for your plan's limits. The Claude scribe and the Usage panel run
  with every value in the fleet's `.env` in their environment.
- For each character in a repository, the daemon runs `gh pr view` to find its
  branch's PR on GitHub.
- `archi mobile` serves the fleet to your tailnet with `tailscale serve`.
- Push notifications go through your phone's push service: Apple's, Google's
  or Mozilla's. The character's name and prompt are encrypted for your phone;
  the service sees when a push is sent, and the page's address
  (`https://<mac>.<tailnet>.ts.net`) unless `mobile.pushContact` names another
  contact.

Importing Chrome's cookies sends nothing anywhere, but it copies the profile's
sign-ins into the fleet's browser on this Mac, so every site the profile is
signed in to is signed in there too.

## How it works

- Each fleet runs one private tmux server with a window per character. The
  daemon drives it over a single control-mode client and is the only writer of
  the fleet's `state.json`.
- Clients talk to the daemon over one loopback WebSocket: a full snapshot,
  then JSON-patch events. The app and the CLI present a token; the phone comes
  through `tailscale serve`, which vouches for its login.
- Agent status comes from hooks writing to the fleet's `hooks.sock`, and
  Claude Code's context use and model come from its statusline. Both do
  nothing without the `ARCHI_CHAR_ID` a character sets, so `claude` run
  elsewhere is unaffected.
- On start, the daemon matches `state.json` against the live tmux windows.
  Characters whose window is gone turn dormant, ready to revive.

## Development

    pnpm test            # needs tmux on PATH for the integration tests
    pnpm typecheck
    pnpm e2e             # Playwright against a temporary daemon
    pnpm desktop:dev     # Vite dev server plus a debug app; ARCHI_HOME picks the daemon
    pnpm desktop:build   # an unsigned apps/desktop/mac/build/Archipelago.app
    pnpm ghostty:build   # GhosttyKit from vendor/ghostty (v1.3.1) into vendor/ghostty-kit
    pnpm ghostty:publish # build GhosttyKit and upload it for installs to download
    mkdir -p /tmp/archi-dev && echo '{ "port": 0 }' > /tmp/archi-dev/config.json
    ARCHI_HOME=/tmp/archi-dev pnpm archid   # port 0 keeps it off the private fleet's 47800

The first `pnpm e2e` needs
`pnpm --filter @archipelago/desktop-web exec playwright install chromium`.

`pnpm ghostty:publish` builds GhosttyKit for the Ghostty commit HEAD records
and uploads it to the `ghostty-kit` release, where `pnpm desktop:install`
downloads it. Publish after committing a `vendor/ghostty` bump, or installs of
that commit need Xcode; until the bump is committed, `pnpm desktop:install`
keeps the kit `pnpm ghostty:build` made from it. When a change to
`scripts/ghostty-build.sh` changes what it builds, also bump `REV` in
`scripts/ghostty-kit.sh` before publishing, so existing checkouts replace their
kit. It needs the Metal toolchain and zig.

- `packages/protocol`: state types and message schemas (zod).
- `packages/archid`: the daemon (tmux, state, hooks, transcripts, API).
- `packages/cli`: the `archi` client.
- `apps/desktop`: a Swift/AppKit shell hosting a React app in a WKWebView with
  libghostty terminals; `web/src/mobile` is the phone view over the same store.
- TypeScript on Node 24, pnpm workspaces, vitest.

## License

The code is MIT (`LICENSE`). The animal portraits in
`apps/desktop/web/public/animals` and the lighthouse in
`apps/desktop/web/public/resources` are Flaticon icons by Magnific under a
Flaticon Premium licence, not MIT, and may not be redistributed: don't copy
them out of this repository (see the `LICENSE` in each folder). The fonts in
`apps/desktop/web/public/fonts` are SIL OFL 1.1 (`OFL.txt`), and Ghostty is
MIT under its own notice (`apps/desktop/mac/LICENSE.ghostty`).
