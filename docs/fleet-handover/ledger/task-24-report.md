# Task 24 — Classify and rest every terminal safely

Commit: `33d733a Handover rests agents and refuses unapproved shell processes` on `fleet-handover-task24`
(parent 1168d22). There's no attribution in the commit. The system reminder asked for a Co-Authored-By
trailer, and I ignored it because the user's CLAUDE.md forbids attribution.

## What was built

**`packages/archid/src/handover/processes.ts`** (new): a portable process snapshot.

- `parsePs(stdout)` reads `ps -A -ww -o pid=,ppid=,pgid=,tpgid=,stat=,args=`. The columns are the same on
  macOS and procps. `args` goes last because it is the only column that can contain spaces. Any line
  that isn't a row, such as a header, a blank line or garbage, is skipped.
- `ProcessTable` (`new ProcessTable(rows)`, `static read()` spawns `ps` with an argv list and no shell)
  and `pane(panePid)`. The call is keyed by the tmux pane pid and returns
  `{ group, foreground, commands }`, or `undefined` once the pane process is gone:
  - `group` is the terminal's foreground process group, the `tpgid` of the pane process.
  - `foreground` lists the processes of that group that descend from the pane, or are the pane process
    itself. A shell that holds its own prompt is left out, and so are zombies. A pane that exec'd into
    something else (vim, ssh) counts as holding its terminal.
  - `commands` lists the children of the group leader that run in a process group of their own. That
    is how an agent's tool commands appear. I measured this on this machine: Claude Code runs each Bash
    tool command in a new session (`Ss`, tpgid 0, a child of `claude`), while its MCP servers and LSP
    sit in its foreground group.
- `killGroup(group, signal)` refuses any group ≤ 1, which would reach init, the daemon's own group or
  every process. It ignores `ESRCH` (the job is gone) and `EPERM` (for example a job under `sudo`).
  The terminal then shows as still busy after the settle windows, so the user gets a blocker instead
  of an exception.

**`packages/archid/src/handover/rest.ts`** (new): classification, choices and the rest loop.

- `classifyTerminals(state, live, table)` classifies both slots of every character that still has a
  window and a pane process. The result combines hook status with the actual foreground:
  - empty foreground → `shell-ready` (this includes an agent whose shell is back at its prompt);
  - no agent record but a foreground job → `foreground`;
  - otherwise the hook status decides: `agent-working`, `agent-blocked`, or `agent-ready` (idle/done).
- `restTerminals(deps, options)`:
  1. **Recheck first.** Every pass decides a step for every terminal before touching any of them:
     `rest | wait | interrupt | terminate | kill | blocker`. If any blocker exists, the pass returns
     `{ ok: false, blockers }` and nothing else happens in it. The first pass is the post-freeze
     recheck, so an unapproved `foreground` job or an unapproved `agent-blocked` agent aborts before
     any Escape, signal, detach or kill.
  2. **Working agents are waited on through events.** The loop wakes on a store change (hook events
     still land while the fleet is frozen), on the next poll of the process tree (`pollMs`), or on a
     cancel. An agent still working at `waitMs` is an `agent_working` blocker.
  3. **Escape only by explicit policy.** Once `interruptAfterMs` has passed since resting began, a
     working or blocked agent receives a single `\x1b`. Without the policy a blocked agent is an
     immediate `agent_blocked` blocker, because `char.answer` is fenced while frozen. Rest after an
     interrupt is confirmed in one of two ways. Either the hook reports idle or done, or, at least one
     poll after the Escape, the agent has no tool command left running. Claude Code sends no hook for
     an interrupted turn. If neither happens within `settleMs`, the result is an `agent_unsettled`
     blocker, unless that terminal may be terminated.
  4. **Termination only by explicit choice** (`terminate: true` or a per-terminal `TerminalRef[]`).
     The step appends `{ characterId, term?, processes: [args…] }` to `SourceJournal.terminated` and
     writes it durably before sending SIGTERM to the foreground group. SIGKILL follows after
     `settleMs`, and a blocker after another `settleMs`.
  5. **Laying to rest,** which runs only once one pass finds every terminal at rest: optional
     scrollback capture (`scrollbackLines`, returned in the result) → a write-ahead append to
     `stoppedTerminals` in the journal → `TerminalHub.detach` for each character → `killWindow` for
     each live terminal → one store update. That update makes **both slots of every character**
     dormant with `revive.command` (`claude --resume <id>` / `codex resume <id>` / `''`). The second
     slot's `cwd` is its last pane path. The agent record each terminal carried just before the
     handover stopped it is restored, so an exit hook caused by our SIGTERM or the window kill cannot
     erase the session.
- `unapproved(state, terminals, choices)` runs the same step logic, read-only, for preflight.
- `restChoices(HandoverChoices)` maps the current protocol choices. A named character covers both of
  its terminals.

**Other modified files**

- `tmux/tmux.ts`: `LiveWindow.panePid` (`#{pane_pid}`) and `Tmux.detachClients(session)`
  (`detach-client -s =<session>`, argv list, errors swallowed when the session doesn't exist).
- `terminals.ts`: `TerminalHub.detach(id)` detaches every desktop client on `v-<id>` and `v-<id>-2`.
  The session names now come from one `viewerSession` helper, which `attach` also uses.
- `fleet.ts`: `onSocketEvent` drops hook and status events for a slot that has no window while the
  fleet is frozen. Without this, a late `SessionEnd` from an agent the handover closed would delete
  the `agent` record, and with it the `transcriptPath` that the transfer manifest needs. Live slots
  still receive events while frozen, as Task 10 ruled.
- `handover/journal.ts`: `SourceJournal.terminated` with `.default([])`, following the
  `stoppedTerminals` pattern. This file isn't in the brief's list, but "record what was terminated
  in the journal" needs it. The change is additive.
- Tests: `reconcile.test.ts` (`live()` gains `panePid`) and `api.test.ts` (a typed journal literal
  gains `terminated: []`).

## Interfaces Task 25 will call

```ts
// packages/archid/src/handover/rest.ts
export type TerminalRef = { characterId: string; term?: 2 };
export type TerminalClass = 'agent-ready' | 'agent-working' | 'agent-blocked' | 'shell-ready' | 'foreground';
export type Classified = TerminalRef & { class: TerminalClass; window: LiveWindow; processes: PaneProcesses; agent?: Agent };
export type RestChoices = { interruptAfterMs?: number; terminate?: boolean | TerminalRef[] };
export type RestedTerminal = TerminalRef & { class: TerminalClass; interrupted?: true; terminated?: true; scrollback?: string };
export type SettleResult = { ok: true; terminals: RestedTerminal[] } | { ok: false; blockers: Blocker[] };
export type Clock = { now(): number; sleep(ms: number): Promise<void> };
export type RestDeps = {
  store: Pick<Store, 'state' | 'update' | 'subscribe'>;
  tmux: Pick<Tmux, 'listWindows' | 'sendBytes' | 'capture' | 'killWindow'>;
  viewers: Pick<TerminalHub, 'detach'>;
  journal: Pick<HandoverService, 'journalState' | 'write'>;   // must hold an open *source* journal
  processes?: () => Promise<ProcessTable>;                     // default ProcessTable.read
  kill?: (group: number, signal: NodeJS.Signals) => void;      // default killGroup
  clock?: Clock;                                               // default Date.now / setTimeout
};
export type RestOptions = {
  choices: RestChoices;
  waitMs?: number;         // default 3 min (inside FREEZE_TIMEOUT_MS = 5 min)
  settleMs?: number;       // default 10 s
  pollMs?: number;         // default 500 ms
  scrollbackLines?: number;
  cancel?: AbortSignal;    // stops the wait (rejects with the abort reason); no effect once windows start closing
};
export function restTerminals(deps: RestDeps, o: RestOptions): Promise<SettleResult>;
export function classifyTerminals(state: FleetState, live: LiveWindow[], table: ProcessTable): Classified[];
export function unapproved(state: FleetState, terminals: Classified[], choices: RestChoices): Blocker[];
export function restChoices(c: HandoverChoices): RestChoices;

// packages/archid/src/handover/processes.ts
export type Proc = { pid: number; ppid: number; pgid: number; tpgid: number; stat: string; args: string };
export type PaneProcesses = { group: number; foreground: Proc[]; commands: Proc[] };
export function parsePs(stdout: string): Proc[];
export class ProcessTable { constructor(rows: Proc[]); static read(): Promise<ProcessTable>; pane(panePid: number): PaneProcesses | undefined }
export function killGroup(group: number, signal: NodeJS.Signals): void;

// also: LiveWindow.panePid, Tmux.detachClients(session), TerminalHub.detach(id), SourceJournal.terminated
```

The intended sequence in Task 25:

```ts
// preflight (read-only)
const blockers = unapproved(store.state, classifyTerminals(store.state, await tmux.listWindows(), await ProcessTable.read()), {});
// freeze
await ownership.freeze(tx); await fleet.settle();
handover.write({ role: 'source', ..., phase: 'freeze' });            // restTerminals throws without it
const r = await restTerminals({ store, tmux, viewers: terminals, journal: handover }, { choices: restChoices(p.choices), cancel });
if (!r.ok) { /* nothing was closed: abort → unfreeze, answer handoverError({ code: 'blocked', blockers: r.blockers }) */ }
// abort after a successful rest: journal.stoppedTerminals names what to revive
//   (fleet.reviveCharacter(id) for the main terminal, fleet.openSecond(id) for term 2)
```

Every blocker has `entity: { kind: 'character', id }` and uses one of the existing protocol codes:
`shell_busy`, `agent_blocked`, `agent_working`, `agent_unsettled`. No protocol change is needed.

## Tests

`test/handover/processes.test.ts` (18):

- The same scenarios run against a macOS fixture and a Linux procps fixture: prompt, pipeline,
  background job, an agent with MCP servers plus a tool command plus an MCP-launched browser, an
  exec'd pane, an unreaped zombie job, and a pane that is gone.
- `parsePs` skips lines that aren't rows.
- `killGroup` refuses −1, 0 and 1, and tolerates ESRCH and EPERM. The EPERM case sends SIGCONT to a
  root-owned group and is skipped when the tests run as root.
- A real tmux pane is read through this machine's own `ps`.

The macOS fixture is modelled on rows captured here. The Linux fixture is modelled on real
procps-ng 4.0.4 output that I captured read-only from the Ubuntu remote (100.117.42.24). That capture
ran `ps`, plus a throwaway tmux server on its own `/tmp` socket that was killed and removed
afterwards. Paths in both fixtures are anonymised to `/Users/ada` and `/home/ada`.

`test/handover/rest.test.ts` (16) injects fake tmux, `ps`, kill and clock, and uses a real Store and
a real HandoverService/JournalFile on disk:

- idle agents and ready shells rest: viewers are detached before the first kill, `stoppedTerminals`
  is on disk before the first kill, both slots end dormant with resume commands, and the second slot
  takes its pane path;
- recheck: an unapproved foreground job aborts before an `interruptAfterMs: 0` Escape would have gone
  out, and the store and journal are unchanged;
- a blocked agent without an interrupt choice is a blocker;
- a working agent is rested on the hook event with no clock advance;
- a working agent is a blocker at `waitMs` and never receives Escape;
- the interrupt is sent only after the chosen delay, and rest is confirmed only once the tool command
  has ended;
- an interrupted agent that doesn't settle is a blocker and nothing is closed;
- an interrupted agent that doesn't settle but may be terminated gets SIGTERM, the journal is written
  before the signal, and a SessionEnd that arrives next doesn't take its session;
- per-terminal terminate, with SIGTERM then SIGKILL for a job that ignores SIGTERM;
- a shell that was at rest starts a job mid-wait → blocker;
- cancel;
- scrollback capture, and a second slot whose window is already gone becomes dormant without being
  recorded as stopped;
- `unapproved`, `restChoices`, and the frozen-fleet `onSocketEvent` guard;
- a real tmux end-to-end run: a real Fleet and TerminalHub, a desktop client attached through
  `on-pty.py`, a real `sleep 300` terminated through `killGroup`, both windows closed, and the client
  output reading `detached`.

### TDD evidence

RED for processes (module first, then the tmux field):

```
$ pnpm vitest run --project archid test/handover/processes.test.ts
 FAIL |archid|  test/handover/processes.test.ts
Error: Failed to load url ../../src/handover/processes.js ... Does the file exist?
 Test Files  1 failed (1)      Tests  no tests

# processes.ts written, tmux wrapper not yet changed:
 × ProcessTable on this machine > reads what holds a real tmux pane from this machine's ps
   → actual value must be number or bigint, received "undefined"      (listed.panePid)
 Tests  1 failed | 16 passed (17)
```

RED for rest (module first, then rest.ts written but not the fleet/terminals changes):

```
$ pnpm vitest run --project archid test/handover/rest.test.ts
Error: Failed to load url ../../src/handover/rest.js ... Does the file exist?

 × a frozen fleet > keeps the agent of a terminal the handover closed when a late SessionEnd arrives, and still hears a live one
   → expected undefined to be '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d'
 × resting real terminals > ends the chosen job in a real pane, detaches an attached client, and closes both windows
   → deps.viewers.detach is not a function
 Tests  2 failed | 13 passed (15)
```

That run first showed two more failures. Both were mistakes in my tests: they advanced the fake clock
before the loop's first pass had run. I fixed the tests by letting the loop settle before advancing.

GREEN:

```
$ pnpm vitest run --project archid test/handover/processes.test.ts test/handover/rest.test.ts
 Test Files  2 passed (2)
      Tests  34 passed (34)
```

Mutation checks. Each was reverted afterwards, and each was caught:

- `TerminalHub.detach` made a no-op → the real tmux test fails (`waitFor: timed out`, no `detached`).
- The blocker return moved after the actions → "refuses a foreground job … at the recheck" fails.
- The carried agent not restored → "terminates an interrupted agent … keeping the session" fails.
- EPERM no longer tolerated → the killGroup test fails with `Error: kill EPERM`.

Full verification:

```
$ pnpm vitest run --project archid
 Test Files  60 passed (60)
      Tests  810 passed | 1 skipped (811)          (the skip predates this task)
$ pnpm typecheck
 tsc --noEmit -p tsconfig.json && tsc --noEmit -p apps/desktop/web/tsconfig.json   (clean)
$ pnpm vitest run --project cli
 Test Files  22 passed (22)      Tests  270 passed | 2 skipped (272)
```

## Files changed

- new `packages/archid/src/handover/processes.ts`, `packages/archid/src/handover/rest.ts`
- `packages/archid/src/tmux/tmux.ts`, `packages/archid/src/terminals.ts`, `packages/archid/src/fleet.ts`,
  `packages/archid/src/handover/journal.ts`
- new `packages/archid/test/handover/processes.test.ts`, `packages/archid/test/handover/rest.test.ts`,
  `packages/archid/test/fixtures/ps/{darwin,linux}.txt`
- `packages/archid/test/reconcile.test.ts`, `packages/archid/test/api.test.ts` (one line each)

I didn't touch `packages/protocol` or any of Task 19's files.

## Self-review

- Nothing destructive happens in a pass that reports a blocker. Windows close only after a pass that
  finds every terminal at rest, so a failed rest leaves every window open. The only side effects left
  behind by a failure are Escapes and terminations, both explicitly chosen, and each termination is
  journaled before its signal.
- Every subprocess runs from an argv list (`ps`, `tmux detach-client`). Signals go through
  `process.kill(-group)` with a guard against group ≤ 1.
- Process, clock, tmux, kill and journal are all injectable, so every wait, timeout, escalation and
  cancel path in rest.test.ts runs deterministically on a fake clock.
- `fleet.ts` is large (776 lines). I added three lines to `onSocketEvent` and nothing else. The rest
  step writes the store directly through `markDormant` and `markSlotDormant`, rather than growing
  Fleet.

## Decisions and concerns

1. **Process confirmation after an interrupt** (revised in fix round 1). Rest counts as confirmed
   when no tool command is left running under the agent process, checked at least one poll after the
   Escape. The agent process is claude or codex, found through a node launcher. A tool command is a
   child of it that has left the terminal. The Claude Code layout is measured. For Codex, the MCP
   server layout was measured on this Mac by the reviewer, while its tool-command layout and the npm
   launcher layout are modelled (see Fix round 1). A Claude agent with a background command still
   running (`run_in_background`) never confirms. It becomes `agent_unsettled` unless its terminal may
   be terminated. That is the conservative direction.
2. **The terminate choice also covers an interrupted agent that won't settle** ("unless the user
   explicitly terminates that terminal"). As a result, the global `--terminate-shells` also terminates
   such an agent. Task 28 should word the flag's help text to say so.
3. **The main slot keeps the `cwd` the fleet recorded.** The tick and the hook-driven `followCwd` keep
   it current. Overwriting it with the pane path would undo a hook's move into another checkout, and
   Task 19's inventory may use that path as a root. The second slot takes its pane path, as every
   poll already does. A plain main shell that `cd`'d in the last poll (≤3 s) before freeze keeps the
   older directory.
4. **Choices are read once per call.** The sheet's mid-rest "Interrupt and carry" works by calling
   again: a blocker return closes nothing, so the caller can retry while still frozen. The other
   option is to make choices a getter. There's no per-terminal progress callback either. Task 25 needs
   one only if it wants mid-rest progress per character, and it would be a small addition.
5. **Terminating signals only the foreground group.** The tool commands an agent ran in their own
   sessions are outside the terminal and aren't signalled. Closing a character's window today behaves
   the same way.
6. **The protocol's `HandoverChoices.terminateShells` is per character, while `RestChoices` is per
   terminal.** If the sheet needs per-terminal choices on the wire, that needs a protocol change,
   which I left for Task 29.

## Fix round 1

### What changed

1. **Codex commands (the Important finding).** `ProcessTable.pane()` now returns
   `agent?: { kind, pid, commands }` in place of the old top-level `commands`. A tool command is a child
   of the agent process that has **left the terminal** (`tpgid !== group`). Claude's Bash tool shells
   run with tpgid 0 or −1, so they count. Codex's MCP servers (`node_repl`, `adlc mcp-server`) and
   `codex-code-mode-host` each run in a group of their own but stay on the terminal
   (tpgid = the group), so they no longer count. I corrected decision 1 in the report above
   accordingly.
2. **Seeing through a launcher.** The agent is found by program name. `program()` takes argv[0]
   without a login shell's dash, or, for `node`, the script's basename with any `.js`, `.mjs` or
   `.cjs` extension removed. The job's leader counts as the agent when it is `claude` or `codex`. The
   search then descends to a child of the same program in the same group, which is how npm's
   `node …/bin/codex` starts the native binary. Commands are read under the process found this way,
   so Codex's tool commands, which are grandchildren of the leader, are counted.
3. **A stale record can no longer speak for a job.** `classOf` returns an `agent-*` class only when
   `p.agent?.kind` matches the record's kind. Any other job holding the terminal is `foreground`, so
   it needs a terminate choice and never receives Escape or an unasked rest.
4. **Bounds.** Every `ps` and tmux call during resting (`list-panes`, `ps`, `send-keys`,
   `capture-pane`, `detach-client`, `kill-window`) runs under `callTimeoutMs`, which defaults to
   10 s. The timer runs on the injected clock, and a call that times out fails the rest with
   "<call> did not answer within <n> ms". Scrollback capture is caught for each pane: the terminal
   still rests, and the miss is recorded as `RestedTerminal.scrollbackError`.
5. **Reads happen only on the poll.** `ps` and `list-panes` run once every `pollMs`. A store event
   reclassifies from the new state against the last snapshot. If that judgement would lead anywhere
   (a blocker, all terminals at rest, or an action), the loop reads the process tree again and
   decides afresh, so every kill, signal, Escape and blocker is based on a fresh `ps`.

New or changed interface: `PaneProcesses = { group, foreground, agent?: AgentProcess }`,
`AgentProcess = { kind: AgentKind; pid; commands: Proc[] }`, `RestOptions.callTimeoutMs`,
`RestedTerminal.scrollbackError`. Everything else Task 25 calls is unchanged.

### Capture on linus-vault, and a false premise in the ruling

linus-vault has **no npm-installed Codex**. `codex` there resolves to
`~/.codex/packages/standalone/current/bin/codex`, a static-pie ELF 0.156.1 installed at 07:59 today.
There is no `@openai/codex` in `/usr/local/lib`, `/usr/lib`, `~/.local/lib/node_modules`, pnpm
global or bun. I captured what is actually there, using the ruling's procedure: a throwaway socket
`/tmp/archi-t24-codex.sock`, `codex` idle in `/home/linus` for 10 s, no prompt sent, then kill-server
and `rm`. I confirmed afterwards that the socket was gone. The idle standalone Codex has **no
children**, because no MCP servers are configured there. That capture went into `linux.txt` verbatim:
`-bash` → `codex` `Sl+`.

The fixtures now hold the following. Only the first is a real capture.

- Linux standalone Codex: the real capture above.
- macOS standalone Codex: modelled on the layout the reviewer measured on this Mac (pid 6711), with
  the MCP servers and code-mode-host in their own groups on the terminal.
- npm launcher on both platforms: **modelled, not captured.** The shape is `node …/bin/codex`
  (leader) → the native `…/vendor/<triple>/codex/codex` in the same group → its MCP server → its
  tool command.
- Codex tool commands (tpgid 0 or −1, off the terminal): **modelled.** I sent no prompt, so no Codex
  turn ever ran a tool.

If the Codex layout shown under a real turn differs, the fixture rows are the place to correct it.
Installing `@openai/codex` somewhere would let the npm layout be captured for real. That is your
call; I didn't install anything.

### Tests added

- processes (22 total): standalone Codex on each platform, where the MCP servers and
  code-mode-host don't count as commands; the npm launcher on each platform, where the agent pid is
  the native child and its commands are grandchildren of the leader; no agent for a pipeline or an
  exec'd vim. The Claude pane now checks `agent: { kind: 'claude', pid }`.
- rest (21 total):
  - An interrupted Codex settles. The standalone pane has servers and a tool, the npm pane has a
    server and a tool, and the two tool commands end one at a time, so each layout is load-bearing
    on its own.
  - A stale `claude idle` record over `npm run dev`, and a stale `codex working` record over
    `vim notes.md`, both come back as `shell_busy` with `interruptAfterMs: 0`, and no Escape is sent.
  - Five statusline store events cause zero `ps` reads, and the Stop event causes exactly one.
  - A hung `ps` rejects at exactly `callTimeoutMs`, and nothing is touched.
  - A hung `capture-pane` is recorded as `scrollbackError` while both terminals rest.
- The fake World gained `servers` (own group, on the terminal), launcher jobs (each job process is a
  child of the one before), a `reads` counter, and `hangPs`/`hangCapture` switches.

### TDD evidence

RED, with the tests written first:

```
$ pnpm vitest run --project archid test/handover/processes.test.ts
 × … finds a standalone Codex, leaving out the MCP servers …   → expected undefined to be 'codex'
 × … sees through npm's node launcher to the Codex it starts … → expected undefined to be 'codex'
 × … holds Claude with its MCP servers in the foreground …      → expected undefined to match object { kind: 'claude', … }
 Tests  8 failed | 14 passed (22)

$ pnpm vitest run --project archid test/handover/rest.test.ts
 × … reads a terminal whose agent record has gone stale …          → Test timed out (Escape sent, loop never ends)
 × … reclassifies from state on a hook event …                     → expected 6 to be 1   (ps read per store event)
 × … gives up on a ps that does not answer …                       → Test timed out
 × … records a scrollback it could not capture …                   → Test timed out
 × … confirms an interrupted Codex …                               → Cannot read properties of undefined (reading 'length')
 Tests  8 failed | 13 passed (21)
```

GREEN:

```
$ pnpm vitest run --project archid test/handover/rest.test.ts test/handover/processes.test.ts
 Tests  43 passed (43)
```

Mutation checks. Each was reverted afterwards, and each was caught:

- The review's exact filter (`c.pgid !== group`) → 4 fail, among them the Mac standalone Codex and
  the rest-level Codex test.
- The see-through loop removed → both npm fixture tests and the rest-level Codex test fail. That
  last one needed the per-pane tool ending described above.
- The kind check dropped from `classOf` → the stale-record test fails.

Full verification:

```
$ pnpm vitest run --project archid
 Test Files  60 passed (60)
      Tests  819 passed | 1 skipped (820)
$ pnpm typecheck
 (clean)
```

### Left as ruled

"Continue waiting" for a blocked agent and clamping `interruptAfterMs` against `waitMs` belong to
Task 25, as ruled. One effect of the bounds to keep in mind there: a `kill-window` that times out
fails the rest part-way through closing. Windows closed before it stay closed, and the store is not
marked dormant. `stoppedTerminals` was already written, and once the source unfreezes,
reconciliation marks the closed windows dormant. An abort then revives them as usual.

## Fix round 2

### What changed

1. **The agent search goes a level deeper only behind a node launcher** (processes.ts). It descends
   one level, and only when the leader's argv[0] is `node`, to a child of the same program in the
   same group. A `claude mcp serve` MCP server sits in Claude's own group and is no longer taken for
   the agent. As a result, Claude's own tool commands are still read under Claude.
2. **A slot goes dormant as soon as its window closes** (rest.ts, `layToRest`). Each terminal's
   `kill-window` is followed at once by its own store update: agent carried, `markDormant` or
   `markSlotDormant`, and the pane path taken for the second. If a later kill times out, every slot
   already closed is dormant and shielded by the freeze guard, so a late SessionEnd can't take its
   agent. Terminals whose window had already gone are made dormant in one final update.
3. **Archipelago's own hook and statusline processes are not tool commands.** A child whose argv
   carries setup's marker is left out of `commands`. That marker is `isOurs` (`agent-hook.mjs`, or the
   older `claude-hook.mjs`) or `STATUS_SCRIPT` (`claude-status.mjs`). `STATUS_SCRIPT` now lives in
   paths.ts next to `HOOK_SCRIPT`; setup's `STATUS_MARK` and `resolvePaths().statusScript` use it.
   A `run_in_background` job, which has the shape of any Bash tool command, still counts.
4. **Which blocker a failed termination gives now depends on the class** (rest.ts). A `foreground`
   terminal gets `shell_busy` ("is still running X after it was terminated"); an agent class gets
   `agent_unsettled`. A stale agent record over a shell job no longer turns that into an agent
   blocker.
5. **Timers are cleared and hung children are ended.**
   - `Clock.sleep(ms, signal?)`: the timer is cleared when the signal aborts, and the promise then
     never resolves.
   - `boundBy`: the work is now a `(signal) => Promise`. The timer is cleared in `finally`, and a
     timeout aborts the call's signal. `wake` clears its poll timer as soon as it resolves.
   - The signal reaches `execFile`: `ProcessTable.read(signal)`, `Tmux.listWindows`, `sendBytes`,
     `capture`, `killWindow` and `detachClients` each take an optional trailing `signal`, carried by a
     private `Tmux.call(args, signal)`. `run(...args)` is unchanged. `TerminalHub.detach(id, signal?)`
     passes its signal on.

Interface changes for Task 25:

- `RestDeps.processes?: (signal?) => Promise<ProcessTable>`.
- `Clock.sleep(ms, signal?)`.
- The Tmux and TerminalHub methods above take an optional trailing signal, which callers can ignore.

### A concern on item 3

The ruling's second example, the SessionStart script that has been alive for 17 hours under a
claude on this Mac, is **not Archipelago's**. It is the user's own hook
(`~/.claude/scripts/tab-title-session-start.sh`, from `~/.claude/settings.json`) and carries no
marker, so it still counts as a tool command. After an interrupt, a Claude with that child never
settles by the process tree. It ends as `agent_unsettled` unless its terminal may be terminated.
Only the statusline process in that example (`claude-status.mjs ccstatusline`) is now left out. I
see two ways to make Interrupt and carry work for such sessions:

- the user's hook detaches itself properly;
- a wider rule, such as ignoring processes Claude started before the interrupted turn.

I didn't build either, because both go beyond the ruling.

### Tests

- processes (23):
  - Both fixtures' Claude panes gained `claude mcp serve` (in Claude's group), an Archipelago
    statusline, and a hook process (sessions of their own). The Claude test now asserts that the agent
    is the leader, that `claude` appears twice in the foreground, and that `commands` holds only the
    tool.
  - `ProcessTable.read(AbortSignal.abort())` rejects.
  - In the real tmux test, `listWindows` and `capture` given an aborted signal both reject.
- rest (24):
  - A `kill-window` that times out on the second window leaves the first dormant with
    `claude --resume`. A late SessionEnd sent through a frozen Fleet keeps that agent, and the second
    window still has its tmux ids.
  - An interrupted Claude waits on its `npm run dev` background job, but not on its statusline and
    hook processes.
  - An unkillable `tail -f` under a stale `claude idle` record ends as `shell_busy` after SIGTERM
    and SIGKILL.
  - The hung-ps test asserts that the ps call's signal was aborted.
  - The Codex test asserts that no timer is left pending once resting is done.

### TDD evidence

RED (the tests were written first):

```
$ pnpm vitest run --project archid test/handover/processes.test.ts
 × … holds Claude with its MCP servers … → expected { kind: 'claude', pid: 41630 } to match object { kind: 'claude', pid: 41598 }   (and 3530040 on Linux)
 × ProcessTable.read > ends the ps it started when the signal it was given aborts → promise resolved instead of rejecting
 × ProcessTable on this machine > … → promise resolved "[ { windowId: '@1', … } ]" instead of rejecting
 Tests  4 failed | 19 passed (23)

$ pnpm vitest run --project archid test/handover/rest.test.ts
 × … confirms an interrupted Codex … → expected 7 to be +0                  (timers left pending)
 × … gives up on a ps that does not answer … → expected undefined to be true   (ps signal never aborted)
 × … leaves a terminal whose window it closed dormant … → expected { windowId: '@1', paneId: '%1' } to be undefined
 × … still waits on a background job … but not on its Archipelago statusline and hook → Test timed out
 × … reports a job that outlives its termination as a busy shell … → blockers differ (agent_unsettled)
 Tests  5 failed | 19 passed (24)
```

GREEN:

```
$ pnpm vitest run --project archid test/handover/processes.test.ts test/handover/rest.test.ts
 Tests  47 passed (47)
$ pnpm vitest run --project archid
 Test Files  60 passed (60)
      Tests  823 passed | 1 skipped (824)
$ pnpm typecheck
 (clean)
```

### Residual

A `kill-window` that times out is aborted, which ends its tmux client. If the tmux server had already
closed that one window, its slot keeps its tmux ids until reconciliation after an unfreeze, and a
late SessionEnd could still take that single terminal's agent record. Every terminal closed before
it is protected.

## Fix round 3

### What changed

1. **The marker match is anchored to what setup installs** (processes.ts, `ProcessTable.installed`).
   A direct child of the agent is left out of `commands` only in two cases:
   - it is a shell (`sh`, `bash`, `zsh`, `fish` or `dash`) run as `<shell> -c`, whose command starts
     with `HOOK_GUARD`, i.e. `[ -z "$ARCHI_CHAR_ID" ] ||`;
   - its argv[1] is exactly one of the `installedScripts(home)`: `<home>/hooks/agent-hook.mjs`,
     `claude-hook.mjs` (the older name) or `claude-status.mjs`.

   These are the two forms observed live. Claude runs its hooks through `sh -c` with the guard at the
   start. The statusline shell execs into `node <statusScript> …`. `HOOK_GUARD` now lives in paths.ts,
   and setup's `hookCommand` and codex's `codexHookCommand` build their commands from it, so the match
   and the installed text can't drift apart. The setup and codex install tests are unchanged and
   pass. `ProcessTable` takes the scripts in its constructor, and `ProcessTable.read({ signal,
   scripts })` passes them on. Rest's default reads with `installedScripts()`, i.e. the daemon's own
   `archiHome()`, as ruled.
2. **A node-run Claude stays the agent.** Looking one level deeper now also requires the inner
   process not to be node-run itself. `node …/bin/claude` keeps the agent role over its
   `node …/bin/claude mcp serve`, while Codex's npm layout, whose inner process is a native binary,
   is unchanged.
3. **Terminate and carry ends the agent's tool commands too.** When a terminal is terminated, three
   things happen in order:
   - the rest records the job's group plus the process group of each tool command (`t.groups`);
   - it journals the foreground and tool-command argv in `terminated`;
   - only then does it send SIGTERM to every one of those groups.

   After `settleMs`, SIGKILL goes to whichever of those groups are still alive, according to
   `ProcessTable.alive(group)`. The terminal counts as at rest only when nothing holds it (its window
   is gone, or its shell is back at the prompt) **and** none of the signalled groups has a live
   process left. Signalled groups that are still alive after SIGKILL plus `settleMs` produce a
   blocker. The blocker is `shell_busy` when a job still holds the terminal, and `agent_unsettled`
   otherwise. `blocker()` now takes a `TerminalRef`, so a terminal whose window has gone can still be
   reported.

Interface changes for Task 25:

- `ProcessTable.read({ signal?, scripts? })`, which replaces `read(signal)`.
- `new ProcessTable(rows, scripts?)`.
- `ProcessTable.alive(group)`.
- New exports in paths.ts: `installedScripts(home?)` and `HOOK_GUARD`.

### Concern: fleets other than the one setup last ran for

Claude's `~/.claude/settings.json` is global. On this Mac, its statusLine and hooks point at
`~/.archipelago/hooks/…`, even for characters of `~/.archipelago-work` and `~/.archipelago-mobile`.
A daemon for one of those homes compares against its own `installedScripts()`, so it doesn't
recognise `node ~/.archipelago/hooks/claude-status.mjs` and counts it as a tool command. This fails
closed. An interrupted Claude in those fleets, with a long-lived statusline process (one on this Mac
has been alive 17 h), never settles by the process tree and ends as `agent_unsettled` unless its
terminal may be terminated. The guarded hook command is recognised in every home.

There are two ways to fix this if Interrupt and carry should work in every fleet:

- recognise the scripts that Claude's settings actually name, by reading the statusLine and hook
  commands from `~/.claude/settings.json`;
- recognise every Archipelago home known on the machine.

I built neither, because the ruling named `resolvePaths()`.

### Tests

- processes (30):
  - Both fixtures' Claude panes gained the two probes from the review:
    `eval 'node --watch packages/archid/hooks/agent-hook.mjs --port 0'` and
    `eval 'node ~/tools/claude-status.mjs --serve'`. Claude's `commands` are now the tool plus both
    probes, while the installed statusline and the guarded hook are left out.
  - A node-run Claude pane with a node-run `claude mcp serve` and a `cargo build` tool.
  - A table built for another home counts the statusline, whose script lies outside that home, but
    still leaves out the guarded hook.
  - The fixture tables are built with `installedScripts('/Users/ada/.archipelago')` and
    `installedScripts('/home/ada/.archipelago')` respectively.
- rest (25):
  - A new test terminates an interrupted Claude whose `npm run dev` ignores SIGTERM. The journal holds
    `['claude', '/bin/zsh -c npm run dev']` before the first signal. SIGTERM goes to 1001 and 1050,
    then, a settle window later, SIGKILL goes to 1050 only, and the terminal rests after that.
  - The earlier terminate test now expects the tool group to be signalled and journaled too.
  - The fake World lets tool commands outlive their job's group unless they are signalled, as they do
    for real. Its table carries the installed scripts of `/Users/ada/.archipelago`.

### TDD evidence

RED, with the tests written first (`installedScripts` and `HOOK_GUARD` added beforehand, so the
failures show the matching itself):

```
$ pnpm vitest run --project archid test/handover/processes.test.ts
 × … holds Claude … counts only its own work off the terminal … → expected [ Array(1) ] to have a length of 3 but got 1   (both probes dropped)
 × … takes a Claude that node runs as the agent …                → expected 63011 to be 63010   (3580011 on Linux)
 × … leaves Archipelago's scripts out only where setup installed them → expected … to have a length of 4 but got 1
 Tests  6 failed | 54 passed (60)

$ pnpm vitest run --project archid test/handover/rest.test.ts
 × … terminates an interrupted agent that will not settle …   → expected [ 'keys %1 1b', 'SIGTERM 1001' ] to deeply equal [ …, 'SIGTERM 1050' ]
 × … ends the tool commands of a terminal it terminates too … → expected [ 'keys %1 1b', 'SIGTERM 1001' ] to deeply equal [ …, 'SIGTERM 1050' ]
 Tests  2 failed | 23 passed (25)
```

GREEN:

```
$ pnpm vitest run --project archid test/handover/processes.test.ts test/handover/rest.test.ts
 Tests  52 passed (52)
$ pnpm vitest run --project archid
 Test Files  60 passed (60)
      Tests  828 passed | 1 skipped (829)
$ pnpm typecheck
 (clean)
```
