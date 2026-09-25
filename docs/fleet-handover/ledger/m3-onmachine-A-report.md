# M3 gate on-machine pass, Part A: provision, fixture, clean handovers both ways

Status: **DONE_WITH_CONCERNS**

The fleet was handed over four times on the real machines, two full round trips, all with the controller on the Mac:

| Run | Direction | Characters | Roots / files | Generation | Time |
| --- | --- | --- | --- | --- | --- |
| 06g | Mac → Linux | 12 ok | 10 / 275 | 1 | 11 s |
| 07a | Linux → Mac (`archi handover local`) | 12 ok | 10 / 276 | 2 | 12 s |
| 08b | Mac → Linux, detached helper + attach | 13 ok | 12 / 64,323 | 3 | 79 s |
| 08e | Linux → Mac, detached helper + attach | 14 ok | 14 / 64,369 | 4 | 110 s |

The core transaction held. Commit fenced the source every time: no revive, attach, run or second terminal, including after a daemon restart. The destination activated every character with its session. Git indexes, statuses, stashes, worktree lists and fsck matched once paths were moved. So did state, fleet.json, the file: tab, the context refs and the sidecars.

None of the four ran by supported paths alone, though. Three defects stop a first handover to a freshly added machine:

- nothing creates the destination's copy of the fleet;
- setup's own mission-control folder occupies a carried root, and `--archive` cannot clear that preflight blocker;
- any macOS symlink with its default mode makes every Mac → Linux transfer fail as `external_writer`.

They were bypassed with documented hand steps on archi-m3 and a `chmod -h 777` on the fixture's two links. The comparisons then found three silent-damage defects:

- a character under a path root declared through a symlink resumes a stale transcript after coming back to the Mac, and a turn is lost;
- a registered worktree no character uses is broken on the Mac after a round trip;
- the session stage of a handover aborted during Transfer is never removed.

Step 7 as written (controller on the gateway machine) was not run. The spec puts the controller on the Mac and has Linux never ssh into the Mac, and `host add` refuses a non-Linux machine. It would also need an ssh route into the owner's Mac, which is not authorised. The Linux → Mac legs ran as the spec's user story does: `archi handover local` from the Mac.

`$S` = `/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/458d4622-7488-4208-9faa-1ee5a901238b/scratchpad/m3-onmachine`. Every script and log named below is there, with scripts at the top level, `logs/`, `snaps/` and `bin/`. The shared environment is `W/m3-env.md`. Tokens never appear in any argv, log or file (step 9f).

## Step 1: read the reports: DONE

I read the M2 on-machine report, tasks 24–27, 28a and 28b, the 28/29 contract, the spec sections on identities, the authority, connections, the transfer model and the transaction, the M3 carried/residuals lists, and progress by grep. C2/F20 (real paths respelled into declared roots) and C9/F27 (connection-info reports fleetHome) were fixed before this pass, and both were confirmed here.

## Step 2: before-state on linus-vault: PASS

`ssh 100.117.42.24 'sh -s' < $S/baseline.sh` → `$S/baseline/linus-before.txt`, the full dump: serve status, `systemctl --user list-units --all`, `ss -ltnp`, users, linger, sshd, tools. `$S/linus-state.sh` → `baseline/linus-state-before.txt`, the stable subset for Part C.

- `tailscale serve status`: `https://linus-vault.prawn-turtle.ts.net (tailnet only)` / `|-- / proxy http://127.0.0.1:8787`.
- 8787 is held by `bun` (pid 1627). 47800 was free. Only `linus` lingered. `MaxSessions 10`.
- Tools: tmux 3.4, rsync 3.2.7, git 2.43.0.

At the end of Part A, `diff` of the stable subset shows only three changes: Ubuntu's own `update-notifier-release.service` going from activating to dead, `archi-m3` in linger/passwd, and archi-m3's `127.0.0.1:47800`. The serve mapping is unchanged.

## Step 3: build and install: PASS

```
$S/build.sh  (web, mobile, apps/desktop/mac/build.sh release; ghostty links to the main checkout, removed after)
  -> Archipelago.app, release 17a8a0c6; companion archipelago-companion-17a8a0c6-linux-x64.tar.gz (45,204,449 B, unsigned)
  git describe 17a8a0c6 before and after; worktree clean
$S/02-install.sh  -> archi version --json: release 17a8a0c6, protocol 10, stateSchema 7, transferSchema 1; no node on the Finder PATH
$S/03-mac-setup.sh  archi -p private setup --no-launchctl --allow-unsigned --release <app>/Contents/Resources/release
  -> current -> $TH/.local/share/archipelago/releases/17a8a0c6, hooks in $TH/.claude/settings.json, plist written, not loaded
```

Three adjustments were needed. All are test-harness constraints, not product findings:

- The temp HOME under `$S` failed: `tmux … tmux.sock (File name too long)`. Unix socket paths are capped at 104 bytes. The temp HOME is therefore `/private/tmp/claude-502/m3h`, a short real directory.
- The owner's live daemon holds 47800, so the temp fleet's `node.json` port is 47871.
- `setup` needs tmux and claude on PATH, so it ran with `$TH/.local/bin:/opt/homebrew/bin` added. Every later helper command ran with the Finder PATH.

The daemon was started as the plist would start it (`$S/mac-daemon-start.sh`).

## Step 4: archi-m3, host add, enable, doctor: PASS (one Minor)

```
(linus) $S/create-user.sh: adduser --disabled-password, ~/.ssh/authorized_keys = ~/.ssh/id_rsa.pub (SHA256:zGoxc1k…), loginctl enable-linger -> uid 1002, Linger=yes
(archi-m3) $S/stub-node.sh: ~/.bashrc starts with PATH=$HOME/.m3-no-node:$PATH (node/npm/npx/pnpm/corepack/tsx stubs exiting 127)
  -> command -v node = the stub, `node -v` exits 127; archi, claude, codex: none; no checkout anywhere
$S/04-host-add.sh   archi host add m3 --ssh archi-m3@100.117.42.24 --release <archive> --allow-unsigned --json </dev/null  (tty: not a tty)
  exit 1 after 12 s = result "actions" (claude and codex not installed, true at that moment); every other step ok:
  service ok "archipelago-archid@private.service … archipelago-gateway.service: loaded, active (running), enabled"; machine d16c91ae-…
$S/04b-enable-doctor.sh   archi host enable m3 --fleet private --json -> authority ok "m3 holds fleet 303bc216-… for 3e70bb14-… at generation 0",
  fleet.json names m3; result ready.   archi host doctor m3 --json -> exit 0 (tmux, claude, shims, gh warn; archid, systemd, gateway, linger, hooks, release ok)
```

The mocked claude was then put in archi-m3's `~/.local/bin`. m3's `system.info` reported `claude 2.1.260, adapter 1, loggedIn, hooks`, but `host doctor` still said `claude warn: not found on PATH` (defect 10).

## Step 5: fixture: PASS

- **Mocked agents.** `$S/bin/claude.mjs` is modelled on `packages/archid/test/fixtures/fake-claude.mjs`: it posts hooks straight to `$ARCHI_HOME/hooks.sock`. It writes Claude 2.1.260 records to `<config>/projects/<slug of the real cwd>/<id>.jsonl`. It answers `--version` and `auth status`. `--resume <id>` fails as the real CLI does when the transcript is not under the real cwd's slug.
- **Launching it.** A wrapper execs the bundled node on it, so `ps` shows `node …/claude.mjs` and the rest classifier reads it as `claude`.
- **The owner's real Claude.** The Mac's `/usr/local/bin/claude` links to the owner's real Claude. It was kept out by `$TH/.local/bin` coming first on the daemon PATH and in `$TH/.zprofile`/`.zshrc`. `ps` confirmed only `claude.mjs` agents ran.
- **Git** (`$S/05a-git-fixture.sh`). Three graphs, each with uncommitted edits, untracked files, a partly staged index and a stash:
  - `alpha` has a nested worktree `.wt/feat` inside its main checkout.
  - `beta` has sibling worktrees `beta-wt1` and `beta-wt2`, plus a registered `beta-unused` that no character uses, and a default-excluded `node_modules`.
  - `gamma` lives under `work` = `$TH/code`, a symlink to `/private/tmp/claude-502/m3w`: the root declared through a symlink. It has `extensions.worktreeConfig` with per-worktree config and a sibling `gamma-wt`.
- **Plain folders.** `notes`, `code/scratch`, `docs/deep/dir`. The matching `work` roots were added to the registry (`$S/05b-path-roots.sh`).
- **Characters** (`$S/05c-fleet-fixture.sh`, through the bundled helper). Twelve characters on two islands, each with one finished turn. Second terminals on `alpha-main` and `notes`, a `file:` browser tab, and an island file context ref. The scribe is off. One session has `subagents/` and `tool-results/` sidecars.
- **Snapshot.** `$S/bin/snap.mjs` records state, files, Git and sessions per side (`W/m3-env.md` lists what). `$S/bin/compare.mjs` maps paths through the roots and classifies each difference.

## Step 6: Mac → Linux, controller on the Mac: PASS only after workarounds

| Sub-step | Result |
| --- | --- |
| 6a first try | **FAIL**, defect 1 |
| 6b occupied home + `--archive` | **FAIL**, defects 3 and 4 |
| 6c symlink | **FAIL**, defect 2 (the abort itself PASS) |
| 6d handover | **PASS** |
| 6e compare | **PASS** (defects 7 and 8) |
| 6f source fenced | **PASS** |

**6a.** `$S/ho.sh 06a-first-try m3`:

```
6 × handover.retry {"phase":"begin","attempt":1..3,"error":"m3 answered with fleetId 47a74455-7dbc-46c0-8076-30d830cf4f72, not 303bc216-c655-4d55-94de-ef5b45c6066a"}
handover.result {"status":"interrupted","phase":"begin","error":"m3 answered with fleetId …","safe":[]}     (nothing begun; gateway g0 unchanged)
```

Hand steps D1–D3 (`$S/06b-remote-hand.sh`, as archi-m3) gave m3's private fleet home the Mac fleet's id and `gatewayMachineId` m3, moved `owner.json` aside and restarted the unit. The log then read: `owner.json is missing and a gateway holds this fleet, so this machine owns nothing …` → `took the gateway's record: 3e70bb14-… owns this fleet at generation 0`.

**6b.** Preflight gave `destination_occupied: /home/archi-m3/.archipelago/home already exists and no handover left it there` (root `r_ef6bb279ff6cc624`). This is setup's own mission-control folder, byte-identical to the Mac's. `$S/ho.sh 06d-mac-to-linux m3 --archive r_ef6bb279ff6cc624` returned the same blocker before Begin. Hand step D4: `mv ~/.archipelago/home ~/.archipelago/home.m3-archived-by-hand`.

**6c.** `$S/ho.sh 06f-mac-to-linux m3` went through begin → freeze → transfer, then:

```
handover.blocked {"phase":"transfer","blockers":[{"code":"external_writer","message":"the far copy /home/archi-m3/src/alpha kept changing through 3 passes (link-to-f1 -> pkg/f1.txt, .wt/feat/link-to-f1 -> pkg/f1.txt); close whatever writes there, then resume"}]}
handover.changed aborted; result blocked
```

Reproduced by hand with the bundled rsync 3.4.4 dry run (`-rlpt … --dry-run --checksum`) against the Linux copy: `.L...p..... link-to-f1 -> pkg/f1.txt`. The link is `lrwxr-xr-x` on the Mac and `lrwxrwxrwx` on Linux, where a link cannot be chmodded.

The abort was clean. The Mac was unfrozen at g0 and all 12 characters revived through `claude --resume`, status idle. m3 had only its `_keep` window. The gateway holds no transaction.

Workaround: `chmod -h 777` on the two links.

**6d.** `$S/ho.sh 06g-mac-to-linux m3` went begin → freeze → transfer → verify → prepare → ready → commit → activate → complete in 11 s, generation 1, 12/12 characters ok. Warnings: `env_file` (alpha/.env), `worktree_unused` (beta-unused).

**6e.** `compare s1-before-mac → s1-after-linux` gave 11 DIFF, 23 rewrite and 14 expected.

The rewrites are all Git links:

- `.wt/feat/.git`, `beta-wt*/.git` and `gamma-wt/.git`;
- `.git/worktrees/*/gitdir`;
- every checkout's rev-parse and worktree list;
- the islands.

Each matches once paths are moved.

The expected differences:

- `node_modules` not carried;
- `beta-unused` and its registration not carried;
- index stat bytes.

Git HEAD, status, stash, `ls-files -s`, refs, `extensions.worktreeConfig` and the per-worktree `m3.role` are equal, and fsck is clean. For all 12 characters these are equal after moving:

- name, cell, cwd (gamma/scratch respelled from `/private/tmp/claude-502/m3w/…` to `/home/archi-m3/code/…`, which confirms C2/F20);
- repo, second-terminal cwd, context, file: tab, session id and revive command.

Every character is live and idle on Linux. Each transcriptPath is at the destination slug, and the transcripts and sidecars match record for record. The mission-control folder and fleet.json are identical.

The DIFFs:

- 7 × git `config`: only the Mac's `system`-scope `credential.helper=osxkeychain`, which is machine-local. The repository config carried unchanged, including `core.ignorecase=true` and `core.precomposeunicode=true` (defect 8).
- `home:docs/deep` dir mode 755 → 775: an intermediate parent the destination created with Ubuntu's umask 002. It is not a carried root, so this is a note.
- 3 × session `record 1` for gamma-main, gamma-wt and scratch: record `cwd` stays `/private/tmp/claude-502/m3w/…` on Linux (defect 7).

**6f.** `$S/06i-mac-fenced.sh`:

- ownership: m3 at generation 1.
- tmux: `_keep` only; 0 mocked agents.
- `char.revive`, `char.second`, `term.attach` and `char.run` each gave `handover_committed "this fleet moved to another machine; 1ab9f668-… is committed"`.
- 0 characters with tmux ids.
- `archi status`: `archid on m3, which runs this fleet`.

After `kill` and restart of the Mac daemon: `starting read-only: d16c91ae-… owns this fleet at generation 1`, still no windows, and every call refused the same way.

## Step 7: Linux → Mac

**Controller on the gateway machine: NOT RUN.** The spec's Roles section says: "Controller — the Mac app or Mac `archi` CLI … does not require the Linux machine to SSH back into the Mac". `host add` refuses anything that is not Ubuntu (`packages/cli/src/controller/host.ts:119-131`). The local registry record's `archiBase` is the fleet home (`registry.ts:41`), not the release prefix. And an ssh route into the owner's Mac for archi-m3 is not authorised.

**Controller on the Mac (`archi handover local`), the spec's pull-back: PASS.** Work done on Linux first:

- a turn for alpha-main;
- an edit staged in beta;
- a new file in notes;
- a commit on gamma-wt.

`$S/ho.sh 07a-linux-to-mac local` completed in 12 s, generation 2, 12/12 ok.

`compare s2-before-linux → s2-after-mac` shows only three kinds of difference:

- destination-local leftovers (`node_modules`, `beta-unused`);
- the Mac's real-path spelling of gamma's Git links and cwd, which is the same folder;
- machine-local config scope.

The same compare against the original `s1-before-mac` shows exactly the Linux work: the beta staged blob, the gamma-wt commit (objects, ref, logs, COMMIT_EDITMSG), `notes/from-linux.txt`, and 2 records added to alpha-main's transcript. On top of that:

- **FAIL (defect 6):** `beta-unused` on the Mac lost its registration. `git worktree list` no longer shows it, and `git -C beta-unused status` gives `fatal: not a git repository`. Branch b3 survives.
- Files git wrote on Linux came back as 664.

The fence on m3 (`$S/linux-fenced.sh`):

- ownership: Mac at generation 2;
- `_keep` only;
- 0 agents;
- revive, second and attach all give `handover_committed`.

## Step 8: a second round trip, controller on the Mac: PASS, with one FAIL on the compare

The fixture was grown first (`$S/08a-grow.sh`): graph `delta`, whose main checkout no character uses, a 13th character `delta-wt`, and 64,000 files under `notes/bulk`.

Mac → Linux went through the app's path: `$S/hod.sh` (`--json --detach` → `{"event":"handover.detached","data":{"pid":55500}}`), then `$S/attach.sh` (`attach --json`, stdin held open). It replayed from preflight and ended complete in 79 s: generation 3, 13/13 ok. `compare s3-before-mac → s3-after-linux` gave only the known items: defect 7, the umask mode of an intermediate dir, and git's own rewrite of `delta-wt`'s index mode.

Work on Linux (`$S/08d-linux-work.sh`):

- turns for gamma-main and alpha-feat;
- a bare repository `~/src/zeta.git` with worktrees `zeta-main` (a new 14th character) and `zeta-b` (unused, with an untracked file).

The first `handover local` stopped at preflight with a correct blocker: `worktree_unused: /home/archi-m3/src/zeta-b: a worktree no character uses holds changes git status reports, which a handover back would leave without their registration; commit or stash them there`. After `git stash -u` there, the handover completed in 110 s: generation 4, 14/14 ok.

`compare s4-before-linux → s4-after-mac` shows the same kinds of known difference as step 7, plus the unused `zeta-b` not carried, plus:

```
DIFF char gamma-main (c_6ko33v) main transcriptPath: …/projects/-private-tmp-claude-502-m3w-gamma/4d66b75a-….jsonl, not …/projects/-private-tmp-claude-502-m3h-code-gamma/4d66b75a-….jsonl
DIFF session gamma-main/main: 4 records -> 2
```

This is **FAIL (defect 5)**. The carried transcript, with the Linux turn, was placed under the lexical cwd's slug. The resumed agent found the pre-handover transcript still under the real cwd's slug and continued from it. Activation reported ok. gamma-wt and scratch point at stale copies in the same way, but those had no Linux turns.

## Step 9: the carried Task 27 checklist

| Item | Result | Evidence |
| --- | --- | --- |
| a. connection-info → token → `-O forward` → WS | **PASS** | `$S/logs/09d-forward-path.log`, preflight to m3 with a kept character (then cleared): the master is `ssh -M -S …/m3a/archi-502/e13359fd40a4 -N … archi-m3@100.117.42.24`, started without `-L`. That master then held `LISTEN 127.0.0.1:60049`, added by `-O forward`. The helper had `TCP 127.0.0.1:60050->127.0.0.1:60049 ESTABLISHED`, its WS through the forward, beside `->127.0.0.1:47871` (the local daemon). The token's only source is `connection-info` over the master (`reach.ts` `openDaemon`) |
| b. claim/prepare over 8 MiB, in parts | **PASS** | `$S/logs/08b-sizes.txt`, `08e-sizes.txt`: source manifest 15,046,336 B; controller `manifest.json` 20,846,116 B and `landed.json` 19,773,158 B, so prepare carries about 40 MB. The daemon takes no single frame over 8 MiB, so these went as 4 MiB parts. Both directions completed, and the freeze answer (the whole manifest) came back in one message |
| c. rsync over the master: gitdir root; session staging at the reported fleet home | **PASS** | `$S/logs/08e-procs.txt`: `rsync … --delete --exclude-from=…/filters/r_ffded24eb576dce7.rules -e ssh -S '…/m3a/archi-502/e1c71f45b52d' -o BatchMode=yes -- -- archi-remote.invalid:/home/archi-m3/src/zeta.git/ $TH/src/zeta.git/` (bare repo, gitdir root, pull). `08b-procs.txt`: `… --mkpath --from0 --files-from=…/lists/s4.from0 … $TH/.claude/ archi-remote.invalid:/home/archi-m3/.archipelago/handover/sessions-cf921a90-…/4/`. Every rsync and every gateway op (`gateway owner 'commit' …`) rode the one master |
| d. route cache after `moved` | **PASS** | `$FH/controller/route.json` = `{"ownerMachineId":"3e70bb14-…","generation":4,"at":"2026-09-23T20:41:10.302Z"}`, the last Complete. After round 1, `archi status` resolved and reached m3 |
| e. `git_extension` on git 2.43 | **PASS** | gamma's `extensions.worktreeConfig` went both ways with its per-worktree config. `$S/09a-git-extension.sh`: a repository made with `git worktree add --relative-paths` (Mac git 2.55) blocked at preflight: `git_extension: …/epsilon/.git uses the Git extension relativeworktrees, which needs git 2.48.0 or newer, and the destination runs git 2.43.0`. The test character and repository were removed afterwards |
| f. no token under `<fleetHome>/controller/**` | **PASS** | `$S/09c-token-grep.sh`: both 48-char tokens, read into variables, gave 0 hits in the Mac `controller/` (events.ndjson, route.json, handover.log), 0 in archid.log, 0 in this pass's logs and snapshots, and 0 on m3 (`~/.archipelago/*.log`, `handover/**`). m3 has no `controller/`, because no controller ran there |

## Step 10: environment left running; `W/m3-env.md` written: DONE

The Mac owns the fleet at generation 4, and no transaction is open. `W/m3-env.md` has the paths, wrappers, fixture, ids, mocked agent, snapshot and compare usage, hand steps, before-state and processes.

Left running:

- **Mac:** the temp-HOME archid (pid 47638), its tmux server (pid 11339) with 14 character windows and 2 second terminals, and 14 mocked agents.
- **m3:** archi-m3's archid and gateway units, lingering.

No ssh master, helper or attach is left. On the Mac, `~/.ssh/known_hosts` md5 and the mtimes of `~/Library/LaunchAgents` and `/Applications/Archipelago.app` are unchanged. The owner's real `~/.archipelago*`, `~/.claude`, `~/.codex` and `~/.local/bin` were never opened.

## Defects

1. **Critical: a fleet cannot be handed to a freshly added machine; nothing creates the destination's copy of the fleet.**
   - Evidence: `host add` provisions a private fleet with its own id (`47a74455-…`), and `host enable` only seeds the gateway record and the Mac's fleet.json. `archi handover m3` then fails before Begin with `m3 answered with fleetId 47a74455-…, not 303bc216-…`. It is retried 3 times (6 `handover.retry` events) and ends `interrupted`, `safe: []`, with no remedy.
   - The M2 ruling said handover is the supported way a fleet becomes remote-owned, but handover needs a destination daemon already holding that fleet id.
   - Where: `packages/cli/src/controller/connection.ts:101` (the check), with no step in `addHost`/`enableHost` (`packages/cli/src/controller/host.ts:290-370`, `:587-599`).
   - Bypassed by hand steps D1–D3.

2. **Critical: a symlink with macOS's default mode blocks every Mac → Linux transfer of its root.**
   - Evidence: `rsync -rlpt` compares link permissions. A Mac link is 0755 and a Linux link is always 0777, so every verification dry run itemizes `.L...p..... link-to-f1 -> pkg/f1.txt`. `compare()` counts any itemized line as instability.
   - After 3 passes the result is `external_writer`, which blames "whatever writes there", and the handover aborts. Any repository with a committed symlink (a CLAUDE.md → AGENTS.md link, say) cannot move to Linux.
   - Reproduced with the bundled rsync 3.4.4.
   - Where: `packages/cli/src/controller/rsync.ts:125` (`BASE` `-rlpt`), `packages/cli/src/controller/transfer.ts:339-342`.
   - The abort was safe. Bypassed with `chmod -h 777` on the fixture's links.

3. **Important: `--archive <root>` cannot clear the preflight blocker it is offered for.**
   - Evidence: `destinationChecks` ignores `choices.archiveRoots`, so `destination_occupied`/`destination_diverged` stays in preflight, and `start` returns `blocked` before Begin. The archive itself only happens at claim, which is never reached. The interactive menu's Archive re-runs the same preflight.
   - Where: `packages/cli/src/controller/handover.ts:217-218` and `:236`.
   - `$S/logs/06d-mac-to-linux.ndjson`.

4. **Important: setup's own mission-control folder on a fresh destination occupies the carried `home.cwd` root.**
   - Evidence: `destination_occupied: /home/archi-m3/.archipelago/home already exists and no handover left it there`, although its content is byte-identical to the Mac's, since setup writes it on both machines.
   - Where: `packages/archid/src/setup.ts:156-161`, with the inventory carrying `home.cwd`.
   - With defect 3, a first handover's only way on is a hand `mv` (D4).

5. **Important: after a return to the Mac, a character whose cwd is under a path root declared through a symlink resumes a stale transcript, and turns made on the other machine are lost.**
   - Cause: the destination places the carried transcript under the slug of the lexical mapped cwd (`$TH/code/gamma`). Claude slugs the real path (`/private/tmp/claude-502/m3w/gamma`), which Task 22 read from the binary and the mock follows.
   - Evidence: the resumed gamma-main found its pre-handover transcript still at the real-path slug and continued from it: 2 records instead of the carried 4, including the Linux turn. Activation reported ok.
   - With no older copy, the resume fails instead (`No conversation found`, then the 60 s SessionStart timeout).
   - Where: `packages/archid/src/handover/sessions/claude.ts:137`. Task 22 recorded this limit, and no fix wave took it up.

6. **Important: a registered worktree no character uses is broken on the machine it lives on after a round trip.**
   - Evidence: the Mac's `beta-unused` lost `.git/worktrees/beta-unused` when the fleet came back. `git status` there gives `fatal: not a git repository`, and its per-worktree HEAD and index are gone. The branch survives.
   - The outbound `worktree_unused` warning says only that it is not registered on the destination. The dirty-worktree blocker admits "a handover back would leave [it] without [its] registration". A clean one is broken silently, against "Handover never silently deletes destination-only work".
   - Where: `packages/archid/src/handover/git-repair.ts:77-81`, which prunes every registration the manifest does not carry. The returning copy of `.git` also lacks it.

7. **Minor: carried transcripts keep the source's real-path `cwd` for sessions under a root declared through a symlink.**
   - Evidence: records on Linux still say `/private/tmp/claude-502/m3w/gamma`.
   - Cause: `sessionPathMap` pairs roots lexically, and an unmovable declared path field raises no issue.
   - Where: `packages/archid/src/handover/sessions/registry.ts:32-38`.

8. **Minor: `core.ignorecase=true` and `core.precomposeunicode=true` from the Mac travel unchanged to Linux's case-sensitive filesystem.**
   - Evidence: the git `config` comparison.
   - Cause: the importer never adapts filesystem-probed Git config.

9. **Minor: a handover aborted during Transfer leaves the destination's session stage behind.**
   - Evidence: `~/.archipelago/handover/sessions-36693f09-…`, with copies of all 12 transcripts, is still on m3 after two later handovers.
   - Cause: claim opens no destination journal, so `handover.abort` returns `{}` without removing the stage.
   - Where: `packages/archid/src/handover/destination.ts:516-518`.

10. **Minor: `host doctor` reports `claude warn: not found on PATH` while the daemon finds it.**
    - Evidence: m3's `system.info` reports claude 2.1.260, logged in, with hooks.
    - Cause: doctor asks the non-login ssh shell, whose PATH on stock Ubuntu lacks `~/.local/bin`. That is where Claude's installer puts `claude`, and it is on the unit's PATH.

11. **Minor: `host list` still shows m3 `gateway: no` after `host enable`.**
    - Where: `host.ts:355` writes `gateway: false`, and `enableHost` never sets it.

Notes, not defects:

- Folders the Linux importer creates follow Ubuntu's umask 002: an intermediate `docs/deep` is 775, as is `~/.archipelago/handover`.
- Git-written files carried back from Linux arrive as 664.
- `archi handover attach` with stdin at EOF ends at once, per the contract. Parts B and C must hold stdin open (`$S/attach.sh`).
- The source daemon's own gateway check is a separate `ssh -o BatchMode=yes` login per call (`archi gateway owner get`), outside the controller's master.
