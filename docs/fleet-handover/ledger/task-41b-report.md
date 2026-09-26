# Task 41b — Git and sessions copy unchanged

Branch `experimental-remote-sessions`, commits 5521fa2a..366ced84 (three, not pushed). Uncommitted: this report.

| Commit | What |
| --- | --- |
| 5bbafdc3 | Git import replaces Git repair |
| 49839eec | Session adapters copy byte for byte, minimum version only |
| 366ced84 | Git import leaves a config carried as a link alone (a guard the first commit dropped) |

## What changed, per step

**1. Git import** (`archid/src/handover/git-import.ts` replaces `git-repair.ts`)
- `importGraphs(manifest, { git, probe, kept })` answers `Blocker[]`. For each graph:
  1. the O8 re-probe: `core.ignorecase`/`core.precomposeunicode` set to what `git init` probes here, only when
     `.git/config` is a regular file;
  2. every registration under `<common>/worktrees` that the manifest does not carry and this machine does not keep
     (O6) is removed. Branch refs stay in the common directory;
  3. `validateGraph` checks each checkout's dirs, status, staged entries, `git worktree list` and the stash
     against the manifest.
- No gitfile or `gitdir` is written, and no `git worktree repair` or `prune` runs. Paths are used as recorded, with
  no `map` and no `realpath`. A Git root that no graph describes still blocks.
- Kept as they were: `graphsHere`, `keptWorktrees`, `unreached` (O6), `probeFsRules`/`adaptRules` (O8).
- Gone: `RepairFs`/`realRepairFs`, `repairGraph`, `GraphRepair` and its report, the gitfile/registration link check,
  the "touch nothing until git opens it" pre-check, and the relative/absolute gitfile logic.
- Callers:
  - `destination.ts` prepare calls `importGraphs`. The seal and abort flow is unchanged.
  - `service.ts` (`unreached`) and cli `controller/handover.ts` (`graphsHere`) import from the new module, and the
    archid export is `./handover/git-import`.
- Comments that named "the repair" now name the import: destination, `paths.ts`, `validate.ts`, `inventory.ts`,
  protocol `TransferRoot`, controller, and the destination test titles.

**2. Session adapters** (`archid/src/handover/sessions/`)
- `SessionAdapter` is `kind`, `adapter`, `min`, `sessionStartOnResume`, `discover`, `carries`, `trusts?`.
  `rewrite`, `validate`, `versions` and `supports` are gone.
- `records.ts` keeps only `versionOf`, `transcriptFile` and `filesUnder`. Removed: the path map, the record walker
  and the version range.
- Claude: the record and attachment type lists, the path/evidence specs and the per-record version check are gone.
  Discovery is unchanged: the transcript plus `subagents/*.jsonl`, `subagents/*.meta.json` and `tool-results/*`.
  Any other file in the session folder still refuses the session, per Task 22's rule.
- Codex: the type list, specs and `session_meta` version check are gone. Discovery still finds the rollout alone.
- Minimum version:
  - `adapterFor` is `versionOk({ minVersion: a.min }, version)`, main's check from `agents.ts`. That function now
    takes `Pick<AgentAdapter, 'minVersion'>`, and `Version` is exported. A pre-release above the floor passes.
  - Codex takes `AGENTS.codex.minVersion` (0.155.0; the session floor was 0.155.1).
  - Claude keeps its own floor, 2.1.251, because `AGENTS.claude` has none (see concerns).
  - The blocker reads `a handover carries claude sessions from 2.1.251 on; update this machine's claude 2.1.200 and
    the destination's claude 2.1.250`.
- `installSession` writes the staged bytes as they are. The same/grown/diverged rule and the layout checks are
  unchanged. `sessionPathMap` is gone.
- `manifest.ts` `scanSession` no longer validates records, so the "holds what … adapter does not know" blocker is
  gone. The missing-transcript blocker stays.
- `agent.transcriptPath` on the destination is `destinationHome + <same relative path>`. With the same agent home on
  both machines (the default), that is the recorded absolute path, which the fixture test asserts. A different
  `CLAUDE_CONFIG_DIR`/`CODEX_HOME` still places the session under the destination's home, as the spec's "Agent
  sessions" says.

No protocol change. `PROTOCOL_VERSION` is untouched at 17. The web UI names no repair, rewrite or version range, so
it did not change.

## Tests (failing first)

Run against the old code first (logs in the session scratchpad):

Git (`git-import.test.ts`, run through `repairGraphs` before the new module existed):
- "reads as the source left it at the same paths, with no gitfile written and no repair or prune". This is the
  Task 3 fixture shape via `git-fixture.ts`, which Task 21 built as that fixture extended. It checks each carried
  gitfile and `gitdir` against the parked source's bytes, and `worktree list`.
  - Old result: `expected [ [ 'worktree', 'repair', …(4) ] ] to deeply equal []`.
- "removes each registration the manifest leaves out, and keeps its branch": `unused-branch` and `gone-branch` still
  resolve, and no prune runs.
  - Old result: the same failure.
- "leaves a config carried as a link, and what it leads to, as they came". This one failed against my own first
  import, which wrote through the link. The old repair had this guard.

Sessions:
- The registry reads 2.1.283, 2.2.0, 3.0.0 and 2.1.300-beta.1 (Claude) and 0.157.0 and 1.0.0 (Codex).
  - Old result: `2.1.283: expected undefined to be { kind: 'claude', … }`.
- "carries a session a CLI newer than every fixture wrote, whatever its records hold": version 2.9.0 / 0.170.0,
  unknown record and attachment types, and a new path field.
  - Old result: two `incompatible_adapter` blockers.
- "a $kind session as $version wrote it › arrives byte for byte at the transcript path its terminal recorded, for a
  newer CLI there to resume", for each of the four fixtures (Claude 2.1.251 and 2.1.280, Codex 0.155.1 and
  0.156.1). The test builds the manifest, checks preflight with a newer destination CLI (2.1.283 / 0.157.0), parks
  the source tree, installs, and compares every file byte for byte. `transcriptPath` must equal the recorded path.
  - Old result: `incompatible_adapter` from the newer CLI.
- "lands under the destination agent home … byte for byte": a record naming the source's agent home is not moved.
  - Old result: the transcript bytes differed (the rewrite moved it).
- Agent preflight: 2.1.283 on both machines, and 2.4.0 on the destination, pass; 2.1.250 blocks.
  - Old result: `incompatible_adapter`.
- `source.test.ts` "passes the Mac's Claude Code 2.1.283 on both machines, and a destination release newer than any
  fixture".
  - Old result: `expected [ 'incompatible_adapter' ] to deeply equal []`.

Changed with the implementation:
- the floor blocker's text;
- `source.test.ts` blocks 2.1.200 where it blocked 2.1.999;
- "blocks a session the destination has no agent home for" (split out of the old version-plus-home test);
- `agentAdapters` reports 0 for Codex 0.142.0;
- `sessions-live` (gated) places bytes unchanged and checks the floor through `adapterFor`.

## Deleted

- `git-repair.ts` and `git-repair.test.ts`. Their surviving cases were ported to `git-import.test.ts`: O6, O8,
  validation, idempotence, the bare repository, and the undescribed-root case. Gone with them: the fake-git
  step-by-step repair cases, and the `ARCHI_TEST_SSH` remote case.
- `sessions.test.ts`:
  - the path-map test;
  - the per-fixture validate/rewrite/round-trip cases (12);
  - the Task 1/2 synthetic rewrite cases;
  - both "refuses what a supported release does not write" cases;
  - the partial-last-line case;
  - the verbatim tool-output case.
- The `machines()` step that rewrote fixture paths to the temp home.

## Verification

| Command | Result |
| --- | --- |
| `pnpm vitest run --project protocol --project archid --project cli` | 125 files passed, 1 skipped; 2224 passed, 5 skipped |
| `pnpm typecheck` | clean |

Baseline on 5521fa2a: 125 files, 2241 passed, 6 skipped. How the counts reconcile:
- Git: −15 and the one skipped remote case (`git-repair.test.ts`), +11 (`git-import.test.ts`).
- `sessions.test.ts`: 44 → 30.
- `source.test.ts`: +1.

No load flake fired. The web suite was not run, since the web UI did not change.

## Concerns

- **Claude's floor is not in `AGENTS`.** Main sets none for Claude. Adding one would make `archi doctor` and host add
  warn for every older local Claude. Their text also prints only `x.y` ("needs 2.1 or newer"). So 2.1.251 stays in
  `claude.ts`, and Codex's floor comes from `AGENTS`.
- **`versionOk` lets an unparseable version pass.** Only `versionOf` output reaches `adapterFor`, and that output
  always starts with x.y.z.
- **The sidecar whitelist stays** (Task 22's ruling). A newer Claude that writes a new kind of file into
  `<id>/` still blocks with `incompatible_adapter` until the whitelist learns it. Carrying the whole session folder
  would remove that.
- **The import no longer pre-checks.** It does not check that git can open the copy, or that every carried piece
  arrived, before it removes registrations. Validation then blocks with git's own message, and the next claim
  mirrors the root again.
- **O8 still writes on macOS.** The probe file goes into the common directory during prepare, as before.
- **Not run:** the `ARCHI_TEST_SSH` remote Git case was not ported. On a Mac it could not pass since O8
  (`probeFsRules` ran locally against a remote path), and porting it needs a filesystem seam the importer no longer
  has. `sessions-live` was updated but not run (it needs a remote with this home and real CLIs).
- **Spike evidence is untouched.** `scripts/probe-{worktree,claude,codex}-handover.mjs`, the three `*-portability`
  tests and the fixture READMEs still describe the different-prefix rewrite and repair.
- **`README.md` "Owed" is stale.** It still says the Claude adapter accepts only 2.1.251–2.1.280. That no longer
  holds; I left the guide to you.
