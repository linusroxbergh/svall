# M3 gate on-machine pass, Part A2: Part A again from scratch on the fixed build

Status: **DONE_WITH_CONCERNS**

Part A's environment was torn down on both machines, and the app and companion were rebuilt from `0248e2ac`. archi-m3 was recreated fresh. Part A's steps 4–9 then ran with no hand steps on product state: no fleet id edit, no owner.json move, no move of `~/.archipelago/home`, and no chmod on links. Every committed link stayed at macOS's 0755 when it left the Mac.

| Run | Direction | Characters | Roots / files | Generation | Time |
| --- | --- | --- | --- | --- | --- |
| 06b | Mac → Linux, first handover to the fresh machine, `--archive` of an occupied root | 12 ok | 10 / 274 | 1 | 11 s |
| 07b | Linux → Mac (`handover local`) | 12 ok | 10 / 277 | 2 | 14 s |
| 07h | Mac → Linux, aborted in Transfer on purpose (O9) | revived on the Mac | 10 / 284 | stays 2 | 11 s |
| 08b | Mac → Linux, detached helper + attach, `--archive` of the diverged root | 13 ok | 12 / 64,333 | 3 | 93 s |
| 08e | Linux → Mac, under watch-forward | 14 ok | 14 / 64,373 | 4 | 102 s |
| 08k | Mac → Linux (extra trip, O6 on Linux git) | 14 ok | 14 / 64,373 | 5 | 101 s |
| 08l | Linux → Mac | 14 ok | 14 / 64,373 | 6 | 107 s |

All eleven O-items are proven on the machines. One carries a caveat:

- **O2.** Mac → Linux now passes with 0755 links, twice. But every Linux → Mac return leaves the Mac's links at 0777, so "the links stay at the Mac's mode" does not hold after a round trip (defect 2, Minor).

The run found two new Minor defects:

- the O9 abort leaves a file on the far side that blocks the next handover (defect 1);
- the link mode noted above (defect 2).

It also confirmed a known deferred Minor on the machines (defect 3). Nothing blocks Parts B and C.

The one DIFF left in every clean snapshot comparison is a note, as in Part A: the intermediate `docs/deep` directory's mode, which Ubuntu's umask sets.

`$S` = `/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/458d4622-7488-4208-9faa-1ee5a901238b/scratchpad/m3-onmachine-a2`. Every script and log named below is there. No token appears in any argv, log or file (9f).

## O-items

| Item | Result | Evidence |
| --- | --- | --- |
| O1: the first handover to the fresh machine works after `host enable` | **PASS** | `host enable m3 --fleet private` → `m3's unused fleet in /home/archi-m3/.archipelago is now this fleet, under archipelago-archid@private.service`. m3's log shows the re-key: `owner.json is missing and a gateway holds this fleet …` → `took the gateway's record: 85df863e-… owns this fleet at generation 0`. The first handover then had no fleet-id error. Its only blocker was the root I occupied on purpose. It completed at generation 1 (06b). A second `host enable` converged: `m3 already holds this fleet`, the same MainPID, and fleet.json, node.json and tmux.conf byte-identical (`logs/09g-enable-again.log`) |
| O2: links stay at the Mac's mode | **PASS on the transfer; FAIL on mode after a return (Minor)** | alpha's `link-to-f1` (×2) and delta's `link-to-d` (×2) were all `lrwxr-xr-x` when they left: 06b, 07h and 08b ran with no `external_writer` from them. On Linux they are `lrwxrwxrwx`. After 07b and 08e the Mac's links are `lrwxrwxrwx` too (`logs/07e-mac-checks.log`, `logs/08h-mac-checks.log`). Defect 2 |
| O3: `--archive` clears its blocker | **PASS** | I made `~/notes/occupied-by-m3.txt` on m3. `handover m3` then blocked with only `destination_occupied /home/archi-m3/notes … (r_20e6fd792c91f173)` (06a2). With `--archive r_20e6fd792c91f173`, preflight showed a warning `… is archived when the handover claims it`, and the run completed. `~/notes.archived-2026-09-23T224005Z` holds the file. The diverged variant passed in 08b too |
| O4: setup's home is adopted | **PASS** | Preflight named no blocker for `/home/archi-m3/.archipelago/home`, which host add's setup had written. After 06b, m3's replica record for it is `sealed`, generation 1, with a baseline of 6 files. No `home.*` sibling exists (`logs/06c-replicas-linux.log`) |
| O5/O7: the symlinked-root character resumes every turn after the round trip, and records carry the destination path | **PASS** | gamma-main, gamma-wt and scratch each took a turn on the Mac, then on Linux. After 07b each transcript sat at the Mac's real-path slug (`-private-tmp-claude-502-m3w2-gamma/…`) with 4 records, and no other copy remained. The resumed agents (`claude.mjs --resume <id>`) then appended a Mac turn: 6 records. After round 2 gamma-main has 10 records in order: Mac, Linux, Mac, Linux, Mac. On Linux every record's cwd is `/home/archi-m3/code/gamma`; on the Mac every one is `/private/tmp/claude-502/m3w2/gamma`. No session DIFF appeared in any compare |
| O6: the unused worktree's `git status` works on its own machine after the round trip | **PASS** | Mac `beta-unused`: `git status` exits 0 and `worktree list` names it after 07b, 08e and 08l. Linux `zeta-b`, made on m3: after Linux → Mac → Linux (08e, 08k), `~/src/zeta.git/worktrees/zeta-b` is still there, status and its stash are intact, and fsck is clean (`logs/08k-m3-zeta-b.log`) |
| O8: core.ignorecase/precomposeunicode on Linux | **PASS** | On Linux, alpha, beta and gamma are `false`/`false`; the Mac's copies stay `true`/`true`. Every other config byte matched in every compare. Going Linux → Mac, the bare `zeta.git` gained `ignorecase = true` and `precomposeunicode = true`, as git init on the Mac would write |
| O9: no `handover/sessions-<tx>` after an abort during Transfer | **PASS** | In 07h, the stage `sessions-c1b260a9-…` was in m3's `~/.archipelago/handover/` in 15 of the 0.3 s samples during Transfer. After `handover.changed aborted`, the folder is empty. The Mac was unfrozen at generation 2 and all 12 characters revived |
| O10: doctor finds claude | **PASS** | `host doctor m3` → `claude ok "2.1.260 (Claude Code)"`, while the non-login shell still finds no `claude` |
| O11: `host list` shows gateway yes | **PASS** | `host list --json` → m3 `"gateway": "yes"` |

## Step 1: read: DONE

I read `W/m3-env.md`, Part A's report, the fix brief and its report (including rounds 1–2), and the brief's Part A and A2 sections. I also read the code paths the checks touch: `enableHost`/`provisionCopy`, `agentChecks`, `ReplicaStore.assess`, preflight's path-root probe, and the cancel and attach controls.

## Step 2: tear down Part A's environment: PASS

Mac (`teardown-mac.sh`, `logs/02-teardown-mac.log`):

- Killed archid 47638, then `tmux kill-server` (which took the 14 agents), then any leftover master or helper (there were none).
- Checked that no `m3h`/`m3a`/`m3w` process remained.
- Removed `/private/tmp/claude-502/m3h`, `/private/tmp/claude-502/m3w` and the link `/private/tmp/claude-502/m3a`.

linus-vault (`logs/02-teardown-remote.log`):

- As archi-m3: stopped and disabled `archipelago-archid@private.service` and `archipelago-gateway.service`, and ran `tmux kill-server`.
- As linus: `loginctl disable-linger archi-m3`, `terminate-user` (0 processes after 1 s), then `deluser --remove-home archi-m3` (exit 0).
- As in M2, deluser left `/home/archi-m3/.archipelago/tmux.sock`. I removed the leftover `/home/archi-m3` with `sudo rm -r`.
- `check-remote-gone.sh` then showed:
  - no user or group, and `users` back to `linus,ofm`;
  - no `/home/archi-m3` and no `/run/user/1002`;
  - only `linus` in the linger directory;
  - 0 uid-1002 processes, and 0 uid-1002 files in /tmp, /var/tmp, /run or /var/spool;
  - nothing on 47800.
- `diff` of the stable subset against Part A's before-state: only Ubuntu's own `update-notifier-release.service` (activating → dead).

## Step 3: rebuild and recreate: PASS

- `build.sh` at `0248e2ac` built the app and `archipelago-companion-0248e2ac-linux-x64.tar.gz` (45,212,768 B, sha256 `465a31ff…6983e23`). The worktree was clean before and after.
- `02-install.sh` put the app in `$TH/Applications`. `archi version --json` gives release `0248e2ac`, protocol 10, stateSchema 7. There is no node on the Finder PATH.
- The new temp HOME is `/private/tmp/claude-502/m3h2`; the work root's target is `m3w2`; the TMPDIR link is `m3b`.
- `03b-fake-claude.sh` set up the mocked claude. `03-mac-setup.sh` ran `archi -p private setup --no-launchctl --allow-unsigned --release …`. Setup wrote the plist without loading it.
- Harness only: `03c-port.sh` set node.json's port to 47871, because the owner's live daemon holds 47800. The daemon was started as its plist would start it (`mac-daemon-start.sh`).
- `create-user.sh` (as linus) recreated archi-m3 exactly as authorised:
  - `adduser --disabled-password`;
  - `~/.ssh/authorized_keys` = `~/.ssh/id_rsa.pub`, which is the first key `ssh -G` offers, and its md5 matches;
  - `loginctl enable-linger`;
  - result: uid 1002, `Linger=yes`.

## Step 4 (Part A 4): archi-m3, host add, enable, doctor: PASS

```
(archi-m3) stub-node.sh; 04a-path-check.sh -> command -v node = ~/.m3-no-node/node, `node -v` exits 127 (login and non-login);
           pnpm/npm/tsx: stubs; archi, claude, codex: none; the home holds only skel files, .m3-no-node and snap
04-host-add.sh   archi host add m3 --ssh archi-m3@100.117.42.24 --release <archive> --allow-unsigned --json </dev/null  (tty: not a tty)
  exit 1 after 12 s, result "actions": claude and codex "not installed on this machine" (true then); every other step ok;
  service "archipelago-archid@private.service: loaded, active (running), enabled; archipelago-gateway.service: …"; machine 9af1ccb4-…
04c-remote-fake-claude.sh  the mocked claude in ~/.local/bin (run by the release's bundled node); non-login `command -v claude` = none
04b-enable-doctor.sh  archi host enable m3 --fleet private --json -> authority ok "m3 holds fleet d86e3f1a-… for 85df863e-… at generation 0";
  fleet ok "m3's unused fleet in /home/archi-m3/.archipelago is now this fleet, under archipelago-archid@private.service; … names m3 as the gateway"; result ready
  archi host doctor m3 --json -> exit 0: claude ok 2.1.260, archid, systemd, gateway, linger, hooks, release, space ok; tmux, shims, gh warn; codex skip
  archi host list --json -> m3 gateway "yes"
```

Before enable, m3's private fleet had its own id `a0a4e00f-…` and `owner.json` at generation 0 (`logs/04b-far-before-enable.log`). After enable it holds `d86e3f1a-…` with `gatewayMachineId` m3, the unit has restarted, and owner.json comes from the gateway's record (`logs/04b-far-after-enable.log`).

## Step 5 (Part A 5): fixture: PASS

- `05a-git-fixture.sh`, `05b-path-roots.sh`, `05c-fleet-fixture.sh` and `05d-sidecars.sh` build the same fixture as Part A: three graphs, twelve characters on two islands, second terminals, a `file:` tab and an island file ref, with the scribe off. The fixture has:
  - alpha, with a nested worktree `.wt/feat` and a committed link;
  - beta, with sibling worktrees and the unused registered `beta-unused`;
  - gamma under `work` = `$TH/code` → `/private/tmp/claude-502/m3w2`, with worktreeConfig. gamma is the repo whose root is declared through a symlink.
- The committed links were left at the Mac's default `lrwxr-xr-x`.
- The m3 `work` root folder `~/code` was made along with its registry entry. The spec leaves path roots to the user, and preflight would block `path_root_missing` without it (`controller/handover.ts:845`).
- One harness slip, fixed before the real run: my first sidecar record named no Claude version, and preflight correctly blocked it `incompatible_adapter … no record names the Claude Code release that wrote it` (`logs/06a-first-try.ndjson`). I rewrote the sidecar as a Claude-shaped record.
- `ps` showed 12 agents, every one `…/claude.mjs`. Snapshot: `s1-before-mac`.

## Step 6 (Part A 6): Mac → Linux, controller on the Mac: PASS

| Sub-step | Result |
| --- | --- |
| 6a first try | **PASS**: one blocker, the root I occupied |
| 6b handover with `--archive` | **PASS** |
| 6c compare | **PASS** |
| 6d source fenced, destination active | **PASS** |

**6a.** `ho.sh 06a2-first-try m3`:

- There was no fleet-id error, and no blocker for `~/.archipelago/home`.
- The only blocker was `destination_occupied /home/archi-m3/notes already exists and no handover left it there`.
- Warnings: `env_file` and `worktree_unused` (beta-unused).

**6b.** `ho.sh 06b-mac-to-linux m3 --archive r_20e6fd792c91f173`:

- It went begin → freeze → transfer → verify → prepare → ready → commit → activate → complete in 11 s.
- Generation 1, 12/12 ok. The 0755 links did not block.
- `~/notes.archived-2026-09-23T224005Z` holds the occupying file.

**6c.** `compare s1-before-mac → s1-after-linux` gave 1 DIFF, 23 rewrite and 24 expected:

- **The DIFF:** `home:docs/deep: dir mode 755 -> 775`, the intermediate parent (a note, as in Part A).
- **Rewrites:** the Git worktree links, rev-parse and worktree lists, and the islands.
- **Expected:**
  - O8's two config keys;
  - `beta-unused` not carried;
  - `node_modules` excluded;
  - index stat bytes.

All 12 characters match once paths are moved, and each is live. Every transcript is at the destination slug, and its records are equal once paths are moved. Unlike Part A, there is no record-cwd DIFF (O7).

**6d.**

- `06i-mac-fenced.sh`: ownership is m3 at generation 1, with only `_keep`. revive, second, attach and run all give `handover_committed`, and no Mac character holds tmux ids.
- After a kill and restart of the Mac daemon, its log reads `starting read-only: 9af1ccb4-… owns this fleet at generation 1`, and every call is refused the same way.
- m3: 12 `claude.mjs --resume <id>` processes and 15 windows (`_keep`, 12 characters, 2 second terminals).

## Step 7 (Part A 7): Linux → Mac

**Controller on the gateway machine: NOT RUN.** The fix brief ruled it an unsupported configuration: the spec's Roles section puts the controller on the Mac.

**`archi handover local` from the Mac: PASS.** Work done on Linux first (`07a-linux-work.sh`): turns for gamma-main, gamma-wt, scratch and alpha-main, a staged edit in beta, `notes/from-linux.txt`, and a commit on gamma-wt.

- `ho.sh 07b-linux-to-mac local` completed in 14 s: generation 2, 12/12 ok.
- `compare s2-before-linux → s2-after-mac`: 1 DIFF, the same dir-mode note.
- `compare s1-before-mac → s2-after-mac` shows exactly the Linux work: beta's staged blob and object, gamma-wt's commit (objects, ref, logs, COMMIT_EDITMSG), and `from-linux.txt`. On top of that come 664 modes on the files Git wrote on Linux (Ubuntu's umask), 2 records added to each of the four sessions, and no `beta-unused` difference (O6).
- The fence on m3 after the return: owner is the Mac at generation 2, only `_keep`, 0 agents, and revive, second and attach all give `handover_committed`.
- O5/O6/O7/O8 were checked here and on the Mac turn after the return (`07e`, `07f`); see the O-items table.

**O9 (`07h-abort-transfer.sh`): PASS.**

- A writer appended to `$TH/notes/churn.txt` every 50 ms. `handover m3` went begin → freeze → transfer. Then `handover.blocked external_writer "the source /private/tmp/claude-502/m3h2/notes kept changing through 3 passes (churn.txt)…"` and `handover.changed aborted`.
- The stage existed during Transfer and was gone afterwards.
- The Mac is back at generation 2, unfrozen, with 12 idle agents, and `handover status` shows none open.

## Step 8 (Part A 8): a second round trip, controller on the Mac: PASS

**Growing the fixture.** `08a-grow.sh` added:

- graph delta: the main checkout no character uses, plus a new committed link `link-to-d` at 0755;
- character delta-wt;
- 64,000 files in `notes/bulk`.

**Mac → Linux (the app's path).** `handover m3 --json --detach` → `{"event":"handover.detached","data":{"pid":50233}}`, then `attach.sh` followed the run.

- The first run blocked at preflight: `destination_diverged "/home/archi-m3/notes changed while this machine did not own the fleet: 1 changed (churn.txt) …"`. The file is what the aborted 07h transfer left there (defect 1).
- The second run added `--archive r_20e6fd792c91f173`. It completed in 93 s: generation 3, 13/13 ok. The new 0755 link did not block.
- `compare s3-before-mac → s3-after-linux`: 1 DIFF, the dir mode.

**Work on Linux** (`08d-linux-work.sh`):

- turns for gamma-main and alpha-feat;
- a bare `~/src/zeta.git` with worktrees `zeta-main` (a new 14th character) and `zeta-b` (unused, with an untracked file).

**Linux → Mac (`08e-linux-to-mac.sh`, under watch-forward).**

- The first run blocked on `worktree_unused "/home/archi-m3/src/zeta-b: a worktree no character uses holds changes git status reports, which a handover back would leave without their registration; commit or stash them there, or remove the worktree"`. This text is no longer true (defect 3).
- After `git stash push -u` in zeta-b, the action the blocker names, the run completed in 102 s: generation 4, 14/14 ok.
- `compare s4-before-linux → s4-after-mac`: 1 DIFF, the dir mode. zeta-b not being carried counts as expected.
- gamma-main's transcript: 8 records, then 10 after a Mac turn.
- The fence on m3: generation 4, only `_keep`, 0 agents, and every call gives `handover_committed`.

**Extra trip, O6 on Linux git** (08k Mac → Linux, 101 s, generation 5, 14/14; then 08l Linux → Mac, 107 s, generation 6, 14/14):

- m3's `zeta-b` kept its registration against the incoming Mac copy of `zeta.git`, which lacked it, and `git status` and its stash work.
- Both compares: 1 DIFF, the dir mode.

## Step 9 (Part A 9): the carried Task 27 checklist

| Item | Result | Evidence |
| --- | --- | --- |
| a. connection-info → token → `-O forward` → WS | **PASS** | `logs/08e-linux-to-mac-forward.log` shows the master `ssh -M -S …/m3b/archi-502/dd177a0ee008 -N … archi-m3@100.117.42.24`, started without `-L`. It then holds `LISTEN 127.0.0.1:50519`, and the helper (node 58525) has `127.0.0.1:50520->127.0.0.1:50519 ESTABLISHED` beside `->127.0.0.1:47871`, the local daemon. `connection-info --json` runs over the master (`logs/06b-procs.txt`) |
| b. claim/prepare over 8 MiB in parts | **PASS** | 08b: source `manifest-<tx>.json` 15,049,013 B; controller `manifest.json` 20,849,902 B and `landed.json` 19,775,809 B. 08e: 20,862,217 B and 19,785,665 B. The daemon's WS takes no frame over 8 MiB (`api/server.ts:30`), so prepare went in `PART_BYTES` (4 MiB) parts, and both directions completed |
| c. rsync over the master: gitdir root; session staging at the remote fleet home | **PASS** | 08e: `rsync … --delete --exclude-from=…/filters/r_ffded24eb576dce7.rules -e ssh -S '…/m3b/archi-502/dd177a0ee008' -o BatchMode=yes -- -- archi-remote.invalid:/home/archi-m3/src/zeta.git/ $TH/src/zeta.git/` (the bare repo pulled as a gitdir root). 06b: `--files-from=…/lists/s11.from0 -e ssh -S '…/04334d92daa4' … -- -- $TH/.claude/ archi-remote.invalid:/home/archi-m3/.archipelago/handover/sessions-312147c2-…/11/`. The gateway calls (`gateway owner 'begin'`/`'commit'`) went over the same master |
| d. route cache after `moved` | **PASS** | After 06b, `archi status` → `archid on m3, which runs this fleet`. `controller/route.json` = `{"ownerMachineId":"85df863e-…","generation":4,…}` after 08e, and generation 6 at the end |
| e. `git_extension` on git 2.43 | **PASS** | gamma's `extensions.worktreeconfig` and its per-worktree `m3.role` went both ways. `09a-git-extension.sh` blocked with `git_extension: …/epsilon/.git uses the Git extension relativeworktrees, which needs git 2.48.0 or newer, and the destination runs git 2.43.0`; its character and repository were removed afterwards |
| f. no token under `<fleetHome>/controller/**` | **PASS** | `09c-token-grep.sh`: both 48-char tokens, read into variables, gave 0 hits in the Mac `controller/` (events.ndjson, route.json, handover.log), 0 in archid.log, 0 in this pass's logs and snapshots, and 0 on m3 (`~/.archipelago/*.log`, `handover/**`). m3 has no `controller/` |

## Step 10: environment left running; `W/m3-env.md` rewritten: DONE

The Mac owns the fleet at generation 6, and no transaction is open anywhere.

- **Mac:** archid (pid 42680) and its tmux server (32701), with 14 character windows, 2 second terminals and 14 mocked agents.
- **m3:** archi-m3's archid (1703691) and gateway (1701156) units, lingering.
- No ssh master, helper or attach is left.
- linus-vault's stable diff against Part A's before-state is the same as at the end of Part A: update-notifier, archi-m3 in linger/passwd, and `127.0.0.1:47800`. The serve mapping is unchanged.
- The Mac's `~/.ssh/known_hosts` md5 and the mtimes of LaunchAgents and `/Applications/Archipelago.app` are unchanged.

`W/m3-env.md` now describes the A2 environment for Parts B and C.

## Defects

1. **Minor: after an abort during Transfer caused by an external writer, the next handover to that machine is blocked, and only `--archive` gets past it.**
   - What happens: the aborted run's own copy of the file the writer kept changing is left on the destination.
   - Evidence: 07h aborted `external_writer` on `notes/churn.txt`. m3's `~/notes` kept `churn.txt` (686 B, 24 lines), and every root there was left `receiving` for the aborted tx `c1b260a9-…`. The next `handover m3` (08b, first run) blocked with `destination_diverged "/home/archi-m3/notes changed while this machine did not own the fleet: 1 changed (churn.txt). Recover the changes by hand, map the root elsewhere, or archive it to continue"`.
   - The message blames a change "while this machine did not own the fleet", but the change is the handover's own write.
   - The only way on is archiving the whole root. That is safe, and the named action works (08b completed), but it leaves `notes.archived-…` behind and re-sends the root in full.
   - Cause: for a record another transaction left `receiving`, `ReplicaStore.assess` accepts only `[baseline, incoming]` (`packages/archid/src/handover/replicas.ts:281-284`). The copy that landed is newer than the manifest's `incoming` version of that file, so it matches neither. Neither the abort nor the destination records what actually landed.

2. **Minor: a Linux → Mac return leaves the Mac's symlinks at 0777.**
   - Evidence: `src/alpha/link-to-f1`, `.wt/feat/link-to-f1`, `src/delta/link-to-d` and `src/delta-wt/link-to-d` were `lrwxr-xr-x` when made. They were `lrwxrwxrwx` after 07b and 08e.
   - Cause: rsync `-p` (`packages/cli/src/controller/rsync.ts:129`, `BASE` `-rlpt`) applies the Linux link's mode, and macOS honours `lchmod`.
   - No functional effect was seen: Git ignores link modes, and the next Mac → Linux move no longer itemizes them. It is still a metadata change on the owner's Mac that the brief's O2 check ("the links stay at the Mac's mode") does not allow.

3. **Minor (known, deferred in progress.md): the dirty-unused-worktree blocker says something O6 made untrue.**
   - Evidence: 08e (first run) blocked on `/home/archi-m3/src/zeta-b … which a handover back would leave without their registration`. After the stash, zeta-b's registration survived Linux → Mac → Linux on m3 (08k, `logs/08k-m3-zeta-b.log`).
   - Where: `packages/archid/src/handover/git-graph.ts:236`.

Notes, not defects:

- **The Mac's state spells a symlinked-root cwd two ways after a return.**
  - After 07b it held the real path (`/private/tmp/claude-502/m3w2/gamma`). After 08e it held the declared one (`$TH/code/gamma`).
  - Cause: the import writes the declared spelling. `fleet.ts:325-328` then follows the pane's real path only when it differs from the cached one. The daemon had restarted before 07b (6d) but not before 08e.
  - It is the same folder either way: the transcript sat at the real slug and resume worked both times.
- A repo born on Linux that makes a round trip through the Mac keeps explicit `core.ignorecase=false` and `core.precomposeunicode=false` lines (`zeta.git` on m3). That is equivalent to the keys being absent.
- As in Part A:
  - the intermediate `docs/deep` directory on m3 is 775 (umask 002);
  - Git-written files carried back from Linux arrive as 664;
  - `handover attach` needs stdin held open.
- `host add`'s own claude and codex probes still use the non-login shell (the deferred sibling of O10). This was not re-tested: claude was not installed when `host add` ran.
- Teardown: `deluser --remove-home` left `/home/archi-m3/.archipelago/tmux.sock` even after `tmux kill-server` (as in M2). The leftover home was removed with `sudo rm -r`.
