# Task 40b, second run: the round trip on the fixed build

Status: **DONE_WITH_CONCERNS**. The fleet went Mac → Linux → Mac on `9be818f5` and every check the two briefs list
passed:

- F8: m3b's tmux 3.4 listing parses, with no stray character, both as owner and as a resting source.
- F9: both daemons seed the six bundled profiles.
- F2: no pid travels.
- F3: kept launch flags come back and a Codex `-p` is dropped.
- The idle-closed notes arrives dormant, wakes on Linux and travels back.
- Codex resumes both carried sessions under their ids on each side.
- Both compares hold only the profile gap already routed to Task 42.

Two new defects came from `archi host upgrade`, not from the handover:

- **N1, Important:** across a protocol change, the upgrade rolls itself back, then forward, and reports "back on the
  release it ran before" while m3b runs the new one.
- **N2, Minor:** the upgraded replica's mission-control home was written by the old release. The first handover is
  therefore blocked on it until `--archive`.

HEAD `9be818f5`. W = `docs/fleet-handover/ledger`. `$S` =
`/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/3739c9b8-51d0-4aa6-ac32-19bc0b56eee0/scratchpad/t40s2`
(the first run's `…/t40` beside it is kept). Every script and log named below is in `$S`, and `W/m3b-env.md` describes
the environment as it stands now.

- `caffeinate -i` ran for the whole pass.
- No command carried a token. Both daemons' 48-character tokens appear in no log, snapshot, captured manifest, Mac
  `controller/` or m3b log (`logs/29a-token-grep.log`).
- No tracked file was edited before the build, so the build is clean (not `-dirty`).

| Step | Result |
| --- | --- |
| 1a build (F12) | PASS: release `9be818f5` |
| 1b install and setup on the Mac | PASS |
| 1c `archi host upgrade m3b` | **FAIL** (N1). The end state is right: m3b runs `9be818f5`, protocol 17 |
| 1d Mac daemon restart; F9 on the Mac | PASS |
| 1e F8 and F9 on m3b | PASS, proven once m3b owned the fleet (step 2); a replica runs no tmux and seeds nothing |
| 1f delete `~/.archipelago.t40-aside` | DONE |
| 2a fixture additions and `s2-before-mac` | PASS |
| 2b Mac → Linux (first brief step 6) | PASS after `--archive` of the blocked home root (N2) |
| 2c Linux → Mac, `handover local` (first brief step 7) | PASS |
| 3 environment left, `W/m3b-env.md` | DONE |

## Step 1: rebuild, install, upgrade, restart

**1a Build: PASS** (`build.sh`, `logs/01-build.log`).

- The worktree was clean. `git describe --tags` gives `ghostty-kit-85-g9be818f5`, yet the release and companion are
  named **`9be818f5`** (F12).
- The release carries `agent-profiles/` (architect, debugger, explorer, planner, reviewer, verifier), protocol 17,
  stateSchema 8 and Node v24.21.0.
- The companion is `archipelago-companion-9be818f5-linux-x64.tar.gz`, 46,179,169 B, sha256 `f4ee28f38326d9b8…`.
- The GhosttyKit link was put back to its old target.

**1b Install and setup: PASS** (`11a-install-setup.sh`, `logs/11a-install-setup.log`).

- The app was replaced in `$TH/Applications`. `archi version --json` gives `9be818f5`, protocol 17, and there is no
  node on the Finder PATH.
- `archi -p private setup --no-launchctl --allow-unsigned --release <app>/Contents/Resources/release` gave:
  - `current -> releases/9be818f5`;
  - node.json kept at 47871;
  - Codex `hooks.json` and Claude `settings.json` byte-identical before and after (so the Codex hook trust holds).

**1c `archi host upgrade m3b --release <companion> --allow-unsigned --json`: FAIL** (`11b-upgrade.sh`,
`logs/11b-upgrade.log`). The command exited 1 after 25 s:

```
{"step":"install","status":"ok","detail":"! path  /Users/Shared/archi-m3b/.local/bin is not on PATH, …"}
{"step":"probe","status":"warn","detail":"m3b answered with protocol 15, not 17"}
{"step":"rollback","status":"warn","detail":"systemctl --user restart archipelago-archid@private.service",
 "action":"ssh archi-m3b@100.117.42.24 and read the daemon log; the machine is back on the release it ran before"}
{"result":"actions",…}
```

Afterwards both units ran `releases/9be818f5`, `current` → `9be818f5`, and `host doctor m3b` said `release ok "9be818f5,
protocol 17"`, so the output is wrong about the end state. What happened, from m3b's journal and archid.log:

1. **15:06:52Z.** The install step ran the *installed* release's `archi setup --release <archive>`, that is the old
   `ghostty-kit-24-g0b72b15a-dirty` (protocol 15). It installed `9be818f5`, moved `current` and restarted both units.
   The new archid was listening at 15:06:54Z.
2. **15:07:14Z, 20 s later.** The old setup's own probe had timed out and it rolled back. The probe was
   `daemonRuns(version, () => Client.connect(home))`, and the old client refuses any daemon that answers another
   protocol. The new daemon answers `{"ok":true,"protocol":17}` (`logs/11e-old-client-probe.log`, where the old
   `archi.mjs` carries the same check). So `current` went back to the old release and archid restarted. The install
   step still said `ok`, because host.ts shows only setup's last output line.
3. The upgrade's own probe then ran `current/bin/archi connection-info`, now the old one, and got protocol 15. It ran
   `archi setup --rollback` with no target. That picks the newest *other* release by mtime, which is `9be818f5`, so
   `current` moved forward again (15:07:14.96Z) and archid restarted a third time.

Suspected: `packages/cli/src/controller/install.ts:149` (`installedSetup` runs the old release's setup),
`packages/cli/src/commands/setup.ts:100` with `packages/cli/src/client.ts:105` (the probe's protocol check),
`packages/cli/src/controller/host.ts:445` and `:458-463` (last-line detail; the rollback's action text), and
`scripts/install-release.mjs:109-124` (`previousRelease` by mtime). Defect N1.

**1d Mac daemon restart: PASS; F9 on the Mac: PASS** (`11c-mac-restart.sh`, `logs/11c-mac-restart.log`).

- Harness step: `$FH/agent-profiles` held only the first run's hand-made `m3b-role.md`. Seeding copies only while the
  folder is absent (`agent-profiles.ts:49-53`), so the folder was set aside before the start.
- The new archid (`releases/9be818f5`, protocol 17) logged `agent profiles -> …/.archipelago/agent-profiles`, with no
  ENOENT. The six files are byte-equal to the release's.
- `m3b-role.md` was then put back beside them, and the aside folder removed.
- The fleet state was unchanged: ownership Mac at generation 0, 8 windows, 5 mocks and 1 Codex, notes dormant.
- alpha-feat's brief still opens with `Agent profile: m3b-role — follow this role.`

**1e F8 and F9 on m3b: PASS, proven in step 2.**

- After the upgrade m3b is a replica. It starts `read-only`, runs no tmux server and does not run `begin()`, so it has
  nothing to list and seeds nothing (`fleet.ts:139-145`).
- At activation (15:16:24Z) it logged `agent profiles -> /Users/Shared/archi-m3b/.archipelago/agent-profiles`. The six
  bundled files were seeded, and `m3b-role.md` was not there (see 2b).
- Its tmux 3.4 listing then read all 10 rows exactly: `_keep`, the 8 carried windows and alpha-main's second, with
  ids, panes, names, commands and paths. State held exactly the 9 carried characters. There was no `i_recovered`
  island and no nameless character, and `char.revive` worked.
- On the way back, m3b's rest classified every terminal from the same listing, and the return completed 9/9.

**1f `rm -rf ~/.archipelago.t40-aside` on m3b: DONE** (124 K; no process held its socket; `logs/11d-aside-removed.log`).

## Step 2: the round trip

### 2a Fixture additions and snapshot: PASS

These were added for F2 and F3 (`12a`–`12d`, `logs/12*`):

- **flags** `c_ku8ri5`, cwd `$TH/real/flags`, island `m3b dirs`, started by
  `--command "claude --effort high --dangerously-skip-permissions --model x"`. It took one turn and was looked at.
  - `--effort` and `--dangerously-skip-permissions` are flags main keeps for Claude.
  - `--model` is one main drops for Claude (`dormancy.ts:22-26`; Claude restores its model itself). The brief's
    `--model x` is a kept flag only for Codex.
- **alpha-main's second terminal** runs the mocked claude (session `35bbee19-…`), with one turn. This gives
  `second.agent.pid` something to test.
- **real-codex-p** `c_z2jbwx`, cwd `$TH/real/codex-p`, real Codex 0.156.1 started as `codex -p t40 -m gpt-6-astra`.
  One turn (`• KIWI`), session `01a0de47-a05d-7b20-a108-5e27532bb402`, pid 45164 with that argv.
  - Codex 0.156.1 refuses `--profile` while `config.toml` holds a legacy `[profiles.t40]` table. The profile went into
    `$TH/.codex/t40.config.toml` (`model_reasoning_effort = "low"`, shown as `GPT-6-Astra low`).
  - Both machines' `config.toml` trust `real/codex-p`, as the folder screen would write. m3b has no profile `t40`.

`snap.sh mac s2-before` gave 8 dirs, 5 checkouts, 10 sessions and 9 characters. Against `s1-before-mac`, the compare
showed exactly the additions and the six seeded profiles (`logs/13-snap-s2.log`).

### 2b Mac → Linux (`archi handover m3b`): PASS after `--archive`

**First try: blocked** (`ho.sh 21-mac-to-linux m3b`, `logs/21-mac-to-linux.log`).

- The only blocker was `destination_occupied "/Users/Shared/archi-m3b/.archipelago/home already exists and no handover
  left it there"` (root `r_4b5999a84b6186f6`). Nothing began.
- m3b's `~/.archipelago/home` was written at 15:06:52Z by the old setup that `host upgrade` ran. It is the old
  template: no `AGENTS.md`, `.agents/skills` or `.codex/rules`, and a different `.claude/rules/archipelago.md`
  (`logs/21b-home-diff.log`).
- The Mac's home was written by `9be818f5` at its start. The two trees differ, and a root no handover left is adopted
  only when it is identical (`replicas.ts:277`, `:288-295`). Defect N2.

**`ho.sh 22-mac-to-linux m3b --archive r_4b5999a84b6186f6`: PASS.** It completed in **14 s** at generation 1.

- Preflight: 9 roots, 208 files, 193,032 B and 10 sessions. Warnings: the archive notice, and `env_file` for alpha. There
  was no `codex_trust` warning, and nothing about alpha-feat's profile (D5).
- Result: 8/8 live characters `ok`. notes was carried dormant.
- m3b's old home is `~/.archipelago/home.archived-2026-09-26T151618Z`, and the new home is the one m3b's daemon wrote
  at activation.

**Compare `s2-before-mac → s2-after-linux`: 1 DIFF, 0 rewrite, 13 expected** (`logs/23c-cmp-mac-to-linux.log`).

- The DIFF is `home:.archipelago/agent-profiles/m3b-role.md: only on the source` (D5, Task 42).
- Expected:
  - O8's core.ignorecase/precomposeunicode;
  - `node_modules`;
  - notes dormant on both sides;
  - one record each that `codex resume` appended.
- With the same home path on both machines, every path mapped to itself, and no rewrite was needed.

**Linux side activated** (`far-checks.sh`, `logs/23a-linux-after.log`):

- Ownership: m3b at generation 1.
- tmux 3.4 has 10 windows, and every agent runs on m3b:
  - 6 mocked agents on `--resume <id> --add-dir …/notes`, the island context;
  - alpha-main's second terminal on `--resume 35bbee19-…`;
  - flags on `--effort high --dangerously-skip-permissions --resume 805751b2-…`;
  - real-codex on `codex resume -c tui.resume_cwd=session 01a0ddbd-…`;
  - real-codex-p on `codex resume -c tui.resume_cwd=session -m gpt-6-astra 01a0de47-…`.

**Mac fenced** (`mac-fenced.sh`, `logs/23b-mac-fenced.log`, `logs/23e-mac-restart-fenced.log`):

- Ownership: m3b at generation 1; only `_keep`; 0 mocks and 0 Codex.
- `char.revive`, `char.second`, `term.attach` and `char.run`, for alpha-main and for notes, all answer
  `handover_committed`.
- 0 characters hold tmux ids.
- `archi status` says `archid on m3b, which runs this fleet`, and route.json names m3b at generation 1.
- After a kill and restart, the Mac daemon logs `starting read-only: 51cf5316-… owns this fleet at generation 1` and
  still refuses revive.

**F2, no pid travels: PASS** (`bin/pids.mjs`, `logs/23d-carried-pids.log`).

- The controller's `manifest.json` and the source's `manifest-<tx>.json` were captured during the run. Neither holds a
  `pid` field anywhere.
- On the Mac the carried agents had included notes' dead 58292 and the second terminal's 23973.
- On m3b:
  - notes has no pid;
  - both Codex characters have none until their first hook;
  - each live mocked agent's pid is a process on m3b with its own `--resume` argv. The pids were checked in `/proc`.

**F3, launch flags: PASS.**

- The carried revive for flags is `claude --effort 'high' --dangerously-skip-permissions --resume 805751b2-…`, and m3b's
  process runs with those flags. `--model x` was dropped, as main's table says.
- real-codex-p carried `codex resume -c tui.resume_cwd=session -p 't40' -m 'gpt-6-astra' 01a0de47-…`. m3b ran it without
  `-p t40`, `-m` kept. That shows the import's `portableRevive` dropped it: had it not, Codex on m3b, which has no
  profile `t40`, would have failed to start.

**Codex resume under the original id: PASS** (`24b-linux-turns.sh`, `logs/24b-linux-turns.log`).

- Each Codex character took a turn through the Mac's helper, routed to m3b:
  - real-codex answered `• MANGO-LINUX`;
  - real-codex-p answered `• KIWI-LINUX`, shown as `GPT-6-Astra default`, since the profile stayed behind.
- Same session ids. Each session has one rollout file, grown to 31 records.
- Codex's footer shows `⚠ 1 warning` on Linux; it was not opened.

**Idle-closed notes: PASS** (`notes-wake.sh`, `logs/24a-notes-wake-linux.log`).

- It arrived with no window and `revive: claude --resume a238f2dd-…`. Its transcript was at the same path, 2 records,
  sha256 equal to the Mac's.
- `char.revive` (open) gave window `@10`, and the mock ran `--resume a238f2dd-…` with m3b's pid.
- A turn from the Mac's helper took the transcript to 4 records.

**Agent profile on m3b: recorded** (`logs/24c-profile-linux.log`, `evidence/m3b-state-after-22.json`).

- alpha-feat keeps `agentProfile: "m3b-role"` in m3b's state.
- `~/.archipelago/agent-profiles` holds only the six bundled files.
- The brief (`char.show`, and `archi char show` through the Mac) leaves the role out, with no line saying it is missing.
  This is by design (`fleet.ts:187-190`: "a profile that is missing … is left out, and the side card says why").
- m3b's log says nothing about it. Profiles travelling is Task 42 (D5).

### 2c Linux → Mac (`archi handover local` from the Mac): PASS

**`ho.sh 26-linux-to-mac local`** (`logs/26-linux-to-mac.log`):

- It completed in **16 s** at generation 2, with 9/9 `ok`, notes included.
- Preflight: 9 roots, 208 files, 234,405 B and 10 sessions. The only warning was `env_file`, and there were no
  blockers.
- `s3-before-linux` was taken first. Against `s2-after-linux` it shows only the Linux work: notes woken, 2 notes
  records and 14 per Codex rollout.

**Compares** (`logs/27c-cmp-linux-to-mac.log`):

- `s3-before-linux → s3-after-mac`: 1 DIFF, which is `m3b-role.md` only on the Mac, where it stayed. Expected: O8,
  `node_modules`, and one record per Codex resume.
- **`s2-before-mac → s3-after-mac` (against the original): 1 DIFF, 0 rewrite, 3 expected.**
  - The DIFF is notes' `revive "claude --resume a238f2dd-…" -> undefined`: notes was woken on Linux as the brief asked,
    so it came back live.
  - Every file, Git index, status, stash, worktree list and ref, and every other character, equals the original.
  - Sessions only grew: notes +2, and each Codex +16.

**The Mac activated, with the same checks** (`27a-mac-after.sh`, `logs/27a-mac-after.log`):

- Ownership: the Mac at generation 2. There are 11 windows (`_keep`, 9 characters, the second terminal), and every
  state pid is the Mac's own process.
- F3 on the way back:
  - flags runs `--effort high --dangerously-skip-permissions --resume 805751b2-…`;
  - real-codex-p runs `codex resume -c tui.resume_cwd=session -m gpt-6-astra 01a0de47-…`. `-p t40` did not come back
    (see Notes).
- F2: the captured manifest holds no `pid` (`logs/27d-carried-pids.log`).
- alpha-feat's brief opens with the role again, since `m3b-role.md` never left the Mac.
- `handover status`: none open. No master or helper is left.

**Codex and notes after the return** (`28a-mac-turns.sh`, `logs/28a-mac-turns.log`):

- real-codex answered `• MANGO-LINUX-MAC`, and real-codex-p `• KIWI-LINUX-MAC`. Same ids, one rollout each, now 46
  records.
- notes has 6 records, with prompts in order Mac, Linux, Mac.

**Linux fenced** (`linux-fenced.sh`, `logs/27b-linux-fenced.log`):

- Ownership: the Mac at generation 2; only `_keep`; 0 mocks and 0 Codex.
- Revive, second, attach and run all answer `handover_committed`.
- 0 characters hold tmux ids, and `handover/` is empty.

## Step 3: environment left, `W/m3b-env.md`: DONE

- The Mac owns the fleet at generation 2, and no transaction is open anywhere.
- Mac: archid pid 156 (`9be818f5`), 11 windows, 8 mocks and 2 real Codex.
- m3b: archid 2563672 and gateway 2562286 on `9be818f5`, and a tmux server with `_keep` only.
- m3b's `~/.codex/config.toml` backup that 12a made was removed; the `real/codex-p` trust entry stays.
- **Final checks** (`logs/29b-final-checks.log`):
  - linus-vault's stable state against the 40b before-state still differs only in archi-m3 → archi-m3b (passwd and
    linger).
  - The serve mapping is unchanged (`/ proxy http://127.0.0.1:8787`). 47800 is archi-m3b's.
  - The Mac's `~/.ssh/known_hosts` md5 and mtime are unchanged, and so is `~/Library/LaunchAgents`.
  - `/Applications/Archipelago.app` reads 15:51:36 +0200, build `3217f2c0` with no bundled release. That is before
    this pass began (17:02), and this pass installed only into `$TH/Applications`.
- `caffeinate` stopped.

## Defects

1. **N1, Important (new): `archi host upgrade` across a protocol change rolls the new release back, then forward, and
   reports the opposite of the end state.**
   - Chain:
     - the install step runs the far machine's installed (old) `archi setup` (`controller/install.ts:149`);
     - that setup's probe connects with the old client, which refuses the new daemon's protocol
       (`commands/setup.ts:100`, `client.ts:105`), so after 20 s it rolls `current` back and restarts archid;
     - the install step still reports `ok`, since only setup's last line is shown (`controller/host.ts:445`);
     - the upgrade's probe then reads protocol 15 and runs `setup --rollback` with no target. That picks the newest
       other release by mtime (`scripts/install-release.mjs:109-124`), which is the new one;
     - the step says `the machine is back on the release it ran before` (`host.ts:463`).
   - Result: exit 1, `result: actions`, three archid restarts in 21 s, and m3b on `9be818f5`, which the doctor confirms.
   - Every release that bumps the protocol will do this.
   - Evidence: `logs/11b-upgrade.log`, m3b journal/archid.log lines 7–24 (quoted in 1c), `logs/11e-old-client-probe.log`.
   - Fix direction: run the new release's own setup (or skip the old setup's probe) for an upgrade, and have the
     rollback name the release it goes back to.
2. **N2, Minor (new): after `host upgrade`, the gateway replica's mission-control home is the old release's template,
   so the next handover to it is blocked `destination_occupied` on `.archipelago/home`.**
   - Cause: the old setup (N1) writes `~/.archipelago/home` on the replica, and a replica never rewrites it
     (`begin()` runs only for an owner). The owner's home is the new template, and adoption takes only an identical
     tree (`replicas.ts:277`, `:288-295`).
   - The blocker names the root, and `--archive` got past it, leaving `home.archived-<stamp>` in m3b's fleet home.
   - A2's O4 held because both sides ran one release.
   - Evidence: `logs/21-mac-to-linux.log`, `logs/21b-home-diff.log`.
3. **D5, Minor (known, Task 42): an agent profile does not travel, and nothing says so.**
   - Preflight gave no warning.
   - On m3b, alpha-feat keeps `agentProfile: m3b-role`, the folder holds only the six bundled files, and the brief
     silently leaves the role out.
   - Evidence: `logs/24c-profile-linux.log`, and the compare's one DIFF.
4. **A2 defect 2, Minor (known, still open): a Linux → Mac return leaves the Mac's links at 0777.** `src/alpha/link-to-f1`
   and `.wt/feat/link-to-f1` were `lrwxr-xr-x` when made (`t40/logs/05d-git-fixture.log`) and are `lrwxrwxrwx` now
   (`logs/28a-mac-turns.log`).

Notes, not defects:

1. **A round trip drops the Mac's own Codex profile.**
   - This follows from the F3 ruling: `-p` is machine-local, so it is dropped at import and cannot come back.
   - The Mac's real-codex-p now runs `-m gpt-6-astra` without `t40` (`GPT-6-Astra default`) until the user restarts it
     with the profile.
2. **Kept Claude flags.** For Claude, main keeps only `--effort`, `--dangerously-skip-permissions`,
   `--allow-dangerously-skip-permissions` and `--permission-mode bypassPermissions`. `--model` is dropped on purpose.
3. **Codex profiles.** Codex 0.156.1 takes `--profile` only from `<CODEX_HOME>/<name>.config.toml`, and refuses it
   beside a legacy `[profiles.<name>]` table.
4. **`ownership.get` after Complete.** On both sides it still shows the last transaction at `phase: committed` after
   Complete, while `handover status` says none is open. A2 showed the same.
5. **Harness slip.** A zsh redirection-only command (`$TMUXB 2>/dev/null` with the variable unset) ran zsh's
   NULLCMD `cat` and held one check open for 2 minutes. It was killed; nothing else was affected.

Status: DONE_WITH_CONCERNS — the Mac → Linux → Mac round trip on `9be818f5` passed every check (F2, F3, F8, F9, notes
dormant → woken → back, Codex resumed under its ids both ways, 1 DIFF each way = the profile gap of Task 42); new N1
(Important: host upgrade across a protocol bump rolls back, then forward, and misreports) and N2 (Minor: the upgraded
replica's home blocks the first handover until `--archive`).
