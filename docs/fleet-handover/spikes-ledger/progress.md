# SDD ledger — plan: /Users/linusroxbergh/linus_laboratory/archipelago/docs/superpowers/plans/2026-09-20-fleet-handover.md

Scope of this run: Tasks 2, 3, 4 (M0 spikes). Task 1 already complete (commit 4101fde, boxes ticked in plan).
Worktree: .claude/worktrees/fleet-handover-task1, branch fleet-handover-task1. Spec read: docs/superpowers/specs/2026-09-20-fleet-handover-design.md.

## Preflight scan

| Pair / task | Produces vs consumes | Found |
|---|---|---|
| Task 2 vs Task 3 | disjoint files (fixtures/handover/codex, test/handover/codex-*, scripts/probe-codex-* vs test/handover/worktree-*, scripts/probe-worktree-*) | no conflict |
| Task 2 vs Task 4 | disjoint (Task 4: scripts/spikes/, test/gateway/relay-contract.test.ts, spike-results doc) | no conflict |
| Task 3 vs Task 4 | disjoint | no conflict |
| Task 2 self | test + probe + README + fixture; mirrors Task 1 shape | consistent |
| Task 3 self | test + probe; "test helper for Task 21" lives inside the test file/probe | consistent |
| Task 4 self | needs clean Ubuntu container + tailnet machine; results doc path is under gitignored docs/superpowers | see rulings |

## Rulings

- Ruling: Task 4's clean-Ubuntu run uses the real target linus-vault (ssh 100.117.42.24, Ubuntu 24.04 x86_64, no pnpm/checkout) under a disposable temp dir, not a Docker container — Docker Desktop is not running and the real target is stronger evidence — cost if wrong: temp files left on the server.
- Ruling: Task 4 may add one path-based `tailscale serve` mapping on linus-vault for the WebSocket spike and must remove it afterwards; the existing `/` -> 127.0.0.1:8787 mapping is never touched — cost if wrong: a stray serve path.
- Ruling: fleet-handover-spike-results.md is written at the main checkout's gitignored plans path beside the plan (canonical location for these docs) — cost if wrong: not in git history.
- Ruling: Tasks 2–4 run sequentially in one worktree even though independent (shared index) — cost: wall-clock.
- Ruling: Task 2 may copy the user's own ~/.codex/auth.json into disposable temp CODEX_HOMEs on this Mac for the live resume test, deleted afterwards, never into the repo — the remote has no Codex installed so cross-machine proof is deferred to release checks — cost if wrong: none beyond local temp files.
- Ruling: no attribution trailers in any commit (user CLAUDE.md).

## Progress
- Task 4 prep: codebase facts saved to task-4-facts.md
- Task 2: implementer DONE_WITH_CONCERNS, commit a161a0f. Findings for spike-results: rollout alone suffices (no index/sqlite); item.cwd is a file:// URI; missing login = mid-turn 401, not session-not-found; stale session_meta.cwd does not block resume; cross-machine unproven (no Codex on linux-vault). Spec Codex paragraph amended by implementer. Review dispatched (base 4101fde, head a161a0f).
- Task 2: review found 1 Important (missing exact login-check command in README), 1 Minor. ⚠️ items verified by controller: commit has no trailers; spec Codex paragraph amended. Fix round 1 dispatched (resume implementer).
- Task 2: fix round 1/5 dispatched fix, commit a457353 (login check = codex login status; probe header note). Scoped re-review dispatched (haiku). Task 3 implementer dispatched in parallel (base a457353).
- Task 2: complete (commits 4101fde..a457353, review clean after 1 fix round)
- Ruling: Task 4 implementer runs in parallel with Task 3 in the same worktree (disjoint files, path-scoped `git add`, index.lock retry) — the user asked for sub-agents where possible and Task 4 is long — cost if wrong: a mixed commit that needs splitting.
- Ruling: Task 4 also owns the tmux 3.4 and Mac openrsync spec/plan amendments and the interop tests behind them, since it owns release/packaging decisions — cost if wrong: an over-broad task.
- Task 4 implementer dispatched (opus), base a457353. Results doc will carry a "Task 3 pending" heading for the controller to fill.
- Task 3: implementer DONE_WITH_CONCERNS, commit 9e00063. Spec findings: prune unlisted registrations BEFORE repair (repair first corrupted the source's unused worktree gitfile); steps 1-2 redundant with repair; never use git worktree prune; submodule origin still names source; git 2.55. Review dispatched.
- Task 3: minor (deferred): 12-line header comment in scripts/probe-worktree-handover.mjs:296-307 is long for house style; .d.mts shim is an unlisted file (justified, no allowJs).
- Task 3: complete (commits a457353..9e00063, review clean). Commit trailer verified clean by controller. Plan boxes ticked.
- Pending after Task 4: spec amendment for Task 3 findings (prune-before-repair, steps 1-2 belt-and-braces, forbid `git worktree prune`, submodule origin remote unchanged) and the Task 3 section of the spike-results doc — deferred to avoid concurrent edits of the spec while Task 4 edits it.
- Task 4: implementer DONE_WITH_CONCERNS, commit caa7c0d (esbuild ^0.28.2 added). Failed assumptions: openrsync unusable -> Mac must bundle rsync 3.x; import.meta.url climbs break under bundle -> Task 12 needs release.ts + ARCHI_RELEASE_ROOT; 'archi version' does not exist; tmux 3.4 rejects only extended-keys-format; tailscale serve strips path prefix -> Task 30 needs configured public base. Remote cleanup verified by controller (serve status intact, no temp dir, no ~/.local/share/archipelago). Review dispatched (opus, base 9e00063). Doc agent dispatched for Task 3 results section + spec Git-graph amendment.
- Docs: Task 3 section of spike-results filled; spec Git-graph importer list amended (prune before repair, no git worktree prune, submodule remotes warned). Doc agent done.
- Task 4: review found 2 Important (no fleet fence on owner->viewer routing in fake-gateway.ts:83,87; Node tarball unverified in build-companion.mjs) + 2 spec gaps (no executable atomic `current` swap; licenses/ incomplete). ⚠️ verified by controller: spec tmux/rsync lines 66-69,310 and plan Tasks 12/23 amended; Task 4 plan boxes ticked; remote clean. Fix round 1 dispatched (resume implementer).
- Task 4: minor (deferred): walk() treats symlinks as files (build-companion.mjs:144-149); `?? 0` bundle size (:124); LOCATE_PROBE interpolates repo path into TS source and probe bundle is hashed into the release (:63-80); `--no-xattrs` is bsdtar-only (:163); decodeBinary has no length guard and JSON.parse unhandled (fake-gateway.ts:24-27,82,105); viewer frame after owner drop silently discarded (:106); 400 non-integer generation untested (:72); twoTap length-0 assertion racy (relay-contract.test.ts:263); afterEach derefs undefined gateway if boot throws (:68,77).
- Task 4: fix round 1/5 fix landed c4171e4 (fleet fence + two-fleet test; Node SHASUMS verify; scripts/spikes/install-release.mjs atomic current swap; 23 bundled licenses). Scoped re-review dispatched (sonnet).
- Task 4: minor (deferred): install-release.mjs extracts into releases/<version>/ before digest verification completes, leaving a partial dir on mismatch (current untouched).
- Task 4: complete (commits 9e00063..c4171e4, review clean after 1 fix round)
- Final review: package built for 25abac716bf1f48c3b2a8f8535f1b2c48d91364c..HEAD, dispatch on opus.
- Final review (opus): Needs fixes — 3 Important: install-release unpacks before authenticating and trusts archive version token; relay contract lacks frame-validation obligation/guard; spec vs reconstruct() step order. M0 assessed: all four promises proven or narrowed honestly. Deferred minors triaged: all stay deferred except install ordering (folded into Important 1).
- Ruling: for Important 3 the code follows the spec — reorder reconstruct() to prune → rewrite → repair — the safety property (prune before repair) holds either way and the tests cover it — cost if wrong: none beyond a re-run.
- Final fix wave dispatched (single dispatch, resume Task 4 implementer): 3 Important + 4 cheap Minors (version-token validation before rmSync; Claude probe lstat symlink refusal; reconstruct empty-list guard; Task 12 obligation line for walk()/modes). Fix base c4171e4.
- Final fix wave landed 08b83ac, bbcbe8e. Controller verified: results doc has Install-order row, walk() obligation, HKDF decision, owner-side relay clause, 4 MiB max frame; no trailers in commits; pnpm typecheck clean; full workspace vitest 95 files / 990 tests passed. Scoped re-review dispatched (sonnet, base c4171e4).
- Final fix wave re-review: Important 1, 3, Minor b, c ADDRESSED; Minor d verified by controller (results doc line 297). Two residuals, adjudicated (no second wave):
- Parked — build-companion.mjs:131-137: `--version ..` passes the charset regex and rmSync then deletes the whole --out dir — Ruling: real, deferred; it is an operator-supplied flag on a dev spike script that Task 12 supersedes, and install-release.mjs (the shape Task 13 inherits) has the containment check; surfaced to the user as the first follow-up — cost if wrong: a developer wipes their own build output dir.
- Parked — relay-contract.test.ts:198-222 does not prove a still-open peer keeps working while the other socket's bad frame is handled (the guard code is correct) — Ruling: real, deferred; Task 31 owns the production relay and its tests; recorded as an obligation — cost if wrong: a weaker contract test until Task 31.
- Final review: complete (branch 25abac7..bbcbe8e, 8 commits, 2 parked). Controller evidence: typecheck clean, 95 files / 990 tests green.
- 2026-09-22: user asked for the container run the plan specified. Docker Desktop started (29.4.3 arm64). Implementer dispatched (opus): build linux-arm64 + linux-x64 companions, install and run in clean ubuntu:24.04 containers, tmux 3.4 config check, results-doc subsection; report task-4-docker-report.md. Base bbcbe8e.
- Docker run done, no commits: arm64 native PASS 8s, amd64 (Rosetta) PASS 13s from clean ubuntu:24.04; arm64 companion now proven-in-container. Task 12/13 findings: archid has no --help (daemon starts); bare Ubuntu lacks ssh-keygen so signature verify fails closed with a misleading message; archi doctor remedies are macOS-only. Results doc updated.
