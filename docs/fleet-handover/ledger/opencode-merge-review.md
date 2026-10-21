# Review: merge 8d5efd6e (origin/main 18efb2ab into fleet handover 2b6dcc2f, base c1905f05)

**Verdict: Needs fixes** (one Important code finding, one Important doc finding; the rest Minor).

Verification on 8d5efd6e: `pnpm typecheck` clean; vitest svalld+cli+protocol 142 files / 4135 tests pass; desktop-web 75 files / 902 tests pass.

Checked and sound: the `--cc` resolutions in config.ts (agentsOff/integrations land in NodeConfig, split via `splitLegacy`, `withIntegrations` applied on merge and legacy read), main.ts (free-port fallback kept: `port ?? DEFAULT_PORT`, EADDRINUSE → `listen(0)`; clients read the port file, `localConnectionInfo` too), doctor's port check (legacy vs node.json), tmux `paste` signal, guard `worktrees.set`, portable-path classes for `worktree`/`keepHere`/`revive.interrupted`, `reviveCommand` for opencode on a slot, second-terminal revive via `withStandalone`, build.noindex paths in build.sh/app-build.sh/release.sh/sign.sh, status-report skill (unchanged vs main), uninstall/setup keep the OpenCode plugin, HANDOVER_KINDS refusal (manifest.ts catch + `agentBlockers`). Migration v7/v8→9 is idempotent for both lineages (`liftV9` fills `second.cwd` only when absent; main-v8 OpenCode file round-trips, protocol/test/migrate.test.ts:28-47); backup stays `state.json.v<old>-<time>`, and `keptCopy` on 0.5.1 looks for `.v8-`, which this release writes.

## Important

### 1. `resumeInterrupted` never resumes a character any handover has ever rested
- packages/svalld/src/fleet.ts:585 filters `c.revive?.interrupted && !c.restedBy`.
- `restedBy` is set at packages/svalld/src/handover/rest.ts:329 and never deleted anywhere (`grep restedBy packages/svalld/src` has no delete; `doRevive` clears `revive`/`resumeError` only, fleet.ts:614/632). It travels in the snapshot (portable-path.ts:102), so after a completed handover every carried character on the destination, and every one an aborted handover rested on the source, keeps it for good.
- Effect: once a fleet has been handed over (or a handover aborted), main's guarantee that a quit/reboot/crash mid-turn resumes the agent with RESUME_NOTE is silently lost for those characters. With handover off it is never set, so off-flag behaviour equals main.
- No test covers the filter either way (fleet.test.ts:630, 1907 exercise only the unrested path).
- Fix: scope it to an open transaction, not a stale marker: filter `!this.carried(c.id)` (the hook the handover service already wires, destination.ts:814-821), or clear `restedBy` when the destination answers for the terminal / on `complete` and on source abort. Add a test: a character with a stale `restedBy` from a closed journal and `interrupted` resumes.

### 2. migration.md "Downgrading" describes the pre-OpenCode release, not 0.5.1
- docs/remote-machines/migration.md:49-58: "a build from before remote machines (protocol 16, state schema 7)", log `version 8, newer than this svalld reads (7) … state.json.v7-<time>`. A 0.5.1 user going back gets `version 9, newer than this svalld reads (8)` and the hint names `state.json.v8-<time>`.
- :79 `cp "$(ls -t state.json.v7-* | head -1)" state.json` finds nothing for anyone who upgraded from 0.5.x (their copy is `.v8-`); `cp` fails and the fleet stays unreadable.
- :93-100 relabel says set `8` to `7`; it must be `9` to `8` for 0.5.1 (still dropping dormant seconds, since 0.5.1's `Second` requires `tmux`), or `9` to `7` plus dropping OpenCode characters for a pre-0.5 build. "This was checked by running…" is no longer true for either.
- Fix: rewrite against 0.5.1 (protocol 19, schema 8): `ls -t state.json.v8-* state.json.v7-* | head -1`, relabel `.version = 8`, re-run the downgrade check, and say a pre-OpenCode build also needs OpenCode characters removed.

## Minor

### 3. Abort revive of a terminal a dead rest closed gets RESUME_NOTE, unlike every other rest
- packages/svalld/src/handover/source.ts:517-518 call `markDormant(c, t.flags)`, which (dormancy.ts:41-43) sets `revive.interrupted` when the agent is still `working`/`blocked` in state, i.e. exactly when the rest died between kill-window and `lay`. `reviveCharacter` then prepends RESUME_NOTE (fleet.ts:625) and submits it, so the agent starts a turn on its own. rest.ts:330-331 states the opposite policy ("a rest the handover chose is no crash … without the note") and deletes the flag.
- Fix: `delete c.revive?.interrupted` after markDormant there, matching rest.ts:331; one source.test case for the crash-mid-rest abort.

### 4. `importState` drops a genuine `interrupted` on carried characters
- packages/svalld/src/handover/validate.ts:126-132: `kept = { command: portableRevive(...) }` replaces `revive`, losing `interrupted: true` on a character that was dormant from a real crash (e.g. its startup resume failed). The destination then resumes it without telling it what was lost. Conversely a character with no `kept` but stale `working` status would gain the flag from `markDormant`.
- Fix: carry `interrupted` into `kept` (`{ command, ...(t.revive.interrupted && { interrupted: true }) }`) or decide explicitly that a handover clears it, and test it.

### 5. destination `lay` can leave `interrupted` behind under `restedBy`
- packages/svalld/src/handover/destination.ts:798: `markDormant(cur)` on a terminal whose resumed agent already went `working` sets `interrupted`; when `carried.sessionId` matches it is overwritten, otherwise it stays. Harmless today only because finding 1's filter hides it; once 1 is fixed this terminal would auto-resume with RESUME_NOTE on the next start. Decide which is wanted when fixing 1.

### 6. `adopt()` writes 47800 into the in-memory config
- packages/svalld/src/handover/destination.ts:152 `NodeConfig.parse(config)`: `config.port` is `undefined` under main's free-port design, so the default `47800` lands in `config.port` (wrong for Svall Dev's 47900). Nothing reads `config.port` after start (main.ts:207 only), and nothing persists it, so no behaviour changes today.
- Fix: parse with config.ts's `NodeFile` (port optional), or keep `port` from `config`.

### 7. Migration test gap for the branch-v8 lineage
- protocol/test/migrate.test.ts covers v7/v8 with a live second and main-v8 OpenCode, not a branch-v8 file with a dormant second (`cwd`, no `tmux`, `revive`, `restedBy`) and `keepHere`/`resumeError`. Add one asserting it passes through unchanged at v9.

## Re-review (8d5efd6e..4ea77cee)

**Verdict: Approved.**

Verification at 4ea77cee: typecheck clean; svalld+cli+protocol 4139 pass, 1 fail (fleet.test "hands claude its prompt as an argument"), which passed in 2 out of 2 lone reruns of fleet.test.ts (127/127), so it is a load flake.

| # | Status | Evidence | Test load-bearing? |
| --- | --- | --- | --- |
| 1 | ADDRESSED | fleet.ts:585 filters `!this.carried(c.id)`. `carries` is wired in the DestinationHandover constructor (destination.ts:181), before `resumeInterrupted` runs at start. `carrying` holds only for an open destination journal. A source with an open journal is frozen, so the `writable()` gate covers it. | Yes. fleet.test "resumes an interrupted agent a closed handover once rested…" fails under `!c.restedBy` (the stale `tx-old` case) and covers the carried case too. |
| 2 | ADDRESSED | The Downgrading section now targets 0.5.1 (protocol 19, schema 8): `v[78]` glob, relabel 9→8, a pre-OpenCode path with relabel to 7 and OpenCode characters dropped, re-checked against 0.5.1 and 0.3.2. | n/a (doc) |
| 3 | ADDRESSED | source.ts:518 deletes `interrupted` after `markDormant`. | Yes. source.test "revives a working agent whose window a rest that died closed…" would see `interrupted: true` under the old code. |
| 4 | ADDRESSED | validate.ts keeps a crash's `interrupted` on `kept` and clears any `markDormant` adds. | Yes. sessions.test: c1 loses the flag under the old code; c2 checks that no flag is added. |
| 5 | ADDRESSED | destination.ts:798 deletes `interrupted` on the main slot. | Yes. destination.test uses a working agent in a different session, so the carried revive does not overwrite it, and the old code would leave `interrupted`. |
| 6 | ADDRESSED | `adopt` parses with `NodeFile`, where port is optional. | Yes. destination.test asserts `config.port` is undefined; the old code gave 47800. |
| 7 | ADDRESSED | migrate.test lifts a handover-written v8 file (dormant second, `restedBy`, `resumeError`, `keepHere`) unchanged. | It guards against regressions only: `liftV9` already passed this file. |

New: none. The re-review checked no OpenCode-handover behaviour, since that support is still absent by design.
