# Configuration

A fleet keeps everything in its home: `~/.svall` for the private fleet
and `~/.svall-<name>` for the others, unless `SVALL_HOME` says otherwise.
Its `fleet.json` holds the fleet's own settings, and `node.json` what
belongs to this machine alone:

| Key | File | What it does |
| --- | --- | --- |
| `name` | `fleet.json` | What the window title and `svall <name>` call the fleet: lowercase letters, digits and dashes, starting with a letter, not an `svall` command, and not `dev` or `dev-…`. Absent, the directory names it. Set from Settings. |
| `port`, `host` | `node.json` | Where the daemon listens: `127.0.0.1`, on `47800` for the private fleet and any free port for the others. Absent, a free port stands in while another program holds `47800`; a port set here that is taken keeps the daemon from starting. Any address off loopback sends the API token in plain text. |
| `defaultCwd` | `fleet.json` | Where a new robot starts when no robot beside it gives it a directory (default `~`). Set by the setup screen's projects folder or `svall setup --projects`. |
| `shell` | `node.json` | The shell a terminal runs, if not your login shell. |
| `linear` | `fleet.json` | `{ "workspace": "acme", "teamKeys": ["ENG"] }` links a branch named after a Linear issue to that issue. |
| `mainAgent` | `fleet.json` | `claude`, `codex` or `opencode`: what the scribe, mission control's crew and `svall robot new --run` run by default. Absent, the private fleet's, else `claude` when it is installed or no CLI is, else the first CLI found. Set from the app or with `svall agent <name>`. |
| `agentsOff` | `node.json` | The agents the private fleet's setup leaves off, writing no hooks or plugin for them. Every other agent found is on. Set by the setup screen or `svall setup --agents`. |
| `integrations` | `node.json` | The agents left on, of `claude` and `codex`, read when there is no `agentsOff`; `opencode` counts as on. Setup replaces it with `agentsOff`. |
| `home` | `fleet.json` | Mission control: `cwd` for its crew (`~/.svall/home` unless set; a new profile fleet in `~/.svall-<name>` gets `~/.svall-<name>/home` here), the `command` that starts an agent (default the main agent's: `claude --model opus`, `codex` or `opencode`), `model`, a model for each CLI, as `{ "claude": "sonnet" }` (default `opus` for Claude, Codex's own; OpenCode's TUI takes none; set in Settings), and `actions`, one `{ "label", "prompt" }` per button. A button's `/name` prompt reaches a Codex crew as `$name`. `offered` names the buttons Svall has added once, with their rules in the crew's settings, so one you delete stays deleted. |
| `scribe` | `fleet.json` | `agent` (default the main agent) and `model`, a model for each CLI as in `home`, or one model of `agent`'s CLI, or of Claude's when `agent` is unset (default `haiku` for Claude, `gpt-6-luna` at low effort for Codex, the CLI's own for OpenCode; set in Settings, OpenCode's only here). |
| `retro` | `fleet.json` | What a retro leaves out (`exclude.repos` by path, `exclude.islands` by id or name), the `unrecorded` repos whose sessions no fleet recorded it reads too, the `model` it reads, judges and verifies with on each CLI, and the `reviewSkills` it reads as reviews. Set with `svall retro config`. |
| `mobile` | `fleet.json` | `logins` to let in (only yours when empty), extra page `origins` allowed to open a socket, and a `pushContact` (https: or mailto:) for push services. |
| `mobile.httpsPort` | `node.json` | The tailscale serve port this fleet is reached on, which Svall saves: 443 for the private fleet, and for each other fleet the first free port from 8443 up, which the private fleet takes too while something else serves 443. If something else serves a kept port, turning the phone link on says so. |

- The daemon reads both files when it starts. To restart the private
  fleet's daemon, run
  `launchctl kickstart -k gui/$(id -u)/io.github.linusroxbergh.svall.svalld`,
  adding `.<name>` for another fleet. While either file doesn't parse, the daemon
  logs why and waits for it to change; `svall doctor` shows the error too.
- Mission control's folder, `home.cwd`, is rewritten on each daemon start from
  that fleet's release, apart from `CLAUDE.md`, which is yours, and
  `.claude/settings.json`, which only `svall setup` resets, in the private
  fleet's folder, keeping a `.bak` copy. A Codex crew reads your `CLAUDE.md`
  through the `AGENTS.md` built from it. The skills behind the buttons live
  there too; list `/svall-organise` or `/svall-rename` in `home.actions` to give
  them a button. Claude Code and Codex each ask once whether to trust the
  folder. Fleets whose `fleet.json` names no `home.cwd` share `~/.svall/home`,
  and a fleet that shares its folder cannot be handed over: set `home.cwd` in
  one's `fleet.json` to give it its own, such as `~/.svall-work/home` for the
  fleet in `~/.svall-work`. Its crew already open keeps working in the old
  folder, so copy over any notes you want in the new one.
- The daemon runs under launchd, without your shell's environment. The fleet's
  `.env` gives the Claude scribe every value in it, and gives new robot
  shells only `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`.
