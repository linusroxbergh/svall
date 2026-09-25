# Task 28 ↔ 29 contract: the `archi handover` helper and the Mac app

28a builds the helper (`packages/cli`, on fleet-handover-impl). 29 spawns it and renders it
(`apps/desktop/web`, `apps/desktop/mac`, on its own branch). Neither changes this contract without
the controller; a gap either side finds is reported, not patched on the other's tree.

## Commands

Global `-p/--profile <name>` and `--json` apply to every form, resolved like every other `archi` command.

- `archi handover <host|local> [--interrupt-after <duration>] [--terminate-shells] [--archive <path>]... [--detach]` — start.
- `archi handover --resume [--detach]`, `archi handover --abort [--detach]`.
- `archi handover --forget` — drops a controller journal the gateway has superseded, and the events file with it (see task-28a-carried.md 8).
- `archi handover status` — read-only.
- `archi handover attach` — follow and steer the live helper.

`local` is this machine's stable id. `--archive <root>` takes the root id a blocker's `entity`
names (`kind: "root"`), and fills `HandoverChoices.archiveRoots`. `--interrupt-after` accepts at
least `0`, `<n>s` and `<n>m`; the app sends `0s` for Interrupt and carry.

## Output

With `--json`, stdout carries one `HandoverEvent` per line (`packages/cli/src/controller/events.ts`),
in order, and nothing else; diagnostics go to stderr. A run's last line is `handover.result`, whose
`data` is the `Outcome`. No token appears on stdout, stderr, in the events file or the log.

Added to the vocabulary:

- `{"event":"handover.status","data":<Verdict> & {"helper"?:{"pid":<n>}}}` — `status`'s one line, and
  `attach`'s last line when no helper is live. `Verdict` is `recovery.ts`'s, `safe` saying what
  may follow; `standing: "superseded"` means `--forget` is the way out.
- `{"event":"handover.detached","data":{"pid":<n>}}` — the only stdout line of a `--detach` launcher.
- `handover.preflight`'s `data` may carry `names: { characters: { <id>: <name> }, roots: { <id>: <destination path> }, sessions: { s<i>: <character name> } }`,
  for rows and blockers that name entities only by id.
- A `handover.entity` row of `kind: "session"` has the id `s<i>`: the session at index `i` of the manifest's `sessions`, all of its
  files as one row. `names.sessions` names it by the character whose session it is.

The daemons' own `handover.entity` events (the source's per-character rest rows during `freeze`,
the destination's per-character results during `activate`) are relayed into the stream in the shape
they arrive in, so the sheet has stable character rows while resting. Only the controller emits
`handover.changed`; its phases move forward, and it emits `handover.changed` for the current phase
again once a `handover.blocked` decision is answered, so a replayed stream shows the decision closed.

## Detached helper (the app's path)

`--detach` makes the command a launcher: it starts the transaction in a child in its own session
(stdin and stdout closed, stderr to `<fleetHome>/controller/handover.log`, mode 0600), waits until
the child's control socket accepts, prints `handover.detached` and exits 0. If the child cannot
start (another helper is live, the fleet has no gateway, bad arguments), the launcher prints a
`handover.result` naming why and exits nonzero. The child never cancels for want of an audience: a
decision it needs waits until an attached client answers it.

Quitting the app kills nothing but its `attach` process; the helper goes on.

## Events file and control socket

The helper appends every event it emits to `<fleetHome>/controller/events.ndjson` (mode 0600,
scrubbed like the journal, truncated when a new start/resume/abort begins). It listens on a Unix
socket, mode 0600 in a 0700 directory, at `<fleetHome>/controller/handover.sock` — or, when that
path is too long for a Unix socket, at a hashed path under a 0700 `$TMPDIR` directory, as the ssh
control sockets are. `<fleetHome>/controller/handover.lock` (0600, holding the helper's pid) is the single-controller lock:
the helper takes it before it listens and holds it for its life; start, `--resume`, `--abort` and
`--forget` refuse while a live holder has it, naming `archi handover attach`. Only the lock's holder
removes a stale socket; readers only probe. A holder that is gone (killed, or the machine rebooted)
never blocks the next start.

Socket protocol, NDJSON both ways. Helper → client: every event of this run so far, then each new
one, ending with `handover.result`, then the helper closes the socket. Client → helper:

- `{"choose":<HandoverChoices>}` — answers the pending decision (the last event was
  `handover.blocked`), or, while Freeze is still waiting on agents, asks it again with these choices
  (Task 27's `choose()`: "Interrupt and carry" mid-rest).
- `{"cancel":true}` — exactly Ctrl-C (Task 27's `cancel()`): before Freeze a clean stop, after Freeze
  a safe abort, after Commit only the watcher lets go and the move goes on.

Unknown or malformed lines are ignored. Several clients may attach; each gets the whole stream.

## `archi handover attach`

Connects to the live helper and relays: socket → stdout, stdin → socket. Stdin reaching EOF ends
`attach` (exit 0) and never touches the helper. When no helper is live it prints the events file's
lines, then one `handover.status`, and exits 0. Without `--json` it renders the same stream as the
foreground command would.

## Exit codes

0 when the command did what it was asked (a start or `--resume` that completed, an `--abort` that
aborted, `status`, `attach`, `--forget`, a launcher that detached); 1 otherwise, including blockers
before Begin in a non-interactive run.

## What the app does with it (Task 29)

- Start: spawn `archi [-p P] handover <dest> --json --detach [...]`, then `archi [-p P] handover attach --json`.
- Observe: read `attach`'s stdout lines. Answer a decision or cancel by writing a control line to its stdin.
- Relaunch: spawn `attach --json`; a live helper replays the run, otherwise the events file plus
  `handover.status` rebuild the sheet, whose Resume/Abort run `--resume --json --detach` /
  `--abort --json --detach` and attach again.
- Close terminal surfaces on `handover.changed` → `freeze`; after `handover.result` `complete`
  (also `detached` then a later `complete`), resolve the owner and reconnect through the existing
  `archi connect --json` helper (task-17-contract.md).
