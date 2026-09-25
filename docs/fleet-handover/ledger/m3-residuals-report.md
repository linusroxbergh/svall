# M3 residuals R1–R4 — implementer report

Branch `fleet-handover-impl`, from 2f5e3fcb. Four commits, one per residual:

- fb3d76a6 A resumed claim overlooks a partial rsync copy only of a file it brings, so a dotfile named like one stops the resume
- 8a46cf3d A manifest may come to half a request, so the prepare carrying it and what landed of it is always read, and a request the daemon closes on as too large is refused once and never sent again
- 72bb60d2 A launcher whose helper listens and ends before it is seen to prints the result that run wrote to the events file, and never an earlier run's
- 17a8a0c6 Host remove refuses a gateway while a handover of a fleet it holds is open, and names how to finish or take it back

All test commands ran with `unset ARCHI_HOME ARCHI_CHAR_ID TMUX` from the worktree root.

## R1 — rsync partial names in a resumed claim

**Change** (`packages/archid/src/handover/replicas.ts`): `RSYNC_PARTIAL` now captures the directory and the name
(`/^(.*\/)?\.([^/]+)\.[A-Za-z0-9]{6}$/`), and a new `partialOf(p, incoming)` holds only when `<dir>/<name>` is one of
the claim record's `incoming` paths. The resume branch of `claim` ignores `p` only when `!known.has(p) && partialOf(p, incoming)`.
A destination-only `.env.backup`, or `sub/.a.txt.Qx81Zk` when the claim brings `a.txt` but not `sub/a.txt`, is read as
destination work, so the resume is refused as `destination_diverged` and the resumed `--delete` never runs over it.

**Test** (`packages/archid/test/handover/replicas.test.ts`): "is not resumed over a file that only looks like rsync's
partial copy of one the claim does not bring" — partials of brought files (`.a.txt.Qx81Zk`, `sub/.c.txt.Ab12Cd`) still
resume; `.env.backup` and `sub/.a.txt.Qx81Zk` block with `added: { count: 2 }`.

- RED: `pnpm vitest run --project archid packages/archid/test/handover/replicas.test.ts -t "only looks like"` →
  `AssertionError: expected { ok: true, …(2) } to match object { ok: false, …(2) }` (received `"ok": true`).
- GREEN: `pnpm vitest run --project archid packages/archid/test/handover/replicas.test.ts` → `32 passed (32)`.

## R2 — prepare bounded at preflight; no resend on 1009

**Option chosen: cap the manifest at half the request cap.** It is one constant: `MAX_MANIFEST_BYTES = MAX_REQUEST_BYTES / 2`
(128 MiB) in `packages/protocol/src/messages.ts`. Preflight and Freeze already block on `MAX_MANIFEST_BYTES` through
`oversize`, so a manifest whose prepare could exceed the request cap is now stopped at preflight, before any terminal rests.
Sending landed by digest would have needed a new wire field and the destination to rebuild what the controller verified.
The bound holds because landed is the destination's scan of the same carried-root files after `rsync --delete` (at most the
manifest's root files), and the prepare envelope (ids, digest, generation, relay secret; a few hundred bytes) is smaller than
the manifest's non-file content (snapshot, fleet config, excludes, path-root maps, per-root paths).

**Never resend on 1009** (`packages/cli/src/client.ts`, `packages/cli/src/controller/reach.ts`): the client now rejects
pending calls on a close with code 1009 as `ApiError('too_large', …)` rather than the plain "archid connection closed" that
the controller's `transient()` retried. `reconnecting` turns it into a `Refused('too_large')`, which is not transient, and
drops the client, because that socket is closed and a later call on it would hang until its timeout. The existing
answer-too-large path (`WS_ERR_UNSUPPORTED_MESSAGE_LENGTH`) also drops the client now.

**Tests**
- `packages/protocol/test/messages.test.ts` "caps a manifest at half a request: …" — `2 * MAX_MANIFEST_BYTES <= MAX_REQUEST_BYTES`.
- `packages/cli/test/client.test.ts` "reads a request archid closes on as too large as its refusal, never as a dropped link to call again".
- `packages/cli/test/controller/handover.test.ts` "stops at a prepare the destination closes on as too large to read, sent once
  and never again". This is a full `Handover.start` whose destination daemon is a real `Client` behind `reconnecting` to a
  WebSocket server that proxies to the fake destination and closes 1009 on `handover.prepare`. The test asserts 1 prepare,
  no `handover.retry`, `interrupted` at `prepare` with `['resume','abort']`, and that a later call opens a second connection.

- RED:
  - `pnpm vitest run --project protocol packages/protocol/test/messages.test.ts -t "caps a manifest"` → `expected 402653184 to be less than or equal to 268435456`
  - `pnpm vitest run --project cli packages/cli/test/client.test.ts -t "closes on as too large"` → `expected Error: archid connection closed to be an instance of ApiError`
  - `pnpm vitest run --project cli packages/cli/test/controller/handover.test.ts -t "closes on as too large"` → `AssertionError: expected 3 to be 1` (the prepare was sent 3 times, the test's retry attempts)
- GREEN: protocol `messages.test.ts` `32 passed (32)`. cli `client.test.ts` + `controller/handover.test.ts` `59 passed (59)`. archid `source.test.ts` + `api.test.ts` `57 passed (57)`.

## R3 — launcher relays the helper's result on child exit

**Change** (`packages/cli/src/commands/handover.ts`, `launchHelper`): before spawning, the launcher records the events
file's identity (`ino:size:mtimeNs`, or none). When `started` does not see the helper listen (it exited, failed to spawn or
timed out), the launcher checks the events file. If the file was written since launch, which only a helper that listened
does (`HelperServer.open` truncates it after `listen`), it prints the file's last `handover.result` line exactly as the
helper wrote it. It then exits 0 when that outcome is what the job asked for and 1 otherwise, per the contract's exit codes.
Otherwise it reports "exited … before it listened" as before. The identity check keeps an earlier run's result from being
taken for this one's. The Swift launcher handler passes each line to the page and, since a line was said, sends no stderr.
The web's `endFollow` adds no error once a result is in, so the page shows the helper's own result.

**Tests** (`packages/cli/test/handover.test.ts`, fixture `packages/cli/test/fixtures/helper.mjs` gains a `HELPER_RESULT`
mode that writes the events file and exits without being seen to listen):
- "prints the result of a helper that listened and ended before it was seen to, and exits as that run went": interrupted → exit 1, complete → exit 0, the helper's result printed verbatim.
- "never takes the result an earlier run left in the events file for that of a helper that could not start": a stale `complete` in the file plus a failing helper still gives the "before it listened" result and exit 1. Mutation check: dropping the identity guard makes it fail (`expected +0 to be 1`).
- "leaves the run to a helper it starts as itself …" (real CLI): the launcher's one line may be `handover.detached` (exit 0) or the helper's own `handover.result` (exit 1, naming refused.test), depending on timing. The rest of the test is unchanged.

- RED: `pnpm vitest run --project cli packages/cli/test/handover.test.ts -t "before it was seen to"` → received `"error": "the handover helper exited (code 0) before it listened; /tmp/archi-t-565b89/controller/handover.log says why"` where the helper's `"the gateway on refused.test did not answer"` was expected.
- GREEN: `pnpm vitest run --project cli packages/cli/test/handover.test.ts` → `49 passed (49)`.
- Reliability, "leaves the run to a helper it starts as itself" run alone 20×:
  - before the commit (with a temporary branch tally): 20/20 passed, all 20 on the `detached` branch;
  - 8 concurrent runs: 8/8 passed;
  - on the committed code: 20/20 passed (see Final results).

## R4 — host remove refuses while a handover is open

**Change** (`packages/cli/src/controller/host.ts`, `gatewayFleets`): before the "another machine owns" check, a fleet that
names the machine as its gateway counts as open when this Mac holds either of two journals:
- the daemon's handover journal (`<home>/handover/journal.json`), present on a source from Freeze and on a destination from Claim until that side's Complete or abort;
- the controller journal (`<home>/controller/handover.json`, read through `fileStore`), present from Begin until the gateway's Complete or abort.

The `fleet` step then fails, with or without `--forget`, before any ssh. The action names, per fleet home and with its
profile flag, `archi handover --resume` to finish, `--abort` to take it back, `archi handover status` to say which is safe,
then `archi host remove <name>`. The profile-aware command builder is shared with the existing `handover local` hint.

I first used `owner.json`'s `transaction` and dropped it. `installCommitted` keeps a committed transaction in `owner.json`
after the handover completes, and the gateway poll does not overwrite a record at the same generation and owner. With that
check, a fleet pulled to this Mac could never drop its gateway. A guard test covers this.

**Tests** (`packages/cli/test/host.test.ts`):
- "refuses while the gateway holds a handover of a fleet open, and names how to settle it" — one fleet frozen as source (daemon journal), one begun by this Mac's controller (controller journal, `-p lab`); both refused for `forget` false and true, no ssh call, fleet.json and registry untouched. Mutation checks: each half of the check alone fails the test.
- "lets the gateway go once the handover that brought a fleet here has completed, though the record it left names that handover" — `owner.json` with a committed transaction to this Mac and no journals → `ready`, gateway removed.

- RED: `pnpm vitest run --project cli packages/cli/test/host.test.ts -t "holds a handover of a fleet open"` → `AssertionError: expected 'ready' to be 'actions'`.
- GREEN: `pnpm vitest run --project cli packages/cli/test/host.test.ts` → `47 passed | 1 skipped (48)`.

## Files changed

- packages/archid/src/handover/replicas.ts
- packages/archid/test/handover/replicas.test.ts
- packages/protocol/src/messages.ts
- packages/protocol/test/messages.test.ts
- packages/cli/src/client.ts
- packages/cli/src/controller/reach.ts
- packages/cli/src/commands/handover.ts
- packages/cli/src/controller/host.ts
- packages/cli/test/client.test.ts
- packages/cli/test/controller/handover.test.ts
- packages/cli/test/handover.test.ts
- packages/cli/test/host.test.ts
- packages/cli/test/fixtures/helper.mjs

## Final results

- `pnpm typecheck` — clean.
- `pnpm vitest run --project protocol` — 8 files, 114 passed.
- `pnpm vitest run --project cli` — 28 files, 465 passed, 3 skipped.
- `pnpm vitest run --project archid` — 69 files passed (1 skipped), 1129 passed, 3 skipped.
- cli "leaves the run to a helper it starts as itself" alone 20× on the committed code: 20/20 passed.

No web, Playwright or Swift file was touched.

## Self-review

I read the whole diff (`git diff 2f5e3fcb..HEAD`). Found and fixed:
- R2: once a 1009 close became an `ApiError`, `reconnecting` would have kept the dead client ("a refusal keeps the client"), so the next call on that daemon would hang until its timeout. It now drops the client on `too_large`, and the controller test proves the next call opens a second connection.
- R4: the first version read `owner.json`'s transaction, which a completed pull leaves in place (see R4). Replaced with the two journals, plus a guard test.
- Comments trimmed to what the code does.

## Concerns

1. R4 is a local check, not a question to the gateway. It covers every handover this Mac's controller runs and every one this Mac's daemon takes part in. It misses one case: a handover driven by a controller on another machine that has not yet frozen or claimed here, while the gateway holds only `preparing`. Asking the gateway over ssh would close that gap, but it costs a round trip and cannot answer for `--forget` on an unreachable machine. Say if you want it.
2. R3: two launchers can race on one fleet. If the other launcher's helper wins the lock and finishes its whole run before this launcher's child exits, this launcher relays that run's result. A helper that is still running has written no result, so the existing "never takes another helper" test still holds.
3. R3: a relayed `complete` result exits 0 without `handover.detached`. The contract's Detached-helper section does not list that pair, but the Exit-codes section covers it. It is practically unreachable, since a whole handover cannot finish inside one 50 ms poll. The app handles it as described above.
4. R2: a manifest between 128 and 192 MiB that used to pass preflight is now blocked there as `manifest_too_large`. That is the point of the change, but the limit users see has dropped.
