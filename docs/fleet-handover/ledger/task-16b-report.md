# Task 16b report — gateway CLI wrappers and `host enable` authority creation

Commit: `15c5240 The gateway answers ownership over SSH and host enable seeds the first record`
(one commit, on `fleet-handover-impl`, parent `8f75910`). Working tree clean.

## Inherited state

The previous implementer's uncommitted tree was further along than the hand-off described: all four
brief items were present and `pnpm typecheck` already passed on it. I read the whole diff and every
new file, reviewed it against the brief, re-derived the RED evidence myself (see below), kept the
work unchanged, and committed it. Nothing was rewritten — the design matches what the brief asks
for and the constraints (Unix socket only, no shell interpolation, DI, atomic writes, no sudo).

## What the commit implements

### 1. `archi gateway serve`

`packages/cli/src/commands/gateway.ts` adds the `gateway` command group, registered in
`packages/cli/src/main.ts`. `serve` runs `main()` from `@archipelago/archid/gateway/bin` — exactly
what the Linux unit renders as ExecStart (`packages/archid/src/linux/setup.ts:67`).

`packages/archid/src/gateway/bin.ts`:

- new exported `shutdown(server, exit, log)` builds the signal handler: a `close()` that resolves
  exits 0, a `close()` that **rejects** logs why and exits 1 instead of leaving the rejection
  unhandled and the process alive.
- `main(log = createLogger())` returns the `AuthorityServer` and takes a logger, so a test can serve
  on a temp prefix without the unit's log line on stderr.

A failure to start is not swallowed: `main.ts`'s `parseAsync().catch()` prints `archi: <message>`
and exits 1.

### 2. `archi gateway owner <op> --fleet <id> [--params <json>]`

A thin wrapper over `AuthorityClient` on `<prefix>/gateway/authority.sock` (`gatewayPrefix()`); no
TCP anywhere. The op is the short name (`get`, `create`, `begin`, `ready`, `commit`, `abort`,
`complete`), mapped onto `owner.<op>` and checked with `isOwnerOp`.

Parameter shape: `--fleet <id>` carries the fleet (it is in every op's schema) and one
`--params <json>` object carries the rest. `fleetId` is applied after the spread, so `--fleet`
always wins. The merged object goes to the authority as-is — the authority is the single validator,
so a bad machine id comes back as its own `invalid_request` rather than a second, parallel refusal.

Output is exactly one JSON line — `{"result":{"record":…}}` or `{"error":{"code","message","data"?}}`
— exit 0 on a result, 1 on an error. Error names are the authority's own; a socket that will not
connect reuses the client's existing `disconnected` code and the message names the socket path.

### 3. `host enable` finishes

`packages/cli/src/controller/host.ts`:

- `HostDeps` gains `machineId(): MachineId`; `realDeps` in `packages/cli/src/commands/host.ts`
  supplies `() => machineId(dir)` — the same reader `archi version --json` uses, against the same
  config dir the registry is loaded from, so nothing is minted twice.
- the Task 15 placeholder `authority` step is replaced by `seedAuthority()`: opens the master to the
  machine, runs `archi gateway owner get --fleet <id>`, and on `not_found` runs `create` with
  `initialOwnerMachineId` = this Mac's id. An existing record is `ok` only when its `fleetId` and
  `ownerMachineId` both match; otherwise the step fails naming the current owner and generation.
  `authority_corrupt` fails the step with an `ssh <dest>, then …` repair action.
- ordering is authority-then-fleet: the `fleet` step (the `gatewayMachineId` write) only runs after
  `authority` succeeded, so every refusal and every unreachable gateway leaves fleet.json untouched.
- `readFleet(file)` was extracted from the old `fleet` step, since the authority step needs the
  fleet id before anything is written.

`packages/cli/src/controller/authority.ts` is the new small module (52 lines) holding the
authority-over-ssh call (`remoteOwner`): it builds the argv with every non-flag word `shellQuote`d,
runs it on the master, and parses the one frame. The wrapper prints its frame whether it succeeded
or not, so the exit code is deliberately not what is read; a reply that is not an ownership frame
throws with what the far side actually said. The record is parsed with `OwnerRecord` — the far
side's answer is data.

### 4. Test-only fix carried from Task 14

`packages/cli/test/controller/ssh.test.ts`'s real-sshd case strips the fake ssh's bin dir from PATH
for the duration of the case, exactly as `packages/cli/test/host.test.ts`'s sshd case does.

## TDD evidence (re-derived in this session)

Method: commit the work, then `git checkout HEAD~1 --` the four modified source files and move the
two new source files aside, keeping every test. That is the tests-first state.

### RED 1 — `shutdown` / `main` (archid)

```
$ pnpm vitest run --project archid packages/archid/test/gateway/bin.test.ts
TypeError: shutdown is not a function
 ❯ test/gateway/bin.test.ts:61:5
 Test Files  1 failed (1)
      Tests  3 failed (3)
```

Expected: `shutdown` did not exist, and `main()` returned `void` with a `close()` rejection that
went unhandled.

### RED 2 — `gateway owner` / `gateway serve` (cli)

```
$ pnpm vitest run --project cli packages/cli/test/gateway.test.ts
Error: Failed to load url ../src/commands/gateway.js … Does the file exist?
 Test Files  1 failed (1)
```

Expected: the command did not exist.

### RED 3 — `host enable`

```
$ pnpm vitest run --project cli packages/cli/test/host.test.ts -t 'host enable'
-   "status": "fail"
+   "status": "skip"
 ❯ test/host.test.ts:477:38
 Tests  5 failed | 2 passed | 24 skipped (31)
```

Expected: the `authority` step was still the Task 15 placeholder that always answered `skip`, and it
ran after the fleet.json write.

### RED 4 — the command is not reachable from `archi` end to end

```
$ pnpm vitest run --project cli packages/cli/test/cli.test.ts -t 'ownership question'
expect(created.code).toBe(0);   // test/cli.test.ts:93
 Tests  1 failed | 11 skipped (12)
```

Expected: `archi gateway owner create` exited 1 because `main.ts` had no `gateway` command.

### RED 5 — the real-sshd case talks to the fake ssh

With HEAD~1's `ssh.test.ts` restored:

```
$ ARCHI_TEST_SSH=trift.test pnpm vitest run --project cli packages/cli/test/controller/ssh.test.ts -t 'real sshd'
expect(r.stdout.trim()).toBe('hello');   // test/controller/ssh.test.ts:191
 Tests  1 failed | 20 skipped (21)
```

Exactly the failure the brief describes: the fake answered the master and then had nothing scripted
for `echo hello`, so stdout was empty.

### GREEN 5 (as far as this machine allows)

```
$ ARCHI_TEST_SSH=trift.test pnpm vitest run --project cli packages/cli/test/controller/ssh.test.ts -t 'real sshd'
Error: ssh could not reach trift.test: ssh: Could not resolve hostname trift.test
 ❯ SshMaster.open src/controller/ssh.ts:94:20
```

The failure moved from the `echo hello` assertion into `SshMaster.open` against the real ssh — the
fake no longer intercepts, which is the whole point of the fix. A genuinely green run needs a real
sshd, and the task forbids touching `~/.ssh/known_hosts`, so the case stays skipped in the normal
run (as it does on `main`): `Tests 20 passed | 1 skipped (21)`.

### GREEN 1–4 (full suite, restored tree)

```
$ pnpm typecheck
(clean)

$ pnpm vitest run --project cli --project archid
 Test Files  77 passed (77)
      Tests  956 passed | 2 skipped (958)
```

## Verification

- `pnpm typecheck` — clean.
- `pnpm vitest run --project cli --project archid` — 77 files, 956 passed, 2 skipped.
- One stray stderr line in the cli run (`ssh: connect to host refused.test port 22: Connection
  refused`) comes from the fake ssh's own fixture and already appears on `8f75910` for the `host
  add` unreachable case; the new `host enable` unreachable case reuses the same destination.

## Files changed

- `packages/archid/src/gateway/bin.ts` — `shutdown()`; `main()` returns the server and takes a logger
- `packages/archid/test/gateway/bin.test.ts` — new
- `packages/cli/src/commands/gateway.ts` — new (`serve`, `owner`)
- `packages/cli/src/controller/authority.ts` — new (`remoteOwner`)
- `packages/cli/src/controller/host.ts` — `HostDeps.machineId`, `readFleet`, `seedAuthority`, ordering
- `packages/cli/src/commands/host.ts` — `machineId` in `realDeps`
- `packages/cli/src/main.ts` — `gateway` registered
- `packages/cli/test/gateway.test.ts` — new (real `startAuthorityServer`, real socket, real records)
- `packages/cli/test/cli.test.ts` — `archi gateway owner` end to end against a real authority
- `packages/cli/test/host.test.ts` — the five `host enable` cases
- `packages/cli/test/controller/ssh.test.ts` — the PATH fix for the real-sshd case

No docs reference `archi host enable` or the command list, so nothing else needed updating.

## Self-review findings

- `seedAuthority` opens and closes its own master inside the `authority` step, where `upgradeHost`
  and `addHost` give the master its own `master` step. A connection failure therefore reads as an
  `authority` failure rather than a `master` one. Acceptable for a single-step flow, and the
  unreachable test pins the behavior, but it is a small departure from the Task 15 shape.
- `readFleet(file)` runs twice on a successful enable: once for the id the authority step needs,
  once for the atomic write. Deliberate — re-reading immediately before the write is more correct
  than carrying a stale parse across an SSH round trip.
- `remoteOwner` reads the last stdout line and ignores the remote exit code, because the wrapper
  prints its frame on both paths. It throws with what the far side actually said (stderr, truncated
  to 200 chars) when no frame comes back. This depends on `archi gateway owner` printing exactly one
  line, which it does.
- `--params` is merged before `fleetId`, so `--fleet` always wins over a `fleetId` smuggled into the
  JSON. Checked deliberately.
- The `gateway owner` wrapper does no parameter validation of its own on purpose: one validator
  means one set of error names and one message for the same mistake.

## Concerns

- The real-sshd case cannot be proved green here (no reachable sshd; `ssh localhost` on this machine
  answers `REMOTE HOST IDENTIFICATION HAS CHANGED` and `known_hosts` is off limits). The fix is
  proven to reach the real ssh, and is identical in shape to the one already working in
  `host.test.ts`.
- `packages/archid/test/fleet.test.ts > clears a stale agent status on revive` failed once in three
  full-suite runs and passes in isolation three times out of three. It is a real-tmux `waitFor` test
  in a file this task does not touch — an unrelated pre-existing flake under load, not a signal
  about this change.
- `AuthorityClient`'s `disconnected` and `timeout` codes are not in `AUTHORITY_ERROR_CODES`. The
  wrapper reuses them rather than inventing names, but a later task may want them declared with the
  rest.
- `archi gateway owner` is reachable on the Mac too, where there is no gateway; it answers
  `disconnected` naming the socket it looked for. The right shape, but nothing yet tells a user that
  this machine is not a gateway.
