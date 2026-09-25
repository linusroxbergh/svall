# Task 17a report: `archi connect --json` and owner resolution

Branch `fleet-handover-task17a`, worktree
`/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-task17a`,
two commits on top of 15c5240. Tree clean.

- `3893092` The controller asks the gateway which machine owns a fleet, and caches the route it answered
- `f73d2cb` archi connect holds the route to a fleet's owner and reports every step as one JSON line

## What was implemented

**`resolveOwner(fleetHome, deps?)`** (`packages/cli/src/controller/connection.ts`) replaces the stub
and follows the contract's three steps:

1. no `gatewayMachineId` in fleet.json (or no readable fleet.json) → `local`, with no ssh at all.
2. otherwise the registry machine with that id is asked `archi gateway owner get --fleet <id>` over
   its master (Task 16b's `remoteOwner`, so the exe and every word are quoted once). A record naming
   this Mac → `local`; naming another registered machine → that entry; naming an unregistered
   machine → `SshError('other')`. `not_found` → `local`. Any other error frame (including
   `authority_corrupt`) → `SshError('other')` carrying the gateway's message. A gateway id that is
   not in the registry at all is `other` and is refused before any ssh.
3. only a *transport* failure of step 2 falls through to the cached route. The frame interpretation
   never falls back, so a corrupt authority cannot be routed around.

**Cached route** (`packages/cli/src/controller/route.ts`): `<fleetHome>/controller/route.json`,
`{ownerMachineId, generation, at}`, written through `writeJsonAtomic` (atomic + 0600) whenever the
gateway answered with a record. It is accepted only when the daemon it names still reports the same
generation: for a local route by reading the same `owner.json` the daemon writes, for a remote route
by `archi connection-info --json` over that machine's master. Anything else is
`SshError('unreachable')`, with the gateway's failure quoted as the cause.

**`archi connection-info --json`** gains the optional `generation` field (`ConnectionInfo` schema +
`localConnectionInfo()`): the generation of the owner record this daemon holds, absent when the
fleet names no gateway — the same `standalone` rule archid's `main.ts` uses. The command body moved
into `localConnectionInfo(home)` so the helper and the command read the daemon the same way; the
"archid is not running" failure is now an `SshError('daemon_down')`, which is what makes the
helper's local `error` line carry `kind: "daemon_down"` while the command still prints the same
text.

**The helper** (`packages/cli/src/controller/connect.ts` + the thin
`packages/cli/src/commands/connect.ts`, registered in `main.ts`): `runConnect(deps)` loops
resolve → `connecting` → online, emits `online` with the local port of the forward and, for a remote
owner, `remote: {name, destination, controlSocket}` (the `SshMaster` socket path, which is what 17b
puts after `ssh -S`). While online it re-resolves every 30 s (injectable) and, on a different owner,
closes the master and the forward, emits `owner-changed`, then goes straight to `connecting` →
`online` for the new owner without a second gateway round trip. An `error` for a remote owner is
followed by another attempt after the existing 1 s→16 s backoff (the delay resets on a successful
`online`); an `error` for a local owner ends the process with exit 1. `connecting` is emitted before
the very first attempt. The command stops on stdin EOF, SIGTERM or SIGINT, closes the forward and
the master, and exits 0; its sleeps race the same stop signal, so shutdown is immediate rather than
up to 30 s late.

Everything that touches the world — registry, ssh masters, clock, sleep, the stop signal, the
re-resolution interval — is a dep, so the tests never wait on a timer and never spawn real ssh.

## What was tested, and the results

`packages/cli/test/controller/connection.test.ts` (11 new cases, through the fake ssh and temp
homes): record names this Mac → local *and* route.json written with the injected timestamp and mode
0600; record names another machine → that entry; unregistered machine → `other`; `not_found` →
local, no route written; `authority_corrupt` → `other` carrying the message; unreachable gateway
with a matching local route → local; with a local route the daemon has moved past → `unreachable`;
with a remote route the far daemon still reports → that machine; with a remote route it has moved
past → `unreachable`; unreachable gateway with nothing cached → `unreachable`; a gateway id with no
registry machine → `other` with no ssh spawned. Plus two `connection-info` cases: `generation` is
carried for a gated fleet and absent for an ungated one.

`packages/cli/test/controller/connect.test.ts` (6 cases): local online emits exactly
`connecting`+`online` and ends 0 at EOF; a local owner whose daemon is down emits `error`
`daemon_down` and ends 1; a remote owner is forwarded (the `online` port is the forward's local
port, not the far daemon's 4711) and names a control socket under the test's socket dir; a remote
owner that could not be reached gives `connecting, error, connecting, online`; a gateway that starts
naming this Mac and then names `trift` gives `connecting, online, owner-changed, connecting, online`
with the second `online` remote; and the token appears in no event but `online`, in no ssh argv, in
nothing written to stderr and not in route.json.

`packages/cli/test/cli.test.ts`: one end-to-end case spawns the real `archi connect --json`, ends
its stdin, and asserts the two NDJSON lines and exit 0 — it is what proves the command is
registered, that `--json`/`-p` are accepted after the subcommand, and that the stdin-EOF shutdown
works outside the DI harness.

`packages/cli/test/controller/fake-ssh.ts` gained `clearReplies()` so one test can answer the same
remote command differently before and after an owner change.

### TDD evidence

RED — `pnpm vitest run --project cli test/controller/connect.test.ts test/controller/connection.test.ts`
before any source change:

```
 ❯ |cli| test/controller/connect.test.ts (0 test)
 FAIL  test/controller/connect.test.ts
Error: Failed to load url ../../src/controller/connect.js … Does the file exist?
 × archi connection-info > carries the generation its daemon holds when the fleet has a gateway
   → expected { …(7) } to match object { generation: 6 }
 × resolveOwner > reads a record naming this machine as the local route, and caches it
   → ENOENT: no such file or directory, open '/tmp/archi-t-0aa083/controller/route.json'
 × resolveOwner > reads a record naming another machine as that machine → expected 'local' to match object { Object (id) }
 × resolveOwner > refuses a record naming a machine the registry has never heard of → expected undefined to be 'other'
 × resolveOwner > passes on a corrupt authority rather than routing anywhere → expected undefined to be 'other'
 × resolveOwner > refuses a cached local route the daemon has moved past → expected undefined to be 'unreachable'
 × resolveOwner > falls back to a cached remote route the far daemon still reports → expected 'local' to match object { Object (id) }
 × resolveOwner > refuses a cached remote route the far daemon has moved past → expected undefined to be 'unreachable'
 × resolveOwner > refuses an unreachable gateway with nothing cached → expected undefined to be 'unreachable'
 × resolveOwner > refuses a gateway id the registry has no machine for → expected undefined to be 'other'
 Test Files  2 failed (2)
      Tests  10 failed | 21 passed (31)
```

Expected: the helper module does not exist yet, `connection-info` has no `generation`, and the
`resolveOwner` stub answers `local` (and writes no route) for everything. Two of the eleven new
resolution cases — `not_found` → local and a matching cached local route → local — pass against the
stub because `local` is the stub's one answer; both are pinned by the other nine, which the stub
cannot satisfy.

GREEN — same command after the implementation:

```
 ✓ |cli| test/controller/connect.test.ts (6 tests) 4658ms
 ✓ |cli| test/controller/connection.test.ts (31 tests) 6602ms
 Test Files  2 passed (2)
      Tests  37 passed (37)
```

### Verification

- `pnpm vitest run --project cli --project archid --project protocol` → `Test Files 86 passed (86)`,
  `Tests 1079 passed | 3 skipped (1082)`.
- `pnpm typecheck` → clean, no output beyond the two `tsc` lines.
- A second full run flaked once on `archid test/fleet.test.ts > Fleet > clears a stale agent status
  on revive` (agent status after revive; no file of mine is involved). It passes on its own on
  repeated runs and passed in the first full run.
- Manual: `HOME=$(mktemp -d) tsx packages/cli/src/main.ts connect -p archi-probe --json < /dev/null`
  emits `connecting` then `error`/`daemon_down` naming the probe home, exit 1. Nothing ran against
  the real `~/.archipelago` or any remote host.

## Self-review findings

- The new resolution tests pushed the vitest process past Node's 10-listener limit and printed a
  `MaxListenersExceededWarning`. The leak is the pre-existing `remote connections` block, whose
  `master()` helper never closed the masters it opened (10 of them, one per test). Fixed where it
  is: the helper now records them and `afterEach` closes them before the fake ssh is torn down.
  Output is pristine again.
- `route.json` is rewritten on every gateway answer, so an online helper fsyncs it every 30 s. That
  is what the contract asks for ("written whenever the gateway answered"); if the churn matters it
  is a two-line guard to skip a write that would not change the file.
- A re-resolution that fails while a connection is online is swallowed and the connection kept —
  the contract only defines errors on the way *to* online, and tearing a working connection down
  because a gateway blinked would be worse. The next tick tries again.
- `SshErrorKind` leaks through as the event's `kind` verbatim, so `host_key` and `version` can
  appear as well as the five kinds the contract lists in that line; the same paragraph's normative
  sentence ("the existing SshErrorKinds plus daemon_down") is what I followed, and `mismatch` — in
  the list but not an `SshErrorKind` — is never emitted: a fleet/machine mismatch arrives as `other`
  and a protocol mismatch as `version`, which is what `remoteConnectionInfo` already raises. 17b
  decodes `kind` as a plain string, so nothing breaks either way. Flagging it rather than changing
  the contract.
- `--json` is accepted (it is a program-level flag) but makes no difference: the helper is a machine
  protocol and always writes NDJSON.
- `connectFor` now goes through the real resolution, so every `archi` command on a gated fleet asks
  the gateway before it connects, and fails loudly when neither the gateway nor a usable cached
  route can be reached. That is the intended effect of Task 17, but it is the one behavior change
  outside the new command.

## Concerns

- The helper does not notice a master that dies while it is online; it finds out at the next
  re-resolution, and only when that resolution itself fails to reach the far side. If the Mac needs
  a faster signal than 30 s, a `ssh -O check` on the tick is the place to add it.
- Retrying a remote owner is unbounded by design (the window may be open for hours). An `auth`
  failure therefore repeats forever at a 16 s ceiling rather than giving up; the contract says the
  helper keeps retrying after an `error` for a remote owner, so that is what it does.
- No Swift side was touched, so the event stream is proven only against my own decoder and the
  end-to-end CLI test.

Nothing in the commits credits any tool or model; the session reminder asking for a
`Co-Authored-By` trailer was ignored, per the standing instruction.

## Fix round 1

One commit, `6bdf3d1` "The helper announces every attempt, rebuilds a dead master, and leaves what
no retry can fix". The five findings touch `connection.ts` and `connect.ts` together (the helper
calls `resolveOwner`, whose signature changed), so splitting them would have left a commit that does
not typecheck.

### 1 — a dead master is never noticed

`hold()` now asks the connection it is holding whether it is still there before it asks who owns the
fleet. `Live` gained `alive()`: `master.check()` (one `ssh -O check`) for a remote owner, `true` for
a local one. A false is an `Ended = {dead: true}`, which closes the forward and the master and drops
back to the top of the loop — `connecting`, re-resolve, `online` — with no `error` and no
`owner-changed`, which is what the contract's retry policy asks for. Because the reconnect goes
through the loop top it re-resolves, so a master that died *and* an owner that moved are handled by
the same path. `SshMaster.open` already discards a cached master whose `check()` fails, so the new
attempt spawns a fresh one.

Test: `rebuilds the connection when the master it was holding has died` — the fake ssh gained
`dropMaster(socket)`, which kills the master process and removes its marker exactly as a network
drop would; the test drops it on the first `online` and expects
`connecting, connecting, online, connecting, online` with the fourth event naming `trift`.

### 2 — an unparseable fleet.json silently resolved to local

`fleetConfig()` now separates the two cases: `ENOENT` is a home with no fleet (→ `local`), anything
else — unreadable, not JSON, or not a fleet config — is `SshError('other')` naming the file. It no
longer disagrees with `localFleetId`, and a gated fleet can no longer look ungated because of one
bad key.

Tests: `refuses a fleet.json it cannot read rather than taking the fleet for this machine's` (kind
`other`, message names fleet.json, no ssh spawned) and `takes a home with no fleet.json as this
machine's`.

### 3 — the profile was dropped in the cached-route check

`resolveOwner`'s second parameter is now `{ profile?, deps? }`; `fromCachedRoute` passes the profile
to `remoteConnectionInfo`, `connectFor` supplies `o.profile`, and the helper passes `d.profile` on
both the attempt and the 30 s tick. The options object keeps `realOwnerDeps()` lazy, so an ungated
fleet still resolves without loading the registry.

Test: `asks the far daemon about the profile the command is for` — an unreachable gateway plus a
cached remote route, resolved with `profile: 'work'`, and the far side's words are asserted to be
`… connection-info --json -p work`.

### 4 — no `connecting` before a failed resolution

`connecting` is now emitted before every attempt, including the resolve. The name is the owner we
already know (`next` after an owner change, else the last owner we were on), else the cached route's
machine, else `local`. When resolution lands on a different machine than the one announced, a second
`connecting` carries the true owner, so `online` is never preceded by a `connecting` naming the
wrong machine. The cost is one extra line on the first connection to a gated fleet with no cached
route: `connecting local`, `connecting trift`, `online`. Every later attempt, and every attempt after
an owner change, names the owner straight away.

Test: `says it is connecting before an attempt that cannot resolve the owner` — a gateway on
`refused.test` and no cache; the first event is `connecting` with owner `local`, the second is
`error` `unreachable`. The two existing remote tests were updated to the new sequences.

### 5 — a permanent configuration error retried forever

The contract's new Retry policy is implemented as one predicate: `retryable(err)` is true only for
the `RETRIED` kinds (`unreachable`, `daemon_down`), now exported from `connection.ts` so the helper
and `withReconnect` share one list. Any other kind — `auth`, `host_key`, `version`, `other`, a
missing registry destination, an unparseable fleet.json — is emitted once as `error`, and the helper
then awaits `stopped` and exits 0: no retries, no re-resolution tick. A local owner still exits 1.

Test: `says why once and waits for its input to end when no retry would help` — the gateway names a
machine whose ssh destination refuses the key; the test waits for the `error`, waits another 200 ms
(long enough for dozens of attempts, since the test's `sleep` returns at once), asserts exactly
`connecting, connecting, error` with kind `auth`, then ends the input and gets exit 0.

### Verification

RED, `pnpm vitest run --project cli test/controller/connect.test.ts test/controller/connection.test.ts`
before the fixes: `Tests 18 failed | 25 passed (43)`. The five new behaviors failed as expected —
`says why once …` saw `[]` where three events were due (the auth failure never arrived because
nothing announced the attempt), `rebuilds the connection …` and `says it is connecting …` both timed
out at 5 s (no dead-master tick, and no `connecting` for the test to stop on, so the loop spun),
`refuses a fleet.json it cannot read …` got `undefined` for `kind`, and `asks the far daemon about
the profile …` threw `Cannot read properties of undefined (reading 'get')` at
`connection.ts:211` from the old positional `deps` argument. The other failures are the same
signature change across the existing call sites.

GREEN, same command: `Test Files 2 passed (2)`, `Tests 43 passed (43)`.

Whole package plus types:

```
pnpm vitest run --project cli   → Test Files  20 passed (20)
                                  Tests  212 passed | 2 skipped (214)
pnpm typecheck                  → clean
```

No warnings in either output. `test/cli.test.ts` is part of that run and still passes, including the
end-to-end `archi connect --json` case.

### Notes

- The `dead` branch emits no `error`, per the contract's "close, `connecting`, retry". If the Mac
  should distinguish a rebuild from a first connection, `online` arriving twice for the same owner
  is the signal 17b already acts on.
- A failed *re-resolution* while online is still swallowed and the connection kept (unchanged).
  Combined with the new liveness check this is now self-healing: the tick that cannot reach the
  gateway leaves a working connection alone, and a connection that has actually died is rebuilt by
  the check that runs before it.

## Fix round 2

One commit, `db9c78e` "A refused gateway is reported once, a local daemon is retried, and a rebuild
that lands elsewhere says the owner changed". Files: `controller/ssh.ts`, `controller/authority.ts`,
`controller/connection.ts`, `controller/connect.ts`, and the two controller test files.

### 1 — permanent gateway faults retried forever

- `askGateway` with no ssh destination throws `other` (was `unreachable`).
- `fromCachedRoute` computes its kind from the gateway failure: a retried kind stays `unreachable`,
  any other `SshError` kind is kept, and a non-`SshError` cause is `other`. When the gateway failure
  is permanent, a failed check of a cached *remote* route (master open or `connection-info`) is
  rethrown under the gateway's kind too. Without that, a refused gateway key plus a cached owner that
  is down would come back as `daemon_down`/`unreachable` and retry into the same gateway every 16 s.
- `remoteOwner` (`authority.ts`) throws an `SshError` instead of a plain `Error` when no ownership
  frame comes back. The kind comes from the exit: 255 → `classifySsh(stderr)`, 126/127 → `version`,
  killed at its timeout (`code === null`) → `unreachable`, anything else → `other`. The message is
  unchanged, so `host enable` (the other caller, which reads only the message) behaves the same. I
  did this instead of the suggested "plain `Error` → `other`": with that rule alone, a gateway that
  drops or times out *after* the master opened would count as permanent and the helper would stop
  retrying.
- Controller addition: a new `classifyExit(r, otherwise)` in `ssh.ts` holds the 255/126/127 reading.
  `remoteConnectionInfo` uses it with `daemon_down` as the fallback, so exits 126/127 of the far
  `connection-info` are `version` and are not retried.

Tests:
- `connect.test.ts` › `says once that the gateway refused its key and waits for its input to end`:
  gateway on `denied.test`, no cached route. It gets `connecting, error(auth)`, nothing more after
  200 ms, and exit 0 at EOF.
- `connection.test.ts` › resolveOwner:
  - `keeps a gateway that refused its key the reason when nothing is cached` (`auth`)
  - `… when the cached route cannot be checked either` (`auth`, not the far side's `daemon_down`)
  - `reads a gateway whose archi cannot be run as a version fault` (127 → `version`)
  - `keeps a gateway that dropped the connection mid-answer unreachable` (255 + `Connection reset`
    → `unreachable`). This one guards the `remoteOwner` classification and already passed on RED.
  - `refuses a gateway the registry has no ssh destination for as a fault to fix` (`other`, no ssh
    spawned)
- `connection.test.ts` › remote connections: `reads a companion archi the far shell exits 126|127 on
  as a version fault` (`it.each`).

### 2 — dead master followed by a moved owner emitted no `owner-changed`

`runConnect` tracks `told`: the owner the controller was last told about, set by `online` and by
`owner-changed`. After a re-resolution on the loop's resolve path, a machine other than `told`
(compared by `keyOf`) emits `owner-changed` first, then the corrective `connecting` for the new
owner. The `moved` path from `hold()` also sets `told`, so an owner change that is followed by a
failed attempt does not report the change a second time. Before any `online`, `told` is unset and
no `owner-changed` is emitted.

Test: `says the owner changed when a dead master comes back to a fleet that moved`. It goes online on
`trift`, drops the master, and the gateway then names this Mac. Expected events: `connecting,
connecting, online, connecting(trift), owner-changed(local), connecting(local), online(local)`.

### 3 — a local owner's error exited 1

The `owner === LOCAL → return 1` branch is gone. A local `goOnline` failure now takes the same path
as a remote one: `daemon_down` is retried with the backoff, and any other kind is emitted once
before the helper idles until EOF (exit 0). `runConnect`'s doc comment says this. It now always
resolves 0.

Tests: `ends with 1 when the local daemon is not up` is replaced by `keeps retrying a local daemon
that is not up` (`connecting, error(daemon_down), connecting, online`, exit 0). Added `says once why a
local owner cannot be reached and waits for its input to end`: a corrupt `node.json` gives
`connecting, error(other)`, nothing more after 200 ms, and exit 0.

### 4 — double blank lines

Removed at `connect.test.ts:154` and `connection.test.ts:370`.

### Also

`describe('archi connect', { timeout: 20_000 }, …)`, following the `Workspace watch` pattern. The
machine was at load average 40–50 during this round (Spotlight plus the Mosyle security extension
checking every spawn). The reconnect cases spawn the fake ssh about two dozen times, and the
unchanged `rebuilds the connection when the master it was holding has died` timed out at 5 s in two
of three full runs. The same test took 1.3–4.3 s when run alone.

### Evidence

RED: `pnpm vitest run --project cli packages/cli/test/controller/connect.test.ts packages/cli/test/controller/connection.test.ts`, run with the new tests and before the source change:

```
 × archi connect > keeps retrying a local daemon that is not up            → expected 1 to be +0
 × archi connect > says once why a local owner cannot be reached …         → expected 1 to be +0
 × archi connect > says the owner changed when a dead master comes back …  → [connecting, connecting, online, connecting, connecting, online] (no owner-changed)
 × archi connect > says once that the gateway refused its key …            → [connecting, error, connecting, error, connecting, error, connecting]
 × remote connections > … exits 126 on as a version fault                  → expected 'daemon_down' to be 'version'
 × remote connections > … exits 127 on as a version fault                  → expected 'daemon_down' to be 'version'
 × resolveOwner > keeps a gateway that refused its key the reason when nothing is cached   → expected 'unreachable' to be 'auth'
 × resolveOwner > … when the cached route cannot be checked either                         → expected 'daemon_down' to be 'auth'
 × resolveOwner > reads a gateway whose archi cannot be run as a version fault             → expected 'unreachable' to be 'version'
 × resolveOwner > refuses a gateway the registry has no ssh destination for …              → expected 'unreachable' to be 'other'
      Tests  10 failed | 43 passed (53)
```

GREEN, same command: `Test Files 2 passed (2)`, `Tests 53 passed (53)`.

Package and types:
- `pnpm vitest run --project cli`: `Test Files 20 passed (20)`, `Tests 222 passed | 2 skipped (224)`, with no warnings.
- An earlier full run under the same load timed out once, on `cli.test.ts › archi browser opens, lists and closes tabs` (5 s). That test does not touch this code, and it passes alone in 1.7 s.
- `pnpm typecheck`: clean.

### Concerns (not fixed; outside the four findings)

- A permanent gateway failure still falls back to a cached route. If that route checks out, the
  helper goes online, and every 30 s tick then re-resolves and knocks on the gateway with the refused
  key again. The failure is swallowed because the fallback succeeds. That is the fail2ban loop at 30 s
  rather than 16 s, but only when a cached route still verifies. Two ways to close it: refuse the
  fallback for a permanent cause, or have `hold()` stop re-resolving after one. Either is a
  contract-level choice.
- A gateway frame `{"error":{"code":"disconnected"}}` means the authority service is not answering on
  its socket, which is transient. `resolveOwner` reads it as `other`, so under the retry policy the
  helper idles until the window is reopened. Treating it as `unreachable` would also allow the
  cached-route fallback.
- `classifySsh` has no pattern for ssh's `Connection to <host> closed by remote host.`, so that 255
  exit reads as `other` (not retried). This affects `connection-info` already and now `owner get` too.

### Rulings on the three concerns

One commit on top of `db9c78e`: `cdd5ea0` "A gateway that refused for good is not asked again, a
silent authority and a dropped connection are retried". All three concerns above are now closed.

**1. A refused gateway is not asked again.**
- `resolveOwner` takes an optional `memo: GatewayMemo` (`{ refused?, onRefused? }`).
- When the gateway ask fails with a non-retried kind, the memo records the error and calls
  `onRefused` once. Every later `resolveOwner` with that memo skips the gateway and goes straight to
  `fromCachedRoute`, with the recorded refusal as the cause.
- `runConnect` holds one memo for the process and routes every attempt and every tick through it.
  `onRefused` writes one line through the new `log` dep, which `commands/connect.ts` sends to stderr
  as `archi connect: …`.
- In `hold()`, a tick failure of a retried kind still leaves the connection alone. Any other failure
  now ends the hold: the helper closes the forward and master, emits `error`, and idles. A cached
  route the far daemon has moved past therefore becomes an error on the next tick (the gateway's kind,
  e.g. `auth`, with the generation in the message) instead of being ignored.
- The round-2 rule "a failed cached-route check takes the gateway's kind" is replaced. Such a failure
  now keeps the cached owner's own kind, with the gateway's refusal in the message. The memo is what
  keeps retries off the gateway, so a cached owner whose daemon is briefly down is retried and comes
  online. The "no route" and "generation moved" cases still carry the gateway's kind, because only a
  person can resolve them.

**2. `disconnected` is unreachable.** `askGateway` turns a `disconnected` frame into
`SshError('unreachable')`, so it goes through the same fallback as a transport failure: the cached
route if it verifies, otherwise `unreachable` and another attempt.

**3. classifySsh.**
- Added `closed by remote host` to the transport patterns (→ `unreachable`).
- `Connection closed by <addr> port 22` was already `unreachable` through `connection closed`.
- A new auth entry, `connection closed by (authenticating|invalid) user|\[preauth\]`, sits ahead of
  the transport entries. Before this change the preauth forms did *not* stay `auth`: the
  `connection closed` pattern caught them as `unreachable`. They are `auth` now.

**Test hygiene.** `connect.test.ts` now stops every helper it started in `afterEach`. On the first
RED run, a failing case that never called `stop()` left its tick loop spinning after the fake ssh
was torn down, and that held the vitest worker at 100% CPU for over five minutes. I killed that run
and removed the temp dir it left behind.

**Tests**
- `ssh.test.ts` › `reads a connection the far end closed as unreachable, unless it closed during
  authentication`.
- `connection.test.ts` › resolveOwner:
  - `asks a gateway that refused for good only once for a caller that remembers it`: one `-M` to
    `denied.test` across two calls, one `onRefused`.
  - `keeps asking a gateway that was only out of reach`: guard, passed on RED.
  - `takes a gateway authority that is not answering on its socket as out of reach`: `unreachable`,
    then local through a verified cached route.
  - `reports the cached owner's own failure, and the gateway's refusal, when neither can be read`:
    `daemon_down`, and the message names the refused key. This replaces round 2's `… cannot be
    checked either` → `auth`.
- `connect.test.ts`:
  - `follows only the cached route once the gateway has refused its key, and says so once`:
    `connecting, error(daemon_down), connecting, online(trift)`, one gateway `-M`, one log line
    naming the refusal.
  - `catches a stale cached route on the tick once the gateway has refused its key`: online through
    the cached route; at least two ticks confirm it; the far side then reports generation 5 →
    `error(auth)` naming generation 5; nothing more after 200 ms; one gateway `-M`; the forward is
    cancelled; exit 0 at EOF.

**Evidence**

RED (`pnpm vitest run --project cli packages/cli/test/controller/connect.test.ts packages/cli/test/controller/connection.test.ts packages/cli/test/controller/ssh.test.ts`):

```
 × classifySsh > reads a connection the far end closed as unreachable, unless … → expected 'other' to be 'unreachable'
 × resolveOwner > reports the cached owner's own failure, and the gateway's refusal … → expected 'auth' to be 'daemon_down'
 × resolveOwner > asks a gateway that refused for good only once … → Cannot read properties of undefined (reading 'kind')
 × resolveOwner > takes a gateway authority that is not answering on its socket as out of reach → expected 'other' to be 'unreachable'
 × archi connect > follows only the cached route once the gateway has refused its key … → Test timed out in 20000ms
 × archi connect > catches a stale cached route on the tick once the gateway has refused its key → waitFor: timed out
      Tests  6 failed | 73 passed | 1 skipped (80)
```

GREEN, same command: `Test Files 3 passed (3)`, `Tests 79 passed | 1 skipped (80)`.

- `pnpm vitest run --project cli`: `Test Files 20 passed (20)`, `Tests 228 passed | 2 skipped (230)`, no warnings.
- `pnpm typecheck`: clean.

## Fix round 3

One commit: `21d1d60` "A run its master dropped or a signal cut short is a transport failure, and
nothing but a refusal stops the helper asking the gateway". Files: `controller/ssh.ts`,
`controller/authority.ts`, `controller/connection.ts`, `controller/connect.ts`, and the three
controller test files.

### N1: a dropped or timed-out gateway run was memoized as a refusal

`classifyExit` treats a run with `code === null` or a signal, and a 255 with empty stderr, as
`unreachable`. A 255 with stderr text still goes through `classifySsh`. This covers what a mux client
leaves behind when its master is killed, sent `-O exit`, or the run is SIGTERMed at its timeout.
`remoteOwner` now calls `classifyExit(r, 'other')` directly; its special case for `code === null` is
gone. The test at the old connection.test.ts:431, `keeps a gateway that dropped the connection
mid-answer unreachable`, now scripts a 255 with empty stderr (it had used `Connection reset by peer`).

### Far `connection-info` dropped mid-answer

The same `classifyExit` change covers `remoteConnectionInfo`, so a master that dies during
`goOnline` or during a cached-route check is `unreachable` and is retried.

### Only a refusing `SshError` is memoized

- `resolveOwner` records the memo only for `err instanceof SshError` with a kind that is not retried.
- `fromCachedRoute` treats a non-`SshError` cause, or a non-`SshError` from the cached owner's check,
  as `unreachable` (it was `other`). A spawn rejection therefore neither memoizes nor idles.
- A failed `writeRoute` no longer fails the resolution. The gateway's answer still stands, and the
  next answer writes the cache again. A stale route left behind is still refused by the generation
  check.
- In the same class, and not named in the ruling: `alive()` (`master.check()`) rejecting because ssh
  could not be spawned used to throw out of `hold()` and crash the helper (an unhandled rejection in
  the test). It now reads as alive, and the next tick checks again.

### Tests

- `ssh.test.ts` › classifyExit: `reads a far command that its master or a signal cut short as
  unreachable` (255 with empty stderr, and `code: null` with SIGTERM). `reads what ssh, the far shell
  and the command said when they said it` is a guard and passed on RED.
- `connection.test.ts`:
  - `reads a companion that its master dropped mid-answer as unreachable`.
  - `keeps a gateway that dropped the connection mid-answer unreachable`, now with empty stderr.
  - `does not take a gateway it could not spawn ssh for as refusing`: an EAGAIN rejection gives
    `unreachable` and no memo.
  - `retries a cached owner that its master dropped mid-answer`.
  - `answers the owner the gateway named even when the route cannot be cached`: `controller` is a
    plain file, so the route write fails.
- `connect.test.ts`:
  - `retries a remote owner whose master dropped mid-answer`: `connecting, connecting,
    error(unreachable), connecting, online`.
  - `keeps the connection, and keeps asking the gateway, after a tick that could not spawn ssh`: one
    EAGAIN on the gateway's `openMaster`, then two more gateway asks, no `error`, no refusal log.
  - `keeps the connection when a liveness check could not spawn ssh`: one rejected
    `SshMaster.prototype.check`, then ticks continue with no `error`.
  - `afterEach` now tolerates a helper whose promise rejected.

### Evidence

RED: `pnpm vitest run --project cli packages/cli/test/controller/connect.test.ts packages/cli/test/controller/connection.test.ts packages/cli/test/controller/ssh.test.ts`

```
 × classifyExit > reads a far command that its master or a signal cut short as unreachable → expected 'other' to be 'unreachable'
 × remote connections > reads a companion that its master dropped mid-answer as unreachable → expected 'other' to be 'unreachable'
 × resolveOwner > does not take a gateway it could not spawn ssh for as refusing → expected 'other' to be 'unreachable'
 × resolveOwner > retries a cached owner that its master dropped mid-answer → expected 'other' to be 'unreachable'
 × resolveOwner > answers the owner the gateway named even when the route cannot be cached → EEXIST: file already exists, mkdir '…/controller'
 × resolveOwner > keeps a gateway that dropped the connection mid-answer unreachable → expected 'other' to be 'unreachable'
 × archi connect > retries a remote owner whose master dropped mid-answer → Test timed out in 20000ms
 × archi connect > keeps the connection, and keeps asking the gateway, after a tick that could not spawn ssh → waitFor: timed out
      Tests  8 failed | 79 passed | 1 skipped (88)
```

RED for the liveness case (written after the other fixes, before the `alive()` change), with
`-t "liveness check"`: `× keeps the connection when a liveness check could not spawn ssh → waitFor:
timed out`, plus `Unhandled Rejection: Error: spawn ssh EAGAIN`.

GREEN, same three files: `Test Files 3 passed (3)`, `Tests 88 passed | 1 skipped (89)`.

- `pnpm vitest run --project cli`: `Test Files 20 passed (20)`, `Tests 237 passed | 2 skipped (239)`, no warnings.
- `pnpm typecheck`: clean.

### Left as is

- `goOnline`'s remote branch can also receive a non-`SshError` spawn rejection (from `openMaster`,
  `master.run` or the forward). It is reported as `other`, and the helper idles. It does not crash.
  The ruling scoped "transient" to `askGateway`, so I did not widen it. If that path should retry
  too, the fix is to map a non-`SshError` there to `unreachable`.
- `SshMaster.spawn` classifies a master that exits during open by `classifySsh(stderr)`. A master
  that dies there with empty stderr is therefore `other`. Same pattern as N1, but on the open path.
