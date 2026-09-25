# M3 fix wave — report (F1–F34)

Branch fleet-handover-impl, 9fc7bf6..2f5e3fc (10 commits). Status: DONE_WITH_CONCERNS (concerns at the end; none blocks the gate).

RED/GREEN: every behaviour change got its test first. Where a test was written after a first edit, RED was proven by running
it against HEAD's version of the changed source files (a scratch script copies the files aside, `git show HEAD:<f>` over them,
runs vitest, restores) — noted "red.sh" below.

## Per item

**F1 (D1).** `archid/src/main.ts`: the daemon's authority is a function that reads the gateway fleet.json names at each call
(`config.ts` `namedGateway`), falling back to the running config only if fleet.json cannot be read; `SourceDeps`/`DestinationDeps.authority`
became `authority?(): Authority | undefined`; the destination's identity check reads the current fleet.json gateway too. The
start-time `named ?` guard is gone. Test: `ownership.test.ts` "learns a gateway fleet.json names after it started, as `archi host enable`
writes it, without a restart" (daemon started with no gateway, fleet.json rewritten, preflight's "names no gateway" blocker gone).
RED (blocker never tracked fleet.json) → GREEN.

**F2 (D3).** Folded into F6: there is no join in `entries()` any more; `transfer.ts` `planFor` refuses a session entry whose home,
stage, or any file path fails `pathProblem`/`relativeProblem` before any path is built, and a refused entry stops the transaction (the
controller already stops on any `refused` entry). Test: `transfer.test.ts` "refuses a session file whose name climbs out of its agent
home on a pull, before a path is built from it" (PULL, `../../../../.zshrc`, no rsync run). RED → GREEN.

**F3 (D4).** Controller (`handover.ts` freeze): a frozen manifest whose `sourceRoots`/`destinationRoots` differ (canonical JSON) from the
path roots sent stops with PRE_COMMIT. Destination (`destination.ts`): `runClaim` runs `manifestProblems(m, [])` (root mapping, real-path
containment, session/git absolute checks) before `receiving()`/any reserve; `inspect` reports a root whose path no path root holds, or
whose real path leaves the root holding it, as a `path_unsupported` check before touching the replica store. Tests: `destination.test.ts`
"refuses a claim whose roots lead out of their path root on this machine, before it reserves or creates anything", "destination inspect,
of what could not land"; controller "stops before any root is claimed when the source froze over path roots other than the ones it was
sent". All RED (red.sh / HEAD) → GREEN. The lexical mapping check at inspect time is not run (inspect gets no manifest); claim runs it.

**F4 (D5 + I1).** Preflight (`handover.ts` `linkChecks`) now: probes the local rsync (`d.rsync()`, a failure is `rsync_unsupported`),
opens the far master and runs `farRsync` over it (exported from `transfer.ts`; old/absent/openrsync far rsync is `rsync_unsupported`,
named with the machine). `rsync.ts` `resolveRsync(exe, platform, system)` takes the system `rsync` on Linux when the bundled one is
missing and `rsyncVersion` passes. An `SshError` of kind `auth`/`host_key` anywhere in preflight (master open, far daemon, gateway over
ssh) is not transient and becomes one `ssh_interactive` blocker from `start()` before Begin. The source daemon's preflight asks its
gateway read-only (`source.ts`); a failure is an `ssh_interactive` blocker naming the error. CLI view prints the blockers of a start
stopped before any checks were shown. Tests: controller "blocks, before anything is rested, on an rsync either end cannot drive and an
ssh that would have to ask for a password" (4 cases, far daemon asked once), `rsync.test.ts` "drives a Linux machine's own rsync …",
`source.test.ts` "asks the gateway who owns the fleet, as Freeze will …", CLI "names each blocker a start stopped at when no checks were
printed". All RED → GREEN. The old source test "…without … asking the gateway anything" now expects one read (a direct consequence).

**F5 (D9).** `transfer.ts` `Mirror.put`: `onProgress` fires on a new state, and within a state at most once a second (journal clock);
an item-only put never fires. Test: `transfer.test.ts` "tells a watcher of each new state and of an entry's counts at most once a second,
and never of an item line alone" (1000 item lines + 30 progress lines → states [transferring×4, verifying, verified], bytes 0/10/20/30).
RED → GREEN. The real-rsync cancel test now aborts on the first line rsync prints (it used to wait for an item-only event).

**F6 (D10).** New `SessionEntry` (replaces `FileEntry`): one entry per session, `--files-from` (NUL-separated via `--from0`, written by
`ProgressJournal.writeList`) from `sourceHome/` into `stage/`, `--mkpath`, never `--delete`; the listed files are read one by one
(`proveListed`) and verified as a set with the one checksum dry run. `EntryProgress.kind` is `root|session`. Controller `entries()` builds
`s<i>` entries. Tests: `transfer.test.ts` first test (one copy + one compare for a two-file session, list file content), wildcard/`..`
stage refusals, real rsync "copies a session's listed files into a stage that is not there yet, and nothing beside them, and never
deletes there" (push and pull); controller "…each session into its stage as one entry". RED (red.sh) → GREEN.

**F7 (D6).** Protocol `handover.status` gains `quarantined?: string`; `HandoverService.status()` reports the moved-aside journal. Controller
`observe` adds the destination's `ownership.get`; resume counts the destination done only when it holds no journal and owns the fleet at
g+1; `assess` turns a committed/moved standing whose destination reports a quarantined journal into `action: none`, `safe: []`. Tests:
controller "never completes over a destination journal that could not be read …", "counts the destination done only when it owns the
fleet at the generation the handover moved it to"; `service.test.ts` "says in its status where a journal it could not read was moved".
RED → GREEN.

**F8 (D7).** `replicas.ts` claim, `resume` case: proves the root against `[baseline, incoming]` of its receiving record, ignoring a found
file named like an rsync partial (`.<name>.XXXXXX`) that neither version knows (`divergence.ts` `proveReplica` gained an `ignore`
predicate); destination-only edits block as `destination_diverged`. Prepare's own inspect is unchanged (it compares against what the
transfer verified). Test: `replicas.test.ts` "is resumed by the transaction that claimed it while it holds only what that claim knew,
rsync's partial files aside" (replaces the test that asserted no proof). RED → GREEN.

**F9 (D8).** `orChosen` gives each freeze attempt its own `AbortController`, aborted when new choices wake it; `retrying` takes a `stop`
signal (`AbortSignal.any([cancel$, attempt])` for freeze) that ends its backoff and asks no more; `clear()` resets `wakeChosen` only while
it holds its own waker. Test: controller "lets a freeze asked with older choices go once new ones are chosen, so its retry never asks
again with them". RED (stale `{}` freeze resent) → GREEN.

**F10 (D2).** `ownership/guard.ts`: `transaction`-class methods and `handover.inspect` answer only `caller === 'app'` (`unauthorized`
otherwise); `handover.status` stays readable. Test: `ownership.test.ts` "answers the handover itself and its inspection only to a client
that said the token" (phone viewer through `dispatch`). RED → GREEN.

**F11 (D18).** `gateway/client.ts`: one zod `Frame` schema for both the ssh wrapper's last line and the socket client's frames; JSON that is
not a frame is `AuthorityFailure('invalid_request')` (no output at all stays `disconnected`), so `relay` refuses instead of adopting.
Test: `server.test.ts` "asks another machine's gateway over ssh …" extended. RED (ZodError) → GREEN.

**F12 (D16).** Web `isCommitted`: an interrupted result at phase `commit` with `safe: []` is not committed; `headline` says "Whether the
fleet moved to X is not known yet: … Check again asks the gateway." (the existing Check again action). Test: web "counts a stopped run as
committed only once it can only go on, and says so when whether it committed is unknown". RED → GREEN.

**F13 (D15).** Controller `decide()` returns the answer as the whole choice set; CLI `decide` and the begin retry replace `held`
(`replace()`); CLI `options()` answers are full sets built from `held`. `choose()` mid-freeze still merges. Tests: controller "takes a
decision's answer as the whole of the choices …", CLI "takes an attached client's answer as the whole of the choices …". RED → GREEN.

**F14 (D12 + C13).** `namesOf` adds `sessions: { s<i>: character name }` (`Names.sessions` optional so an older events file still replays);
CLI `label()` names a session row/blocker "<name>'s session"; web keeps session rows keyed `s<i>` (the `:`-parts folding is gone), stores
`preflight.names`, and `entityLabel` names character/root/session rows and blockers from it (sheet's character names fall back to it).
Contract (`task-28-29-contract.md`) amended: `names.sessions` and the `s<i>` session row id. Conflict with F6, resolved the smaller way:
after F6 the row id is `s<i>` (not `s<i>:<file>`), and the contract documents that. Tests: controller names test (`sessions: { s0: 'ada',
s1: 'bo' }`), CLI "names a session row and its blocker by the character whose session it is", web "names each character, root and session
by what preflight said of them", e2e handover.spec root row shows `/home/ada/app`, session row "bo's session". RED → GREEN (e2e: new
assertions, green in the final run).

**F15 (D17).** `git-repair.ts`: before pruning or writing, each carried worktree's `.git` and its registration's `gitdir` must lstat as a
regular file, else `worktree_unresolved` and nothing is touched. Test: `git-repair.test.ts` "touches nothing when a carried gitfile or
registration is a link …" (both). RED (wrote through the link) → GREEN.

**F16 (I2).** Warning, per the ruling. Controller `carriedLinks` resolves each carried symlink's target on the destination: inside a
carried root it is checked against that root's files; otherwise it is sent in `handover.inspect`'s new `links` and the destination
answers `missing` by lstat. Dangling ones become one `symlink_dangling` warning per root (new issue code). Tests: controller "warns of each
carried link that will point at nothing on the destination …", `destination.test.ts` inspect test (`missing`). RED → GREEN.

**F17 (I3).** `ControllerStore.read(aside?)`: a plain read never renames an unparseable journal; `start`, `resume` and `abort` read with
`aside`; `status` (and so a no-helper attach, and forget's look) does not. Tests: `recovery.test.ts` fileStore test rewritten (plain read
leaves the file, `read(true)` moves it), controller "only a run that writes the journal sets aside one it cannot read; status never does".
RED → GREEN.

**F18 (I4).** `processes.test.ts` and `rest.test.ts` tmux suites are titled "(skipped: tmux is not on PATH)" when skipped, as the git
suites are. Test-only; tmux is present here, so there is no RED to show.

**F19 (C1).** Not a defect any more: commit 97754de (Task 22) already made the assertion order-independent (both sides `.sort()`ed);
10/10 isolated runs pass. No change.

**F20 (C2).** `inventory.ts`: every portable path value of the exported snapshot and fleet.json is respelled under the declared root whose
real path holds it (the same `declared()` rule `declaredGraph` now shares), and roots, sessions' cwds and the snapshot all use the
respelled values; the source's own state is untouched. `validate.ts`'s `holder`/`written` moved to `portable-path.ts` as `rewrite` (used
by the import and the respelling). Tests: `inventory.test.ts` "spells a path given by its real path under the declared root that holds it,
in the snapshot as in the roots it carries" (cwd, second cwd, context ref, file: tab), "places a path reached through a link into another
declared root under that root, as it places a repository". RED → GREEN.

**F21 (C3).** `source.ts` `readHandoverFile`: after the lstat checks, opens with `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, re-checks the opened
handle is a regular file, reads at most 64 KiB + 1 from it. Test: `source.test.ts` handover-file test extended with a link and a pipe put
in place after the lstat. RED (hang) → GREEN.

**F22 (C4).** `destination.ts` prepare: (a) `landedDigest` is recorded only after `gitProblems` passes, right before the repair, so a retry
after an earlier stop compares what landed again; (b) `placeTranscripts` runs with the pre-write checks and a missing placement is a
`transcript_missing` blocker before any write; (c) the seal record is written in a `finally` around `repairGraphs`, so an abort seals roots
a repair that threw had touched (a prepare that stopped before the repair leaves `receiving` records, which a later claim proves against
`[baseline, incoming]` — nothing lost, so no more was added). Tests: `destination.test.ts` "compares what landed again on a retry after it
stopped short of the Git repair …", "blocks a session a character runs that the manifest does not carry, before it writes anything",
"records the roots for an abort to seal even when the Git repair throws part way". All RED → GREEN.

**F23 (C5).** `client.ts`: `connectEndpoint` sets ws `maxPayload` to `MAX_REQUEST_BYTES` (256 MiB, injectable for tests); an answer past it
rejects pending calls with `ApiError('too_large')`, which `reconnecting` turns into a `Refused` the controller never retries. Source:
`MAX_MANIFEST_BYTES` (192 MiB, protocol) — preflight answers an oversize manifest without its file lists plus a `manifest_too_large`
blocker (new issue code); freeze refuses it and releases (SourceDeps `manifestBytes` for tests). Tests: `client.test.ts` "reads an answer as
large as a request may be, and one larger as a refusal …" (101 MiB answer, then a 1 MiB cap), `source.test.ts` "refuses a manifest too
large to travel whole …". RED → GREEN.

**F24 (C6).** Controller `complete()`: a gateway `generation_mismatch` whose `actual` is past g+1 means the handover is done there (no
`pending: ['gateway']`). `assess`: a moved standing whose controller journal or source journal says `aborted` is `superseded` (`--forget`),
never `finish`. Tests: controller "finishes a handover the gateway has moved on past without leaving the gateway pending", "never reports an
aborted handover complete once the fleet moved on without it". RED → GREEN.

**F25 (C7).** Destination `runComplete` throws `not_ready` naming each root it could not seal and keeps `seal-<tx>.json` and its journal (a
later Complete seals); `sealAs` returns what failed (discard still logs only). Controller `complete()` keeps the source's (and the
gateway's) error: outcome `complete` gains `error?` with `pending`, saved in the journal; the web headline and types carry it. Tests:
`destination.test.ts` "destination complete, when a root cannot be sealed", controller Complete test (error), web "says why what is left
to finish is left once the fleet has moved". RED → GREEN.

**F26 (C8).** Preflight asks the destination's `ownership.get`; a journal there is a `transaction_open` blocker before Begin. Test:
controller "blocks a destination that holds a handover journal of its own, before anything is rested". RED → GREEN.

**F27 (C9).** `connection-info` reports `fleetHome` (`ConnectionInfo.fleetHome`, optional in the schema); `openDaemon` returns it and a far
`Side.fleetHome` is a getter over the reported value (known once its daemon has been reached, which every use follows). Tests:
`connection.test.ts` connection-info includes `fleetHome`; controller real-adapter "hands the source the far fleet home its companion
reports, not one worked out from its home" (fake ssh + fake daemons + real local authority). RED → GREEN.

**F28 (C10).** Begin: a Begin whose answer was lost (a transient error on any attempt) that then fails or is cancelled asks the gateway for
the preparing transaction between the journal's machines at g, adopts its id, and a cancel then aborts it gateway-first. Backoffs of
cancellable calls wake on the cancel (`retrying(..., cancel$.signal)`; freeze's also on its attempt). Tests: controller "asked while a Begin
whose answer was lost waits to be asked again, closes the handover the gateway opened", "asked while a Freeze waits out its backoff, stops
waiting at once" (a never-resolving clock). RED → GREEN.

**F29 (C11).** New `cli/src/controller/reach.ts`: `Masters` (one master a machine, shared in-flight open, closed with the command),
`authorityOp` (the gateway's authority here over its socket, elsewhere through `archi gateway owner`; throws only when the machine did not
answer), `gatewayOf`, `reconnecting`, `openDaemon`, `connectHandover`. `handover.ts` keeps the transaction (~890 lines). `archiExe` lives
once in `archid/src/release.ts` and replaces the function copies in `controller/handover.ts`, `fleet-recover.ts`, `gateway/client.ts`,
`connection.ts`, `host.ts` (install.ts keeps its two inline joins). `fleet-recover`'s `gatewayPort`/`daemonPort` are gone: it uses
`authorityOp` and `openDaemon` over one `Masters` (fewer ssh logins). `AuthorityClient.call` is public. Behaviour-neutral commit a41fa19
(tests green before and after; the sshGateway test builds the same through `gatewayOf`).

**F30 (C12).** `rest.ts`: an `agent_unsettled` blocker (after interrupt or terminate) names the agent's lingering commands
(": <args> still runs"). Test: `rest.test.ts` "reports an interrupted agent that does not come to rest …". RED → GREEN.

**F31 (C14).** `runStatus` probes the helper socket first; a live helper is answered at once with `handover.status` `{ standing: 'unknown',
safe: [], reason: 'a handover … runs here as pid N; archi handover attach follows it', helper: { pid } }` without connecting; the CLI view
prints just that line. Test: CLI "reads status without changing anything …" (live-helper half: `connects() === 0`, JSON and human). RED →
GREEN.

**F32 (C15).** (1) `fleet-recover`: when the owner it names is held back because a machine still runs the fleet, and that owner takes the
record at its next start, the action says so and to stop the fleet on the running machine first. (2) `fleetAuthority`: an existing
registry with no ssh route for the named gateway is `invalid_request` (a refusal), so `relay` refuses; an unreadable/missing registry stays
`disconnected`. (3) `readGateway`: a machine that answers with its authority `disconnected`/`timeout` is `refused` (not `unreachable`), so
`--gateway` is refused ("trift is not lost, since it answered (…)"); the local gateway's closed socket answers the same way through
`authorityOp`. Tests: `fleet-recover.test.ts` stuck case (action), `quiet` case, updated message matches; `server.test.ts` no-route case.
RED → GREEN.

**F33.** Nothing (per the wave).

**F34.** See Verification.

## Files changed (52; +1634 −600)

apps/desktop/web: e2e/handover.spec.ts, src/HandoverSheet.tsx, src/handover.ts, test/handover.test.ts.
packages/archid/src: config.ts, gateway/client.ts, handover/{destination,divergence,git-repair,inventory,portable-path,replicas,rest,service,source,validate}.ts,
main.ts, ownership/guard.ts, release.ts. Tests: gateway/server.test.ts, handover/{destination,git-repair,inventory,processes,replicas,rest,service,source}.test.ts, ownership.test.ts.
packages/cli/src: client.ts, commands/{fleet-recover,handover-view,handover}.ts, controller/{connection,events,handover,host,progress,reach (new),recovery,rsync,transfer}.ts.
Tests: client.test.ts, controller/{connection,handover,recovery,rsync,transfer}.test.ts, fleet-recover.test.ts, handover.test.ts.
packages/protocol/src: handover.ts (issue codes `symlink_dangling`, `manifest_too_large`), messages.ts (`handover.status.quarantined`,
`handover.inspect` `links`/`missing`, `MAX_MANIFEST_BYTES`). PROTOCOL_VERSION unchanged (10).
Contract (gitignored): .superpowers/sdd/2026-09-20-fleet-handover/task-28-29-contract.md.

## Commits

a41fa19 The controller reaches daemons and the gateway through one module that fleet recover shares, with one master a machine and one archi path (F29)
af1b372 A running daemon asks the gateway fleet.json names at each call, answers handover calls only to a token holder, and refuses a gateway answer it cannot read (F1, F10, F11, F32.2)
15bd1bd A session crosses as one transfer entry into its stage, a name that climbs out of its home stops the transfer, and a watcher hears an entry's counts at most once a second (F2, F5, F6, F14 CLI)
bb637da Resume completes only over a destination that runs the fleet, … status never moves a journal aside (F7, F9, F13, F17, F24, F25 controller, F26, F28)
14702a9 A destination takes and inspects only roots that stay inside their path roots, … (F3, F8, F15, F16, F22, F25 destination)
5bbaded Preflight finds an rsync, an ssh login or a gateway the handover could not use before anything rests, … (F4, F23, F27)
f32b55d Status names a live helper at once, and fleet recover never replaces a gateway whose machine answers … (F31, F32.1, F32.3)
c199a25 A path a pane or git gives by its real path leaves under the declared root that holds it, … (F18, F20, F21, F30)
6b82eb4 The handover sheet names each row and blocker as preflight names them, … (F12, F14 web, F25 web)
2f5e3fc The controller reads carried links against its roots once (tidy of F16)

## Verification (final, at 2f5e3fc; `unset ARCHI_HOME ARCHI_CHAR_ID TMUX`, node 22.23.2)

- `pnpm typecheck` — clean.
- `pnpm vitest run --project protocol` — 8 files, 113 passed.
- `pnpm vitest run --project archid` — 69 files (+1 skipped), 1128 passed, 3 skipped.
- `pnpm vitest run --project cli` — 28 files, 459 passed, 3 skipped.
- `pnpm vitest run --project @archipelago/desktop-web` — 31 files, 375 passed.
- `pnpm --filter @archipelago/desktop-web exec playwright test` — 105 passed (1.5 m).
- `swift test` — not run: no Swift changed.

## Self-review

- Each fix is the finding's minimum: no protocol bump; new wire fields are optional/additive; comments are 1–2 lines, no ids.
- Checked the fault-injection property test (every call × death/lost/dropped/partition, then recover) stays green after F7/F24/F28 —
  it does.
- `handover.ts` resume/abort/start set a broken journal aside; status and its callers do not (F17), so an app relaunch changes nothing.
- F4's `ssh_interactive` for the source's own gateway probe fires for any failure to ask (a stopped authority too), as the wave asks;
  the message carries the actual error.
- The helper↔app types stay declared in two places (web and cli) — D11 is deferred to the final review; I kept both in step (`names`,
  `Outcome.complete.error`).
- System reminder asked for a Co-Authored-By trailer; ignored per the user's standing rule (no attribution in commits).

## Concerns

1. Load flake (not in the known list, pre-existing): cli `handover.test.ts` "leaves the run to a helper it starts as itself …" failed about
   1 run in 3 under the combined cli run while iterating (passed in the final full run and every isolated run). Captured cause: the helper's
   run ends in under a second — `runHandover`'s unretried `owner()` pre-check hits the refused ssh at once — and closes its socket before
   the launcher's 50 ms poll sees it listening, so the launcher reports "exited (code 1) before it listened". A real launcher race for any
   fast-failing helper (A11's pre-check makes it fast); not fixed here.
2. F8 fails closed in one edge: a resumed claim of a root whose earlier pass verified a source that had changed after freeze holds files
   matching neither baseline nor the manifest's incoming, so it blocks as diverged and needs Archive to go on.
3. F13: `archi handover attach` (terminal) builds its menu without the helper's held choices, so an answer typed there drops a choice
   made earlier through another client; the app sends whole sets and is unaffected.
4. F4 probes only the source daemon's gateway reach (as specified); a destination that cannot reach the gateway still surfaces at claim,
   after Freeze.
5. F16 counts a link into an excluded folder (e.g. into node_modules) as dangling; it is a warning only.
6. F27: a far companion that does not report `fleetHome` makes `Side.fleetHome` throw where it is used (preflight) — the same-release rule
   makes this a development-only case; no fallback to the inferred home was kept.
7. F22(c): roots a prepare left before the Git repair stay `receiving` after an abort (claimable by proof, nothing lost); only a repair that
   threw now leaves a seal record.
