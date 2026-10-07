# Svall

> [!NOTE]
> **Alpha**: early and changing fast. Expect rough edges.

A macOS map of your Claude Code, Codex and OpenCode agents. Every terminal is a
character on an island, so you can see at a glance which agents are working,
waiting on you or done.

![The map: islands of characters, the islands panel on the left and a character's side card on the right](assets/svall_overview.jpg)

- Islands group your characters, say one per project, on a map or a board.
  Each card shows its agent's status, context use, model and links such as its
  PR and ticket.
- Each terminal is a tmux window. Quitting a fleet's window stops its
  terminals; opening a character again resumes its session with
  `claude --resume`, `codex resume` or `opencode -s`.
- Give an island or character instructions, links, files or folders, and
  agents leave notes for the next agent. Each session starts with a short brief
  of all of it, plus its repository, PR and ticket, and gets
  a diff when any of it changes. The brief also tells the agent when to hand
  work to a new character.
- Resources lists the instructions, skills, subagents, commands, MCP servers,
  plugins, hooks and settings that Claude Code and Codex give your agents, and
  opens each in an editor.
- Every terminal has a browser, a file editor and the working tree's changes
  beside it.
- The scribe names each character and keeps its note up to date.
- Mission control's buttons start a helper agent that updates or reports on
  the fleet.
- A macOS banner tells you when an agent is blocked or done. A blocked one has
  Approve and Deny on it.
- Your phone gets the fleet and any terminal over Tailscale, with push
  notifications.
- The `svall` CLI scripts the fleet: make characters, send prompts, wait for
  them.

## Quickstart

You need an Apple Silicon Mac on macOS 15 or newer, and the Claude Code CLI,
the Codex CLI or OpenCode. The Claude and Codex desktop apps don't install the
CLIs.

1. Install the [Claude Code CLI](https://code.claude.com/docs/en/setup), which
   works with a Claude subscription or an Anthropic API key, or the
   [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) 0.155 or newer, which
   works with an OpenAI API key alone, or [OpenCode](https://opencode.ai/docs/)
   2.0.22 or newer, which runs on OpenCode Zen's free models without an account
   or on any provider you sign in to. See [Using API keys](#using-api-keys).

2. Download Svall from [svall.dev](https://svall.dev) and drag `Svall.app` to
   Applications, or run:

       curl -fsSL https://svall.dev/install.sh | sh

   The script installs to `/Applications`, or `~/Applications` when that isn't
   writable, or `$SVALL_INSTALL_DIR`. It checks the download's checksum,
   developer signature and Apple notarization, then opens the app.

3. Open Svall. The setup screen lists the agents it found and asks for your
   projects folder. **Review changes** lists the files it will write. If it
   finds neither CLI, it shows how to install one and checks again when you
   return. Its hooks do nothing outside Svall;
   [What setup changes](#what-setup-changes) has the details. If
   `~/.local/bin` isn't on your PATH, it shows the line to add to your shell
   profile so the `svall` command works.

4. `+ New island` on the sandbar at the bottom makes an island, and Cmd+T makes
   a character on it: a shell that becomes an agent when you type `claude`,
   `codex` or `opencode`. With more than one CLI installed, the app asks which
   one the scribe and mission control run. Change it later in Settings or with
   `svall agent codex`.

## Using Svall

### Using API keys

Svall has no AI account or billing of its own. The provider whose key you use
bills the calls.

For Claude Code, put an
[Anthropic API key](https://console.anthropic.com/settings/keys) in the private
fleet's `.env` (another fleet's is `~/.svall-<fleet>/.env`):

    mkdir -p ~/.svall
    touch ~/.svall/.env
    chmod 600 ~/.svall/.env
    nano ~/.svall/.env

Add `ANTHROPIC_API_KEY=your-key` on its own line, and keep the key out of this
repository and your shell history. New character shells and the Claude scribe
read it, and it signs Claude Code in; `svall doctor` shows whether it did. A
shell that is already running keeps its old environment, so after changing the
file, create a new character or revive a dormant one. Claude Code may ask once
before it uses the key; see its
[environment variable reference](https://code.claude.com/docs/en/env-vars).

For Codex, sign the CLI in with an
[OpenAI API key](https://platform.openai.com/api-keys) before you start a Codex
character. With `OPENAI_API_KEY` set in your normal terminal, run:

    printenv OPENAI_API_KEY | codex login --with-api-key
    codex login status

An `OPENAI_API_KEY` in the fleet's `.env` reaches new character shells, but
Codex doesn't log in from it. See the
[Codex authentication guide](https://learn.chatgpt.com/docs/auth).

For OpenCode, sign in to a provider with `opencode auth login`, or set the
provider's key (such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) in the fleet's
`.env`. OpenCode reads both.

The scribe and mission control run the main agent's CLI, so a Codex-only
install needs no Claude login. The Usage panel shows Claude and Codex plan
limits, not API spending.

### Updating

Svall checks for updates on its own. When one is out, the private fleet's window
shows a blue dot on the sidebar's Settings button, and Settings ends with an
Update button. In that window, Svall → Check for Updates… checks now. Installing
quits every Svall window, which stops each fleet; a character picks up where it
left off when you open it.

### Uninstalling

Svall → Uninstall Svall… stops every fleet and its tmux server, removes the
hooks (your own statusline stays), the launchd agents, the `svall` command and
each fleet's phone link, and moves the app to the Trash. The settings backups
stay. With "Also delete fleet data" ticked, it deletes `~/.svall`, the other
fleets' homes and the app's preferences, sign-ins and caches in `~/Library` too.

`svall uninstall` does the same from a terminal, but deletes the app instead of
moving it to the Trash, and asks before deleting it or the fleets. `--purge`
deletes them without asking.

### When something breaks

Run `svall doctor`. It checks what the fleet needs and prints the end of the
daemon's log, `~/.svall/svalld.log`. Send its output, and what you were doing,
as an issue on
[linusroxbergh/svall](https://github.com/linusroxbergh/svall/issues).

If a new character's terminal takes seconds to show its prompt, zsh is usually
rebuilding its completion cache. Homebrew's `brew shellenv` exports `FPATH`, so
shells that Claude Code starts rewrite `~/.zcompdump`. Add this line to the end
of `~/.zshrc`:

```zsh
typeset +x FPATH
```

### Migrating from Herdr

Ask your agent to move your Herdr workspaces into Svall. Each workspace becomes
an island, and each Claude, Codex or OpenCode pane a character in the same
directory. `herdr --skill` and `svall <command> --help` tell it how.

## Build from source (Svall Dev)

A checkout builds `Svall Dev.app`, which runs beside the release without
touching its fleets: it uses `~/.svall-dev`, the `svall-dev` command and port
47900. It needs macOS 15.6 or newer and the Command Line Tools for Xcode 26 or
newer. An Intel Mac also needs Xcode; see
[Building Ghostty from source](#building-ghostty-from-source).

1. Install the tools, and the Claude Code CLI, the Codex CLI or OpenCode:

       brew install node tmux pnpm gh   # skip node if you have 24 or newer
       gh auth login                    # resolves PR links

   If `xcrun --show-sdk-version` prints a version below 26, update the Command
   Line Tools in System Settings → General → Software Update. pnpm must be 12
   or newer.

2. Clone and install:

       git clone https://github.com/linusroxbergh/svall && cd svall
       pnpm desktop:install

   The installer lists anything missing before it builds. Without admin rights,
   run this instead:

       mkdir -p ~/Applications && SVALL_APP_DEST=~/Applications pnpm desktop:install

   If your shell can't find `svall-dev` afterwards, add `~/.local/bin` to your
   PATH:

       echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # then open a new terminal

3. Run `svall-dev`, or open Svall Dev from Spotlight, and use it as in the
   Quickstart. While no release is installed, Svall Dev also installs `svall`.

`svall-dev` and the daemon run from the clone, so run `pnpm desktop:install`
again after moving it. Run `svall-dev uninstall` before you delete the clone, or
its hooks, command and launchd agents stay behind.

### Updating Svall Dev

    git pull && pnpm desktop:install

If pnpm fails to switch versions, update it to 12 or newer the way you
installed it. If Node is unsupported, run `brew upgrade node`.

### Building Ghostty from source

The installer downloads GhosttyKit, the terminal engine, prebuilt. It builds it
from source instead on an Intel Mac, or when no build of the Ghostty version
this checkout records has been published and pinned. That needs Xcode 26 or
newer from the App Store. Open Xcode once to accept its license, then run:

    sudo xcode-select -s /Applications/Xcode.app
    xcodebuild -downloadComponent MetalToolchain
    brew install zig@0.15

The first build takes several minutes and about 1.5 GB of disk.

## Concepts

- **Fleet**: one daemon, one tmux server, one window. `svall` opens the
  private fleet, and `svall work` opens a separate fleet named `work`, offering
  to create it the first time. File → Open Fleet… (Cmd+Shift+O) does the same
  from the app, and Settings renames a fleet.
- **Island**: a group of characters. Mission control is the fixed one at the
  bottom.
- **Character**: one terminal. Type `claude`, `codex` or `opencode` in it and
  the map tracks the agent: `working`, `idle`, `blocked` (waiting on you) or
  `done`. An agent idle or done for 12 hours is closed to free its memory and
  resumes when you open its terminal; Settings → close idle agents after
  changes the wait or turns it off.
- **Scribe**: a minute after an agent stops with new work, and about every ten
  minutes while it keeps working, a headless `claude -p`, `codex exec` or
  `opencode run` writes the character's name, note and links, and the island's
  description. Notes you wrote stay, and a name you gave only gains a PR or
  ticket id. Passes start at most once a minute, so a busy fleet can run 60 an
  hour, and each costs money on an API key. A new fleet asks before turning the
  scribe on, and you can turn it off in Settings.

## The desktop app

- **Map**: double-click a card to open its terminal; Cmd+Enter switches
  between half and full size. Drag cards between islands, onto another card to
  swap them, or onto water to make a new island. Drag an island's label to move
  it and its corner to resize it. On mission control, `arrange` packs the fleet
  into the window, and `update info` and `status` start a helper agent.
- **Board** (Cmd+M): islands as a folder tree, with the selected character's
  terminal beside it. Drag characters and islands to move or reorder them.
  A starred character also stands in Starred at the top, newest first; drag
  there to star one at a spot or to reorder.
- **Side card** (Cmd+I): the character's note, agent profile, instructions,
  context, docs, last prompts, model, directory and context use.
- **Browser** (Cmd+2): tabs survive a relaunch, and the agent sees their
  addresses. Sign in once per fleet by importing Chrome's cookies, or fill
  logins from 1Password with Cmd+Shift+P once you turn it on in Settings and
  install the 1Password CLI.
- **Files** (Cmd+3): an editor for the character's directory. A file the agent
  rewrites reloads unless you have changed it.
- **Changes** (Cmd+4): each file's diff against HEAD, or against the point
  where the branch left main.
- **Resources** (Cmd+Shift+R, or the lighthouse islet): what `~/.claude`,
  `~/.codex`, the fleet's docs and each repository give your agents.
  `~/.claude.json` and `~/.codex/auth.json` hold tokens and never open.
- **Settings** (Cmd+,): display, browser, keyboard, notifications, phone, and
  the fleet's name, main agent, scribe and idle timeout. `Usage`, next to it,
  shows the plan limits of your running agents without using any.

### Keyboard

Terminals are Ghostty surfaces and read your Ghostty config. The app takes the
chords below and passes everything else to the terminal. Rebind or clear any of
them under *The keyboard* in Settings. A chord your Ghostty config binds when
Svall first launches stays with Ghostty until you claim it there.

| Keys | Action | Keys | Action |
| --- | --- | --- | --- |
| Cmd+T | New character | Cmd+W | Close the card or character |
| Cmd+J | Next character | Cmd+K | Previous character |
| Cmd+Shift+J | Next island | Cmd+M | Map or board |
| Cmd+I | Side card | Cmd+Enter | Card size |
| Cmd+1 to 4 | Terminal, browser, files, changes | Cmd+B | Browser beside the terminal |
| Cmd+L | Address bar | Cmd+G | Prompt mission control |
| Cmd+Shift+R | Resources | Cmd+Shift+P | Fill a login from 1Password |
| Cmd+, | Settings | Cmd+- / = / 0 | Zoom |
| Cmd+Shift+A | Arrange the fleet | Cmd+U | First link beside the terminal |
| Cmd+Shift+O | Open a fleet | Cmd+Q | Quit |

Ctrl+click on a link asks whether to open it in the character's browser or
yours, and selecting text copies it. Terminals attach to tmux, so Ghostty's
`initial-command` and `input` are ignored.

## The `svall` CLI

    svall status                                  # every island and character
    svall island create feature
    svall char new --island feature --cwd ~/repo --claude
    svall char run <id> "review the failing tests in src/api"
    svall char wait <id> --until done,blocked     # exits 0 on a match, 2 on timeout, 3 when gone
    svall char read <id> --transcript --lines 20
    svall char revive <id>                        # a dormant character, resumed
    svall char show <id>                          # the brief its agent gets

- A name works wherever an id does. `--json` prints machine-readable output,
  `-p <fleet>` targets another fleet, and `--term 2` a split character's second
  terminal.
- `island create`, `island update` and `char update` take `--instructions`,
  for the agent only, such as "merge without asking", and
  `--context "<url or ~/path>[ label]"`, which sets the links, files or folders
  it gets; `--pin <ref>` marks one to read first.
- `--agent-profile <name>` gives a character's agent a role from the fleet's
  `agent-profiles` folder. Six ship with a new fleet (architect, debugger,
  explorer, planner, reviewer, verifier); edit them or add your own in
  Resources.
- `svall <command> --help` lists the rest.

## Phone

    svall mobile          # serve over Tailscale and print a QR (also a switch in settings)
    svall mobile off

- Open the link on your phone, then choose Share → Add to Home Screen. You get
  every island and character as a list, the starred ones also first, and a
  character's terminal full screen with Esc, Tab, Ctrl-C and arrow keys above
  the keyboard.
- `⚙` → *Notify this phone* sends a push when an agent is blocked or done. Tap
  a blocked one to approve or deny it.
- The page and its pushes work while Svall is open on that fleet, since its
  daemon serves them.
- The tailnet needs MagicDNS and HTTPS certificates turned on in Tailscale's
  admin console. The certificate puts the Mac's tailnet name in a public log.
- Only your own tailnet login gets in, and no token reaches the phone. To let
  others in, list their logins and yours in `mobile.logins` and restart the
  daemon.
- Each fleet is its own Home Screen app on its own port: 443 for the private
  fleet, and for each other fleet the first free port from 8443 up, which the
  private fleet takes too while something else serves 443. The port is kept in
  `mobile.httpsPort`; if something else serves a kept port, turning the link on
  says so.

## Configuration

A fleet keeps everything in its home: `~/.svall` for the private fleet
and `~/.svall-<name>` for the others, unless `SVALL_HOME` says otherwise.
Its `config.json` takes:

| Key | What it does |
| --- | --- |
| `name` | What the window title and `svall <name>` call the fleet: lowercase letters, digits and dashes, starting with a letter, not an `svall` command, and not `dev` or `dev-…`. Absent, the directory names it. Set from Settings. |
| `port`, `host` | Where the daemon listens: `127.0.0.1`, on `47800` for the private fleet and any free port for the others. Absent, a free port stands in while another program holds `47800`; a port set here that is taken keeps the daemon from starting. Any address off loopback sends the API token in plain text. |
| `defaultCwd` | Where a new character starts when no character beside it gives it a directory (default `~`). Set by the setup screen's projects folder or `svall setup --projects`. |
| `shell` | The shell a terminal runs, if not your login shell. |
| `linear` | `{ "workspace": "acme", "teamKeys": ["ENG"] }` links a branch named after a Linear issue to that issue. |
| `mainAgent` | `claude`, `codex` or `opencode`: what the scribe, mission control's crew and `svall char new --run` run by default. Absent, the private fleet's, else `claude` when it is installed or no CLI is, else the first CLI found. Set from the app or with `svall agent <name>`. |
| `agentsOff` | The agents the private fleet's setup leaves off, writing no hooks or plugin for them. Every other agent found is on. Set by the setup screen or `svall setup --agents`. |
| `integrations` | The agents left on, of `claude` and `codex`, read when there is no `agentsOff`; `opencode` counts as on. Setup replaces it with `agentsOff`. |
| `home` | Mission control: `cwd` for its crew, the `command` that starts an agent (default the main agent's: `claude --model sonnet`, `codex` or `opencode`), and `actions`, one `{ "label", "prompt" }` per button. A button's `/name` prompt reaches a Codex crew as `$name`. |
| `scribe` | `agent` (default the main agent) and `model`, a model of `agent`'s CLI, or of Claude's when `agent` is unset (default `sonnet` for Claude, the CLI's own for Codex and OpenCode). |
| `mobile` | `logins` to let in (only yours when empty), extra page `origins` allowed to open a socket, a `pushContact` (https: or mailto:) for push services, and the `httpsPort` it is served on, which Svall saves. |

- The daemon reads `config.json` when it starts. To restart the private
  fleet's daemon, run
  `launchctl kickstart -k gui/$(id -u)/io.github.linusroxbergh.svall.svalld`,
  adding `.<name>` for another fleet. While the file doesn't parse, the daemon
  logs why and waits for it to change; `svall doctor` shows the error too.
- Mission control's folder, `~/.svall/home`, is shared by every fleet and
  rewritten on each daemon start, apart from `CLAUDE.md`, which is yours, and
  `.claude/settings.json`, which only `svall setup` resets, keeping a `.bak`
  copy. A Codex crew reads your `CLAUDE.md` through the `AGENTS.md` built from
  it. The skills behind the buttons live there too; list `/svall-organise` or
  `/svall-rename` in `home.actions` to give them a button. Claude Code and
  Codex each ask once whether to trust the folder.
- The daemon runs under launchd, without your shell's environment. The fleet's
  `.env` gives the Claude scribe every value in it, and gives new character
  shells only `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`.

### Codex

A Codex character gets the same status, context gauge, revive, brief and scribe
as a Claude Code one. Codex runs only hooks you trust: choose "Trust all and
continue" on its startup dialog, or trust the hook later with `/hooks`, and do
so again whenever it changes. Until then the character stays a plain shell with
a warning. `svall doctor` says whether the hook is trusted.

### OpenCode

An OpenCode character gets the same status, context gauge, revive, brief and
scribe as a Claude Code one. OpenCode has no hooks; Svall's plugin in
`~/.config/opencode/plugins` reports to it, needs no trust step, and does
nothing outside a character. The brief rides along as system text. OpenCode
reports no plan limits, so the Usage panel shows none for it.

## What setup changes

The setup screen runs `svall setup`, which also works without the app
(`--check` only checks). It changes nothing while something it needs is
missing. For each agent you leave on, it writes:

- `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`): a hook on
  Claude Code's session, prompt, tool, permission, notification and stop
  events, which exits before starting Node outside a character, and a
  statusline wrapper that keeps your own statusline running inside it.
- `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`): the same hook.
- `~/.config/opencode/plugins/svall.js` (or under `$XDG_CONFIG_HOME`): Svall's
  OpenCode plugin.

Every change keeps a `.bak-<time>` copy. Setup also writes:

- `~/Library/LaunchAgents/io.github.linusroxbergh.svall.svalld*.plist`, one per
  fleet, which the app uses to start each daemon.
- `~/.local/bin/svall`: a shim into `Svall.app`.
- `~/.svall` and `~/.svall-<name>`: each fleet's state, config, log, hook
  scripts and tmux server, plus the mission control folder they share.

Svall Dev writes the same under `.svall-dev`, `svall-dev` and
`io.github.linusroxbergh.svall.dev.svalld*`, and neither variant's hook acts on
the other's fleets.

## What leaves your Mac

Svall has no telemetry, analytics or crash reporting. Besides what your agents
send:

- The scribe sends the end of each agent's transcript to Claude, Codex or
  OpenCode's provider on your login or API key, with the names, notes, links,
  directories and branches of its island's characters, and the names of the
  fleet's other characters.
- Mission control's buttons start the main agent, and the Usage panel asks
  Claude Code for your plan's limits. The Claude scribe and the Usage panel get
  every value in the fleet's `.env`.
- For each character in a repository, the daemon runs `gh pr view` to find its
  branch's PR.
- `svall mobile` serves the fleet to your tailnet with `tailscale serve`.
- A character's browser starts on google.com, and `svall doctor` runs
  `gh auth status`.
- Svall checks `https://svall.dev/appcast.xml` for updates, which tells
  svall.dev your IP address and the version you run. Svall Dev doesn't.
- Push notifications go through your phone's push service: Apple's, Google's
  or Mozilla's. The character's name and prompt are encrypted for your phone;
  the service sees when a push is sent, and the page's address unless
  `mobile.pushContact` names another contact.

Importing Chrome's cookies sends nothing, but it signs the fleet's browser in
to every site the Chrome profile is signed in to.

## How it works

- A daemon, `svalld`, runs each fleet while its window is open. It owns one
  private tmux server holding every character's terminals, follows their output
  over a single control-mode client and is the only writer of the fleet's
  `state.json`.
- The app, the CLI and the phone talk to the daemon over one loopback
  WebSocket: a full snapshot, then JSON-patch events. The app and the CLI
  present a token; the phone comes through `tailscale serve`, which vouches for
  its login.
- Agent status comes from hooks writing to the fleet's `hooks.sock`, and
  Claude Code's context use and model come from its statusline. Both do
  nothing without the `SVALL_CHAR_ID` a character sets, so `claude` run
  elsewhere is unaffected.
- On start, the daemon matches `state.json` against the live tmux windows.
  Characters whose window is gone turn dormant, ready to revive.

## Development

    pnpm test            # needs tmux and swiftc (the Command Line Tools) on PATH
    pnpm typecheck
    pnpm e2e             # Playwright against a temporary daemon
    pnpm desktop:dev     # Vite dev server plus a debug app; SVALL_HOME picks the daemon, unless it names a release fleet
    pnpm desktop:build   # an ad-hoc signed apps/desktop/mac/build.noindex/Svall Dev.app
    pnpm app:build       # apps/desktop/mac/build.noindex/Svall.app, with its own node, tmux, daemon and CLI
    pnpm ghostty:build   # GhosttyKit from vendor/ghostty into vendor/ghostty-kit
    pnpm ghostty:publish # build GhosttyKit and upload it for installs to download
    mkdir -p /tmp/svall-dev && echo '{ "port": 0 }' > /tmp/svall-dev/config.json
    SVALL_HOME=/tmp/svall-dev pnpm svalld   # port 0 keeps it off the private fleets' 47800 and 47900

The first `pnpm e2e` needs
`pnpm --filter @svall/desktop-web exec playwright install chromium`.

- `packages/protocol`: state types and message schemas (zod).
- `packages/svalld`: the daemon (tmux, state, hooks, transcripts, API).
- `packages/cli`: the `svall` client.
- `apps/desktop`: a Swift/AppKit shell hosting a React app in a WKWebView with
  libghostty terminals; `web/src/mobile` is the phone view over the same store.
- TypeScript on Node 24, pnpm workspaces, vitest.

## License

MIT, see [`LICENSE`](LICENSE). The animal portraits, the lighthouse icon and
the fonts are not MIT: each folder has its own licence file.
