# M3b gate: on-machine pass

Status: **DONE_WITH_CONCERNS**. The fleet went Mac → Linux → Mac on release `32ee1745` (HEAD `32ee1745`):

- a real Claude session and two real Codex sessions resumed under their original ids on both sides and continued
  their conversations;
- the four entity docs were found on Linux by the same keys, through m3b's own API;
- `m3b-role` travelled, and alpha-feat's brief uses it on Linux;
- no pid travelled;
- a second archid refused "already running" on Linux and on the Mac, and left the running one untouched;
- against the original snapshot, the round trip differs only in what the pass did on purpose.

One new defect, G1 (Important): on the first handover to a machine whose Claude has never trusted the folder, the
real Claude resume stops at Claude's folder-trust prompt, and no SessionStart comes. The destination waited 60 s, then
left real-claude dormant (`ok:false`), and preflight gave no warning. Once the prompt was answered by hand, the session
resumed under its id and recalled the code word.

HEAD `32ee1745`. W = `docs/fleet-handover/ledger`. `$G` =
`/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/3739c9b8-51d0-4aa6-ac32-19bc0b56eee0/scratchpad/m3bg`.
It holds the scripts, taken from 40b's `…/t40s2` and adapted, and every log (`logs/`), snapshot (`snaps/`) and captured
manifest (`evidence/`) named below. `W/m3b-env.md` describes the environment as it stands now.

- No command carried a token. Both daemons' 48-character tokens appear in no log, snapshot or captured manifest, and
  in nothing under the Mac's `controller/` or m3b's logs (`logs/61-token-grep.log`).
- The Claude credential was never printed.
- The worktree was clean for the build (`git describe`: `ghostty-kit-140-g32ee1745`, not `-dirty`).
- `caffeinate -i` ran for the whole pass.

| Step | Result |
| --- | --- |
| 1a build of the app and the linux-x64 companion | PASS: release `32ee1745` |
| 1b install and setup on the Mac, daemon restart | PASS |
| 1c `archi host upgrade m3b` (R5) | PASS: `ready`, no rollback, `m3b answers on release 32ee1745` |
| 1d m3b's mission-control home is untouched (R6) | PASS: tree byte- and mtime-identical, and the first handover needed no `--archive` for `home` |
| 2 fixture additions and snapshot | PASS, after two harness repairs (Notes 1–2) |
| 3a Mac → Linux | PASS after the expected `--archive` of `agent-profiles`; real-claude came up dormant (G1) |
| 3b the real Claude session on Linux | PASS once the trust prompt was answered by hand: same id, `OSPREY GATE-LINUX`, one transcript |
| 3c the real Codex sessions, docs, `m3b-role`, pids, fences, notes, compare | PASS |
| 4 a second archid on Linux and on the Mac | PASS on both |
| 5 Linux → Mac (`handover local`) | PASS: 10/10 `ok`, real-claude included; the original snapshot differs only in notes' revive |
| 6 environment left running, `W/m3b-env.md` updated with the way to open the test app | DONE |

## Step 1: rebuild, install, upgrade, restart

**1a Build: PASS** (`build.sh`, `logs/01-build.log`).
- Release `32ee1745`: protocol 17, stateSchema 8, transferSchema 1, Node v24.21.0.
- Companion `archipelago-companion-32ee1745-linux-x64.tar.gz`, 46,180,668 B, sha256 `c933273ea030d397…`.
- GhosttyKit was the prebuilt `…-r1`. Its link was put back.

**1b Install, setup, restart: PASS** (`11a-install-setup.sh`, `logs/11a-install-setup.log`, `logs/11c-mac-restart.log`).
- `current` → `releases/32ee1745`; node.json kept on 47871.
- Codex `hooks.json` and Claude `settings.json` are byte-identical before and after.
- The restarted archid reports `system.info` release `32ee1745`. The fleet was unchanged: 11 windows, 8 mocks and 2
  Codex, and `agent-profiles` holds the six bundled files plus `m3b-role.md`.

**1c `archi host upgrade m3b --release <companion> --allow-unsigned --json`: PASS** (`11b-upgrade.sh`,
`logs/11b-upgrade.log`).

```
{"step":"install","status":"ok","detail":"! path  /Users/Shared/archi-m3b/.local/bin is not on PATH, …"}
{"step":"probe","status":"ok","detail":"m3b answers on release 32ee1745"}
{"result":"ready","actions":[]}
upgrade exit 0 after 9s
```

- Both units restarted once onto `releases/32ee1745` (archid 2563672 → 3707968, gateway 2562286 → 3707977). m3b
  logged one `starting read-only … at generation 2`.
- `host doctor m3b`: `release ok "32ee1745, protocol 17; this controller runs 32ee1745, protocol 17"`, `home ok`.
- Caveat: `9be818f5` and `32ee1745` both speak protocol 17. So N1's cross-protocol path (an old client probing a new
  daemon) was not exercised on the machines. The fixed parts that did run are the ready result, the named release
  in the probe and the absence of a rollback.

**1d R6: PASS.** The mission-control home on m3b, `~/.archipelago/home`, was listed before and after the upgrade:
names, modes, mtimes and sizes of all 29 entries, and a hash of the bytes. The listing did not change (`diff exit 0`,
`logs/11b-home-before.txt`, `logs/11b-home-after.txt`). The Mac → Linux preflight then blocked on nothing for `home`.

## Step 2: fixture additions and snapshot

`20-fixture-mac.sh` (`logs/20-fixture-mac.log`), `21-remote-prep.sh` (`logs/21-remote-prep.log`) and the real-Claude
steps (`logs/23-creds.log`, `logs/24-real-claude-new.log`, `logs/24b-real-claude-restart.log`).

- **Real Claude binary and wrapper.**
  - The owner's `~/.local/share/claude/versions/2.1.283` was copied to `$TH/agents/claude-2.1.283`, sha256
    `d8cb1e5c…`, equal to the source. m3b already had `~/agents/claude-2.1.283`.
  - On each machine, `~/.local/bin/claude` sends the call to the real binary only when `$PWD` is under
    `real/claude-r/`, with `DISABLE_AUTOUPDATER=1`. Every other call goes to the mock, so both daemons' agent probes
    still see the mock's 2.1.260.
  - The real binary is reached through a link named `claude` (`agents/real-claude/claude`), as a real install reaches
    it (Note 1).
  - m3b's `~/.claude.json` got `hasCompletedOnboarding: true` first, so no interactive start could reach Claude's
    login step. That step emptied the copied credentials in M3 Part C. The Mac's already had it.
- **Credential** (as authorised). `security find-generic-password -s "Claude Code-credentials" -w` went straight into
  `$TH/.claude/.credentials.json`, then over ssh into archi-m3b's. Both copies were 0600 and equal. The access token
  expired at 23:32:41Z, and it was read at 19:36:12Z: **236 minutes left**.
  - All real-Claude steps ran from 19:36 to 19:43:56Z.
  - Neither copy changed during that time.
  - At 19:43:56Z both copies were deleted, and no real Claude process was left on either machine
    (`logs/56-real-claude-rest.log`).
- **real-claude** `c_ruypft`: cwd `$TH/real/claude-r`, island `m3b dirs`, made with `archi char new … --agent claude`.
  - Claude opened on its folder-trust prompt with **"No, exit" preselected**. No SessionStart came until it was
    answered: the state held `no agent`, and it had one only after the answer.
  - The prompt was answered by hand, then one turn: `Remember the code word OSPREY … Reply with exactly: OK` → `⏺ OK`.
  - Session `cff60418-f7bb-44cf-85ce-f9bb153978cd`, one transcript.
- **Entity docs through `docs.create`**:

  | Tier | Root id | Doc | Key |
  | --- | --- | --- | --- |
  | fleet | `r:$FH/docs/fleet` | `m3b-fleet.md` | FLEET-KESTREL |
  | island (m3b repos) | `r:$FH/docs/islands/i_k46lzs` | `m3b-island.md` | ISLAND-PLOVER |
  | character (beta-main) | `r:$FH/docs/characters/c_dy5zy3` | `m3b-character.md` | CHARACTER-WREN |
  | repo (beta) | `r:$FH/docs/repos/beta-d3942f1e` | `m3b-repo.md` | REPO-HERON |

  - `bin/docs.mjs read` finds each one as a Resources row (`resources.get`) and reads it with `fs.read` by that row's
    root id and path.
  - beta-main's `char.show` brief lists all four tiers.
- **beta-unused**: `git worktree add $TH/src/beta-unused -b unused-br`, with an edit and an untracked file stashed as
  `beta-unused stash`. The stash is now `stash@{0}` of the beta graph, and the worktree is clean.
- **alpha-feat** keeps `agentProfile: m3b-role`. **notes** was made dormant with its session (Note 2).
- Snapshot `s4-before-mac` (`snaps/`, spec extended with `.archipelago/docs` and `src/beta-unused`). It shows exactly
  these additions against 40b's `s3-after-mac` (`logs/cmp-s3-after-mac--s4-before-mac.txt`).

## Step 3: Mac → Linux

**`ho.sh 32-mac-to-linux m3b`: blocked, as expected** (`logs/32-mac-to-linux.ndjson`). The only blocker was:

```
destination_occupied "/Users/Shared/archi-m3b/.archipelago/agent-profiles already exists and no handover left it there"
(root r_c749c5ef5d50be07)
```

- It was not blocked on `home` (R6).
- Warnings: `env_file` for alpha, and `worktree_unused` (`… not registered on the destination, though their branches
  travel: /Users/Shared/archi-m3b/src/beta-unused (on unused-br)`).
- There was no warning about Claude's folder trust (G1).
- The first try, `31-mac-to-linux`, also blocked `shell_busy` on real-claude. That was the harness (Note 1).

**`ho.sh 33-mac-to-linux m3b --archive r_c749c5ef5d50be07`: complete, generation 3, in 72 s**
(`logs/33-mac-to-linux.ndjson`).
- Preflight: 12 roots, 236 files, 479,302 B and 11 sessions.
- m3b's seeded folder is now `~/.archipelago/agent-profiles.archived-2026-09-26T193825Z`.
- Result: 8/8 live characters `ok`, and notes was carried dormant. The one failure:

```
{"id":"c_ruypft","ok":false,"error":"real-claude's terminal resumed claude session cff60418-…, which did not report its
SessionStart within 60 s, so it is dormant again with that session; it may have stopped at a prompt; revive it to see"}
```

**G1 on Linux** (`logs/33-linux-after.log`, `logs/35-real-claude-linux-revive.log`, `logs/35b-real-claude-linux-trust.log`).
- m3b's state kept real-claude dormant, with its `revive` and `resumeError`, and its window was gone.
- `char.revive` opened `claude --resume cff60418-…` on the folder-trust prompt, with "No, exit" preselected. m3b's
  `~/.claude.json` held no trust for `real/claude-r`.
- After Down and Enter:
  - SessionStart landed with the same id, `cff60418-…`, and m3b's pid 3762140;
  - the folder's trust was written to m3b's `.claude.json`.

**Real sessions on Linux: PASS** (`34-turns.sh linux GATE-LINUX`, `logs/34-linux-turns.log`). Each turn went through
the Mac's helper, which routes to m3b.

| Character | Answer | Session | Files on m3b |
| --- | --- | --- | --- |
| real-claude | `● OSPREY GATE-LINUX` | `cff60418-…` | one `.jsonl` named after it, 42 → 57 records, every record's `sessionId` `cff60418-…` |
| real-codex | `• MANGO-LINUX-MACGATE-LINUX` | `01a0ddbd-…` | one rollout, 47 → 61 records |
| real-codex-p | `• KIWI-LINUX-MACGATE-LINUX` | `01a0de47-…` | one rollout, 47 → 61 records |

**Docs on Linux: PASS** (`logs/33-linux-after.log`).
- `docs.mjs read`, run on m3b against m3b's own daemon, gave `FOUND` for all four tiers. The root ids and paths are
  the Mac's, and the content hashes and keys are equal.
- beta-main's brief on m3b lists the fleet, repo, island and character docs.

**Profile: PASS.** `~/.archipelago/agent-profiles/m3b-role.md` is on m3b, with md5 `87a423ab…` equal to the Mac's. On
m3b, alpha-feat's `char.show` opens with `Agent profile: m3b-role — follow this role.`

**No pid travelled: PASS** (`logs/38-carried-pids.log`).
- The controller's `manifest.json` and the source's `manifest-<tx>.json` were captured during the run. Neither holds a
  `pid` field.
- On m3b, every live mock's pid is a process on m3b with its own `--resume` argv. The Codex characters and dormant
  notes had no pid until their first hook.
- notes carried no pid, though its Mac pid 79544 was stale.

**Everything the second smoke checked: PASS** (`logs/33-linux-after.log`, `logs/36-notes-wake-linux.log`,
`logs/37-mac-fenced.log`).
- Ownership: m3b at generation 3. tmux 3.4 listed 11 windows. There is no `i_recovered` island, and state holds exactly
  the 10 characters.
- The argv on m3b:
  - mocks: `--resume <id> --add-dir …/notes`;
  - flags: `--effort high --dangerously-skip-permissions --resume 805751b2-…` (F3; `--model x` dropped);
  - real-codex: `codex resume -c tui.resume_cwd=session 01a0ddbd-…`;
  - real-codex-p: `… -m gpt-6-astra 01a0de47-…`.
- notes arrived dormant with `revive: claude --resume a238f2dd-…`, and its transcript arrived at the same path.
  `char.revive` woke it on m3b, and a turn took the transcript from 6 to 8 records.
- The Mac is fenced:
  - ownership names m3b at generation 3; the Mac has only `_keep`, 0 agents and 0 characters with tmux ids;
  - `char.revive`, `char.second`, `term.attach`, `char.run` and `docs.create` all answer `handover_committed`, for
    alpha-main, notes and real-claude;
  - `archi status` routes to m3b;
  - after an archid restart it logs `starting read-only: 51cf5316-… owns this fleet at generation 3` and still refuses.
- O6, this way (`logs/64-o6-linux.log`): m3b's copy of beta has no `worktrees/beta-unused`. `unused-br` is still there
  at `e3b68b38…`, and the stash has both entries. The worktree folder is not on m3b.

**Compare `s4-before-mac → s4-after-linux`: 1 DIFF, 3 rewrite, 25 expected**
(`logs/cmp-s4-before-mac--s4-after-linux.txt`).
- The DIFF is notes' `revive`: it was woken on Linux, as briefed.
- The three `rewrite` lines are the beta checkouts' `worktree list`. They are equal once beta-unused's registration,
  which is not carried, is dropped. No path was rewritten.
- Expected: O8's `core.ignorecase`/`precomposeunicode`, `node_modules`, beta-unused not carried, and records appended
  after each resume.
- `agent-profiles` and `docs` compare equal.

## Step 4: a second archid for the same fleet home

**Linux: PASS** (`40-lock-linux.sh`, `logs/40-lock-linux.log`). The unit was active (MainPID 3707968). The release's
`bin/archid` was started with the unit's own environment (`ARCHI_HOME`, `HOME`, `PATH`, `LANG`):

```
exit 1 after .145597318 s
archid.log: error archid failed to start: Error: archid is already running for /Users/Shared/archi-m3b/.archipelago
    at alreadyRunning (…/releases/32ee1745/lib/archid.mjs:48337:33)  at Server.<anonymous> … (abstract socket EADDRINUSE)
```

These were read before and after, and none changed:
- the unit's MainPID, and NRestarts 0;
- `state.json`, `fleet.json`, `owner.json`, `node.json`, `token`, `tmux.conf`, `port` and `tmux-binary` (inode, size,
  mtime, md5);
- `hooks.sock` (inode, mtime);
- the log's inode, with no `archid.log.1`;
- the 12 tmux windows;
- one abstract lock name and one archid process.

The only write is the refusal appended to the running daemon's log (m1).

**Mac: PASS** (`41-lock-mac.sh`, `logs/41-lock-mac.log`). The Mac archid was running as the read-only replica (pid
90578). A second one was started with the plist's environment. It exited 1 at once with the same line, this time
through `lockFile` (`O_EXLOCK` on `daemon.lock`). The same fingerprints, `daemon.lock` included, did not change.
Afterwards both daemons still answer `system.info`.

## Step 5: Linux → Mac (`archi handover local`)

**`ho.sh 50-linux-to-mac local`: complete, generation 4, in 20 s, 10/10 `ok`, real-claude included**
(`logs/50-linux-to-mac.ndjson`).
- The snapshot `s5-before-linux` was taken first. Against `s4-after-linux` it differs in nothing beyond beta-unused
  not being on m3b.
- Preflight: 12 roots, 230 files, 558,690 B and 11 sessions. The only warning was `env_file`.
- real-claude came back without the trust prompt: the Mac's `.claude.json` has trusted the folder since step 2.

**The same checks on the Mac: PASS** (`52-mac-after.sh`, `logs/52-mac-after.log`, `logs/53-mac-turns.log`,
`logs/54-linux-fenced.log`, `logs/55-carried-pids.log`).
- The Mac owns at generation 4. There are 12 windows, and every state pid is a Mac process with its own `--resume`
  argv. real-claude runs `…/agents/real-claude/claude --resume cff60418-…`.
- Turns on the Mac:
  - real-claude `⏺ OSPREY GATE-MAC`: one transcript, 66 records, one `sessionId`, prompts in order Mac, Linux, Mac;
  - real-codex `• MANGO-LINUX-MACGATE-LINUXGATE-MAC` and real-codex-p `• KIWI-…GATE-MAC`: one rollout each, 76 records;
  - notes: 10 records, with prompts from the Mac, Linux, Mac, Linux and Mac.
- Docs: all four are `FOUND` through the Mac's API by the same keys, with equal hashes. alpha-feat's brief opens with
  `m3b-role`.
- **O6, the other way:**
  - `beta-unused` is still registered on the Mac, and `git status` there reads `## unused-br` and is clean;
  - the stash holds both entries;
  - `unused-br` is at `e3b68b38…`;
  - `worktree list` shows beta, beta-unused, beta-wt1 and beta-wt2.
- F2: the captured controller manifest holds no `pid` field.
- m3b is fenced: ownership names the Mac at generation 4, only `_keep` runs, and revive, second, attach and run answer
  `handover_committed`. No character holds a tmux id, and `handover/` is empty.
- `handover status`: none open. No ssh master or helper is left.

**Compares** (`logs/cmp-s5-before-linux--s5-after-mac.txt`, `logs/cmp-s4-before-mac--s5-after-mac.txt`):
- `s5-before-linux → s5-after-mac`: 0 DIFF. The 3 `rewrite` lines are beta-unused's registration, kept on the Mac (O6).
- **`s4-before-mac → s5-after-mac` (the original): 1 DIFF, 0 rewrite, 4 expected.**
  - The DIFF is notes' revive: it was woken on Linux, so it came back live.
  - Every file, Git index, status, stash, worktree list and ref, doc and profile equals the original.
  - Sessions only grew: notes +4, each Codex +30 and real-claude +25 records.

## Step 6: environment left, `W/m3b-env.md`: DONE

- The Mac owns the fleet at generation 4, and no transaction is open.
  - Mac: archid pid 94582 on `32ee1745`, 11 windows, 8 mocks and 2 real Codex, all idle.
  - real-claude is dormant with its session: its window was closed while archid was down, so it kept `revive`.
- Both Claude credential copies are deleted. The by-eye pass does not need them. Reviving real-claude without them
  starts Claude logged out, and `W/m3b-env.md` says so.
- **Opening the test app**: `$G/open-test-app.sh` runs the app's binary with `CFFIXED_USER_HOME` and `HOME` set to the
  test HOME and every `ARCHI_*`/`TMUX*` variable removed. It was checked once (`logs/60-app-open.log`):
  - The test app, pid 97202, claimed `$TH/.archipelago/app.pid`.
  - Its helper ran with `HOME=/Users/Shared/archi-m3b`, and its page connected to the test daemon on 47871.
  - WebKit data went to `$TH/Library/WebKit`.
  - The owner's app (pid 11689) kept running.
  - The owner's `~/Library/Preferences/io.github.linusroxbergh.archipelago.plist` (mtime, size) and his WebKit store
    list are unchanged.
  - HOME alone is not enough: `NSHomeDirectory()` ignores it and follows only `CFFIXED_USER_HOME` (`nshome.swift`).
    With HOME alone, the app would open `~/.archipelago`, the owner's fleet.
- **Final checks:**
  - linus-vault's stable state against the 40b before-state still differs only in archi-m3 → archi-m3b, plus Ubuntu's
    snap loop devices (`logs/62-linus-diff.log`).
  - The serve mapping is unchanged.
  - The Mac's `~/.ssh/known_hosts` (md5 `1f403c13…`, Sep 14), `~/Library/LaunchAgents` (Sep 26 11:49:14) and
    `/Applications/Archipelago.app` (15:51:36, `3217f2c0`) are unchanged (`logs/63-owner-files.log`).
  - One read outside the test HOME: `~/.archipelago/app.pid` was read once to learn the owner's app pid. Nothing of
    his was written.
- `caffeinate` stopped.

## Defects

1. **G1, Important (new): a real Claude resume on a machine whose Claude has never trusted the folder stops at Claude's
   folder-trust prompt, and nothing says so before the handover.**
   - Claude Code 2.1.283 asks the question on `claude --resume <id>` too, with "No, exit" preselected. It sends no
     hook until the prompt is answered: on the Mac, real-claude had no agent in the state until then.
   - The Claude adapter has no `trusts`, which `types.ts` documents as "absent for one that never asks". So:
     - preflight gives no warning like `codex_trust`;
     - activation gives no "waits at its Trust this folder? prompt" notice;
     - the destination waits the full 60 s, then leaves the terminal dormant with `ok:false`.
   - Every real Claude character hits this on its first handover to a machine. The handover took 72 s against 20 s
     back.
   - The user then has to revive it and answer a prompt whose preselected choice quits Claude.
   - The session and its transcript are intact. The spec's "resume under their original session ids" holds only after
     that hand step.
   - Claude keeps the answer in `~/.claude.json` under `projects["<path>"].hasTrustDialogAccepted`, which the
     destination could read as `codex.ts` reads Codex's `trust_level`.
   - Suspected:
     - `packages/archid/src/handover/sessions/claude.ts:17-45` (no `trusts`);
     - `packages/archid/src/handover/sessions/types.ts:40-41`;
     - `packages/cli/src/controller/handover.ts:159-166` (`codexTrust` only);
     - `packages/archid/src/handover/destination.ts:576-580` (the notice needs `trusted()` false).
   - Evidence: `logs/24-real-claude-new.log`, `logs/33-mac-to-linux.ndjson` (the result row),
     `logs/35-real-claude-linux-revive.log` and `logs/35b-real-claude-linux-trust.log`.
2. **m1, Minor (new): a refused second archid writes a full stack trace into the running daemon's log as an `error`.**
   - `bin.ts:43` reports `e.stack` for every start failure, `alreadyRunning` included. That adds 6–10 lines per
     attempt to the log of the daemon that is running.
   - Under systemd's `Restart=always` it adds them every 2 s. Task 42's m2 names the case: another user holding the
     abstract name.
   - The one-line `e.message` would say it. Evidence: `logs/40-lock-linux.log`, `logs/41-lock-mac.log`.
3. **A2 defect 2, Minor (known, still open): a Linux → Mac return leaves the Mac's committed links at 0777.**
   `src/alpha/link-to-f1` and `.wt/feat/link-to-f1` are still `lrwxrwxrwx` (`logs/53-mac-turns.log`).

## Notes, not defects

1. **Harness: the real Claude must be reached through a link named `claude`.**
   - The first wrapper exec'd `agents/claude-2.1.283` by that name. The rest reads the agent from the process's argv,
     so the handover blocked with `shell_busy "real-claude's terminal is running …/agents/claude-2.1.283"`
     (`logs/31-mac-to-linux.ndjson`).
   - A real install runs Claude as `claude` through `~/.local/bin/claude` → `versions/<v>`. The wrappers now exec
     `agents/real-claude/claude`, a link to the copy.
   - real-claude was restarted under its session: `/exit`, then `claude --resume cff60418-…` typed into its shell,
     which is a user's own resume. The session id and transcript were unchanged.
2. **Harness: notes was made dormant by losing its window while archid was down.**
   - A first `tmux kill-window` with archid up let the mock's SessionEnd clear notes' session from the state.
   - notes was revived, and its session resumed by hand with `claude --resume a238f2dd-…`. The window was then killed
     while archid was stopped, so the restarted archid kept it dormant with its session and revive
     (`logs/22-notes-dormant.log`, `logs/22b-notes-dormant.log`).
   - The idle timer (`dormantAfterHours`, at least 1 h) was not used. real-claude was put to rest the same way at the
     end.
3. **Harness: the agent probes see the mock.** The dispatching wrapper runs the real Claude only in `real/claude-r`, so
   both daemons' version and login probes read the mock's 2.1.260 and its "logged in". The real binary's version and
   login were not what preflight checked.
4. **Not re-run:**
   - Codex's `-p` drop (F3): real-codex-p has run without `-p` since 40b's round trip.
   - The cross-protocol upgrade (N1), since both releases speak protocol 17.
5. **Claude's per-project `projects/<slug>/memory/` does not travel.** Only the session's own file and folder do.
   Here the folder was empty on both sides, so nothing was lost, and the spec does not name it. A Claude that wrote
   project memories on one machine would not have them on the other.
6. **Fence probe quoting.** `mac-fenced.sh`'s `char.run` line mis-quoted its params under `sh`. It was re-probed
   directly, and all three answered `handover_committed`. The script is fixed.
7. **Leftovers on m3b:** `~/.archipelago/agent-profiles.archived-2026-09-26T193825Z` (the seeded bundle) and 40b's
   `home.archived-2026-09-26T151618Z`. Both are safe to delete.

Status: DONE_WITH_CONCERNS — Mac → Linux → Mac on 32ee1745 (g3 in 72 s, g4 in 20 s): real Claude and both real Codex
resumed under their original ids and recalled/continued on each side, four entity docs found on Linux by the same keys
through the API, m3b-role arrived and briefs alpha-feat, no pid travelled, O6 held both ways, second archid refused on
Linux and Mac with nothing touched, original snapshot differs only in notes' revive; new G1 (Important: Claude's folder
trust prompt on the first resume on a new machine stalls activation 60 s and leaves the character dormant, with no
preflight warning) and m1 (Minor: refusal stack trace in the running daemon's log).
