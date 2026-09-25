# M3 fix wave — F1–F34 (binding). Detail for each source id: D*/I* in m3-candidates.md → m3-panel-*.md / m3-intent-findings.md and the validators' notes in m3-validated.md; C* in m3-carried.md.

Kept at the floor
F1 (D1, high). A running daemon never learns a gateway named after it started — resolve the gateway authority per call from the current fleet.json (drop main.ts's start-time `named ?` guard), or have host enable reach the running daemon; test enable-then-handover without a restart.
F2 (D3). Reject any session file path that relativeProblem refuses (absolute, `.`/`..`, control chars) before path.posix.join in entries(); stop the transaction; test a `../` path on a pull.
F3 (D4). The controller requires the frozen manifest's source/destination path roots to equal the ones it sent; claim and handover.inspect run manifestProblems' root mapping and real-path containment before reserving or creating anything.
F4 (D5 + I1). Preflight probes the local rsync and the far rsync over the master (rsync_unsupported blocker, incl. a far rsync below MIN_RSYNC; on Linux accept the system rsync when rsyncVersion passes), and asks the source daemon to reach its gateway authority read-only; a failure there or in the controller's BatchMode master is an `ssh_interactive` blocker — all before Begin.
F5 (D9). Emit a transfer entity event only when an entry's state changes or at most once a second per entry, never for an item-only put.
F6 (D10). One transfer entry per session: copy its file list into sessionStage(tx, i) with --files-from (no --delete) and verify it as a set with one checksum dry run.

Folded in by ruling
F7 (D6). Resume counts the destination done only when its ownership.get shows it owns the fleet at g+1 (or status reports a quarantined journal and the run stops with no safe action); never complete over a quarantined journal.
F8 (D7). A same-transaction `receiving` root is proved against [baseline, incoming] (ignoring rsync temp names) before a resume claim; destination-only edits made since block as divergence.
F9 (D8). Each freeze attempt gets its own AbortController that orChosen aborts on 'chosen' and retrying checks before each resend; clear() resets wakeChosen only while it holds its own waker.
F10 (D2). guardMethod refuses 'transaction'-class methods and handover.inspect for caller !== 'app'; phone-viewer dispatch test.
F11 (D18). Parse the gateway's ssh frame with a schema (as controller/authority.ts parseAnswer does); a malformed one is AuthorityFailure('invalid_request'), so relay refuses rather than adopting.
F12 (D16). The sheet counts an interrupted result as committed only when safe includes 'resume' or its phase is past commit; an unknown commit gets its own headline pointing at Check again.
F13 (D15). A decision's answer replaces the choice set (CLI held choices and the controller journal); merging stays only for a mid-freeze choose().
F14 (D12 + C13). namesOf adds sessions (`s<i>` → character name); the contract documents the `s<i>:<file>` row id; the sheet (and CLI) show names for character, root and session rows and blockers.
F15 (D17). Git repair lstat-checks each worktree `.git` and registration `gitdir` (regular file, or worktree_unresolved) or writes by temp+rename.
F16 (I2). handover.inspect reports carried symlinks that will dangle on the destination (relative targets against the manifest's files, absolute ones by lstat there) as a preflight warning. Ruling: a warning, not a blocker — the spec says preflight "detects" them and the blocker list omits them; many repos carry harmless dangling links.
F17 (I3). `archi handover status` and a no-helper attach never rename an unparseable controller journal; only writing paths move it aside.
F18 (I4). The tmux-gated suites (processes.test.ts:182, rest.test.ts:737) name their skip reason.

Carried (m3-carried.md, verbatim there)
F19 = C1, F20 = C2, F21 = C3, F22 = C4, F23 = C5, F24 = C6, F25 = C7, F26 = C8, F27 = C9, F28 = C10, F29 = C11, F30 = C12, F31 = C14, F32 = C15 (three parts).
F33 (M2 parked, cheap in touched code): none — leave M2's parked items to the final review.
F34 (verification). Typecheck, every project's full suite, swift test and the whole Playwright suite once at the end; known load flakes rerun alone.
