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
Mac** to bring it back. The sheet follows six steps:

1. **Checks.** Nothing is touched yet. The sheet lists what would be carried, anything that blocks, and warnings.
2. **Resting characters.** The fleet freezes: nothing may change it until the handover commits or aborts. Each
   terminal is brought to rest, and its window closed. The Load tab still reads; its Sleep and Delete are refused.
3. **Transferring files and sessions.** Each folder and agent session is copied, with progress.
4. **Verifying.** The copy is checked, and the other machine prepares the fleet. Abort still gives it back.
5. **Committing.** The gateway commits the fleet to that machine. From here there is no way back, and the sheet says
   so.
6. **Resuming characters.** The fleet runs on the other machine, and each character resumes there.

When something needs your answer, the sheet waits for one. You can close it meanwhile, such as to answer an agent in
its terminal, and open it again from **Handover**, which is marked while a decision waits:

| Choice | Offered for | What it does |
| --- | --- | --- |
| Continue waiting | an agent still working | Waits for it to finish its turn. |
| Interrupt and carry | an agent working or waiting on an answer | Sends Escape to each such agent, waits for it to settle, and carries it. It resumes from its transcript on the other machine. |
| Terminate and carry | a shell running a command, a job suspended with ctrl+z, an agent that will not settle, or an idle agent whose background command still runs | Ends what runs in the terminals of each character named. The shell reopens in its folder on the other machine. |
| Archive and carry | a folder on the other machine that is in the way or changed there | Moves that folder to a timestamped sibling first, then copies afresh. Nothing is deleted, and the folder's row says where the old copy is kept. |
| Carry the folder whole | a terminal in a folder that holds Git repositories no character works in, such as a shell in `~/Developer` | Carries that folder with those repositories. |
| Abort | anything before the commit | Nothing moves; the fleet stays where it was. |

A character marked **keep on this machine** on its card blocks the handover until you turn that off.

Quitting the app or closing the sheet does not stop a handover: it runs in a helper process of its own, and quitting
leaves this Mac's daemon and terminals running for it. When the app opens again, the sheet picks up where the
handover stands, with **Resume** and **Abort** before the commit. After it, resuming is all that is safe, so the sheet
resumes by itself and offers **Retry** only if that stops again.

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
| `--terminate-shells` | Terminate and carry every terminal kept busy by a command, a suspended job, or an agent that will not settle. |
| `--archive <root>` | Archive and carry this destination folder, by the root id a blocker names or its path. Repeat it for more. |
| `--carry-unused` | Carry the folder whole: each folder a terminal is in moves with the Git repositories there that no character works in. |

`svall handover` exits 0 when it did what it was asked and 1 otherwise. [Every code it can report](errors.md) is
listed with what to do about it.

## What moves and what stays

| Moves | Stays on each machine |
| --- | --- |
| Islands, characters, their places on the map, notes, instructions, links, context, agent profile and dormancy | `node.json`: the daemon's port and host, the shell, the phone's https port |
| `fleet.json`, and the fleet's entity docs and `agent-profiles` folder | The fleet's token, the phone key, push keys and subscriptions, and `owner.json` |
| Browser tab URLs | Browser cookies and logins, and each Mac's own layout |
| Every folder a character works in, a file or folder named in its context, and mission control's folder (`home.cwd`), which no other fleet on the same machine may use | Folders left out by the excludes below |
| Each repository a character works in: its Git directory, the main checkout, every worktree a character uses (one OpenCode made in `~/.local/share/opencode/worktree` too), and their staged, unstaged, untracked and ignored changes, stash, branches and refs | The registration of a worktree no character uses (its branch and stash still move) |
| Each agent's session: Claude Code's transcript with the session's own folder (subagents and saved tool output), Codex's rollout file, OpenCode's session export with Svall's log of it | Agent logins, user-wide settings, skills, MCP servers and hooks; Claude's file history, which `/rewind` uses, and session environment; OpenCode's own folders (`~/.local/share/opencode`, `~/.config/opencode`, `~/.local/state/opencode`, `~/.cache/opencode`) but for its worktrees, its undo snapshots, subagent sessions, and shell and tool-output files |
| `.env` files inside the folders that move | The fleet's own `.env`, unless `handover.transferFleetEnv` is on in `fleet.json` |
| | Every running process, its pid, its tmux window and its scrollback |

Folders named `node_modules/`, `.venv/`, `__pycache__/`, `dist/`, `build/`, `target/` and `.next/`, and
`*.tsbuildinfo` files, are left out by default, and each machine keeps its own. `handover.exclude` in `fleet.json`
adds patterns; `"excludeDefaults": false` replaces the defaults with yours. A folder a terminal is in moves whole, so a
shell open in `~/Developer` would carry every repository there: the checks stop at the ones no character works in
until you choose Carry the folder whole (`--carry-unused`), move the terminal, or leave them out.

Paths are never rewritten: both machines have the same home path, so every path in the fleet means the same thing on
either. A repository's `origin` that names a path on the Mac travels as it is, and the checks warn about it.

A folder the fleet left on a machine stays there as a replica of what was last carried. Moving back copies only what
changed. If something on that replica changed while the machine did not own the fleet, the checks before the copy stop
the handover rather than overwrite it: copy the changes back by hand, or archive the replica. A change made there once
the copy has started is overwritten.

A repository can say where it runs with `.svall/handover.json`, such as `{ "platforms": ["darwin"] }`, which
blocks a move to Linux while a character works in it. An Xcode project in a folder moving to Linux is only a warning.

## Agents

A handover carries Claude Code sessions from release 2.1.251 on, Codex sessions from 0.156.0 on and OpenCode sessions
from 2.0.22 on, with no upper limit: a Claude or Codex session's files are copied byte for byte to the same place on
the other machine, so a newer release works as long as it keeps its sessions where it did. An OpenCode session travels
as its `opencode session export`, which the other machine's OpenCode imports in the terminal's folder before the
character resumes. Each machine checks its own CLI before anything moves: installed, recent enough, logged in and
with Svall's hooks, as the daemon finds it. The destination's release must also be at least the source's, since an
older one may not read what the newer wrote; a newer one only warns. A login never moves; log in on each machine.

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
  A Claude Code monitor still running counts, going by the processes that run, not by the monitors its hooks listed.
  An idle OpenCode's MCP and language servers do not count: they stop with it.
- An agent still in its turn is waited for, up to three minutes (or as long as `--interrupt-after` says, if longer),
  then shows as a blocker you can keep waiting on or interrupt. Interrupting sends Escape and waits up to ten seconds
  for the agent and whatever it started to stop.
- An agent waiting on an answer blocks until you answer it or interrupt it.
- A shell running a command in the foreground blocks until the command ends or you terminate it.
- A command or an agent suspended with ctrl+z blocks too, until you bring it back with `fg` (then it counts as above)
  or terminate it.

On the other machine:

- Each agent terminal the handover rested resumes as a new process in its folder, with `claude --resume <id>`,
  `codex resume <id>` or `opencode --standalone -s <id>` and the launch flags it had, such as its model or permission
  mode. Codex's `-p`/`--profile` and `--local-provider` are dropped, because they name configuration on the machine
  it came from. It has its whole conversation. An agent the handover interrupted or terminated in a character's main
  terminal resumes with a note that its turn was cut short and that what it ran in the background was stopped, and
  carries on; in a second terminal, tell it to continue.
- A plain shell opens in its folder and prints: *Svall restarted this shell after a handover; whatever ran here
  before did not move.*
- A character that was dormant before the handover stays dormant.
- A terminal counts as up only once it starts the session it carries. Claude Code and OpenCode report that session
  as they resume; one that starts another session, or none within a minute, is closed and stays dormant with its own.
  One waiting to trust its folder or to accept Bypass Permissions mode stays open, and its row says which answer goes
  on. Codex reports nothing until its first turn, so it counts once its prompt shows, or else once it has held its
  terminal for 3 s, which its row then says.
- A terminal that does not come up stays dormant with its session, and its card and row say why, as do
  `svall status` and `svall char list` (`resume failed: <why>`). Retry it from the row, or open it like any dormant
  character. When it will not resume at all, **Start fresh from summary** on its terminal (`svall char revive <id>
  --fresh`, with `--term 2` for a second terminal) starts a new session in its folder whose first prompt summarises
  the old one's last turns; the old session's files stay where they are.
- Servers, builds and watchers do not restart: start them again. Ports are not forwarded to the Mac in this version.

## Working on the other machine

While the fleet runs on the Linux machine, the Mac app reaches it over ssh. Everything works as it does locally:
terminals attach through the same ssh connection, and the map, the files and the changes come through a forwarded
port. When the Mac sleeps, the fleet goes on.

- `svall` commands go to whichever machine owns the fleet; `--host <name|local>` picks one.
- The copy on the machine that does not own the fleet is read-only: reading works, and a change is refused with
  `handover_committed` once a handover has moved the fleet away from it (`not_owner` on a machine no handover left).
- The Load tab shows what the fleet costs the machine it runs on. On Linux a robot counts only what runs in its
  terminals: a server it left running in the background is neither listed nor ended by Sleep or Delete.
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
| Nothing is safe | The gateway cannot say whether the commit landed: wait until it is reachable and ask again; if it is gone for good, see [When the gateway is lost](#when-the-gateway-is-lost). A journal that could not be read, a handover between other machines, or another run already going also stop here; the message says which, and [what to do](errors.md#why-nothing-is-safe). |
| Forget | The gateway has moved on past this handover. `svall handover --forget` drops this Mac's journal of it. |

What else to know:

- **Killing the app** stops nothing, since the helper runs on. **Killing the helper** (or a foreground `svall
  handover`) leaves the handover where it stopped. The journals say where that is, the sheet rebuilds from them when
  the app opens, and `status` says what to do.
- **Starting while a handover is open here** stops and offers only `svall handover --resume`, which goes the one safe
  way on; `svall handover status` says whether `--abort` is safe too.
- **The Mac sleeping** suspends the helper and drops its link. Before the commit the fleet stays frozen on the machine
  it was leaving; after it, the fleet runs on neither machine. Once the Mac wakes, Resume or Abort, or Retry after the
  commit, goes on. Keep the Mac awake until a handover ends.
- **A dropped link** takes the controller from about 45 seconds to two and a half minutes to give up, depending on
  the step: each call waits up to 30 seconds and is asked up to four times, and the ssh connection is closed after 45
  seconds without an answer. The sheet shows the retries meanwhile, then stops with Resume and Abort before the
  commit; after it, the sheet resumes by itself once, then offers Retry. The last step of a move to this Mac takes longest, as it asks both the other machine and the gateway;
  it then ends complete, and `svall handover --resume` finishes what they missed.
- **A handover journal a machine cannot read** is moved aside to `handover/journal.json.broken-<time>` in its fleet
  home, and that machine starts read-only. On the machine the fleet came from, Abort takes the fleet back and reopens
  the terminals the handover rested. On the machine it went to, nothing is safe until you repair that file, put it
  back at `handover/journal.json`, restart the fleet's daemon there and resume, or name the machine to run the fleet
  with `svall fleet recover --force-owner <machine>`, which runs it from the state that machine holds. `svall
  handover status` names the file.
- **On the Linux machine**, `svall handover --resume` in a terminal there finishes a committed handover that moved the
  fleet to it, though it has no route to the Mac: the Mac finishes its own side when `svall handover --resume` (or
  Retry) runs there. Before the commit, resume and abort run only on the Mac that started the handover.
- **An unreachable gateway** never stops the machine that owns the fleet: it goes on working. No handover can begin or
  commit until the gateway answers, and a machine frozen for a handover stays read-only until one of them does.
- **Changes on the other machine** made before the copy starts are not overwritten: a changed replica stops the
  handover until you copy the changes back or archive it. One made while the copy runs is lost.
- **After the commit** a character that did not resume is retried on the machine the fleet went to, never by moving
  the fleet back.

## When the gateway is lost

If the gateway machine is gone for good, or its record of the fleet cannot be read, ordinary handovers cannot go on.
`svall fleet recover` writes a new ownership record, and is never part of an ordinary retry:

```sh
svall fleet recover --force-owner local                       # the gateway is gone and nothing replaces it: this Mac runs the fleet alone
svall fleet recover --force-owner local --gateway spare       # another registry machine replaces the lost gateway
```

1. It shows what the gateway and every machine hold, this Mac's journal and cached route, every generation it saw,
   the record it would write (at a generation above all of them) and the risks.
2. It writes only after you type the fleet id; without a terminal, `--confirm <fleet id>` does that.
3. It records the write in `controller/recoveries.ndjson` in the fleet home, and with a gateway also in the gateway's
   `recoveries.ndjson`, then tells every machine that answers: the one it names runs the fleet, and the others let go
   and close their terminals.
4. A machine it could not reach is listed under **next**. This Mac, and the gateway's own machine unless `--gateway`
   replaced it, take the record when their daemon next starts; any other has to be stopped, then the command run
   again once it answers.

Work done since the last handover on a machine that loses the fleet stays on that machine's disk; none of it is
carried. A machine that prepared a handover it never ran drops what it prepared, and the risks name it. `--gateway`
needs a machine from the registry that holds no record of the fleet, and is refused while the current gateway still
answers.

### When the only gateway is gone

With one Linux machine, nothing can replace it as the gateway, since a Mac is never one. When it does not answer,
`svall fleet recover --force-owner local` runs the fleet on this Mac alone:

- This Mac's daemon takes a record above every generation it saw, lets go any handover its journal holds (the
  terminals it rested reopen, and what it prepared is dropped), and runs the fleet. `fleet.json` names no gateway
  from then on, so no handover moves the fleet until `svall host enable <host> --fleet <fleet>` makes a machine its
  gateway again, at the generation this Mac holds (see [A gateway set up again](#a-gateway-set-up-again)). This
  Mac's own journal of a handover is dropped with it.
- With this Mac's daemon not running, the command writes `owner.json` and `fleet.json` itself and ends `incomplete`
  until the daemon starts, unless a handover journal lies there, which only the daemon lets go, even one it cannot
  read: start it first (`svall doctor` says why it is not running), then run the command again.
- It refuses while another machine answers that it runs the fleet, and this Mac's daemon refuses the record while
  the gateway answers it.
- Every other machine that answers takes the record first and lets go any handover it holds. One that holds a
  handover and does not take it ends the command `incomplete` before this Mac runs the fleet: run it again once that
  machine answers. One that reaches the gateway, which this Mac cannot, takes the gateway's own record instead, and
  the command ends `incomplete` too: the gateway is not lost, so recover through it from a machine that reaches it.
- Then `svall host remove <name> --forget` drops the lost machine from the registry. Before the recovery it refuses
  while this Mac keeps a journal of a handover, or the lost machine owns the fleet.

The lost machine never learns of the record. If it comes back still running the fleet, both machines run it until
you stop the fleet's daemon there for good (`systemctl --user disable --now svall-svalld@<fleet>`, since a plain
stop starts again at the next boot, or `svall uninstall --force`), and its copy of the work since the last handover
stays on its disk.

To make it the gateway again, `svall fleet recover --force-owner local --gateway <name>` writes a record naming this
Mac over whatever record it holds, names it the gateway in `fleet.json`, and tells its daemon to let the fleet go;
`svall host enable` refuses while its record names another owner. As a last resort, on that machine move its record
`~/.local/share/svall/gateway/fleets/<fleet id>.json` aside and run `svall uninstall --force`, then `svall host add`
and `svall host enable` it again from this Mac.

### A gateway set up again

A gateway machine that was reinstalled, or whose account was made again, has lost its record of the fleet and comes
back with a new machine id: commands that reach it find no Svall there, or another machine than the registry
names. Set it up again from this Mac, under the same name:

```sh
svall host add studio --ssh ada@studio        # installs the companion; the registry takes the new machine id
svall host enable studio --fleet private      # a new record naming this Mac the owner, and the machine's copy
```

The new record starts at the generation this Mac's `owner.json` holds, so the next handover begins there. Where
another machine holds a later generation, such as one that ran the fleet since, a daemon never gives up its
generation for a lower one, so a handover stops at Checks with `generation_mismatch`. `svall fleet recover
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

## When the Mac is lost

A fleet the Linux machine runs goes on there, and `svall` in a terminal on it works as before. A new Mac cannot take
the fleet in this version, since `svall host add` and `svall host enable` set up only a Linux machine. For a fleet the
lost Mac ran, `svall fleet recover --force-owner local` in a terminal on the Linux machine runs it there from the copy
it holds from the last handover; what was done on the Mac since is gone with it.

## Known limitations

- **OpenCode leaves its undo snapshots and subagent sessions behind.** On the other machine, undoing a step from
  before the handover does not work, and a subagent's own session is not there; its result is in the conversation.
- **A background job an agent started can go unseen** once the command that started it has exited, for Claude, Codex
  and OpenCode alike. It keeps running on the machine the fleet left.
- **OpenCode's shared service can finish a turn Terminate and carry cut off, on the machine the fleet left.** That
  machine's copy of the session still holds the unfinished turn, and OpenCode's shared background service resumes it
  there; any `opencode` command run outside Svall without `--standalone` starts that service. Until the fleet comes
  back, run OpenCode there only with `--standalone`, or first remove the copy with `opencode session delete
  --standalone <id>`, taking the id from `opencode session list --standalone` in the character's folder.
- **A plain `codex` typed in a character's bash, fish or nested zsh does not move.** It runs on Codex's shared
  background server, whose hooks Svall ignores, so its terminal has no agent: the checks show `shell_busy` (*is running
  codex*), and Terminate and carry leaves its session on the machine the fleet left. Type `codex --no-daemon` there
  instead; a character's own zsh and the agents Svall starts add it already.
- **An edit on the other machine while the copy runs is lost.** The checks compare each folder there with what was
  last carried before the copy starts; a change made there after that is overwritten. Leave the other machine's copies
  alone until the handover ends.
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
- **A committed handover can run nowhere for a while.** If the controller stops right after the commit (the link
  drops, the Mac sleeps, or the helper is killed), the machine the fleet went to holds it read-only until a resume
  activates it, so the fleet runs on neither machine. Retry (`svall handover --resume`) starts it; for a move to the
  Linux machine, so does `svall handover --resume` there. A move to this Mac also waits to confirm the commit with
  the gateway, so it starts only once the link is back.
- **Agents ask to trust each moved folder** the first time they resume in it on a machine (see [Agents](#agents)).
  The character waits at that prompt until you answer it.
- **A resume rebuilt without this Mac's journal forgets your choices.** If the controller's journal is lost,
  `--resume` rebuilds it from the other three without your interrupt, terminate, archive or carry choices, and may
  stop at the same blockers again; choose again.
- **More than ten terminals on a remote fleet** exceed sshd's default of ten sessions per connection. Each one past
  the tenth opens its own ssh login and shows one "Session open refused by peer" line. Like the app's own
  connection, that login asks nothing, and logs in with the keys ssh already holds; if none works, the terminal closes
  with "ssh quit as soon as it started". While the connection is full, the app's check of where the fleet runs cannot
  get through, so a window follows a move made outside it only once the connection has room again.
- **A Codex terminal a handover reopened with its session, or one you open again after a handover could not resume
  it, and quit before its first prompt** goes dormant again, its window closed, saying Codex exited before that
  session started: Codex reports a session only once it takes a turn. The session is kept; open the terminal again.
- **A controller killed outright** (such as `kill -9`) leaves its ssh connection open until the link drops.
- **The phone** shows a character that failed to resume as asleep, without the reason the Mac shows.
- **Version 1 covers one Mac and one Linux gateway per fleet**, with the same home path on both. It does not move a
  single character or island, forward ports, keep a phone URL across machines, or move from one Linux machine to
  another.
