# Task 39a report: docs, error catalogue, migration and downgrade, SMOKE, copy and release notes

Status: **DONE_WITH_CONCERNS**. BASE a2da2e3f; my nine commits are interleaved with Task 38a's in the same worktree:

| Commit | Subject |
| --- | --- |
| 469e5321 | The remote machines docs list every blocker, warning and error a handover, host or recover command reports, and a test fails when the code has one the list lacks |
| 5135a8ab | The remote machines docs say what a Linux machine needs, how to add it and make it a gateway, how a handover moves a fleet and what restarts, and what to know when one stops part way |
| 8a60fdcb | The remote machines docs say what the upgrade changes in each fleet home, and how to go back to an older release with the copies it kept |
| 1edc82ab | The remote machines docs have release notes for the feature |
| 0d07da9e | The Mac app has a smoke test for remote machines: … |
| dee440ba | The README points at the remote machines docs, lists the handover settings, and says archi and the daemon run from the installed release rather than the clone |
| 49d1d213 | The machines panel and the handover sheet say what a machine needs and what a handover moves before the first run, … |
| 7a83d84e | The error catalogue covers a root holding an agent's login or the ssh folder, and host commands refusing an ssh destination that now reaches another machine |
| d2fdceb9 | The handover docs describe the live probe as it runs and what a new agent release can break, linking the security notes |

Every commit named its own paths (`git commit -- <paths>`). I changed no file 38a changed, and no protocol file.

## What each doc covers, and where

All user docs are in `docs/remote-machines/`:

| File | Brief item | Covers |
| --- | --- | --- |
| `README.md` | 1, 5 | What the feature is, the flag, the index, a four-step "in short", and how it is distributed: from source, no signed/notarized app, no signing key, no first-run self-install (the ruling). |
| `setup.md` | 1 | Supported machines (macOS 15+, Ubuntu LTS x86-64/arm64, systemd user services, linger, tmux/Git/rsync, Tailscale, agent minimums), the same home path (why, `useradd -m -d` / `usermod -d -m`, the 59-byte limit from 38a's 730a1c4f, parents outside the home), turning the flag on, Add Machine step by step (app and `archi host add`) with the actions left to the user, the companion release (arm64 needs `pnpm release:companion --arch arm64` + `--release … --allow-unsigned`, since a `desktop:install` build pins only linux-x64), `archi host enable`, doctor/upgrade/remove/forget, `setup --rollback`, logs, and what is installed where on both machines. |
| `handover.md` | 1 | The sheet's five sections and every choice; the CLI (flags, Ctrl-C, `i`/`c`, `--detach`/`attach`, exit codes); what moves and what stays (data, secrets, entity docs, agent profiles, sessions, excludes; pids, tmux ids, logins, file history, node.json, keys stripped or left); agents (minimum 2.1.251 / 0.155.0, no maximum, the fixture + live-probe process for a new release, trust and bypass prompts); what restarts (rest rules with the 3 min wait and 10 s settle, revive flags, the shell notice, dormant stays dormant, failed resume); working on the remote fleet; recovery by `status` (pre-commit abort, post-commit retry, dropped link 49–108 s, unreachable gateway, divergence); force-owner disaster recovery; known limitations. |
| `errors.md` | 2 | The catalogue (below), with the before/after-commit rules and the phase table. |
| `migration.md` | 3 | `config.json` → `fleet.json`/`node.json`, schema 8 / protocol 17 with the kept `state.json.v7-*`, `owner.json`/`machine.json`, source-checkout shims → release links and launchd agents on `current`, `--replace-settings`, named fleets (per-fleet split, per-fleet enable, the seven names that are commands now). Downgrade: what the older build does, the exact restore steps, the relabel alternative, and upgrading again. |
| `release-notes.md` | 5 | New, changed, requirements, not yet. |

Known limitations collected in `handover.md#known-limitations`: two controllers driving one handover, the orphaned Begin, saved tool output naming the other machine's folder (only when `CLAUDE_CONFIG_DIR` differs, since Task 41 made paths identical), `/rewind` not reaching back, the 49–108 s give-up after a dropped link, the fleet running nowhere after a drop right after the commit of a move to the Mac, the trust/bypass prompts, a rebuilt journal forgetting the user's choices (36b), terminals past sshd's ten sessions (M2 parked), a SIGKILLed controller's orphaned master (37a), the phone not showing the resume error (M3 ruling), and the version-1 scope.

Also:

- `apps/desktop/mac/SMOKE.md` (item 4): **created**; no smoke doc existed anywhere in the repo (only ledger task-40 smoke briefs). It covers provisioning, both directions, worktrees, agent resume, a foreground blocker (and agent interrupt and keep-here), a changed destination copy with Archive, network failure before and after the commit in both directions, controller kill and relaunch before and after the commit, and re-attach after an ssh drop, on a named test fleet `smoke`, pointing at `m3b-env.md` for a fully isolated run.
- `README.md` (item 5): a `## Remote machines` section, a `handover` row in the configuration table, and a "What leaves your Mac" bullet. See concern 1 for the other lines it changed.
- Web copy behind the flag (item 5): the machines panel shows what the machine needs before the first run (`host-intro`); the handover sheet shows what a handover moves before anything is shown (`handover-intro`) and where to set up a gateway when the fleet has none (`handover-no-gateway`); `blockerHint` gains lines for `incompatible_release/protocol/schema`, `agent_cli_missing`, `agent_logged_out` and `agent_hooks_missing`. Unit tests (2 new) and e2e assertions (1 new test, 2 extended) were written first and failed before the copy.

## The catalogue's exhaustiveness check

`packages/cli/test/error-catalogue.test.ts` (cli project, 14 tests). For each list it reads the codes from the code and
the rows under one heading of `errors.md`, and asserts the two sets are equal (nothing missing, nothing stale) and that
no code is listed twice:

| Heading | Read from |
| --- | --- |
| Handover phases (10) | `HANDOVER_PHASES` (protocol) |
| Blockers and warnings (41) | `HandoverIssueCode.options` (protocol) |
| Daemon refusals (8) | `HandoverError.options` code literals (protocol) |
| Gateway answers (13) | `AUTHORITY_ERROR_CODES` (archid gateway) + every `new AuthorityFailure('…')` in `gateway/client.ts` (`timeout`, `disconnected`) |
| How a run ends (6) | `Outcome`'s `status` members in `controller/events.ts` |
| Standing (7), Action (4) | `Standing` and `Verdict.action` in `controller/recovery.ts` |
| Events (8) | every `event: 'handover.*'` in `controller/events.ts` |
| Connection errors (6) | `SshErrorKind` in `controller/ssh.ts` |
| Step statuses (5), Steps (24) | `StepStatus` and every `run.step('…')` in `controller/host.ts`, plus `AGENT_KINDS` |
| Doctor checks (24) | every check `name:`, `failed('…')` and `unitCheck('…')` in `commands/doctor.ts` and `controller/host.ts`, plus `AGENT_KINDS` |
| What the gateway holds (5), Results (3) | `Held.state` and `recover.result` in `commands/fleet-recover.ts` |

Mutation checks, each restored after: removing the `claude_bypass` row fails "Blockers and warnings"; adding a
`handover.bogus` row fails "Events"; adding `'bogus'` to `SshErrorKind` in `ssh.ts` fails "Connection errors". Each
failed exactly its own case, 13 others passing.

38a catch-up: I pulled in 38a's commits through 4c671f4d. Its new checks added no code (the test stayed green), but
changed meanings, which 7a83d84e covers: `path_unsupported` now also means a root holding an agent's login/config or
lying in or holding `~/.ssh` (89a8ec19); host upgrade/remove/enable refuse an ssh destination that reaches another
machine (69c0c268, in the `master`, `uninstall` and `authority` steps); the `home` step's 59-byte limit and the
doctor's `gateway` EINVAL cause (730a1c4f). Links to `docs/security/fleet-handover.md` (38a's 4c671f4d) resolve;
`handover.md` links its "Agent versions" section rather than repeating it.

## Downgrade proof

Scripts and logs in the scratchpad
`/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/89928d60-3853-43e3-b6cb-3e149e9baba0/scratchpad/`:
`dg-env.sh`, `dg-phase1.sh`, `dg-phase{A,B,C,D}.sh`, `dg-logs/phase{A,B,C,D}.out`, the migrated snapshot
`dg-migrated.tgz`, and the older build in `main-src/` (`git archive origin/main`, protocol 16, state 7,
`pnpm install --frozen-lockfile --offline`).

Isolation: every process ran under `env -i` with `HOME` a scratchpad folder reached through a short link
(`/private/tmp/claude-502/adg`, removed afterwards) so the sockets fit, a PATH of `node`, `tmux` and a `claude` double
that answers only `--version` and `auth status` (no real claude or codex), `ARCHI_APP_DEST` in that HOME, setup
`--no-launchctl` only, ports 47893/47894 (never 47800). No process was left running; the real `~/.archipelago`,
`~/Library`, launchd, `~/.claude*`, `~/.codex` and `~/.ssh` were not touched.

- **Phase 1 (upgrade).** main's `archi setup --no-launchctl`; main's archid made a private fleet (two characters, one
  renamed `made-on-main`) and a named fleet `work` (with its plist from main's own `setupHome`), state 7. Then this
  branch's `archi setup --release <32ee1745 tree> --allow-unsigned --no-launchctl` (release under
  `.local/share/archipelago`, both plists → `current/bin/archid`, shims → relative links, private `config.json` →
  `.bak` + `fleet.json` + `node.json`), and HEAD's archid (tsx) on both homes: "state.json migrated to version 8;
  version 7 kept at …/state.json.v7-…", `work` split at its start, `owner.json` written. A third character
  `made-on-branch` was added. (The installed release is the M3b-gate build 32ee1745 from this branch; migration code
  is unchanged since, and the migration itself ran on HEAD.)
- **Phase A (older build, nothing restored).** main's setup wrote `config.json` = `{}` (default port and settings),
  pointed the private plist back at the clone, **left `work`'s plist on `current/bin/archid`**, and **wrote its shim
  script through `~/.local/bin/archi` into `releases/32ee1745/bin/archi`**. main's archid on both homes logged
  `state.json is version 8, newer than this archid reads (7): update archipelago …; or, to go back to the fleet as this
  version last saw it, move …/state.json.v7-<ts> to …/state.json; archid starts once it is fixed`, wrote no port file
  and waited; `state.json` stayed version 8.
- **Phase B (the documented restore).** In each home: `fleet.json node.json owner.json` → `handover-aside/`,
  `config.json.bak` → `config.json`, newest `state.json.v7-*` → `state.json`; `rm ~/.local/bin/archi{,pelago}` and the
  named plist. main's setup then kept `config.json` (port 47893), wrote fresh shim scripts (the release's `bin/archi`
  untouched) and the private plist; main's archid started both fleets on 47893/47894 at state 7 with `made-on-main`
  and without `made-on-branch`. Upgrading again with `config.json` left in place split it into a **new fleet id**.
- **Phase C (relabel).** v8 `state.json` with `"version": 7`, config restored: main's archid started and listed all
  three characters, `made-on-branch` included.
- **Phase D (upgrade again, set-aside files back).** After B plus an edit on main, `rm config.json`, `handover-aside/*`
  back, this branch's setup + archid: same fleet id, port 47893, state 8, the edit kept.

`migration.md` states the result, the exact files, and the steps, including "bring every fleet home" for a fleet with a
gateway, since an older build knows nothing of ownership.

## Verification

- `pnpm typecheck`: clean.
- `pnpm vitest run --project protocol --project archid --project cli --project @archipelago/desktop-web --project
  scripts` at 4c671f4d + my d2fdceb9 working tree: 197 files passed, 1 skipped; 4373 tests passed, 5 skipped, 0 failed.
  An earlier full run failed 2 (archid `api.test.ts` "never writes the daemon token…", 38a's cae6fb82 test landing
  during the run, and the known `fleet.test.ts` revive flake); both pass alone and the later full run was clean.
- `pnpm --filter @archipelago/desktop-web exec playwright test`: 156 passed. `host.spec` + `handover.spec` failed 3
  before the copy and passed 17/17 after.
- Swift: unchanged, not run.
- Every `archi` command and flag in the docs checked against the commander definitions (`host add|list|doctor|
  upgrade|remove|enable`, `handover` and its flags, `fleet recover --force-owner|--confirm|--gateway`, `char update
  --keep-here|--no-keep-here`, `setup --rollback|--replace-settings|--release|--allow-unsigned`, global `-p`, `--host`,
  `--json`), and every path against `paths.ts`, `linux/setup.ts`, `gateway/authority.ts`/`bin.ts`, `install-release.mjs`
  and `recovery.ts`.

## Concerns

1. **README lines beyond the pointer section.** The brief asked for a short section; I also corrected lines this
   branch had made false: "Keep the clone where it is, because `archi` and the daemon run from it" (they run from the
   installed release), the uninstall list (it also removes the installed releases) and "Run it before you delete the
   clone …". Revert them if the owner wants the README untouched here.
2. **An older build writes through this release's shim links.** main's `setup` does `writeFileSync` on
   `~/.local/bin/archi`, which follows the link into `releases/<version>/bin/archi`; and main's `launch` never rewrites
   an existing named-fleet plist, which would re-migrate a restored fleet. Old builds cannot be changed, so
   `migration.md` removes the links and named plists before the older install; a reinstall of the newer version
   replaces the damaged release dir.
3. **Doc facts only the machines can confirm.** I did not run the arm64 companion command, the SMOKE timings ("about a
   minute" to re-attach after the link returns, "within two minutes" to give up), or the new sheet copy in the built
   app. 39b and the owner's by-eye pass should read SMOKE.md and the three new texts (`host-intro`, `handover-intro`,
   `handover-no-gateway`) and the six new hints.
4. **The catalogue test reads type unions from source text.** `Standing`, `SshErrorKind`, `StepStatus`,
   `Verdict.action`, the `Outcome` members, `Held` and `recover.result` have no runtime list, so the test reads them
   with regexes. A reformat that breaks a regex fails the test loudly (empty set or mismatch), never passes silently.
   Exporting runtime arrays would be sturdier but touches controller files 38a works in.
5. **Not catalogued:** the daemon's `unauthorized` (a phone viewer calling a transaction method; not a
   `HandoverError`, and no user flow reaches it).
6. **Downgrade relabel.** Documented as an alternative that worked in the test; a field whose type changed between
   schemas would make the older build drop that character (it keeps `state.json.broken-<time>`), which the doc says.
