# M3 Part C fix wave: Q1–Q3 report

Branch `fleet-handover-impl`, from `e96ee59b`. Three commits, in the order the items depend on each other:

| Item | Commit | Subject |
| --- | --- | --- |
| Q2 | `f304a7ec` | Preflight warns that Codex asks to trust a carried folder only where the destination's own Codex config does not trust it yet |
| Q1 | `4296770b` | An activation counts a resumed Codex up once its pane has held Codex a few seconds, keeps a window whose Codex waits at its trust prompt with a notice saying so, and names what a Codex that never came up did |
| Q3 | `2415ab4c` | A terminal a handover could not resume keeps why on its record until it next comes up, and the app shows it wherever that terminal shows as dormant |

Q2 went first because Q1's notice reads the same trust fact. Every test command ran with `unset ARCHI_HOME ARCHI_CHAR_ID TMUX` first.

## Q2: the `codex_trust` warning only for folders the destination does not trust

**Change.**
- `SessionAdapter` gains an optional `trusts(home, folder)`: whether the CLI resumes in `folder` without first asking to trust it. Only the Codex adapter has it (`sessions/codex.ts`). It reads `<home>/config.toml` with smol-toml and is true when `[projects."<path>"] trust_level = "trusted"` holds for:
  - the cwd, as given or by its real path (Codex keys by real path: `/private/tmp/…` on the Mac);
  - or the main checkout of the repository holding the cwd, the way Codex trusts a worktree through its main repository.

  A missing or unreadable config trusts nothing.
- `home` is the destination's own agent home from its probe (`AgentProbe.home`, which is `codexPaths(process.env).dir`), so `CODEX_HOME` is honoured.
- Protocol, additive: `ResumeFolder = { kind, cwd, repo? }`. `handover.inspect` takes `resumes?: ResumeFolder[]` and answers `untrusted?: string[]`, the cwds among them whose agent would ask.
- `sessions/registry.ts`:
  - `resumeFolder(c, term, at)`: a terminal's cwd plus `repo.mainRoot` when the character's `repo.root` holds that cwd. A repo that no path root maps lends no trust.
  - `resumeFolders(m)`: the same for each session a manifest carries, mapped onto the destination through the path roots, with `~` read against the source home. `@archipelago/archid/handover/sessions/registry` is now exported for the CLI.
- `DestinationHandover.inspect` answers `untrusted` through a new private `trusted(folder)`. That method picks the adapter for the destination's CLI release (`cli(kind)`: `adapterFor(kind, probe.version)`, else the kind's current adapter), and activation uses the same method (Q1).
- Controller (`cli/src/controller/handover.ts`): `destinationChecks` sends the Codex sessions' folders as `resumes`, and `codexTrust` warns only for those `untrusted` names. The old unconditional `codexTrust` in `preflight()` is gone.

**Tests.**
- `packages/archid/test/handover/destination.test.ts`, "destination inspect > names each carried folder this machine's Codex would ask to trust, by the config in its own Codex home". Its config.toml trusts `work/bo` and marks `work/demo` untrusted. It asks about:
  - bo;
  - a link to bo (real path);
  - a worktree of bo with `repo: bo`;
  - demo;
  - a folder with no entry;
  - a Claude folder.

  It expects `untrusted = [demo, fresh]`. With the config removed, bo is untrusted. With no `resumes`, there is no `untrusted`.
- `packages/cli/test/controller/handover.test.ts`, "preflight > warns that Codex asks to trust a carried folder only where the destination does not trust it yet". bo's Codex works in a worktree of `app`. The controller must ask `[{ kind: 'codex', cwd: '/home/ada/app/.claude/worktrees/x', repo: '/home/ada/app' }]`, warn `codex_trust` for c_bo while untrusted, and not warn once the fake destination trusts it. The fake destination's inspect now answers `untrusted` for every folder it does not hold in `trusted`, so the existing "adds the destination's roots…" test keeps its `codex_trust` expectation.

**TDD RED** (`scratchpad/cfix/q2-red.txt`)
```
$ pnpm vitest run --project archid packages/archid/test/handover/destination.test.ts -t "would ask to trust"
   × destination inspect > names each carried folder this machine's Codex would ask to trust, by the config in its own Codex home
AssertionError: expected undefined to deeply equal [ …(2) ]
      Tests  1 failed | 55 skipped (56)
$ pnpm vitest run --project cli packages/cli/test/controller/handover.test.ts -t "only where the destination does not trust"
   × preflight > warns that Codex asks to trust a carried folder only where the destination does not trust it yet
AssertionError: expected undefined to deeply equal [ { kind: 'codex', …(2) } ]
      Tests  1 failed | 62 skipped (63)
```
**TDD GREEN** (`scratchpad/cfix/q2-green.txt`)
```
$ pnpm vitest run --project archid packages/archid/test/handover/destination.test.ts -t "would ask to trust" --reporter=verbose
 ✓ … destination inspect > names each carried folder this machine's Codex would ask to trust, by the config in its own Codex home
      Tests  1 passed | 55 skipped (56)
$ pnpm vitest run --project cli packages/cli/test/controller/handover.test.ts -t "only where the destination does not trust" --reporter=verbose
 ✓ … preflight > warns that Codex asks to trust a carried folder only where the destination does not trust it yet
      Tests  1 passed | 62 skipped (63)
```

## Q1: Codex characters activated without a SessionStart

**Change.**
- The fact lives in the adapters. `SessionAdapter.sessionStartOnResume` is `true` for Claude and `false` for Codex. `destination.ts` has no kind-name check left: the old `agent.kind === 'codex'` trust wording is gone.
- `wakeSlot`, for a terminal with a session to resume:
  - The adapter comes from `cli(agent.kind)`.
  - A kept pane already running the agent's own kind is up at once, as before.
  - Otherwise it waits for the SessionStart (`waitStart`) and opens the window, as before.
  - **Reporting kind (Claude).** Unchanged: the SessionStart within `sessionStartMs`, else dormant with the error "…which did not report its SessionStart within 60 s, …; it may have stopped at a prompt; revive it to see". No trust wording.
  - **Non-reporting kind (Codex).** The SessionStart wait is untimed (`waitStart(…, timed = false)`), and the new `settles()` keeps the time.
- `settles()` looks at the pane afresh every 0.5 s through `holding()` (tmux list plus a ps of that pane):
  - **Up (`'running'`):** the pane's foreground has been the agent's own kind for `SETTLE_MS = 3000` on end.
  - **Up (`'started'`):** a SessionStart came after all, heard or waited on.
  - **Fails at once:** the pane goes back to its shell after the agent ran (`but codex exited back to its shell`), or the window closes.
  - **Fails at the deadline:** after `sessionStartMs` (60 s) with no agent run in progress: `but codex did not come up within 60 s: <what it saw>`. What it saw is one of: `its pane stayed at the shell prompt`, `its pane ran <program> instead` (from the foreground leader's argv0, which `holding()` now returns for `other`), or `its pane could not be read (<err>)`. A failed look is recorded and the loop goes on; it never kills a window on a look that failed.
  - Every failure goes through `lay()`: dormant with `agent`/`revive`, window closed. The error is `<which> resumed codex session <id>, <why>, so it is dormant again with that session; revive it to see`.
- **Trust notice.** A terminal that is up without a SessionStart (`'running'`, or a kept pane running its agent) whose folder this machine does not trust gets `notice: 'codex waits at its "Trust this folder?" prompt in <which>; answer it there'`. The check is `trusted({ kind, ...resumeFolder(c, term, expandHome) })`, the same one Q2 uses. Its row is ok and the window stays open. Trust wording appears only there.
- The notice travels:
  - on the journal row (`DestinationJournal.activation[].notice`);
  - through `characterResults` into the `handover.activate` result (protocol: `notice` on each character);
  - on the daemon's and the controller's `handover.entity` rows (`notice?` on the event type);
  - into the CLI's reading: `✓ bo resumed; <notice>` on the row, and `! bo: <notice>` under the completed result;
  - into the sheet's resume row (`resumed; <notice>`, still `data-status="ok"`).
- `waitStart` gains `timed = true`. `wakeSlot` cancels its wait once the terminal is answered for, so no untimed waiter is left behind.

Guarantees from the last wave that still hold:
- each slot is judged on a fresh look;
- an error row is always dormant with `agent`/`revive` (every error path goes through `lay()`);
- a SessionStart heard with no waiter is kept in `heard` and answers a later wait at once.

The activation still starts nothing before the Commit (`runActivate` is unchanged up to `wake`) and never touches the source.

**Tests** (`packages/archid/test/handover/destination.test.ts`, "destination activate").
- New: "counts a resumed Codex up once its pane has run Codex through the settle, with no SessionStart, and keeps its window". dee's folder is trusted. The run must answer after 3–5 s of the fake clock, not 60 s; the result is `{ id: 'c_dee', ok: true }` with no notice, no `kill c_dee`, and the row carries the session id.
- New: "counts a resumed Codex up at its trust prompt where this machine does not trust its folder, keeps its window, and says the prompt waits there". No config: ok within 5 s, the notice matches `"Trust this folder?" prompt in dee's terminal`, no error, window kept, and bo's row has no notice.
- New: "names what a resumed Codex did when it exits back to its shell, and leaves it dormant with its session". Codex runs, then its pane goes back to bash. The run fails within 2 s with `codex exited back to its shell`, no trust wording, `kill c_dee`, and dormant with `agent`/`revive`.
- Changed: "leaves a resume that ends back at its shell dormant…" now also has dee never coming up. It expects `codex did not come up within 60 s: its pane stayed at the shell prompt`, and both terminals end dormant and uncarried.
- Changed: "names a resume that never reports back…" keeps only bo (Claude) silent. It asserts the error has no trust wording, and has bo's carried SessionStart clear the row. dee's old expectation, an error with trust wording, was the defect.
- Real tmux, new: "counts a resumed Codex that reports nothing up once ps has read it in its pane through the settle, and keeps its window". The resume enters `exec <bin>/codex 600`, a symlink to sleep, with no SessionStart. It must be ok with the trust notice, the pane read by `ProcessTable` as codex, and the session id on the row.
- `packages/cli/test/controller/handover.test.ts`, "carries what a character that came up still waits on in its terminal into its row and the result".
- `packages/cli/test/handover.test.ts`, "the human reading of what a resumed character waits on > says so on its row as it resumes and again when the handover completes".
- `apps/desktop/web/test/handover.test.ts`, "puts a character the destination brought up under Resuming…", now with a notice row.
- `apps/desktop/web/e2e/handover.spec.ts`, "the sheet carries a move…", now asserts ada's resume row reads `resumed; <notice>` with `data-status="ok"`.

**TDD RED**
```
$ pnpm vitest run --project archid packages/archid/test/handover/destination.test.ts -t "destination activate"      (scratchpad/cfix/q1-red.txt)
   × … counts a resumed Codex up once its pane has run Codex through the settle, with no SessionStart, and keeps its window
     AssertionError: expected 70000 to be less than or equal to 5000
   × … counts a resumed Codex up at its trust prompt where this machine does not trust its folder, …
     AssertionError: expected 70000 to be less than or equal to 5000
   × … names what a resumed Codex did when it exits back to its shell, …
     AssertionError: expected false to be true          (still waiting on a SessionStart after the exit)
   × … leaves a resume that ends back at its shell dormant with its session and a visible error
-   "error": StringMatching /codex did not come up within 60 s: its pane stayed at the shell prompt/,
+   "error": "dee's terminal resumed codex session 01a0cd02-…, which did not report its SessionStart within 60 s, so it is dormant again with that session; Codex was most likely waiting at its \"Trust this folder?\" prompt; revive it and answer that prompt there",
      Tests  4 failed | 18 passed | 37 skipped (59)
$ pnpm vitest run --project archid packages/archid/test/handover/destination.test.ts -t "reports nothing up once ps"   (HEAD's destination.ts; q1-red-real.txt)
   × destination activate on real terminals > counts a resumed Codex that reports nothing up once ps has read it in its pane through the settle, and keeps its window 10608ms
-   "notice": StringMatching /Trust this folder/,
-   "ok": true,
+   "ok": false,
$ pnpm vitest run --project cli packages/cli/test/controller/handover.test.ts -t "still waits on in its terminal"
   × the controller transaction > carries what a character that came up still waits on in its terminal into its row and the result
-     "notice": "codex waits at its \"Trust this folder?\" prompt in bo's terminal; answer it there",
$ pnpm vitest run --project cli packages/cli/test/handover.test.ts -t "resumed character waits on"
   × the human reading of what a resumed character waits on > says so on its row as it resumes and again when the handover completes
     → expected [ …(4) ] to include '  ✓ bo resumed; codex waits at its "T…'
$ pnpm vitest run --project @archipelago/desktop-web apps/desktop/web/test/handover.test.ts      (HEAD's src/handover.ts; q1-red-web.txt)
   × the handover a sheet follows > puts a character the destination brought up under Resuming, apart from its rest row
Expected: "resumed; codex waits at its "Trust this folder?" prompt in cy's terminal; answer it there"
Received: "resumed"
```
**TDD GREEN** (`scratchpad/cfix/q1-green.txt`)
```
$ pnpm vitest run --project archid packages/archid/test/handover/destination.test.ts -t "destination activate" --reporter=verbose
 ✓ … counts a resumed Codex up once its pane has run Codex through the settle, with no SessionStart, and keeps its window 318ms
 ✓ … counts a resumed Codex up at its trust prompt where this machine does not trust its folder, keeps its window, and says the prompt waits there 309ms
 ✓ … names what a resumed Codex did when it exits back to its shell, and leaves it dormant with its session 329ms
 ✓ … leaves a resume that ends back at its shell dormant with its session and a visible error 311ms
 ✓ … on real terminals > counts a resumed Codex that reports nothing up once ps has read it in its pane through the settle, and keeps its window 4283ms
      Tests  23 passed | 37 skipped (60)
$ pnpm vitest run --project cli packages/cli/test/controller/handover.test.ts -t "still waits on in its terminal"    Tests  1 passed | 63 skipped (64)
$ pnpm vitest run --project cli packages/cli/test/handover.test.ts -t "resumed character waits on"                Tests  1 passed | 50 skipped (51)
$ pnpm vitest run --project @archipelago/desktop-web apps/desktop/web/test/handover.test.ts -t "under Resuming"    Tests  1 passed | 21 skipped (22)
$ pnpm --filter @archipelago/desktop-web exec playwright test --config <ipv4 config> e2e/handover.spec.ts         8 passed
```

## Q3: a failed resume's error outlives the handover

**Existing mechanism.** No per-character error was in the fleet state:
- `hint` is a fixed enum (`codex-silent`) whose text the app computes;
- `scribeError` is fleet-wide;
- `terminalErrors` lives only in the page.

So I added a field.

**Change.**
- Protocol, `state.ts`: `resumeError?: string` on `TerminalSlot` and `Character`, so each terminal carries its own. It is optional and additive, and the state schema stays at v7. `portable-path.ts` classifies both as not-a-path (`NOT_PATHS`).
- Destination: `recordSlot` writes the row's error onto that terminal's record, or deletes it when the row is ok, before it writes the journal. That covers:
  - every failure `wakeSlot` records;
  - a retried activation that succeeds;
  - a carried SessionStart that later clears an error row while the journal is open.

  Complete closes the journal and leaves the record, so state.json keeps it.
- Fleet: whatever brings a terminal up again clears it:
  - `doRevive`;
  - `doOpenSecond`;
  - the poll's re-attach of a live window to a dormant main terminal;
  - `attachSlot`, for the second terminal in the poll and in `reconcile()`;
  - `reconcile()`'s main-terminal re-attach.

  `markDormant`/`markSlotDormant` leave it alone.
- App, all behind `handover.enabled` through `resumeErrorOf(s, slot)` in `selectors.ts`, which answers only for a dormant slot while `shell.handoverEnabled`:
  - `TerminalArea`'s dormant view shows it above "Revive <name>", for the main and the second terminal (`data-testid="resume-error"`), with the same markup as the existing terminal-error view;
  - the side card adds a `resume failed` row (`side-resume-error`) with the `.row` markup the settings card uses for the scribe's last failure;
  - the sidebar's `dormant` label carries it as its title;
  - the map token's `dormant` word carries it as its title.

  No CSS changed.

**Tests.**
- `destination.test.ts`, "names a resume that never reports back…": bo's record holds `resumeError` equal to its row's error, and ada's has none. Another session starting leaves the error; bo's carried SessionStart clears it.
- `destination.test.ts`, real tmux, new: "keeps why a resume failed on its character's record past Complete, until a revive brings that terminal up". This is the whole path with a real Fleet:
  - dee's Codex exits and its row fails;
  - `handover.complete` closes the journal;
  - `Store.readSnapshot(state.json)` still holds dee's `resumeError` next to its `revive`, and only dee has one;
  - `fleet.reviveCharacter('c_dee')` brings a window up, and state.json no longer holds the error.
- `fleet.test.ts`, new: "keeps why a resume failed on a terminal while it lies dormant, and lets it go once that terminal comes up".
  - Both terminals are dormant with an error, and polls leave it.
  - A revive clears only the main terminal's error.
  - `openSecond` clears the second terminal's.
  - A live window re-attached by the poll clears it too.
- `e2e/handover.spec.ts`, new, each restarting the daemon on a state.json with the error, as settings.spec does for `scribeError`:
  - "a character a handover could not resume says why where it shows as dormant, until a revive brings it up": the terminal area, the side card and the sidebar title show the error; Revive brings the surface up and the error goes from the page and from state.
  - "the map says why a handover could not resume a dormant character on its token": the token title, then gone once revived.
  - "…offers only its Revive while the fleet does not ask for handover": the flag guard, where Revive is shown and the text appears nowhere.

**TDD RED**
```
$ pnpm vitest run --project archid packages/archid/test/handover/destination.test.ts -t "never reports back|past Complete"   (q3-red.txt)
   × destination activate > names a resume that never reports back as its character error, …
-   "resumeError": "bo's terminal resumed claude session 3f2b8c1e-…, which did not report its SessionStart within 60 s, …",
   × destination activate on real terminals > keeps why a resume failed on its character's record past Complete, until a revive brings that terminal up
-   "resumeError": "dee's terminal resumed codex session 01a0cd02-…, but codex exited back to its shell, so it is dormant again with that session; revive it to see",
      Tests  2 failed | 59 skipped (61)
$ pnpm vitest run --project archid packages/archid/test/fleet.test.ts -t "keeps why a resume failed"
   × Fleet > keeps why a resume failed on a terminal while it lies dormant, and lets it go once that terminal comes up
-   undefined,
+   "x's terminal resumed claude session 3f2b8c1e-…, which did not report its SessionStart within 60 s",
$ playwright test --config <ipv4 config> e2e/handover.spec.ts -g "could not resume"           (q3-red-web.txt)
  ✘ … a character a handover could not resume says why where it shows as dormant, until a revive brings it up
    Error: expect(locator).toHaveText(expected) failed … waiting for getByTestId('resume-error')
  ✓ … offers only its Revive while the fleet does not ask for handover        (a guard: nothing to show, so it cannot go red)
$ playwright test … -g "the map says why"                    (HEAD's map/Token.tsx; q3-red-web-map.txt)
  ✘ … the map says why a handover could not resume a dormant character on its token
    Expected: "ada's terminal resumed codex session …"   Received: ""
```
**TDD GREEN**
```
$ pnpm vitest run --project archid packages/archid/test/handover/destination.test.ts -t "never reports back|past Complete" --reporter=verbose   (q3-green-archid.txt)
 ✓ … names a resume that never reports back as its character error, keeps the fleet, and clears it when the session starts after all 398ms
 ✓ … on real terminals > keeps why a resume failed on its character's record past Complete, until a revive brings that terminal up 2233ms
      Tests  2 passed | 59 skipped (61)
$ pnpm vitest run --project archid packages/archid/test/fleet.test.ts -t "keeps why a resume failed" --reporter=verbose
 ✓ Fleet > keeps why a resume failed on a terminal while it lies dormant, and lets it go once that terminal comes up 869ms
$ playwright test --config <ipv4 config> e2e/handover.spec.ts          (q3-green-web.txt)
  11 passed (10.4s)
```

## Playwright on this machine

An unrelated project's vite holds `[::1]:5173`, which I left alone. The daemon admits only `localhost:5173` and `127.0.0.1:5173` origins. So Playwright ran through `scratchpad/cfix/playwright.ipv4.config.ts`: the repo's config with vite on `--host 127.0.0.1` and `baseURL` `http://127.0.0.1:5173`. Nothing in the repo changed for it.

## Files changed

- Source:
  - `packages/protocol/src/handover.ts`, `messages.ts`, `state.ts`
  - `packages/archid/package.json` (export of `handover/sessions/registry`)
  - `packages/archid/src/handover/destination.ts`, `journal.ts`, `portable-path.ts`
  - `packages/archid/src/handover/sessions/types.ts`, `claude.ts`, `codex.ts`, `registry.ts`
  - `packages/archid/src/fleet.ts`, `reconcile.ts`
  - `packages/cli/src/controller/handover.ts`, `events.ts`
  - `packages/cli/src/commands/handover-view.ts`
  - `apps/desktop/web/src/handover.ts`, `selectors.ts`, `TerminalArea.tsx`, `SideCard.tsx`, `Sidebar.tsx`, `map/Token.tsx`
- Tests:
  - `packages/archid/test/handover/destination.test.ts`
  - `packages/archid/test/fleet.test.ts`
  - `packages/cli/test/controller/handover.test.ts`
  - `packages/cli/test/handover.test.ts`
  - `apps/desktop/web/test/handover.test.ts`
  - `apps/desktop/web/e2e/handover.spec.ts`

## Final suite results

At `2415ab4c`. The outputs are in `scratchpad/cfix/final-*.txt`.

- `pnpm typecheck`: exit 0.
- **archid:** 1167 passed, 3 skipped (70 files, 1 skipped), exit 0. No load flake this time.
- **cli:** 495 passed, 3 skipped (29 files), exit 0.
- **protocol:** 115/115, exit 0.
- **web unit** (`--project @archipelago/desktop-web`): 375/375 (31 files), exit 0.
- **Playwright, the whole suite:** 107 passed and 1 failed, `e2e/card.spec.ts:122` "the half card keeps the size it was dragged to, for the next character too". It fails on the drag-resize width check (511 against more than 575).
  - That test is intermittent here: on HEAD it passed 2 of 3 runs alone.
  - It also fails on base: with `apps/desktop/web/src` and `packages/protocol/src` checked out at `e96ee59b`, it failed 3 of 5 runs alone. The tree was restored to HEAD afterwards and is clean.
  - So it predates this wave and is not on the known-flake list; I did not investigate it further.

  The specs over the changed UI all passed: `handover` 11/11, `terminal`, `split`, `sidecard`, `map`, `board`, `drag` and `home`.

## Self-review

- **No spin in the settle loop.** A first cut raced the loop against a SessionStart wait whose own 60 s timer had already answered `false`, so under a fake clock that jumps a minute at a time it spun in microtasks until the heap ran out. The wait for a non-reporting kind is now untimed, and only the loop's own deadline ends it, so the race resolves only on a real SessionStart or on the sleep.
- **A slow Codex start is not cut short.** The deadline is only checked while no agent run is in progress. A Codex that appears just before 60 s gets up to one more settle (3 s) to count, rather than failing mid-run.
- **Every failure stays dormant.** Every Codex failure goes through `lay()`, as in the last wave. The kept-pane shortcut, a pane already running its own agent kind, still answers at once, and now also carries the trust notice when the folder is untrusted.
- **One folder rule on both sides.** Inspect and activation share `trusted()`. The folder they judge comes from `resumeFolder()`: through the manifest's path roots at preflight, and through `expandHome` on the destination's own state at activation.
- **Where the notice lives.** The notice is not stored on the character: the window it names stays open and shows the prompt itself. It lives on the row, the result, the CLI lines and the sheet row.
- **When `resumeError` is written and cleared.** It is written before the journal row, so a failed journal write, as in "answers only once every terminal … even when recording one fails", leaves the record ahead of the journal, never behind it. It is cleared by anything that gives the terminal a window, so a stale error cannot come back when that terminal goes dormant again later.

## Concerns

1. **Codex trust rules are modelled from memory of Codex's source, not checked against 0.156.1.** The model: trusted iff the cwd's real path, or its repository's main checkout, has `trust_level = "trusted"`. Gaps:
   - `repo.mainRoot` stands in for Codex's `dirname(git rev-parse --git-common-dir)`. They agree for main checkouts and linked worktrees, but not for a submodule.
   - A folder recorded `trust_level = "untrusted"` still warns and gets the notice, following the ruling's wording, though Codex may not ask there.
   - A config whose `approval_policy`/`sandbox_mode` suppresses the trust screen is not modelled. It would get a warning and notice it does not need.

   All of these err towards saying a prompt may wait when none does. None of them stops a Codex from counting as up.
2. **Wrapper scripts that do not `exec`.** The settle reads the pane's foreground leader, or a node launcher's codex child. A wrapper script that runs Codex without `exec` reads as `sh`, so that terminal fails after 60 s with `its pane ran sh instead`, which the error names. The Part C wrappers (`01b-remote-wrappers.sh`, `01d-mac-agents.sh`) do `exec`, so the on-machine re-run should see `codex`.
3. **Settle-period trade-offs.**
   - While a Codex settles, its pane is looked at every 0.5 s with a whole `ps -A`. With 4 Codex terminals starting at once that is about 8 `ps` per second for about 3 s.
   - A Codex that exits more than 3 s after it started counts as up, which the ruling accepts.
4. **Where `resumeError` is and is not shown.**
   - It travels in the exported snapshot. A character that was already dormant with an error keeps it across a later handover, until revived.
   - The phone views (`mobile/`) do not show it: they have no `handover.enabled` flag to gate it behind.
5. **One unreproduced failure.** During Q2, one whole-file run of `destination.test.ts` failed 1 of 56. The next two runs passed 56/56, and it passed in every run after that. I did not capture which test it was.
