# Smoke test: remote machines

A by-hand pass over the app with a Linux machine: adding it, moving a fleet both ways, and what happens when something
goes wrong on the way. It takes about an hour. The automated runs are in [docs/integration.md](../../../docs/integration.md);
this pass covers what only the app and real machines show. What each step should do is described in
[docs/remote-machines](../../../docs/remote-machines/README.md).

## What you need

- The app built from the commit under test with `pnpm desktop:install`, and `svall doctor` showing its `rsync` check ok.
- An Ubuntu 24.04 machine on your tailnet with a throwaway account whose home is your Mac home's path
  ([how](../../../docs/remote-machines/setup.md#the-same-home-path)), reachable with `ssh <account>@<machine>`.
- Claude Code, Codex and OpenCode (2.0.22 or newer) installed and logged in on both machines.
- A test fleet, so your own stays untouched: `svall smoke` offers to create one named `smoke`. Set
  `"handover": { "enabled": true }` in `~/.svall-smoke/fleet.json`, then quit and reopen its window with
  `svall smoke`. Every `svall` command below takes `-p smoke`.

To keep the whole pass off your own home too, run it under a test HOME as `docs/fleet-handover/ledger/m3b-env.md`
describes.

## 1. Provisioning

1. Settings → Machines → **Set up**. Name the machine `studio` and give its ssh destination. Choose **Add machine**.
   - Each step appears as it finishes, grouped Connect, Prerequisites, Companion, Service, Agent logins, Final probe
     and Registry. A new host key is asked in a dialog.
   - A fresh account ends with **still to do**: lingering, and any agent not logged in.
2. Do what it lists over ssh, then choose **Check**: no row is marked ×. On Ubuntu 24.04 `tmux` is marked ! (it ships
   3.4), and so may `gh` and `path` be; none of them stops a handover. It ends with **Check: done**, or with **ready
   for handover** when nothing is marked ! either.
3. Choose **Make it this fleet's gateway**. Its `machine`, `authority` and `fleet` steps are ok, and `svall host list`
   shows `studio` as a gateway.
4. Choose **Add machine** again with the same name: every step runs again and nothing changes.

## 2. The fleet

In the `smoke` fleet, make:

- two islands;
- a repository with a commit, a linked worktree beside it (`git worktree add ../smoke-wt -b wt`), and in each a staged
  change, an unstaged change, an untracked file and a stash;
- a character running Claude Code in the main checkout, with one finished turn that names a code word;
- a character running Codex in the worktree, with one finished turn;
- a character running OpenCode in the main checkout, with one finished turn that names another code word;
- a plain shell character with a second terminal open (Split, then Terminal in the right pane), and a browser tab on
  a `file:` URL;
- a character with a file in its context.

Select the Claude character and open its side card.

## 3. Mac to Linux

1. **Handover** at the foot of the sidebar → **studio**.
   - Checks lists the folders, files and sessions, and warns about each folder Claude or Codex will ask to trust.
   - Resting characters, then Transferring files and sessions with progress per folder and session, then Verifying and
     committing, then Resuming characters with a row per character.
2. When it completes:
   - The sidebar's foot names `studio`. The same character is selected with its card open.
   - A terminal of the Claude character answers its trust prompt once ("Yes, I trust this folder"), then shows its
     earlier turn. Ask it for the code word: it remembers it. The Codex character does the same, and the OpenCode one
     remembers its code word without asking about the folder.
   - The plain shell prints *Svall restarted this shell after a handover…*, in the same folder. `hostname` names
     the Linux machine. Its second terminal is there too.
   - In the worktree: `git status`, `git diff --cached`, `git stash list` and `git worktree list` match what you left.
   - The browser tab shows the same URL.
3. `svall -p smoke status` from the Mac lists the fleet as it runs on `studio`.

## 4. Linux back to the Mac

1. **Handover** → **This Mac**. The same five steps run, and the fleet comes back as it was, agents resuming again
   with their whole conversation.
2. Over ssh on `studio`: `~/.local/bin/svall -p smoke --host local island create x` reaches that machine's copy and is
   refused with `handover_committed` ("this fleet moved to another machine").

## 5. A foreground blocker

1. In the plain shell, run `sleep 600`. Start a handover.
   - Checks stops with `shell_busy`, naming `sleep 600`. Nothing has moved.
2. Start it again and choose **Terminate and carry**: the handover goes on, and on the other side the shell reopens
   with the restart notice.
3. Give an agent a task that takes a few minutes and start a handover.
   - Resting characters shows it resting, with **Interrupt and carry**.
   - Choose it: the agent is interrupted, and on the other side it resumes with its conversation.
4. Give the OpenCode character a local MCP server (an `mcp` entry in `opencode.json` in its folder), let it finish a
   turn, and start a handover.
   - Resting characters rests it at once: the MCP server it runs does not block.
   - Once the handover completes, `pgrep -fl opencode` on the machine it left lists nothing of that character.
5. Turn on **keep on this machine** on a character's card and start a handover: `character_pinned` stops it, with a
   button to the card.

## 6. A copy changed on the other machine

With the fleet on the Mac, edit a file in `studio`'s copy of the repository over ssh. Start a handover to `studio`.

- Checks stops with `destination_diverged`, naming the file. Nothing is overwritten.
- Choose **Archive and carry**: the handover goes on, and the folder's row says where the changed copy was kept,
  beside the folder with a timestamp, and still says so once the copy finishes.

## 7. Network failure

The Linux machine is reached over Tailscale, so disconnecting Tailscale on the Mac drops the link.

1. Start a handover and disconnect while it is transferring.
   - The headline shows retries, and within two minutes it stops with **Resume** and **Abort**.
2. Reconnect and choose **Abort**. The fleet stays on the machine it was on, and its terminals reopen.
3. Start again, disconnect during Resuming characters (after the commit), and reconnect.
   - It stops with **Retry** only, never Abort.
   - Retry brings the fleet up on the new machine; the old one runs none of its terminals.
4. Repeat 1–2 in the other direction, from Linux to the Mac.

## 8. Controller killed and relaunched

1. Start a handover. While it transfers, quit the app with Cmd+Q and open it again (`svall smoke`).
   - The sheet shows the handover still running, and it completes.
2. Start one more. While it transfers, find the helper with `svall -p smoke handover status` ("running here as pid N")
   and `kill -9` it, then quit and reopen the app.
   - The sheet shows the handover stopped part way with **Resume** and **Abort**. Resume completes it.
3. Do the same once it is Resuming characters: the sheet offers only **Retry**, and Retry completes it.

## 9. Re-attach after an ssh drop

With the fleet on `studio` and several terminals visible:

1. Disconnect Tailscale on the Mac for a minute.
   - The banner says `studio` is not reachable. The agents and shells keep running on `studio`.
   - No terminal asks for a password or opens a login of its own meanwhile; each waits.
2. Reconnect.
   - Within about a minute the banner clears and every visible terminal re-attaches, with its scrollback.
   - Typing reaches the same shells.

## 10. Clean up

Bring the fleet back with **This Mac**, then remove the machine with **Remove** (or `svall host remove studio`). To
delete the test fleet, stop its daemon and remove its home and agent:

```sh
launchctl bootout gui/$(id -u)/io.github.linusroxbergh.svall.svalld.smoke
tmux -S ~/.svall-smoke/tmux.sock kill-server
rm -rf ~/.svall-smoke ~/Library/LaunchAgents/io.github.linusroxbergh.svall.svalld.smoke.plist
```
