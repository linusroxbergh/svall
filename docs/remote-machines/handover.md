# Moving a fleet

A handover moves a whole fleet between this Mac and its gateway machine: every island and character, the folders and
Git repositories they work in, and each agent's conversation. It moves no running process: agents resume from their
transcripts and shells reopen in their folders. One machine runs the fleet at a time, and a handover that fails part
way leaves it either still on the machine it came from, or on the machine it went to with any character that could
not resume waiting to be retried. It never leaves both running.

Before the first one, [set the machine up](setup.md), make it the fleet's gateway, and run `svall host doctor <name>`
(**Check** in the app): no check should fail (✗). A warning (!) about `tmux`, `gh` or `path` does not stop a handover;
an agent your fleet runs that is missing or not logged in there does.

## From the app

Choose **Handover** at the foot of the sidebar, then the machine to move the fleet to: the gateway's name, or **This
Mac** to bring it back. The sheet follows five steps:

1. **Checks.** Nothing is touched yet. The sheet lists what would be carried, anything that blocks, and warnings.
2. **Resting characters.** The fleet freezes: nothing may change it until the handover commits or aborts. Each
   terminal is brought to rest, and its window closed.
3. **Transferring files and sessions.** Each folder and agent session is copied, with progress.
4. **Verifying and committing.** The copy is checked, the other machine prepares the fleet, and the gateway commits
   it to that machine. From here there is no way back.
5. **Resuming characters.** The fleet runs on the other machine, and each character resumes there.

When something needs your answer, the sheet waits for one. You can close it meanwhile, such as to answer an agent in
its terminal, and open it again from **Handover**, which is marked while a decision waits:

| Choice | Offered for | What it does |
| --- | --- | --- |
| Continue waiting | an agent still working | Waits for it to finish its turn. |
| Interrupt and carry | an agent working or waiting on an answer | Sends Escape to each such agent, waits for it to settle, and carries it. It resumes from its transcript on the other machine. |
| Terminate and carry | a shell running a command, an agent that will not settle, or an idle agent whose background command still runs | Ends what runs in the terminals of each character named. The shell reopens in its folder on the other machine. |
| Archive and carry | a folder on the other machine that is in the way or changed there | Moves that folder to a timestamped sibling first, then copies afresh. Nothing is deleted, and the folder's row says where the old copy is kept. |
| Abort | anything before the commit | Nothing moves; the fleet stays where it was. |

A character marked **keep on this machine** on its card blocks the handover until you turn that off.

Quitting the app or closing the sheet does not stop a handover: it runs in a helper process of its own, and quitting
leaves this Mac's daemon and terminals running for it. When the app opens again, the sheet picks up where the
handover stands, with **Resume** and **Abort** before the commit, or only **Retry** after it.

Once the fleet has moved, the app reconnects to it where it runs, keeping the character you had selected, its open
card and your pane layout, which belong to this Mac. The machine's name shows at the foot of the sidebar.

## From a terminal

```sh
svall handover studio                         # move this fleet to studio
svall handover local                          # bring it back to this Mac
svall handover status                         # where a handover stands, and what is safe; changes nothing
svall handover --resume                       # go on with an open handover
svall handover --abort                        # take the fleet back, before the commit only
svall handover attach                         # follow the handover running in the background
svall handover --forget                       # drop this Mac's journal of a handover the gateway has moved past
```

- `-p <fleet>` moves another fleet, and `--json` prints one event per line ([the events](errors.md#events)).
- In a terminal, a decision shows as a short menu. It starts from the choices the run already holds, on a `--resume`
  too. While characters rest, type `i` and Enter to interrupt and carry the agents still working, or `c` to cancel.
- Ctrl-C before the commit aborts the handover, and the fleet stays where it was. After the commit the move goes on;
  a second Ctrl-C stops watching, and `svall handover --resume` finishes it.
- `--detach` leaves the handover to a background helper and prints its pid; `svall handover attach` follows it, and
  its log is `controller/handover.log` in the fleet home. In a terminal, attach's menu starts from the choices the
  run already holds.
- Without a terminal, `svall handover attach` passes each line of its stdin to the helper, as the app does, and stops
  following when stdin ends: `svall handover attach --json </dev/null` returns at once while the helper runs on. A
  script keeps stdin open for as long as it follows.
- Only one handover of a fleet runs on a Mac at a time; a second start names the one running.

A run in the foreground with no terminal to ask in (`--json`, or stdin not a terminal) stops at the first blocker and
gives the fleet back. A `--detach` helper waits at a blocker found after Checks until someone answers it through
`svall handover attach` or the app. One found while characters rest lets the fleet run again where it is, with the
terminals the handover stopped reopened, while the handover stays open at the gateway; an answer freezes it again.
One found later waits with the fleet frozen. These flags answer ahead:

| Flag | What it answers |
| --- | --- |
| `--interrupt-after <duration>` | Interrupt and carry the agents still working after this long: a number with `ms`, `s`, `m` or `h`, such as `1500ms`, `30s` or `2m`; `0` interrupts at once. A time past three minutes makes the rest wait that long. |
| `--terminate-shells` | Terminate and carry every terminal kept busy by a command, or by an agent that will not settle. |
| `--archive <root>` | Archive and carry this destination folder, by the root id a blocker names or its path. Repeat it for more. |

`svall handover` exits 0 when it did what it was asked and 1 otherwise. [Every code it can report](errors.md) is
listed with what to do about it.

## What moves and what stays

| Moves | Stays on each machine |
| --- | --- |
| Islands, characters, their places on the map, notes, instructions, links, context, agent profile and dormancy | `node.json`: the daemon's port and host, the shell, the phone's https port |
| `fleet.json`, and the fleet's entity docs and `agent-profiles` folder | The fleet's token, the phone key, push keys and subscriptions, and `owner.json` |
| Browser tab URLs | Browser cookies and logins, and each Mac's own layout |
| Every folder a character works in, a file or folder named in its context, and mission control's folder (`home.cwd`), which no other fleet on the same machine may use | Folders left out by the excludes below |
| Each repository a character works in: its Git directory, the main checkout, every worktree a character uses, and their staged, unstaged, untracked and ignored changes, stash, branches and refs | The registration of a worktree no character uses (its branch and stash still move) |
| Each agent's session: Claude Code's transcript with the session's own folder (subagents and saved tool output), Codex's rollout file, OpenCode's session export with Svall's log of it | Agent logins, user-wide settings, skills, MCP servers and hooks; Claude's file history, which `/rewind` uses, and session environment; OpenCode's own folders (`~/.local/share/opencode`, `~/.config/opencode`, `~/.local/state/opencode`, `~/.cache/opencode`), its undo snapshots, subagent sessions, and shell and tool-output files |
| `.env` files inside the folders that move | The fleet's own `.env`, unless `handover.transferFleetEnv` is on in `fleet.json` |
| | Every running process, its pid, its tmux window and its scrollback |

Folders named `node_modules/`, `.venv/`, `__pycache__/`, `dist/`, `build/`, `target/` and `.next/`, and
`*.tsbuildinfo` files, are left out by default, and each machine keeps its own. `handover.exclude` in `fleet.json`
adds patterns; `"excludeDefaults": false` replaces the defaults with yours.

Paths are never rewritten: both machines have the same home path, so every path in the fleet means the same thing on
either. A repository's `origin` that names a path on the Mac travels as it is, and the checks warn about it.

A folder the fleet left on a machine stays there as a replica of what was last carried. Moving back copies only what
changed. If something on that replica changed while the machine did not own the fleet, the handover stops rather than
overwrite it: copy the changes back by hand, or archive the replica.

A repository can say where it runs with `.svall/handover.json`, such as `{ "platforms": ["darwin"] }`, which
blocks a move to Linux while a character works in it. An Xcode project in a folder moving to Linux is only a warning.

## Agents

A handover carries Claude Code sessions from release 2.1.251 on, Codex sessions from 0.155.0 on and OpenCode sessions
from 2.0.22 on, with no upper limit: a Claude or Codex session's files are copied byte for byte to the same place on
the other machine, so a newer release works as long as it keeps its sessions where it did. An OpenCode session travels
as its `opencode session export`, which the other machine's OpenCode imports in the terminal's folder before the
character resumes. Each machine checks its own CLI before anything moves: installed, recent enough, logged in and
with Svall's hooks, as the daemon finds it. A login never moves; log in on each machine.

When a new Claude Code or Codex release comes out:

1. Record a session made by it as a fixture beside the others in
   `packages/svalld/test/fixtures/handover/claude/<version>` or `codex/<version>`, sanitized as the README there
   describes. `packages/svalld/test/handover/sessions.test.ts` checks the session adapter against every fixture.
2. Run the live probe against a machine with the same home path and both agents logged in. It carries a session from
   this Mac there and back, and one started there to this Mac, checks each resumes with its memory, and removes what it
   made. It spends a few tiny turns on each account:

   ```sh
   SVALL_LIVE_REMOTE=ada@studio pnpm test packages/svalld/test/handover/sessions-live.test.ts
   ```

   `SVALL_LIVE_AGENTS=claude` limits it to one agent, and `SVALL_LIVE_REMOTE_CLAUDE` or `SVALL_LIVE_REMOTE_CODEX` names
   another CLI on the remote machine, such as an older release still installed there.
3. If both pass, nothing changes. A release that keeps its session files somewhere new, or resumes differently,
   needs the session adapter updated: until then the checks stop with `incompatible_adapter` or `transcript_missing`,
   or the character stays dormant on the other machine with its transcript and the error. The adapter's minimum rises
   only when an older release stops working.

Until its probe passes, a new release is untested with handover, not refused. [The security notes](../security/fleet-handover.md#agent-versions)
say what a new release can break.

An agent asks for your word the first time it resumes in a folder on a machine: the checks warn about each such
character, and after the move its row says that it waits.

- **Claude** asks whether to trust the folder, with "No, exit" preselected: choose "Yes, I trust this folder".
- **Claude in Bypass Permissions mode** asks once per machine: choose "Yes, I accept".
- **Codex** asks whether to trust the folder: answer it in that terminal.
- **OpenCode** asks nothing.

Svall never writes an agent's own settings to answer these for you.

## What restarts

Nothing that runs moves; the handover brings each terminal to rest first.

- An idle or finished agent, and a shell at its prompt, are ready at once.
- An idle agent that left a command running in the background blocks until the command ends or you terminate it.
  An idle OpenCode's MCP and language servers do not count: they stop with it.
- An agent still in its turn is waited for, up to three minutes (or as long as `--interrupt-after` says, if longer),
  then shows as a blocker you can keep waiting on or interrupt. Interrupting sends Escape and waits up to ten seconds
  for the agent and whatever it started to stop.
- An agent waiting on an answer blocks until you answer it or interrupt it.
- A shell running a command in the foreground blocks until the command ends or you terminate it.

On the other machine:

- Each agent terminal the handover rested resumes as a new process in its folder, with `claude --resume <id>`,
  `codex resume <id>` or `opencode --standalone -s <id>` and the launch flags it had, such as its model or permission
  mode. Codex's `-p`/`--profile` and `--local-provider` are dropped, because they name configuration on the machine
  it came from. It has its whole conversation; an interrupted turn does not go on by itself, so tell it to continue.
- A plain shell opens in its folder and prints: *Svall restarted this shell after a handover; whatever ran here
  before did not move.*
- A character that was dormant before the handover stays dormant.
- A terminal that does not come up stays dormant with its session, and its card and row say why. Retry it from the
  row, or open it like any dormant character.
- Servers, builds and watchers do not restart: start them again. Ports are not forwarded to the Mac in this version.

## Working on the other machine

While the fleet runs on the Linux machine, the Mac app reaches it over ssh. Everything works as it does locally:
terminals attach through the same ssh connection, and the map, the files and the changes come through a forwarded
port. When the Mac sleeps, the fleet goes on.

- `svall` commands go to whichever machine owns the fleet; `--host <name|local>` picks one.
- The copy on the machine that does not own the fleet is read-only: reading works, and a change is refused with
  `handover_committed` once a handover has moved the fleet away from it (`not_owner` on a machine no handover left).
- Revealing a file in Finder, or opening Settings → Fleet config, asks you to open it on the machine that holds it.
- File → Open Fleet… lists and makes this Mac's fleets only from a window whose fleet is on this Mac; in this fleet's
  window it says where the fleet runs instead. `svall <name>` opens another fleet from a terminal either way.
- A terminal attaches only while the app's own ssh connection to that machine answers, and waits while it is down.
- If the ssh link drops, the terminals and agents keep running on the other machine. The banner says it is not
  reachable, and the app reconnects and re-attaches every terminal once the link is back.
- The phone reaches a fleet through the owning machine's own `svall mobile` setup, so a Home Screen app added from one
  machine works only while that machine owns the fleet.

## When a handover stops part way

A handover writes a journal on this Mac, on both machines and at the gateway, and `svall handover status` reads all
four to say what is safe:

| Status says | Do |
| --- | --- |
| Resume or Abort | Before the commit. `svall handover --resume` carries on, copying only what is not there yet; `svall handover --abort` gives the fleet back to the machine it came from and reopens only the terminals the handover stopped. |
| Resume only | After the commit. `svall handover --resume` activates the fleet on the machine it went to. The machine it came from never takes it back by itself. |
| Nothing is safe | The gateway cannot say whether the commit landed. Wait until it is reachable and ask again. |
| Forget | The gateway has moved on past this handover. `svall handover --forget` drops this Mac's journal of it. |

What else to know:

- **Killing the app** stops nothing, since the helper runs on. **Killing the helper** (or a foreground `svall
  handover`) leaves the handover where it stopped. The journals say where that is, the sheet rebuilds from them when
  the app opens, and `status` says what to do.
- **A dropped link** takes the controller from about 45 seconds to two and a half minutes to give up, depending on
  the step: each call waits up to 30 seconds and is asked up to four times, and the ssh connection is closed after 45
  seconds without an answer. The sheet shows the retries meanwhile, then stops with Resume and Abort, or Retry after
  the commit. The last step of a move to this Mac takes longest, as it asks both the other machine and the gateway;
  it then ends complete, and `svall handover --resume` finishes what they missed.
- **An unreachable gateway** never stops the machine that owns the fleet: it goes on working. No handover can begin or
  commit until the gateway answers, and a machine frozen for a handover stays read-only until one of them does.
- **Changes on the other machine** are never overwritten: a changed replica stops the handover until you copy the
  changes back or archive it.
- **After the commit** a character that did not resume is retried on the machine the fleet went to, never by moving
  the fleet back.

## When the gateway is lost

If the gateway machine is gone for good, or its record of the fleet cannot be read, ordinary handovers cannot go on.
`svall fleet recover` writes a new ownership record, and is never part of an ordinary retry:

```sh
svall fleet recover --force-owner local                       # this Mac is to own the fleet
svall fleet recover --force-owner local --gateway spare       # and another registry machine replaces the lost gateway
```

1. It shows what the gateway and every machine hold, this Mac's journal and cached route, every generation it saw,
   the record it would write (at a generation above all of them) and the risks.
2. It writes only after you type the fleet id; without a terminal, `--confirm <fleet id>` does that.
3. It records the write in the gateway's `recoveries.ndjson` and in `controller/recoveries.ndjson` in the fleet home,
   then tells every machine that answers: the one it names runs the fleet, and the others let go and close their
   terminals.
4. A machine it could not reach is listed under **next**. This Mac, and the gateway's own machine unless `--gateway`
   replaced it, take the record when their daemon next starts; any other has to be stopped, then the command run
   again once it answers.

Work done since the last handover on a machine that loses the fleet stays on that machine's disk; none of it is
carried. `--gateway` needs a machine from the registry that holds no record of the fleet, and is refused while the
current gateway still answers.

### A gateway set up again

A gateway machine that was reinstalled, or whose account was made again, has lost its record of the fleet and comes
back with a new machine id: commands that reach it find no Svall there, or another machine than the registry
names. Set it up again from this Mac, under the same name:

```sh
svall host add studio --ssh ada@studio        # installs the companion; the registry takes the new machine id
svall host enable studio --fleet private      # a new record naming this Mac the owner, and the machine's copy
```

The new record starts at generation 0. If the fleet has moved before, this Mac holds a later generation, which a
daemon never gives up for a lower one, so a handover stops at Checks with `generation_mismatch`. `svall fleet recover
--force-owner local` then writes a record above both, and this Mac takes it.

An account under another user name is another ssh destination: run `svall host remove studio` first, with `--forget`
if the old account can no longer be reached, then add the machine at the new one.

If the fleet was running on that machine, run the same three commands. Until the recovery, this Mac holds the fleet
read-only as it was when it last left; what was done on the other machine since then is gone.

If the fleet was running there and the account comes back under another user name, `svall host remove studio`
refuses, `--forget` included, because this Mac still has the fleet on that machine, and `svall host enable` for a
new name refuses while `fleet.json` names `studio`. Add the machine under a new name, recover with it as the
gateway, give it its copy of the fleet, and only then forget the old one:

```sh
svall host add studio2 --ssh ada2@studio
svall fleet recover --force-owner local --gateway studio2
svall host enable studio2 --fleet private
svall host remove studio --forget
```

## Known limitations

- **OpenCode leaves its undo snapshots and subagent sessions behind.** On the other machine, undoing a step from
  before the handover does not work, and a subagent's own session is not there; its result is in the conversation.
- **A background job an agent started can go unseen** once the command that started it has exited, for Claude, Codex
  and OpenCode alike. It keeps running on the machine the fleet left.
- **OpenCode's shared service can finish a turn Terminate and carry cut off, on the machine the fleet left.** That
  machine's copy of the session still holds the unfinished turn, and OpenCode's shared background service resumes it
  there; any `opencode` command run outside Svall without `--standalone` starts that service. Until the fleet comes
  back, run OpenCode there only with `--standalone`, or first remove the copy with `opencode session delete
  --standalone <id>`, taking the id from the handover's messages or from `opencode session list --standalone` in the
  character's folder.

- **Two controllers can drive one handover.** Starting a handover of the same fleet from two Macs at once can have
  both drive the same handover, since the gateway accepts the second start as the first. The gateway still commits
  it once. On one Mac, the second start is refused.
- **A late Begin can leave an open handover behind.** When the gateway receives a start only after its handover was
  aborted, it holds a handover nobody drives. `svall handover status` shows it open, and `svall handover --abort`
  closes it.
- **Saved tool output can name the other machine's folder.** A Claude transcript names each full tool output it
  saved by path. They move to the same path when both machines keep Claude's files in the same folder (`~/.claude`,
  unless `CLAUDE_CONFIG_DIR` says otherwise). Where they differ, the agent sees only each output's preview; running
  the tool again gets it whole.
- **`/rewind` does not reach back across a handover**, because Claude's file history stays on its machine.
- **A dropped link takes up to about two and a half minutes** to end the run.
- **A handover carries at most as many files as the smaller daemon's heap holds** (`too_many_files`): half the heap
  at 8 KiB a file, such as 68,832 files when one machine has 2 GB of memory. Leave generated folders out with
  `handover.exclude`.
- **A Git clean filter set up on one machine only is found after the copy.** A repository that uses Git LFS,
  git-crypt, nbstripout or another clean filter, usually set up in `~/.gitconfig`, reads as changed where git lacks
  that filter, so the handover stops with `git_mismatch` when the other machine prepares the fleet, after every file
  is copied. Nothing checks this sooner: set the same filter up on the other machine first, such as with `git lfs
  install`.
- **A move to this Mac can run nowhere for a while.** If the link drops right after the commit of a move to this Mac,
  the Mac waits to confirm the commit with the gateway, which it cannot reach, so the fleet runs on neither machine.
  Once the link is back, Retry (`svall handover --resume`) starts it here.
- **Agents ask to trust each moved folder** the first time they resume in it on a machine (see [Agents](#agents)).
  The character waits at that prompt until you answer it.
- **A resume rebuilt without this Mac's journal forgets your choices.** If the controller's journal is lost,
  `--resume` rebuilds it from the other three without your interrupt, terminate or archive choices, and may stop at
  the same blockers again; choose again.
- **More than ten terminals on a remote fleet** exceed sshd's default of ten sessions per connection. Each one past
  the tenth opens its own ssh login and shows one "Session open refused by peer" line. Like the app's own
  connection, that login asks nothing, and logs in with the keys ssh already holds.
- **A Codex terminal a handover reopened with its session, or one you open again after a handover could not resume
  it, and quit before its first prompt** goes dormant again, its window closed, saying Codex exited before that
  session started: Codex reports a session only once it takes a turn. The session is kept; open the terminal again.
- **A controller killed outright** (such as `kill -9`) leaves its ssh connection open until the link drops.
- **The phone** shows a character that failed to resume as asleep, without the reason the Mac shows.
- **Version 1 covers one Mac and one Linux gateway per fleet**, with the same home path on both. It does not move a
  single character or island, forward ports, keep a phone URL across machines, or move from one Linux machine to
  another.
