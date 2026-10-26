# Moving a robot

Each robot runs on one machine: this Mac, or a Linux machine [added as a worker](setup.md) of the fleet. A robot you
move to a worker keeps its conversation, its branch, its commits and its uncommitted changes, and keeps working while
this Mac sleeps. The fleet stays on this Mac: its islands, map, notes, phone and mission control. A worker runs robots
and nothing else, and keeps its own clone of each repository its robots work in.

Robots on different machines share islands, cards, the map, the board and the keyboard flow. A robot on a worker shows
a machine badge on its card, token and board card, and keeps its board column; `svall robot run`, `read`, `wait` and
`revive` reach it there, and its terminal attaches over this Mac's own ssh connection to the worker.

## Moving one

On the robot's card, choose **Move to linus-vault** (one for each worker that answers), or **Move to this Mac** on a
robot that runs elsewhere. The sheet says in one line what travels, such as

> session 564 KB · branch kanban: 2 commits not on origin, 3 changed files · storefront on linus-vault: will clone (first time) · .env stays here

and **Move** runs it. Moving back, the line counts what comes back from the worker the same way. From a terminal:

```sh
svall robot move <id> --machine linus-vault    # to the worker
svall robot move <id> --machine local          # back to this Mac
```

It prints the sheet's line, then the move's id once the robot is the destination's. A refused move exits 2 with the
reason and the action. `--interrupt-after <duration>` (such as `30s`, or `0`) interrupts what still runs after that
long, `--carry <file>` takes a credential file such as `.env` along, and `--retry` runs the robot's current move again
from the step it stopped at.

While it moves the card says "moving" and its terminal "moving to linus-vault…"; opening a terminal, a revive, `svall
robot run` and closing the robot are refused with "moving to linus-vault". Then the card shows the badge, and the
terminal reopens on the other machine with the same conversation, in the robot's folder there.

## The checks

Every check is about this robot alone. A move that cannot happen shows the first reason with one action; the rest are
behind **details**.

1. **The worker is reachable and runs this release.** "linus-vault is not reachable; try again when it is awake".
   "linus-vault runs X, this Mac Y; upgrade it under Machines", or "update svall on this Mac" when the worker's is
   the newer.
2. **The robot's agent is installed and logged in there, at the same version or newer.** "claude is not installed on
   linus-vault", "linus-vault runs claude 2.1.299, this Mac 2.1.300; update claude on linus-vault", "claude is not
   logged in on linus-vault; log claude in there", each with the terminal button. An OpenCode logged in on neither
   machine runs on a model that needs no login, and passes.
3. **The robot stands in a Git worktree on a branch, or on a main checkout that the move converts.** On a main
   checkout the sheet says so ("your 3 changed files in svall's main checkout move to a new branch kanban"): after
   you confirm and the agent rests, the move makes a worktree under `.claude/worktrees/<robot>` on a new branch
   `<robot>`, carries main's index, working-tree changes and untracked files into it, staged against unstaged as they
   were, and leaves main clean on its branch. The stash list is never touched. "two robots share svall's main
   checkout; give one its own worktree first". "kanban is on a detached HEAD; check out a branch first". A robot in
   no repository, such as a shell in `~`, skips checks 3 to 6 and moves with its session only.
4. **The repository is known to the worker.** At the main checkout's place there (`/Users/ada/code/app` on the Mac is
   `/home/ada/code/app` on the worker) it has a clone of the same repository, or nothing and a remote it can fetch
   from with its own credentials. "svall has no remote; push svall to a remote first". "linus-vault cannot read
   github.com/ada/svall; log gh in there", with the terminal button. A path in the way is refused with its path, and
   nothing there is ever reset or deleted to make room.
5. **No other robot, on any machine, is on this branch of this repository.** "board is on kanban too; put one of
   them on another branch first".
6. **What travels fits, and carries no tracked credential.** The patches, untracked files and carried commits come
   to at most 100 MB. An untracked file in the worktree named like a credential (`.env*`, `*.pem`, `id_rsa*`,
   `*.tfvars`, `*.key`, `.netrc`) stays here unless you tick it in the sheet (`--carry`), and the sheet names it: ".env
   stays here". A tracked one that changed, or that a carried commit holds, cannot stay behind: "commit or revert .env
   first".
7. **The agent is idle, or you choose Interrupt after this turn.** "kanban is working; interrupt after this turn". "a
   command is running; move anyway and it ends". A robot waiting on a question moves too: it resumes idle, and asks
   again when prompted.

Mission control's robots stay on this Mac and have no move button.

## What travels

- **The session.** Claude Code's transcript and session folder, Codex's rollout, and OpenCode's session, written out
  of OpenCode on the machine it leaves and read into OpenCode where it lands. Each lands at the same place under the
  agent's home there, and the agent resumes it in the robot's folder.
- **The branch.** The commits the worker's clone lacks, as a Git bundle; the staged and the unstaged changes, each
  applied as they were; and the untracked files Git does not ignore, with their modes and links. The first move into a
  repository clones it on the worker from its remote, and carries only the commits the clone does not hold.
- **The agent's setup.** Before every move this Mac copies its agent configuration to the worker, one way: Claude's
  `CLAUDE.md`, `skills/`, `rules/`, `agents/`, `commands/`, `keybindings.json` and `settings.json`, Codex's
  `AGENTS.md`, `~/.agents/skills` and the fleet's agent profiles. Svall's own hooks and statusline there, logins, keys,
  plugins, `~/.claude.json` and the settings that hold secrets (`env`, `apiKeyHelper`, `awsCredentialExport`,
  `awsAuthRefresh`, `otelHeadersHelper`) never travel. A file under `~/.svall/mirror-overrides/` on the worker, laid
  out the same way, is merged last and wins.
- **Trust of the folder.** The first move into a clone on the worker trusts its main checkout, and so every worktree in
  it, in the agent's own settings there (Claude's `~/.claude.json`, Codex's `config.toml`), while no agent of that kind
  runs there; otherwise the agent's "Trust this folder?" question is answered for it as it opens. Bypass-mode consent
  and Codex's trust of Svall's hooks are yours to give, once per machine.

## What stays

- The worktree the robot left, kept and locked (`git worktree lock`, with the reason `moved to linus-vault <move id>`).
  Nothing in it is changed or deleted.
- Stashes, refs other than the branch, and ignored files, such as `node_modules` ("node_modules is not carried"):
  dependencies and build output are the destination's to rebuild.
- A credential file you did not tick.

A move never pushes: commits travel in the bundle, and the remote's branches are as you left them.

## Moving back

Moving back is the same move the other way. The worktree the robot left on this Mac is compared with what the move
recorded:

- A branch that moved refuses: "kanban moved on this Mac since the move; merge or rename it".
- A worktree that changed refuses: "changes on this Mac in /Users/ada/code/app/.claude/worktrees/kanban since the
  move; stash or commit them".
- An OpenCode session this Mac's OpenCode went on with refuses: "OpenCode went on with session ses_… on this Mac
  since the move; save it with opencode session export, then delete it". A move out refuses the same way for the
  worker's copy.
- A worker that sends no sheet of what comes back refuses: "linus-vault did not answer the move sheet in 30 s; try
  again", or on a release without one, "linus-vault runs a release without move.sheet; upgrade it under Machines".

Otherwise the worktree is reset to the commit it was left at, unlocked, and the robot's work from the worker is
applied to it: its commits, its staged and unstaged changes and its untracked files. The worktree it leaves on the
worker is then locked the same way, and the next move there takes it back by the same rules.

## When something goes wrong

- **Before the robot is the destination's** (a failed check of the files, a lost connection, a crash), the robot
  reopens where it was, with its window, and the destination removes what it prepared, but for an OpenCode session it
  read in, which the next move there replaces. A main checkout the move converted stays converted, and the robot
  reopens in its new worktree.
- **After it is**, a crash on either machine resumes the move from its journal; the robot never reopens on the machine
  it left. An agent that does not start there shows its error on the card with **Retry**, or
  `svall robot move <id> --retry`, which starts it without moving it again.
- **A worker this Mac cannot reach**: its robots show the status unknown, and their terminals "linus-vault is not
  reachable". They keep running there, and are never marked dormant for being out of reach. Once the worker answers
  again, what they did meanwhile comes home in order and the terminals attach again.
- **A worker that reboots**: its robots come back dormant, as on a Mac, and revive from their cards. Restarting its
  Svall service alone leaves them running.

`svall handover` moves no fleet while any of its robots runs on a worker or is on its way to one: "kanban runs on
linus-vault; move every robot back first".

## Limitations

- Stashes, refs other than the branch, and ignored files in the worktree stay on the machine they were on.
- Context items of kind file or folder outside the worktree do not exist on the other machine.
- No platform or filter checks: a robot whose work needs Xcode moves and finds out.
- A second terminal moves as a shell in the same worktree; a command running in it ends.
- The phone cannot see the server's robots while the Mac sleeps.
- No replica divergence protection, because there are no replicas: the only shared thing is a branch, and git owns it.
- A worker that disappears for good: its robots stay unknown until you close them.
- The scribe reads the transcripts of robots on this Mac alone: a robot on a worker keeps its name, note and board
  column until you change them.
- A question an agent had open does not survive a move: the agent resumes idle and asks again.
- The conversation travels whole: anything the agent pasted or printed in it, a key included, is in the transcript
  on both machines.
- sshd allows ten sessions per connection by default: the link's stream, each terminal and each file read share the
  daemon's one master, and a terminal past that opens an ssh login of its own.
