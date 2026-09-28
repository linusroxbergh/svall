# Task 37c: the supported-host run on the real machines

Status: **DONE_WITH_CONCERNS**.

A release built by 37b's `scripts/release-build.sh` from a snapshot of `890b1dfe` was installed on both machines of the
M3b environment. The fleet then went Mac → Linux (generation 7, 22 s) and Linux → Mac (generation 8, 16 s) with that
release's helper, 10/10 terminals `ok` each way.

- **G2 holds on the machines.** A real Claude running `claude --dangerously-skip-permissions` when the handover started
  got `claude_bypass` at preflight.
- **The real Claude session travelled.** It kept its id `b65e21cb-…` on both sides and recalled its code word on Linux
  and back on the Mac.
- **The original snapshot compares clean except for one new defect.** Against the round trip's result, the only
  differences are 10 stale `revive` fields. That is D1 (Minor): a live terminal the destination opened keeps its
  carried resume command in the state until archid restarts.

`$G` = `/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/3739c9b8-51d0-4aa6-ac32-19bc0b56eee0/scratchpad/m3bg`
(`W/m3b-env.md`, W = `docs/fleet-handover/ledger`). 37c's scripts are in `$G/c37/`, and every log named here is in
`$G/logs/c37/`.

Rules:
- The product code was not touched.
- Work on linus-vault ran only as archi-m3b.
- The Mac side ran only under the test HOME, through `$G/env.sh` and the wrappers.
- The credential was never printed.
- No command carried a daemon token (`70-token-grep.log`: 0 hits for either token in the Mac `controller/`,
  `archid.log`, all of `$G/logs`, `$G/snaps` and `$G/evidence`, or m3b's logs and `handover/`).
- `release-scan.mjs --secrets-only` passes over `$G/logs/c37` and both evidence folders.

| Step | Result |
| --- | --- |
| 1 build from a `git archive` snapshot with `release-build.sh`, scan | PASS: release `890b1df`, all three archives `ok` |
| 1 install on the Mac test HOME (app, helper, plist), daemon restart | PASS |
| 1 `archi host upgrade m3b` from the Mac release's helper | PASS: `ready`, no rollback, `m3b answers on release 890b1df` |
| 2 G2: preflight shows `claude_bypass` for the running bypass Claude | **PASS** |
| 3 Mac → Linux | PASS: generation 7, 22 s, 10/10 `ok`; real-claude-b stops at the bypass warning with its notice, "Yes, I accept" binds the carried id |
| 3 Linux → Mac | PASS: generation 8, 16 s, 10/10 `ok`, no notices |
| 3 compare (state, repos, docs, sessions, ownership) | PASS, except D1: 10 DIFF, each a stale `revive` |
| 3 real Claude turns | PASS: `LYNX C37-LINUX` on m3b and `LYNX C37-MAC` on the Mac, one transcript, one session id |
| 4 environment left, `W/m3b-env.md` updated and committed | DONE |

## 1. Build and installs

**Snapshot and build** (`c37/build.sh`, `01-build.log`, 15:29:52–15:30:54Z).
- `git -C <worktree> archive 890b1dfe | tar -x -C $G/c37/src`, then `git init`, a fetch of `890b1dfe` from the main
  repository, and `git reset --mixed` to it. `git status` was empty before and after, and `git describe` is `890b1df`.
- The worktree's gitignored vendor caches were copied beside it: GhosttyKit `332b2aef…-r1` (current), the pinned Node
  tarballs and rsync.
- `scripts/release-build.sh --out $G/c37/rel --version 890b1df --url-base https://github.com/linusroxbergh/archipelago/releases/download/890b1df`.
  `ARCHI_RELEASE_KEY` was unset, so the release is unsigned. The run built protocol 17, stateSchema 8, transferSchema
  1, authoritySchema 1, Node v24.21.0.

| Archive | Bytes | sha256 | Scan |
| --- | --- | --- | --- |
| `archipelago-companion-890b1df-linux-x64.tar.gz` | 46,186,272 | `5a0f8cec88d08bd4…` | ok, 114 files |
| `archipelago-companion-890b1df-linux-arm64.tar.gz` | 45,877,723 | `e06a949592794757…` | ok, 114 files |
| `archipelago-controller-890b1df-darwin-arm64.tar.gz` | 41,219,181 | `8080fb9c21f31fde…` | ok, 117 files |

- The scan ran inside `release-build.sh`, then once more by hand: exit 0. It found no hit.
- The controller's `release.json` pins both companions at their `https://github.com/…/download/890b1df/…` URLs and
  digests.

**The app.** A release publishes no app, only the controller tree the app carries.
- The app shell was built from the same snapshot, as `desktop:build` does (web build, then
  `apps/desktop/mac/build.sh release`).
- Its `Contents/Resources/release` was replaced by the tree unpacked from the controller archive, and the app was
  re-signed ad hoc (`$G/c37/app/Archipelago.app`, build `890b1df`, `codesign -v` valid).
- `diff -r` of the app's release against the archive's tree is empty.

**Mac install** (`c37/11-install.sh`, `11-install.log`).
- The app went into `$TH/Applications`, and `$G/companion/` got the release's linux-x64 archive.
- The app's helper ran `archi -p private setup --no-launchctl --allow-unsigned --release <app>/Contents/Resources/release`
  (exit 0):
  - `current` → `releases/890b1df`;
  - the plist in `$TH/Library/LaunchAgents` names `current/bin/archid` and was not loaded;
  - `~/.local/bin/archi` → `current`.
- These are unchanged by setup: `node.json` (47871), Codex `hooks.json` (`8d9fb67b…`), Claude `settings.json`
  (`441dbf3d…`) and the plist's md5.
- The daemon restarted on `890b1df` (pid 25739), and `system.info` says `890b1df`, protocol 17. The fleet was
  unchanged: 11 windows, and nothing open.

**m3b upgrade** (`c37/12-upgrade.sh`, `12-upgrade.log`). The command was
`archi host upgrade m3b --release <the release's companion-x64 archive> --allow-unsigned --json`:

```
{"step":"release","status":"ok","detail":"890b1df for linux-x64 from the archive you named (unsigned)"}
{"step":"probe","status":"ok","detail":"m3b answers on release 890b1df"}
{"result":"ready","actions":[]}
upgrade exit 0 after 10s
```

- Both units restarted onto `releases/890b1df`: archid 295623 → 2726068, and gateway 295632 → 2726077.
- m3b logged `starting read-only: 05b3af33-… owns this fleet at generation 6`.
- m3b's mission-control home is unchanged: 29 entries, with names, modes, mtimes and bytes equal (`diff exit 0`).
  Codex hooks and Claude settings are unchanged too.
- `host doctor m3b` fails nothing: `release ok "890b1df, protocol 17; this controller runs 890b1df, protocol 17"`. It
  warns about tmux 3.4, PATH and gh.

## 2. G2 on the machines

**Setup.**
- **m3b's bypass acceptance was removed.** `20-m3b-unbypass.sh` (`20-m3b-unbypass.log`) deleted
  `skipDangerousModePermissionPrompt` from m3b's `~/.claude/settings.json`. A byte copy is kept in
  `~/m3b-tools/settings.json.before-c37`. Afterwards neither settings file nor `.claude.json` held a bypass
  acceptance, and both still trusted `real/claude-r` and `real/claude-t`.
- **The credential** (`c37/23-creds.sh`, `23-creds.log`) went into both test homes:
  - read at 15:34:52Z, with `expiresAt` 23:11:13Z, so **456 minutes left**;
  - both copies 0600, 15,529 B and equal.
- **real-claude-b** (`c_aosb44`) was started in bypass mode on the Mac (`24-bypass-start.log`, `24b-bypass-start.log`):
  - `char.revive` opened `claude --resume b65e21cb-…`. The rest had dropped its flag (`W/m3b-env.md`).
  - `/exit` was sent, and then `claude --dangerously-skip-permissions --resume b65e21cb-6b39-4b2e-9f64-727dc5b4ef3f` was
    typed into its shell: a user's own resume.
  - SessionStart bound the same session id, with pid 30873 and argv `…/agents/real-claude/claude
    --dangerously-skip-permissions --resume b65e21cb-…`. The pane reads `⏵⏵ bypass permissions on`.
  - The Mac's Claude has accepted bypass mode, so no warning appeared there.
- The snapshot `c1-before-mac` was taken with it running.

**Preflight of Mac → Linux** (`31-mac-to-linux.ndjson`, `31-preflight-warnings.txt`), 1.65 s into the run, 0 blockers:

```
claude_bypass c_aosb44(real-claude-b) Claude warns that real-claude-b resumes in Bypass Permissions mode on m3b, with "No, exit" preselected; choose "Yes, I accept" in that terminal
claude_bypass c_ku8ri5(flags) Claude warns that flags resumes in Bypass Permissions mode on m3b, with "No, exit" preselected; choose "Yes, I accept" in that terminal
```

- The other warnings were `claude_trust` for the seven mocked Claude characters, `env_file` for alpha, and
  `worktree_unused` for beta-unused.
- Both captured manifests carry real-claude-b as `claude --dangerously-skip-permissions --resume b65e21cb-…` and flags
  as `claude --effort 'high' --dangerously-skip-permissions --resume 805751b2-…`. Neither holds a `pid` field.
- On the way back, Linux → Mac gave no `claude_bypass`, which is correct: the Mac has accepted bypass mode.

## 3. The round trip

### Mac → Linux (`ho-ts.sh c37/31-mac-to-linux m3b`)

**Complete, generation 7, in 22 s** (transaction `2f82c6f5-…`).
- Preflight: 13 roots, 240 files, 1,083,234 B and 13 sessions.
- Result: 10/10 `ok`: alpha-feat, alpha-main (both terminals), notes, beta-wt1, beta-wt2, beta-main, flags, real-codex,
  real-codex-p and real-claude-b. real-claude and real-claude-t were carried dormant.
- real-claude-b's row came with the notice `claude has not started its session in real-claude-b's terminal and may be
  waiting at a prompt there; answer it there`.

From the stream's arrival times and m3b's pane watch (`~/m3b-tools/c37w31.watch`):
- its pane opened about 11.4 s into the run, running `claude --dangerously-skip-permissions --resume b65e21cb-…`;
- about 12.3 s in, it showed `Bypass Permissions mode, No, exit, Yes, I accept`;
- its row came at 20.84 s, about 9.4 s after the pane opened. This is R2's quiet count, as at the re-check.

**"Yes, I accept" on Linux** (`32-bypass-accept.sh`, `32-bypass-accept.log`).
- Down and Enter were sent at 15:36:58.6Z. Within 1 s, SessionStart bound `b65e21cb-…` with m3b's pid 2742908, whose
  argv is `…/agents/real-claude/claude --dangerously-skip-permissions --resume b65e21cb-…`.
- m3b's settings then held `skipDangerousModePermissionPrompt: true` again, byte-identical to before (`441dbf3d…`).

**Turn on Linux** (`r-turns.sh linux C37-LINUX c_aosb44`, `34-linux-turn.log`):
- the answer was `● LYNX C37-LINUX`;
- the transcript on m3b is one file named after the session, 68 records, and every record's `sessionId` is
  `b65e21cb-…`.

**Linux side** (`33-far-checks.log`, `35-linux-docs.log`):
- m3b owns at generation 7, with 12 windows.
- Every state pid is a process on m3b with its own `--resume` argv. The mocks run with `--add-dir …/notes`, flags with
  `--effort high --dangerously-skip-permissions`, and the Codex characters with `codex resume …` (`-m gpt-6-astra` for
  real-codex-p). The Codex characters have no pid until their first hook.
- Docs: the four entity docs are `FOUND` through m3b's own API by the same keys (FLEET-KESTREL, ISLAND-PLOVER,
  CHARACTER-WREN, REPO-HERON), with the same root ids, paths and hashes. beta-main's brief lists all four tiers.
- Profiles: alpha-feat's brief opens with `Agent profile: m3b-role`. `m3b-role.md` has md5 `87a423ab…`.

**The Mac fenced** (`36-mac-fenced.log`):
- all 34 probes answer `handover_committed`, before and after an archid restart: `char.revive`, `char.second`,
  `term.attach` and `char.run` for alpha-main, notes, real-claude-t and real-claude-b, plus `docs.create`;
- only `_keep` runs, with no agent;
- `archi status` routes to m3b, and `route.json` names m3b at generation 7;
- the restarted archid logs `starting read-only: 51cf5316-… owns this fleet at generation 7`.

**Compare `c1-before-mac → c1-after-linux`: 10 DIFF, 3 rewrite, 26 expected** (`cmp-c1-before-mac--c1-after-linux.txt`).
- The 10 DIFFs are D1: each live character's `revive`, `undefined → "<its carried resume command>"`.
- The 3 `rewrite` lines are the beta checkouts' `worktree list`, equal once beta-unused's registration, which is not
  carried, is dropped.
- The expected lines are the same as at the gate:
  - O8's `core.ignorecase` and `precomposeunicode`;
  - `node_modules` excluded;
  - beta-unused not carried;
  - both dormant real Claudes dormant on both sides;
  - records appended after each resume.

### Linux → Mac (`ho-ts.sh c37/50-linux-to-mac local`)

`c2-before-linux` equals `c1-after-linux`: 0 DIFF.

**Complete, generation 8, in 16 s, 10/10 `ok`, no notices** (transaction `4b45062c-…`).
- Preflight: 13 roots, 234 files, 1,094,102 B and 13 sessions.
- Warnings: `claude_trust` for the seven mocks and `env_file`, with no blocker. There was no `claude_bypass` (see above).

**Turn on the Mac** (`51-mac-turn.log`):
- the answer was `LYNX C37-MAC`, from pid 41144, `…/agents/real-claude/claude --dangerously-skip-permissions --resume
  b65e21cb-…`;
- the transcript has one session id throughout, and its turns in order are LYNX (Mac), RECHECK-LINUX, RECHECK-MAC,
  C37-LINUX and C37-MAC. It held 77 records after the turn, and 79 once Claude was put to rest.

**Mac side** (`52-mac-after.log`, `53-linux-fenced.log`):
- The Mac owns at generation 8, and every state pid is a Mac process with its own `--resume` argv.
- All four docs are `FOUND` by the same keys and hashes, and alpha-feat's brief opens with `m3b-role`.
- O6 holds:
  - beta-unused is still registered, and its status reads `## unused-br`, clean;
  - both stash entries are there;
  - `unused-br` is at `e3b68b38…`;
  - `worktree list` shows beta, beta-unused, beta-wt1 and beta-wt2.
- m3b is fenced:
  - revive, second, attach and run for alpha-main, notes and real-claude-b all answer `handover_committed`;
  - only `_keep` runs, and no character holds a tmux id;
  - `handover/` is empty.
- `handover status`: none open anywhere. No ssh master or helper of the test HOME is left.

**Compares:**
- **`c2-before-linux → c2-after-mac`: 0 DIFF**, 3 rewrite (beta-unused's registration, kept on the Mac: O6) and 26
  expected.
- **`c1-before-mac → c2-after-mac` (the original): 10 DIFF, 0 rewrite, 5 expected.**
  - The 10 DIFFs are the same stale `revive` fields (D1).
  - Every file, Git HEAD, branch, `status --porcelain=v2`, index, stash, worktree list, refs, config, `fsck`, doc and
    profile equals the original.
  - The sessions only grew: real-claude-b by 18 records, and each Codex by 2.

## 4. Environment left for the by-eye pass

**Rest and credential** (`c37/66-real-claude-rest.sh`, `66-real-claude-rest.log`).
- real-claude-b's window was closed while the Mac archid was down, and archid was restarted (pid 45038).
  real-claude-b is dormant with its session (`revive: claude --resume b65e21cb-…`; this harness rest drops the flag, as
  before).
- Both credential copies were **deleted at 15:43:01–02Z**. Every real-Claude step ran from 15:35:13 to 15:42:58Z,
  about 8 minutes into the token's 456.
- No real Claude runs on either machine (`ps` counts: 0 and 0), and no `.credentials.json` exists on either.

**The test app** (`80-app-open.log`). `open-test-app.sh` opened the `890b1df` app:
- it claimed `$TH/.archipelago/app.pid`, and its page connected to the test daemon on 47871;
- it quit cleanly;
- the owner's app (pid 23913) kept running, and his preferences plist was unchanged.

**The owner's files** (`72-owner-files.log`):
- These are unchanged: `~/.ssh/known_hosts` (Sep 14 17:37:59, 7,796 B, stat only), `~/Library/LaunchAgents` (Sep 26
  11:49:14) and `/Applications/Archipelago.app` (Sep 28 08:27:52, `4067bfea`).
- The owner's preferences plist reads 13:19:04 +0200. That is before this pass, which began at 17:29 +0200.

**End state** (`90-end-state.log`):
- The Mac owns at generation 8. Its archid 45038 runs `890b1df`, with 11 windows, 8 mocks and 2 real Codex, all idle.
- m3b's units run `890b1df`, and its tmux holds only `_keep`.
- No transaction is open, and both `handover/` folders are empty.
- `W/m3b-env.md` is updated and committed.

## Defects

1. **D1, Minor (new; a regression since `4697836`): a live terminal the destination opened keeps its carried `revive`
   in the state after the handover completes, until that archid restarts.**
   - **On m3b at generation 7.** Every live main terminal read `revive=<its carried resume command>` while its window
     and pid were live (`33-far-checks.log`). An example is real-claude-b's `claude --dangerously-skip-permissions
     --resume b65e21cb-…` next to pid 2742908.
   - **On the Mac at generation 8.** It was the same, and still so minutes later (`52-mac-after.log`,
     `66-real-claude-rest.log` "before").
   - **Second terminals are cleared.** alpha-main's second terminal had `revive=null`, because the poll's `attachSlot`
     drops it.
   - **A restart clears it.** After the Mac archid restarted, every live terminal read `revive=null`
     (`66-real-claude-rest.log` "after").
   - **The release before did not do this.** On `4697836` the re-check's same checks show `revive=null` for every live
     character (`$G/logs/r/36-far-checks.log`, `$G/logs/r/52-mac-after.log`).
   - **Both compares show it** as their only DIFFs (10 each).
   - **Suspected cause.** `ed25ada8` has `reviveCharacter` keep `revive` while the destination's `carrying()` is true
     (`packages/archid/src/fleet.ts:753`). `carrying()` stays true until the terminal's activation row is recorded
     (`handover/destination.ts:757-765`). After that, nothing drops a main terminal's `revive`:
     - the poll deletes it only when re-attaching a character that had no tmux (`fleet.ts:380-386`);
     - `attachSlot` does it for the second terminal (`reconcile.ts:47-51`);
     - only the startup reconcile does it for the main terminal (`reconcile.ts:132`).
   - **Impact found.** Nothing visible to a user:
     - the app reads `revive` only for a dormant terminal (`apps/desktop/web/src/TerminalArea.tsx:95`);
     - the next preflight replaces a running slot's `revive` with one read from its process (`handover/source.ts:195-199`).

     The state still misreports each live terminal as carrying a resume command. A reader that takes that field on
     trust, such as `sessions/registry.ts:103`'s bypass check for a slot preflight does not refresh, would read the
     carried one.
   - **Fix direction.** Drop the main terminal's `revive` once its activation row is recorded, or have the poll drop
     it when the terminal is not carried, as `attachSlot` does for the second.

No other defect was found.

## Notes

1. **Harness: the first bypass start raced Claude's own start** (`24-bypass-start.log`).
   - The script waited for a pid in the state, and the dormant real-claude-b still held the stale pid 41361 from a
     Mac run before the re-check's rest. So `/exit` was typed about 0.5 s after `char.revive`, and the typed resume was
     lost while Claude exited.
   - Claude went back to its shell with the state at `no agent`, and the resume was typed again (`24b-bypass-start.log`).
     The session id and transcript were unchanged.
   - A dormant character keeping its last pid is what the state has always done. The carried manifests drop it.
2. **What was not exercised on the machines:**
   - **The published download path.** `host upgrade` got the companion by `--release <archive>` with `--allow-unsigned`.
     The manifest's `https://github.com/…/download/890b1df/…` URLs are unpublished, and no signing key exists, so the
     download and the signature check were not run here.
   - **N1's cross-protocol upgrade.** `4697836` and `890b1df` both speak protocol 17.
3. **linus-vault's owner state was not re-taken.** `$G/linus-diff.sh` logs in as the default ssh user, not archi-m3b,
   which the brief rules out.
4. **Not revived.** real-claude and real-claude-t were carried dormant both ways, with their revives intact.
5. **real-claude-b is dormant without its bypass flag.** A new G2 check needs the bypass start again, and m3b's
   acceptance removed again (`W/m3b-env.md`, 37c's scripts).

## Concerns

1. D1 came in with the fix wave's `ed25ada8`, and neither the unit nor the fault suites caught it: they stop at the
   activation rows. Until it is fixed, every handover leaves stale `revive` fields until the next restart, and each
   on-machine compare shows them as DIFFs.
2. A published, signed install (download from the manifest's URL, signature check against `allowed_signers`) has
   still not run end to end on real machines.

Status: DONE_WITH_CONCERNS — release `890b1df` (release-build.sh from a `890b1dfe` snapshot, scan clean on all three
archives) installed on the Mac test HOME and upgraded onto m3b by its own `host upgrade` (`ready`, no rollback); G2
PASS (`claude_bypass` for the running bypass Claude real-claude-b, and flags); Mac → Linux g7 in 22 s and Linux → Mac g8
in 16 s, 10/10 `ok` each, real Claude `b65e21cb-…` recalled LYNX on Linux and Mac under one id, docs, profile, O6,
fences and Git state equal; new D1 (Minor): live terminals keep their carried `revive` until archid restarts, the only
DIFFs.
