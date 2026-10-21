# PR #2 on-machine round trip (brief)

PR #2 (https://github.com/linusroxbergh/svall/pull/2, branch `worktree-port-pr-1`, head `a84bf57d`) has run only in
containers with mocked agents. The last real-machine pass was Archipelago release `d0602dc`
(`ledger/final-onmachine-report.md`, environment `ledger/m3b-env.md`); nothing from svall has run on a real machine, and
real OpenCode has never been handed over. That environment is gone: the Mac test HOME `/Users/Shared/archi-m3b` is
deleted and its `/private/tmp` scripts are likely cleared. Use those files, `final-onmachine-brief.md` and
`task-39b-report.md` as the template, with svall's names.

Read first: `docs/fleet-handover/README.md` ("Owed", "How the work was run", "Testing notes"),
`docs/remote-machines/setup.md`, `handover.md`, `apps/desktop/mac/SMOKE.md`.

## Do

1. Start in a new detached worktree of `a84bf57d`. Build two releases from `git archive` snapshots (`scripts/release.sh`
   / `release-build.sh`, unsigned, so installs take `--allow-unsigned`): `b31fe003` (the previous head) and `a84bf57d`.
2. Mac: a test HOME `/Users/Shared/svall-m4` (0700) with `SVALL_APP_DEST` inside it and `--no-launchctl`, driven only
   through wrapper scripts. linus-vault (`100.117.42.24`): a throwaway user `svall-m4` whose home is
   `/Users/Shared/svall-m4`, with a key made in the test HOME; Claude Code, Codex and OpenCode (2.0.22 or newer)
   installed in that user's home.
3. A test fleet with a real Claude, a real Codex and a real OpenCode character, repos with worktrees, staged and unstaged
   changes and a stash, and one terminal in a folder holding repos no character works in.
4. With `b31fe003` installed: `host add`, `host doctor`. Install `a84bf57d`, `host upgrade`, `--rollback`, upgrade again
   (each fleet daemon and the gateway on the expected release), then `host add` the same name again (reports ready).
5. Hand the fleet Mac → Linux → Mac with the release's helper. The unused-repos terminal must block with
   `repository_unused` until `--carry-unused`. Compare state, repos (HEAD, branch, index, stash, working changes,
   worktrees), docs, sessions and ownership both ways; take a turn in each real agent on Linux and back on the Mac, each
   under its own session id.
6. Leave it for the owner's by-eye pass: the Mac owns the fleet, nothing open anywhere, no credential copy on either
   machine, `svall-m4` kept. Write `ledger/pr2-onmachine-env.md` as `m3b-env.md` was: where everything is, how the owner
   opens the test build against the test HOME for `SMOKE.md`'s steps, and the teardown (the user and its linger on
   linus-vault, the Mac test HOME).

## Owner's approvals (2026-10-13)

- linus-vault: sudo through the default ssh user only to create, and later tear down, `svall-m4`. Never touch the
  account `linus` or its files, fleets and services, other users (report `archi-m3b` if it is still there; don't remove
  it), or `tailscale serve/funnel/set`.
- Credentials, for the real-agent steps only: copy the owner's Claude, Codex and OpenCode logins into the test homes
  (0600, never printed or logged) and delete every copy right after. Claude comes from the Mac keychain's
  `Claude Code-credentials`, only with ≥90 min left on `claudeAiOauth.expiresAt` (otherwise wait and check again);
  never refresh a login from a test account.

## Rules

- `unset SVALL_HOME SVALL_CHAR_ID TMUX` first. A bare `svall`, or `HOME=… open …`, reaches the owner's own fleet or app.
- Never touch the owner's `~/.svall*`, `~/.config/svall`, `~/Library`, `/Applications`, `~/.claude*`, `~/.codex`,
  OpenCode's data or `~/.ssh` (using the existing key to reach linus-vault is fine; leave `known_hosts` unchanged). No
  colima.
- Report a product defect with evidence; don't fix it, push or touch the PR. Keep scripts and logs in your scratchpad.
- If something needs the owner, stop and say so in your report instead of working around it.

## Report

`ledger/pr2-onmachine-report.md` (uncommitted): both release ids and scans, the installs, `host add` (first and
repeat), doctor, both upgrades and the rollback (each daemon's release), both directions (generation, duration,
characters carried), the `repository_unused` check, the compare, each agent's turns and session ids, credential
copy/delete times (never the token), defects, the end state, concerns. Add one line to `ledger/progress.md` when done.
