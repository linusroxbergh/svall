# Task 41b — review

Commits 5521fa2a..366ced84 on `experimental-remote-sessions`, checked against the task brief (41b and "Both halves"), the
spec ("Git repository graphs", "Agent sessions", "Terminal records", "Compatibility", "Same paths") and the delivery rules.

**Verdict: Needs fixes.** Two Important findings and four Minor ones. No Critical findings.

## Important

### I1. The Claude sidecar whitelist still works as a version maximum

- **Where:** `packages/archid/src/handover/sessions/claude.ts:10-21` (`SIDECARS`, `carries`) and `:46-50` (an unknown
  file refuses the session).
- **Evidence:**
  - The spec ("Agent sessions") says an adapter "depends only on where its CLI keeps a session's files, not on the
    record format, and has a minimum supported version but no maximum."
  - `<config>/projects/<slug>/<id>/` is where Claude Code keeps a session's own files. The whitelist also judges what
    kind of file each one is. Any other name under that folder raises `incompatible_adapter` at preflight, e.g.
    `auto-mode-classifier-error.txt`, `subagents/*.json` or a nested `tool-results/p1/page-1.jpg`
    (`sessions.test.ts:105-115`, `:255-264`). So a newer Claude that adds a new file kind blocks every handover of
    that session until the code learns the name. That is the pin 41b was meant to remove.
  - Task 22's survey already found 0.5% of sessions blocked by the classifier dump. That survey covered 2.1.251–2.1.280
    only, not the Mac's 2.1.283. The blocker text ("…which Claude Code session adapter 1 does not carry") gives the
    user nothing to act on.
  - The whitelist was there so each kind could get its own transform (`records` / `meta` / `verbatim` in the old
    `claude.ts`). With no transform, that reason is gone. Byte-for-byte copying to the same path needs nothing from
    the file kind.
  - `session-env/<id>` (secrets) and `file-history/<id>` sit outside the session folder, so carrying the whole folder
    carries neither.
- **Fix:**
  - Carry every regular file under `projects/<slug>/<id>/`, and have `carries` accept any path under that folder.
  - Keep what `filesUnder` already refuses: links, non-regular entries and names it cannot carry.
  - Turn the two refusal tests into "carries every file of the session's own folder byte for byte".
  - Drop `projects/${slug}/${id}/notes.md` from the install refusal list (`sessions.test.ts:393`).

### I2. The import deletes through a `worktrees` folder carried as a link, outside the claimed roots

- **Where:** `packages/archid/src/handover/git-import.ts:127-131`.
- **Evidence:**
  - `readdirSync(<common>/worktrees)` and `rmSync(<common>/worktrees/<id>)` follow a `worktrees` that is a symlink.
    The manifest carries a symlink as a symlink (`manifest.ts:82-86`).
  - `gitProblems` resolves each carried worktree's `gitDir`, so it catches the link, but only when the graph carries a
    worktree. With none carried, nothing checks it.
  - Reproduced in a scratch copy: a main-only graph whose `.git/worktrees` links to `<base>/outside-wts`, holding
    `victim/data`. `importGraphs` returned `[git_mismatch]` and `victim/data` was gone.
  - This breaks "nothing written outside claimed roots" and the spec's "Handover never silently deletes
    destination-only work". The old repair had the same hole; this change rewrote the function and guarded only
    `config`.
- **Fix:** lstat `<common>/worktrees` the same way as `config` (`:126`). Absent means nothing to remove. Anything
  that is not a real directory refuses with `worktree_unresolved`. Add a case beside "leaves a config carried as a
  link".

## Minor

### M1. The import's refusal path is untested, and its filesystem calls are not injectable

- **Where:** `git-import.ts:132-135`. Delivery rule: dependency injection for filesystem operations so failure paths
  are deterministic.
- **Evidence:** I replaced the catch with `throw e`. The archid handover tests and the cli tests all still passed, apart
  from the `--version` test, which fails in any copy without `.git`. So a failing `git config --get` (`GitFailure`) or
  a failing `rmSync` (errno) is never shown to become a `worktree_unresolved` blocker instead of a crash. The old
  `RepairFs` seam is gone, and nothing replaces it.
- **Fix:** add a case with a fake git that answers `config --file … --get core.ignorecase` with exit 128, expecting
  `worktree_unresolved` for the graph and its registrations untouched. `chmod 000` on `worktrees` also works, without
  bringing back a seam.

### M2. The Unicode probe names are now raw literals

- **Where:** `git-import.ts:17`, `:20`.
- **Evidence:** `ä` and `ä` became literal `ä` (`c3 a4`) and `a` + U+0308 (`61 cc 88`). The bytes are right
  today. But an editor or formatter that normalises to NFC would make both names the same and the probe would always
  answer `precomposeUnicode: true`. No test runs the real `probeFsRules`, since every test injects `probe`. It is also a
  change outside the task.
- **Fix:** restore the two escapes.

### M3. Docs still describe the pins and the rewrite

- **Where:**
  - `packages/archid/test/fixtures/handover/claude/README.md:17` ("pinned to the tested version") and `:59-60` ("Task 22
    still needs versioned schema checks, a full path-root mapping");
  - `packages/archid/test/fixtures/handover/codex/README.md:16` ("Support is pinned to 0.155.1") and `:81`;
  - `docs/fleet-handover/README.md:45-47` ("accepts only 2.1.251–2.1.280").
- **Evidence:** all of these contradict the code as it now stands. The two fixture READMEs are the documentation for
  the fixtures `sessions.test.ts` uses.
- **Fix:**
  - Fixture READMEs: cut the pin and the "Task 22 still needs" lines, or add one line saying sessions are copied byte
    for byte from each adapter's minimum on.
  - Pick-up guide: the orchestrator updates the "Owed" bullet (the implementer left it on purpose).

### M4. `SessionAdapter.min` hides a missing Codex floor behind a non-null assertion

- **Where:** `sessions/codex.ts:25` (`AGENTS.codex.minVersion!`).
- **Evidence:** if main ever drops Codex's floor, `min` is `undefined` at runtime while its type says `Version`.
  `versionOk` then passes every release, which is the right outcome, but `sessionAdapter(kind).min.join('.')` in any
  new caller would throw.
- **Fix:** optional. `min: AGENTS.codex.minVersion ?? [0, 0, 0]`, or leave it.

## The implementer's concerns, judged

- **Sidecar whitelist:** the whole session folder should travel. See I1.
- **Claude floor in `claude.ts` (2.1.251), Codex floor from `AGENTS` (0.155.0):** acceptable.
  - `AGENTS.claude` has no floor, and adding one would change `archi doctor` and host add for every local Claude. The
    brief allowed "if that fits".
  - Codex 0.155.0 is the floor Archipelago already requires of Codex on both machines, so moving down from 0.155.1
    admits no release the fleet could not already run.
- **No pre-check before removing registrations:** acceptable, no finding.
  - Preflight's `gitBlockers` already refuses a repository whose extensions the destination's git cannot open.
  - `landedProblem` proves every carried file arrived before the import runs, and `gitProblems` proves each graph
    place lies in a carried root.
  - The only thing removed is a registration the import would remove anyway, in a copy the next claim mirrors again.
  - Validation reports git's own error.
- **The `ARCHI_TEST_SSH` remote Git test was deleted:** acceptable. It could not pass on a Mac once O8 ran the probe
  locally, and it needed the filesystem seam this importer no longer has. A Linux git reading a moved graph is what
  the M3b on-machine pass checks. Its brief should include a fleet with a worktree, an unused registration and a
  stash.
- **Spike scripts and the `*-portability` tests:** leave them. They are M0 evidence cited by `spike-results.md` and
  `readiness.md`, and they import no product code. 41b does not make them dead. They can go with Task 39's docs pass if
  wanted. Their fixture READMEs are M3.
- **`versionOk` passes an unparseable version:** acceptable. Only `versionOf` output reaches `adapterFor`, on both
  sides of the exact-release pair.
- **O8 writes on macOS:** acceptable. The probe file goes into the claimed common directory and is removed before the
  seal scan.

## Verified clean

- **Git** (`git-import.ts`):
  - It writes no gitfile or `gitdir`. `git grep` finds no `worktree prune` or `repair` anywhere in `packages/*/src`.
  - `git-repair.ts` and its test are gone. No reference is left outside the plan's history.
  - Unlisted, unkept registrations are removed and branch refs stay (`unused-branch` and `gone-branch` still resolve).
  - Validation checks `worktree list`, status, staged entries and the stash.
  - O6 (kept registrations, both the proven and the unproven commit cases) and O8 (the re-probe, only on a regular
    `config`) still hold.
  - Callers (`destination.ts`, `service.ts`, cli `controller/handover.ts`) and the package export are renamed. Seal and
    abort are unchanged.
- **Sessions:**
  - The path map, the record walker, the record and attachment type lists, `validate`/`rewrite` and the version range
    are all gone, with no stale symbol left (`git grep` for each).
  - `installSession` writes the staged bytes unchanged.
  - Discovery is unchanged: the Claude transcript with `subagents/` and `tool-results/`, and the Codex rollout alone.
  - The missing-transcript blocker and the link, non-regular and name refusals are kept.
  - `transcriptPath` equals the recorded path with the default agent home (the fixture test asserts it).
  - Claude 2.1.283, and a destination running 2.4.0, pass preflight (`source.test.ts`, `sessions.test.ts`).
- **Safety:**
  - Git runs through `runGit` with argv only.
  - Sessions are written only under the agent home that `sessionProblems` checks by real path.
  - Activation still waits for `installCommitted`. Apart from I2, the import writes only inside the claimed common
    directory.
- **Protocol and web:** no protocol change, `PROTOCOL_VERSION` untouched, and no web text names repair, rewrite or a
  version range.
- **Commits:** plain one-sentence subjects with no attribution.
- **Tests fail without their change.** I applied each mutation in a scratch copy of 366ced84; every one was caught:

  | Mutation | Tests that caught it |
  | --- | --- |
  | `worktree repair` run after removal | "same paths, no repair or prune" and "removes each registration" |
  | `worktree prune` instead of removal | the same two |
  | Registrations not removed | 9 of 11 in `git-import.test.ts` |
  | Removal also deletes the branch refs | "keeps its branch" and 3 others |
  | Config link guard dropped | "config carried as a link" |
  | O8 skipped | the case/Unicode test |
  | `kept` ignored | both O6 tests |
  | A 2.1.280 / 0.156.1 cap put back | the registry test, all 4 fixture cases, the preflight case and `source.test.ts` 2.1.283 |
  | Content rewritten on install | "lands under the destination agent home … byte for byte" |
  | Record check put back in the scan | "carries a session a CLI newer than every fixture wrote" |

  The one survivor is M1.
- **Runs** (on 366ced84 plus the ledger commit):

  | Command | Result |
  | --- | --- |
  | `pnpm vitest run --project protocol --project archid --project cli` | 125 files passed, 1 skipped; 2224 passed, 5 skipped (matches the report) |
  | `pnpm vitest run --project @archipelago/desktop-web` | 708 passed |
  | `pnpm typecheck` | clean |

## Fix round 1

Commits 5f62409e..b4442350, checked against `task-41b-fix1-findings.md` and `task-41b-fix1-report.md`.

**Verdict: Approved.** All six items are fixed, and each stays within its item. One new Minor, which does not block.

### Each item

- **I1 — fixed** (`sessions/claude.ts`):
  - The whitelist is gone. `discover` carries every regular file under `projects/<slug>/<id>/`, and `carries`
    accepts the transcript or any path under that folder.
  - Links, non-regular entries and names `filesUnder` cannot carry are still refused. `..` and absolute paths are
    still refused in `installSession`. `file-history/` and `session-env/` still stay behind.
  - Fails first: with the old `claude.ts` put back in a scratch copy, "finds every file of the session's own folder"
    and "carries a file of a kind no release so far wrote … byte for byte" both fail.
  - The one change outside `sessions/` is `packages/cli/test/handover.test.ts:378,396`. That test printed a sample
    blocker the adapter can no longer produce, and it now prints the floor blocker. This is in scope.
- **I2 — fixed** (`git-import.ts:128-132`):
  - `<common>/worktrees` gets an lstat first. If it is anything but a real folder, the graph gets
    `worktree_unresolved`. If it is absent, nothing is removed.
  - Fails first: with the guard taken out, the new test fails with `expected [] to deeply equal [ { …(3) } ]`. That
    is what I reproduced before the fix: `victim/data` removed, then a clean validation.
- **M1 — fixed.**
  - The two new tests are "a git that refuses" (exit 128 on `config --get`) and "`worktrees` at mode 000". They fail
    when the catch rethrows, as does the I2 test.
  - They pass on the pre-fix import, as they should: the catch already existed and only lacked a test.
  - **Judged against the delivery rule:** meets it. The rule asks for failure paths that are deterministic in unit
    tests.
    - The process side goes through the injected `GitRunner`.
    - The filesystem side fails deterministically on a real fs through `chmod 000`, the same way
      `sessions.test.ts:135-137` already tests an unreadable sidecar folder.
    - A seam used by one test would be the kind of abstraction the house rules warn against.
  - **What is not covered:** the mode-000 case is skipped as root, and an `rmSync` that fails part way is never
    exercised. It goes through the same catch, so neither gap is worth a seam.
- **M2 — fixed.** Both names are escapes again: `ä` and `ä`, byte for byte as in `git-repair.ts`.
  `git-import.ts` now holds no non-ASCII byte.
- **M3 — fixed.**
  - Both fixture READMEs lose the pin. Their "Task 22 still needs … path-root mapping" line now describes the adapter
    as it stands.
  - The spike verdict prose ("remapped", "different path prefix") describes the M0 probe and is correctly left alone.
    So are the spike scripts, the `*-portability` tests, `spike-results.md`, `readiness.md` and the pick-up guide.
- **M4 — fixed.** `min: AGENTS.codex.minVersion ?? [0, 0, 0]`, with no `!`. A missing floor now means every release
  counts.

### New finding

#### M5 (Minor). A file named like the session folder passes preflight and is refused only at prepare

- **Where:** `sessions/claude.ts:37-41`, `:12-15`.
- **Evidence:**
  - `filesUnder(fs, home, folder)` answers `[folder]` when `projects/<slug>/<id>` is a regular file rather than a
    folder. `discover` no longer filters its list through `carries`, so preflight lists that file.
  - `carries` refuses it, because it is not under `<id>/`. `installSession` then throws `path_unsupported` at
    prepare, after the transfer.
  - Reproduced in the scratch copy: `discover` answered `[<id>.jsonl, <id>]`, and `carries` answered
    `[true, false]`.
  - Before the fix round, the whitelist filter in `discover` caught this at preflight. Claude never writes such a
    file, so the case is theoretical. Prepare still refuses before anything activates, so nothing is lost.
- **Fix:** in `discover`, refuse with `incompatible_adapter` when any listed file is one `carries` refuses. That is one
  `filter` and a throw, and it makes preflight and prepare agree by construction. Otherwise, ledger it as deferred.

### Runs (on e790eb83)

| Command | Result |
| --- | --- |
| `pnpm vitest run --project protocol --project archid --project cli` | 125 files passed, 1 skipped; 2227 passed, 5 skipped (matches the report) |
| `pnpm vitest run --project @archipelago/desktop-web` | 708 passed |
| `pnpm typecheck` | clean |
