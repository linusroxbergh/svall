# Final fix wave — Fixer C1 re-review (app, scripts, CI)

Scope: `48d0e51c..b7d94143` over apps/desktop (mac and web), scripts, test/, .github and README. Nothing in scope
changed after `b7d94143`. Verdict: **Approved.** One item is NOT ADDRESSED: the `host upgrade` half of C16, which is in
packages/cli and was handed to Fixer B. The new findings are four Minors.

## Verification

- A scratch copy (`git archive b7d94143`, with the worktree's node_modules and vendor/node linked in) passes the
  web and scripts projects (785 passed, 5 skipped) and both `tsc` projects, and it passes archid `release.test.ts`
  (33 passed, 2 skipped) and the three portability tests. `swift test` there runs 75 tests with 0 failures.
- The GNU tar staging test in `test/install-release.test.ts` passes on colima with `ARCHI_TEST_GNU_TAR=archi-it:machine`.
- actionlint (docker `rhysd/actionlint`) is clean on ci.yml. The four `pins.json` Node digests match nodejs.org's
  `SHASUMS256.txt` for v24.21.0, fetched today.
- Colima was stopped again with no containers left, and the docker context is back on `desktop-linux`.
- Each fix was mutated away in the scratch copy and its tests run:

| Mutation | Result |
| --- | --- |
| C18: `verifySignature` moved after the full unpack | fails "checks the signature … once, before anything else leaves the archive" (scripts and archid) |
| C18: name check removed | fails "refuses a release name no installer takes…", "installs an archive through it, name check first" |
| C18: SHA256SUMS before/after compare removed | non-gated suites **pass**; the GNU tar test fails with `staged` (the intruder's tree authenticates without it) |
| C18: `release.json` member check removed | fails "refuses an archive with no release.json of its own" |
| C18: version-mismatch check removed | fails "…a release.json naming another release" |
| C18: a directory source takes `verifyTree` without the signature | fails archid "refuses an unsigned release unless it is allowed" |
| C16: `rollbackTo: before`, or `back` ignoring `was === release` | fails both same-named reinstall tests |
| C17: no prune | fails "keeps it and the new one and no other", "keeps the release a rollback put current back on" |
| C17: prune also removes `back` | fails 3 scripts tests and archid "…keeping the one before" |
| C11: `readable` guard removed from `applyEvent` / from the store | fails the contract test and the replay test / fails the store test (`reading 'length'`) |
| C11: `interrupted` stops checking `safe` | fails "passes over a line missing any field it reads" |
| L22: hold check after the attach removed | fails "shows nothing an attach brings back once the freeze has begun…" |
| L23: `frozen` not retried | fails "retries an attach a frozen fleet refused…" |
| L23: no retry when the hold lifts | fails the L22 test, which covers the second attach |
| C31/L27: SIGKILL removed from `LineChild.stop` | HostProcess cancel test fails; the Handover quit test hangs |
| C31/L26: exit no longer joined with the end of stdout | **passes** (Minor 1) |
| C31: HostProcess stderr not captured | fails "what the child says on stderr is kept when no step failed" |
| C31: ControllerProcess `onExit` not suppressed while stopping | crashes RemoteConnectionTests (expectation fulfilled twice) |
| C15: `masterAnswers` guard removed | fails "no command is built while the master does not answer" |
| C13: fallback removed from the helper's exit | fails "a helper that dies before it says where a fleet with no gateway is…" |

## Items

| Item | Verdict | Note |
| --- | --- | --- |
| C11 (web) | ADDRESSED | `readable` requires every field `protocol/handover-events.ts` marks required and the sheet reads |
| C12 | ADDRESSED | `shell.info` is re-sent after `enable`/`remove`, with the gateway read fresh. The ShellRouter wiring has no test |
| C13 | ADDRESSED | |
| C14 | ADDRESSED | |
| C15 | ADDRESSED | Terminals 11+ keep working, and the report says why. See below |
| C16 | install-release half ADDRESSED; `host upgrade` message **NOT ADDRESSED** | `host.ts:506-511` still rolls back to `before` and says "the one it ran before" for a same-named reinstall. Handed to Fixer B |
| C17 | ADDRESSED | Keeps `current` and `back`. Dot-named in-flight folders are left alone |
| C18 | ADDRESSED | `stageArchive` is exported and typed. Every refusal from both old copies still holds; see below |
| C31 + L26, L27, L33 | ADDRESSED | L26 is fixed only in structure (Minor 1) |
| L22, L23 | ADDRESSED | A freeze this page does not follow retries only on reconnect (disclosed) |
| L28 | ADDRESSED | cli `parseDuration` takes `<n>ms` |
| L32 / I11 | ADDRESSED | Nothing reads `agentAdapters` from release.json. The spec's `agentAdapters` is `system.info`'s |
| L35 | ADDRESSED | Never run in Actions (billing) |
| L36 | ADDRESSED | Pins checked before the published digest. A signed build (`ARCHI_RELEASE_KEY`) rebuilds rsync from the pinned source |
| I12 | ADDRESSED | The doc mentions of the old paths (readiness.md, spike-results.md) are C2's |

## C18: the release trust path

`stageArchive` runs these steps in order: listing, member refusals (one release, no `.`/`..`/empty segment, no
backslash, no duplicate), the name check, the `release.json` member, SUMS+SIG extracted by name, the signature, the full
unpack, SHA256SUMS byte-equal to the checked one, `verifyTree` (digests, then the tree against release.json both ways),
and the version match. Nothing from the staging runs, and `tar` and `ssh-keygen` come from PATH.

Several ways around the check were tried by reasoning, and each is refused:

- **A link write over SHA256SUMS** (`d -> .`, GNU tar) is refused by the byte compare, as the GNU tar test showed.
- **A case-variant member** (`releases/v/sha256sums`) passes the case-sensitive duplicate check but overwrites
  SHA256SUMS on APFS. The byte compare refuses it too.
- **An overwrite of any other file** fails its digest against the SHA256SUMS the compare pinned.
- **A `releases` or `releases/<v>` symlink member** cannot replace the non-empty folder the by-name extraction already
  made, so tar exits non-zero.
- **An absolute or `..` link** is delayed by GNU tar and refused as a traversal by bsdtar.
- **Replacing both SUMS and SIG with another genuine signed pair** was accepted by the old second signature check. The
  byte compare refuses it, so it is strictly tighter.
- **An unsigned archive** that plants a SIG through a link stays `signed: false`.

## C15: the check-then-attach window

The window runs from the in-process `connect()` to ssh's own mux connect: the Ghostty spawn plus ssh start-up, tens of
ms. If the master dies inside it, ssh logs in on its own with `BatchMode=yes` to a destination the master checked a
moment earlier. That is the exposure the MaxSessions fallback for terminals 11+ already accepts, and ssh has no option
that removes one without the other. `ControlMaster=no` also stops a user's `ControlMaster auto` from making the surface
a master at the helper's socket path. After a dead master, the surface is remembered, and `rebuild()` re-attaches it on
the helper's next `online`, which the websocket closing over the dead forward triggers.

## New findings

1. **Minor. L26's guard test does not catch its bug.** Taking the stdout end out of `LineChild`'s `ended` group, so
   `onExit` follows the exit alone, passes all 43 HostProcess, ControllerProcess and Handover tests. The join is
   correct by construction, and the report says the race was never red.
2. **Minor. `LineChild.stop` spins the main run loop when it has to kill.** After SIGKILL, `waitUntilExit()` runs the
   main run loop. `HandoverSession` used to let go without waiting. Now, in `launch`/`observe`/`attach`, a wedged
   attach's `onExit` can run inside `following?.stop()` while `following === child`, and send the page a stray
   `handover.exit` as the next run starts. This needs an attach that ignores both stdin EOF and SIGTERM.
3. **Minor. C17 can prune a release a live process still runs from.** A daemon left running by `--no-launchctl`, or a
   long-lived `archi`, exports `ARCHI_RELEASE_ROOT=releases/<v>`. That folder is gone after two installs (disclosed).
4. **Minor. The C15 report overstates host-key checking.** It says `BatchMode=yes` "never … accepts an unknown host
   key", but an `accept-new` or `no` StrictHostKeyChecking in the user's ssh config still accepts one. The master reads
   the same config, so this adds no exposure, but Fixer C2's security-doc line should not repeat the claim.
