# Rebuild the PR #2 test environment at the 0.12.0 head

The owner's by-eye pass of svall PR #2 (https://github.com/linusroxbergh/svall/pull/2) runs on the environment the
real-machine round trip left: a Mac test HOME and the `svall-m4` account on linus-vault, both at
`/Users/Shared/svall-m4`, running build `a84bf57d`. PR #2 has since been rebased onto Svall 0.12.0. Put the new head,
**HEAD_SHA** (on branch `pr2-v3`), on both sides. Don't open the app and don't hand anything over: the owner does that.

Read first: `ledger/pr2-onmachine-env.md` (the environment and why the app must not be opened), and §1–§2 of
`ledger/pr2-onmachine-report.md` (how the builds, installs and upgrades were done). `ledger/` is
`/Users/linusroxbergh/linus_laboratory/svall/.claude/worktrees/fleet-handover-impl/docs/fleet-handover/ledger`.

## The kit moved

macOS's /tmp cleanup emptied the old `$S` (`/private/tmp/…/scratchpad/m4`): every script, log, snapshot, pid file and
built app there is gone. The scripts were recovered verbatim from the transcript into **`$TH/kit`**
(`/Users/Shared/svall-m4/kit`, `S` in `env.sh` now points there). `21-extras.sh` and `create-user.sh` were written
with unquoted heredocs, so their variables were expanded when first written; read them before relying on them.

The test daemon from 13 October still runs (pid 36262, `…/svall-m4/Applications/Svall.app/Contents/Helpers/node
…/runtime/svalld.mjs`), with its tmux server and ssh-agent (`$TH/tmp/agent.sock`). Its pid file is gone: check the pid
by its arguments, then write it to `$S/run/svalld.pid` so `mac-daemon-stop.sh` finds it.

## Rules (unchanged from the round trip)

- `unset SVALL_HOME SVALL_CHAR_ID TMUX` first; `unset -f node` (the shell function is broken). A bare `svall`, or
  `HOME=… open …`, reaches the owner's own fleet or app. Use the kit's wrappers (`sv.sh`, `tenv` in `env.sh`).
- Never touch the owner's `~/.svall*`, `~/.config/svall`, `~/Library`, `/Applications`, `~/.claude*`, `~/.codex`,
  OpenCode's data or `~/.ssh` (`known_hosts` unchanged). No `launchctl` of any kind: the test plist shares the owner's
  launchd label. Never open the test app.
- linus-vault: reach it only as `svall-m4` with the test key through the test ssh-agent. No sudo is needed for this
  task, so use none. Never touch the account `linus`, its files, fleets or services, other users, or
  `tailscale serve/funnel/set`.
- No credentials are copied; the agents stay logged out.
- If something needs the owner, stop and say so in the report instead of working around it.

## Steps

1. **Before.** Read-only health: the test daemon answers (`api.sh system.info`: `a84bf57d`, protocol 22, stateSchema
   9); `units-far.sh` (both m4 units on `a84bf57d`, gateway record at generation 2 naming the Mac); `snap.sh` a
   snapshot of the Mac fleet (characters, islands, terminals, roots) to compare with after.
2. **Build HEAD_SHA** as §1 did: a `git archive` snapshot in `$S/build/<id>/src` (`<id>` the 8-char SHA), the vendor
   caches (`vendor/{ghostty-kit,node,tmux,sparkle}` from the main checkout; `vendor/rsync` from whichever worktree has
   one, such as `pr2-final`, or as the repo's scripts make it), `scripts/release-build.sh` with `SVALL_RELEASE_KEY`
   unset, `release-scan.mjs` over the archives, then `SVALL_RELEASE_NAME=<id> pnpm app:build`. Copy the app to
   `$S/app.noindex/<id>/`.
3. **The Mac.** Move the installed `a84bf57d` app to `$S/app.noindex/a84bf57d/Svall.app` (kept for a rollback),
   stop the test daemon (`mac-daemon-stop.sh`), install with `11-install.sh <id>` (`setup --no-launchctl`), start it
   with `mac-daemon-start.sh`. Check `system.info` reads `<id>`, protocol 23, stateSchema 9, the fleet still owned
   by the Mac at generation 2, and a snapshot equal to step 1's apart from what the new build adds.
4. **m4.** `12-upgrade.sh` (`host upgrade m4`), then `host doctor m4` and `units-far.sh`: both units on `<id>`,
   `a84bf57d` kept, the gateway record still generation 2 naming the Mac, the Linux fleet home still a fenced copy.
5. **Preflight only.** If the CLI can run the handover's checks without starting it, run them for `m4` and record
   what they say. Otherwise skip. Do not freeze or hand over.
6. **Docs.** Update `ledger/pr2-onmachine-env.md` in place for the new build and the kit's new home: `S` is
   `$TH/kit`; the teardown must run the remote scripts before `teardown-mac.sh`, which removes `$TH` and the kit with
   it. Keep it a description of the environment as it is now.

## Report

Write `ledger/pr2-rebuild-012-report.md`: DONE / DONE_WITH_CONCERNS / BLOCKED, archive names, sizes, sha256 and scan
results, the app's CFBundleVersion, the before/after `system.info` and `units-far.sh` lines, the snapshot comparison,
the preflight result, and anything that surprised you. Logs go in `$S/logs/`.
