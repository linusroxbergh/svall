# Task 37 — real two-machine integration and fresh-install CI (brief)

Plan: `docs/fleet-handover/plan.md` Task 37. Spec `docs/fleet-handover/spec.md` is binding, in particular "Verification"
(automated tests: local-to-Linux and Linux-to-local with two disposable machines or containers, mocked agents and real
tmux/SSH/rsync; fresh Ubuntu x86-64 and arm64 provisioning from the published Mac artifact) and the release/companion
sections (signed manifests, `ssh-keygen -Y sign/verify`). Delivery rules `ledger/review-constraints.md`. Worktree
`/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions`.

## Split

37a: items 1, 2 and 6 (the integration harness, its fault scenarios, the CI jobs that run it), report
`task-37a-report.md`. 37b (after 37a's review): items 3, 4, 5 and 7 (fresh installs, the release workflow), report
`task-37b-report.md`. 37c (after 37b's review): item 8, the supported-host run on the real machines, report
`task-37c-report.md`. Your dispatch names your part.

## Rulings that shape this task (ledgered)

- **Topology.** GitHub's macOS runners cannot run Linux containers, so CI hands a fleet between two Linux containers on
  one Linux runner: "local" plays the controller's machine (the controller runs from the checkout's build there) and
  "remote" is the companion machine, provisioned by `archi host add` from the companion archive. Both accounts share one
  home path. Mac↔Linux is covered by 37c on the real machines.
- **One script, two hosts.** Every CI job is a thin call to a script under `scripts/integration/` that runs the same way
  on this Mac (`docker` via colima: start it if stopped and say so, stop it after, and set the docker context back to
  `desktop-linux`) and on a GitHub runner. Evidence comes from local runs; Actions jobs do not start on this repo
  (billing), so a GitHub run is owed, not claimed.
- **Signing.** No release signing key exists. The release workflow signs only when its signing secret is present; a tag
  without it is a dry run that builds, installs and tests everything and uploads nothing.

## Do

1. `scripts/integration/fleet-handover.sh` with fixture fake agents (promote the hook-speaking mocked Claude the on-machine
   passes used, `claude.mjs`, rather than writing a new one; Codex likewise if a mock exists) and the sshd setup: build
   both containers (Ubuntu 24.04, real sshd, rsync, tmux, Git; systemd where the product needs it), add the remote with
   `archi host add`, build a small fleet (a repo with a linked worktree, staged/unstaged/untracked changes and a stash; a
   shell terminal; a mocked-agent character with a session), hand it local → remote → local, and assert the manifests,
   the worktree indexes (HEAD, branch, index, stash, working changes), the state, the ownership records on both sides
   and the gateway, and that the agent resumed under its session id.
2. Controller-kill and network-drop scenarios at representative boundaries: before Freeze, during transfer, after Ready
   (pre-commit: abort revives only the source), right after Commit and during activation (post-commit: resume activates
   only the destination, the source never reactivates). Kill the real controller process and drop the real SSH link
   (e.g. block the port inside the container), then take the action `archi handover status` offers.
3. Fresh installs: build the companion archives for x64 and arm64, install each into a clean Ubuntu 24.04 environment of
   its architecture with no Node and no checkout on PATH, through the product's own path from the Mac-side artifact;
   verify the systemd units run (`archid` and the gateway, linger), then `host upgrade` to a second build and
   `setup --rollback` back. Locally: arm64 natively, x64 under emulation (plus linus-vault is x86-64 in 37c).
4. No user credential in any artifact or log the jobs upload; scan every release archive for secrets, developer paths
   (`/Users/`, the worktree path, `$HOME`) and checkout dependencies, failing the job on a hit.
5. `.github/workflows/release.yml`: on a tag, build the Mac controller and both companion archives, run the integration
   job (item 1–2) and both fresh-install jobs (item 3), and upload signed manifests and artifacts only after every one of
   them passed (`needs:`), signing with `ssh-keygen -Y sign` from a secret; an unsigned test tag is a dry run.
6. `.github/workflows/ci.yml`: add the integration job (keep the existing trigger), and make the rsync-dependent tests
   fail rather than skip in CI when `vendor/rsync` is missing (build it or set a require flag; ledger Task 23 minor).
7. Integration documentation under `docs/` (how to run each script locally, what each job proves, what CI cannot run).
8. The supported-host run (37c): on the M3b environment (`ledger/m3b-env.md`: the Mac test HOME and `archi-m3b` on
   linus-vault, both at `/Users/Shared/archi-m3b`), upgrade both sides to a release built by 37b's scripts from a
   `git archive` snapshot of HEAD, hand the fleet Mac → Linux → Mac with the release artifacts (not the source checkout),
   and check G2 on the machines: a Claude running with `--dangerously-skip-permissions` when the handover starts gets
   the `claude_bypass` warning at preflight (credential rule below).

## Verify

37a/37b: each script run locally end to end, output recorded (both directions, every scenario, both architectures);
`actionlint` (e.g. the `rhysd/actionlint` image) on both workflows; `pnpm typecheck`; the vitest projects the change
touches. 37c: the round trip's compare (state, repos, sessions, ownership) and the G2 warning, from the machines.

Every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH";
unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`; single test files as `pnpm test <path>` from the root.

## Rules

Test first where the change is executable product behaviour; a harness run that exposes a real defect is a finding —
fix it in its own commit with a failing test and list it in the report. Argv-only subprocesses in product code; durable
0600 writes. Never touch `~/.archipelago`, `~/Library`, `~/.claude`, `~/.claude.json`, `~/.codex` or `~/.ssh`; 37a and
37b never touch `/Users/Shared/archi-m3b` or linus-vault. 37c works only inside the M3b environment, never on the
owner's own account, services or `tailscale serve/funnel/set`. Credential rule (37c): read `Claude Code-credentials`
from the keychain straight into the test account's `~/.claude/.credentials.json` (0600, never printed) right before a
real-Claude step, only with ≥90 min left on `claudeAiOauth.expiresAt`, finish inside it, delete it after. No bare
`git stash`; don't rm gitignored build output. Comments only where behaviour is not self-evident, 1–2 lines. Commit
subjects: one plain sentence, repository style, no attribution lines. Commit as you go; do not push.

## Report

Your part's report file (uncommitted): what each script and job does, every run with its command and result, defects
found and fixed, what CI cannot run here and why, concerns. End your reply with one status line: DONE,
DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT, the commit range, and the counts.
