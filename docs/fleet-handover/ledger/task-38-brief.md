# Task 38 — security, performance and destructive-operation audit (brief)

Plan: `docs/fleet-handover/plan.md` Task 38. Spec `docs/fleet-handover/spec.md` is binding (release signing and
verification, "Ownership authority", "Failure and recovery", what transfers and what stays). Delivery rules
`ledger/review-constraints.md`. Worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`,
branch `experimental-remote-sessions`.

## Split

38a: security, destructive operations, licences and service/file permissions (items 1–4 and 8–9), writing
`docs/security/fleet-handover.md`; report `task-38a-report.md`. 38b (after 38a's review): performance (items 5–7), writing
the benchmark script and its results into the same doc; report `task-38b-report.md`. Your dispatch names your part.

## Carried into this task (ledger `progress.md`)

- **Must-fix (38a):** m6, line 683 — `host upgrade` must verify the new release on the far machine against the
  installed release's pinned `allowed_signers` with system tools (`ssh-keygen -Y verify`, `sha256sum -c --strict`)
  before anything from the staged archive runs. Today it verifies against the signers the new archive carries.
- 38b: line 275 (surfaces past sshd's MaxSessions ride their own logins; a surface-master pool), line 304 and 361
  (per-file lists inline in records and manifests; each file hashed one at a time; each replica hashed at preflight and
  again at claim), line 446 (the daemon WebSocket's 8 MiB cap is passed by a prepare at ~25k files), line 564 (the
  dangling-link check costs links × files at preflight), line 312 (directories, empty dirs and dir modes not recorded:
  decide whether it matters and say so).
- Line 355: the supported agent-version range and what a new Claude/Codex release does to handover (38a documents the
  process; the fixture/probe step is Task 39's).

## Do

1. Threat-model and test: SSH aliases (an alias or `ProxyCommand` that points somewhere else, option injection through a
   host or user name), every remote argv, malicious repository file names (leading `-`, newlines, control characters,
   non-UTF-8, case collisions), symlinks (in roots, pointing out of roots, swapped between inventory and transfer), a
   stale authority record, destination-path confusion.
2. Secrets never enter argv, logs, NDJSON events, state, manifests or repository roots: tokens, the relay secret, agent
   credentials (`~/.claude/.credentials.json`, `~/.codex/auth.json`), SSH material. Add a test per channel.
3. Every delete, rename and archive target traced back to a validated registry/manifest/replica record: list each
   destructive call site in the doc with the record that authorises it and the regression test that proves an
   unauthorised target is refused. Add missing tests; fix any site that can reach an unvalidated path (test first).
4. m6 above, test first.
5. Benchmark first and incremental transfer on a small, a large-file and a many-file (≥50k files) repository: wall time,
   peak RSS of controller and both daemons, hashing memory, NDJSON event count/volume, the largest RPC message. Bound
   whatever grows with repository size (event rate, message size, memory) and fix the carried items that break at that
   scale.
6. Terminal backpressure and API payload limits under large output (a terminal producing output faster than the SSH
   link carries; the daemon's message caps).
7. Record the numbers and the bounds in the doc, with the script (`scripts/bench/…` or beside the integration scripts)
   and how to rerun it.
8. Licences and notices for everything a release carries (bundled Node, rsync (GPL-3: source offer or source in the
   archive), npm dependencies bundled by esbuild, Ghostty/GhosttyKit in the app): a NOTICE/licences file in each archive
   and a test or build check that fails when a bundled component has no entry.
9. Service permissions and file modes (systemd units, the fleet home, ownership/journal/registry/secret files at 0600,
   sockets), Tailscale exposure (nothing the handover adds is served past loopback or the tailnet), and what uninstall
   (`archi host remove`, `setup --uninstall` or equivalent) keeps and deletes.

## Verify

The security regression tests, `pnpm typecheck`, `pnpm vitest run --project protocol --project archid --project cli
--project @archipelago/desktop-web --project scripts`; 38b: the benchmark run recorded in the doc; archive and licence
inspection of a built companion and controller release.

Every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH";
unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`; single test files as `pnpm test <path>` from the root.

## Rules

Test first for every fix; a finding you fix gets its own commit with its failing test. Findings you judge acceptable
go in the doc with the reason. Argv-only subprocesses; durable 0600 writes. Never touch `~/.archipelago`, `~/Library`,
`~/.claude`, `~/.claude.json`, `~/.codex`, `~/.ssh`, `/Users/Shared/archi-m3b` or linus-vault; never run the real
claude or codex. No bare `git stash`; don't rm gitignored build output. Comments only where behaviour is not
self-evident, 1–2 lines. Commit subjects: one plain sentence, repository style, no attribution lines. Commit as you go;
do not push.

## Report

Your part's report file (uncommitted): findings ranked with what you fixed (commit, test) and what you accepted (why),
the destructive-site table, the benchmark numbers (38b), verification counts, concerns. End your reply with one status
line: DONE, DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT, the commit range, and the counts.
