# M3b environment (for the owner's by-eye pass and what follows the M3b gate)

Written by Task 37c on 2026-09-28 at release `890b1df` (report `task-37c-report.md`), after the M3b gate and its
re-check (`m3b-gate-report.md`), updated by Task 39b on 2026-09-29 at release `896fc01` (report
`task-39b-report.md`), and by the final on-machine check the same day at release `d0602dc` (report
`final-onmachine-report.md`). The fleet's generations:
- 40b's round trip was generations 1 and 2;
- the gate's was generations 3 and 4;
- the re-check's was generations 5 and 6;
- 37c's Mac → Linux was generation 7, and its Linux → Mac generation 8;
- 39b's acceptance runs were generations 9 to 36 (its report lists each);
- the final check's Mac → Linux was generation 37, and its Linux → Mac generation 38.

**The Mac owns it at generation 38**, and no transaction is open anywhere.

`$G` below is the gate's scratchpad:
`/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/3739c9b8-51d0-4aa6-ac32-19bc0b56eee0/scratchpad/m3bg`.
37c's scripts are in `$G/c37/` and its logs in `$G/logs/c37/`; the re-check's logs are in `$G/logs/r/`. Task 40b's
`…/scratchpad/t40s2` and `…/t40` beside it keep those runs' logs and snapshots.

`$C` below is Task 39b's folder:
`/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/89928d60-3853-43e3-b6cb-3e149e9baba0/scratchpad/t39b`.
Its scripts are in `$C/` and `$C/bin/`, its logs in `$C/logs/` and its snapshots in `$C/snaps/`.

`$F` below is the final check's folder, `…/89928d60-3853-43e3-b6cb-3e149e9baba0/scratchpad/fin` beside `$C`: 39b's
scripts adapted to it, plus `units-far.sh`, `12-upgrade.sh <label>`, `13-rollback.sh <label> [release]`, `turn.sh` and
`after-{linux,mac}.sh`, with its logs in `$F/logs/` and snapshots in `$F/snaps/`. All three folders live under
`/private/tmp`, which a reboot of the Mac clears.

## Where things are

| | |
| --- | --- |
| Build | release **`d0602dc`** (unsigned; protocol 17, stateSchema 8, Node 24.21.0), built by `$F/build.sh` in `$F/src`, a `git archive` snapshot of `d0602dcc` with that commit's git metadata and the worktree's gitignored vendor caches: `scripts/release-build.sh --version d0602dc --url-base https://github.com/linusroxbergh/archipelago/releases/download/d0602dc` wrote and scanned the three archives into `$F/rel/`. The release publishes no app, so the app shell was built from the same snapshot (`apps/desktop/mac/build.sh release`) and its `Contents/Resources/release` replaced by the controller archive's tree (`$F/app/`). Log `$F/logs/01-build.log`. 39b's `896fc01` build is still in `$C/`, 37c's `890b1df` in `$G/c37/` |
| Test HOME (`TH`) | `/Users/Shared/archi-m3b` on the Mac (0700), the same path as archi-m3b's home on linus-vault |
| `ARCHI_APP_DEST` | `$TH/Applications` (the app is `$TH/Applications/Archipelago.app`, build `d0602dc`) |
| Helper | `$TH/Applications/Archipelago.app/Contents/Resources/release/bin/archi` (bundled node `…/release/node/bin/node`, `$BNODE` in `env.sh`) |
| Installed release | `$TH/.local/share/archipelago/current` → `releases/d0602dc`, with `896fc01` kept for a rollback; the install removed the older ones. Plist `$TH/Library/LaunchAgents/io.github.linusroxbergh.archipelago.archid.plist`, never loaded |
| TMPDIR | `$TH/tmp/` (ssh control sockets go to `$TH/tmp/archi-502/<hash>`) |
| Companion archive | `$G/companion/archipelago-companion-d0602dc-linux-x64.tar.gz` (46,233,877 B, sha256 `977873776c6cc13a…`), a copy of the release's; `$G/run/rel` names `d0602dc`. The `896fc01`, `890b1df`, `4697836` and `32ee1745` archives are beside it |
| Remote | host `m3b` = `archi-m3b@100.117.42.24`, machine `51cf5316-f3d9-447c-8855-58a6521effd2`, uid/gid 1002, linger on, home `/Users/Shared/archi-m3b`. Release `d0602dc`, with `896fc01` kept: the final check ran the release's `archi host upgrade m3b --release <companion> --allow-unsigned`, `--rollback` to `896fc01`, then the upgrade again. The first upgrade removed the older releases |
| Mac machine | `linuss-macbook-pro` (the test HOME's own id) `05b3af33-8eae-4be7-ae90-4f2d1318c398` |
| Fleet | `private`, id `d85abac7-4346-4b6a-8e86-d24a4053d294`, gateway `m3b` |
| Mac fleet home (`FH`) | `$TH/.archipelago`, daemon on `127.0.0.1:47871` (node.json is off 47800, which the owner's live daemon holds) |
| Linux fleet home | `/Users/Shared/archi-m3b/.archipelago`, `archipelago-archid@private.service` on `127.0.0.1:47800`, a read-only replica with sealed replicas of every root at generation 38, and no tmux server (the source stops its fleet at Complete since the fix wave). `agent-profiles.archived-2026-09-26T193825Z` (the bundle m3b seeded before profiles travelled), `home.archived-2026-09-26T151618Z` (40b) and `$TH/notes.archived-2026-09-28T234456Z` (39b's divergence check) are safe to delete. `archipelago-gateway.service` holds the authority record |
| Path roots | none; both machines' registry records carry `home=/Users/Shared/archi-m3b` |
| Ownership | the Mac at generation 38; `archi handover status`: none open anywhere |

## Opening the test build's app (by-eye pass)

From a plain Terminal on the Mac, with the Mac test daemon running (it is; see "Left running"):

```sh
sh /private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/3739c9b8-51d0-4aa6-ac32-19bc0b56eee0/scratchpad/m3bg/open-test-app.sh
```

It runs the app's binary directly with:

- `CFFIXED_USER_HOME=/Users/Shared/archi-m3b`. `NSHomeDirectory()` follows only this variable, not `HOME`. The app
  therefore takes its fleet home, machine registry, preferences, window frame and WebKit data from the test HOME.
- `HOME=/Users/Shared/archi-m3b` for the bundled `archi connect` it starts.
- `TMPDIR=$TH/tmp/`.
- The Finder PATH.
- Every `ARCHI_*`, `TMUX*`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `ZDOTDIR` removed, so a shell inside the owner's
  Archipelago passes nothing of his fleet to it.

It opens as a second "Archipelago" beside the owner's own, which keeps running. Quit it with ⌘Q in its window.

The gate checked this on `32ee1745` (`$G/logs/60-app-open.log`), the re-check on `4697836` (`$G/logs/r/80-app-open.log`),
37c on `890b1df` (`$G/logs/c37/80-app-open.log`), 39b on `896fc01` (`$C/logs/80-app-open.log`) and the final check on
`d0602dc` (`$F/logs/80-app-open.log`):

- the test app claimed `$TH/.archipelago/app.pid`;
- its helper ran with the test HOME, and its page connected to the test daemon on 47871;
- WebKit data went to `$TH/Library/WebKit`;
- the owner's app, his preferences plist and his WebKit stores were untouched.

Do not use instead:

- **`HOME=… open …` or `HOME=…` alone.** The app would open `~/.archipelago`, the owner's own fleet.
- **`archi` or `archi <profile>` from the test HOME.** Its launch path asks launchctl for the owner's own agent label,
  then runs `open -a Archipelago`, which LaunchServices may resolve to either app.
- **`open -a Archipelago` or `open -b io.github.linusroxbergh.archipelago` while the test app exists.** Both apps share
  the bundle id. Open the owner's own app by its path, `/Applications/Archipelago.app`.

Both apps share the bundle id, so macOS notifications from the test app show as "Archipelago".

### What to look at (Task 39b's list)

Task 39b proved the spec's manual acceptance from the CLI (`task-39b-report.md`). These are what only the app shows.
Start with the Mac owning the fleet and the test app open; in a Terminal set `G=` and `C=` to the folders above. Each
Handover is **Handover** at the foot of the sidebar, then **m3b** or **This Mac**.

1. **The same selected character and browser tabs after a round trip.** Select `shell` (island `m3b shells`), open its
   card and its browser: two tabs, `page.html` (it shows T39B-PAGE) and `https://example.com/t39b?tab=2`. Make the
   second tab active and split the panes. Handover → m3b: when it completes, the sidebar's foot names m3b, `shell` is
   still selected with its card open, the browser shows both tabs with the second one active, the layout is the same,
   and `hostname` in shell's terminal says `linus-vault` under the restart notice. Handover → This Mac: the same, with
   this Mac at the foot. (The tab URLs travel in the state, which 39b's compares checked; the selection, the active tab
   and the layout are the app's own.)
2. **The sheet rebuilt after the helper is killed before the commit.** In the Terminal: `sh $C/eye-kill.sh transfer`.
   In the app: Handover → m3b. The script kills the helper as Transferring starts. Quit the app (⌘Q) and open it again.
   The sheet should come back by itself at the step it stopped at, with **Resume** and **Abort** and no Retry (`sh
   $G/a.sh handover status` says "open … Safe: `archi handover --resume` or `archi handover --abort`"). Choose Abort:
   the Mac reopens every terminal. Do it again and choose Resume: the fleet completes on m3b.
3. **The sheet rebuilt after the helper is killed after the commit.** With the fleet on m3b: `sh $C/eye-kill.sh
   activate`, then Handover → This Mac. Quit and reopen as before: the sheet shows Resuming characters with only
   **Retry**. Retry completes on the Mac.
4. **Quitting the app mid-handover.** Run `sh $G/a.sh char run c_srvv73 'work 60'` so Resting characters waits on the
   worker, then Handover → m3b and quit the app while it rests. Reopen: the sheet shows the handover still running, and
   it completes.
5. **A foreground shell blocks visibly.** `sh $G/a.sh char run c_m62lwt 'sleep 600'`, then Handover: Checks names
   `shell_busy` for shell and `sleep 600`, with **Terminate and carry**, and nothing moves. Choose it: the handover
   completes, and shell's terminal on the other side shows the restart notice.
6. **A working agent.** `sh $G/a.sh char run c_srvv73 'work 120'`, then Handover: Resting characters shows worker
   resting with **Continue waiting** and **Interrupt and carry**, and the sheet cannot be closed meanwhile. Interrupt
   and carry: worker's pane on the other side reads `(resumed)`.
7. **The archived copy's row.** With the fleet on the Mac: `ssh archi-m3b@100.117.42.24 'echo EYE >>
   ~/work/worker/README.txt'`, then Handover → m3b. Checks stops on `destination_diverged` naming `README.txt`; choose
   **Archive and carry**. Watch the `work/worker` row under Transferring: does it say where the old copy went
   (`…/work/worker.archived-<time>`), is it marked ×, and does the line survive once the copy's progress starts? On
   `896fc01` the next progress line replaced it (39b's F1); since the fix wave every progress line of that folder
   carries it (`archivedTo`), so it should stay, unmarked. Delete `~/work/worker.archived-*` on m3b afterwards.
8. **A resume that fails, and Retry.** With the fleet on the Mac: `ssh archi-m3b@100.117.42.24 'touch
   ~/.m3b-mock/fail-resume'`, then Handover → m3b. failer's row is marked × with "… exited back to its shell, so it is
   dormant again …", with **Retry**; its card says why; the Mac runs nothing. Choose Retry while the flag is still
   there, and note what the row and the card show. On `896fc01` failer was left a plain shell with no session and a
   second Retry did nothing (39b's F3); since the fix wave it should go dormant again with its session and the error,
   so Retry stays offered. Then `ssh archi-m3b@100.117.42.24 'rm ~/.m3b-mock/fail-resume'` and Retry once more: it
   should come up on `456339f6-1755-4ddc-bc20-c6550f43e27a`. If it is left a plain shell instead, type `claude --resume
   456339f6-1755-4ddc-bc20-c6550f43e27a` in failer's terminal to bring its session back.
9. **The network pulled, and re-attach after an ssh drop** (`apps/desktop/mac/SMOKE.md` §7 and §9). Only by
   disconnecting Tailscale on the Mac, which 39b did not touch: its cells pulled the link through an ssh proxy the app
   does not use. The CLI's timings to expect: the headline shows retries, then Resume and Abort 59–108 s after the pull
   before the commit, and only Retry 47–98 s after it; in Complete toward the Mac the run can end as complete with the
   source and gateway pending after about 2.5 minutes.

When done, leave the Mac owning the fleet and quit the test app. Since the fix wave a live terminal drops its carried
`revive` at the first poll after its activation (D1), so no daemon restart is needed.

## Wrappers (all `sh`; the Mac ones source `$G/env.sh`: unsets ARCHI_HOME/ARCHI_CHAR_ID/TMUX/TMUX_PANE, sets HOME, ARCHI_APP_DEST, TMPDIR and the Finder PATH `/usr/bin:/bin:/usr/sbin:/sbin`)

- `$G/a.sh <archi args>`: the bundled helper, stdin `/dev/null`.
- `$G/ho.sh <label> <handover args>`: runs `archi handover … --json` in the foreground and writes
  `logs/<label>.ndjson|.stderr`. `$G/ho-ts.sh` does the same and also writes `logs/<label>.times`, each stream line's
  arrival in seconds with its event, phase, character and notice (`bin/ts.pl`).
- `$G/watch-manifest.sh <label>` (background during a handover): copies the controller's and the Mac daemon's
  manifests, which Complete clears, into `evidence/<label>/`. Stop it with `touch evidence/<label>/stop`. Read them with
  `$BNODE $G/bin/pids.mjs <files>`.
- RPC wrappers (tokens are never printed):
  - `$G/api.sh <method> [json]`: one RPC to the Mac daemon;
  - `$G/rapi.sh <method> [json]`: the same on m3b, through `~/m3b-tools/api.mjs`;
  - `$G/chars.sh`: one line per character of the Mac state, with each slot's pid and revive.
- `$BNODE $G/bin/docs.mjs <fleetHome> create|read` finds the four gate docs as Resources rows (`resources.get`), then
  reads them with `fs.read` and prints beta-main's brief lines. m3b has a copy in `~/m3b-tools/`.
- `$BNODE $G/bin/sess.mjs <agentHome> <cwd> <sessionId>` prints a Claude session's files and records. m3b has a copy.
- `ssh archi-m3b@100.117.42.24 'sh -s' < <script>` runs these on m3b:
  - `$G/far-checks.sh`: ownership, characters, windows, agent argv, state pids against `/proc`, profiles, docs and log;
  - `$G/linux-fenced.sh` (`sh -s -- <charId>`): the Linux side after the fleet left it;
  - `$G/notes-wake.sh`: opens the dormant notes;
  - `$G/40r-lock-linux.sh`: the second-archid check, with fingerprints of `archid.log` and the unit log (`40-lock-linux.sh`
    is the gate's);
  - `~/m3b-tools/r-watch.sh <label> <charId>…` (run there): every 0.5 s, each character's window, the prompt its pane
    shows and its state, into `~/m3b-tools/<label>.watch`; `touch ~/m3b-tools/<label>.stop` ends it.
- On the Mac:
  - `$G/mac-fenced.sh`: the Mac after the fleet left it, then the same after a restart of its archid;
  - `$G/52-mac-after.sh <label>`: the Mac as owner;
  - `$G/41r-lock-mac.sh`: the second-archid check, with `archid.log` fingerprinted (`41-lock-mac.sh` is the gate's);
  - `$G/34-turns.sh mac|linux <suffix>`: turns for real-claude and both Codex characters, then their files;
  - `$G/r-turns.sh mac|linux <suffix> <charId>…`: a code-word turn for each real Claude named, then its files and state.
- `$G/mac-daemon-start.sh` starts the Mac daemon as its plist would (`env -i`, the plist's PATH, cwd `$TH`). Its pid
  goes to `$G/run/archid.pid` and its log to `$FH/archid.log`. `$G/mac-daemon-restart.sh` restarts it.
- `$G/st.sh` (Mac) and `$G/rst.sh` (m3b): a setup tmux of its own, not the fleet's, for answering Codex's trust screens.
- `$G/snap.sh mac|linux <label>` writes `$G/snaps/<label>-<side>.json`, and `$G/cmp.sh <from> <to>` runs `bin/compare.mjs`.
- Checks: `$G/09-token-grep.sh`, and `$G/linus-diff.sh [label]` (linus-vault's stable state against the 40b
  before-state; it logs in as the default ssh user, not archi-m3b).
- 37c's (`$G/c37/`):
  - `23-creds.sh`: the Claude login into the test HOME, then to m3b only with 90 minutes or more left, else the Mac
    copy is deleted at once (exit 3). `69-creds-delete.sh` deletes both and shows neither is left;
  - `20-m3b-unbypass.sh` (`sh -s` on m3b): removes `skipDangerousModePermissionPrompt` from m3b's Claude settings,
    keeping a copy in `~/m3b-tools/settings.json.before-c37`;
  - `24-bypass-start.sh`: revives real-claude-b, `/exit`, then types `claude --dangerously-skip-permissions --resume
    <id>` into its shell. Its wait reads a dormant character's stale `agent.pid` as started; wait for the pane instead;
  - `32-bypass-accept.sh` (`sh -s` on m3b): "Yes, I accept" in real-claude-b's pane, then its SessionStart;
  - `pf.mjs <ndjson> <chars.tsv>`: a handover stream's preflight blockers and warnings, one per line;
  - `66-real-claude-rest.sh`: the re-check's rest, for real-claude-b alone.
- 39b's (`$C/`):
  - `$C/state.sh mac|linux`: one line per character (window, agent, status, pid, `revive`, `restedBy`, browser tabs),
    then the ownership and the windows; `$C/sides.sh`: both machines, the gateway's record and any leftover master at a
    glance.
  - `$BNODE $C/bin/drive.mjs <label> <handover args>`: a handover with `--json` (or, with `DETACH=1`, `--detach` then
    `attach`) into `$C/logs/<label>.ndjson|.times|.summary.json`. `TRIGGER=event:<event>:<phase>[:<ms>]`,
    `TRIGGER=ssh:<word>` or `TRIGGER=ssh-hold:<word>` pull the link; `KILL=event:…` SIGKILLs the controller.
  - `$C/cell.sh <label> <host|local> <abort|resume|auto|abort-then-resume> KEY=VALUE…`: one fault cell, with `status`
    and the recovery. `$C/pf.sh <label>`: a run's blockers, warnings, phases, retries and result.
  - The pulled link: `$C/shim/ssh` gives ssh `$C/bin/linkproxy.mjs` as its ProxyCommand, and while `$C/link/down`
    exists no byte crosses and no connection opens. drive.mjs puts the shim on the controller's PATH, and
    `$C/mac-daemon-restart.sh shim` on the Mac daemon's (plain `$C/mac-daemon-restart.sh` takes it off).
    `$C/bin/link-guard.sh <seconds>` restores the link after that long.
  - `$C/eye-kill.sh <phase> [seconds]`: for the by-eye list above.
- Do not write a redirection-only command such as `$UNSET 2>/dev/null` in zsh: it runs `cat` on stdin.
- `pgrep -f` inside `ssh … '<command>'` matches that command's own shell. Count with `ps -o args= | grep -c '^<path>'`.
- **Making a character dormant with its session.** Close its window while archid is down (stop it, kill the window,
  wait for the agent to exit, then run `mac-daemon-start.sh`), as `$G/66-real-claude-rest.sh` does. The restarted
  archid then marks it dormant with its `revive`, but without launch flags, since no process is left to read them from.
  A `tmux kill-window` with archid up lets the agent's SessionEnd clear the session instead.

## Snapshots and comparison

- `bin/snap.mjs` and `bin/spec-{mac,linux}.json` cover one root, `home`, at the same path on both sides.
  - Folders: `src/alpha`, `src/beta`, `src/beta-wt1`, `src/beta-wt2`, `src/beta-unused`, `notes`, `real` (so
    `real/claude-r`, `real/claude-r/bypass`, `real/claude-t`, `real/flags`, `real/codex-*`), `.archipelago/home`,
    `.archipelago/agent-profiles` and
    `.archipelago/docs`.
  - Git checkouts: those five plus `src/alpha/.wt/feat`.
- `bin/compare.mjs` is 40b's. Its `rewrite` lines on the beta checkouts' `worktree list` are beta-unused's registration,
  which is not carried: they are equal once it is dropped.
- Snapshots:
  - the gate: `s4-before-mac`, `s4-after-linux`, `s5-before-linux`, `s5-after-mac`;
  - the re-check: `s6-before-mac` (its original), `s6-after-linux`, `s7-before-linux`, `s7-after-mac`;
  - 37c: `c1-before-mac` (its original, real-claude-b running in bypass mode), `c1-after-linux`, `c2-before-linux`,
    `c2-after-mac` (real-claude-b still live; the current state but for its rest and the stale revives below).

  `c1-before-mac → c2-after-mac` is 10 DIFF, each a live character's `revive` (37c defect D1: a live terminal a
  handover opened keeps its carried `revive` until that archid restarts).
- 39b's snapshots are in `$C/snaps/`, taken by `$C/snap.sh mac|linux <label>` with `$C/bin/spec39-{mac,linux}.json`
  (the gate's folders plus `work/`) and compared by `$C/cmp.sh <from> <to>` into `$C/logs/cmp-*.txt`:
  - `d1-before-mac` (its original: 15 characters, before the first move), `d1-after-linux`, `d2-before-linux`,
    `d2-after-mac`;
  - `f1-before-mac` (real-claude live), `f1-after-linux`, `f2-after-mac`, the last round trip.

  `d1-before-mac → f2-after-mac`, across all of 39b's handovers, differs only by D1's `revive` fields and the
  archived replica `work/failer.archived-2026-09-28T234918Z` that 39b's divergence check left on the Mac. The Mac
  archid restarted after the last handover, and no live terminal holds a `revive` now.
- The final check's snapshots are in `$F/snaps/` (same spec, `$F/snap.sh` and `$F/cmp.sh`), files named
  `<label>.json`: `a0-mac` (as found), `b1-before-mac` (real-claude live), `b1-after-linux`, `b2-before-linux`,
  `b2-after-mac`, and `c9-end-mac` (as left, after real-claude's rest). `a0-mac → c9-end-mac` is 0 DIFF: only the
  real sessions grew.

## Fixture (Mac)

Fifteen characters on five islands besides mission control. Islands: `m3b repos` `i_k46lzs` (file context ref
`$TH/notes/f1.txt`, so its agents get `--add-dir $TH/notes`), `m3b dirs` `i_6crr3l`, and 39b's `m3b shells`
`i_5j8cv0`, `m3b work` `i_9g5yfe` and `m3b fail` `i_l174sc`. The scribe is off, and `dormantAfterHours` is **0**. Ids
are in `$G/run/chars.tsv` and `$G/run/islands.tsv`.

| name | id | cwd | notes |
| --- | --- | --- | --- |
| notes | `c_4jdink` | `$TH/notes` | carried dormant, woken on Linux, live again (session `a238f2dd-59c9-472e-a080-8935c84ab154`, 10 records) |
| alpha-main | `c_d4e995` | `$TH/src/alpha` | its second terminal runs the mocked claude (session `35bbee19-0e88-4881-a4a8-b02bf8885f16`) |
| alpha-feat | `c_2kp1rw` | `$TH/src/alpha/.wt/feat` | nested worktree; agent profile `m3b-role` (custom; travels with `agent-profiles/`) |
| beta-main | `c_dy5zy3` | `$TH/src/beta` | `node_modules/` default-excluded; holds the character doc |
| beta-wt1 | `c_9y8x8f` | `$TH/src/beta-wt1` | sibling worktree |
| beta-wt2 | `c_27vxwy` | `$TH/src/beta-wt2` | sibling worktree |
| real-codex | `c_ts2fmw` | `$TH/real/codex-x` | real Codex 0.156.1, session `01a0ddbd-67eb-7b41-8ec8-a30797ef4a8f`, 147 records (`…GATE-LINUXGATE-MACFIN-LINUXFIN-MAC`) |
| flags | `c_ku8ri5` | `$TH/real/flags` | mocked, resumes with `--effort high --dangerously-skip-permissions` |
| real-codex-p | `c_z2jbwx` | `$TH/real/codex-p` | real Codex, session `01a0de47-a05d-7b20-a108-5e27532bb402`, 76 records; runs `-m gpt-6-astra` without the Mac-only profile `t40` |
| real-claude | `c_ruypft` | `$TH/real/claude-r` | real Claude Code 2.1.283, session `cff60418-f7bb-44cf-85ce-f9bb153978cd` (code word OSPREY; 129 records: Mac, Linux, Mac, then 39b's Mac, Linux, Mac on `896fc01`, then the final check's on `d0602dc`). **Dormant** with `revive: claude --resume cff60418-…` |
| real-claude-t | `c_jmyxcs` | `$TH/real/claude-t` | real Claude, session `10542a51-6750-490a-89cc-3bee4522534d` (code word FALCON; 53 records: Mac, Linux, Mac). Its folder was untrusted on both machines until answered. **Dormant** with `revive: claude --resume 10542a51-…` |
| real-claude-b | `c_aosb44` | `$TH/real/claude-r/bypass` | real Claude started `claude --dangerously-skip-permissions`, session `b65e21cb-6b39-4b2e-9f64-727dc5b4ef3f` (code word LYNX; 79 records, turns Mac, Linux, Mac, Linux, Mac). **Dormant** with `revive: claude --resume b65e21cb-…`: the rest that closed its window dropped the flag, and its state keeps the stale pid 41144 |

| shell | `c_m62lwt` | `$TH/work/shell` | plain shell with a second terminal, and two browser tabs: `file://$TH/work/shell/page.html` and `https://example.com/t39b?tab=2`. `archi char run c_m62lwt 'sleep 600'` makes a foreground blocker |
| worker | `c_srvv73` | `$TH/work/worker` | the worker mock (below): `archi char run c_srvv73 'work <seconds>'` starts a turn that long, whose tool command is `sleep <seconds>`; Escape ends it |
| failer | `c_5fssn9` | `$TH/work/failer` | mocked; its resume fails on a machine where `$TH/.m3b-mock/fail-resume` exists (neither has one now) |

No Claude login copy is left, so reviving any real-Claude character starts Claude logged out.

- Graph alpha: nested worktree `.wt/feat` (in `info/exclude`), committed link `link-to-f1`, a repo `.env`.
- Graph beta: sibling worktrees `beta-wt1` and `beta-wt2`.
  - **beta-unused** (`$TH/src/beta-unused`, branch `unused-br`) is a registered worktree no character uses. It is clean,
    and its change is the stash `beta-unused stash`, `stash@{0}` of beta.
  - It stays registered on the Mac (O6). m3b's copy of beta has no registration for it, but keeps `unused-br` and the
    stash.
- Each graph has uncommitted edits, a partly staged index, an untracked file and a stash.
- The links are `lrwxrwxrwx` since the first return (A2 defect 2).
- Entity docs (made with `docs.create`, keys in the text):

  | Tier | Doc | Key |
  | --- | --- | --- |
  | fleet | `$FH/docs/fleet/m3b-fleet.md` | FLEET-KESTREL |
  | island `i_k46lzs` | `$FH/docs/islands/i_k46lzs/m3b-island.md` | ISLAND-PLOVER |
  | character `c_dy5zy3` | `$FH/docs/characters/c_dy5zy3/m3b-character.md` | CHARACTER-WREN |
  | repo beta | `$FH/docs/repos/beta-d3942f1e/m3b-repo.md` | REPO-HERON |

- `$FH/agent-profiles` holds the six bundled profiles and `m3b-role.md`; m3b's copy is the same (sealed replica).

## Agents

- **Mocked Claude:**
  - `$TH/.m3b-mock/claude` on both machines is A2's `claude.mjs`, extensionless beside a `package.json` of
    `{"type":"module"}`, reporting 2.1.260. It posts its own pid with each hook.
  - `~/.local/bin/claude` dispatches on both machines. In `$TH/real/claude-r/` and `$TH/real/claude-t/` it runs the
    real Claude:
    `agents/real-claude/claude`, a link named `claude` to `agents/claude-2.1.283`, with `DISABLE_AUTOUPDATER=1`.
    Everywhere else it runs the mock, through the app's bundled node on the Mac and `current/node/bin/node` on m3b.
  - Both daemons' agent probes run outside those folders, so they see the mock.
  - The mock-only wrappers are kept as `$G/run/mac-claude-wrapper.mock` and m3b's `~/.m3b-mock/claude-wrapper.mock`.
  - Since 39b the dispatcher also runs `$TH/.m3b-mock/w/claude` (the worker mock: raw input, `work <seconds>`, Escape)
    in `$TH/work/worker/`, and `$TH/.m3b-mock/f/claude` (prints "No conversation found…" and exits 1 after 2.5 s) for a
    `--resume` in `$TH/work/failer/` while `$TH/.m3b-mock/fail-resume` exists. The dispatchers before 39b are
    `$TH/.m3b-mock/claude-dispatch.before-39b` on both machines.
- **Real Claude 2.1.283:**
  - Mac: `$TH/agents/claude-2.1.283`, a copy of the owner's `~/.local/share/claude/versions/2.1.283`.
  - m3b: `~/agents/claude-2.1.283` (from Task 41).
  - Both `.claude.json` files have `hasCompletedOnboarding` and trust `real/claude-r` and `real/claude-t`.
  - Both Claudes have accepted bypass mode (`skipDangerousModePermissionPrompt: true` in `~/.claude/settings.json`,
    beside Archipelago's hooks). m3b's was answered again in 37c (its settings are byte-identical to the copy in
    `~/m3b-tools/settings.json.before-c37`), so a new bypass check needs that key removed there first
    (`$G/c37/20-m3b-unbypass.sh`).
  - m3b's pre-gate `.claude.json` is `~/.m3b-mock/claude.json.before-gate`.
  - **No Claude credential is left on either machine.** The final check's copies of the owner's login were deleted at
    07:11:16Z on 2026-09-29 (39b's at 01:07:59Z that day, 37c's at 15:43:02Z on 2026-09-28), and no real Claude runs.
  - `$TH/Applications/Claude Code URL Handler.app` is one real Claude made under the test HOME.
- **Real Codex 0.156.1:**
  - Mac: `$TH/agents/codex`, with `$TH/.codex/auth.json` (0600) and `config.toml` trusting `real/codex-x`,
    `real/codex-p` and the 8 hooks. Profile `t40` is `$TH/.codex/t40.config.toml`.
  - m3b: `~/agents/codex`, with `~/.codex/auth.json` and the same trust. There is no `t40`.
- `$TH/.zprofile` and `.zshrc` keep `$TH/.local/bin` ahead of `/usr/local/bin`. The owner's real
  `/usr/local/bin/claude` never ran under the test HOME.

## Harness on m3b (not product)

- `~/.m3-no-node/` holds stubs for npm, npx, pnpm, corepack and tsx (exit 127), with the `.bashrc` line putting them
  first. The node stub is renamed `node.t40-disabled`, because Codex's hook runs `node` from PATH.
- `~/.m3b-mock/`, `~/.local/bin/{claude,codex}`, `~/agents/{codex,claude-2.1.283,real-claude/}`, and `~/m3b-tools/`
  (api, chars, snap, docs and sess tools, `r-watch.sh` and the pane watches `r31.watch`, `c37w31.watch` and
  `c37w50.watch`, the lock checks' before and after files, `settings.json.before-c37`, and the last `out.json`).
- Task 41's `~/probe/` is there too. It is not part of the fleet.

## Left running

- **Mac:**
  - archid, pid in `$G/run/archid.pid` (91360, on `releases/d0602dc`, started by `$G/mac-daemon-start.sh` with the
    plist's PATH), log `$FH/archid.log`;
  - its tmux server `/opt/homebrew/bin/tmux -S $FH/tmux.sock` (89638) and control client (91380);
  - 15 windows: `_keep`, the 12 live characters, `c_d4e995-2` and `c_m62lwt-2`. The three real-Claude characters have
    none;
  - 10 mocked agents and 2 real Codex, all idle;
  - no test app, ssh master, helper, link proxy, watcher or setup tmux, and no `caffeinate` of the final check.
- **m3b** (archi-m3b, lingering):
  - `archipelago-archid@private.service` (MainPID 2708271) and `archipelago-gateway.service` (MainPID 2708280), both
    on `d0602dc`, active and enabled;
  - no tmux server for the fleet: a fenced machine runs none since the fix wave.

## Before-state

- **linus-vault:** `$G/baseline/linus-before.txt` (full) and `linus-state-before.txt` (stable subset), taken at the
  start of 40b while archi-m3 still existed.
  - `tailscale serve status`: `https://linus-vault.prawn-turtle.ts.net (tailnet only)` / `|-- / proxy
    http://127.0.0.1:8787` (linus's `bun`).
  - `127.0.0.1:47800` was archi-m3's archid and is now archi-m3b's.
  - Re-take with `$G/linus-diff.sh <label>`. At the end of the re-check the differences are archi-m3 → archi-m3b in
    passwd and the linger directory, Ubuntu's snap loop-device targets, and one of linus's own listeners
    (`192.168.0.100:35459`) gone. 37c did not re-take it: the script does not log in as archi-m3b.
- **Mac:** `$G/baseline/mac-before.txt` and `mac-before-gate.txt`.
  - `~/.ssh/known_hosts` md5 `1f403c1326762e931fcf90aa00a04d27` (mtime Sep 14), unchanged.
  - `~/Library/LaunchAgents` mtime 2026-09-26 11:49:14 +0200, unchanged.
  - `/Applications/Archipelago.app` is the owner's own install. It now reads build `4067bfea`, mtime 2026-09-28
    08:27:52 +0200: a reinstall outside these passes, which install only into `$TH/Applications`.
  - The owner's `~/Library/Preferences/io.github.linusroxbergh.archipelago.plist` read mtime 2026-09-28 13:19:04 +0200,
    1550 B, before 37c began; 37c's test-app check left it unchanged (`$G/logs/c37/72-owner-files.log`). On
    2026-09-29 the owner's own app, opened at 09:03:10 +0200, wrote it (09:05:17, 1567 B, then 09:11:47); the final
    check's test-app open at 09:05:26 left it as it was (`$F/logs/80-app-open.log`).
  - The gate and the re-check read the owner's keychain item `Claude Code-credentials` as authorised (the re-check three
    times, two of them left unused for too little time), and `~/.archipelago/app.pid` once. Neither wrote anything of
    his.

## Teardown recipe (not run; the environment stays for the by-eye pass)

- **Mac:** `sh $G/teardown-mac.sh`. It kills archid, the tmux server, and any master or helper of `$TH`, then removes
  `/Users/Shared/archi-m3b`, which takes the app, the release, the Codex credential and the binary copies with it.
  `$G/src` (the re-check's build snapshot), `$G/c37` (37c's snapshot, release and app) and `$C` (39b's snapshot,
  release, app, scripts and logs) go with their scratchpads.
  - Quit a test app that is still open first.
  - Task 41's probe session in the owner's `~/.claude/projects/-Users-Shared-archi-m3b-probe-claude/` is outside the
    test HOME (see `task-41-probe-report.md`).
- **m3b:**
  1. `ssh archi-m3b@100.117.42.24 'sh -s' < $G/teardown-remote-user.sh`;
  2. `ssh 100.117.42.24 'sh -s' < $G/teardown-remote-root.sh`: disables linger, runs terminate-user and
     `deluser --remove-home`, runs `rm -r` on what deluser leaves and on `/tmp/claude-1002` (a real Claude ran there),
     then `rmdir /Users/Shared /Users`;
  3. `… < $G/check-remote-gone.sh`;
  4. `$G/linus-diff.sh final` against the before-state.
