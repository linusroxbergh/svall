# M3 Part B fix wave — P1–P5 (binding)

Source: W/m3-onmachine-B-report.md, section "Defects" (D1–D6 there) and the cell paragraphs it cites.
Each item carries the controller's ruling; the spec wins over anything here that contradicts it.

P1 (Important, D1). A daemon WebSocket that closes between calls (a master drop, or the far daemon
restarting) is kept. The next call is sent on the dead socket and hangs for its whole deadline: freeze
and claim 930 s, abort 30 s, complete 150 s. It never reconnects.
- Cause: `reconnecting` drops its client only when a call through it fails (packages/cli/src/controller/reach.ts:94-118).
- `Client.call` sends on a closed socket without error (packages/cli/src/client.ts:97-108), because
  ws's send-after-close only counts bytes when no callback is given.
- `Client` sees the close (client.ts:54), but nothing tells `reconnecting`.

Ruling: a call on a client whose socket is closing or closed fails at once, with the same transient
error a call cut off in flight gets, so `reconnecting` drops the client and reconnects. A close with
calls pending rejects them at once. They must not wait out their timers.

Test: close the socket between two calls; the second call reconnects and answers well inside a second,
not at the deadline.

P2 (Important, D6). A destination daemon that dies mid-activation leaves the characters it had opened
but not started sitting at a shell prompt, with the resume command typed but never run. Their
`agent`/`revive` state is dropped, and the run still ends `complete` with 10 of 14 characters listed and
no error.
- The retried Activate starts only slots with no window (`wake`, packages/archid/src/handover/destination.ts:470-477),
  so a window the dead daemon opened is taken as live. `wakeSlot` (:479) never runs for it and
  `characterResults` (:93) has no row for it.
- The cleared `agent` is most likely the restarted daemon's reconcile reading a pane with no agent
  process. Trace it.

Ruling: activation is idempotent per slot and never counts a window as live on its presence alone. On
a retried Activate, a slot this transaction opened whose agent is not running is started again: its
typed-but-unrun command is cleared, or the window is replaced. That slot gets its activation row.
Reconcile must not erase a rested character's `agent`/`revive` while a handover's activation owns that
slot, or before the slot has been activated. Every character in the transaction ends with a row. A
character that cannot resume stays dormant with its transcript and a visible error, as the spec says,
never silently missing.

Test: kill the daemon after it opens some windows and before it starts their agents. The retried
activation starts every character and reports all of them, and no state loses `agent`/`revive`.

P3 (folded, D2). After the Linux machine's archid, tmux server and agents all die mid-freeze,
`handover status` offers resume, and resume can never succeed. Every attempt fails with `tmux
list-panes … no server running`.
- The restarted frozen-source daemon starts no tmux server (handover/startup.ts:45-49).
- The rest reads panes unconditionally (handover/rest.ts:221).

Ruling (the spec: "`archi handover status` says whether Abort or Resume is safe"; a resume that cannot
succeed breaks that): the rest treats "no tmux server" as no live panes. Every terminal is then rested,
and the resume goes on. If that is not safe for some state, status must not offer resume there.

Test: resume a freeze after the tmux server is gone.

P4 (folded, D3). A foreground `archi handover --json` that has printed its result stays alive while a
dead call's timer runs. In A2d it lingered over 5 min.
- `exit` only sets `process.exitCode` for a non-helper run (packages/cli/src/commands/handover.ts:588).
- The abandoned client's pending timer (client.ts:100) holds the loop.

Ruling: this sits in P1's code. The client's call timers must not keep the process alive once the run
is over: unref them, or close every client at the end of the run. After its result, the process exits.

P5 (folded, D5). A foreground `--json` helper dies of an unhandled `EPIPE` when its stdout reader goes
away. The error comes from `Observer.record`, through the `--json` line writer (commands/handover.ts:96).

Ruling: this is a one-line guard in the file P4 touches. An EPIPE on stdout stops output and leaves the
run to finish or stop through its journals. It never crashes the controller mid-transaction.

Not in this wave:
- D4 (a SIGKILLed helper leaves its ssh -M master). It joins the M2 parked item "per-process sockets
  mean a master orphaned by SIGKILL/OOM is never reaped" for the final review; no in-process handler
  sees SIGKILL.
- The "none open anywhere" wording when the gateway is unreachable. Deferred.

Verification: a failing test first for each item. Covering suites while iterating. At the end, run
typecheck and the archid, cli and protocol full suites once. Known load flakes (rerun them alone; they
are not findings): archid fleet.test.ts revive tests and "marks the agent working", e2e "two turns
against a fake claude", processes.test.ts real-ps case, source.test.ts FIFO timer; cli cli.test.ts
browser, ssh.test.ts spawn-count.
