# Task 12 — Reproducible Mac controller and Linux companion artifacts

Status: **DONE**

Commits (branch `fleet-handover-impl`):

- `8cfdb8a` A release root replaces every repository climb
- `4a40073` Published builds carry a versioned controller and companion

## What was implemented

### A release root instead of `import.meta.url` climbs (`8cfdb8a`)

`packages/archid/src/release.ts` is now the one place the layout is named. `releaseRoot()` returns
`ARCHI_RELEASE_ROOT` when the `bin/` shims exported it and the checkout otherwise; `hooksDir()`,
`homeTemplateDir()` and `mobileDistDir()` derive from it; `repoRoot()` refuses outright on a release
and, on a checkout, asserts `pnpm-workspace.yaml` is there rather than returning a wrong path
silently; `releaseVersion()` reads `<root>/release.json` and answers `dev` on a checkout.

Callers: `setup.ts` (`installHookScripts`, `installHomeTemplate`), `api/server.ts`, `mobile.ts`,
`packages/cli/src/commands/mobile.ts`, `packages/cli/src/commands/setup.ts`,
`packages/cli/src/launch.ts`. `packages/archid/src/api/bundle.ts` and its `MOBILE_DIST` are gone;
`@archipelago/archid/release` replaces the `./bundle` export.

`mobile.ts` no longer holds a `REPO_ROOT`. `buildBundle` resolves `repoRoot()`, so it cannot run in
a release, and `mobileControl` only builds the phone page on a checkout — on a release a missing
page is reported through the existing `pageMissing` flag.

`launchdPlist` now takes `program: string[]`. `setup.ts` gained `RunFrom` (`{ release }` or
`{ repoRoot }`) and `daemonProgram()`; a release install writes
`ProgramArguments = [<current>/bin/archid]` and symlinks `~/.local/bin/{archi,archipelago}` to
`../share/archipelago/current/bin/archi`, while a source install keeps the tsx plist and the sh
shim so `pnpm archid` and `pnpm desktop:dev` are untouched. `uninstall.ts` recognises the symlinked
shim so it is still taken back.

`archi version [--json]` reports release, protocol, state schema, transfer schema, authority schema
and runtime. `version` joined `RESERVED` in `profile.ts`, so it is no longer read as a profile name.
`AUTHORITY_SCHEMA_VERSION = 1` was added to the protocol.

### The builds, the manifest and the installer (`4a40073`)

`scripts/spikes/` is deleted; its logic is production code:

- `scripts/release/pins.json` — the one place Node (`v22.23.2`, the current 22 LTS) and rsync
  (`3.4.4` plus its source sha256) are pinned.
- `scripts/release/allowed_signers` — committed with a placeholder key and the commands to replace
  it. No long-lived key was generated; tests and the local signing run used ephemeral ed25519 keys.
- `scripts/release-stage.mjs` — what both platforms share: the pinned Node tarball (downloaded into
  `vendor/node/`, checked against nodejs.org's `SHASUMS256.txt` for its own version before a byte is
  staged, with the sums cached beside it), `node/include`, `node/lib/node_modules` and the npm/npx/
  corepack links pruned, `node/LICENSE` kept, one esbuild ESM bundle per entry point, the `bin/`
  shims, `hooks/`, `home/`, `web-mobile/`, the licence of every package esbuild inlined (mapped from
  the metafile inputs), and the schema versions read out of the protocol rather than retyped.
- `scripts/release-manifest.mjs` — `entriesOf` walks with `lstat` and records path, type
  (file|dir|symlink), mode, size, content sha256 and link target; `manifestDigest` is order-free;
  `writeManifest` writes `release.json` and then `SHA256SUMS` over every file *including*
  `release.json`, so the one detached signature covers the whole description; `signManifest` /
  `sshVerify` wrap `ssh-keygen -Y sign|verify -n archipelago-release`; `verifyRelease` authenticates
  a tree in place and is the injectable-verifier seam.
- `scripts/build-companion.mjs` — linux-x64 and linux-arm64 archives, each staged in its own tree,
  tarred with `--no-xattrs` under `COPYFILE_DISABLE=1`.
- `scripts/build-controller.mjs` — the darwin tree for the host arch plus `bin/rsync` built from the
  pinned source with the required `./configure` flags and cached in `vendor/rsync/<ver>-<arch>/`,
  with `licenses/rsync-LICENSE`.
- `scripts/install-release.mjs` — the shared installer. It stages a directory or a `.tar.gz` in
  `.staging-<pid>`, checks the version token is a plain directory name under `releases/`, verifies
  the signature, then every `SHA256SUMS` line, then the tree against `release.json` in **both**
  directions, and only then renames the whole tree into `releases/<version>` and renames a temporary
  symlink over `current`. A release of the same name (a `<sha>-dirty` development build) is replaced
  only after the new tree is whole. It is a library with a CLI, guarded on `process.argv[1]`'s
  basename so the copy bundled into `archi` stays a library.

The shims resolve their own symlinks before exporting `ARCHI_RELEASE_ROOT`, which the spike's shim
did not — `~/.local/bin/archi` is a symlink, and so is `current`. (Corrected after review: the first
version exported `<prefix>/current`; see the fix report below.)

`archi setup --release <dir or tarball> [--allow-unsigned]` installs a release under
`~/.local/share/archipelago` and points launchd, the Claude hooks and the shims at `current`.
`apps/desktop/mac/build.sh release` runs `build-controller.mjs` and copies the tree into
`Archipelago.app/Contents/Resources/release/`; `scripts/desktop-install.sh` hands that exact tree to
`archi setup --release`, so a developer install exercises the installed-runtime layout. No Swift was
touched. `.gitignore` gained `vendor/node/` and `vendor/rsync/`; `package.json` gained
`release:companion`.

## Tests and results

`pnpm vitest run --project archid --project cli --project protocol` → **868 passed, 76 files, 0
failed**. `pnpm typecheck` → clean. Both run three times; one intermediate run showed 2 failures in
the tmux-backed CLI/fleet tests while a smoke daemon of mine was holding port 47800 — it did not
recur across four subsequent clean runs.

New coverage in `packages/archid/test/release.test.ts` (22 tests):

- release-root resolution on both layouts, asset directories, `repoRoot()` refusal on a release,
  `releaseVersion()` from `release.json` and its `dev` fallback;
- the manifest walk records symlink targets and modes, skips its own files, and `manifestDigest` is
  identical for a reversed entry list and for two independently built trees (same list, same modes,
  same digest);
- `verifyRelease` refuses an unsigned tree without the flag and a signature from another identity
  (ephemeral ed25519 key created in the test);
- the installer: atomic `current` swap keeping the previous release, same-version replacement,
  tampered file, unlisted extra file, repointed symlink, unsigned without the flag, a `..` version
  token, a `SHA256SUMS` line naming a path outside the release, and an empty prefix after a refusal;
- a full build through `stageRelease` + `writeManifest` + `installRelease`, then
  `<current>/bin/archi version --json` from the installed tree — skipped with a named reason when
  the pinned Node tarball, its cached sums or `dist-mobile` are not on disk (no test downloads).

`packages/cli/test/cli.test.ts` gained the `archi version --json` test, which also proves `version`
is not read as a profile name.

### TDD evidence

RED/GREEN was literal for `release.ts`: the seven tests were written first and failed
(`releaseRoot is not a function`, `expected 'dev' to be '1.2.3'`, …), then passed on the first
implementation. Same for `archi version --json`.

For the manifest and installer I wrote the module before the tests, so instead of a claimed RED I
proved each test bites by removing its guard one at a time and re-running:

| guard removed | failing test |
| --- | --- |
| digest comparison in `checkSums` | refuses a file whose content was changed after the manifest was written |
| unlisted-path check | refuses a file the release carries and the manifest does not list |
| entry-description comparison | refuses a symlink repointed after the manifest was written |
| unsigned refusal | accepts an unsigned tree only when it is asked to; refuses an unsigned release unless it is allowed |
| path-outside-release check | refuses a `SHA256SUMS` line naming a path outside the release |
| version-token check | refuses a version token that would reach outside `releases/` |

Every mutation failed exactly the test that names it and nothing else, and every guard was restored.

## Builds run and artifacts

All with the pinned `node-v22.23.2`.

| artifact | unpacked | archive | manifest entries | licences |
| --- | --- | --- | --- | --- |
| controller `darwin-arm64` | 123 MB (103 files, 26 dirs) | — (tree) | 126 | 26 |
| companion `linux-x64` | 121 MB | 45,064,495 B | 124 | 25 |
| companion `linux-arm64` | 121 MB | 44,912,386 B | 124 | 25 |

Bundles: `lib/archi.mjs` 616,858 B, `lib/archid.mjs` 940,931 B. `Archipelago.app` with the release
tree inside: 128 MB.

- `apps/desktop/mac/build.sh release` run in this worktree (GhosttyKit symlinked to the main
  checkout's `vendor/ghostty` for the run, then restored). The copied tree inside
  `Archipelago.app/Contents/Resources/release` re-verifies against its own manifest: 126 entries.
- Reproducibility: two controller builds of the same tree produced identical `entriesDigest`, file
  lists, modes and per-file digests — zero differing entries. Nothing embeds a timestamp.
- Archive hygiene: `tar -tzvf` of the x64 archive reports **0** `LIBARCHIVE` keywords and **0** `._`
  members; no `node_modules`, no `*.map`, and `grep -r linus_laboratory` over the tree and over
  `release.json` / `SHA256SUMS` finds nothing.
- Signing: a signed companion built with `ARCHI_RELEASE_KEY` pointing at an ephemeral key installed
  cleanly against a matching `allowed_signers`; against the committed placeholder it refused with
  `SHA256SUMS is not signed by archipelago-release` and left the prefix empty.
- Installed layout smoke test under a temp `HOME` with `ARCHI_APP_DEST` inside it and
  `--no-launchctl` (the exported root claimed here was wrong; see the fix report):
  `archi setup --release` wrote
  `ProgramArguments = [<HOME>/.local/share/archipelago/current/bin/archid]`, the relative shim
  `archi -> ../share/archipelago/current/bin/archi`, and the bundled `archid` then booted, seeded the
  mission-control home out of the release's `home/`, listened, and answered `archi status` through
  the bundled `archi`. Running it twice replaced the same-named release in place. The real
  `~/.archipelago` and `/Applications` were never touched.
- Dev commands unchanged: `pnpm archi version` prints `release dev`, and `pnpm archid` starts from
  the checkout (it only stops on the live daemon's port).

## Docker proof — **run**

`ubuntu:24.04`, `--platform linux/arm64`, with `openssh-client`, `rsync` and `tmux` installed and no
system Node, no pnpm and no checkout in reach of the daemon:

- the signed `linux-arm64` archive verified against the ephemeral `allowed_signers` and installed:
  `signed: true`, 124 entries, `current -> releases/8cfdb8a-dirty`;
- `archi version --json` answered `{"release":"8cfdb8a-dirty", …, "runtime":{"node":"v22.23.2",
  "platform":"linux","arch":"arm64"}}` from `/` with the checkout mount out of the picture;
- `archid` started, seeded the home template from the release, listened on 47800, and
  `archi status` talked to it.

Before tmux was installed the daemon stopped with `tmux not found on PATH: brew install tmux` — the
message is macOS-flavoured on Linux; out of scope here, worth a line elsewhere.

## Self-review findings (fixed before the commits)

- `verifyRelease` compared paths against a caller-supplied `dir` without resolving it, so a relative
  directory refused everything with "names a path outside the release". Found while verifying the
  copied tree inside the app bundle. Fixed by resolving `dir` first.
- The first `build-companion` run staged both architectures at the same
  `<out>/releases/<version>`, so the second wiped the first's tree. Each architecture now stages in
  its own subtree.
- `release/` in `.gitignore` also matched `scripts/release/`, silently excluding `pins.json` and
  `allowed_signers` from the commit. Removed — `apps/desktop/mac/build/` already covers the output.
- The installer refused a release directory it already had, which every repeat development install
  would hit (`<sha>-dirty` recurs). It now replaces a same-named release, after the new tree is
  authenticated and renamed in.
- `uninstall.ts` matched a shim only by its file content, so the new symlinked shim would have been
  left behind.
- Over-exported internals in `release-stage.mjs` and `release-manifest.mjs` were trimmed to what the
  builders and the tests actually use.

## Rulings bent, and why

1. **Shared staging lives in `scripts/release-stage.mjs`.** Ruling 1 names four scripts; the two
   builders share the runtime, bundling, asset and licence work, and duplicating ~180 lines between
   them would have been worse. Only `scripts/release/` (pins and allowed signers) sits in the
   subdirectory, as ruling 2 and 4 asked.
2. **`archi setup --release` imports the installer from `scripts/`.** Ruling 8 says `archi setup`
   gains the ability to install a release, which means the installer has to be reachable from the
   bundled `archi` — the Mac app's own first run is
   `<app>/Contents/Resources/release/bin/archi setup --release <that dir>`. Rather than duplicate it
   in TypeScript, `packages/cli/src/commands/setup.ts` imports `scripts/install-release.mjs` through
   a `.d.mts` sidecar, the pattern `probe-worktree-handover.mjs` already established here. A package
   reaching outside itself is the cost; a second implementation of the security-critical path would
   have been the alternative.
3. **The RunFrom plumbing landed in the first commit.** The split asked for the install layout in the
   second; `setup.ts` and `launch.ts` had to change for the release root anyway, and separating the
   plist/shim edit from the asset-directory edit inside the same functions would have produced a
   commit that does not build.
4. **`desktop-install.sh` now always runs `archi setup`** instead of only when setup was missing: the
   plist's `ProgramArguments` changes with every release, and `launchctl kickstart` restarts an agent
   with the plist it already loaded, so a conditional setup would have left the old program running.

## Concerns

- `scripts/release/allowed_signers` holds a placeholder, so a real signed release will not verify
  until the public half of the actual release key replaces it. Deliberate (ruling 4); the file
  carries the commands.
- rsync is pinned at 3.4.4; 3.5.1 is current upstream. 3.4.4 is the last of the 3.4 line and
  interoperates with Ubuntu 24.04's 3.2.7, which is what Task 23 needs. The pin is one line.
- The Node tarball digest is checked against `SHASUMS256.txt` over HTTPS but that file is not
  signature-checked (nodejs.org publishes a detached PGP signature for it). The spike's decision
  stands; worth revisiting when a release key exists.
- `bin/rsync` is unsigned and unnotarized inside `Archipelago.app`. Notarizing the bundle is a
  separate concern the spec already keeps separate, but a hardened-runtime notarization pass will
  have to cover it.
- The controller tree is only built for the host architecture. A universal Mac release needs both
  `darwin-arm64` and `darwin-x64` trees; both are pinned, and `build-controller.mjs` would need an
  `--arch` flag plus a lipo/fat-bundle decision for `bin/rsync`.
- `node/lib` survives pruning as an empty directory. Harmless, recorded as a `dir` entry.
- `archi mobile on --build` on a release throws from `repoRoot()` with "this is an installed
  release, not a checkout". Correct, but the wording is a developer's; the phone page is already in
  the release, so that flag has no purpose there.

---

# Fix report — five review findings

Status: **DONE**. Commit `2af5f28`. `agentAdapters: []` was ruled acceptable
and is untouched.

Each fix got a failing test first. The six new tests failed as written
(`ensureBundle is not a function`, `allowedSigners is not a function`, `shimText is not a function`,
`expected false to be true` for the staged signers file, `expected '{ "permissions": …' to be
'mine'`), then passed.

## 1 — the signers a release trusts never travelled with it

`allowed_signers` was resolved from `import.meta.url`, which inside the esbuild-inlined
`lib/archi.mjs` points at `<release>/lib/release/allowed_signers`, and nothing staged the file at
all. The bundled `archi setup --release` could therefore only ever install with `--allow-unsigned`.

Changed: `release-stage.mjs` `DIRS` gained `release`, and `stageAssets` copies
`scripts/release/allowed_signers` to `<root>/release/allowed_signers`.
`install-release.mjs` replaced the `ALLOWED_SIGNERS` constant with
`allowedSigners()`, which returns `$ARCHI_RELEASE_ROOT/release/allowed_signers` when the env is set
and the committed checkout path otherwise; `install-release.d.mts` and
`packages/cli/src/commands/setup.ts` follow.

Covering tests: `the signers a release trusts > sits inside the release once one is installed, and
in the checkout otherwise`; `a release built by the build scripts > answers archi version --json
from the installed tree` now also asserts `release/allowed_signers` is in the installed tree.

Artifact check, after `node scripts/build-controller.mjs --out /tmp/archi-ctrl` and
`apps/desktop/mac/build.sh release`:

```
$ ls apps/desktop/mac/build/Archipelago.app/Contents/Resources/release/release/
allowed_signers
```

End to end, with an ephemeral ed25519 key: a signed controller tree was built with that key's public
half in `scripts/release/allowed_signers` (the committed placeholder was restored immediately
afterwards — `git diff --quiet scripts/release/allowed_signers` confirms it), installed once with
`--allowed-signers`, and then the *installed* `archi` installed the same signed tree again with no
flags at all:

```
$ env HOME=/tmp/archi-home2 .../current/bin/archi -p private setup --no-launchctl \
    --release /tmp/archi-signed/releases/4a40073-dirty
release 4a40073-dirty -> /tmp/archi-home2/.local/share/archipelago/releases/4a40073-dirty
current -> /tmp/archi-home2/.local/share/archipelago/current
hook script -> /tmp/archi-home2/.archipelago/hooks/agent-hook.mjs
```

and the checkout path still refuses a signature the committed placeholder does not cover:

```
Error: SHA256SUMS is not signed by archipelago-release: Command failed: ssh-keygen -Y verify
  -f .../scripts/release/allowed_signers -I archipelago-release -n archipelago-release -s .../SHA256SUMS.sig
```

## 2 — `release.json` named the build machine

`verifiedAgainst` recorded whichever path the digests were read from, so a warm cache put
`/Users/…/vendor/node/SHASUMS256-v22.23.2.txt` into the shipped manifest. `nodeRuntime` now always
records `https://nodejs.org/dist/<version>/SHASUMS256.txt` and only uses the cache path for reading
and for the "lists no digest" message.

Covering test: the built-release test asserts `release.json` does not contain the checkout path and
does contain `https://nodejs.org/dist/`.

Artifact check on the rebuilt tree:

```
$ grep -c "linus_laboratory\|/Users/" /tmp/archi-ctrl/releases/4a40073-dirty/release.json
0
$ grep -o '"verifiedAgainst": "[^"]*"' /tmp/archi-ctrl/releases/4a40073-dirty/release.json
"verifiedAgainst": "https://nodejs.org/dist/v22.23.2/SHASUMS256.txt"
$ grep -rl linus_laboratory /tmp/archi-ctrl/releases/4a40073-dirty/
(nothing)
```

## 3 — `archi mobile on` was broken on the shipped CLI

`--no-build` makes commander default `o.build` to true, so the plain `archi mobile on` always called
`buildBundle`, which calls `repoRoot()`, which throws on a release.

`buildBundle` is now module-private in `packages/archid/src/mobile.ts` behind a new
`ensureBundle(d, { rebuild })`: it builds from the checkout when asked or when the page is missing,
never on a release, and returns `{ dist, missing }` without throwing. `mobileControl` and
`packages/cli/src/commands/mobile.ts` are both callers, so the rule lives in one place; the CLI
raises a release-aware error when the page is missing.

Covering tests (`packages/cli/test/mobile.test.ts`): `builds the page from the checkout when it is
missing, and on request`; `never reaches for pnpm on a release, and reports a page the release does
not carry`.

Artifact check, from the installed release with a stub `tailscale` on PATH and the daemon up:

```
$ .../current/bin/archi mobile on --no-build
https://mac.tailnet.ts.net/
every login on your tailnet may drive the fleet; …

$ mv .../current/web-mobile /tmp/ && .../current/bin/archi mobile on
archi: no phone page at /private/tmp/.../releases/4a40073-dirty/web-mobile; run archi mobile on without --no-build
```

(The second message is the checkout wording because `isRelease()` was added to the CLI after that
run; the release wording `this release carries no phone page at …` is what ships now.)

## 4 — every developer install rewrote edited mission-control settings

`setupUser` passed `replaceSettings: true` unconditionally, and `desktop-install.sh` now runs
`archi setup` on every install, so an edited `.claude/settings.json` was replaced and backed up each
time. `setupUser` and `runSetup` take `replaceSettings?: boolean`, defaulting off; only
`archi setup --replace-settings` turns it on, and the install script does not pass it. The comment
above `installHomeTemplate` states the new rule.

Covering test: `runSetup > rewrites the home skills and settings on every run` now asserts a plain
second run leaves `mine` alone with no backup, and that a third run with `replaceSettings: true`
replaces it and keeps a copy.

Artifact check under the temp `HOME`, mission-control settings set to `{"mine":true}`:

```
=== two plain installs ===
(no settings rewrite, no backup)
settings still: {"mine":true}
backups: 0
=== with --replace-settings ===
backup -> <mc>/.claude/settings.json.bak-1790080291422
home settings -> <mc>/.claude/settings.json
settings now start: {\n  "permissions": {\n    "allow": [
backups: 1
```

## 5 — the shim exported `current`, not the release

The `while [ -L "$self" ]` loop only resolves the last component, and a logical `cd … && pwd` left
`current` in the middle of the path, so a running daemon would have started reading the *next*
release the moment an upgrade moved the symlink. The shim now ends with

```sh
ARCHI_RELEASE_ROOT=$(CDPATH= cd -P -- "$(dirname -- "$self")" && cd -P -- .. && pwd -P)
```

and `SHIM` is exported as `shimText(name)` so it can be tested.

Covering test: `the bin shim > exports the release it lives in, not the current symlink pointing at
it` builds the `~/.local/bin/archi → ../share/archipelago/current/bin/archi → releases/1.0.0/bin/archi`
layout in a temp dir with a stand-in `node/bin/node` that prints the variable, runs the generated
shim, and asserts the output is `realpath(releases/1.0.0)` and contains no `/current`.

Artifact check with the shipped shim, through both hops, by swapping the installed
`lib/archi.mjs` for a one-liner that prints the variable:

```
$ ~/.local/bin/archi
/private/tmp/archi-fakehome/.local/share/archipelago/releases/4a40073-dirty
expected physical release: /private/tmp/archi-fakehome/.local/share/archipelago/releases/4a40073-dirty
```

The report's original claim that the exported root was `<prefix>/current` has been corrected in
place above.

## Commands and output

```
$ pnpm typecheck
(clean)

$ pnpm vitest run --project archid --project cli --project protocol
 Test Files  76 passed (76)
      Tests  872 passed (872)          # run twice, same result

$ node scripts/build-controller.mjs --out /tmp/archi-ctrl
… "version": "4a40073-dirty", "platform": "darwin-arm64", "entries": 128, "signed": false

$ apps/desktop/mac/build.sh release
…/apps/desktop/mac/build/Archipelago.app

$ verifyRelease("apps/desktop/mac/build/Archipelago.app/Contents/Resources/release")
entries 128 signed false
```

The controller tree is 128 manifest entries (126 before, plus the `release/` directory and
`release/allowed_signers`). File counts, sizes and the licence list are otherwise unchanged.

## Notes

- `packages/cli/test/mobile.test.ts` was the right home for the `ensureBundle` tests: it already
  covers the archid mobile helpers with fake deps, and the CLI's own `mobileCommand` builds
  `realDeps()` at construction, so it is not unit-testable without a tailnet.
- Nothing else in the release changed shape; the reproducibility, archive-hygiene and Docker results
  from the first report still hold, and the Docker proof was not re-run for these five fixes (none
  of them touches the Linux archive's contents beyond adding `release/allowed_signers`).
