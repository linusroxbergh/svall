# Task 39a review

**Verdict: Needs fixes.** 0 Critical, 4 Important, 7 Minor.

Reviewed the nine 39a commits (469e5321 … d2fdceb9) in `.superpowers/sdd/plan/review-39a.diff`, the final docs at HEAD
e67d3a1c, against the brief, the spec and the code. Commands were run from the checkout under a temp HOME. The
catalogue test was mutated in a `git archive d2fdceb9` copy with its own workspace links, so protocol changes counted.

## Spec and brief compliance

| Item | | Notes |
| --- | --- | --- |
| 1. User docs: hosts, prerequisites, same home path | ✅ | `setup.md`; one wrong line about non-LTS (m1) |
| 1. What transfers and what stays | ✅ | `handover.md` table matches `inventory.ts:228-259` (docs, profiles, `home.cwd`, `.env` only on request; fleet home otherwise refused) |
| 1. Agent versions, fixture + live probe process | ✅ | minimums, fixture dirs, `sessions-live.test.ts` env vars all exist |
| 1. Restart semantics | ✅ | 3 min / 10 s, dropped Codex flags, shell notice text all match code |
| 1. Ledger known limitations | ✅ | all seven the brief names, plus 36b/37a/M2/M3 ones |
| 2. Catalogue of every code, with recovery | ✅ / ❌ | content complete; "exhaustive by construction" has silent holes (I4); two recovery recipes wrong (I2, I3) |
| 3. Migration notes, downgrade proven | ✅ | run is real; logs match the doc |
| 4. `apps/desktop/mac/SMOKE.md` | ✅ | covers every listed area; one expected result cannot happen on the stated machine (I1) |
| 5. README section, gated copy, release notes | ✅ | copy behind `handover.enabled`; README corrections right |
| Ruling: the gate stays | ✅ | docs describe the flag; nothing removes it |
| Ruling: no first-run self-install | ✅ | `docs/remote-machines/README.md:32-37` and release notes say so |

## Important

### I1. "ready for handover" after a doctor run: the CLI never prints it, and the app never shows it on stock Ubuntu 24.04

- `docs/remote-machines/handover.md:9-10`: "check that `archi host doctor <name>` says **ready for handover**".
- `docs/remote-machines/setup.md:126`: `archi host doctor` / Check "Ends with **ready for handover** when nothing fails
  or is left to do".
- `apps/desktop/mac/SMOKE.md:27`: "choose **Check**: it ends with **ready for handover**".

Evidence:

- `archi host doctor` prints `machine <name>` and the check lines, and nothing else (`packages/cli/src/commands/host.ts:96-103`).
  Only the step flows (add, upgrade, remove, enable) print "ready for handover" (`host.ts:55-61`).
- The app's Check shows it only when every check is `ok` or `skip` (`apps/desktop/web/src/host.ts:66-70`). The
  companion's doctor on stock Ubuntu 24.04 warns on:
  - tmux 3.4 (`doctor.ts:76`). The docs call 24.04 the tested release and say 3.4 "works otherwise".
  - `gh` missing (`doctor.ts:159`).
  - `path`, because the ssh command's PATH lacks `~/.local/bin` (`doctor.ts:90-93`, `pathEnv: process.env.PATH`).

  So SMOKE step 1.2 fails as written on the machine SMOKE asks for.

Fix: say the machine is ready when `archi host doctor` shows no ✗, or when Check lists no failed step. Add that
warnings about tmux 3.4, `gh` or PATH do not block a handover. Or make the CLI doctor print the verdict and count only
failures. Either way, docs and code should agree.

### I2. An unattended `--detach` run does not stop and give the fleet back: it waits, frozen

- `docs/remote-machines/errors.md:51-52`: "Without a person to ask (`--json`, `--detach` with nobody attached), the
  run stops with `blocked` and gives the fleet back."
- `handover.md:65` says the same right after the `--detach` bullet.

Evidence:

- `decide` returns `'cancel'` only when the process is not the helper (`packages/cli/src/commands/handover.ts:198`).
  The helper awaits `decisions.ask()` until an attached client answers or cancels (`handover.ts:196-205`, `:209-221`).
- The controller awaits that answer with no timeout (`packages/cli/src/controller/handover.ts:798`). A blocker found
  while resting, transferring or verifying therefore leaves the source frozen until someone runs `archi handover
  attach` or opens the app.
- This is the behaviour the sheet relies on (`handover.md:25`, `:37-39`), so the catalogue line is the one that is
  wrong.
- Only a foreground `--json` or non-TTY run cancels and gives the fleet back.

Fix: "a foreground run with no terminal to ask (`--json`, or stdin not a terminal) stops with `blocked` and gives the
fleet back. A `--detach` helper waits with the fleet frozen until `archi handover attach` or the app answers or aborts
it. `archi handover status` shows it open."

### I3. The "remove and add again" recoveries leave the fleet with no gateway, and a moved fleet then stuck at `generation_mismatch`

- `errors.md:58`, `identity_mismatch`: "A machine id that changed (a reinstalled machine): `archi host remove <host>
  --forget`, then `archi host add` again."
- `errors.md:90`, `home_mismatch`: "`archi host remove <host>`, then `archi host add` at that account."

Traced in code, not run:

1. `host remove` (with or without `--forget`) strips `gatewayMachineId` from every fleet that named the machine
   (`packages/cli/src/controller/host.ts:590-596`). After the add, the fleet has no gateway until `archi host enable`,
   which neither recipe names.
2. A reinstalled machine, or a new account, holds no record. `host enable` then creates one at generation 0
   (`packages/archid/src/gateway/authority.ts:105`) and checks only the owner (`host.ts:630-633`).
3. A fleet that has moved at least once holds generation ≥ 2 in this Mac's `owner.json`. Preflight blocks on
   `owned.generation !== record.generation` (`controller/handover.ts:227-229`).
4. `errors.md:59`'s fix for that block ("restart the source's daemon: on start it takes the gateway's record") cannot
   work: "A lower one never rolls ownership back" (`packages/archid/src/ownership/state.ts:56-62`).

Fix:

- Name `archi host enable <host> --fleet <fleet>` after the add, in both rows.
- Add that a fleet that has moved before then needs `archi fleet recover --force-owner local`, which writes above every
  generation seen.
- In the `generation_mismatch` row, say restarting helps only when the gateway is ahead.
- Better still, route a reinstalled gateway to [When the gateway is lost](../../remote-machines/handover.md) and run
  the sequence once on the M3b pair before 39b.

### I4. The catalogue test misses new codes whose names hold `_`, `-` or a digit, and union members named by alias

- `packages/cli/test/error-catalogue.test.ts:464,467,471,473` match `[a-z]+`, `handover\.[a-z]+` and `[a-z ]+`.
- `union()` (`:430-434`) keeps only quoted literals.
- In the d2fdceb9 copy, each of these plants passed 14/14:
  - a step `'agent-login'`, and a step `'rsync2'`;
  - an Outcome `status: 'timed_out'`;
  - an event `'handover.gave_up'`;
  - a doctor check `'gh-auth'`;
  - `SshErrorKind = TunnelKind | 'auth' …`.
- A planted `HandoverIssueCode` and a removed `claude_bypass` row each failed exactly one case.
- The codebase already names codes this way (`host_key`, `daemon_down`, `finish-abort`).
- Report concern 4 says a reformat "never passes silently". That holds for existing entries, but not for new ones.

Fix:

- Match `'([^']+)'` in each of those regexes.
- Make `union()` throw when the text between `=` and `;` is anything but `'…'` literals joined by `|`.
- Add a planted-code case for a regex-read list to the test.

## Minor

1. **Non-LTS Ubuntu.** `setup.md:11` says "another Ubuntu release is a warning". Only a non-LTS release warns (`host.ts:141-143`);
   22.04 passes. `errors.md`'s `os` row is right. Say "a release other than an LTS is a warning".
2. **Enable step count.** `SMOKE.md:28` says "Both steps are ok". Enable runs three steps, `machine`, `authority` and `fleet`
   (`host.ts:675-689`), shown under Connect and Service.
3. **Quoted status text.** `SMOKE.md:105` quotes `("running here as pid N")`. `status` prints "A handover of this
   fleet runs here as pid N; …" (`commands/handover.ts:419`, `handover-view.ts:224`).
4. **Upgrade suggested for an unregistered machine.** `errors.md:274`, the `identity` step, says "`archi host upgrade
   <host>` when the protocol differs". During an add the machine is not in the registry yet (registry is the last step,
   `host.ts:380`), so upgrade stops at `no machine … in the registry` (`host.ts:396`). Suggest `archi host doctor` and
   adding it again.
5. **Agent steps claim more than they check.**
   - `errors.md:276` says the `codex` step includes "trusting its hooks", but the step checks only version and login.
     Hook trust appears only in the not-logged-in action (`host.ts:238`).
   - `setup.md:76` says the agent steps check "recent enough". Claude has no `minVersion` in `archid/src/agents.ts`, so
     only preflight's adapter floor applies (`sessions/claude.ts:11`).
6. **`brew install gh` on Linux.** 37b's report routed "Copy on Linux" to Task 39 (`task-37b-report.md:207-210`). The
   companion doctor still tells Ubuntu to `brew install gh` (`doctor.ts:159`), which `archi host doctor` and Check
   show. Fix it in code, or record why it is deferred.
7. **Unclear wording.** `handover.md:194` says "A killed app or controller stops nothing it had not already reached".
   Suggest: "Killing the app stops nothing, since the helper runs on. Killing the controller leaves the handover where
   it stopped. The journals say where that is, …"

## Verified clean

- **Commands** (`--help` under a temp HOME): every one the docs give.
  - `host add|list|doctor|upgrade|remove|enable` and their flags.
  - `handover` with `--interrupt-after`, `--terminate-shells`, `--archive`, `--resume`, `--abort`, `--forget` and
    `--detach`, plus `status` and `attach`.
  - `fleet recover --force-owner|--confirm|--gateway`.
  - `char update --keep-here|--no-keep-here`.
  - `setup --rollback|--release|--allow-unsigned|--replace-settings`.
  - The global `-p`, `--host` and `--json`.
  - `island create <name>`.
  - `pnpm release:companion --out --arch` and its `archipelago-companion-<version>-linux-<arch>.tar.gz` output.
- **Paths:**
  - Fleet home files (`paths.ts`).
  - Unit names, per-fleet unit files and `log/<unit>.log` (`linux/setup.ts`).
  - The gateway's `fleets/`, `authority.sock` and `recoveries.ndjson`. The 59-byte limit is 107 minus the 48-byte
    suffix.
  - `machine.json` and `machines.json`, `controller/handover.log`, and `controller/recoveries.ndjson`.
  - The fixture dirs, the live-probe env vars and the `#agent-versions` anchor.
  - Every relative link and anchor in the new docs resolves.
- **Numbers:**
  - 3 min and 10 s (`rest.ts:72-73`).
  - 30 s, and 15 s × 3 (`ssh.ts:11,143`, `authority.ts:4`).
  - A 16 s backoff for `unreachable` and `daemon_down` only (`connection.ts:18-20`).
  - 128 MiB (`messages.ts:326`) and 5 GiB (`host.ts:32`).
  - 2.1.251 and 0.155.0.
  - The default excludes (`inventory.ts:35`).
  - Protocol 17, state 8, and `state.json.v7-<time>` (`store.ts:46`).
  - `config.json` → `.bak` before the split, and `handover.enabled` defaulting to false (`config.ts:66-90`,
    `protocol/handover.ts:88-93`).
- **Downgrade proof:**
  - The scratchpad scripts and `dg-logs/phase{A,B,C,D}.out` exist and match `migration.md` line for line: the empty
    `config.json`, the shim written through the link into `releases/32ee1745/bin/archi`, the named plist left on
    `current`, the version-8 refusal, the restore, the relabel and the re-upgrade with the same fleet id.
  - The older build's `archi <name>` does write a missing named plist (`main-src/packages/cli/src/launch.ts:54`), as
    step 4 says.
  - Its reconcile adopts stray tmux windows, so terminals left running across the downgrade are not lost.
- **Catalogue:** 14/14 pass at HEAD. The runtime-read lists (phases, issue codes, daemon refusals, gateway codes) fail
  on a plant. So does a removed row.
- **Web copy:**
  - `host-intro`, `handover-intro` and `handover-no-gateway` are accurate, and render only inside `HostSetup` and
    `HandoverSheet`, which return null without `handover.enabled`.
  - Removing the six new hints fails the two new unit tests. The web handover suite passes 26/26.
  - `pnpm typecheck` is clean.
- **README:**
  - `archi` and the daemon do run from `current` (setup, `desktop-install.sh`).
  - Uninstall removes the releases (`archid/src/uninstall.ts:99,165`).
  - Dropping "run it before you delete the clone" is right.
  - The config row's keys match `FleetConfig.handover`.
- **Writing:** plain and for a user. `migration.md` and the release notes describe change because change is their
  subject. There are no ticket ids or revision notes.

## Re-review of fix round 1

**Verdict: Approved.** Every finding is addressed. New issues in the fix diff: 0 Critical, 0 Important, 1 Minor,
plus 1 Minor out of scope.

Scope: e3e8e26e, ffdc6d76 and cd684bc6 (`.superpowers/sdd/plan/review-39a-fix1.diff`). 38a's 8828eb30 and e216eb69
and its uncommitted `install.ts` and test files were left alone.

| Finding | Verdict | Evidence |
| --- | --- | --- |
| I1 | ADDRESSED | See the note after this table. |
| I2 | ADDRESSED | `errors.md` and `handover.md` now separate a foreground run with no terminal (cancel, `commands/handover.ts:154,198`) from a `--detach` helper. The helper waits frozen at a blocker found after Checks (`:199-205`, `controller/handover.ts:798`). A blocker found at Checks still ends `blocked`. |
| I3 | ADDRESSED | See the note after this table. One narrow case is still wrong (N1). |
| I4 | ADDRESSED | Rerun in a `git archive cd684bc6` copy with its own workspace links. Baseline 15/15. Each plant failed exactly its own case (1 failed, 14 passed): step `agent-login`, Outcome `timed_out`, event `handover.gave_up2`, check `gh-auth`, `SshErrorKind = TunnelKind \| …`, `Standing = Extra \| …`, `Held` state `gone-for_good2`, and `AuthorityFailure('time-out2')`. `literals()` refuses anything but `'…'` joined by `\|`. |
| m1 | ADDRESSED | `setup.md:11` now says "a release other than an LTS is a warning" (`host.ts:129,141-143`). |
| m2 | ADDRESSED | SMOKE 1.3 names `machine`, `authority` and `fleet`. |
| m3 | ADDRESSED | SMOKE 8.2 quotes "runs here as pid N". |
| m4 | ADDRESSED | The `identity` row now says: ssh there, run `~/.local/bin/archi version --json`, then add the machine again. It no longer suggests `upgrade` for an unregistered machine. |
| m5 | ADDRESSED | The `codex` row and `setup.md` step 5 match `controller/host.ts:221-240` and `agents.ts:30`. |
| m6 | ADDRESSED | `doctor.ts:158-159` names `sudo apt install gh` on Linux and `brew install gh` on a Mac. `doctor.test.ts` asserts the Linux line. `error-catalogue` and `doctor` tests pass 54/54 in the worktree. |
| m7 | ADDRESSED | The `handover.md` wording separates killing the app from killing the helper. |

**I1 note.**

- The CLI doctor gives no verdict (`commands/host.ts:96-103`). The docs now say: no ✗, and warnings about
  `tmux`/`gh`/`path` do not block a handover.
- The app's Check does end "Check: done" when there are warnings and no failure. Doctor checks carry no action
  (`ControllerProcess.swift:303`), so `runActions` is empty (`web/src/host.ts:63`), and `readyForHandover` needs every
  step ok or skip (`:66-70`).
- SMOKE 1.2 and `setup.md:126` agree with this.
- The step flows still print "ready for handover" (`commands/host.ts:59`), so `setup.md:80` stays right.

**I3 note.** Re-traced the new "A gateway set up again" section:

1. `host add` under the same name and destination keeps the entry (`claimName`) and swaps in the new id at the
   registry step (`controller/host.ts:380-383`).
2. `host enable` creates the record at generation 0 (`authority.ts:105`) and re-points `fleet.json`.
3. Preflight's generation check (`controller/handover.ts:227-229`) and "never a lower one"
   (`ownership/state.ts:56-62`) give `generation_mismatch`.
4. `fleet recover --force-owner local` writes above both.

The fixer's scratchpad `i3.out` shows the same with a local gateway:

- a restart keeps generation 2 against a record at 0;
- recover writes 3;
- a restart keeps 3.

The `generation_mismatch` row's new "gateway behind the source" clause is right. The fleet-ran-there paragraph holds
for the same destination: add does not check fleet ownership, so the three commands run.

### Fixer's concerns

1. **`host.ts:453`'s home message.** The docs are right regardless. `home_mismatch` points to the new section, and the
   section's steps work.
   - If the account was moved with `usermod -d -m` (same user name), machine id and records move with the home. Then
     `host enable` finds the record, and no recovery follows.
   - The code messages are incomplete, though. Both `controller/host.ts:453` and `archid/src/handover/inventory.ts:184`
     say "remove, then add" with no enable. See N2.
2. **Traced and run locally only.** Acceptable for docs. The trace above agrees with the code, and the local run
   exercises the generation arithmetic. Running add, enable and recover once against a reinstalled companion on the
   M3b pair belongs in 39b.
3. **New user name while the fleet ran on the lost machine.** This is real, and the new section gets it wrong. See N1.

### New in the fix diff

- **N1 (Minor): a new user name and a fleet that ran there leads to a dead end.** `handover.md` "A gateway set up
  again" says:
  - "An account under another user name is another ssh destination: run `archi host remove studio` first, with
    `--forget` if the old account can no longer be reached".
  - "If the fleet was running on that machine, run the same three commands".

  When both hold, `host remove` refuses, `--forget` included. Its `fleet` step runs first and refuses a fleet another
  machine owns (`controller/host.ts:556-559`). Its action, `archi handover local`, cannot work with that machine lost.

  Traced path that works: `archi host add studio2 --ssh <new destination>`, then `archi host enable studio2 --fleet
  <fleet>`, then `archi fleet recover --force-owner local`, then `archi host remove studio --forget`. By then no fleet
  names the old id, so the `fleet` step passes.

  Add one sentence saying so. It is the narrowest disaster case, so this is Minor.
- **N2 (Minor, out of scope, code): the home messages omit enable.** `controller/host.ts:453` (doctor's `home` check)
  and `archid/src/handover/inventory.ts:184` (`home_mismatch`) still say only "remove, then add". Add "then `archi host
  enable`", or point at `docs/remote-machines/handover.md#a-gateway-set-up-again`, the next time 38a's files are open.

### Also checked

- **Links:** all 38 relative links and anchors in the remote-machines docs, SMOKE and README resolve, including
  `handover.md#a-gateway-set-up-again`.
- **Catalogue test:** `fieldValues(RECOVER, 'result')` now parses every `result:` in `fleet-recover.ts`. A future
  `result: someVar` there fails the catalogue with "not a union of string literals". That failure is loud, not silent,
  so this is not a finding.
