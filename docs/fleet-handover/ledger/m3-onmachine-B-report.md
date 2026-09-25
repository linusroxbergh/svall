# M3 gate on-machine pass, Part B: a disconnect or a kill at every phase, both directions

Status: **DONE_WITH_CONCERNS**

All 36 cells ran (none NOT RUN): **33 PASS, 3 FAIL**. The carried items C1–C4 all PASS. The ownership invariant held
in every run: 41 injected handover runs, and in each the 0.3 s samplers on both machines saw no destination window or
agent before the gateway's commit and no source window or agent after it. Every fenced side refused revive and attach,
abort was refused after every commit, and every snapshot matched the last good one. The final state matches the
small-fixture baseline (b01-mac → final-mac: 0 DIFF) after 44 generations.

The three FAILs come from two Important defects:
- **D1** (A2d, B1d): a daemon WS that closes between calls is kept, so the next call hangs for its whole deadline, up to
  15.5 min for a freeze or a claim. Six PASS cells (B5d, B6d, B7d, B8d, B9d, B9k) also hit it as a 150 s stall in
  Complete, and then completed on their own.
- **D6** (A8k): a destination daemon that dies mid-activation leaves some characters at a shell with their session
  dropped. The handover still reports `complete`, and those characters are missing from its result.

Four Minors (D2–D5) are listed at the end.

The matrix below was written before the first injection. Some cells were re-run with a sharper trigger (suffix 2 or 3),
and each paragraph says why. The session stalled once, during B6d, while the Mac slept 00:13–00:28 UTC. The
environment was checked and B6d's result read back from its logs before going on.

`$S` = the A2 scratchpad (`…/scratchpad/m3-onmachine-a2`, whose wrappers and environment this part reuses).
`$B` = `/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/458d4622-7488-4208-9faa-1ee5a901238b/scratchpad/m3-onmachine-b`.

## Phases

From the spec's State machine and `packages/cli/src/controller/handover.ts:93` (`PHASES`), as the controller journals
them and its events stream (`$FH/controller/events.ndjson`, and the helper's `--json` stdout) shows them:

| Phase | What runs | Where the stream shows it |
| --- | --- | --- |
| begin | gateway `owner begin` over the master (`archi gateway owner 'begin'`) | `handover.preflight` just before the call; `handover.changed begin` once it answered |
| freeze | source daemon `handover.freeze` (rests every terminal, answers the manifest) | `handover.changed freeze`; the source's own `handover.entity` rows (phase freeze) while it rests |
| transfer | destination `handover.claim`, then rsync per root and session over the master | `handover.changed transfer`; entity rows phase transfer; `bin/rsync` processes |
| verify | per entry: scan + `rsync --dry-run --checksum` passes (inside the transfer loop); then the landed digest is journaled | entity rows phase verify; `--dry-run` rsync processes; `handover.changed verify` when all verified |
| prepare | destination `handover.prepare` (Git repair, sessions placed, prepared state) | `handover.changed prepare` |
| ready | gateway `owner ready` | `handover.changed ready`; `gateway owner 'ready'` ssh |
| commit | gateway `owner commit` (the point of no automatic return) | `handover.changed commit`; `gateway owner 'commit'` ssh |
| activate | destination `handover.activate` (promotes state, starts windows) | `handover.changed activate`; entity rows phase activate |
| complete | destination, then source `handover.complete`, then gateway `owner complete` | `handover.changed complete` |

## Injections

- **Disconnect**, one of:
  - `drop`: SIGKILL the controller's ssh master (`ssh -M -S …/m3b/archi-502/…`, a descendant of the helper) once. The
    forward and every WS through it go with it; rsync cannot fall back (it targets `archi-remote.invalid`).
  - `outage`: the master and every ssh/rsync the helper spawns are SIGKILLed every 50 ms for 30 s, so the
    controller's own retries (4 attempts, 1/2/4 s back-off) cannot get through. This is the disconnect that forces the
    helper to stop and `handover status` to offer a way on. The daemons' own ssh (the Mac daemon's gateway check) is
    not touched.
- **Kill**, one of: the controller helper (SIGKILL), the source daemon, the destination daemon (Mac: SIGKILL, then
  restarted after 2 s as launchd would; m3: `systemctl --user kill --kill-whom=main -s SIGKILL`, systemd restarts it
  after 2 s), the gateway (`systemctl --user kill -s SIGKILL archipelago-gateway.service`, restarted after 2 s).
- "answer lost": the helper (or the ssh client carrying the call) is SIGSTOPped the moment the call's
  `gateway owner '<op>'` ssh appears, left 3 s so the gateway acts, then killed: the op happened and its answer never
  arrives.
- "held" (A7d3, A7k3, B6k3, B6d3): the Commit/Ready ssh lives about 0.2 s, less than a 60 ms `ps` poll can be sure
  of, so a test shim (`$B/shim/ssh`, ahead of `/usr/bin/ssh` on the helper's PATH only in those cells) runs the first
  `gateway owner '<op>'` for real, keeps its answer in `run/hold-answer`, waits, and exits 255 with nothing on stdout:
  the gateway acted and the answer never reached the controller. Every other ssh passes straight through.
- "pinned": the helper is SIGSTOPped at the trigger event, the injection lands, then SIGCONT, so the injection sits
  exactly between two steps.

Direction A = Mac → Linux (`archi handover m3`; source the Mac daemon, reached locally; destination m3's daemon over the
master's `-O forward`; gateway on m3 over the master). Direction B = Linux → Mac (`archi handover local` on the Mac;
source m3's daemon over the forward; destination the Mac daemon; same gateway).

Checks per cell: the helper's result; `archi handover status --json` (standing, `safe`); both daemons' ownership and
journal; a revive/attach attempt on the side that must be fenced; a 0.3 s sampler on each machine for the whole cell
(non-`_keep` windows, mocked agents, and on m3 the gateway record file) from which the invariant is read: before the
gateway's commit no destination window or agent, after it no source window or agent. Then the offered recovery, the same
checks again, and a snapshot of the owning side compared with the last good one (`$S/bin/compare.mjs`).

## Injection matrix

| Cell | Dir | Phase | Injection | Trigger | Planned recovery | Result |
| --- | --- | --- | --- | --- | --- | --- |
| A1d | M→L | begin | outage 30 s | `handover.preflight` | offered | **PASS**: interrupted@begin, Begin had opened tx at the gateway; resume adopted it → g9 |
| A1k | M→L | begin | helper SIGKILL, Begin's answer lost | `gateway owner 'begin'` ssh appears | abort | **PASS**: open [resume, abort]; abort → aborted@begin |
| A2d | M→L | freeze | drop | first source freeze row | offered | **FAIL** (D1): claim hung on the dead WS; cancelled after 150 s → aborted, Mac revived |
| A2k | M→L | freeze | source (Mac) archid SIGKILL, restarted | first source freeze row | abort | **PASS**: restarted daemon came up frozen; freeze retry answered from its journal → g11 unattended |
| A3d | M→L | transfer | drop mid-rsync (carried C1), 64,000-file bulk | notes rsync running 3 s | resume | **PASS**: interrupted@transfer; resume → g7 |
| A3k | M→L | transfer | helper SIGKILL (detached helper, the app's path) | first rsync process | abort | **PASS**: open [resume, abort]; abort → Mac revived 16/14 |
| A4d | M→L | verify | drop during a checksum dry run | first `--dry-run` rsync | resume | **PASS**: interrupted@transfer (rsync 12); resume → g13 |
| A4k | M→L | verify | destination (m3) archid SIGKILL, pinned | `handover.changed verify` | offered | **PASS**: prepare retried onto the restarted daemon → g15 unattended |
| A5d | M→L | prepare | drop with prepare in flight | `changed prepare` + 0.3 s | offered | **PASS**: prepare retried → g17 unattended |
| A5k | M→L | prepare | helper SIGKILL | `changed prepare` + 0.5 s | resume | **PASS** (landed in commit, see A5k2): committed [resume]; resume → g19 |
| A6d | M→L | ready | outage 30 s | `changed ready` | abort | **PASS**: gateway at ready-to-commit, open [resume, abort]; abort → Mac revived |
| A6k | M→L | ready | gateway SIGKILL, pinned | `changed ready` | offered | **PASS**: Ready retried through the gateway restart → g23 |
| A7d | M→L | commit | master killed 0.1 s into the commit's ssh, then outage 30 s (carried C2) | `gateway owner 'commit'` ssh appears + 0.1 s | resume (abort must be refused) | **PASS** (A7d3): interrupted@commit safe []; status committed [resume]; abort refused; resume → g29 |
| A7k | M→L | commit | helper SIGKILL, commit's answer lost | `gateway owner 'commit'` ssh appears | resume (abort must be refused) | **PASS** (A7k3): committed [resume]; abort refused; resume → g31 |
| A8d | M→L | activate | drop | `changed activate` + 1 s | offered | **PASS** (A8d2): activate re-asked after reconnect, 14/14 ok, no duplicates → g35 |
| A8k | M→L | activate | destination (m3) archid SIGKILL | `changed activate` + 1 s | resume | **FAIL** (D6): complete g37 listed 10 of 14; 4 left at a shell with the resume typed, session link dropped |
| A9d | M→L | complete | drop | `changed complete` | offered | **PASS**: Complete retried after reconnect → g39, no pending |
| A9k | M→L | complete | source (Mac) archid SIGSTOP ("asleep", carried C3), SIGCONT after the helper ends | `changed complete` | resume | **PASS**: complete g41 pending [source]; status moved [resume]; resume finished it |
| B1d | L→M | begin | drop, pinned | `changed begin` | offered | **FAIL** (D1): freeze sent into the dead WS, 930 s timeout; resume afterwards → g10 |
| B1k | L→M | begin | gateway SIGKILL, pinned | `handover.preflight` | offered | **PASS**: Begin retried through the gateway restart → g12 |
| B2d | L→M | freeze | outage 30 s | first source freeze row | abort | **PASS**: interrupted@freeze; abort → m3 unfrozen, revived 16/14 |
| B2k | L→M | freeze | source (m3) archid SIGKILL | first source freeze row | resume | **PASS** as planned (B2k2 → g14 unattended); the first run killed the whole unit: resume can never succeed (D2) |
| B3d | L→M | transfer | drop mid-rsync (carried C1), 64,000-file bulk | notes rsync running 3 s | resume | **PASS**: interrupted@transfer; resume → g8 |
| B3k | L→M | transfer | destination (Mac) archid SIGKILL during claim, restarted | `changed transfer` | offered | **PASS**: claim retried onto the restarted daemon → g16 |
| B4d | L→M | verify | outage 30 s, pinned | `changed verify` | resume | **PASS**: interrupted@ready; resume → g18 |
| B4k | L→M | verify | helper SIGKILL during a checksum dry run | first `--dry-run` rsync | abort | **PASS**: open [resume, abort]; abort → m3 revived 16/14 |
| B5d | L→M | prepare | drop | `changed prepare` | offered | **PASS** with a 150 s stall (D1) in Complete → g20 |
| B5k | L→M | prepare | destination (Mac) archid SIGKILL, restarted | `changed prepare` + 0.3 s | offered | **PASS**: prepare retried onto the restarted daemon → g22 |
| B6d | L→M | ready | drop with Ready in flight | `gateway owner 'ready'` ssh appears + 0.1 s | offered | **PASS** with a 150 s stall (D1) in Complete → g24; B6d3 (Ready answer lost + drop) → g32, same stall |
| B6k | L→M | ready | helper SIGKILL, Ready's answer lost | `gateway owner 'ready'` ssh appears | resume | **PASS** (B6k3): ready-to-commit, open [resume, abort]; resume re-sent Ready → g28 |
| B7d | L→M | commit | drop with Commit in flight | `gateway owner 'commit'` ssh appears + 0.1 s | offered | **PASS** with a 150 s stall (D1) in Complete → g26 (run as B7d2) |
| B7k | L→M | commit | gateway SIGKILL, pinned | `changed commit` | offered | **PASS**: Commit re-asked through the gateway restart → g30 |
| B8d | L→M | activate | outage 30 s | `changed activate` | resume | **PASS** with a 150 s stall (D1) in Complete → g34 |
| B8k | L→M | activate | helper SIGKILL | `changed activate` + 1 s | resume | **PASS** (B8k2): destination finished activating alone; committed [resume]; resume → g36 |
| B9d | L→M | complete | outage 30 s | `changed complete` | resume | **PASS** with a 150 s stall (D1) in Complete → g42, no pending |
| B9k | L→M | complete | source (m3) archid SIGKILL | `changed complete` | offered | **PASS** with a 150 s stall (D1): source Complete on the closed WS, then retried → g40 |

Carried items:

| Item | Cell | Result |
| --- | --- | --- |
| C1 a master drop mid-transfer | A3d, B3d | **PASS** both ways: rsync cannot fall back past a dead master (`archi-remote.invalid`), the run stops interrupted@transfer with [resume, abort], and resume finishes (64,000-file notes root, 69–70 s) |
| C2 ssh killed mid-Commit, then resume | A7d (A7d3) | **PASS**: the gateway committed, the answer was lost; the helper stopped `interrupted@commit` with safe [] (unknown); status then committed [resume]; abort refused; resume → g29 |
| C3 the Mac "asleep" at Complete → source pending, resume completes | A9k | **PASS**: `complete` with pending ["source"] after about 3 min of retries; status moved [resume]; after SIGCONT, resume → complete, journal cleared |
| C4 gateway off: gated daemon start ≤ ~10 s, ssh fails fast, `archi connect --json` retries through it | separate | **PASS**: gateway unit stopped: daemon start 0.6 s (Mac) / 0.3 s (m3), connect online 0.4 s; offline (black-holed route): ssh fails at 10.1 s, daemon start 10.3 s, connect online after 10.2 s on the cached route; m3 owning: connect online via m3 in 1.3 s |

## Results

How to read a cell: `$B/logs/<cell>.log` is the timeline (events, trigger, injection, state on both machines, status,
fence probe, recovery, invariant); `<cell>.ndjson` the helper's stream; `<cell>.recover.ndjson` the recovery's;
`<cell>.m3-samples`/`.mac-samples` the 0.3 s samplers; `<cell>.summary.json` all of it; `cmp-<cell>.txt` the
snapshot comparison. PASS means: the invariant held in the samples, the fenced side refused revive and attach, the
offered action (or the run itself) reached a clean state (owner 16 windows/14 agents, the other side 0/0, no
transaction, no controller journal), and the snapshot matched the last good one. Every comparison listed below
printed only A2's standing note `home:docs/deep: dir mode 755 <-> 775` across machines, and 0 DIFF on the same machine.
The two exceptions are B2k-r and A8k2, each explained in its paragraph; each was clean again after the by-hand step.

Harness facts learned on the way (not product findings):
- `systemctl --user kill` without `--kill-whom=main` kills the unit's whole cgroup: archid, its tmux server and every
  agent (the unit's `KillMode=process` only governs stop). The first B2k run did that; the harness then used
  `--kill-whom=main` for every later m3 archid kill (B2k2 onward). The gateway unit runs one process, so the
  default and main-only kills of it are the same.
- A foreground `archi handover` whose trigger stage waited on a delay could land a step late: A5k's 0.5 s delay
  outlasted prepare (0.4 s here), so it became a commit-phase kill; A5k2 is the prepare-phase kill.
- The Mac idle-slept 00:13–00:28 UTC during B6d (pmset log), which is what stretched its 150 s Complete stall and
  stopped the session.

### Mac → Linux (A)

**A1d begin, outage 30 s from `handover.preflight`: PASS.** The first `gateway owner begin` ssh was killed (255, no
frame), the master could not reopen (3 retries), result `interrupted@begin`, safe [resume, abort], the controller
journal holding no transaction id. The Begin had reached the gateway all the same: after the outage the record held
tx 604d0736 `preparing`, and `handover status` found it (standing open, [resume, abort]). The Mac was never frozen
(16/14 throughout). `--resume` adopted that transaction and completed at g9 (21 s). Invariant held (commit
23:28:58.7 UTC). Compare b01-mac → A1d-m3-linux clean.

**A1k begin, helper SIGKILL with Begin's answer lost: PASS.** The helper was SIGSTOPped the moment its
`gateway owner 'begin'` ssh appeared, left 3 s, killed. The gateway held tx f34fedc2 `preparing`; the controller
journal `{"phase":"begin"}` with no id. Status: open, [resume, abort]. `--abort` → `aborted@begin` in 1 s; gateway
clear, Mac unchanged at g10. The killed helper left its `ssh -M` master running (orphan, ppid 1); see D4.

**A2d freeze, master drop at the first source freeze row: FAIL (D1).** The freeze is local on the Mac and finished.
The claim to m3 then went out on the WS that had run through the dead master's forward. No error came back: the
helper sat at `changed transfer` holding only its TCP connection to the Mac daemon (lsof), no child, no retry, for
150 s, when the harness sent `{"cancel":true}` through `archi handover attach`. The claim's own deadline would have
been 930 s (`CLAIM_TIMEOUT_MS` + 30 s). The cancel aborted: `handover.abort` to m3 again waited 30 s on the dead socket
(`archid did not answer handover.abort within 30000ms`), the retry reconnected, result `aborted@transfer`, the Mac
revived 16/14 at g10. The foreground helper printed its result and then stayed alive over 5 minutes (the dead claim's
timer), and was killed by hand (D3). Invariant held; compare clean.

**A2k freeze, source (Mac) archid SIGKILL mid-rest, restarted 2 s later: PASS.** The restarted daemon logged
`handover e665f48f… froze this fleet at freeze; it is read-only until the controller resumes or aborts it`. The
controller's freeze retries (#1 `archid connection closed`, #2 `ECONNREFUSED`) reached it and it answered the freeze
from its journal; the run completed at g11 with no user action. Invariant held.

**A3d transfer, drop mid-rsync (C1), 64,000-file bulk: PASS.** Dropped 3 s into the notes rsync:
`rsync exited 255: Control socket connect(…): Connection refused / ssh: Could not resolve hostname archi-remote.invalid`
(no fallback connection). Result `interrupted@transfer` [resume, abort]; the Mac frozen+surrendered with its source
journal at freeze; m3 0 windows; m3's revive/attach refused. `--resume` → complete g7 in 69 s. Compare b00-mac →
A3d-m3-linux clean.

**A3k transfer, detached helper SIGKILL mid-rsync (the app's path): PASS.** Killed with its rsync and ssh children
running. Status open [resume, abort]; `--abort` → `aborted@transfer` in 3 s; the Mac unfrozen and revived 16/14.
Orphan master (D4).

**A4d verify, drop during a `--dry-run --checksum`: PASS.** `rsync exited 12`, `interrupted@transfer`;
`--resume` → complete g13.

**A4k verify, destination (m3) archid SIGKILL pinned at `changed verify`: PASS.** Helper paused, m3's main process
killed, systemd restarted it (listening 2.5 s later), helper resumed: `retry prepare #1: archid connection closed`,
then prepare on the restarted daemon, complete g15 unattended.

**A5d prepare, drop 0.3 s into prepare: PASS.** `retry prepare #1: archid connection closed`, reconnect, complete g17.

**A5k helper SIGKILL (landed in commit): PASS.** The kill came 50 ms after `changed commit` with the commit's ssh
running. Gateway: tx 5816a10b `committed`, g19. Status: committed, safe [resume] only; the Mac (source, frozen)
refused revive/attach (`frozen`). `--resume` → complete g19.

**A5k2 prepare, helper SIGKILL at `changed prepare`: PASS.** Gateway `preparing`, the Mac source journal at freeze,
m3's destination journal at prepare (m3 frozen, 0 windows). Status open [resume, abort]; `--resume` → complete g21.

**A6d ready, outage 30 s from `changed ready`: PASS.** The Ready's ssh died (255, no frame) but the gateway had
recorded `ready-to-commit`; three retries could not reach it; `interrupted@ready` [resume, abort]. Status: open
(`ready-to-commit and has not committed`). `--abort` → `aborted@ready`: gateway cleared at g22, m3's prepared journal
dropped, the Mac revived 16/14. Invariant held (m3 never had a window).

**A6k ready, gateway SIGKILL pinned at `changed ready`: PASS.** `retry ready #1/#2: … authority.sock: ECONNREFUSED`,
systemd restarted the gateway, Ready went through, complete g23.

**A7d commit, as first planned (poll for the commit's ssh): NOT INJECTED.** The commit's ssh lives about 0.2 s and a
`ps` poll here takes 60 ms; the run completed at g25 before the poll saw it. The `--abort` after it answered `none`.
A7d2 single-stepped the helper (2 ms at a time) and missed it too: a stopped helper does not reap its finished ssh,
which then shows in `ps` only as `(ssh)`; it completed g27 uninjected. A7d3 uses the shim.

**A7d commit, ssh killed mid-Commit then resume (C2): PASS** (run as A7d3). The gateway committed g29 (the held answer
is the committed record); the shim's ssh was then killed by a 30 s outage that also took every master the helper tried
to open. Commit's follow-up `gateway.get` failed three times and the helper stopped with
`interrupted@commit`, `whether 12263dd8… committed is unknown (… exited null without an ownership frame); resume asks the
gateway again`, **safe []**: it offered neither abort nor resume while it could not know. The Mac (source) stayed frozen
and refused revive/attach (`frozen`); m3 held its destination journal at prepare with 0 windows. After the outage,
status: committed, safe [resume]. `--abort` was refused (`interrupted@commit … only its activation can go on`,
safe [resume]); `--resume` → complete g29 in 2.4 s. Invariant held (commit 07:05:42.4; no source window after it).

**A7k commit, helper SIGKILL with Commit's answer lost: PASS** (run as A7k3; the first-planned poll would have missed
the ssh as A7d did). The gateway committed g31; the helper was killed while the shim held the answer. State: gateway
`committed`, the Mac (source) frozen with its journal at freeze and refusing revive/attach (`frozen`), m3 holding its
destination journal at prepare with 0 windows, controller journal at commit. Status: committed, safe [resume].
`--abort` refused (safe [resume]); `--resume` → complete g31. Orphan master (D4).

**A8d activate, drop 1 s into activate: landed in Complete.** Activate took 1.08 s, so the master died 1 ms after
`changed complete`, with the destination's Complete call in flight; the run completed at g33 0.85 s later with no
retry. Recorded as an extra complete-phase drop; A8d2 is the activate-phase one.

**A8d2 activate, drop 0.3 s into activate: PASS.** `retry activate #1: archid connection closed`; the retry reached m3,
which was already activating, and answered for all 14 characters; complete g35 with 16 windows and 14 agents on m3 (no
character started twice). Invariant held (commit 07:14:39.2).

**A8k activate, destination (m3) archid SIGKILL 0.3 s into activate: FAIL (D6)** (run as A8k2; at 1 s the kill would
have landed in Complete). systemd restarted archid, which came up `at activate on this machine; read-only until it is
activated`; the controller's activate retries (#1 connection closed, #2 ECONNRESET) reached it, it answered, and the
run ended **complete g37** with a `characters` list of 10. The four beta characters were missing from it, with no error
anywhere. On m3 their windows existed but ran bash with `claude --resume <id> --add-dir '/home/archi-m3/notes'` typed at
the prompt and never run (the first daemon died between typing the command and its Enter); their state had lost
`agent` (session id, transcript path) and `revive`; 16 windows, 10 agents. The compare against B8k2 showed exactly
that (4 × `agent … -> undefined`, 4 × `session …/main: not in the destination state`). The invariant held (no source
window after the commit, no destination window before it). By hand, one Enter in each of the four panes started the
resumed sessions; their SessionStart restored `agent` with the carried session ids; 16/14, and the compare
(`cmp-A8k2-fixed`) is clean (`logs/A8k2.manual-enter.log`).

**A9d complete, drop at `changed complete`: PASS.** The destination's Complete was in flight on the WS:
`retry complete #1: archid connection closed`, reconnect, complete g39 2 s later, no pending.

**A9k complete, the Mac "asleep" at Complete (C3): PASS.** The source (Mac) archid was SIGSTOPped at `changed complete`.
m3's Complete went through; the source Complete waited out its 150 s, then two reconnects each gave up after 10 s
(`archid did not accept a connection on ws://127.0.0.1:47871 within 10000ms`); the gateway's Complete went through. The
helper ended `complete` g41 with **pending ["source"]** and that error, and kept its journal. The Mac was then
SIGCONTed. Status: moved, action finish, safe [resume]; the Mac refused revive/attach (`not_owner`). `--resume` →
complete g41 in 0.8 s, controller journal cleared, status none. The source never ran a window after the commit
(invariant held; 0 Mac windows from 07:22:18.6 on).

### Linux → Mac (B)

**B1d begin, drop pinned at `changed begin`: FAIL (D1).** After the drop the helper sent the freeze to m3 on the
WS through the dead forward and heard nothing for 930 s (`archid did not answer handover.freeze within 930000ms`,
`FREEZE_TIMEOUT_MS` + 30 s). m3 never received it: it stayed unfrozen with 16/14 running, the gateway held tx cd70f121
`preparing`, and the Mac had nothing. While the helper lived, `handover status` said only `unknown, safe []: a
handover of this fleet runs here as pid …`. The helper then died of an unhandled `EPIPE` writing its `--json` stdout
(the harness reading it had exited; D5). Status then: open [resume, abort]; `--resume` (B1d-r) → complete g10 in 17 s.
Invariant held throughout.

**B1k begin, gateway SIGKILL pinned at `handover.preflight`: PASS.** `retry begin #1/#2: ECONNREFUSED`, complete g12.

**B2d freeze, outage 30 s from the first source freeze row: PASS.** `retry freeze` ×3 (connection closed, master
exited, `mux_client_request_session … Broken pipe`), `interrupted@freeze` [resume, abort]; m3 frozen+surrendered with
its source journal at freeze, 0 windows. `--abort` → `aborted@freeze`: m3 unfrozen and every stopped terminal
revived (16/14), g13.

**B2k freeze, source (m3) archid SIGKILL mid-rest.** As first run, `systemctl --user kill -s SIGKILL` killed the whole
unit (harness error above): archid, the fleet's tmux server and all 14 agents, a machine-crash-like fault. m3 restarted
as frozen-source with no tmux server. The helper stopped `interrupted@freeze` with the raw error `Command failed:
/usr/bin/tmux … list-panes -s -t fleet … no server running`, [resume, abort]. `--resume` twice failed the same way
at once; it can never succeed from there (D2). `--abort` (B2k-r) → `aborted@freeze`, unfrozen at g13, but every
character dormant: no windows, because the kill came before the rest journaled any stopped terminal, so abort had
nothing to revive. That matches the spec ("revives only terminals that handover stopped"); 14 `char.revive` and 2
`char.second` by hand brought 16/14 back (`logs/B2k-r.manual-revive.log`), compare 0 DIFF. **B2k2**, the planned
fault (`--kill-whom=main`): m3 restarted frozen with tmux and agents intact, the freeze retry reached it, complete g14
unattended: **PASS**. Invariant held in both (the Mac never ran anything).

**B3d transfer, drop mid-rsync (C1), 64,000-file bulk: PASS.** `rsync exited 12` on the pull,
`interrupted@transfer`; `--resume` → complete g8 in 70 s. b00-mac → B3d-mac-mac: 0 DIFF. The bulk was then deleted
on the Mac (authorised), and every later cell ran on the small fixture.

**B3k transfer, destination (Mac) archid SIGKILL during claim, restarted 2 s later: PASS.** `retry transfer #1/#2`,
claim on the restarted daemon, complete g16.

**B4d verify, outage 30 s pinned at `changed verify`: PASS.** Prepare is local (the Mac), so the outage hit Ready:
three retries, `interrupted@ready` [resume, abort]; gateway `preparing`, the Mac destination journal at prepare
(frozen, 0 windows), m3 frozen at freeze. `--resume` → complete g18.

**B5d prepare, drop at `changed prepare`: PASS, with D1's stall.** Prepare (local), Ready and Commit (the gateway
calls fall back to a direct ssh when the master's socket is gone), Activate (local) all passed; Complete's call to m3,
the source, went out on the dead WS and hung 150 s (`archid did not answer handover.complete within 150000ms`,
`COMPLETE_TIMEOUT_MS` + 30 s) before the retry reconnected and finished at g20.

**B5k prepare, destination (Mac) archid SIGKILL 0.3 s into prepare, restarted: PASS.** Prepare retried onto the
restarted daemon, complete g22.

**B6d ready, drop 0.1 s into Ready's ssh: PASS, with D1's stall.** Ready answered before the drop landed (the drop came
with `changed commit`/`activate`), so no answer was lost. Complete's source call hung on the dead WS as in B5d; the
Mac idle-slept 00:13–00:28 during that wait, and the run completed at g24 when it woke. The harness was killed with the
session; B6d's invariant was read afterwards from its samples (`bin/invariant.mjs`: commit 00:11:07.4, 0 destination
windows before, 0 source windows after) and its snapshot taken at 06:55 UTC (A6k-m3-linux → B6d-mac-mac clean).

**B4k verify, helper SIGKILL during a checksum dry run: PASS.** Killed with its `--dry-run` rsync running. Gateway
`preparing`, m3 frozen+surrendered with its source journal at freeze, the Mac nothing (the claim had not landed a
destination journal). Status open [resume, abort]; `--abort` → `aborted@transfer`: m3 unfrozen and revived 16/14,
g25. Orphan master (D4). Compare 0 DIFF.

**B7d commit, drop with Commit in flight: PASS, with D1's stall.** As first planned (poll for the ssh) the cell was not
run; B7d2 single-steps the helper (2 ms at a time) until its `gateway owner 'commit'` ssh exists, leaves it stopped,
kills the master 84 ms later and resumes it. The gateway committed g26 in the same 0.3 s sample window, and the helper
went on to activate 9 ms after it was resumed, so it had the commit's answer; the drop cost nothing there. Complete's
source call then went out on the dead WS and waited 150 s (D1) before the retry finished it. Invariant held (commit
07:00:33.6); compare clean.

**B6k ready, helper SIGKILL with Ready's answer lost: PASS** (run as B6k3, the shim holding the answer). The gateway
had recorded `ready-to-commit` with the prepared digest (the held answer shows it); the helper was killed with the shim
still holding. State: gateway `ready-to-commit`, the Mac destination journal at prepare (frozen, 0 windows), m3 frozen at
freeze, controller journal at ready. Status open [resume, abort]. `--resume` sent Ready again, which the gateway took
at the same digest, then committed and completed at g28. Orphan master (D4).

**B7k commit, gateway SIGKILL pinned at `changed commit`: PASS.** The Commit found the authority socket refusing; the
controller asked the gateway's record again (`retry commit #1/#2: … ECONNREFUSED`), which after systemd's restart read
`ready-to-commit`, so it sent the Commit again: committed g30, completed unattended. It never offered to give the source
its fleet back. Invariant held (commit 07:06:53.9).

**B6d3 ready, Ready's answer lost and the master killed (extra run of B6d): PASS, with D1's stall.** The gateway
recorded `ready-to-commit`; the master was killed and the shim exited 255 with no answer: `retry ready #1: archi
gateway owner ready exited 255 without an ownership frame`. The retry opened a new master, Ready was taken again at
the same digest, then Commit, Activate; Complete's source call waited 150 s on the dead WS (D1), then finished g32.

**B8d activate, outage 30 s from `changed activate`: PASS, with D1's stall.** Activate is local (the Mac) and finished
in 1.3 s; the outage killed the one master the helper held. Complete's source call to m3 then sat on the WS that had
died with that master, and waited its 150 s (D1) though the outage had ended after 30 s; the retry reconnected, and the
source and gateway Completes finished: complete g34, no pending.

**B8k activate, helper SIGKILL 0.3 s into activate: PASS** (run as B8k2: at 1 s the kill would have landed in
Complete, as A8d did). The Mac destination carried the activation through on its own: 16 windows and 14 agents, its
journal at activate; m3 frozen+surrendered at freeze, refusing revive/attach (`frozen`); gateway `committed` g36.
Status committed, safe [resume]; `--resume` re-asked Activate (answered at once for 14/14, nothing started twice) and
completed g36. Orphan master (D4).

**B8m activate (extra), destination (Mac) archid SIGKILL 0.3 s into activate, restarted: PASS.** The kill came while
the Mac was still confirming the commit (it restarted `at prepare on this machine`), before any window opened; the
retried Activate started all 14 (the result lists 14, all ok), complete g38. D6 needs the kill to land while windows
are opening, which A8k2 hit and this did not.

**B9k complete, source (m3) archid main SIGKILL at `changed complete`: PASS, with D1's stall.** The kill landed while
the Mac destination's own Complete ran; m3's WS closed with its daemon, between calls, so the source Complete went out
on the closed socket and waited 150 s (`did not answer handover.complete within 150000ms`, D1) before the retry
reached the restarted daemon and finished g40 with no pending. D1 is therefore not only a master drop: any close of an
idle WS, a remote daemon's restart included, stalls the next call.

**B9d complete, outage 30 s from `changed complete`: PASS, with D1's stall.** The Mac destination's Complete is local
and went through; the outage killed the helper's master, so m3's WS closed, and the source Complete went out on it and
waited 150 s (D1). By then the outage was long over; the retry reconnected, source and gateway Completes finished,
complete g42 with no pending. The outage never produced the `pending` it was aimed at: D1's wait outlasted it.

### Carried item C4: the gateway off

`$B/bin/c4.mjs`, logs `logs/C4-gateway-off.log`, `logs/C4-offline.log`, `logs/C4-remote-owner.log`.

**Gateway unit stopped, the Mac owning (g42): PASS.**
- The Mac daemon asks the gateway through its own `ssh … archi gateway owner get`. By hand that call answered
  `{"error":{"code":"disconnected",… connect ENOENT …/authority.sock}}` in 0.32 s.
- The restarted Mac archid was up in 0.57 s. It logged `the gateway did not say who owns this fleet (… ENOENT …);
  starting on the record this machine holds`.
- m3's archid, restarted with the gateway down, was up in 0.3 s (its own log: SIGTERM 07:29:17.474 → started 17.796),
  with the same line. The harness's own "32 s" figure for it read an empty log file and is wrong.
- `archi status` returned in 0.5 s.
- `archi handover status --json` returned in 8 s (four `gateway.get` attempts with back-off), saying `none`.
- `archi connect --json` (stdin held open) gave `connecting local`, then `online` 0.4 s later, off the cached route.
- The gateway was started again after 40 s. Connect stayed online, and status went back to 0.5 s.

**Gateway away, the Mac offline from linus-vault (simulated): PASS.**
- The simulation pointed the temp HOME's registry entry for m3 at `archi-m3@192.0.2.1` (TEST-NET-1, where nothing
  answers). The registry was restored afterwards and its md5 matches the original.
- ssh fails at ConnectTimeout: the daemon's gateway call took 10.1 s (`connect to host 192.0.2.1 port 22: Operation
  timed out`).
- The gated daemon's start waited exactly its bound: up 10.3 s after start, logging `the gateway did not say who owns
  this fleet (no answer within 10000 ms); starting on the record this machine holds`.
- `archi status` took 10.3 s.
- `archi handover status --json` took 58 s. It opened four masters against the 10 s timeout, then answered `none`.
- `archi connect --json` printed `connecting local`, then went `online` after 10.2 s, once the gateway ask had timed
  out and the cached route stood in.
- After the registry was restored, connect stayed online, and status took 0.5 s again.

**Gateway unit stopped, m3 owning (extra; g43, handed there and back with plain runs): PASS.**
- `archi status` said `archid on m3, which runs this fleet` in 1.4 s.
- `archi connect --json` went `connecting m3`, then `online` through a master and forward in 1.3 s, on the cached route
  to m3 (whose generation matched). It stayed online through the gateway's return.
- No connect run printed an error line, so there was nothing it had to retry past.

## Environment left

- **Ownership:** the Mac owns the fleet at generation 44, and no transaction is open anywhere. The Mac runs 16 windows
  and 14 agents; m3 has `_keep` only.
- **Processes:**
  - Mac archid: pid 81104.
  - m3: archid MainPID 154986 and gateway MainPID 196330, both active.
  - No master, helper or sampler of this part is running.
- **Fixture:** the bulk folder is gone from both machines.
- **Checks:**
  - The temp HOME registry is byte-identical to before C4.
  - linus-vault's stable state and the Mac's known_hosts match the end of A2.
  - `W/m3-env.md` has a Part B section with all of this.

## Defects

1. **Important (D1): a daemon WS that closes between calls (a master drop, or the far daemon restarting) is kept, and
   the next call to that daemon hangs for its whole deadline (freeze and claim 930 s, abort 30 s, complete 150 s) instead of
   reconnecting.**
   - Evidence: B1d (freeze, `archid did not answer handover.freeze within 930000ms`; m3 never froze), A2d (claim,
     stalled >150 s until cancelled; the helper held no connection toward m3), B5d, B6d, B6d3, B7d2, B8d (complete,
     150 s each), B9k (complete, 150 s, after m3's archid restarted between calls).
     Drops with a call in flight (A5d, A4d, B2d) fail at once and reconnect.
   - Cause: `reconnecting` drops its client only when a call through it fails (`packages/cli/src/controller/reach.ts:94-118`);
     a WS that closed between calls is kept. `Client.call` then sends on the closed socket
     (`packages/cli/src/client.ts:97-108`); ws's `send` after close only counts the bytes when no callback is given
     (`ws/lib/websocket.js` `sendAfterClose`), and the pending call has only its timer. `Client` already sees the close
     (`ws.on('close')` at `client.ts:54`) but nothing tells `reconnecting`.
   - Effect: no invariant broke; the handover is only slow, and a 15 min freeze or claim wait looks like a hang in the
     sheet. With a real link loss (the master exits on ServerAlive timeout) this happens whenever the loss lands between
     two calls.
2. **Minor (D2): after the Linux machine's archid, tmux server and agents all die mid-freeze, `handover status` offers
   resume, and resume can never succeed.** B2k: every resume fails at once with `Command failed: … tmux list-panes …
   no server running`, and the offered [resume, abort] does not say that only abort goes on. The restarted daemon
   (frozen-source) does not start a tmux server, and the source freeze's rest reads panes unconditionally
   (`packages/archid/src/handover/rest.ts:221`, `tmux list-panes`; startup mode at `handover/startup.ts:45-49`).
3. **Minor (D3): a foreground `archi handover --json` that has printed its result stays alive while a dead call's
   timer runs** (A2d: over 5 min, the 930 s claim timer). `exit` only sets `process.exitCode` for a non-helper run
   (`packages/cli/src/commands/handover.ts:588`), and the abandoned client's pending timer (`client.ts:100`) holds the
   loop. The control socket and lock were already let go (`handover status` answered `none` while it lived), so only
   the process and its connection linger.
4. **Minor (D4): a SIGKILLed helper leaves its `ssh -M` master running** (every helper kill: A1k, A3k, A5k, A5k2, A7k3,
   B4k, B6k3, B8k2, one orphan each with ppid 1, killed by the harness). `closeMastersOnSignal` covers TERM/INT/HUP only (`packages/cli/src/controller/ssh.ts:95-104`).
   The next helper's socket path has its own pid in the hash, so nothing collides; the orphan holds an authenticated
   connection to the gateway machine until something kills it.
5. **Minor (D5): a foreground `--json` helper dies of an unhandled `EPIPE` when its stdout reader goes away** (B1d:
   `Emitted 'error' event on Socket instance … EPIPE`, from `Observer.record` → the `--json` line writer,
   `commands/handover.ts:96`). The journals are intact and resume went on (B1d-r); the app's detached helper writes no
   stdout, so this is the CLI in a pipe only.
6. **Important (D6): a destination daemon that dies mid-activation leaves the characters it had opened but not yet
   started behind a shell prompt, drops their session from the state, and the finished handover does not mention
   them.**
   - Evidence: A8k2. After systemd restarted m3's archid the controller's retried Activate returned, the run ended
     `complete` g37, and its `characters` held 10 of 14, all ok. The other four (beta-main, beta-wt1, beta-wt2,
     beta-sub) had windows running bash with `claude --resume <id> …` typed at the prompt but never entered, 10 agents
     for 14 characters, and `agent`/`revive` gone from their state (the compare's 8 DIFFs). Nothing reported an error;
     the spec's "characters that fail to resume remain dormant with their transcript and a visible error" did not hold.
   - Cause: the retried activation starts only slots with no window (`wake`, `packages/archid/src/handover/destination.ts:470-477`,
     "one already live is left as it is"). A window the dead daemon had opened is therefore taken as live and gets no
     activation entry at all: `wakeSlot` (`:479`) never runs for it, so `characterResults` (`:93`) has no row. The
     cleared `agent` is most likely the restarted daemon's reconcile reading a pane with no agent process; that part was
     not traced in code.
   - Workaround seen: pressing Enter in each such pane runs the typed resume and re-links the session.

Notes, not defects:
- With the gateway unreachable and no journal anywhere it can read, `archi handover status` answers `none` and "no
  handover of this fleet is open anywhere" (C4, after 8 s and 58 s). It cannot know that. With only one controller per
  fleet, that is where the answer ends up, but the wording claims more than was checked.
- Every daemon's cached owner record keeps the last transaction's `committed` block after Complete (`ownership.get`
  on both machines shows tx 7a0ff7da `committed` at the start of B, after A2's last run). The gateway's record has no
  transaction and `handover status` says none open; the fence probes on the non-owner name that transaction
  (`handover_committed (this fleet moved to another machine; <tx> is committed)`).
- A5k: the source refused revive/attach with `frozen` rather than `handover_committed` while it had not yet heard of
  the commit; the invariant holds either way.
- The gateway calls survive a master drop because `master.run` falls back to a direct ssh when the control socket is
  gone (ssh's mux client does that for a session request); rsync cannot (it targets `archi-remote.invalid`), and neither
  can the daemons' WS (the forward dies with the master).
