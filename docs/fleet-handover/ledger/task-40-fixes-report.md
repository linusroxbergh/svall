# Task 40 fix wave: report

Branch `experimental-remote-sessions`, on 44730499. Twelve commits, 5086cff1..f1bceb6b, one per item; not pushed.
Uncommitted: this report. `$S` below is the session scratchpad
`/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/3739c9b8-51d0-4aa6-ac32-19bc0b56eee0/scratchpad/t40f`,
where every before/after log named here is kept.

| Item | Commit | Subject |
| --- | --- | --- |
| F1 (M1) | 5086cff1 | A dormant second terminal keeps its agent through the end its window sends, and travels with a resume only while it has one |
| F2 (M2) | c2ed10eb | An agent's pid stays on the machine it ran on when the fleet is handed over |
| F3 (M3) | c8dfcee0 | A terminal resumes after a handover with the launch flags an idle close keeps, less a Codex profile or local provider |
| F4 (M4) | 349dfc8d | A second terminal whose pane reports no path keeps the directory it had |
| F5 (M5) | 13a1001d | archi doctor fails the two config layouts archid refuses to start on, through the check archid itself makes |
| F6 (M6) | 574c1738 | archi doctor checks that the program a fleet's plist runs is there, a release's archid as well as a checkout's tsx |
| F7 (M7) | e45b2767 | Tests cover a release's plist and shims, setup --check --release, and when a resume error shows |
| F8 (D1) | adcee29c | archid reads tmux's window and session listings on tmux 3.4 as on 3.7, whatever the locale it runs in |
| F9 (D2) | 8105272c | A release carries the bundled agent profiles, so a fleet it runs is seeded with them |
| F10 (D3) | 96dfa150 | A tmux row with no window name is never adopted, and no character the schema refuses is written |
| F11 (D4) | cb51e36e | archi host add looks for claude and codex on the PATH the companion's units run with, and holds each to its adapter's version floor and login |
| F12 | f1bceb6b | A release is named after its release tag, or its commit when only another tag such as ghostty-kit is there |

## Items

**F1.** `onSocketEvent` (`fleet.ts`) drops a SessionEnd for any slot without a window, the second included, so a
closed second terminal keeps its agent and the inventory carries its transcript. `importState` keeps a revive only
while the slot still has an agent; a second terminal whose agent is gone opens as a plain shell.
- Red: `sessions.test` "keeps the resume a terminal went dormant with…": the agentless second kept
  `claude --dangerously-skip-permissions --effort high --resume 7c1d…` instead of `''`. `fleet.test` "keeps a second
  terminal that ran an agent…": `expected undefined to be '3f2b8c1e-…'` after the term-2 SessionEnd.

**F2.** `exportSnapshot` deletes `agent.pid` and `second.agent.pid`. The forbidden-field test (`inventory.test`) now
carries a pid in both slots, asserts both agents leave without it, and that the live state keeps its own.
- Red: `expected { Object (kind, sessionId, …) } to deeply equal …` (pid still there).

**F3.** Ruling applied:
- The rest (`rest.ts`) builds its revive the way the idle close does: `startFlags` on the ps args of the agent process
  holding the pane, captured with the agent before any terminate, passed to `markDormant`/`markSlotDormant`. A launch
  `startFlags` refuses resumes with no flags.
- `importState` keeps every revive of a slot with an agent, rested or not, through `portableRevive` (`dormancy.ts`),
  which drops Codex `-p`/`--profile`/`--local-provider` and their values.
- Spec "Terminal records" amended in one sentence.
- Red: `rest.test` new case: `claude --resume 3f2b…` instead of `claude --dangerously-skip-permissions --effort 'high'
  --resume 3f2b…`. `sessions.test`: the rested case lost its flags, and the codex case kept `-p 'work' --local-provider
  'ollama'`.

**F4.** `attachSlot` takes `w.path || (slot?.cwd ?? '')`. Red: `reconcile.test`
`expected { unread: false, cwd: '', … } to deeply equal { cwd: '/side', … }`.

**F5.** `configRefusal(paths, has)` in `config.ts` holds both refusals as text. `initConfig` throws it as
`InvalidConfig`, and doctor's `config()` fails with it before reading any file.
- Red: with a fleet.json that parses beside a config.json, doctor answered
  `{ status: 'ok', detail: '/u/.archipelago/fleet.json and /u/.archipelago/node.json' }`.
- The two `toThrow(InvalidConfig)` assertions (M7) are in this commit. They passed before the change, as coverage.

**F6.** `plistRun` returns the first `ProgramArguments` string as `program`. `daemonPath` fails when it is gone, and
says "its program is there".
- Red: the ok detail still said "its checkout is there". The new release case (a gone
  `current/bin/archid`) fails the same run.
- `setup.test` round-trips a real `launchdPlist` through `plistRun`.

**F7.** Tests only, all green on arrival:
- `setup.test`: `plistCurrent` for a release, which is not current for another release or the checkout; a release
  shim relinked into another release is out of date; a release's shims are not the checkout's.
- `cli.test`: `setup --check --release` gives no shims warning for release links where `setup --check` does. A
  mutation forcing the checkout judgement made it fail.
- `selectors.test`: `resumeErrorOf` gives the error only with the flag on and no window; flag off, a window, or no
  slot give undefined.
- The second-slot and agentless revive cases are in F1.

**F8.** `-F` formats the daemon parses: `listWindows` and `listSessions` carry names and paths; `hasWindow`,
`attachSession` and `newWindow` read only ids.
- Both listings go through one `listing()` helper: fields and rows are marked with printable `<token>` and `</token>`
  made per call.
- `call()` passes `-u`: tmux 3.4 and 3.7c both print a tab, a newline or a letter outside ASCII as `_` to a client
  outside a UTF-8 locale.
- Tests:
  - unit tests on both output shapes (3.7c raw; 3.4 with control characters as octal escapes) for both listings;
  - the real-tmux listing test gains `åäö` and now lists with `LANG`, `LC_ALL` and `LC_CTYPE` empty.
- Red: the real Mac test under an empty locale gave `[[undefined, undefined, false]]` (3.7c prints the old `\x1f`
  separators as `_` there too), and the 3.4-shape window test failed.
- **Real tmux 3.4**:
  - colima was stopped; I started it, and stopped it again at the end. It had switched the docker context to
    `colima`, so I set it back to `desktop-linux`.
  - Image `archi-tmux34`: `ubuntu:24.04` + `apt install tmux` (3.4) + node v24.21.0 linux-arm64, sha256-checked
    against `vendor/node/SHASUMS256-v24.21.0.txt`.
  - The old (HEAD's) and new `tmux.ts` were bundled with esbuild around one probe (`$S/tmux34/probe-lib.ts`): the
    real-tmux test's dirs plus `a$b`, listed with no LANG at all.
  - Command, per bundle: `id=$(docker create archi-tmux34 node /tmp/run.mjs); docker cp -q run-$v.mjs
    $id:/tmp/run.mjs; docker start -a $id`. Full output is in `$S/tmux34/real-34.out`.

  ```
  old: windows listed: 1 of 7 — one row, windowId "@0\\037e32e…_keep\\037…", every other field undefined
       sessions: [["fleet_0_1790433894",null]]
  new: windows listed: 7 of 7; ids, panes and names exact
    c_0 "tab\there" -> "tab\there" exact
    c_1 "new\nline" -> "new\nline" exact
    c_2 "unit\u001fsep" -> "unit\\037sep" differs
    c_3 "row\u001e\nend" -> "row\\036\nend" differs
    c_4 "forged\u001e\n@9\u001f…" -> "forged\\036\n@9\\037…" differs
    c_5 "åäö" -> "åäö" exact
    c_6 "a$b" -> "a\\$b" differs
       sessions: [["fleet",0]]
  ```
- The probes behind the design, on both versions: `$S/tmux34/probe{,2,3,4}*.out`, and the 3.4 and 3.5a
  `server_client_print` source in `$S/tmuxsrc`.

**F9.** `release-stage.mjs` stages `packages/archid/agent-profiles` (in `DIRS` and `stageAssets`). The full
release-build test now compares `hooks`, `home`, `systemd` and `agent-profiles` in the installed release with the
checkout. Red: `ENOENT … releases/0.0.0-test/agent-profiles`.

**F10.**
- `reconcile` adopts no row without a name, a pane id and a path, so no row the listing could not split.
- `Store.update` checks every character a patch touches against `Character` and throws before writing or telling
  anyone.
- Red: `reconcile.test` `expected { c_caosbi: … } to deeply equal {}`. `store.test`
  `expected [Function] to throw an error`.

**F11.**
- `host add`'s agent steps run `env PATH=<unit PATH> <bin> …` over ssh. The PATH is `unitPath` for
  `<archiBase>/current`: the one the units and `host doctor` use.
- Main's `AGENTS` supplies the binary, `versionOk` floor, `loginArgs`/`loggedIn` and `loginHint`. `env`'s exit 127
  means not installed. The login-shell `WHICH` probe for agents is gone.
- Red: six host tests failed; the new ones found neither CLI ("not installed") where the unit's PATH holds both.

**F12.** `describeVersion(repo)` runs `git describe --tags --match 'v[0-9]*' --always --dirty`. `build.sh` takes its
VERSION from `describeVersion()` instead of its own `git describe`, so both builds and the app name one release.
- Red: `expected 'ghostty-kit-83-ge7321aa7-dirty' to be '10394f5'`.
- This tree now names itself `e7321aa7-dirty`, measured before the rebase that folded the F5 fixture in.

## Verification (f1bceb6b)

| Command | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm vitest run --project protocol --project archid --project cli --project @archipelago/desktop-web` | 189 files passed, 1 skipped; 2943 passed, 6 skipped |
| per project | protocol 137; archid 1558 passed, 3 skipped; cli 540 passed, 3 skipped; web 708; scripts 26 |

- Baseline at 44730499, same command: 2926 passed, 6 skipped.
- Under load average 9–10, `fleet.test` "keeps the home island out of world layout" failed once (home island w 14,
  not 11). It passed 3 of 3 alone.
- One of five `--project archid` runs had 1 failure whose name the grep did not keep. The other four and the combined
  run were green.
- Swift and Playwright were not run: nothing in them changed.

## Concerns

1. **tmux 3.4 values.**
   - Fields and rows now split on both versions and in any locale.
   - But 3.4 prints a control character in a name or path as an escape (`\037`, `\r`), and a `$` followed by
     another character as `\$`. It does not escape a backslash (VIS_NOSLASH), so the text cannot be decoded
     unambiguously, and the daemon keeps it as printed.
   - A pane in such a directory gets that text as its `cwd` on Linux.
   - A fix, if wanted: before listing, replace backslashes server-side with a per-listing placeholder
     (`#{s/…/…/:pane_current_path}`), then decode. Not done.
2. **The store guard throws inside `update`.**
   - A mutation that would write an invalid character now fails the whole update. The poll and recovery log it.
     At start, a reconcile that tripped it would fail the start; with F10's filter, reconcile only adopts rows
     that make a valid character.
   - The full suites found no path that trips it.
3. **Destination `lay()`.** A wake that fails still lays the slot dormant with `markDormant(c)`, which drops flags a
   rested revive carried. This matches main's behaviour after any failed revive; left.
4. **Release tags.** `v[0-9]*` is my choice of release-tag shape; no release workflow exists yet (Task 37). Until one
   tags a release, every build is named by its commit.
5. **Colima.** Started for F8 and stopped afterwards, with the docker context set back to `desktop-linux`. The
   `archi-tmux34` image stays in colima's disk for a rerun.

Status: DONE_WITH_CONCERNS — 5086cff1..f1bceb6b; typecheck clean; vitest 189 files / 2943 passed, 6 skipped;
tmux 3.4 container run 7 of 7 windows (old: 1 garbage row); tmux 3.4 prints control characters and `$x` in paths
escaped.
