# Task 38a review

**Verdict: Needs fixes.** Critical 0, Important 5, Minor 9.

The m6 far check is sound against an unpinned key, a digest mismatch and `--allow-unsigned`. Two paths still get around
it: the far shell's PATH, and a repeat `host add`. The audit also missed a destructive `host remove` case, a set of
GPL-3 files in the app, and a spec clause that one of its accepted risks waives.

## Spec and brief compliance

| Item | | Note |
| --- | --- | --- |
| 4. m6: far check against the installed release's pinned signers, before staged code runs | ❌ | I1, I2; M1, M2 |
| 1. Threat model: aliases, argv, file names, symlinks, stale authority, path confusion | ✅ | ProxyCommand `%h`/`%r` and alias checks tested. I5 is the one spec gap; M7, M9 minor |
| 2. Secrets per channel, agent logins and `~/.ssh` blocked | ✅ | Every channel cites a test that exists and asserts absence. Gaps: M3, M4 |
| 3. Destructive sites traced and refusal-tested | ❌ | I3; M5, M6 |
| 8. Licences and notices, build check | ❌ | I4; M8 (owner items) |
| 9. Permissions, Tailscale, uninstall | ✅ | Log folder 0700, fleet home and keys at 0600, nothing served past loopback (checked by reading the code) |
| Carried: Mac rollback kickstart, 59-byte home, probe every fleet | ✅ | Correct, minimal, and each test fails without its fix |
| Doc `docs/security/fleet-handover.md` | ✅ with M5, M8, M9 | All ~55 test names it cites exist |

## Important

**I1. The far check runs whatever the far login shell's PATH finds, after `cd` into the staged release.**
`packages/cli/src/controller/install.ts:134-143`. `VERIFY` starts with `cd "$1"` and then calls `grep`, `ssh-keygen`
and `sha256sum` by bare name. If the far account's PATH for a non-interactive ssh command holds a relative entry
(`./node_modules/.bin`, `bin`, `.`, or an empty `::` entry) ahead of `/usr/bin`, those names resolve inside the
uploaded tree. Staged code then runs before the check and decides its outcome.
Reproduced in scratch with the script verbatim:
- tree: junk `SHA256SUMS` and `.sig`, plus `node_modules/.bin/{ssh-keygen,sha256sum}` shims;
- run: `PATH="./node_modules/.bin:$PATH" sh verify.sh <tree> <allowed_signers>`;
- result: the shim ran (marker file written), the check printed `pinned` and exited 0.

This is the "staged code runs first" case the brief asked for. It needs a PATH setting that is not the Ubuntu default
but is a known dev habit.
*Fix (test first):* start `VERIFY` with `PATH=/usr/bin:/bin; export PATH`, or call `/usr/bin/ssh-keygen` and
`/usr/bin/sha256sum`. In `host.test.ts`, run the far machine with a relative PATH entry and a staged
`node_modules/.bin/ssh-keygen`, and assert that shim never runs.

**I2. A repeat `host add` reinstalls over an installed release without the far check.**
`packages/cli/src/controller/host.ts:356-360` calls `bootstrapSetup` without `installed`.
- `claimName` accepts the same name at the same destination ("its probes run again"), and spec line 335 says
  repeated setup is idempotent.
- So `archi host add trift --ssh trift.test`, or the app's Add Machine run again to repair, installs a new release
  with only the controller's check and the staged archive's self-check. That is exactly the case m6 closed for
  `host upgrade`.
- The doc's "A first install has no installed release" (`docs/security/fleet-handover.md:57-58`) is true only for a
  machine with no `current`.

*Fix (test first):* in the install step, ask `currentRelease(master, remote.archiBase)`. When it answers, pass
`installed: remote.archiBase`. Test: `host add` onto a `farMachine` that pins `signer.signers`, with an archive
signed by `intruder`, runs no `setup`.

**I3. `host remove` uninstalls a machine that currently owns a fleet through another gateway.**
`packages/cli/src/controller/host.ts:541-556`. `gatewayFleets` looks only at fleets whose `gatewayMachineId` is the
machine being removed.
- A fleet handed to trift, with a third machine as its gateway, is never examined.
- `archi uninstall` then runs there: it stops the fleet's daemon and unit and kills its tmux server, so its running
  agents die. The authority still names trift as the owner.
- Reproduced in scratch by adding to `host.test.ts`
  `fleetAt('.archipelago-lab', { gateway: OTHER_MAC, owner: REMOTE })`: the far calls are
  `[archi version --json]` then `[archi uninstall]`, and the result is `ready`.
- The doc's destructive table (line 107) states the guard only for "a fleet naming this gateway", so this site's
  authorisation has a hole.

*Fix (test first):* also refuse when any local fleet's `cachedOwner` or `readRoute` names `entry.id`, whatever its
gateway, and name `archi [-p <profile>] handover local` as the action.

**I4. The app ships Ghostty's GPL-3 shell integration with no notice and no GPL text.**
- `apps/desktop/mac/build.sh:26` copies `vendor/ghostty-kit/share/ghostty` into `Contents/Resources/`.
- That tree holds `shell-integration/bash/ghostty.bash`, `zsh/.zshenv` and `zsh/ghostty-integration`. Their headers
  read "based on Kitty's … integration. Kitty is distributed under GPLv3, so this file is also distributed under
  GPLv3."
- It also holds `bash/bash-preexec.sh` (MIT, Ryan Caloras).
- `apps/desktop/mac/NOTICE` names neither, and no GPL-3 text ships.
- `test/app-notice.test.ts` walks only the objects in `libghostty-fat.a`, so its "fails on any component the NOTICE
  lacks" does not reach `Resources/`.
- The doc's open items (lines 130-138) miss this too.

*Fix:* name "Ghostty shell integration (bash, zsh; derived from Kitty), GPL-3.0" and "bash-preexec, MIT" in the
NOTICE, and ship `COPYING` (GPL-3) and bash-preexec's licence beside it. The scripts are their own source. Extend the
test to fail on any `Resources/ghostty/**` file whose header names a licence the NOTICE does not. Otherwise leave
`shell-integration` out of the bundle if the app never injects it.

**I5. The accepted "gateway machine id not checked" contradicts the spec.**
Spec line 511 lists "source, destination or gateway identities/generations disagree" among preflight's blockers. The
doc (lines 211-215) and report accept the risk instead.
- The reasoning is sound: a wrong gateway has no record, so Begin refuses.
- The real exposure is narrow. A gateway that is also the destination shares the master whose `connection-info`
  identified it (`Masters.for`), so only a third-machine gateway, or the daemons' own `fleetAuthority` ssh
  (`packages/archid/src/gateway/client.ts:165-175`), goes unidentified.
- The stated cost, "touches every controller test that fakes ssh", is test upkeep, not a runtime reason. At runtime
  it is one `archi version --json` per gateway master.

This is the owner's call. Either add the check (the `sameMachine` from `69c0c268`, once per gateway master in
`authorityOp`) or amend spec line 511. It is not the implementer's to waive.

## Minor

**M1. A missing signers file reads as "pins no signer".** `install.ts:136`: `grep -s` on a missing file is false, so
the check prints `unpinned` and exits 0. Scratch: a tree signed by an unpinned key passed with a nonexistent signers
path. It is reachable only on a broken install. *Fix:* `[ -f "$2" ] || exit 5`, with its own message.

**M2. The far check does not tie the verified release to the version asked for.** A release signed by a pinned key
can be replayed under another `releases/<v>` name, which is a downgrade. Scratch: a copy of `good` under `v999`
printed `pinned` and exited 0. *Fix:* pass the expected version as `$3` and require `release.json` (covered by
`SHA256SUMS`) to name it. Or accept it in the doc.

**M3. The agent-login and `~/.ssh` guard is lexical on the destination, and leaves out Archipelago's own install.**
- `inventory.ts:140-145` resolves the destination's paths with `realPath` on the source's filesystem. The
  destination's claim (`replicas.ts:310` `clash`) guards only its fleet home.
- So if the destination's `~/.ssh` is a link into a folder that is a root, the root is not blocked. An `archive`
  choice would then move the real keys and `authorized_keys` aside.
- The machine-local set also leaves out `~/.local/share/archipelago` (the gateway's authority records),
  `~/.config/systemd/user` and the shims. A root of `~/.local` or `~/.config` passes preflight, and an `archive`
  choice renames the gateway's records aside.

*Fix:* have the destination's `clash` refuse roots that hold or lie in its own real `~/.ssh`, agent login files and
Archipelago prefix, as it does for the fleet home.

**M4. Credentials outside the agent homes travel silently, and only the configured agent home is blocked.**
- `~/.config/gh/hosts.yml`, `~/.netrc`, `~/.git-credentials`, `~/.aws/credentials` and `~/.docker/config.json`
  carry no blocker or warning in a root. A repository `.env` gets `env_file`.
- Spec line 486 makes credentials and dotfiles machine-local.
- `machineLocal` uses `CLAUDE_CONFIG_DIR`/`CODEX_HOME` *instead of* `~/.claude`/`~/.codex`. A daemon env that differs
  from the shell's (the doctor's `daemon env` warning) leaves the default login unguarded.

*Fix:* block both the default and the configured locations. Warn, via `release-scan`'s `CREDENTIAL_FILE` list, on
the others. Or list them as accepted.

**M5. The destructive table misses sites, and one refusal cell names a positive test.** Missing rows:
- `sessions/registry.ts:69-86`, writing into the destination's agent home. It overwrites only an equal file or a
  strict prefix; tested by `sessions.test.ts` "refuses a copy the destination continued on its own…".
- Activation's replacement of `state.json` and `fleet.json` (`store.ts:94`, `destination.ts:525`).
- `tmux kill-window` at rest (`rest.ts:353`) and at activation (`destination.ts:746`).
- The `fleet recover --force-owner` record write.

"Upload leftovers" (line 105) cites "deletes the archive it uploaded…", which proves the deletion, not a refusal.

**M6. The `.`/`..` encoding of controller transaction folders is untested.** Doc line 102 claims "`.` and `..` are
encoded" and cites `recovery.test.ts`, whose test uses an ordinary id. Mutation in a scratch copy: with
`progress.ts:11`'s `.replace(…)` removed, the whole `cli` project still passes (1437 passed; the 1 failure is
`--version` in a non-git copy). Without it, `clear('..')` would `rm -rf` the controller's state folder. *Fix:* a test
that `transactionDir('..', base)` stays under `base/handover` and `clear('..')` leaves `base`.

**M7. After the identity check, a command can still reach an unchecked machine.**
- `ssh.ts:181` passes the real destination to every `master.run`. If the master has died, ssh falls back to a fresh
  connection that nothing identified.
- rsync already avoids this with `archi-remote.invalid` (`rsync.ts:19`).
- `enableHost`'s `provisionCopy` (`host.ts:649`) opens a second master without `sameMachine`, and that step can
  re-key `owner.json`.

*Fix:* use the `.invalid` host for `run` as rsync does, and run `enable`'s two steps on one checked master.

**M8. Two of the owner's licence items are not quite accurate.**
- **Item 1:** "MIT, BSD, zlib, libpng and Apache-2.0 ask for their texts". zlib, libpng and BSL-1.0 (utfcpp) make
  no demand of binary copies. MIT, BSD, Apache-2.0 and FTL do.
- **Item 2, libintl (LGPL-2.1):** the LGPL also needs its own text and libintl's source (or a written offer) shipped,
  as rsync's now is. The relinking material has to reach recipients, not the public, so "only once the repository is
  public" overstates it.
- **Item 3, Flaticon:** accurate.
- **Fragile object regexes:** `app-notice.test.ts` maps generic object names (`log`, `version`, `timer`, `print`,
  `st`, `empty`) to components. A new dependency with such an object would be attributed silently.

**M9. The doc does not record two deviations, and the report overstates the doc.**
- Spec line 286 says installers verify "before the archive is unpacked". Both the controller (`inspectCompanion`) and
  the far machine unpack first, and doc line 62 presents that as design, not as a deviation.
- The report says each of its eight accepted items is in the doc's "Accepted risks". Three are not: an archive member
  outside `releases/<v>`, a version name from the archive, and the phone page's whole closure.
- Case collisions are folded with `toLowerCase` only (`probe.ts:20`). Names that differ only by Unicode
  normalization (NFC/NFD), which APFS treats as one file, reach the transfer; nothing covers that at preflight.

*Fix:* add the deviation and the three items to "Accepted risks". Fold `normalize('NFD')` into `caseCollisions`, or
accept it.

## The three accepted risks

- **Gateway machine id:** a spec deviation; see I5.
- **A root swapped for a symlink mid-transfer:** acceptable for version 1. Both sides need a process running as the
  user, which the trust model trusts, and the source side is caught at verification.
- **The Linux lock name squatted by another account:** acceptable for version 1. It is a denial of service only, and
  Node has no `flock`. The stated reason is thin, though: under systemd, `restart` stops the old daemon before the new
  one starts, so a key mixed into the name would not open a window during an upgrade. Reword the reason, or mix in a
  0600 nonce from the home.

## Verified clean

- **m6 against a signature from an unpinned key:** refused, exit 3 (scratch run of the script with real ssh-keygen,
  and the host test).
- **m6 against a digest mismatch:** refused, exit 4.
- **m6 against an extra unlisted file:** it passes the far check, but only files `SHA256SUMS` lists run before the
  staged archi's own two-way `verifyRelease`.
- **The far check is load-bearing:** removing it fails 5 tests (4 in `host.test.ts`, 1 in `install.test.ts`).
- **`--allow-unsigned` and the no-key fallback** each say what they checked in the `install` step.
- **c9387b13:** there are no bare requires left, the real build loads none of the planted modules, and the scan
  refuses one.
- **69c0c268** on remove, upgrade and enable. Refusing `%`, `$`, backticks, `;`, `|` and `'` in destinations
  prevents CVE-2023-51385.
- **89a8ec19** on the source: `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honoured, and a folder inside an agent home
  stays allowed.
- **Secrets tests:** the api log, upgrade events and manifest tests would each fail on a leak.
  `connection-info` never quotes its answer back.
- **562b562b:** mode 0700 on a log folder left open.
- **3e920585:** home 0700, keys and `hooks.sock` 0600.
- **b5c162af:** kickstarts only Archipelago labels, and `--no-launchctl` restarts nothing on either OS.
- **730a1c4f:** 107/103 bytes is right for `sun_path`, and 59/60 bytes is the right boundary.
- **e3e67b2e:** probes every `archipelago-archid@*` unit and names the silent one.
- **Licences in the build:** `packageLicence` fails the build on a package with no licence file, `http_ece`'s kept
  text is MIT upstream, the rsync tarball digest is checked before the cached-binary return, and the font OFL names
  both copyright holders.
- **Uninstall table:** matches `uninstall.ts` (releases, current, companions and log removed; gateway records kept;
  purge only for folders holding `fleet.json` or `config.json`).
- **Tailscale:** handover and host code only probe for `tailscale`.

## Runs

- 15 touched test files, all green: `install` and `host` 86 passed and 1 skipped; the other 13 files 298 passed,
  including the real build, the rsync controller build and the object walk.
- Mutations and repros ran in a scratch `git archive 4c671f4d` copy with its dependencies linked, and in a scratch
  directory for the verify script.
- The worktree is untouched apart from this file.
