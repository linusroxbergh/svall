# Task 39b: the manual acceptance on release artifacts, on the real machines

Status: **DONE_WITH_CONCERNS**.

Release `896fc01` was built from a `git archive` snapshot of `896fc015` and installed on both machines of the M3b
environment. The fleet was grown to fifteen characters on five islands and handed over 28 times. Every acceptance
item of the spec holds from the CLI, in both directions:

- 22 cells pulled the network, one in each reported phase;
- 6 cells killed the controller.

Two halves of the items need the app, and they are on the owner's by-eye list: the sheet rebuilt on relaunch, and the
same selection.

- **New defects, all Minor:**
  - F1: the archived copy's note is sent as an error and then overwritten.
  - F2: the destination caches its agent login for 60 s.
  - F3: a Retry that fails again drops the session.
- **Doc mismatches:** 4 (below).
- **D1 still holds:** 37c's stale `revive` on live terminals is still there on `896fc01`.

`$C` = `/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/89928d60-3853-43e3-b6cb-3e149e9baba0/scratchpad/t39b`
(scripts in `$C/` and `$C/bin/`, logs in `$C/logs/`, snapshots in `$C/snaps/`). `$G` is the gate's folder
(`W/m3b-env.md`, W = `docs/fleet-handover/ledger`).

Rules:
- The product was not changed beyond item 4.
- Work on linus-vault ran only as archi-m3b.
- The Mac side ran only under the test HOME, through the wrappers.
- The credential was never printed.
- No daemon token is in any log (`70-token-grep.log`: 0 hits for both tokens). `release-scan.mjs --secrets-only`
  passes over `$C/logs` (398 files) and `$C/snaps`.

| Item | Result |
| --- | --- |
| Build and scan | PASS: `896fc01`, three archives `ok` |
| Installs (Mac setup, `host upgrade m3b`) | PASS |
| Twelve (15) characters on five islands, both directions | PASS: g9 in 53 s and g10 in 33 s, 12/12 live terminals `ok` each way; compares clean but for D1 and the explicit archive |
| Working agents finish, or are interrupted | PASS both directions: finish M→L and L→M, interrupt L→M and M→L |
| Foreground shells block visibly | PASS both directions from the CLI (`shell_busy`); the sheet is by-eye item 5 |
| Same selected character and browser tab URLs | Tab URLs PASS (in the state, equal across every compare); selection and layout are by-eye item 1 |
| Linked worktree keeps branch, index and changes, and resumes its agent | PASS (compares, both directions) |
| Network pulled during each displayed phase gives the documented action | PASS: 22 cells, both directions; timings differ from the doc (M-a) |
| Controller killed before and after Commit, `status` names the action | PASS: 4 cells and 2 trials; the sheet on relaunch is by-eye items 2 and 3 |
| A failed destination agent login blocks before freeze | PASS both directions (F2) |
| A resume failure after Commit leaves one dormant, retryable character; the source stays fenced | PASS both directions (F3) |
| A destination file edited while inactive is never overwritten without archive approval | PASS both directions (F1) |
| Item 4: N1 docs, N2 messages | DONE: `7243b8dc`, `76524110` |
| Item 5: by-eye list | appended to `W/m3b-env.md` ("What to look at") |
| Item 6: environment left | Mac owns at g36, nothing open, no credential copy; `W/m3b-env.md` committed `c84b4562` |

## 1. Build and installs

**Build** (`$C/build.sh`, `logs/01-build.log`, 23:31:56–23:32:51Z on 2026-09-28).

- **The snapshot.** It was made with `git -C <worktree> archive 896fc015`. After `git init`, a fetch of `896fc015`
  from the main repository and `git reset --mixed`, `git status` was empty and `git describe` read `896fc01`.
- **Vendor caches.** The worktree's `vendor/ghostty-kit` (`332b2aef…-r1`, current), `vendor/node` and `vendor/rsync`
  were copied in. Also copied was `rsync-3.4.4.tar.gz` from 37c's snapshot: the controller has shipped rsync's source
  since `3bf64226`, and the worktree's cache lacks the tarball.
- **The release command.** `scripts/release-build.sh --version 896fc01 --url-base
  https://github.com/linusroxbergh/archipelago/releases/download/896fc01`, with `ARCHI_RELEASE_KEY` unset, so the
  release is unsigned. It carries protocol 17, stateSchema 8 and Node v24.21.0.

| Archive | Bytes | sha256 | Scan |
| --- | --- | --- | --- |
| `archipelago-companion-896fc01-linux-x64.tar.gz` | 46,226,695 | `49353a0742896d28…` | ok, 277 files |
| `archipelago-companion-896fc01-linux-arm64.tar.gz` | 45,907,324 | `0f2621831498dc0d…` | ok, 277 files |
| `archipelago-controller-896fc01-darwin-arm64.tar.gz` | 42,476,064 | `e8e5671c746ab009…` | ok, 281 files |

- **The scan.** It ran inside `release-build.sh` and once more by hand: exit 0, no hit.
- **The app.** It was built as 37c did, and its `Contents/Resources/release` replaced by the controller archive's tree.
  `diff -r` is empty and `codesign -v` valid, build `896fc01`.

**Mac install** (`$C/11-install.sh`, `logs/11-install.log`).
- The app went into `$TH/Applications`, and the companion into `$G/companion/`.
- `archi -p private setup --no-launchctl --allow-unsigned --release <app release>` exited 0, and `current` →
  `releases/896fc01`.
- `node.json`, the Codex hooks, the Claude settings and the plist are unchanged.
- The daemon restarted on `896fc01`: `system.info` reads 896fc01, protocol 17.

**m3b upgrade** (`$C/12-upgrade.sh`, `logs/12-upgrade.log`). The release's `archi host upgrade m3b --release <x64
companion> --allow-unsigned --json` ran:
- `release` ok (unsigned);
- `install` ok, "checked by its digests alone";
- `probe` ok: "m3b answers on release 896fc01";
- result `ready` in 11 s.

The units restarted onto `896fc01`: archid 2726068 → 667595, gateway 2726077 → 667604. m3b's mission-control home
tree is unchanged. `host doctor m3b` fails nothing: `release` ok, and warnings for tmux 3.4, path and gh.

## 2. The fleet grown

`$C/21-grow.sh`, `logs/21-grow.log`, made with the release's own `archi`:
- **Islands.** `m3b shells` `i_5j8cv0`, `m3b work` `i_9g5yfe` and `m3b fail` `i_l174sc`, beside `m3b repos` and
  `m3b dirs`: five, and mission control.
- **Characters.**
  - `shell` `c_m62lwt`: a plain shell with a second terminal, and browser tabs `file://$TH/work/shell/page.html` and
    `https://example.com/t39b?tab=2`.
  - `worker` `c_srvv73`: a new worker mock.
  - `failer` `c_5fssn9`: mocked.
- **The count.** 15 characters: 12 live terminals, 2 second terminals and the 3 dormant real Claudes. The brief says
  twelve; the fleet already had twelve on two islands, and the three new ones cover the shell, working-agent and
  resume-failure items.

The mocks (`$C/20-mocks.sh`), on both machines:
- The worker mock `$TH/.m3b-mock/w/claude` is the gate's mock with raw input. `work <s>` starts a turn whose tool
  command is `sleep <s>`. Escape ends it with Claude's "[Request interrupted by user]" record and no hook.
- `$TH/.m3b-mock/f/claude` prints "No conversation found with session ID: …" after 2.5 s and exits 1.
- The dispatchers route `work/worker/` to the worker mock, and a `--resume` in `work/failer/` to the failing one while
  `$TH/.m3b-mock/fail-resume` exists. The earlier dispatchers are kept as `.m3b-mock/claude-dispatch.before-39b`.

## 3. Acceptance, item by item

Generation runs 9 → 36, with no transaction open at the end.

### 3.1 Every character, both directions (`32-m2l.sh`, `42-l2m.sh`)

| Run | Direction | Result | Time | What it carried |
| --- | --- | --- | --- | --- |
| d1b | Mac → Linux | complete g9 | 53.3 s | 16 roots, 246 files, 1.11 MB, 15 sessions; 12/12 live terminals `ok`, 3 dormant real Claudes carried dormant |
| d2b | Linux → Mac | complete g10 | 33.1 s | 16 roots, 240 files, 15 sessions; 12/12 `ok` |

After d1b, on m3b (`logs/33-linux-after.log`):
- 14 windows run, with 10 mocks and 2 real Codex. Every agent was resumed with `--resume <its id>`.
- The shell's two terminals print the restart notice, in `work/shell` under bash.
- `archi status` routes to m3b and lists 6 islands and 15 characters.

After d2b, the Mac is the same (`logs/43-mac-after.log`).

The fenced side refuses `char.revive`, `term.attach` and `char.second` with `handover_committed`, both ways, and runs no
agent.

Compares:

| Compare | DIFF | What they are |
| --- | --- | --- |
| `d1-before-mac → d1-after-linux` | 12 | all D1, each live terminal's carried `revive` |
| `d2-before-linux → d2-after-mac` | 2 | the Mac's `work/failer.archived-…` folder and its file, which the explicit archive made (3.7) |
| `d1-before-mac → f2-after-mac` | 14 | D1 and the same archived folder. This spans all 28 handovers |

Every Git field is equal in every compare:
- HEAD, branch and `status --porcelain=v2`;
- the index and the stash;
- the worktree list, the refs, the config and `fsck`.

That holds for `src/alpha`, `src/alpha/.wt/feat`, `src/beta`, `src/beta-wt1` and `src/beta-wt2`. So do the docs, the
profiles and the browser tabs. The `rewrite` lines are beta-unused's registration (O6), as before.

### 3.2 Working agents finish, or are interrupted

| Run | Direction | Worker | Rest | Result |
| --- | --- | --- | --- | --- |
| d1b | M → L | `work 40`, no flag | the freeze row waited 36 s (+3.2 → +39.4 s) until the turn's Stop | carried idle; its transcript has "did: work 40" |
| d4 | L → M | `work 30`, no flag | waited 25 s (+1.9 → +27.3 s) | carried idle |
| d2b | L → M | `work 600`, `--interrupt-after 10s` | Escape at 10 s; at rest 11.4 s in; m3b's `sleep 600` gone | the transcript ends "[Request interrupted by user]"; resumed on the Mac (`(resumed)` in its pane) |
| d3 | M → L | `work 600`, `--interrupt-after 5s` | at rest 6.2 s in | resumed on m3b |

### 3.3 Foreground shells block visibly

| Run | Direction | Result |
| --- | --- | --- |
| d1a | M → L | `sleep 600` in shell: the result is `blocked` with `shell_busy c_m62lwt "shell's terminal is running sleep 600"`. The Mac is not frozen, its 12 windows run, the sleep still runs, and m3b's `handover/` is empty with only `_keep` in tmux |
| d2a | L → M | the same on m3b |

With `--terminate-shells`, d1b and d2b carried the shell. Its terminal on the other side printed "Archipelago restarted
this shell after a handover…", and no `sleep 600` is left on the source. How the sheet shows the blocker is by-eye
item 5.

### 3.4 Selected character and browser tab URLs

- **The URLs travel.** Shell's two tabs are in the state on each side after every move, and every compare is equal on
  `browser`.
- **The rest is the app's.** The selected character, the active tab and the layout belong to the app: by-eye item 1.

### 3.5 The network pulled during each displayed phase

How the link was pulled, without touching the owner's network, Tailscale or sshd:
- **The proxy.** `$C/shim/ssh` runs `/usr/bin/ssh` with `$C/bin/linkproxy.mjs` as its ProxyCommand. While
  `$C/link/down` exists, no byte crosses either way and no new connection opens. ssh's own timeouts then end the master
  after 45 s, and new connections after 10 s ("Connection timed out during banner exchange"), as on a pulled cable.
- **Who goes through it.** The controller had the shim on its PATH. The Mac daemon was restarted with it too
  (`$C/mac-daemon-restart.sh shim`), so its gateway calls were cut as well.
- **When the link came back.** It was restored 2 s after the controller exited. A connection whose ssh had gone by then
  was closed without its queued bytes.
- **Triggers.** A stream event (`event:handover.changed:<phase>[:ms]`), or the first ssh whose arguments hold a word
  (`'begin'`, `--server` for rsync, `'ready'`, `'commit'`). `ssh-hold:'commit'` runs the real Commit, keeps its answer,
  then pulls the link: the answer is lost.

Each cell: the run, the machines, `status` (text and `--json`), the recovery status allows, and the machines again
(`$C/cell.sh`; logs `logs/n*.log`, streams `logs/<label>.ndjson`, summary `logs/cells-summary.txt`).

| Cell | Dir | Pulled at | Run ended | Pull → exit | `status` then | Recovery |
| --- | --- | --- | --- | --- | --- | --- |
| n01 | L→M | Begin's ssh | interrupted@begin [resume, abort] | 107.2 s | none, "the gateway never began this handover; nothing moved", [abort] | abort → aborted |
| n04 | M→L | Begin's ssh | interrupted@begin [resume, abort] | 107.9 s | the same | abort → aborted |
| n02 | L→M | `changed freeze` | interrupted@freeze [resume, abort]; m3b frozen, 0 windows | 97.1 s | open [resume, abort] | abort → m3b reopened 14 windows |
| n05 | M→L | `changed freeze` | interrupted@freeze; the Mac never froze (its first call, the destination's `system.info`, hung) | 86.5 s | open [resume, abort] | abort → aborted |
| n03 | L→M | first rsync (`--server`) | interrupted@transfer (rsync 255) | 59.7 s | open [resume, abort] | resume → complete g18 |
| n06 | M→L | first rsync | interrupted@transfer | 59.3 s | open [resume, abort] | resume → complete g19 |
| n07 | L→M | `changed verify` | interrupted@ready (verify and prepare were local) | 97.0 s | open [resume, abort] | abort → aborted |
| n09 | M→L | `changed verify` | interrupted@prepare | 97.1 s | open [resume, abort] | abort → aborted |
| n08 | L→M | `changed prepare` +100 ms | interrupted@ready | 97.5 s | open [resume, abort] | resume → complete g20 |
| n10 | M→L | `changed prepare` +100 ms | interrupted@prepare (m3b had prepared; the answer was lost) | 97.8 s | open [resume, abort] | resume → complete g21 |
| n11 | L→M | Ready's ssh | interrupted@ready | 96.9 s | open [resume, abort] | abort → aborted |
| n14 | M→L | Ready's ssh | interrupted@ready | 97.2 s | open [resume, abort] | abort → aborted |
| n12 | L→M | Commit's ssh (request lost) | interrupted@commit, `safe: []`, "whether … committed is unknown; resume asks the gateway again" | 107.1 s | open (ready-to-commit) [resume, abort] | abort → aborted |
| n15 | M→L | Commit's ssh (request lost) | the same | 107.4 s | the same | abort → aborted |
| n13b | L→M | Commit landed, answer lost | interrupted@commit, `safe: []` | 97.4 s | committed [resume] | `--abort` refused ("is committed … only its activation can go on", safe [resume]); resume → complete g24 |
| n16 | M→L | Commit landed, answer lost | the same | 97.7 s | committed [resume] | resume → complete g23 |
| n17b | L→M | `changed activate` +0 | interrupted@activate: "the gateway could not say who owns this fleet" | 47.5 s | committed [resume]. The Mac is frozen with 0 windows, m3b frozen with 0 windows: the documented "run nowhere for a while" | resume → complete g30 |
| n18 | M→L | `changed activate` +500 ms | interrupted@activate [resume]; m3b had activated 14 windows | 97.5 s | committed [resume] | resume → complete g25 |
| n17 | L→M | `changed activate` +500 ms | **complete** g26, `pending: [source, gateway]`; the Mac ran 14 windows | 144.3 s | committed [resume] | resume → complete (m3b and gateway closed) |
| n19 | L→M | `changed complete` | **complete** g28, `pending: [source, gateway]` | 140.7 s | committed [resume] | resume → complete |
| n20 | M→L | `changed complete` | interrupted@complete [resume] | 97.0 s | committed [resume] | resume → complete g27 |
| n13 | L→M | Commit landed, answer lost | see note | — | — | — |

- **Recovery worked every time.** After each recovery, the owner ran all 14 windows (10 mocks, 2 real Codex), and the
  other side ran none, with its journal empty. `status` read "none open anywhere".
- **Abort.** It reopened only the source's terminals, every time.
- **n13 is void as a timing.** The Mac entered Maintenance Sleep at 00:25:45Z, mid-cell, and woke at 00:42:17Z
  (`pmset -g log`). The guard restored the link on wake, the controller asked `owner get`, learned of the commit, and
  completed g22 by itself. That is a correct end, but not one the table measures, so it was rerun as n13b. A
  `caffeinate -dimsu` held the Mac awake from 00:42Z to the end of the run.
- **The results match `errors.md`'s phase table.**
  - Before the commit: Resume or Abort.
  - Commit: `safe: []` until the gateway answers, then what it says.
  - Activate: Resume only.
  - Complete: Resume finishes it.
  - After a pulled Begin, `status` narrows the offer to Abort alone, as the table's `none` standing describes.

### 3.6 The controller killed before and after Commit

Each cell ran `--detach`, followed the helper, and SIGKILLed it at the event (`KILL=event:…`).

| Cell | Dir | Killed at | `status` | Recovery |
| --- | --- | --- | --- | --- |
| k1b | M→L | transfer +0.3 s | "open, at transfer … Safe: `--resume` or `--abort`"; the Mac frozen, 0 windows | abort → the Mac reopened 14 windows |
| k3 | L→M | transfer +0.3 s | the same; m3b frozen | abort → aborted |
| k2 | M→L | activate +0.3 s | "committed, at activate … Safe: `--resume`"; m3b had activated 14 windows | resume → complete g17 |
| k4 | L→M | activate +0.3 s | committed [resume]; the Mac frozen with 0 windows until the resume | resume → complete g16 |
| trial | L→M | transfer (`$C/eye-kill.sh`) | open [resume, abort] | resume → complete g34 |
| trial | M→L | activate (`eye-kill.sh`) | committed [resume] | resume → complete g35 |

- **The ssh master stays.** A killed helper's master outlived it every time, as documented ("A controller killed
  outright … leaves its ssh connection open until the link drops"). The cell ended it.
- **Two clean runs from harness slips.**
  - The first k1/k3 attempts attached with stdin at EOF, which ends `attach` at once (M-c). The unattended helpers
    completed M→L g13 and L→M g14.
  - k1's second attempt did the same, giving g15.
  - Those are clean runs of the app's `--detach` path.
- **The sheet on relaunch** is by-eye items 2 and 3.

### 3.7 A destination file edited while inactive

| Run | Direction | Result |
| --- | --- | --- |
| d1a | M → L | m3b's replica `notes/f1.txt` was edited while the Mac owned the fleet. The run is `blocked`: `destination_diverged r_008f4a2b… "/Users/Shared/archi-m3b/notes changed while this machine did not own the fleet: 1 changed (f1.txt)…"`. m3b's file is unchanged after it (md5 `3684fde1…`) |
| d1b | M → L | With `--archive r_008f4a2b…`, the replica moved to `$TH/notes.archived-2026-09-28T234456Z`, holding the edit. The fresh `notes/f1.txt` equals the Mac's (`84f39294…`) |
| d2a, d2b | L → M | The same with the Mac's replica `work/failer/README.txt`: blocked, unchanged, then archived to `$TH/work/failer.archived-2026-09-28T234918Z` with the edit. The fresh copy equals m3b's |

F1 is about how the sheet shows the archived copy.

### 3.8 A failed destination agent login blocks before freeze

| Run | Direction | Result |
| --- | --- | --- |
| d0 | M → L | m3b's `~/.codex/auth.json` moved aside, so `codex login status` reads "Not logged in". The run is `blocked` with `agent_logged_out "codex is not logged in on the destination"`. The Mac is not frozen, its 12 windows run, m3b's `handover/` is empty, and `status` reads none open |
| d2-login | L → M | The test HOME's `.codex/auth.json` on the Mac moved aside, and the run waited 65 s for the destination's cached probe (F2). The same blocker; m3b not frozen, 12 windows |

Both logins were restored and shown logged in, and neither file was printed.

### 3.9 A resume failure after Commit

| Run | Direction | Result |
| --- | --- | --- |
| d3 | M → L | With `.m3b-mock/fail-resume` on m3b: `complete` g11, 11 ok, and failer `ok: false`, "failer's terminal resumed claude session 456339f6-…, but claude exited back to its shell, so it is dormant again with that session; revive it to see". On m3b failer is dormant with `revive: claude --resume 456339f6-…` and its transcript. The Mac refuses `char.revive c_5fssn9` with `handover_committed` and runs no agent. `status`: none open |
| d4 | L → M | The same on the Mac: complete g12, failer dormant, m3b fenced. With the flag removed, `archi char revive c_5fssn9` brought it up at once on the same session (`(resumed)`) |

In d3 the first retry ran while the fault was still there, which is F3.

### 3.10 Beside the list

- **Keep on this machine.** It blocks: `character_pinned "worker is kept on this machine"` (`logs/85-pinned.log`).
- **The fenced copy refuses a change.** `~/.local/bin/archi --host local island create` on m3b was refused, but with
  `handover_committed`, not `not_owner` (M-d).
- **A real Claude resumed on both platforms from these artifacts** (`$C/60-real.sh`, `logs/60-real.log`,
  `60-real-answers.txt`).
  - real-claude (`cff60418-…`, code word OSPREY) answered "OSPREY T39B-MAC", then, after g31, "OSPREY T39B-LINUX" on
    m3b, then, after g32, "OSPREY T39B-MAC2".
  - It was one transcript under one session id, 76 → 94 records.
  - `f1-before-mac → f1-after-linux` and `→ f2-after-mac` show only D1 and the known archived folder.
- **Real Codex.** Both Codex characters resumed on each side in every handover.

## 4. Release gate

This run adds, on release artifacts and on both platforms:
- the real Claude and real Codex resumes above;
- 22 link cells and 6 kill cells on real machines, with the single-owner invariant visible in every "where it stopped"
  row: never windows on both sides.

It does not re-run:
- the fault-injection suite (37a's 18 fault runs, and the 36a/36b suites);
- the agent fixtures (`sessions.test.ts`);
- the live probe (Task 41);
- fresh provisioning on x86-64 and arm64 (37b).

m3b was upgraded, not freshly provisioned.

The published download and signature path still has not run end to end: no key, no published URLs.

## 5. Defects (not fixed; the product was not touched beyond item 4)

1. **F1, Minor: the archived copy's note does not stay on the sheet.**
   - The controller sends "what was there is kept at <path>" once, as the root row's `error`
     (`packages/cli/src/controller/handover.ts:573`).
   - The sheet shows an `error` row as a failure, marked × with `data-status="fail"`
     (`apps/desktop/web/src/HandoverSheet.tsx:75-76`).
   - The next event for that root replaces the row whole, since `withEntity` in `apps/desktop/web/src/handover.ts`
     keys rows on section, kind and id. That event is the transfer progress, 10 lines later in `logs/d1b-m2l.ndjson`
     (lines 35 → 45–47), and the note is gone. Once the copy starts, nothing on the sheet says where the replica went.
   - SMOKE §6 says a row says where it was kept.
   - Fix direction: a `notice`, kept across progress updates. By-eye item 7 confirms it on screen.
2. **F2, Minor: the destination's agent login is cached for 60 s.**
   - `agentProber` keeps a probe for 60 s (`packages/archid/src/handover/sessions/registry.ts`, `ttlMs = 60_000`).
   - Both blocked runs after a login was restored still reported `agent_logged_out`: d1a 24 s after m3b's, and d2a
     23 s after the Mac's. `errors.md` says to log in and try again.
   - The other way, a login lost within a minute of a probe would pass preflight and fail at resume, after the commit.
     That is inferred from the code, not reproduced.
   - Fix direction: probe afresh at preflight, or say "within a minute" in the docs.
3. **F3, Minor: a Retry that fails again drops the session.**
   - In d3 the first retry (`char.revive`, what the sheet's Retry calls) ran while the fault remained. The resume
     failed again.
   - failer was then left a live plain shell: no `agent`, no `revive`, no session in its state
     (`logs/51-failer-after-retry.json`).
   - A second `char.revive` does nothing, since the character is no longer dormant; so would the sheet's Retry. The
     session came back only by typing `claude --resume 456339f6-…` in its terminal.
   - Retrying after the fault is fixed works (d4).
   - Fix direction: lay a revived terminal dormant again, with its session, when its agent exits before its
     SessionStart, as activation does.
4. **D1 (37c, known), still on `896fc01`.** Each live terminal a handover opened keeps its carried `revive` until
   that archid restarts: 12 or 13 DIFF in each cross-machine compare. The Mac archid was restarted at the end, and no
   live terminal holds one now.

## 6. Doc mismatches

- **M-a: the give-up time** (`handover.md` "When a handover stops part way" and "Known limitations": "between 49 and
  108 seconds", "up to 108 seconds").
  - Before the commit, the measured range is 59–108 s: begin 107–108 s, transfer 59 s, the rest 86–98 s.
  - After it, 47.5–98 s: n17b was 47.5 s, under the stated floor.
  - A Complete toward the Mac ends as `complete` with `pending` only after 141–144 s (n17, n19), past the stated
    ceiling. It runs two rounds of three retries, one for the source and one for the gateway.
- **M-b: the login recheck** (`errors.md` `agent_logged_out`). "`claude auth login` or `codex login`" then try again: a
  retry within a minute still blocks (F2).
- **M-c: attach and stdin** (`handover.md` "From a terminal": "`archi handover attach` … follow the handover running in
  the background").
  - Without a terminal, `attach` forwards stdin to the helper and ends when stdin ends
    (`packages/cli/src/commands/handover.ts` `runAttach`, `rl.on('close', () => conn.close())`).
  - So `archi handover attach --json </dev/null`, as a script runs it, exits 0 at once, printing nothing, while the
    helper runs. Observed three times.
- **M-d: the fenced copy's refusal** (`handover.md` "Working on the other machine": "a change is refused with
  `not_owner`"; SMOKE §4 step 2 the same).
  - After a handover the fenced machine answers `handover_committed` ("this fleet moved to another machine; <tx> is
    committed"), because `assertOwner` prefers a committed transaction's code (`packages/archid/src/ownership/state.ts:91-93`).
    Every fence probe here got `handover_committed`.
  - Only a machine whose record names no committed handover answers `not_owner`.

Checked and found right:
- the phase table, the `status` standings and actions;
- `interrupted`'s `safe`, and `pending` on `complete`;
- "Resume only" after the commit;
- the refused abort;
- "a move to this Mac can run nowhere for a while" (n17b);
- the killed controller's surviving master;
- the restart notice text, "Retry it from the row";
- `destination_diverged` and the archive naming.

## 7. Item 4

| Commit | What it does |
| --- | --- |
| `7243b8dc` (N2) | Both home-mismatch messages now name `archi host enable`: `host doctor`'s home check (`packages/cli/src/controller/host.ts:450`) and the `home_mismatch` blocker (`packages/archid/src/handover/inventory.ts:196`). The four expectations (`host.test.ts` ×2, `inventory.test.ts`, `source.test.ts`) were changed first: RED 4 failed, GREEN 158 passed and 2 skipped; `pnpm typecheck` clean |
| `76524110` (N1) | `docs/remote-machines/handover.md` "A gateway set up again" gains the new-user-name case while the fleet ran there: add under a new name, `host enable`, `fleet recover --force-owner local`, then `host remove <old> --forget` |

## 8. By-eye list

It is in `W/m3b-env.md` under "What to look at (Task 39b's list)", with exact steps:
1. selection, active tab and layout after a round trip;
2. the sheet rebuilt after a pre-commit helper kill (`$C/eye-kill.sh transfer`);
3. the same after the commit (`eye-kill.sh activate`);
4. quitting the app mid-handover;
5. the foreground blocker on the sheet;
6. a working agent's Continue waiting and Interrupt and carry;
7. the archived row (F1);
8. failer's Retry (F3);
9. a real Tailscale disconnect and the re-attach (SMOKE §7 and §9), which the proxy cannot show.

## 9. Credential

- **Read.** `Claude Code-credentials` was read from the Mac keychain at 01:06:04Z: expiresAt 07:13:43Z, 367 minutes
  left.
- **Copied.** Straight into both test homes' `~/.claude/.credentials.json` (0600, 15,529 B, equal) by 01:06:05Z.
- **Used.** Real-Claude steps ran from 01:06:05Z to 01:07:23Z.
- **Rested.** real-claude was laid dormant with its session by closing its window while archid was down
  (`$C/66-real-claude-rest.sh`).
- **Deleted.** Both copies were gone at 01:07:59Z, and shown absent at 01:08:00Z (`logs/69-creds-delete.log`).
- **Checked since.** No `.credentials.json*` is on either machine now, and no real Claude runs.

## 10. End state

From `logs/90-end-state.log` and a re-check after the coordinator's resume.

- **Ownership.** The Mac owns at generation 36, not frozen, with no transaction at the gateway, the Mac or m3b.
  `handover status`: none open anywhere.
- **The Mac.**
  - archid 56652 runs `896fc01`, started by `$G/mac-daemon-start.sh` with the plist's PATH, no shim.
  - 15 windows: 12 live characters and 2 second terminals, plus `_keep`, with 10 mocks and 2 real Codex, all idle.
  - The three real Claudes are dormant. No live terminal holds a `revive`.
- **m3b.** Both units run `896fc01` (667595 and 667604). tmux holds `_keep` only.
- **Nothing is open or left.** No test app, ssh master, helper, link proxy, guard or `caffeinate` of this run. No
  `fail-resume` flag; both Codex logins in place. No credential copy.
- **Archived replicas left by 3.7.**
  - m3b `$TH/notes.archived-2026-09-28T234456Z`;
  - the Mac `$TH/work/failer.archived-2026-09-28T234918Z`.
- **The owner's files** are unchanged (stat only): `~/.ssh/known_hosts` (Sep 14, 7,796 B), `~/Library/LaunchAgents`
  (Sep 26), `/Applications/Archipelago.app` (Sep 28, `4067bfea`) and his preferences plist (Sep 28 13:19:04, 1,550 B).
- **The test app** (`logs/80-app-open.log`) opened as build `896fc01`, claimed `$TH/.archipelago/app.pid`, connected
  to 47871 with its helper, kept its WebKit data in `$TH/Library/WebKit`, and quit.
- **`W/m3b-env.md`** was updated and committed (`c84b4562`): release, generation 36, the fifteen characters and five
  islands, 39b's harness and mocks, the snapshots, "Left running", the by-eye list and the teardown note.

## Concerns

1. The link cells pulled ssh through a proxy, not the network: the controller's and the Mac daemon's ssh. What only a
   real disconnect shows is left to by-eye item 9: the app's own `archi connect`, Tailscale's own behaviour, and a
   TCP connection that survives an outage.
2. The Mac sleeps on its own (Maintenance Sleep) whenever no one holds it awake. A long run needs `caffeinate`; n13
   lost 16.5 minutes to it.
3. F3 and F2 each touch an acceptance item's edge. The item holds for the first retry after a fix and for a login fixed
   a minute earlier, but not in general.
4. 38b's fix rounds landed after `896fc015` (`2ef3851b` … `3915b6d2`). They change the file-count bounds, the preflight
   and terminal backpressure. The ruling says one round trip is re-run on the final build if they touch transfer or
   terminals, and they do.
