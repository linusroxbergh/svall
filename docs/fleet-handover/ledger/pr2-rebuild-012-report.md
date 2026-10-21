# PR #2 test environment rebuilt at `2ab80fda`: report

Status: **DONE_WITH_CONCERNS**.

Both sides now run `2ab80fda`, which is PR #2 on Svall 0.12.0 (branch `pr2-v3`): the Mac test HOME and `svall-m4` on
linus-vault.
- The Mac still owns the private fleet at generation 2, and the gateway record still names it.
- The Linux fleet home is still a fenced copy ("starting read-only").
- Every snapshot compare against step 1 is 0 DIFF.
- No app was opened and nothing was handed over.

The concerns are hazards of the environment, not of the build. LaunchServices registered the installed test app by
itself, and the linus-vault baseline is gone (see Surprises).

`S` = `$TH/kit` = `/Users/Shared/svall-m4/kit`. Logs are `$S/logs/2ab80fda-*.log` and `$S/logs/cmp-*.txt`, and
snapshots are in `$S/snaps/`. A rebuild at a new commit is `sh $S/rebuild.sh <commit>` (below).

| Step | Result |
| --- | --- |
| 1 Before (13:03Z) | PASS: Mac `a84bf57d` protocol 22 stateSchema 9; both m4 units `a84bf57d`, kept `a84bf57d b31fe003`; gateway g2 naming the Mac |
| 2 Build (13:05:36–13:08:45Z) | PASS: 3 archives scan `ok`; app 0.12.0, CFBundleVersion 724, protocol 23, stateSchema 9, unsigned |
| 3 Mac (13:09Z) | PASS: `a84bf57d` app kept in `$S/app.noindex/a84bf57d/`; `system.info` `2ab80fda` protocol 23 stateSchema 9; owned by the Mac at g2; snapshot 0 DIFF |
| 4 m4 (13:10Z) | PASS: `host upgrade m4` `ready` in 17 s; both units `2ab80fda`, kept `2ab80fda a84bf57d`; gateway g2 naming the Mac; doctor shows no ✗ |
| 5 Preflight | SKIPPED: the CLI has no checks-only mode |
| 6 Docs | `pr2-onmachine-env.md` updated in place |

## 1. Before (`logs/2ab80fda-1-before.log`)

- The test daemon was pid 36262, checked by its arguments (`…/svall-m4/Applications/Svall.app/Contents/Helpers/node
  …/runtime/svalld.mjs`, since Oct 13 09:24) and written to `$S/run/svalld.pid`.
- `system.info`: `a84bf57d protocol 22 stateSchema 9`. `ownership.get`: generation 2, owner
  `bfa140ac-…` (the Mac), not frozen, transaction `committed`.
- `units-far.sh`:
  - `svall-gateway.service` active, pid 2883802, and `svall-svalld@private.service` active, pid 2883792, both on
    `releases/a84bf57d`.
  - `current -> …/a84bf57d`, kept `a84bf57d b31fe003`.
  - Fleet daemon `a84bf57d protocol 22 stateSchema 9`, generation 2, owner the Mac, no tmux server.
  - Gateway record `{"fleetId":"fa4f67ae-…","generation":2,"ownerMachineId":"bfa140ac-…"}`.
- Snapshots `2ab80fda-before-mac` and `2ab80fda-before-linux`.
  - They hold the characters, islands, state, `fleet.json`/`owner.json`, and git and files of the carried folders.
  - New fields: `roots` (each replica record, baseline hashed) and `terminals` (the tmux windows with folder and
    command).
  - The Mac: 7 windows (`_keep`, 5 shells, shell's second), 9 roots `sealed` at g2. Linux: 9 roots `sealed` at g2,
    no tmux server.

## 2. Build (`$S/build/2ab80fda/summary.txt`; logs `2ab80fda-2-build.log`, `-21-install` … `-25-app-build`)

- **Snapshot.** `git archive 2ab80fda` into `$S/build/2ab80fda/src`, then `git init`, a fetch of the commit from the
  main repository and `git reset --mixed`. `describe` reads `2ab80fd`, 724 commits, and `git status` is empty before
  and after the build.
- **Vendor caches.** `ghostty-kit`, `node`, `tmux` and `sparkle` came from the main checkout: kit
  `332b2aef…-r1` (`ghostty-kit.sh current` passed), node v24.21.0, tmux 3.7c, Sparkle 2.10.0. `vendor/rsync`
  (3.4.4-arm64) came from `pr2-final`. The build pins match `a84bf57d`'s, and `scripts/` differs only in compat and
  spike files.
- **Build environment.** `env -i` with the owner's HOME (pnpm's store, `~/.npmrc`), PATH
  `/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, and the user TMPDIR.
- **Steps.** `pnpm install --frozen-lockfile`. Then `scripts/release-build.sh --out $S/rel/2ab80fda --version
  2ab80fda --url-base https://github.com/linusroxbergh/svall/releases/download/2ab80fda`, with `SVALL_RELEASE_KEY`
  unset. Then `release-scan.mjs` over the three archives, and `SVALL_RELEASE_NAME=2ab80fda pnpm app:build`. The app
  was copied to `$S/app.noindex/2ab80fda/Svall.app`, and `codesign -v` reports it valid.
- **Warnings**, the same benign three as the round trip: an `.npmrc` variable missing under `env -i`, vite's chunk
  size, and SwiftPM's sparkle cache.

| Archive | Bytes | sha256 | Scan |
| --- | --- | --- | --- |
| `svall-companion-2ab80fda-linux-x64.tar.gz` | 46,399,896 | `c4d0545fa9df9008c9e0896e863dcdd0981c0da6963d2c91a3fdc159d6298ea8` | ok, 328 files |
| `svall-companion-2ab80fda-linux-arm64.tar.gz` | 46,082,141 | `7a430fd89d8112b1180e724db80d38432d28e6ff8ac45559920e76d49594bab5` | ok, 328 files |
| `svall-controller-2ab80fda-darwin-arm64.tar.gz` | 42,659,771 | `8537ec7071f18e78472740fd0c4f21ffba4cab888185a4c880621ca298a1d8be` | ok, 332 files |

- **The app.** `CFBundleShortVersionString` 0.12.0, **CFBundleVersion 724**.
  - `release.json`: `2ab80fda`, darwin-arm64, protocol 23, stateSchema 9, transferSchema 1, authoritySchema 1, node
    v24.21.0, `unsigned: true`.
  - Its own linux-x64 companion has sha256 `a01de9160c5b26ad3f2324a8c829e41eba1415ad63e595c5cc9ca2b977bb65ab`.
  - That companion's unpacked tree is identical to release-build's x64 one (0 `diff -rq` lines). The archives differ
    as before (tar mtimes).

## 3. The Mac (`logs/2ab80fda-3-mac.log`, `-3-mac-health.log`)

- `r3-mac.sh 2ab80fda` ran at 13:09:06Z. It stopped svalld 36262, then moved the installed app (`a84bf57d`, 816) to
  `$S/app.noindex/a84bf57d/Svall.app`.
- It installed with `11-install.sh 2ab80fda`. The bundled CLI's `setup --no-launchctl --agents claude,codex,opencode`
  wrote the plist, hooks, home rules and skills, the OpenCode plugin and the shim under `$TH`. Its `version` printed
  release `2ab80fda`, protocol 23, state schema 9.
- `mac-daemon-start.sh` started svalld 1514 on 127.0.0.1:47871, with version `0.12.0 (724)`. It re-attached the tmux
  server 21066, which survived the restart: tmux 3.7c in both builds. The new control client is 1558.
- After: `system.info` reads `2ab80fda protocol 23 stateSchema 9`. `ownership.get` reads generation 2, owner the Mac,
  not frozen, `committed`.
- **Snapshot** `before → mac`: **0 DIFF**. The new build adds nothing the snapshot sees:
  - setup rewrote the home files with the same content;
  - `state.json` keeps schema 9;
  - the windows, roots and characters are unchanged, the 3 real agents dormant with the same `revive`.

## 4. m4 (`logs/2ab80fda-4-m4.log`, `-4-m4-health.log`)

`r4-m4.sh 2ab80fda` = `12-upgrade.sh` (`host upgrade m4 --json`, 13:10:08Z):
- `machine`, `master`, `release` (`2ab80fda` for linux-x64 from the app's companion, unsigned), `upload`, `install`,
  then the probe "m4 answers on release 2ab80fda". Result `ready`, exit 0, in 17 s.

`units-far.sh` after:
- `svall-gateway.service` active, pid 2339711, and `svall-svalld@private.service` active, pid 2339700, both on
  `releases/2ab80fda`.
- `current -> …/2ab80fda`, **kept `2ab80fda a84bf57d`** (`b31fe003` dropped).
- Fleet daemon `2ab80fda protocol 23 stateSchema 9`, generation 2, owner the Mac, not frozen, no tmux server. Its log
  says "starting read-only: bfa140ac-… owns this fleet at generation 2", so the Linux home is still a fenced copy.
- Gateway record unchanged: generation 2, naming the Mac.

`host doctor m4`:
- No ✗.
- ✓ release "2ab80fda, protocol 23; this controller runs 2ab80fda, protocol 23". Also ✓ for svalld, systemd, gateway,
  linger, hooks, codex hooks, the OpenCode plugin and the shims.
- ! tmux 3.4, claude and codex not signed in, path, gh.

Snapshots `before → after`: Mac **0 DIFF**, linux **0 DIFF**. The final read-only pass (`-6-final.log`, after the
LaunchServices fix below) gives the same: 0 DIFF on both sides, everything as above.

## 5. Preflight

Skipped. `svall handover` has no checks-only option. Without a TTY it runs straight through, because `interactive`
needs `stdin.isTTY` and there is no confirm step (`packages/cli/src/commands/handover.ts:153`). The daemon's
`handover.preflight` RPC is read-only by its schema comment, but it is not the CLI, so it was not run.

## 6. Docs

`pr2-onmachine-env.md` now describes the environment as it is:
- `S` is `$TH/kit`. The builds are `2ab80fda`, with `a84bf57d` kept for a rollback; the app is build 724; m4's
  current and kept releases are updated.
- The rebuild and rollback scripts are listed.
- The snapshots have their new fields and files.
- The pids left running are updated.
- The owner's before-state is as read today: known_hosts md5 unchanged; `/Applications/Svall.app` 0.12.0 build 721,
  svalld 27628.
- The teardown runs m4 first and `teardown-mac.sh` last, because it removes `$TH` and the kit.

## The kit

New scripts:
- `r1-health.sh <label>`, read-only: `system.info`, `ownership.get`, the LaunchServices count, `state.sh mac`,
  `units-far.sh`, and `snap.sh` on both sides.
- `r2-build.sh <commit>`.
- `r3-mac.sh <id>`.
- `r4-m4.sh <id>`.
- `rebuild.sh <commit>` runs 1→4 with health after the Mac and after m4, then the compares. It stops at the first
  failure.

`rebuild.sh` was not run as one invocation. Its steps ran one by one, with the same scripts and log names; the
LaunchServices step was added to `r3-mac.sh` afterwards and run by hand.

Changed:
- `bin/snap.mjs` and `bin/compare.mjs`: roots and terminals.
- `units-far.sh`: the fleet daemon's ownership and tmux server.
- `snap.sh` and `state.sh`: fixed, see below.
- `teardown-mac.sh`: fixed, see below.

## Surprises

1. **LaunchServices registered the installed test app by itself.** Its registration dates from the install (13:09Z,
   version 724). That is newer than the owner's 721, so `open -b io.github.linusroxbergh.svall` or a URL scheme could
   pick it.
   - `Claude Code URL Handler.app` in `$TH/Applications` had been registered again on Oct 17 without being opened.
   - Both are now unregistered (`lsregister -u`, as `close-test-app.sh` does): count 0.
   - `r3-mac.sh` now does this, and `r1-health.sh` reports the count. macOS may register them again on its own.
2. **CFBundleVersion is 724, lower than `a84bf57d`'s 816.** The PR is now one commit on main, so the commit count
   fell. It is still above the owner's 721. Nothing in this environment compares build numbers.
3. **The recovered kit had two broken scripts, now fixed:**
   - `snap.sh linux` and `state.sh linux` failed: Node 24 refused the extensionless `mktemp` file
     (`ERR_UNKNOWN_FILE_EXTENSION`). They now use `mktemp --suffix=.mjs`.
   - `teardown-mac.sh` would always have refused, because its own command line (`$TH/kit/…`) matched its "processes
     of the test HOME" check. It now leaves out its own pid.
4. **Left as is, since this task does not need them:**
   - `21-extras.sh` and `create-user.sh` hold unexpanded heredoc text (`$TH`, `$IR`, `$CB`, `$CSH`, `'$PUB'`, a
     literal `$@`).
   - `60-creds-copy.sh` reads `$HOME_OWNER_OC`, which `env.sh` does not set.
   - **`$S/baseline/linus-before.txt` is gone**, so `linus-diff.sh` has nothing to compare against. Checking
     linus-vault at teardown needs the owner, by hand.
5. **m4 keeps two releases.** This upgrade dropped `b31fe003`. A rebuild at a newer commit will drop `a84bf57d` from
   m4, though the Mac's `app.noindex/a84bf57d` stays. Going back would then be a plain `host upgrade` from that app,
   not `--rollback`.
6. **OpenCode reads as signed in** (`host doctor`, `system.info`), with 0 `openai` rows in either home and no Claude
   or Codex credential file. It already read so on `a84bf57d`.
7. **Port.** m4's fleet daemon listens on a free port (41011) because linus-vault's 47800 is taken, as on every
   earlier start.

## Rules kept

- `unset SVALL_HOME SVALL_CHAR_ID TMUX` and `unset -f node` before every command that ran the kit. The Mac side ran
  only through the kit's wrappers (`env -i`, `--no-launchctl`).
- No `launchctl`, no sudo, and no app opened. Nothing was handed over or frozen, and no credential was copied.
- linus-vault was reached only as `svall-m4` through `$TH/tmp/agent.sock`. Nothing of `linus`, `archi-m3b` or
  `tailscale` was touched.
- The owner's files were untouched:
  - `~/.ssh/known_hosts` md5 `1f403c13…` (Sep 14, 7,796 B);
  - the owner's svalld 27628 still runs;
  - no write under `~/Library` beyond the build's caches, as the round trip's builds did.
  - The only LaunchServices change is unregistering the two test HOME apps.
- The worktree `pr2-rebase-012` was not used; the build came from `git archive`.
- Tokens: 0 hits for either daemon's token in `$S/logs`, `$S/snaps` or `$S/run`. `release-scan.mjs --secrets-only`
  passes over all three (17, 8 and 1 files).
