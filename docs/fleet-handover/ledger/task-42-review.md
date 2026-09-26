# Task 42 — review

Reviewed 632b71cd..8db67a32 on `experimental-remote-sessions` against `task-42-brief.md`, `task-42-report.md`, plan
Task 42, the spec ("Product contract", "Same paths", "Transfer inventory", "Terminal records") and
`review-constraints.md`. Scratch copies, probes and logs are in the session scratchpad under `r42/`.

**Verdict: Approved.** Critical 0, Important 0, Minor 6.

Docs and profiles travel as ordinary replica roots and get divergence, `--delete` and archive like any other root.
The state leaves without any process-bound value. The Linux lock holds and is let go however the daemon dies. Every
test named in the report fails without its change. The six minors are two test gaps, two messages and scans, a
one-time block on machines that seeded profiles before this build, and a stale guide.

## Findings

### Minor

**m1. No test pins the Linux lock to its home, to a start race, or to a linked spelling.**
`packages/archid/test/home-lock.test.ts` (whole file); lock at `packages/archid/src/main.ts:78-89`.
- Every home-lock test uses one home at a time.
- A mutant naming the socket `\0archipelago-archid-constant` passes `home-lock.test.ts` 5/5 on Ubuntu 24.04.
  That name stops a second fleet on the machine from starting. The container's whole archid project run under the
  mutant showed no `already running` failure either (`r42/linux-constname.log`, `r42/linux-constname-suite.log`).
- Probes in `r42/copy/packages/archid/test/zz-lock.test.ts` pass on the committed code on macOS and Linux and catch
  the mutant:
  - two starts of one home at the same instant, in one process (×5) and as two archid processes;
  - two homes started side by side;
  - a second start through a symlinked spelling of the home;
  - a daemon that ends with `process.exit`.
- Fix: add the two-homes and same-instant cases to `home-lock.test.ts`, and the linked-spelling case, which only
  Linux's real-path name needs.

**m2. Another local user can take the abstract name first, and the daemon then says it is already running.**
`packages/archid/src/main.ts:79-82`.
- In the container, user `mallory` bound `\0archipelago-archid-<sha256 of /tmp/fh2>` first. The fleet owner's
  archid then exited 1 with `archid is already running for /tmp/fh2` (`r42/squat.sh`). Under systemd it would
  restart every 2 s with that line.
- Judged acceptable for version 1. The spec's gateway is a user-owned machine, and the squatter gains no access to
  the fleet.
- Fix, smallest first:
  - on Linux, have the refusal say another process, possibly another user's, holds the name;
  - or derive the name from a secret in the 0700 fleet home as well as its path. The secret goes in a 0600 file
    that is created once by `link()`, so two racing starts read the same one, and other users cannot compute it.

**m3. A destination whose `agent-profiles/` was seeded before it received the folder blocks once as occupied.**
`packages/archid/src/fleet.ts:144` seeds the folder, `packages/archid/src/linux/provision.ts:94-107` keeps the old
home's folders, and `replicas.ts` claims it.
- A probe with the real `seedAgentProfiles` and `ReplicaStore.claim` gave:
  - a destination seeded from the same bundle, with the source's folder unchanged: `ok: true, kind: 'replica'`.
    O4 adopts it.
  - the same destination, with the source holding one more profile: `destination_occupied`.
- Machines that meet this:
  - one that owned the fleet before this build, such as m3b;
  - the Mac, if the fleet is on Linux when the Mac upgrades;
  - a gateway whose home ran as a standalone fleet before `host add` rekeyed it. `inUse` lets a standalone home
    at generation 0 with no characters through, and it keeps the seeded folder. This is the one product path.
- The blocker names the root, and `--archive` clears it without loss.
- Fix:
  - accept `--archive` once for the dev machines;
  - for the rekey branch of `provisionFleet`, set the replaced fleet's `agent-profiles/` aside, as
    `agent-profiles.archived-<stamp>`, when it holds only the bundled files.

**m4. The symlinked docs/profiles guard is untested, and its blocker gives advice a fleet's docs cannot follow.**
`packages/archid/src/handover/inventory.ts:218`, message at `:180-185`.
- Replacing `else if (real(p, undefined)) offer(p, kind)` with `else offer(p, kind)` passes `inventory.test.ts` and
  `fleet-home.test.ts`: 37/37 tests.
- With `<fleetHome>/docs` linked elsewhere, the blocker says `… so use <target> instead`, with no entity.
  - The fleet's docs are always read from `<fleetHome>/docs`, so there is no other path to use.
  - Without an entity, the blocker is not tied to the root in the report.
- Fix: for these two roots, say `replace the link with the folder it leads to`, and add a test with a linked `docs`.

**m5. The fleet-home scan misses a template-literal path outside the daemon's start path.**
`packages/archid/test/handover/fleet-home.test.ts:67-75`.
- Adding `` scratch(): void { fs.writeFileSync(`${this.deps.paths.home}/scratch.json`, ''); } `` to `fleet.ts` passes
  all five tests.
- The same write inside `start()` is caught only by the started-daemon listing.
- No such writer exists today. The report's concern 4 names the limit.
- Fix: add ``/\$\{[\w$.]*?(?:home|fleetHome)\}\/([^/`$]+)/g`` to the TS scan. `entry.sourceHome` in `transfer.ts`
  does not match, because of the capital H.

**m6. The pick-up guide still lists what this task closed as owed.** `docs/fleet-handover/README.md:48-51`.
- "Owed before this can ship" still names three gaps:
  - entity docs that "do not travel yet";
  - an `agent.pid` that "travels and must not";
  - the Linux daemon lock.
- Fix: drop those three bullets. The ledger notes that commit is the controller's job.

## Implementer's concerns and the brief's questions

- **(a) Seeding or doc writes on a machine that does not own the fleet: none.**
  - `seedAgentProfiles` is called only from `Fleet.begin()` (`fleet.ts:144`). That runs only when
    `ownership.writable()` (`fleet.ts:114-118`).
  - It copies only while the folder is absent (`agent-profiles.ts:49-53`). An upgrade that adds a bundled profile
    never touches an existing folder, so no replica diverges from it.
  - `setupUser` writes no profile or doc.
  - `docs.create`/`rename`/`delete` and `fs.write` are mutations (`ownership/guard.ts:42-45`).
  - `removeDocs` runs only from island and character deletion.
  - At activation the destination's folder has already landed, so the seed is a no-op.
- **(b) Adopting a byte-identical or bundled-only folder.** A byte-identical folder is already adopted (O4). For a
  bundled-only folder, see m3.
- **(c) The abstract name can be bound first by another user.** Acceptable for version 1. See m2 for the message and
  a cheap hardening.
- **(d) No protocol bump.** Acceptable.
  - `compatibility()` (`handover/source.ts:62-71`) requires the same `release`.
  - Published releases are named by `git describe --always --dirty`, so an older companion is refused at preflight.
  - Two `dev` builds from different checkouts would fail loudly at the destination's schema parse, not silently.
- **Concern 2 (a folder absent at the source is not carried):** acceptable.
  - The app never removes `docs/` or `agent-profiles/`, and an owner's start re-seeds a missing profiles folder.
  - A stale destination copy therefore needs a hand `rm -rf` on the source.
- **Concern 3 (a user exclude like `*.md` drops docs):** acceptable. Excludes are the user's choice. No default
  exclude can match a doc tier, a repo slug (`<name>-<8 hex>`) or a profile file.
- **Concern 7 (`agentsFound` stripped):** fine.
  - The destination's store lacks it only between prepare and activation, when that daemon is read-only.
  - `syncAgents` sets it in `begin()`, which runs again after a `deactivate()`.

## Verified clean

- **Suites.** `pnpm typecheck` is clean.
  - `pnpm vitest run --project protocol --project archid --project cli --project @archipelago/desktop-web`: 190 files
    passed, 1 skipped; 2947 tests passed, 5 skipped.
  - On an rsync copy, the six touched test files passed 172/172 before any change.
- **Tests fail without their change** (each reverted in a scratch copy):
  - portable-path back at dff49798, keeping only the `NOT_BOUND` export: the 3 new classification tests fail, one
    of them on `expected 'codex-silent' to be undefined`.
  - The two pid entries dropped from `PATH_FIELDS`: the stale-pid test fails. It passes on the old code, since the
    F2 strip predates this task.
  - `inventory.ts`, `replicas.ts` and the protocol enum at 632b71cd: the docs/profiles inventory test fails, as do
    the linking, claim and destination tests.
  - A `scratch.json` joined onto `paths.home` in `start()`: the scan test and the started-daemon test both fail.
  - On Ubuntu with 632b71cd's `main.ts`, three of the five home-lock tests fail. The report's
    `hook receiver already running` and log rotation match. With 8db67a32's code, home-lock is 5/5, fleet-home 5/5,
    and the five probes pass.
- **Mutants caught:**
  - `clash` allowing docs/profiles anywhere in the fleet home, or through a link;
  - the destination-fleet-home check skipped;
  - docs/profiles dropped from the roots allowed inside the fleet home, which fails 3 tests.
- **Divergence.** After the destination test's seal, a probe added `docs/fleet/late.md` and changed
  `agent-profiles/reviewer.md`.
  - `inspect` gave `destination_diverged` for each: `1 added (fleet/late.md)` and `1 changed (reviewer.md)`.
  - Docs written on a machine between handovers block and are never overwritten silently.
  - The source seals both roots at Complete (`source.ts:339-352`), as it does every other root.
- **Same keys.** Repo-doc slugs hash the main root's absolute path, which no longer changes. Island and character
  doc folders are keyed by ids that travel. The destination test finds all four tiers and the profile by name.
- **Process-bound fields.** Walked the v8 `FleetState` and `FleetConfig`:
  - `tmux`, `second.tmux`, `panePath`, `agent.pid`, `second.agent.pid` and `hint` are forbidden, and
    `agentsFound` is machine-local. All are stripped by `exportSnapshot` through one loop.
  - `markSlotDormant` resets `status`, `prompt`, `promptId` and `background` at import (`reconcile.ts:22-37`).
  - `restedBy`, `resumeError` and `lastPrompt` bind to no process.
  - `main` has moved two commits past the merge base, both map layout only, with no new state field.
- **Fleet-home entries.** Checked the list against every writer:
  - `resolvePaths` and `installedScripts`;
  - archid: store, config, owner, journal, replicas, archive, log rotation, tmux, `tmux-binary`, `daemon.lock`,
    the hook receiver, mobile key, push, vapid, usage and scribe cwds, `*.prompt`, `ensureHome`, agent profiles and
    docs;
  - cli: controller, route, recoveries and the transaction folders;
  - the hook scripts (`hooks.down`) and the Swift app (`app.pid`, `browser-store`, `controller/events.ndjson`);
  - launchd's log, which is `archid.log`; the systemd units, the gateway prefix and `machine.json` live outside the
    fleet home.
  - Nothing is missing. Secrets never travel, and the `.env` goes only with `transferFleetEnv`.
- **Linux lock:**
  - Released on SIGKILL, with the tmux server still up (committed test), and on `process.exit` (probe).
  - Exactly one of two simultaneous starts wins, on macOS and on Linux. Two fleets run side by side, and a linked
    spelling is refused on Linux.
  - libuv's close-on-exec sockets keep it out of the tmux server.
  - macOS keeps `O_EXLOCK` unchanged.
- **Linux run.** Colima was stopped: started it, used `archi-tmux34` (Ubuntu 24.04.5, node 24.21, tmux 3.4,
  aarch64), then removed the containers, stopped colima and set the docker context back to `desktop-linux`.
- **Delivery rules.** No new subprocess or persistent write in source. The one direct `fs.existsSync` in
  `buildInventory` matches the `realPath`/`entryOf` calls already there. Commit subjects are one sentence with no
  attribution. Comments are 1–2 lines and describe what the code does now. The spec edit matches the change.
