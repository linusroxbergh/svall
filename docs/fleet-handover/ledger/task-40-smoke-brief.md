# Task 40b — on-machine smoke of the rebased build (brief)

W = `docs/fleet-handover/ledger` in the worktree
`/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl` (branch
`experimental-remote-sessions`, HEAD at dispatch). Spec: `docs/fleet-handover/spec.md` (binding). Paths inside the
older ledger files point at `.superpowers/sdd/2026-09-20-fleet-handover/`, which is now W.

Goal (plan Task 40): one Mac→Linux→Mac round trip with mocked agents and one real Codex session on the rebased
build. The M3 on-machine passes ran before the squash onto zod 4, TS 7 and Node 24 and before main's dormant-after-idle,
agent profiles and bundle-id move; this proves the product still hands a fleet over on current main.

You verify; you do not change product code. When something fails, capture the exact command, output and the file:line
you believe is responsible, and keep going with whatever else can still be proven. A defect that blocks the rest ends
the pass early with status BLOCKED.

## Read first

- W/m3-onmachine-brief.md (rules and the Part A method), W/m3-env.md (the M3 harness: wrappers, mocked claude,
  snapshot/compare, teardown recipe), W/m3-onmachine-A2-report.md and W/m3-onmachine-C-report.md (what a clean pass
  and the real-Codex step looked like, and every trap they hit). The M3 scratchpads named there still exist under
  `/private/tmp/claude-502/…/458d4622-…/scratchpad/`; copy what fits into your own scratchpad and adapt it.
- W/task-40-rebase-report.md (what the rebase changed).

## Authorised by the owner (and only this)

- Remote linus-vault, `ssh 100.117.42.24` (you log in as `linus`, passwordless sudo).
- **Remove `archi-m3`**: as archi-m3 stop and disable its archipelago units and `tmux kill-server`; as linus
  `loginctl disable-linger archi-m3`, `loginctl terminate-user archi-m3`, `deluser --remove-home archi-m3`,
  `sudo rm -r /home/archi-m3` if deluser leaves it; confirm no user, group, home, `/run/user/1002`, linger entry,
  process or file of it is left.
- **Create `archi-m3b`** whose home is **`/Users/Shared/archi-m3b`**: `sudo mkdir -p /Users/Shared` (root, 0755),
  `adduser --disabled-password --home /Users/Shared/archi-m3b archi-m3b`, the Mac's own public key authorised (the
  key `ssh -G 100.117.42.24` offers), `loginctl enable-linger archi-m3b`. It stays up after this pass for Tasks 41–42
  and the M3b gate.
- Credentials: copy linus's `~/.codex/auth.json` (and `~/.claude/.credentials.json` if present) into archi-m3b's home
  (sudo cp, chown archi-m3b, 0600). On the Mac copy the real `~/.codex/auth.json` into the test HOME's `.codex/`
  (0600). Read-only use of linus's claude/codex binaries on linus-vault is fine if world-executable; otherwise install
  per-user copies. Never modify linus's files, services, fleets or crontab.
- NEVER run `tailscale serve`, `tailscale funnel` or `tailscale set`. Check `ss -ltnp` before starting anything and
  never bind a port already in use (8787 in particular).
- **Mac test HOME is `/Users/Shared/archi-m3b`** (`mkdir`, `chmod 0700`; the same path as archi-m3b's home — this is
  the point). `ARCHI_APP_DEST` points into it; `--no-launchctl` wherever setup runs. Never touch the owner's real
  `~/.archipelago*`, `~/Library/LaunchAgents`, `/Applications`, `~/.ssh` (read only: OpenSSH reads it from getpwuid),
  `~/.local/bin`, `~/.claude` or `~/.codex` (read only for the auth.json copy). The real `/usr/local/bin/claude` must
  never run under the test HOME in this task.
- Clean up the M3 leftovers on the Mac if present: `/private/tmp/claude-502/m3w2` and the symlink
  `/private/tmp/claude-502/m3b` (`m3h2` is already gone). Nothing else under `/private/tmp/claude-502`.
- Keep `caffeinate -i` running while you work; stop it at the end.

## Steps

1. Record the before-state on linus-vault (`tailscale serve status`, linus's `systemctl --user list-units`, `ss -ltnp`)
   and the Mac (`~/.ssh/known_hosts` md5, mtimes of `~/Library/LaunchAgents` and `/Applications/Archipelago.app`).
2. Tear down archi-m3 and the Mac leftovers as authorised.
3. Build the Mac app and the linux-x64 companion from HEAD (the build now downloads a prebuilt GhosttyKit, and the
   release pins Node 24). Install the app into the test `ARCHI_APP_DEST`, set up the test HOME from the bundled release.
4. Create archi-m3b as authorised. Confirm no Node, pnpm or checkout on its PATH. `host add` it with no tty,
   `host enable` it as the fleet's gateway, `host doctor --json`. Declare path roots as the product asks; both machines'
   `home` root is `/Users/Shared/archi-m3b`.
5. Fixture on the Mac-owned test fleet, smaller than M3's: about six mocked characters over at least two Git graphs,
   one with a nested worktree and one with sibling worktrees, each graph with uncommitted edits, a partly staged index,
   an untracked file and a stash; one character with a second terminal; one character left idle-closed (dormant
   after idle, main's #15/#16 — set a short idle limit or use `dormancy.set`); one character with a non-default agent
   profile (main's #14). Plus one real Codex character (Codex 0.156.1, one trivial turn) in a trusted folder.
   Snapshot as M3 did.
6. Hand Mac → Linux (`archi handover` via the bundled helper). Compare; confirm the Mac side cannot revive and the
   Linux side activated; `codex resume` continues the carried session under its original id; the idle-closed character
   arrives dormant with its transcript and wakes on open on Linux; record what happens to the agent profile.
7. Hand Linux → Mac with the controller on the Mac (`archi handover local`). Compare against the original snapshot,
   same checks.
8. Leave the environment running (Mac owns the fleet, no transaction open) and write W/m3b-env.md in the shape of
   m3-env.md: paths, wrappers, ids, fixture, credentials, what runs where, the before-state, and the teardown recipe.

## Report

W/task-40-smoke-report.md. Per step: the commands (tokens redacted), key output, PASS / FAIL / NOT RUN, and for every
FAIL the suspected file:line. End with a Defects list, each with severity (Critical/Important/Minor) and evidence, and
one status line: DONE, DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT.

## Shell notes

- `unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE` first; your shell points at the owner's live fleet.
- zsh's `node` is a broken nvm function: `unset -f node npm npx pnpm _load_nvm nvm` and put
  `$HOME/.nvm/versions/node/v24.18.0/bin` first on PATH for builds; write every test-HOME step as an `sh` script in
  your scratchpad that captures node's path first. From the build on, run the app's bundled helper
  (`…/Contents/Resources/release/bin/archi`), never the checkout, tsx or pnpm.
- Do not rm gitignored build output in the worktree (`apps/desktop/mac/.build`, the GhosttyKit symlink). No bare
  `git stash`. Do not edit tracked files.
