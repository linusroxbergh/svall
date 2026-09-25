# M3 gate — on-machine pass (brief)

W = /Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl/.superpowers/sdd/2026-09-20-fleet-handover
Checkout (HEAD of branch fleet-handover-impl): /Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl
Spec: /Users/linusroxbergh/linus_laboratory/archipelago/docs/superpowers/specs/2026-09-20-fleet-handover-design.md

Goal (plan M3 gate, verbatim): "With real tmux/Git/SSH and mocked agents, hand twelve characters and at
least three Git graphs—including nested and sibling worktrees—in both directions. Inject a
disconnect/process kill at every phase. Before Commit only the source may revive; after Commit only the
destination may activate. Compare source/destination file manifests, Git indexes/status/stashes and
state snapshots. Then repeat with one supported real Claude session and one supported real Codex
session."

The pass runs as three sequential parts sharing one environment. Each dispatch names its part. Do your
part only; leave the environment running for the next part (Part C tears it down).

You verify; you do not change product code. When something fails, capture the exact command, output and
the file:line you believe is responsible, and keep going with whatever else can still be proven. A
defect that blocks the rest of your part ends it early with status BLOCKED.

## Authorised by the owner (and only this)
- Remote: linus-vault, `ssh 100.117.42.24` (you log in as `linus`, passwordless sudo). Ubuntu 24.04
  x86_64, tmux 3.4, git 2.43.0, rsync 3.2.7, Tailscale up.
- ONE throwaway user `archi-m3` there, created with sudo exactly as archi-m2 was in M2 (W/m2-onmachine-report.md
  step 3): `adduser --disabled-password`, the Mac's own public key authorised (the key `ssh -G 100.117.42.24`
  offers), `loginctl enable-linger archi-m3`. Part C deletes it: stop its user services, disable linger,
  `deluser --remove-home archi-m3`, confirm the user and its processes are gone.
- Part C only: copy linus's `~/.claude/.credentials.json` and `~/.codex/auth.json` into archi-m3's home
  (sudo cp, chown archi-m3, mode 0600). Read-only use of linus's claude/codex binaries is fine if they are
  world-executable; otherwise install per-user copies for archi-m3. Never modify linus's files.
- Everything else under `linus` on the remote is read-only: never touch linus's files, services, fleets or
  crontab.
- NEVER run `tailscale serve`, `tailscale funnel` or `tailscale set`, and never change the existing serve
  mapping. Read-only `tailscale status` / `tailscale serve status` is fine. Check `ss -ltnp` before
  starting anything and never bind a port already in use (8787 in particular).
- Mac side: never touch the owner's real ~/.archipelago*, ~/Library/LaunchAgents, /Applications, ~/.ssh,
  ~/.local/bin, ~/.claude or ~/.codex. Use a temp HOME under your scratchpad, `ARCHI_APP_DEST` pointing
  into it, and `--no-launchctl` wherever setup runs. OpenSSH reads ~ from getpwuid, not $HOME, so ssh
  still uses the real ~/.ssh and known_hosts — read, never write. Part C only: Claude on the Mac reads the
  login keychain (no copy needed); copy the real `~/.codex/auth.json` into the temp HOME's `.codex/` (0600);
  it dies with the temp HOME.
- Do not sleep the Mac. "The Mac asleep at Complete" is simulated by stopping (SIGSTOP, then SIGCONT) or
  killing the temp-HOME Mac daemon at that point.
- Always `unset ARCHI_HOME ARCHI_CHAR_ID TMUX` first; your shell points at the owner's live fleet.
- The zsh here has an nvm `node` function that breaks under an overridden HOME: write every temp-HOME step
  as an `sh` script in your scratchpad that captures `$(command -v node)` first. The Bash guard refuses long
  compound commands; put them in scripts.
- The `archi` shim breaks when run from inside a feature worktree. From the build on, run the app's bundled
  helper (`…/Contents/Resources/release/bin/archi`), never the checkout, tsx or pnpm.

## Shared environment file
Part A writes `W/m3-env.md`: the temp HOME path, ARCHI_APP_DEST, the helper path, the sh wrappers, the
companion archive, the host name, both fleet homes, fleet and character ids, the Git fixture layout, the
mock-agent mechanism, how to snapshot/compare both sides (your comparison script's path), the before-state
of linus's `tailscale serve status` and `systemctl --user list-units`, and every running process you left
up. Parts B and C read it first and append what they change.

## Part A — provision, fixture, clean handovers both ways
1. Read W/m2-onmachine-report.md (how the app and linux-x64 companion are built, installed and added; its
   defects list) and the task reports that describe the handover surface: W/task-24-report.md (rest),
   W/task-25-report.md (freeze/abort/export), W/task-26-report.md (prepare/activate), W/task-27-report.md
   (controller transaction), W/task-28a-report.md, W/task-28b-report.md (CLI, recover), and
   W/task-28-29-contract.md. Read only the spec sections you need.
2. Record the before-state on linus-vault: `tailscale serve status`, linus's `systemctl --user list-units`,
   `ss -ltnp`.
3. Build the Mac controller app and the linux-x64 companion archive from HEAD. Install the app into the temp
   `ARCHI_APP_DEST`.
4. Create archi-m3 as authorised. Confirm no Node, pnpm or checkout on its PATH. `host add` it with no tty,
   `host enable` it as the fleet's gateway (whatever the reports say a gated fleet needs), `host doctor --json`.
5. Fixture on the Mac-owned temp fleet: twelve characters with mocked agents (find the fake-agent mechanism
   the e2e tests use; put a fake agent on archi-m3's PATH too), each with a live terminal, spread over at
   least three Git graphs that include a nested worktree and sibling worktrees, with uncommitted changes, a
   staged index and a stash in each graph, and one root declared through a symlink. Snapshot: file
   manifests, `git status --porcelain=v2`, `git stash list`, index hashes (`git ls-files -s`), worktree
   lists, and the fleet state (characters, terminals, islands) from the API.
6. Hand Mac → Linux with the controller on the Mac (`archi handover` via the helper). Compare the same
   snapshot on the destination; every difference is a finding unless the spec says the path is rewritten.
   Confirm the Mac side cannot revive and the Linux side activated.
7. Hand Linux → Mac with the controller on the gateway machine (run `archi handover` as archi-m3 on
   linus-vault). Compare again against the original snapshot.
8. Hand Mac → Linux → Mac once more with the controller on the Mac to prove a second round trip.
9. The carried Task 27 checklist, as far as a clean run proves it: connection-info → token → `-O forward` →
   WS; a claim/prepare over 8 MiB sent in parts (grow the fixture until the manifest crosses 8 MiB); rsync
   over the master for a gitdir root and session staging at the inferred remote fleet home; the route
   cache after `moved`; `git_extension` on git 2.43 (worktreeConfig or another extension on one graph);
   `grep -r` of `<fleetHome>/controller/**` on both sides for the connection token (it must not appear).
10. Leave everything running and write W/m3-env.md.
Report: W/m3-onmachine-A-report.md.

## Part B — a disconnect or kill at every phase, both directions
1. Read W/m3-env.md and W/m3-onmachine-A-report.md. List the handover phases from the spec and the
   controller journal (Begin … Complete) and write the injection matrix first: for each phase, each
   direction, one disconnect (kill the ssh master, or the `-O forward`) and one process kill (controller
   helper, source daemon, destination daemon, gateway). Drive each injection deterministically: find where
   the helper's events file or the journal shows the phase and kill at that point.
2. For every cell: record what the helper/`archi handover status` reports, which `safe` actions it offers,
   then check the invariant — before Commit only the source may revive (destination terminals never run);
   after Commit only the destination may activate (the source never reactivates). Recover with the offered
   action (resume or abort, or `fleet recover` where the spec says), then compare snapshots against the
   last good state.
3. Carried specifically: a master drop mid-transfer; ssh killed mid-Commit then resume; the Mac "asleep"
   (daemon stopped) at Complete → the source shows pending and a resume completes; the gateway off (stop
   archi-m3's gateway unit) → a gated fleet's daemon start waits at most ~10 s (GATEWAY_START_MS), ssh
   fails fast, and `archi connect --json` retries through it.
Report: W/m3-onmachine-B-report.md (the matrix with PASS/FAIL per cell).

## Part C — real Claude and Codex, then cleanup
1. Read W/m3-env.md and the A and B reports. Install the credentials as authorised; make claude and codex
   available to archi-m3 and to the Mac temp HOME.
2. Give one character a real Claude session and one a real Codex session (one turn each, a trivial prompt).
   Hand them Mac → Linux and back Linux → Mac. On each side after activation, confirm `claude --resume`
   and `codex resume` continue the carried session and that SessionStart reports the carried session id
   (the activation wait depends on it). Note the Codex trust prompt: does activation pass it or stall?
3. Cleanup: kill every master, helper and daemon you started on the Mac; remove the temp HOME; delete
   archi-m3 as authorised. Compare linus's `tailscale serve status`, `systemctl --user list-units` and
   `ss -ltnp` against Part A's before-state; they must match.
Report: W/m3-onmachine-C-report.md.

## Report format (every part)
Per step: the commands (tokens redacted), key output, PASS / FAIL / NOT RUN, and for every FAIL the
suspected file:line. End with a Defects list, each with severity (Critical/Important/Minor) and evidence.

## Part A2 — re-run Part A from scratch on the fixed build (after the O1–O11 fix wave)
Part A needed hand steps D1–D4 and a chmod on two links. The fix wave (W/m3-onmachine-fixes.md,
report W/m3-onmachine-fixes-report.md) is meant to remove every one of them. A2 proves that on a
fresh machine and a fresh fleet.
1. Read W/m3-env.md, W/m3-onmachine-A-report.md and W/m3-onmachine-fixes.md. Reuse Part A's scripts in
   its scratchpad (`$S`) where they still fit.
2. Tear down Part A's environment. On the Mac: stop the temp-HOME archid and its tmux server, kill any
   leftover master or helper, remove the temp HOME and the fixture tree. On linus-vault: stop
   archi-m3's units, disable linger, `deluser --remove-home archi-m3`, and confirm the user and its
   processes are gone. This is the same authorisation as Part C's cleanup.
3. Rebuild the app and the companion from the new HEAD. Recreate archi-m3 fresh, exactly as authorised.
4. Re-run Part A steps 4–9 with NO hand steps: no fleet id edits, no owner.json moves, no mv of
   ~/.archipelago/home, no chmod on links. Keep the fixture's committed symlinks at the Mac's default
   mode. Add one repo whose root is declared through a symlink and carries a Claude-shaped transcript
   with a turn made on each side. Also add one registered worktree that no character uses.
5. Check each O-item where the product shows it:
   - O1: the first handover to the fresh machine works after `host enable`;
   - O2: the links stay at the Mac's mode;
   - O3: `--archive` clears its blocker (occupy one root on the far side on purpose);
   - O4: setup's home is adopted;
   - O5/O7: the symlinked-root character resumes every turn after the round trip, and records carry
     the destination path;
   - O6: the unused worktree's `git status` works on its own machine after the round trip;
   - O8: core.ignorecase/precomposeunicode on Linux;
   - O9: after an abort during Transfer, no `handover/sessions-<tx>` is left;
   - O10: doctor finds claude;
   - O11: `host list` shows gateway yes.
6. Leave the new environment running and rewrite W/m3-env.md for Parts B and C.
Report: W/m3-onmachine-A2-report.md.

## Part C, step 0 — rebuild and re-check Part B's failures (after the P1–P5 fix wave)
Before Part C's step 1: rebuild the app and the companion from the new HEAD. Install the app into the same
temp `ARCHI_APP_DEST`, and upgrade archi-m3 through the product's own path (`archi host upgrade m3`, or
whatever the reports name). Then restart the Mac temp-HOME daemon from the new app. Keep the fleet and
fixture exactly as Part B left them.

Re-run Part B's FAIL cells on the new build with Part B's harness (`$B`, see W/m3-env.md): A2d, B1d and
A8k2. Also re-run B2k2's wholesale-unit-kill variant for P3, and one foreground `--json` run whose reader
goes away (P5). P1–P5 in W/m3-onmachine-B-fixes.md say what each must now show. Keep `caffeinate -i`
running for the whole part. Record these as step 0 in the Part C report.
