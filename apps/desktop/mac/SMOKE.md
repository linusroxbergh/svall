# Smoke test: remote machines

A by-hand pass over the app with a Linux machine: adding it as a worker, moving a robot there and back, and what
happens when the machine is out of reach. The automated runs are in [docs/integration.md](../../../docs/integration.md);
this pass covers what only the app and real machines show. What each step should do is described in
[docs/remote-machines](../../../docs/remote-machines/README.md).

## What you need

- The app built from the commit under test with `pnpm desktop:install`.
- An Ubuntu 24.04 machine on your tailnet with a throwaway account, reachable with `ssh <account>@<machine>`; its home need not
  be your Mac's ([home paths](../../../docs/remote-machines/setup.md#home-paths)).
- Claude Code, Codex and OpenCode (2.0.22 or newer) installed and logged in on both machines.
- A repository with a remote both machines can fetch from with their own credentials.
- A test fleet, so your own stays untouched: `svall smoke` offers to create one named `smoke`. Every `svall` command
  below takes `-p smoke`.

## 1. Adding the machine

1. Settings → Machines → **Add machine**. Name the machine `studio` and give its ssh destination. Choose **Add machine**.
   - Each step appears as it finishes, grouped Reaching the machine, What the machine needs, Svall on the machine,
     Running Svall there, Agent CLIs, Trying it out and This Mac's list of machines. A new host key is asked in a dialog.
   - A fresh account ends with "studio has N things to fix", such as an agent not logged in.
2. Choose **Open terminal** on a row that offers it, such as an agent not logged in: a terminal on `studio` opens in
   the panel with the command typed at the prompt and not run. Press Return and finish the login; clicking its link
   opens your browser. For `codex login` the sign-in comes back through port 1455; with another `codex login` holding
   that port on the Mac, the terminal says so at once. Typing `exit` closes it and the panel checks `studio` again.
   Do the rest the same way, then choose **Check** on `studio`'s row: no row is marked ×. On Ubuntu 24.04 `gh` and
   `path` may be marked !; neither stops a move. It ends with "studio is ready. Robots you move there keep working
   while this Mac sleeps."
3. Settings → Machines shows `studio` with the release and result of its last check.
4. Choose **Add machine** again with the same name: every step runs again and nothing changes.

## 2. The fleet

In the `smoke` fleet, on an island of its own (mission control's robots do not move), make:

- in the repository, three linked worktrees, each on a branch of its own (`git worktree add ../smoke-a -b a`), and in
  the first a commit not on the remote, a staged change, an unstaged change, an untracked file and an untracked `.env`;
- a robot running Claude Code in the first worktree, with one finished turn that names a code word;
- a robot running Codex in the second and one running OpenCode in the third, each with one finished turn that names
  another code word.

Select the Claude robot and open its side card.

## 3. Moving a robot out

1. Choose **Move to studio** on the card.
   - The sheet, "Move <robot> to studio", says in one line what travels: the session's size, the branch with its
     commit not on origin and its changed files, that `studio` will clone the repository the first time, and ".env
     stays here", with a box to copy it.
   - Choose **Move**. The card says "moving" and the terminal "moving to studio…"; then the card shows a `studio` badge
     and the terminal reopens on `studio`, in the robot's folder there.
2. A turn there:
   - Ask the agent for the code word: it remembers it. It asks nothing about trusting the folder.
   - Ask it to commit its changes: the commit lands on its branch on `studio`.
   - **Terminal there** on the card opens a terminal in its folder: `hostname` names the Linux machine, `git log`
     shows the new commit, and `.env` is not there.
   - Its panes offer no Files or Changes tab, and the card no Resources.
3. Move the Codex and the OpenCode robots the same way: each remembers its code word on `studio`.

## 4. Moving it back

1. Give the Claude robot a task that takes a few minutes, and choose **Move to this Mac** on its card while it works.
   - The sheet, "Move <robot> to this Mac", refuses with "<robot> is working" and **Interrupt after this turn**.
   - Choose it, then **Move**.
2. When it completes:
   - The card's badge is gone, and the terminal reopens on the Mac with the same conversation. Ask for the code word:
     it remembers it.
   - In the worktree on the Mac, `git log` holds the commit made on `studio`, and `git status` its changes as they
     were there.
   - Over ssh on `studio`, `git worktree list` shows the worktree it left, locked.
3. Move the Codex and the OpenCode robots back the same way.

## 5. A worker out of reach

With a robot on `studio` and its terminal visible:

1. Disconnect Tailscale on the Mac for a minute.
   - The robot's status is unknown and its terminal says `studio` is not reachable. The agent keeps running on
     `studio`.
   - No terminal asks for a password or opens a login of its own meanwhile; each waits.
2. Reconnect.
   - Within about a minute the terminal re-attaches, with its scrollback.
   - Typing reaches the same shell.

## 6. Clean up

Move every robot back with **Move to this Mac**, then remove the machine with **Remove** (or `svall host remove
studio`). To delete the test fleet, stop its daemon and remove its home and agent:

```sh
launchctl bootout gui/$(id -u)/io.github.linusroxbergh.svall.svalld.smoke
tmux -S ~/.svall-smoke/tmux.sock kill-server
rm -rf ~/.svall-smoke ~/Library/LaunchAgents/io.github.linusroxbergh.svall.svalld.smoke.plist
```
