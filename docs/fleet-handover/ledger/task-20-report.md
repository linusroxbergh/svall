# Task 20 report: safe destination replica records and divergence checks

Status: DONE_WITH_CONCERNS
Commit: 5165430 Inactive replicas cannot be overwritten without proving their baseline (BASE e5a0efb, no attribution)
Protocol: unchanged. Nothing under `handover/sessions/`, Task 24's files or `protocol/handover.ts` was touched.

## What was built

### `handover/replicas.ts`: `ReplicaStore`, one per fleet on the machine it runs on

**Records.** `ReplicaRecord` is a zod union on `state`:

| State | Fields | Meaning |
| --- | --- | --- |
| `reserved` | `transactionId` | Written before the root exists |
| `receiving` | `transactionId`, `excludes`, `baseline`, `incoming` | A transaction writes into the root. `baseline` is what was proven there at claim; `incoming` is what the transaction brings |
| `sealed` | `sealedBy`, `generation`, `manifestDigest`, `excludes`, `baseline` | The content a completed handover left |

- Every record also carries `version: 1`, `fleetId` and the canonical `path`.
- A record lives at `paths.replicaRecord(fleetId, canonicalPath)`, which is `<fleetHome>/replicas/<fleetId>/<sha256(canonical path)>.json`.
- Records are mode 0600 and nothing is ever written inside a root.
- A record that cannot be parsed, or that names another path or fleet, blocks as `destination_occupied`.

**Canonical path.** This is the real path on this machine, taken with `fs.realpathSync.native` so macOS gives the on-disk case. For a path that does not exist yet, it is the deepest existing ancestor's real path with the rest joined back on. Every key, existence check and fleet-home comparison uses it.

**`inspect(root, { transactionId?, excludes })`** is read-only, for destination preflight. It returns one of:

- `{ ok: true, kind: 'absent' | 'resume' | 'replica', path }`
- `{ ok: false, blocker, divergence? }`

The blockers are:

- `path_unsupported`
  - The root path is not a plain absolute path.
  - The root overlaps the fleet home by real path.
- `destination_occupied`
  - The path exists with no record, even when it is a copy of the same Git repository.
  - A reserved record sits over a non-empty root.
  - The record is unreadable.
- `path_collision`: a parent of the root is a file.
- `destination_diverged`: the root differs from its baseline. The blocker carries a divergence report.

**`claim(root, { transactionId, excludes, incoming })`** gates the write. rsync may write a root only after an ok claim, and `--delete` is covered by the same claim.

- **Absent root:**
  1. The `reserved` record is created exclusively: a finished temp is `link`ed into place, and EEXIST throws `ReplicaError('conflict')`.
  2. Then the root is created exclusively: parents with `mkdir -p`, the leaf with a non-recursive `mkdir`, or `wx` for a file root.
  3. The record becomes `receiving` with an empty baseline.
  - If the root appears between the check and step 2, the reservation is given back and the claim returns `destination_occupied`.
- **Same transaction's `receiving` record:** `resume`, with no re-hash, as the spec's cheap resume requires.
- **`sealed` record:** the root must prove it matches its baseline.
- **Another transaction's `receiving` record** (an aborted partial): the root must prove every path matches the claim-time baseline or that transaction's incoming files.
  - On proof, the record becomes `receiving` for the new transaction, and its baseline is the content just proven.
- **Crash between creating a reserved root and marking it:** an empty root under a `reserved` record is adopted, since an empty root holds no one's work. A non-empty one is refused.
- **Sealed or partial record whose root is gone:** reserved afresh.
- **Concurrent callers:** every record replacement checks the bytes it read before the async proof, in one synchronous step with the durable write. A change made meanwhile throws `conflict`.

**`seal(root, { transactionId, generation, manifestDigest, excludes, files }, side)`**

- Idempotent for the same transaction.
- `'destination'` seals only a root this transaction claimed; anything else throws `not_claimed`.
- `'source'` seals the copy the old machine leaves behind, whatever record was there. Without this the return trip finds the originals "occupied".
- `files` is validated: relative, no `.`, `..` or empty step, no control characters, no duplicates, and exactly `''` for a file root.
  - A dangerous path throws `invalid`.
  - The same validation blocks a claim with `path_unsupported`.

**`archive(root, approved)`**

- Refuses with `not_approved` unless `approved` (for example `HandoverChoices.archiveRoots`) names the root by id, by the path as given, or by its canonical path.
- Refuses the fleet home, or anything holding it, with `invalid`.
- Moves the root to `<path>.archived-<YYYY-MM-DDTHHMMSSZ>[-n]` from the injected clock:
  - a folder by `mkdir` of an empty sibling (EEXIST moves on to the next name), then `rename` onto that empty folder;
  - a file by `link` (EEXIST moves on), then `unlink`.
- Nothing already holding a name is ever replaced.
- Removes the record and returns `{ path, archivedTo }`, the recovery path.

**Fleet-home rule, by real path.**

- A root that holds the fleet home, or lies inside it, is refused.
- Two exceptions, each only when it is reached with no link that leads elsewhere inside the fleet home:
  - the fleet `.env`, for an `env` root whose lexical path is `paths.env`;
  - mission control's own folder, for a `home` root.
- So `<fleetHome>/home` symlinked to `<fleetHome>/keys`, and `.env` symlinked to `token`, are both refused. That is the destination-side half of the Task 19 minor.

`replicaRoots(manifest, side)` lists the carried (unfolded) roots at their path on each side. `relativeProblem(p)` is exported for Task 26's manifest re-validation.

### `handover/divergence.ts`

- **`proveReplica(at, accepted, excludes)`** scans the replica with the manifest's own scan (`scanPath`) and compares it with each accepted version.
  - It drops the configured excludes on both sides, so host-local caches never count.
  - `.git` is never excluded (Task 19's matcher), and `.gitignore` is never read, so a gitignored file is divergence.
- **`compareReplica`**:
  - A path matches when it equals some version's entry (sha256 and mode for a file, target for a link; mtime ignored), or is absent where some version lacks it.
  - Added, removed and changed paths are sorted by code unit, with whole counts and a bounded preview (10 per kind by default).
  - Names the scan cannot carry (control characters, invalid UTF-8) and unreadable folders are `unchecked`, and they block too.
- **`divergenceBlocker`** builds `destination_diverged`: counts and previews per kind, and the three ways on (recover by hand, remap, archive).

### Supporting changes

- `durable.ts`: `createDurable(file, data)`, an exclusive durable create (temp, fsync, `link`, fsync dir, 0600). A new `link` stage lets tests crash or race it. `writeDurable` now shares `writeTemp`, with no behaviour change.
- `manifest.ts`: `scanRoot` became the exported `scanPath(top, excluded, sfs, contents)`, so a replica is read exactly as its source was. No behaviour change.
- `portable-path.ts`: `realPath(p, realpath?)` takes an injectable realpath.
- `paths.ts`: `replicaRecord(fleetId, canonicalPath)`.

## Tests

`pnpm vitest run --project archid test/handover/replicas.test.ts test/handover/divergence.test.ts` gives 37 passed: 27 in replicas and 10 in divergence. `durable.test.ts` gains 2, for 23.

The replicas tests cover:

- Record location, key and mode, and that nothing is written inside the root.
- `replicaRoots`.
- An unreadable record.
- The reservation record written before the root is created, observed through an injected `mkdir`.
- Two concurrent claims, where exactly one wins. A check-then-write would let both win.
- A record raced in before the link.
- A root raced in before the `mkdir`: the reservation is given back and the stranger's file is untouched.
- A file root.
- Three crash windows: before creating, after creating but before marking, and a filled root under a reservation.
- An unowned copy of the same repository being refused.
- A same-transaction resume that never scans.
- Seal: only the claiming transaction, idempotent, source side, and invalid manifest paths.
- A sealed replica: claimed after proof, left as it was after divergence, reservable once gone, and a conflict when the record changes during the proof.
- An aborted partial taken over when clean and blocked when edited.
- Real-path keying through a symlink.
- The fleet home through a symlink, holding it, and the `.env`/mission-control exemptions with and without inner links.
- Archive: approval, collision with an existing directory and file, a sibling raced in before the move, a file root, and a refusal for the fleet home.

The divergence tests cover:

- mtime is ignored.
- Ordering, counts and preview bound.
- Mode and link changes.
- Two-version acceptance.
- Unchecked entries.
- Caches versus a gitignored file versus `.git/refs/heads/build/x`.
- Unreadable folders and control-character names.
- A later transaction's new excludes.
- A file root.
- Blocker wording.

## TDD evidence

RED, with the tests written first and no module present:

```
$ pnpm vitest run --project archid test/handover/replicas.test.ts test/handover/divergence.test.ts test/handover/durable.test.ts
 FAIL |archid|  test/handover/divergence.test.ts [ packages/archid/test/handover/divergence.test.ts ]
 FAIL |archid|  test/handover/replicas.test.ts [ packages/archid/test/handover/replicas.test.ts ]
Error: Failed to load url ../../src/handover/divergence.js ... Does the file exist?
 FAIL |archid|  test/handover/durable.test.ts > createDurable > creates a whole file at mode 0600, and refuses a name already taken without touching it
 FAIL |archid|  test/handover/durable.test.ts > createDurable > leaves no file when it crashes before the link, and the whole file after it
 Test Files  3 failed (3)
      Tests  2 failed | 21 passed (23)
```

GREEN: `Tests 56 passed (56)`.

Two further RED/GREEN rounds came out of self-review:

1. **Tightening the fleet-home exemptions.** The new tests were run against the old rule:
   `real paths > refuses a root that reaches the fleet home …` and `refuses mission control's folder or the fleet .env when a link leads them elsewhere`, `Tests 2 failed | 24 passed (26)`. The new rule gives 57 passed.
2. **`proveReplica`,** which leaves newly excluded paths out of both sides and always reads a file root:
   `TypeError: proveReplica is not a function`, `Tests 4 failed | 33 passed (37)`. With the change, `Tests 60 passed (60)` across the three files.

Mutation checks: each line was changed, the focused tests run, and the file restored. Every one turned a test red.

| Mutation | Tests failed |
| --- | --- |
| No CAS on record replace | 1 |
| Reserve with `writeDurable`, not exclusive `createDurable` | 3 |
| Seal without the claimed-by check | 1 |
| No same-transaction resume shortcut | 2 |
| No fleet-home check | 2 |
| Adopt any reserved root | 1 |
| Archive by plain `rename` | 3 |
| Create root before writing the record | 3 |
| Adopt an unowned existing root | 1 |
| Partial compared to its baseline only | 2 |
| Archive without approval | 1 |
| "Removed" when any version holds the path | 2 |
| Ignore mode | 1 |
| No cache excludes in the scan | 2 |
| Exclude filter applied to the file root itself | 1 |
| No exclude filter on the accepted versions | 1 |

Full runs, once each:

- `pnpm typecheck`: clean.
- `pnpm vitest run --project protocol`: 106 passed.
- `pnpm vitest run --project archid`: 852 passed and 3 failed. None of the 3 is caused by this change:
  - Two `fleet.test.ts` revive cases are the known flake. `test/fleet.test.ts` alone gives 37/37.
  - `inventory.test.ts > carries a path inside mission control …` is a pre-existing flake; see concerns. It passes alone and fails 4 of 10 runs on an untouched copy of HEAD e5a0efb.

## Files changed

- Created in `packages/archid/src/handover/`: `replicas.ts`, `divergence.ts`
- Created in `packages/archid/test/handover/`: `replicas.test.ts`, `divergence.test.ts`
- Modified in `packages/archid/src/`: `paths.ts`, `handover/durable.ts`, `handover/manifest.ts`, `handover/portable-path.ts`
- Modified: `packages/archid/test/handover/durable.test.ts`

## Interfaces for Tasks 23, 26, 27 and 28

```ts
// packages/archid/src/handover/replicas.ts
new ReplicaStore({ fleetId, paths, fs?, scanFs?, stages?, now? })
replicaRoots(manifest: Pick<TransferManifestV1, 'roots'>, side: 'source' | 'destination'): ReplicaRoot[]  // { id, kind, entry, path }
store.inspect(root, { transactionId?, excludes }): Promise<ReplicaCheck>
store.claim(root, { transactionId, excludes, incoming: TransferFile[] }): Promise<ReplicaCheck>  // throws ReplicaError('conflict')
store.seal(root, { transactionId, generation, manifestDigest, excludes, files }, 'source' | 'destination'): void
store.archive(root, approved: readonly string[] | undefined): { path; archivedTo }
type ReplicaCheck = { ok: true; path: string; kind: 'absent' | 'resume' | 'replica' }
                  | { ok: false; path: string; blocker: Blocker; divergence?: Divergence };
ReplicaError.code: 'conflict' | 'not_claimed' | 'not_approved' | 'invalid' | 'missing'
relativeProblem(p): string | undefined   // manifest path validation for Task 26
// packages/archid/src/handover/divergence.ts
proveReplica(at, accepted: TransferFile[][], excludes, sfs?): Promise<{ divergence; files }>
compareReplica(accepted, found, unchecked?, limit?): Divergence   // { added, removed, changed, unchecked: { count, preview } }
diverged(d): boolean;  divergenceBlocker(root, at, d): Blocker
// durable.ts: createDurable(file, data, opts?) · manifest.ts: scanPath(top, excluded, sfs?, contents?) · paths.ts: replicaRecord(fleetId, canonicalPath)
```

Intended flow:

1. **Destination preflight (Task 26/27).** Call `inspect` for each `replicaRoots(manifest, 'destination')` with `manifest.excludes`, and collect the blockers.
2. **Transfer (Task 23).**
   - Immediately before rsync touches a root, the destination daemon runs `claim` with the manifest root's `files` as `incoming`.
   - rsync writes only after `ok`, into `check.path` (canonical), with `--delete` allowed.
   - The controller reaches the store through a destination RPC that does not exist yet; Task 25/26 must add it. The store is archid-local and runs where the root lies.
3. **Complete (Task 27).**
   - The destination calls `seal(..., 'destination')` and the source calls `seal(..., 'source')` (roots at `sourcePath`), with `generation` g+1, the manifest digest and the verified `files` from the last pass.
   - Seal before the gateway clears the transaction. If the clear happens first, a crash between the two leaves the roots unsealed with nothing left to resume.
4. **Archive (Task 28/29).** Call `archive(root, choices.archiveRoots)` only when the user or the CLI flag names that root.

## Self-review and concerns

1. **Likely false divergence from Git housekeeping.** `.git` content is compared byte for byte, so these would block the next handover:
   - a plain `git status` on an inactive replica (shell prompt, IDE) rewriting `.git/index` stat data;
   - an IDE's background fetch touching `FETCH_HEAD` and remote refs.

   Task 21 (index and staged-blob validation) may want to compare `.git/index` semantically. This task only honours the brief: configured caches are ignored, nothing else is.
2. **Pre-existing flake, not mine.** `inventory.test.ts:325` asserts a fixed blocker order. `settle` sorts by canonical JSON, where `entity.id` (`r_<sha of a random /tmp path>`) precedes `message`. It failed 4 of 10 runs on an untouched copy of HEAD. Comparing as a set would fix it; it is in Task 19's file, so I left it.
3. **Exclusivity scope.**
   - Truly exclusive across processes: the first reservation (`link`), root creation (`mkdir`/`wx`) and archive names (`mkdir`/`link`).
   - Replacing an existing record is a byte CAS inside one synchronous step, which is exclusive within one daemon only. Two archid processes on one fleet home are not guarded.
   - Accepted narrow window: another fleet on the same machine reserves the same absent path, and this daemon crashes between a failed `mkdir` and giving its record back. A retry could then adopt the other fleet's still-empty root. No user work is at risk.
4. **Mode is part of equality.** Task 23's rsync must preserve permissions (`-a`/`-p`), or every file reads as changed.
5. **Stray temp files block takeover.** Leftover rsync temps (a SIGKILLed receiver) or a `--partial-dir` inside a root read as "added" when a *different* transaction takes over a partial copy. That is the safe side, and the user can archive. Task 23 should keep partial dirs out of roots or add them to the excludes.
6. **Transcripts have no records.** Session destinations (`TransferSession`) are not transfer roots. Task 22's adapters own whether an existing transcript on the destination may be overwritten.
7. **Rare false positive near mission control.** A non-`home` root inside mission control's folder that was not folded into it (only when an excluded component lies between) is refused as a fleet-home overlap.
8. **Cost.** Records hold baseline and incoming file lists inline. Proving an existing replica hashes the whole root twice per handover, at preflight and at claim. Both are for Task 38.

## Fix round 1

Finding (Important): `assess` proved a replica over `[...r.excludes, ...excludes]`. A path the sealing handover excluded stayed out of the proof after the user dropped that exclude, but rsync `--delete` only spares what the current run excludes. Destination-only files there could be deleted or overwritten after an ok claim.

### What changed

- `replicas.ts` `assess`: `proveReplica(at, accepted, excludes, …)` now gets only the current transfer's excludes. `proveReplica` already filters the accepted versions with the same matcher, so a formerly excluded path that the transfer now carries shows as `added` and blocks.
- Nothing else read the record's `excludes`, so the field is gone from the `receiving` and `sealed` records, and from `Seal`. `Inspect.excludes` and `Claim.excludes` stay, because the proof uses them.
  - Interface change for Task 27: `store.seal(root, { transactionId, generation, manifestDigest, files }, side)`, with no `excludes`.
- `replicas.test.ts`:
  - New test: `a sealed replica > blocks on what the handover that sealed it excluded once this transfer carries that path`. The root holds `a.txt` and `data/built.bin`. It is sealed with a baseline scanned under `EXCLUDES + data/`. Then `inspect` and `claim` run with `EXCLUDES` alone. Both must return `destination_diverged` with `added: ['data/built.bin']`, and the sealed record must stay untouched.
  - `sealAs` and the sealed-record `toEqual` no longer carry `excludes`.

### RED (new test, before the fix)

The RED run sealed with `{ ...sealAs('tx-0', baseline), excludes: [...EXCLUDES, 'data/'] }`, so the record carried the old excludes the proof then merged in. Once the field was dropped, the setup seals the same baseline without it.

```
$ pnpm vitest run --project archid test/handover/replicas.test.ts -t "excluded once this transfer"
 FAIL |archid|  test/handover/replicas.test.ts > a sealed replica > blocks on what the handover that sealed it excluded once this transfer carries that path
AssertionError: expected { ok: true, …(2) } to match object { ok: false, …(2) }
-   "blocker": Object { "code": "destination_diverged" },
-   "divergence": Object { "added": Object { "preview": Array [ "data/built.bin" ] } },
-   "ok": false,
+   "ok": true,
 ❯ test/handover/replicas.test.ts:290:21
 Test Files  1 failed (1)
      Tests  1 failed | 27 skipped (28)
```

### GREEN

```
$ pnpm vitest run --project archid test/handover/replicas.test.ts test/handover/divergence.test.ts
 ✓ |archid| test/handover/divergence.test.ts (10 tests)
 ✓ |archid| test/handover/replicas.test.ts (28 tests)
 Test Files  2 passed (2)
      Tests  38 passed (38)

$ pnpm typecheck
tsc --noEmit -p tsconfig.json && tsc --noEmit -p apps/desktop/web/tsconfig.json   (exit 0)
```

`divergence.test.ts > leaves out of both sides what a later transaction newly excludes` still passes unchanged.
