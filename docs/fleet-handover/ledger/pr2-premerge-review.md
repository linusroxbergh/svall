# PR #2: what to tackle before merging (2026-10-12)

Review of https://github.com/linusroxbergh/svall/pull/2 at `b31fe003` against origin/main `091be0b0` (Svall 0.9.0).
Report only: nothing was edited, pushed or commented. Line numbers are at `b31fe003`. Nothing already in
`deferred.md` or the earlier PR reviews is raised again, except where the item should move before the merge.

- **Panel:** 7 Opus reviewers, each using the Bug Hunter, Architect and Guardian lenses. Their areas were the
  inspiration fix wave (`09a4d83c..f8938750`), the merge resolution (`--remerge-diff 22901e88`), the merge follow-ups
  plus main 0.9.0 against the single-owner invariants, upgrading and downgrading with the flag off, flag-off runtime,
  release and shipping, and intent (PR body, spec, docs).
- **Validation:** a fresh Opus validator for each Medium+ finding and one batch validator for the Lows. Each finding was
  reproduced again with a scratch test or a run in a temp HOME; the scratch files were deleted afterwards. Then Gemini
  (pal codereview, thinking high) checked the Medium+ findings and confirmed all 7, with severity changes noted below.
- **Overall:** the merge resolution is sound: all 29 conflicts keep both sides, and the guard and inventory cover every
  0.9.0 method and state field. One regression reaches users who never turn the flag on (M1), and it needs fixing
  before the merge. The rest are cheap fixes plus a doc pass.

## Must fix before merge

### M1. svalld does not start when `~/.config/svall` cannot be written, even with no gateway (deferred item promoted)
- **Claim:** `start()` calls `machineId()` for every fleet (`packages/svalld/src/main.ts:152`). If `~/.config` is
  read-only or root-owned, if it is a file, or if `machine.json` is corrupt, the daemon exits 1 about 1 s after start.
  `bin.ts:40` waits only on config and state-version errors, so the app restarts the daemon every 10 s and shows
  "svalld not running". 0.9.0 never touches `~/.config/svall` and starts in all three cases. So an update leaves an
  affected flag-off user with no Svall at all, and EACCES/ENOTDIR come with no hint.
- **Evidence:** tsx svalld run in temp HOMEs, compared with a 0.9.0 worktree:
  - `chmod 555 ~/.config`: the PR fails with `EACCES … mkdir '.config/svall'` at `machine.ts:26`; 0.9.0 starts and
    logs only an opencode plugin error.
  - `machine.json` = `{"id":`: the PR fails with "invalid machine file"; 0.9.0 starts.
  - `~/.config` as a file: the PR fails with ENOTDIR; 0.9.0 starts.

  A root-owned `~/.config` left by a tool run under sudo is a known macOS support issue (Joplin, 1Password CLI,
  rclone). Gemini rated this critical; we keep it High because it needs an uncommon setup.
- **Change:** if `machineId()` throws and `config.gatewayMachineId` is unset, log the error and run on owner.json's
  `ownerMachineId`, or a fresh UUID. A fleet with a gateway still fails. The validator tested this patch in a scratch
  worktree: all three cases start, the id stays the same across restarts, and `daemon.test` (19) and `machine.test`
  (6) pass. Add a chown hint to the EACCES line. `svall version` (`packages/cli/src/commands/version.ts:13`) throws the
  same way; fix it too.
- **Cost:** small.

## Should fix before merge

### S1. A repeat `host add` reports ready when the far setup went back to the old release
- **Claim:** `addProbe` calls `endToEnd(master, entry)` without a release (`packages/cli/src/controller/host.ts:278`,
  called at `:423`). The identity step checks only the protocol. `upgradeHost` does pass
  `{ release: companion.version }` (`:543`). The wave made the far `setup --release` probe the new daemon and, when it
  doesn't answer, go back to the previous release while still exiting 0. A repeat add, or a first add over an existing
  install, then saves the registry and reports `ready` for a machine running the old release. The install step shows
  only the last output line, so the rollback line never appears. The handover later blocks with
  `incompatible_release`.
- **Evidence:** two scratch tests. (1) The real Linux `setup --release 1.1.0` over 1.0.0 with a silent daemon went back
  to `current -> releases/1.0.0` and exited 0. (2) `addHost` with that output, with the far side on 1.2.2 and the
  archive at 1.2.3, returned `{result:'ready',actions:[]}` and saved the registry. `host doctor` does catch it (release
  check fails); connect doesn't. Gemini rated it High; we keep it Medium because the Upgrade path recovers.
- **Change:** `endToEnd(master, entry, { release: companion.version })` in `addProbe`, with a message naming the
  rollback.
- **Cost:** tiny.

### S2. The every-update download goes from 51 MB to ~141 MB (deferred item promoted, in part)
- **Claim:** every release build carries `Resources/release` (`apps/desktop/mac/build.sh:51-61`): 172 MB on disk and
  ~90 MB compressed, for every user with the flag off too. Of that, 117 MB is a second Node, byte-identical to
  `Helpers/node`, and 45 MB is the linux-x64 companion. Updates have no Sparkle deltas, because `release.sh:54` empties
  `dist/releases`. Neither `deferred.md` nor the PR states this cost.
- **Evidence:** built with build.sh's own calls (`release-scan` ok). `du`: 172M (node 117M, companions 45M). Zipped:
  89,020,472 B; UDZO: 90,205,916 B. The 0.9.0 DMG is 50,650,996 B (`curl -sI`). `cmp` shows the carried node
  identical to the vendor node in `Helpers`. The live appcast has a single enclosure.
- **Change:** after the rsync into the app, replace `Resources/release/node/bin/node` with a symlink to
  `../../../../Helpers/node`. This must come after `release-scan`, which refuses links. In a mock bundle,
  `codesign --verify --strict --deep` passed and `bin/svall --version` ran, and the DMG comes to ~100 MB. Also write
  the remaining cost into `deferred.md`. Fetching the companion at Add Machine instead is a follow-up (F4).
  Notarization with the carried tree is still unverified.
- **Cost:** tiny for the link; medium for the companion part.

### S3. A new Mac fleet's opening shell makes the whole projects folder a handover root
- **Claim:** main 0.9.0's opening shell sits at `config.defaultCwd` (`packages/svalld/src/fleet.ts:150`), which setup
  sets to the projects folder (`~/Developer`). The inventory turns every character cwd into a `cwd` root and skips only
  the home (`packages/svalld/src/handover/inventory.ts:245`). So a fleet's first handover copies every repo in
  `~/Developer`, unrelated ones included.
  - Preflight shows only counts and doesn't ask to confirm.
  - `too_many_files` names no root or character.
  - On the way back the Mac copy is sealed as a replica, so any IDE edit under `~/Developer` gives
    `destination_diverged` with "Archive ~/Developer". This part comes from reading the code; it wasn't run.
- **Evidence:** scratch inventory test with a worker at `Developer/app` and the shell at `Developer`. Roots:
  `[home, cwd Developer, repo Developer/app (folded)]`, and the carried root holds `app`, `unrelated` and `old-stuff`.
  The CLI printed `Checks: 2 roots, 105 files … ✓ nothing blocks the handover`. 0.9.0 users already have this shell:
  4c42afcb is in v0.9.0. Gemini rated it High.
- **Change:** don't simply skip `defaultCwd`, because a character can really work there and its files would then be
  left behind. Instead, add a preflight warning naming the character when a non-Git `cwd` root holds Git repositories
  that no character uses, and list each root with the characters behind it under Checks.
- **Cost:** small.

### S4. A prompt sent as the freeze lands still types into the frozen fleet
- **Claim:** `Prompts.run` sends after the lane wait and the composer read with no `writable()` re-check
  (`packages/svalld/src/fleet/prompts.ts:55-57`). Only `deliverHeld` re-checks (`:106`, `:116`). A `char.run` the
  guard admitted just before a freeze therefore types the prompt and writes `working` into frozen state. Main's safe
  send opened this window; 8e86c009 closed it only for held prompts. Two older windows remain: the Enter goes in
  100 ms after the paste (`tmux.ts:225-229`), and `Fleet.settle()` doesn't wait on prompt lanes (`fleet.ts:168`).
- **Evidence:** two panelists and a validator reproduced it independently with scratch tests on real tmux (4/4). In
  each, a freeze inside `tmux.screen` produced `delivered`, with `typed [{go, frozen:true}]` and status `working`.
  Usually harmless: the freeze runs `check()` before the rest, so the rest sees a working agent. The narrow harmful
  case (a lane backlog longer than `check()` lets the rest kill the window mid-turn) comes from reading the code; it
  wasn't run. With the flag off nothing freezes. The validator rated it Low; Gemini rated it Medium/should.
- **Change:** in `run`, send only when `free && !held && this.deps.writable()`, and hold otherwise. That is one line,
  in line with 8e86c009. The Enter window and `settle()` waiting on the lanes are F3.
- **Cost:** tiny.

### S5. Doc pass: claims that are wrong at head
Each item is tiny and confirmed against the code.
- **The flag gates the app, not the CLI.** The PR TL;DR, `docs/fleet-handover/README.md:7`,
  `docs/remote-machines/README.md:8` and `release-notes.md:3-5` all say everything sits behind `handover.enabled`.
  In fact no CLI command reads the flag, by design (plan.md:704, Task 18 ruling), and `setup.md:56` already says so.
  In a temp HOME with the flag off, `svall host add` reached ssh and wrote machines.json; `gateway owner create` wrote
  a record; with a gateway set, `svall handover x` opened the ssh master. No app control, setup step, migration or
  doctor fix reaches these, so nobody gets there by accident. Reword those four places to match `setup.md:56`.
- **"Works exactly as before" isn't true with the flag off.** `release-notes.md:3-5` and the PR's "For everyone"
  list leave these out:
  - A second terminal running Claude or Codex now stays dormant when Svall quits, and opening Terminal 2 later types
    `claude --resume` instead of starting a fresh shell. This is the spec's v9 behaviour (`dormancy.ts:56`, `:246`);
    0.9.0 deleted it. There is no auto-revive; a scratch test confirmed it.
  - The daemon now writes `~/.config/svall/machine.json`.
  - Each window runs a connect helper.
  - The app download grows (S2).
- **`migration.md:119` "Upgrading again" breaks a second downgrade.** It runs `rm config.json`, so a second
  downgrade's `mv config.json.bak config.json` (`:81`) fails and 0.9.0 starts on default settings. Reproduced in a
  shell. Use `mv config.json config.json.bak` instead; with fleet.json present the split ignores the `.bak`.
- **`migration.md:16`** leaves `agentsOff` out of node.json's keys, and doesn't say that keys neither file knows
  survive only in `config.json.bak`.
- **`spec.md`** says schema v8 at `:549`, `:851` and `:875`; it is 9. The export-strip sentence at `:553` leaves out
  `agent.subagents`, `hint` and `panePath`, which are classed FORBIDDEN.
- **`deferred.md:105`** still lists "Linux `setup --release` never passes `rollbackTo`", which the wave fixed
  (`commands/setup.ts:265`).
- **PR body: "Edits made on the destination are never overwritten without a blocker"** contradicts `deferred.md:53`
  (the root isn't re-checked before `rsync --delete`). Qualify or drop it.
- **The PR's flag-removal conditions** include a notarized `pnpm release` and a Svall Dev handover path. The README's
  "Owed before this can ship" list has neither. Make the two lists match.

## Follow-up ticket

- **F1.** Every window runs the connect helper even with no gateway (`ShellRouter.swift:64`). It measured 84 ms to
  online, 78 MB RSS / 42 MB footprint, and a 30 s tick. Keep this deferred: flag-off users can't see it, and the fix
  is about 10 untested lines of Swift where a wrong local-only guess attaches terminals on the wrong machine. Gemini
  agreed. Small.
- **F2.** The bundled rsync is built without `MACOSX_DEPLOYMENT_TARGET`, so its minos is 26.0 against the app's 15.0
  (`scripts/release-stage.mjs:122`, `otool` checked). Its imported symbols match a 15.0 build, and it hasn't been run
  on macOS 15. Pin 15.0 as `tmux-build.sh` does and key the cache on it. Tiny.
- **F3.** The rest of S4: check `writable()` before the Enter (`tmux.ts:225`) and have `Fleet.settle()` wait on
  prompt lanes. Small.
- **F4.** Fetch the companion at Add Machine instead of carrying it, which saves ~46 MB more. This changes Add
  Machine's offline story. Medium.
- **F5.** Local release builds sign with any `SVALL_RELEASE_KEY` and never check `allowed_signers`
  (`release-stage.mjs:374`). An install of such a build refuses its own companion (reproduced). Verify after signing.
  Tiny.
- **F6.** `pnpm compat` doesn't check `opencode session export/import --standalone --directory`, which the handover
  runs (`scripts/compat/harnesses.ts:232`). Tiny.
- **F7.** Two processes splitting `config.json` at once: the loser throws a raw ENOENT and the daemon exits
  (`config.ts:131-135`). Reproduced at function level only; the daemon locks the home first, so it takes a manual
  `svall setup` running alongside. Small.
- **F8.** `host.ts` writes the machine-identity check four ways (`:347`, `:409`, `:521`, `:579`), with two different
  fix texts. Small.
- **Unverified, needs the container harness or the built app:**
  - an Upgrade, now one click away, taken while a handover is open restarts the destination daemon and the gateway
    mid-transaction (`host.ts:516` has no open-handover guard, unlike `removeHost`);
  - only the window that ran Upgrade restarts its idle helper, so other fleets' windows keep a stale banner
    (`ShellRouter.swift:398`);
  - notarization and the DMG with the carried tree;
  - the first `release.yml` run.

## Checked, not an issue

- **Merge resolution:** each of the 29 conflict hunks was read against both parents and keeps both sides' meaning.
  Cleanly merged files that touch handover paths hold too: keyboard Esc order, `--no-daemon` via `withStandalone`,
  scribe, SvallHome, and release.sh.
- **0.9.0 against the invariants:** 76 methods map to 76 guard classes, and all 142 state and fleet.json leaves are
  classified. `robots.set`, `char.update` and `char.run` are mutations; `subagents` is FORBIDDEN; `shellsOnly`,
  `robot` and `animals` are NOT_BOUND. Main's poll, dormancy and scribe writers are gated on `writable()`. The rest
  still recognises the new hook and statusline lines.
- **Merge follow-ups:**
  - The opening shell stays Mac-only on every Fleet path (only `main.ts:156` omits `platform`).
  - Keep awake holds only for a local owner; flag-off behaviour is identical to 0.9.0.
  - Held prompts: both `writable()` checks and `stop()` are load-bearing.
  - The harness's mock prompt lines read correctly through svalld's own `readComposer` in tmux.
  - The new tests fail when their guarded line is reverted.
- **Inspiration wave:**
  - A repeat add checks identity before upload and before the registry, and keeps the gateway mark.
  - The upgrade rollback never lands on the failing release.
  - A same-name reinstall doesn't loop.
  - The auth hint keys only on `auth`.
  - The Swift helper restart stays on the main thread, and the remote unloaded screen keeps HostSetup.
  - cli 113, svalld 35, web 55 and Swift 21 targeted tests pass.
- **Upgrading from 0.9.0 with the flag off:**
  - Every config key lands in the right file and still takes effect: port, shell, mobile, agentsOff, scribe.
  - v8→v9 keeps every field.
  - 0.9.0 refuses the migrated state with exactly the message `migration.md` quotes.
  - A symlinked `config.json` and an existing `.bak` behave as documented.
  - Mixed CLI and daemon versions refuse clearly in both directions.
- **Going back to 0.9.0:** the downgrade steps, run verbatim on 4 homes (private, named, `~/.svall-host`, name
  "fleet"), work. The cost to the user:
  - settings changed after the upgrade revert;
  - characters made after it are lost, or come back as nameless "recovered" robots if their tmux window is alive;
  - edits to fleet.json and node.json are lost.

  The `jq` relabel path keeps characters and drops dormant second terminals, as documented.
- **Claude Code below 2.1.251:** the warning only warns, so `deferred.md` can keep it.
- **Flag-off runtime:**
  - No new Mac listener or socket; the daemon lock is unchanged.
  - Two fleets starting at once share one machine.json (5/5).
  - A standalone fleet repairs a foreign or unreadable owner.json.
  - CLI is +7 ms (larger bundle). Hooks and the statusline are unchanged.
  - The Machines pane, the handover sheet and banners are gated; quitting takes the 0.9.0 path.
- **Release:**
  - The next `pnpm release` from main isn't blocked: the tag's signer check exists only in `release.yml`, which has
    never run, and `release.sh` pushes the tag after upload.
  - The carried-release block builds in ~47 s and needs only Xcode CLT and two downloads.
  - Svall Dev is unaffected.
  - Licence gaps predate the PR, and the PR adds no new obligation.
  - `pnpm compat` is clean. The only new dependency is zod for the CLI.
- **Intent:** `svall doctor`/setup warn below 2.1.251; the mid-turn resume after abort, handover and recovery is
  covered by tests; the reserved names, protocol 22 and schema 9 match.

## Fix wave

M1 and S1–S5 went into PR #2 (pushed b31fe003..a84bf57d, 17 commits). Five fresh Opus fixers worked test-first, each
in its own worktree, and a fresh Opus reviewer checked each one; all were approved after their rounds.

- **M1:** a fleet with no gateway starts on owner.json's id or a fresh one when `~/.config/svall` can't be used, with a
  chown/move hint. `svall version` names the problem.
- **S1:** `host add` fails at identity when the far machine doesn't run the release just installed, and its probe
  asks for that release.
- **S2:** the app's carried node is a link to `Helpers/node`, and the build fails when the two differ. UDZO went from
  137.6 to 99.1 MB.
- **S3:** a ruling changed it from a warning to a preflight blocker, `repository_unused`. A warning scrolled past
  while the copy began. The blocker is cleared by `--carry-unused`, the sheet's "Carry the folder whole", or moving
  the terminal or excluding the repositories. It is checked at preflight, at freeze and after the rest.
- **S4:** `char.run` holds a prompt when the fleet froze during the composer read.
- **S5:** docs, plus `deferred.md`, which gained F2–F8, the wave's deferred minors, and every pointer moved to the
  new head.

**Verification at a84bf57d** (code at 221df16f):
- typecheck clean;
- protocol 159, svalld 2665, cli 1636, web 1071;
- faults 1421, Playwright 200, Swift 86;
- fresh install arm64 ALL PASS;
- container round trip 786.9 s ALL PASS (25 steps).
