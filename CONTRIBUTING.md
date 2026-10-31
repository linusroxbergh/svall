# Contributing

Open an issue before a large change, so the work is not wasted. Keep a pull
request to one change, with a test where the code has them. `pnpm test` and
`pnpm typecheck` must pass.

By contributing you agree that your contribution is licensed under
GPL-3.0-or-later, like the rest of Svall. There is no CLA to sign.

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
   [Quickstart](README.md#quickstart). While no release is installed, Svall Dev
   also installs `svall`.

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
    brew install zig@0.17

The first build takes several minutes and about 1.5 GB of disk.

## Development

    pnpm test            # needs tmux and swiftc (the Command Line Tools) on PATH
    pnpm typecheck
    swift test --package-path apps/desktop/mac   # the app's Swift tests, once a build has linked GhosttyKit
    pnpm e2e             # Playwright against a temporary daemon
    pnpm desktop:dev     # Vite dev server plus a debug app; SVALL_HOME picks the daemon, unless it names a release fleet
    pnpm desktop:build   # an ad-hoc signed apps/desktop/mac/build.noindex/Svall Dev.app
    pnpm app:build       # apps/desktop/mac/build.noindex/Svall.app, with its own node, tmux, daemon and CLI; the first needs docker, for the Linux companions' tmux
    pnpm ghostty:build   # GhosttyKit from vendor/ghostty into vendor/ghostty-kit
    pnpm ghostty:publish # build GhosttyKit and upload it for installs to download
    mkdir -p /tmp/svall-dev && echo '{ "port": 0 }' > /tmp/svall-dev/node.json
    SVALL_HOME=/tmp/svall-dev pnpm svalld   # port 0 keeps it off the private fleets' 47800 and 47900

The first `pnpm e2e` needs
`pnpm --filter @svall/desktop-web exec playwright install chromium`.

On macOS, tests that start tmux servers (the `svalld-tmux` and `cli-tmux`
projects, `pnpm e2e`) can hang the tty layer until a reboot, so `pnpm test`
leaves them out and `pnpm e2e` refuses. `SVALL_TMUX_ON_MAC=1` runs them, one run
at a time across worktrees, once the 1-minute load is at most the core count;
`SVALL_NO_TEST_LOCK=1` skips that lock and wait.

`pnpm test:linux [<vitest args>]` runs `svalld-tmux` and `cli-tmux`, or what the
args name, in a Linux container with the release's tmux 3.7c, testing the
checkout it runs from read-only. It keeps each checkout's Linux node_modules in
docker volumes it names as it starts; this removes them all:

    docker volume ls -q --filter name=svall-test-linux- | xargs docker volume rm

- `packages/protocol`: state types and message schemas (zod).
- `packages/svalld`: the daemon (tmux, state, hooks, transcripts, API).
- `packages/cli`: the `svall` client.
- `apps/desktop`: a Swift/AppKit shell hosting a React app in a WKWebView with
  libghostty terminals; `web/src/mobile` is the phone view over the same store.
- TypeScript on Node 24, pnpm workspaces, vitest.

[docs/integration.md](docs/integration.md) covers the runs on real machines and
the release pipeline.

## How it works

- A daemon, `svalld`, runs each fleet while its window is open. It owns one
  private tmux server holding every robot's terminals, follows their output
  over a single control-mode client and is the only writer of the fleet's
  `state.json`.
- The app, the CLI and the phone talk to the daemon over one loopback
  WebSocket: a full snapshot, then JSON-patch events. The app and the CLI
  present a token; the phone comes through `tailscale serve`, which vouches for
  its login, and holds the pass the QR code gave it in a cookie.
- Agent status comes from hooks writing to the fleet's `hooks.sock`, and
  Claude Code's context use and model come from its statusline. Both do
  nothing without the `SVALL_ROBOT_ID` a robot sets, so `claude` run
  elsewhere is unaffected.
- On start, the daemon matches `state.json` against the live tmux windows.
  Robots whose window is gone turn dormant, ready to revive.
