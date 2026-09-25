# Task 14 — SSH control-master transport

Commit `c71c9da` on `fleet-handover-task14` (forked from `2af5f28`).

## What was implemented

**`packages/cli/src/controller/process.ts`** — `runProcess(exe, argv, { cwd?, env?, timeoutMs,
signal?, maxOutputBytes = 1 MiB, input? })` → `{ code, signal, stdout, stderr, truncated }`. Always
`spawn(exe, argv)`, never a shell. Output is bounded per stream and flagged truncated; a command that
outlives its timeout or whose caller aborts gets SIGTERM and SIGKILL 2 s later. `redact(text,
secrets[])` replaces every secret with `[redacted]`.

**`packages/cli/src/controller/ssh.ts`** — `SshMaster.open({ destination, socketDir? })`,
`check()`, `run(argv, opts)`, `forward(remotePort)`, `cancelForward(localPort, remotePort)`,
`close()`.

- Control socket: `$TMPDIR/archi-<uid>/` created 0700, file name the first 12 hex of
  sha256(destination).
- `open` runs `-O check` first, so a master a previous process left behind is reused; a socket file
  with nothing listening is removed before spawning. A module-level map keyed by the socket path
  makes concurrent opens share one master, refcounted so the last holder is the one that exits it.
- The master is `ssh -M -S <sock> -N -o BatchMode=yes -o ControlPersist=no <destination>`, unref'd
  and killed on process exit so it never outlives the CLI.
- Every other invocation is built by one private `argv()` helper, so all of them carry `-S <sock>`
  and `-o BatchMode=yes`. `run` is `… <destination> -- <argv…>`, with a doc comment saying ssh hands
  the argv to the remote login shell and that user data may not be passed as a remote argument.
- `forward` picks the local port itself (bind 127.0.0.1:0, close, use it), since ssh does not report
  the kernel's choice back for `-O forward`; the race window is documented on the method.
- Errors are `SshError { kind, message }` with `kind` from one pattern table
  (`classifySsh`): auth, host_key, unreachable, version, daemon_down, other.

**`packages/cli/src/controller/connection.ts`** — `ConnectionInfo` (zod),
`remoteConnectionInfo(master, machine, { fleetId, profile? })`, `withReconnect`, `connectRemote`,
`resolveOwner`, `connectFor`.

- `remoteConnectionInfo` runs `<archiBase>/current/bin/archi connection-info --json [-p <profile>]`
  over the master and validates `fleetId`, `machineId` and `protocol` before returning, so the token
  is only handed on once the far end is the machine and fleet that was meant. A mismatch is a typed
  error naming the field (`version` for protocol, `other` otherwise). Exit 255 is classified from
  ssh's stderr; any other non-zero exit is `daemon_down`. A malformed answer is never quoted back,
  because it may hold a token.
- `connectRemote` = open master → info → forward → `Client.connectEndpoint`, the whole attempt
  wrapped in `withReconnect`. The token lives in a local and is never written anywhere.
- `withReconnect` retries only `unreachable` and `daemon_down`, at most 5 attempts, doubling from 1 s
  and capped at 16 s.
- `resolveOwner(fleetHome)` returns `'local'` for now (a later task asks the gateway); `--host`
  overrides it.

**`packages/cli/src/commands/connection.ts`** — `archi connection-info [--json]` prints
`fleetId`/`machineId`/`release`/`protocol`/`host`/`port`/`token` for the target home and exits 1 when
no port file exists. The human reading shows the endpoint and says the token is in `--json` only.

**`packages/cli/src/client.ts`** — added `static connectEndpoint({ url, token })`; `connect(home)` now
reads port/token/host and calls it. Both timeouts unchanged; the two messages that named
`host:port` now name the url.

**`packages/cli/src/main.ts`** — registers `connection-info`, adds the global
`--host <name|local>`, and routes `connect()` through `connectFor`. An ungated fleet with no `--host`
still goes straight to `Client.connect(home)` and never loads the machine registry.

## Tests

`packages/cli/test/fixtures/ssh.mjs` is a stand-in for ssh, symlinked first on PATH by
`packages/cli/test/controller/fake-ssh.ts`. It appends every argv as a JSON line, keeps master and
proxy state in a directory, answers `-O check/forward/cancel/exit`, prints a canned
`connection-info` answer, fails with real ssh wording for the destinations `refused.test`,
`denied.test` and `hostkey.test`, and — for `-O forward` — starts a real local TCP proxy onto the
remote port, so a forwarded client connection is genuinely carried.

`test/controller/ssh.test.ts` (17): argv shapes for open/check/run/forward/cancel/exit; the socket
dir is 0700 and the name 12 hex; concurrent opens spawn one master; a master left by another process
is reused; a stale socket file is removed; a hostile destination and a `$(whoami)` profile arrive as
single argv tokens; the three error classifications; output bounding, timeout kill, abort kill,
stdin, and redaction. The real-sshd test is skipped with its reason in the name unless
`ARCHI_TEST_SSH=<destination>` is set.

`test/controller/connection.test.ts` (14): the companion is asked by absolute path with the profile;
a wrong `fleetId`, `machineId` or `protocol` is refused with the right kind, names the field and does
not contain the token; a companion whose daemon is down reads as `daemon_down`; `connectRemote`
hands back a `Client` talking to a real local `ws` server through the forward, with the token seen
only by the server, absent from every logged argv and with nothing written into the fleet home; a
machine with no ssh destination is refused; an ungated fleet takes the local path and spawns no ssh.
`withReconnect` backoff, giving up after five attempts and not retrying `auth` are driven with fake
timers. The `connection-info` command is tested for its JSON, for keeping the token out of the human
reading, and for refusing when archid is not running.

### TDD evidence

Both test files were written first and run before any source existed:

```
FAIL |cli| test/controller/connection.test.ts — Failed to load url ../../src/commands/connection.js
FAIL |cli| test/controller/ssh.test.ts — Failed to load url ../../src/controller/process.js
Test Files 2 failed (2)
```

After the fixture was made executable and the modules written, three real failures were left and
each one changed either the test or the code: `-O check` runs before the master spawn (test
expectation corrected), `connectRemote` threw synchronously instead of rejecting (made `async`), and
the fake `-O forward` returned before its proxy was listening (fixture now waits, as ssh does).

### Results

- `vitest run --project cli test/controller/ssh.test.ts test/controller/connection.test.ts` — 30
  passed, 1 skipped.
- `vitest run --project cli` — 16 files, 116 passed, 1 skipped.
- `vitest run --project cli --project archid --project protocol` — 78 files, 901 passed, 2 skipped.
- `tsc --noEmit -p tsconfig.json` — clean.
- By hand through the real CLI: `archi connection-info` and `--json` against a temp home, and
  `archi help` showing `--host`.

## Files changed

- Added: `packages/cli/src/controller/process.ts`, `packages/cli/src/controller/ssh.ts`,
  `packages/cli/src/controller/connection.ts`, `packages/cli/src/commands/connection.ts`
- Added: `packages/cli/test/controller/ssh.test.ts`,
  `packages/cli/test/controller/connection.test.ts`,
  `packages/cli/test/controller/fake-ssh.ts`, `packages/cli/test/fixtures/ssh.mjs`
- Modified: `packages/cli/src/client.ts`, `packages/cli/src/main.ts`

Nothing outside the allowed set was touched.

## Self-review findings (fixed before committing)

- `spawn()` could leave its process-exit handler and its child behind when opening failed; both are
  released on every throw path now.
- A failed `Client.connectEndpoint` through the tunnel passed the ws error through unredacted and
  untyped; it is now redacted against the token and classified (`daemon_down` when the endpoint did
  not answer), which also makes a daemon that died between the description and the connect
  retryable.
- The registry the connection tests build was left in `/tmp`; it now lives under the fake ssh's
  directory, which is removed after each test.
- One assertion depended on two test processes appending to the log in order; it now looks for the
  master's argv rather than its position.

## Rulings bent, and why

- `resolveOwner` returns `'local' | MachineEntry` rather than `'local' | MachineRecord`:
  `remoteConnectionInfo` has to check the answer's `machineId` against the registry's id, and only
  the entry carries it.
- `remoteConnectionInfo(master, machine)` takes a third argument `{ fleetId, profile? }`. The local
  fleet id it validates against is not derivable from a master and a machine record.
- `connectRemote({ registry, machine, fleetHome })` takes `machine` as a name or id and resolves it
  through the registry it was handed, so both arguments do work.
- `withReconnect` caps the delay at 16 s but, at 5 attempts, waits 1 s, 2 s, 4 s and 8 s. "Max 5
  attempts" and "1s→16s" cannot both be literal; the attempt count is the one enforced.
- `connectFor` is one small addition beyond the listed interfaces, so that `main.ts` gained only the
  `--host` option and two registrations.

## Concerns

- `archi connection-info --json` prints the daemon token on stdout. That is what the controller reads
  over the master, and the human reading omits it, but any future caller of the command has to treat
  its stdout as a secret.
- The local port for a forward is picked here and handed to ssh, so another process can take it in
  the gap. The window is small, the failure is a clean error, and ssh gives no way to learn the port
  it picked for a `-O forward`.
- `ssh` is resolved on PATH. That is what makes the fake possible, and it matches how the rest of
  the repo spawns tools, but a machine with a broken PATH would find a different ssh.
- The remote argv is handed by ssh to a login shell, so every element must stay a plain token. Only
  the release path and a `-p <profile>` go through it today; the doc comment on `run` says so, but
  nothing enforces it.
- The attribution trailer a session reminder asked for was not added, per the user's standing rule.

---

# Fix pass — four Important review findings

Commit `54badec` "A registry field cannot become an ssh option or a remote command" on
`fleet-handover-task14`.

## Finding 1 — an option-shaped ssh destination

`argv()` and the master spawn now put `--` immediately before the destination, so a registry value
like `-oProxyCommand=…` is data. `run()` keeps a second `--` after the destination: OpenSSH parses
options again once the host is consumed, so without it a remote argument beginning with `-` (our
`--json`, `-p`) would be read by ssh rather than sent. The full shape is
`ssh -S <sock> -o BatchMode=yes [-O <cmd> …] -- <dest> [-- <remote argv…>]`.

`MachineRecord.ssh` is now `/^[A-Za-z0-9][A-Za-z0-9._@:[\]-]*$/` — no leading dash, no whitespace, no
control characters — which still takes `linus@host.tailnet.ts.net:22`.

The fake ssh had to learn ssh's two passes (options, destination, options again) for its argv
parsing to stay faithful.

## Finding 2 — `archiBase` reaching the remote login shell

`MachineRecord.archiBase` is now `/^\/[A-Za-z0-9._\/-]*$/` with a refinement rejecting any `..`
component. `remoteConnectionInfo` re-checks it against that same schema and checks `profile` with
`isProfileName` before building the command, throwing a typed `SshError` naming the field, so a
record written by something that skipped the schema still cannot reach the shell.

## Finding 3 — the socket directory's mode

`ownSocketDir` replaces the bare `mkdirSync`: after the mkdir it `lstat`s the directory and refuses
anything that is not a real directory (catching a symlink someone else put there), that is not owned
by this uid, or that has any group or other bit set. Each refusal is a typed error.

## Finding 4 — a master that died mid-session

- `classifySsh` maps control-socket, `Connection closed`, `Connection reset` and `broken pipe`
  wording to `unreachable`, so a dead master is retryable rather than `other`.
- `open()` now runs `-O check` against a master it has in its map and, when that fails, drops the
  map entry and releases it; the next `start()` removes the stale socket and spawns a new master.
- The forward is cancelled by the attempt that made it whenever the connect fails, rather than by
  `withReconnect` before a retry. It is the same leak, closed at its source: `withReconnect` is
  generic and knows nothing about forwards, and a forward has to be taken back on the last attempt
  too, where there is no retry to hang the cleanup on.

## Covering tests

- `packages/cli/test/controller/ssh.test.ts`: the hostile-destination case now includes
  `-oProxyCommand=touch /tmp/pwned` and asserts every logged argv holds the destination exactly once,
  immediately after the first `--`; a master killed under the controller is re-spawned and answers;
  a pre-created 0755 socket directory and a symlink in its place are both refused; the two new
  stderr wordings classify as `unreachable`. Every argv expectation carries the new `--`.
- `packages/cli/test/controller/connection.test.ts`: an `archiBase` of `/home/linus; touch
  /tmp/pwned` and a profile of `$(touch /tmp/pwned)` are refused with the field named and nothing
  resembling them ever reaching an argv; a daemon that rejects the token leaves `forward` followed
  by `cancel` and no leaked forward.
- `packages/protocol/test/handover.test.ts`: `ssh` refuses `-oProxyCommand=…`, `--`, embedded
  whitespace, a newline and the empty string; `archiBase` refuses `~`-relative, relative, `..`-
  climbing, shell-punctuated and `$`-carrying values.

```
$ node node_modules/vitest/vitest.mjs run --project cli test/controller --project protocol test/handover.test.ts
 ✓ |cli| test/controller/paths.test.ts (9 tests)
 ✓ |protocol| test/handover.test.ts (23 tests)
 ✓ |cli| test/controller/registry.test.ts (10 tests)
 ✓ |cli| test/controller/connection.test.ts (17 tests)
 ✓ |cli| test/controller/ssh.test.ts (20 tests | 1 skipped)
 Test Files  5 passed (5)
      Tests  78 passed | 1 skipped (79)

$ node node_modules/vitest/vitest.mjs run --project cli --project archid --project protocol
 Test Files  78 passed (78)
      Tests  909 passed | 2 skipped (911)

$ node node_modules/vitest/vitest.mjs run --project '@archipelago/desktop-web'
 Test Files  29 passed (29)
      Tests  319 passed (319)

$ tsc --noEmit -p tsconfig.json && tsc --noEmit -p apps/desktop/web/tsconfig.json
TYPECHECK OK
```

## Files changed in this pass

`packages/protocol/src/handover.ts`, `packages/protocol/test/handover.test.ts`,
`packages/cli/src/controller/ssh.ts`, `packages/cli/src/controller/connection.ts`,
`packages/cli/test/controller/ssh.test.ts`, `packages/cli/test/controller/connection.test.ts`,
`packages/cli/test/fixtures/ssh.mjs`.

## Concerns left

- The tightened `archiBase` pattern also governs the local machine's record, whose `archiBase` is
  `archiHome()`. A `$HOME` or `ARCHI_HOME` holding a space or a non-ASCII character now fails
  `MachineRecord`, and `MachineRegistry.load` writes the local record without parsing it, so such a
  machine would only find out on the next load, when the registry is set aside as `.broken`. The
  pattern is the conservative one the review asked for; the registry's unparsed local write is where
  it would show up.
- The re-check in `open()` costs one `ssh -O check` per call on a shared master. That is the price of
  never handing back a master that has died.
- Two opens that race on a master which has just died can each spawn one; the healthy shared path is
  still a single master, which is what the test pins.

---

# Fix pass 2 — quoting instead of a narrow path pattern

Commit `b6c574a` "A remote path is quoted for the far shell, not cut down to fit it" on
`fleet-handover-task14`.

Round 1 bought safety for the remote command line by forbidding characters in `archiBase`, which
also forbade home directories people really have. The ruling reverses that: the command line is made
safe by quoting, and a path is allowed to be a path.

## What changed

- `shellQuote(token)` in `packages/cli/src/controller/ssh.ts`, beside the `run` doc comment that
  explains why a login shell is involved at all: single quotes around the token, with `'\''` for an
  embedded quote.
- `remoteConnectionInfo` quotes the two tokens it builds — `<archiBase>/current/bin/archi` and the
  profile after `-p` — and leaves the literal flags (`connection-info`, `--json`, `-p`) plain.
- `MachineRecord.home` and `MachineRecord.archiBase` share one `MachinePath` schema: absolute, no
  NUL, no newline, no `..` component, anything else allowed — spaces, quotes and non-ASCII included.
  `home` was an unconstrained string before, so it gains the absolute-path check.
- The `ssh` destination keeps round 1's token pattern: a destination is an argument of the
  controller's own ssh command, not a path.
- `remoteConnectionInfo` keeps both re-checks: `archiBase` against that schema, and `profile`
  through `isProfileName`.

## Covering tests

- The fake ssh now reconstructs the remote argv the way the far side does: it joins the remote
  tokens into one line, has `/bin/sh` split it back into words (`printf '%s\0' <line>`), and logs
  those words. `FakeSsh.remoteCalls()` reads them, so a test sees what the login shell was left
  holding rather than what the controller sent.
- `connection.test.ts`: an `archiBase` of `/home/li nus/it's; touch /tmp/pwned` arrives as exactly
  one word, `…/current/bin/archi`, with `connection-info --json -p private` after it — the test
  fails on a syntax error from the shell if the quoting is dropped. The ordinary case asserts both
  the quoted argv and the words it becomes. The rejection case is now a relative path, since a
  shell-punctuated one is legal and safe.
- `ssh.test.ts`: `shellQuote` pins the `'\''` form directly.
- `registry.test.ts`: a local machine whose `$HOME` is `…/Linus's home` loads, saves and loads again
  with no `.broken` registry.
- `handover.test.ts`: `home` and `archiBase` both refuse `~`-relative, relative, `..`-climbing,
  newline-carrying and NUL-carrying values, and both take
  `/Users/José Núñez/Library/Application Support`, `/home/linus/it's here/archi; touch x` and
  `/home/$USER`.

```
$ node node_modules/vitest/vitest.mjs run --project cli test/controller --project protocol test/handover.test.ts
 ✓ |cli| test/controller/paths.test.ts (9 tests)
 ✓ |protocol| test/handover.test.ts (23 tests)
 ✓ |cli| test/controller/registry.test.ts (11 tests)
 ✓ |cli| test/controller/connection.test.ts (18 tests)
 ✓ |cli| test/controller/ssh.test.ts (21 tests | 1 skipped)
 Test Files  5 passed (5)
      Tests  81 passed | 1 skipped (82)

$ node node_modules/vitest/vitest.mjs run --project cli --project archid --project protocol   (three times)
 Test Files  78 passed (78)
      Tests  912 passed | 2 skipped (914)

$ tsc --noEmit -p tsconfig.json && tsc --noEmit -p apps/desktop/web/tsconfig.json
TYPECHECK OK
```

One run of the three suites reported two failures while a second vitest was running beside it on the
same machine; four later runs of the same command, alone, were clean, and the two it named were not
in the controller or protocol files.

## Files changed in this pass

`packages/protocol/src/handover.ts`, `packages/protocol/test/handover.test.ts`,
`packages/cli/src/controller/ssh.ts`, `packages/cli/src/controller/connection.ts`,
`packages/cli/test/controller/ssh.test.ts`, `packages/cli/test/controller/connection.test.ts`,
`packages/cli/test/controller/registry.test.ts`, `packages/cli/test/controller/fake-ssh.ts`,
`packages/cli/test/fixtures/ssh.mjs`.

## Concerns left

- Round 1's concern is gone: a home directory with a space or a non-ASCII character now loads and
  saves like any other.
- `shellQuote` is POSIX. A remote login shell that is not POSIX — fish, csh — would read `'\''`
  differently. The companion is reached through a login shell on Linux and macOS, where sh-compatible
  quoting holds; a fish user's account would be the case to watch.
- Every future remote command has to remember the rule: literal flags plain, everything else through
  `shellQuote`. Only `remoteConnectionInfo` builds one today, and `run`'s doc comment states it.

---

# Fix pass 3 — one option terminator, and it goes before the destination

Commit `9b8b8f2` "One option terminator, before the destination, is what ssh reads" on
`fleet-handover-task14`.

Round 1 added a `--` before the destination *and* kept one before the remote argv. The second one is
wrong: ssh re-enters its own option parsing after the destination only when the options before it
were **not** terminated (`opt_terminated` in ssh.c), so once the first `--` is there the rest of the
line goes to the far side verbatim — including that second `--`, which the remote shell then reads
as a command.

## Verified against a real sshd before changing anything

OpenSSH_10.3p1 client and sshd on this machine, with a scratch `UserKnownHostsFile` so nothing of
the user's was touched:

```
$ ssh -o BatchMode=yes -- localhost -- echo hello      # what round 1 emitted
zsh: no such option:  echo hello
exit=1
$ ssh -o BatchMode=yes -- localhost echo hello         # what it emits now
hello
exit=0
$ ssh -o BatchMode=yes -- localhost printf '%s\n' -v one   # an option-shaped remote argument
-v
one
```

The third is the point of the single `--`: with the destination terminated, ssh never looks at the
remote arguments, so nothing there needs protecting from it.

## What changed

- `argv()` emits one `--`, immediately before the destination, and the remote argv follows the
  destination directly.
- `run()` carries the ssh.c rule in its doc comment, together with the quoting rule from round 2.
- The fake ssh models the real parse: a `--` in the first pass sets `terminated`, and the second
  option pass happens only when it was not set. It also learned attached option values (`-oFoo=bar`),
  without which it could not tell an option-shaped destination from a destination at all.

## Covering tests

- `ssh.test.ts` — the run case asserts the exact argv, that it holds exactly one `--`, and that the
  words the far shell is left with start with the archi path and contain no `--`.
- `connection.test.ts` — the ordinary case asserts everything from the `--` onwards, so a second one
  would fail it; the quoting case asserts the reconstructed first word is the whole archi path.
- Mutation check that the guard still bites: with the `--` removed from `argv()`,
  `carries a hostile destination as one argument after the option terminator` fails (the fake then
  eats `-oProxyCommand=…` as an option, exactly as ssh would). Restored immediately after.

```
$ node node_modules/vitest/vitest.mjs run --project cli test/controller --project protocol test/handover.test.ts
 Test Files  5 passed (5)
      Tests  81 passed | 1 skipped (82)

$ tsc --noEmit -p tsconfig.json && tsc --noEmit -p apps/desktop/web/tsconfig.json
TYPECHECK OK
```

`--project cli --project archid --project protocol` reported one or two failures on two of four runs,
always a different tmux-driven test in `packages/archid/test/fleet.test.ts`, which passes on its own
every time. archid never imports the cli package — it only writes its path into a shim — and this
pass touched nothing outside `packages/cli`, so those are this machine's tmux timing, not the change.

## The opt-in real-sshd test

`ssh -o BatchMode=yes localhost true` does **not** succeed on this machine: sshd answers, but the
user's `~/.ssh/known_hosts:24` holds a stale ECDSA key for localhost, so it fails host key
verification. macOS ssh resolves `~` through the passwd entry rather than `$HOME`, so the isolated
HOME the suite runs under cannot be given a known_hosts of its own, and `SshMaster` has no way to
pass `-o UserKnownHostsFile=…`. I did not touch the user's known_hosts, so `ARCHI_TEST_SSH=localhost`
was not run and the test stays skipped.

What was run against the real sshd instead: the three client commands above, and an ad-hoc script
driving the real `SshMaster` at localhost, which failed at the master with
`kind: 'host_key'` — the classifier reading real OpenSSH 10.3 stderr correctly.

## Files changed in this pass

`packages/cli/src/controller/ssh.ts`, `packages/cli/test/controller/ssh.test.ts`,
`packages/cli/test/controller/connection.test.ts`, `packages/cli/test/fixtures/ssh.mjs`.

## Concerns left

- The suite's green on this only ever means as much as the fake's fidelity. Two guards now stand
  behind it: the fake models `opt_terminated` and attached option values, and the remote argv is
  reconstructed by a real `/bin/sh`. Neither is the real ssh; the three commands above are.
- `packages/archid/src/setup.ts` has a private `shq` with the same semantics as `shellQuote`. Two
  copies now exist in the repo. Merging them means touching archid, which was outside this task's
  files; worth one follow-up.
