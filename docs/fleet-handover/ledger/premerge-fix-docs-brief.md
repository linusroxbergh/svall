# Fixer docs — S5 (claims that are wrong at head) and deferred.md

Worktree `/Users/linusroxbergh/linus_laboratory/svall/.claude/worktrees/pm-fix-docs`, branch `pm-fix-docs`.
Read `ledger/premerge-fix-common.md` and item S5 plus "Follow-up ticket" of `ledger/pr2-premerge-review.md` first.

Exclusive files: `docs/fleet-handover/README.md`, `docs/fleet-handover/spec.md`, `docs/fleet-handover/deferred.md`,
`docs/remote-machines/README.md`, `docs/remote-machines/release-notes.md`, `docs/remote-machines/migration.md`,
`docs/remote-machines/setup.md`. Not errors.md or handover.md (another fixer owns them). Docs only; verify each fact
against the code at b31fe003 before writing it.

1. The flag gates the app's controls only. Reword `docs/fleet-handover/README.md:7`, `docs/remote-machines/README.md:8`
   and `release-notes.md:3-5` to say so, matching `setup.md:56` (the `svall host`, `handover`, `gateway` and `fleet
   recover` commands work whether or not it is on).
2. `release-notes.md`: drop "works exactly as before" and list what changes for every fleet with the flag off:
   - a second terminal running Claude, Codex or OpenCode stays when Svall quits or its window goes, and opening
     Terminal 2 resumes that session; quit the agent and exit the shell to remove it (no auto-revive);
   - the daemon writes `~/.config/svall/machine.json`; a fleet with no gateway still starts when it cannot (another
     fixer makes that true);
   - each window runs a small `svall connect` helper;
   - the app download is about twice 0.9.0's (about 100 MB; another fixer removes the duplicate Node).
   Put these where release-notes.md lists changes for everyone; keep it short.
3. `migration.md:119` "Upgrading again": `mv config.json config.json.bak` in place of `rm config.json` (check that the
   split ignores a `.bak` once fleet.json exists). `migration.md:16`: node.json also gets `agentsOff`, and keys
   neither file knows stay only in `config.json.bak`.
4. `spec.md`: schema v8 → v9 at `:549`, `:851`, `:875` where it means this branch's resumable schema; add
   `agent.subagents`, `hint` and `panePath` to the export-strip sentence at `:553` (check portable-path.ts FORBIDDEN).
5. `docs/fleet-handover/README.md` "Owed before this can ship": add a notarized `pnpm release` (the app carries an
   extra Node runtime, rsync and a Linux tarball that notarization has not seen).
6. `deferred.md`:
   - drop the `setup --release never passes rollbackTo` item (`:105`; fixed);
   - reword the "svalld exits at start when ~/.config/svall cannot be made…" item to cover only a fleet that names a
     gateway;
   - reword the "two controllers" item: the app carries the linux-x64 companion (~45 MB) and the controller's lib;
     the Node is shared with Helpers (another fixer does that);
   - add the review's follow-ups F2–F8 as items in their areas, in the file's style (one sentence + path:line): rsync
     deployment target, the Enter-after-paste window and `Fleet.settle()` not waiting on prompt lanes, carrying the
     companion vs fetching it at Add Machine, local builds not checking allowed_signers, compat not checking
     `opencode session export/import`, the concurrent config split, host.ts's four identity checks. F1 (connect
     helper per window) is already listed; keep it.
