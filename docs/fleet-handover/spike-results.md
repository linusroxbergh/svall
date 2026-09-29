# Fleet handover — spike results

The M0 evidence for the four product promises. Each section says what was proven on real artifacts,
what was not, and what the later tasks must carry.

---

## Task 1 — Claude Code session portability

**Proven.** Claude Code 2.1.278 resumes a completed conversation after its JSONL and subagent
sidecars are copied to a new project-path slug and the live cwd metadata is remapped, both with
`-p --resume <id>` and interactive `--resume <id>`. The resumed session remembered a pre-transfer
marker, showed its earlier Bash and subagent turns, ran `pwd` in the destination, and appended new
turns only to the destination transcript.

- A `SessionStart` hook delivers `session_id` and `transcript_path`, the latter pointing at
  `<config>/projects/<cwd-slug>/<uuid>.jsonl`. The slug replaces non-alphanumeric cwd characters
  with `-`.
- A completed `Agent` call leaves `<project>/<uuid>/subagents/agent-*.jsonl` and a matching
  `agent-*.meta.json`, which must move with the transcript.
- `session-env/<uuid>` is deliberately excluded: it can hold secrets, and resume succeeded without it.
- Historical user text, tool arguments and Bash output keep the source path. Those are evidence and
  must not be blanket-rewritten; the handover's SessionStart context tells the agent its new paths.
- Interactive resume prompts to trust the new project folder. Published setup must not read that
  prompt as an auth failure.

**Not proven.** Cross-OS and independent authentication. The live test used two temporary
path shapes but the same authenticated macOS Claude config directory; a separate `HOME` or
`CLAUDE_CONFIG_DIR` reported `loggedIn: false`. A second machine must log in on its own. Support is
pinned to the tested version.

Details and commands: `packages/svalld/test/fixtures/handover/claude/README.md`.

---

## Task 2 — Codex session portability

**Proven.** Codex CLI 0.155.1 resumes a moved session from its rollout file alone. A session created
under one `CODEX_HOME` resumed from a second `CODEX_HOME` at a different home-shaped path prefix
with only `sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<id>.jsonl` copied across, remembered its
pre-move marker, ran `pwd` in the destination and appended in place.

- Codex rebuilds its own `state_5.sqlite` thread row pointing at the moved rollout and the
  destination cwd. No index file has to move. `history.jsonl` holds every session's prompts and must
  never be copied wholesale.
- Id lookup is a directory scan, not an index: a rollout dropped flat under `<home>/sessions/`
  resumed fine. An unknown id fails with `no rollout found for thread id <id>`.
- `SessionStart` and `Stop` hooks deliver `hook_event_name`, `session_id` and `transcript_path` under
  the same keys Claude Code uses, so `packages/svalld/src/hooks/receiver.ts` normalizes both
  backends unchanged.
- Path-bearing metadata to remap: `session_meta.cwd`, `session_meta.runtime_workspace_roots[]`,
  `turn_context.cwd`, `turn_context.workspace_roots[]`,
  `turn_context.permission_profile.file_system.entries[].path.path`,
  `turn_context.file_system_sandbox_policy.entries[].path.path`,
  `world_state.state.environments.environments.<env>.cwd`, and an `item_completed` item's `cwd`,
  which is a `file://` URI rather than a bare path.
- `world_state.state.permissions.approved_command_prefixes` is left alone on purpose: it matches on
  exact command text, so an entry naming a source path stops matching after the move, which fails
  closed.
- A missing destination login surfaces as a mid-turn `401 Unauthorized`, not a preflight error. The
  host doctor must run `CODEX_HOME=<home> codex login status` up front; it prints `Not logged in`
  with exit 1 and leaves the home otherwise untouched.

**Not proven.** Cross-machine and cross-OS resume — the Linux target has no Codex installed. Proven
on macOS only, on 0.155.1, with one account's `auth.json` copied by hand into each disposable home.
Interactive `codex resume <id>` was not exercised. The 0.142 rollout shape is accepted by the probe
on the strength of a checked-in fixture, but no 0.142 session was resumed live.

Details and commands: `packages/svalld/test/fixtures/handover/codex/README.md` and
`.superpowers/sdd/2026-09-20-fleet-handover/task-2-report.md`.

---

## Task 3 — linked worktrees

**Proven.** Git **2.55.0** (macOS, darwin 25.6.0), commit `9e00063`. Test file
`packages/svalld/test/handover/worktree-portability.test.ts` against the probe helper
`scripts/spikes/probe-worktree-handover.mjs`, 7 tests, all green.

The fixture is a hermetic `fs.mkdtempSync` tree holding one main checkout with a nested worktree
inside `.claude/worktrees/nested`, a sibling worktree, a registered-but-unused worktree nobody
copies, a `file://` submodule, a stash, and staged + unstaged + untracked changes in every used
checkout. Transfer copies only the main checkout and the sibling to a new home prefix and deletes
the source tree outright, so the destination has to stand on its own.

- `git worktree repair` with no path arguments fixes nothing: every registration still names the
  source machine, so git has nothing to anchor on and everything stays `prunable`. The mapped
  destination paths are the load-bearing part of repair.
- Branch refs of a dropped registration survive: `refs/heads/unused-branch` still resolves to the
  same sha after `.git/worktrees/unused` is removed, because branch refs live in the common dir and
  only `HEAD`/`index`/`refs/bisect` are per-worktree.
- `refs/stash`, its reflog and `git stash list` travel with the common dir untouched, and read
  identically from the main checkout and from every linked worktree.
- A submodule's gitfile (`gitdir: ../.git/modules/sub`) and its `core.worktree`
  (`../../../sub`) are both relative, so neither needs rewriting after the move. From inside the
  submodule, `--git-dir == --git-common-dir == <super>/.git/modules/sub` and `--show-toplevel` is
  the submodule itself: it is its own repository graph, exactly the shape
  `packages/svalld/src/links/git.ts` already reads.

**Findings that change the spec.**

1. Unlisted registrations must be pruned *before* `git worktree repair`, not just as well as it.
   With a still-reachable source (`<source>/work/unused` on the same machine, a shared mount, or a
   rehearsal), running repair from the destination copy rewrote the *source's* unused worktree
   gitfile to point at the destination's common dir — it corrupted the machine being migrated from.
   Pruning first leaves the source's gitfiles, gitdir files, snapshot and worktree list
   byte-identical.
2. Spec steps 1–2 (rewriting each worktree's `.git` gitfile and the matching
   `.git/worktrees/*/gitdir`) are redundant with `git worktree repair <mapped paths>` on this git
   version — repair fixes both sides of the link from the mapped paths alone. They are kept as
   belt-and-braces, with an assertion that repair then reports nothing left to do
   (`repairReport === ''`).
3. `git worktree prune` must never be used for step 3. At import time no registration resolves yet,
   so prune removes *all* of them; in the fixture it deleted `.git/worktrees` entirely rather than
   emptying the one entry the manifest omits.
4. A submodule's `origin` remote still names the source machine after the move, and nothing in this
   flow remaps it. `git status`, `rev-parse` and `submodule status` all work offline, but a
   `file://`-style (or otherwise host-local) origin will not fetch on the destination.

**Remaining gate.** Task 21 must still add typed production discovery, associate a character with
its worktree, and handle a detached HEAD or a locked worktree — none of which this spike's fixture
exercises. Measured on one git version (2.55.0) on macOS only; the destination target is Linux, and
nothing observed here is macOS-specific beyond the fixture's own `/tmp` realpath handling.

Details: `.superpowers/sdd/2026-09-20-fleet-handover/task-3-report.md`.

---

## Task 4 — release packaging and stable relay assumptions

Everything below ran on 2026-09-21 against the real Linux target `test-server`
(Ubuntu 24.04.2, x86-64, Tailscale 1.84, rsync 3.2.7, tmux 3.4), from this Mac, inside a disposable
`/tmp/svall-spike-1790013049` that was removed afterwards.

### Bundling and the pinned runtime

`scripts/spikes/build-companion.mjs` bundles `packages/cli/src/main.ts` and
`packages/svalld/src/bin.ts` with **esbuild 0.28.2** (a new root devDependency) to ESM for
`node22`, unpacks a pinned Node tarball beside them and tars the result.

```bash
pnpm --filter @svall/desktop-web build:mobile
node scripts/spikes/build-companion.mjs \
  --node-tarball <scratch>/node-v22.23.2-linux-x64.tar.xz \
  --out <scratch>/companion --sign-key <scratch>/release-key
```

- Every dependency bundled cleanly with no esbuild warnings. `web-push`, `ws`, `zod`,
  `fast-json-patch`, `qrcode`, `smol-toml` and `commander` are pure JS with no dynamic `require`
  that esbuild could not follow. Two flags were needed and are the whole story:
  `--external:bufferutil --external:utf-8-validate` (optional `ws` accelerators it already falls
  back from) and a `createRequire` banner, because esbuild's ESM output has no `require` for the
  CJS dependencies that expect one.
- Output sizes: `lib/svall.mjs` 590,030 B, `lib/svalld.mjs` 902,301 B.
- No developer absolute path survives into either product bundle. The only `linusroxbergh` hit in
  each is the repository URL in a config default
  (`pushContact` in `packages/svalld/src/config.ts`).

**Pinned runtime.** Node **v22.23.2** (`lts: Jod`, released 2026-07-28), the current 22.x LTS.
`node-v22.23.2-linux-x64.tar.xz` verified against `SHASUMS256.txt`:
`d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307`.

### Archive layout

```text
releases/<version>/
  bin/svall           0755  sh shim: exports SVALL_RELEASE_ROOT, execs node/bin/node lib/svall.mjs
  bin/svalld          0755
  lib/{svall,svalld}.mjs
  node/               unpacked official tarball, including its LICENSE
  hooks/              packages/svalld/hooks
  home/               packages/svalld/home (CLAUDE.md, .claude/settings.json, .claude/skills)
  web-mobile/         apps/desktop/web/dist-mobile
  licenses/           svall, node, and one per package esbuild inlined (25 files)
  SHA256SUMS          sha256 of every staged file
  SHA256SUMS.sig      ssh-keygen -Y signature over SHA256SUMS
  release.json        version, platform, the verified node version and digest, bundle sizes,
                      the bundled-licence list, and per-file sha256/mode/size
```

Unpacked 199 MB, tarball 58 MB, 4,846 files.

The runtime is verified before it is staged. `build-companion.mjs` reads
`https://nodejs.org/dist/<version>/SHASUMS256.txt` (or a local copy given with `--node-shasums`),
finds the line for the tarball's own basename and refuses a mismatch, so the signed `SHA256SUMS`
never attests to an unchecked Node. Appending one byte to the tarball produced
`node-v22.23.2-linux-x64.tar.xz is not the published runtime: expected d60acfe0…, got 13c76c47…`
and staged nothing at all. `release.json` records the digest and where it was checked against.

`licenses/` carries the text of every package esbuild inlined, mapped from the metafile's inputs
back to each `node_modules/<pkg>/LICENSE*`: 23 packages — `ws`, `web-push`, `zod`, `commander`,
`qrcode`, `fast-json-patch`, `smol-toml` and their transitive dependencies — beside Svall's
and Node's.

### Installing a release

`scripts/spikes/install-release.mjs` makes the `current` swap executable rather than typed:

```bash
node scripts/spikes/install-release.mjs --tarball <archive.tar.gz> --prefix <dir> \
  [--allowed-signers <file>] [--signer <identity>]
```

It reads the version from the archive's own member names rather than guessing at the directory it
just wrote. The archive is untrusted until it is authenticated, so nothing is unpacked anywhere
`current` could reach. The order is: check the version is a plain directory token that stays under
`<prefix>/releases/`; unpack into `<prefix>/.staging-<pid>/`; verify every `SHA256SUMS` line there,
refusing any whose path resolves outside the release; optionally verify `SHA256SUMS.sig`; rename
the whole verified tree into `<prefix>/releases/<version>/`; and only then symlink to
`current.tmp-<pid>` and rename that over `current`, which is atomic on both platforms so `current`
is never briefly absent or dangling. The staging directory is removed on success and on failure.

Exercised locally in a temp directory (not on the remote):

| Case | Result |
| --- | --- |
| install of the first release | `current` → `releases/0.0.0-spike+v22.23.2`, 4,846 files verified, signature OK, `rollbackTo: null` |
| upgrade to a second release | `current` → `releases/0.0.1-spike`, `rollbackTo` naming the first, both releases kept on disk |
| `--signer someone-else` | refused: `SHA256SUMS is not signed by someone-else` |
| a release with one bundle byte appended | refused: `lib/svall.mjs: expected 0c708051…, got e8944b64…` |
| an archive whose release directory is `..` | refused: `names an unusable release directory: ".."` |
| a `SHA256SUMS` line naming `../../../etc/hosts` | refused: `SHA256SUMS names a path outside the release` |

After every refusal the prefix held nothing: no `releases/`, no `current`, no staging directory.

On the live Linux run the same swap was done by hand with
`ln -sfn … current.tmp && mv -T current.tmp current` and behaved identically.

### Running the release on Linux with no repo, no pnpm and no system node

`PATH=/usr/bin:/bin`, `HOME` redirected into the temp dir, nothing from the checkout present.

| Exercise | Result |
| --- | --- |
| `node/bin/node -v` | `v22.23.2`, `linux x64` |
| `bin/svall`, `bin/svalld` modes | `-rwxr-xr-x` after tar round trip |
| `sha256sum -c SHA256SUMS` | OK |
| `ssh-keygen -Y verify` | `Good "svall-release" signature … ED25519` |
| `svall --help` | full command list, exit 0 |
| `svall doctor --json` | ran; reported `node v22.23.2` ok, `tmux 3.4` warn, `claude` fail (not installed) |
| `svalld` | started, wrote state, listened on `127.0.0.1:47800`, stopped on SIGTERM |

`svalld` created `state.json`, `port`, `tmux.conf`, `hooks.sock`, `tmux.sock`, and `token`,
`mobile-key`, `vapid.json` at mode 0600.

### What breaks under bundling — what Task 12 must change

The release ships a `lib/locate-probe.mjs` built from the same sources, which reports what the
daemon's `import.meta.url` climbs resolve to once bundled. Run from the installed release:

```json
{
  "bundleUrl": "file:///…/install/releases/0.0.0-spike+v22.23.2/lib/locate-probe.mjs",
  "releaseRootEnv": "/…/install/current",
  "mobileDist": "/tmp/svall-spike-1790013049/apps/desktop/web/dist-mobile",
  "mobileDistExists": false,
  "repoRoot": "/tmp/svall-spike-1790013049/install/",
  "repoRootExists": true,
  "hookScripts": { "ok": true, "hookScript": "…/probe-home/hooks/agent-hook.mjs", "bytes": 3198 },
  "homeTemplate": { "ok": true, "done": ["home CLAUDE.md -> …", "home skills -> …", "home settings -> …"] }
}
```

- **`setup.ts:134` hooks and `setup.ts:151` home templates keep working, by coincidence.** Both climb
  `..` from the module's own directory, and `lib/` sits exactly one level under the release root that
  carries `hooks/` and `home/`. The lookup is silently coupled to that layout; move `lib/` and both
  break with no warning.
- **`api/bundle.ts:4` `MOBILE_DIST` breaks outright.** It climbs four levels and lands on
  `<install-parent>/apps/desktop/web/dist-mobile`, which does not exist, so `serveBundle` answers
  every phone request with `The phone bundle is not built. Run svall mobile on the Mac.`
- **`mobile.ts:18` `REPO_ROOT` breaks silently and worse.** It climbs three levels and resolves to
  `<install>/`, which *does* exist, so an existence check passes. `mobile.ts:47-48` would then run
  `pnpm --filter @svall/desktop-web build:mobile` with that as cwd, on a machine with no pnpm.

Task 12 must introduce an explicit locator instead of climbing: a `packages/svalld/src/release.ts`
exporting `releaseRoot()` that reads `SVALL_RELEASE_ROOT` (already exported by the shims) and falls
back to the repository layout for `pnpm svalld` development, with `hooksDir()`, `homeTemplateDir()`
and `mobileDistDir()` derived from it. `api/bundle.ts` and `mobile.ts` become callers; the
runtime-`pnpm` mobile build path must be gone from a published release rather than merely failing.

Three further packaging facts for Task 12:

- **`svall version` does not exist.** The CLI's root action treats a bare positional as a profile
  name, so `svall version` printed `svall: no profile version; run svall version in a terminal to
  create it` and exited 0. The plan's "run `svall version --json` from an unpacked clean artifact"
  needs a real `version` command added first, and it should not be reachable as a profile name.
- **`tar` on macOS taints the archive, and it takes two flags to stop it.** A plain bsdtar
  `-czf` wrote `LIBSVALLVE.xattr.com.apple.provenance` pax headers, and GNU tar printed 5,957
  `Ignoring unknown extended header keyword` warnings while unpacking on the target. `--no-xattrs`
  alone removes the pax headers but makes bsdtar fall back to AppleDouble `._` members instead;
  `COPYFILE_DISABLE=1` in the environment removes those too. The spike script now passes both, and
  the archive contains zero `LIBSVALLVE` keywords and zero `._` members (58,460,924 B against
  59,034,579 B before).
- **The runtime should be pruned.** Of 199 MB unpacked, `node/include` is 62 MB of C++ headers and
  `node/lib/node_modules` 16 MB of npm and corepack, none of which a companion needs. `node/LICENSE`
  must stay.
- **The manifest describes file contents, not the file tree.** The spike's `walk()` treats a symlink
  as a file and hashes what it points at, so `node/bin/npm`, `node/bin/npx` and `node/bin/corepack`
  — all symlinks into `../lib/node_modules/` — are listed in `SHA256SUMS` with their targets'
  digests and nothing recording that they are links. The installer reads through them and agrees,
  so a link repointed inside the archive would pass; it also checks no file's mode and never
  notices a file the archive carries that the manifest omits. Task 12 must record each entry's
  type, mode and link target, and Task 13's installer must compare the unpacked tree against the
  manifest in both directions.

### Decisions

| Question | Decision |
| --- | --- |
| Bundler | esbuild, one ESM file per entry point, `platform=node target=node22`, `--external:bufferutil --external:utf-8-validate`, `createRequire` banner. No source maps in a release. |
| Node runtime | The official `nodejs.org` linux-`<arch>` tarball for the current 22.x LTS, verified against `SHASUMS256.txt` and pinned in the release manifest. |
| Node source and licence | `node/LICENSE` ships, copied to `licenses/node-LICENSE`. Node's licence covers redistribution of the binary; no source copy has to ship, and the manifest records the exact upstream version and the digest it was verified against, so the source is identifiable. |
| Bundled dependency licences | The build maps esbuild's metafile inputs back to each `node_modules/<pkg>/LICENSE*` and copies them into `licenses/`. A bundle inlines the code, so its licence text has to travel with it; deriving the list from the metafile means a new dependency cannot be forgotten. |
| Runtime verification | The Node tarball's SHA-256 is checked against `nodejs.org`'s `SHASUMS256.txt` for its own version before it is unpacked, and the build fails loudly rather than signing an unverified runtime. |
| Archive layout | `releases/<version>/{bin,lib,node,hooks,home,web-mobile,licenses}` plus `release.json`, `SHA256SUMS`, `SHA256SUMS.sig`, unpacked under `~/.local/share/svall/` with an atomic `current` symlink, exactly as the spec describes. |
| Release signature | A `SHA256SUMS` manifest over every staged file, detached-signed with `ssh-keygen -Y sign -n svall-release`; the installer verifies with `ssh-keygen -Y verify` against a pinned `allowed_signers`. Proven end to end with an ephemeral ed25519 key. It needs no new dependency on either machine, unlike minisign. The Mac app stays signed and notarized separately; the Linux archive is covered only by this manifest signature. |
| Install order | Authenticate in staging, then rename into `releases/`. An installer unpacks into `<prefix>/.staging-<pid>/`, verifies digests and signature there, and renames the whole verified tree into `releases/<version>/` before touching `current`. The archive names its own version, so that token is checked to be a plain directory name inside `releases/` first, and a `SHA256SUMS` line may not name a path outside the release. Task 13 inherits this order: no unverified byte is ever written where `current` could point at it. |
| Release root | An `SVALL_RELEASE_ROOT` env exported by the `bin/` shims, read by a new `release.ts`. Not `import.meta.url`. |

### tmux on Ubuntu 24.04

Ubuntu 24.04's apt tmux is **3.4**; the spec's supported environment hard-required 3.5+. The
repository needs 3.5 only for Shift+Enter and already treats older as a warning
(`packages/svalld/src/tmux/conf.ts:3`, `packages/cli/src/commands/doctor.ts:41`), so the spec now
requires tmux 3.x with 3.5+ recommended, and Add Machine's tmux check is a warning.

Verified with the exact config `tmuxConfText` generates, `pbcopy` stripped as Task 13 requires:

- `tmux -S <sock> -f <conf> new-session -d` → exit 0, empty stderr, session created, a pane ran a
  command. `history-limit`, `default-size`, `window-size`, `mouse`, `status` and
  `extended-keys` all took effect.
- `extended-keys-format` is unknown to 3.4: `show-options -s extended-keys-format` answers
  `invalid option: extended-keys-format`.
- tmux 3.4 **continues past the unknown option and applies every later line** — proven both for
  `-f <conf>` at startup and for `source-file` into a running server, where a config whose last line
  followed the unknown one still took effect.
- The startup path (`-f`) swallows the error; `source-file` reports
  `<conf>:2: invalid option: extended-keys-format` and exits 1. That is what svalld logged as an
  error on the live Linux run. Task 13 should omit the line when the local tmux is older than 3.5,
  so `source-file` exits 0 and the log stays clean. Only Shift+Enter is lost.

### rsync: the Mac must bundle rsync 3.x

The Mac's `/usr/bin/rsync` is openrsync (`protocol version 29`, "rsync version 2.6.9 compatible");
no Homebrew rsync is installed. Interop tested against the target's rsync 3.2.7 over ssh, in both
directions, on a tree with spaces, `ö` and an emoji in the names.

| Flag Task 23 wants | openrsync → rsync 3.2.7 |
| --- | --- |
| `-a` push and pull | works; spaces and unicode preserved byte-for-byte in both directions |
| `--delete` | works; removed a destination-only file, protected excluded paths |
| `--exclude-from=FILE` | works; verified on a clean destination, `cache/` never copied |
| `--files-from=FILE` | works; only the two named paths, including one with spaces |
| `--partial` | accepted |
| `--itemize-changes` | accepted, but see below |
| `--progress` | accepted; old single-line 2.6.9 format ending `(xfer#1, to-check=1/2)` |
| `--stats` | accepted; file and byte counts |
| `--out-format=FMT` | accepted |
| `--info=progress2` | **rejected**: ``rsync: unrecognized option `--info=progress2'`` |
| `--protect-args` | **rejected**: ``rsync: unrecognized option `--protect-args'`` |
| `-s` | **rejected**: `rsync: invalid option -- s` |

Two behavioural problems on top of the rejections:

- **Remote paths split on spaces.** With no `--protect-args`, pushing to
  `host:/tmp/…/awk ward/ö dir/` created `/tmp/…/awk` instead. Hand-escaping
  (`host:/tmp/…/awk\ ward/o\ dir/`) works, but that puts the controller back in the business of
  quoting for a remote shell for every root path.
- **Itemize output mangles non-ASCII names.** openrsync printed
  `ö-unicode-dir/smörgås �\#237\#217\#235.txt` where rsync 3.2.7 printed the real name, and its
  itemize flag field is 9 columns wide against rsync 3's 11. Per-file progress parsed from that
  output would be wrong for exactly the names the transfer engine cares most about. Files on disk
  were correct in every case; only the reporting is broken.

**Decision: the Mac controller bundles a real rsync 3.x** in the desktop release and uses the system
binary only as a fallback the doctor flags. openrsync can move the bytes, but it cannot give Task 23
protected remote arguments or a parseable per-root byte progress, which are two of that task's
stated requirements. Task 23's "include the selected macOS rsync when Task 4 requires it" is now a
requirement, and the supported-environment list says rsync 3.x.

### Tailscale serve and the fleet PWA

The existing `/` mapping to `http://127.0.0.1:8787` was never touched. One path mapping was added
and removed.

```bash
# add
tailscale serve --bg --yes --set-path /svall-spike http://127.0.0.1:8799
# remove — NOT `tailscale serve --https=443 off`, which the add command suggests and which
# would have taken the existing `/` mapping with it
tailscale serve --https=443 --set-path /svall-spike off
```

`tailscale serve status` before, during and after:

```text
https://test-server.tailnet.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:8787

https://test-server.tailnet.ts.net (tailnet only)
|-- /            proxy http://127.0.0.1:8787
|-- /svall-spike proxy http://127.0.0.1:8799

https://test-server.tailnet.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:8787
```

A path mapping coexists with the root mapping; both appear as separate `Handlers` entries under one
`test-server.tailnet.ts.net:443` web config. One gateway therefore needs exactly one mapping,
as the spec assumes.

The origin was a small WebSocket echo plus static server run with the **uploaded pinned Node**,
serving `/f/demo-fleet/`. From this Mac:

```console
$ curl -sSI https://test-server.tailnet.ts.net/svall-spike/f/demo-fleet/manifest.webmanifest
HTTP/2 200
content-type: application/manifest+json
```

```json
{ "name": "Svall demo-fleet", "short_name": "svall demo-fleet",
  "start_url": "/svall-spike/f/demo-fleet/", "scope": "/svall-spike/f/demo-fleet/",
  "display": "standalone",
  "icons": [{ "src": "/svall-spike/f/demo-fleet/icons/icon-192.png", "sizes": "192x192", "type": "image/png" }] }
```

Headers the origin saw, echoed back over the same mapping:

```json
{ "url": "/f/demo-fleet/headers",
  "headers": {
    "host": "test-server.tailnet.ts.net",
    "tailscale-headers-info": "https://tailscale.com/s/serve-headers",
    "tailscale-user-login": "linus.roxbergh@gmail.com",
    "tailscale-user-name": "Linus",
    "tailscale-user-profile-pic": "https://lh3.googleusercontent.com/…",
    "x-forwarded-for": "100.64.102.53",
    "x-forwarded-host": "test-server.tailnet.ts.net",
    "x-forwarded-proto": "https" } }
```

Three findings Task 30 and Task 31 depend on:

- **Tailscale serve strips the path prefix.** A request to `/svall-spike/f/demo-fleet/headers`
  reached the origin as `/f/demo-fleet/headers`. The gateway is mounted at its own root and cannot
  learn its public prefix from the request, so `start_url`, `scope`, asset URLs and the
  service-worker registration must be built from a configured public base rather than from
  `req.url`. In the intended deployment the mapping is `/` and the base is empty, but Task 30 must
  not assume that.
- **`Tailscale-User-Login` cannot be spoofed.** A curl that sent
  `Tailscale-User-Login: attacker@example.com` still arrived as
  `tailscale-user-login: linus.roxbergh@gmail.com`; the proxy overwrites the header it owns.
  `Tailscale-User-Name` behaves the same way. That is the assumption
  `packages/svalld/src/api/server.ts:55-66` already rests on, now checked on a live mapping.
- **Identity headers reach a WebSocket handshake too**, not just plain HTTP requests, so the relay
  can mint a viewer identity at upgrade time.

### Relay over the real mapping

From this Mac, a `wss://` connection through the same path mapping to the echo server:

```json
{ "gatewaySawUrl": "/f/demo-fleet/ws",
  "tailscaleUserLogin": "linus.roxbergh@gmail.com", "tailscaleUserName": "Linus",
  "rpcBytes": 2124, "rpcEchoMatches": true, "rpcRoundTripMs": 11.1,
  "binaryIsBinary": true, "binaryBytes": 1048576, "binaryEchoMatches": true,
  "binaryRoundTripMs": 181.8 }
```

An RPC-sized JSON frame (2,124 B) and a 1 MiB binary frame both round-tripped byte-identical over
one WSS socket through `tailscale serve`, at 11.1 ms and 181.8 ms.

### Relay framing contract

`packages/svalld/test/gateway/relay-contract.test.ts` (14 tests, hermetic, always runs) and its
`fake-gateway.ts` helper pin the shape:

- The owner dials the gateway outbound at `/relay` with `x-svall-fleet`, `x-svall-machine`,
  `x-svall-generation` and `x-svall-secret`. Authentication happens at the HTTP upgrade, so a
  refused owner never gets a socket: wrong or unknown fleet secret → **401**, a second owner at the
  same generation or a stale one → **409**, and a newer generation takes the fleet over and closes
  the incumbent with **4410**. Secret comparison is constant-time over SHA-256 digests.
- A viewer connects at `/f/<fleetId>/socket`. No `Tailscale-User-Login` → **401**; no owner holding
  the fleet → **503**.
- The gateway mints `{ fleet, login, name, issuedAt }` from the proxy header alone and attaches an
  HMAC-SHA256 signature; the owner verifies it. An identity a viewer supplies in its own frame is
  discarded. Verification fails on a tampered claim and on the wrong key.
- Text frames are JSON `{ t: 'rpc' | 'res' | 'event', id, viewer, … }`. Binary frames are a 4-byte
  big-endian header length, that many bytes of JSON header, then the payload, so a terminal frame
  carries the same `id` and `viewer` as an RPC frame. One owner socket carried a 1 MiB + 7 B
  terminal frame up, a 1 MiB + 7 B frame back down, and interleaved RPC calls, responses and an
  event in both directions, matched by id rather than by arrival order. Two viewers on one owner
  socket each received only their own frames.
- Viewer ids are scoped to a fleet on the way back down as well as up. With two fleets registered,
  an owner of fleet A naming a viewer id belonging to fleet B delivers nothing, for a JSON frame
  and for a binary one; that viewer receives only its own owner's answer.
- A peer that sends a frame the gateway cannot parse — a binary frame whose declared header length
  overruns it, or a text frame that is not JSON — has that one socket closed with **1008** while
  every other connection keeps working, and no decode throws inside a message handler.
- Sockets are plain `ws://` on loopback; TLS is terminated by `tailscale serve` in front of the real
  gateway, which the test file states in a comment rather than asserting.

Mutation check: removing the generation fence and letting a viewer-supplied identity win made 3 of
14 tests fail; removing the fleet comparison on the owner's send path made the cross-fleet test
fail. The auth assertions bite.

Three obligations this contract hands to Tasks 30 and 31 rather than settling:

- **The gateway's identity signing key needs a provisioning path.** The contract signs the viewer
  identity with an HMAC, which means every owner must hold the same key to verify it, and nothing
  provisions it today. The decision for Task 31 is to **derive the identity key from the per-fleet
  relay secret** the spec already provisions mode 0600 (an HKDF with a fixed `identity` info
  string), so a fleet gains no second secret and the key rotates with the relay secret. The
  alternative — a separate gateway key pair with public-key signatures — buys the owner nothing
  here, because the only signer it ever trusts is the gateway it authenticated to. If Task 31 ever
  needs an identity a third party can verify, that trade changes.
- **The owner-side rule was not exercised.** The spec's "the owner accepts a forwarded identity
  only on the authenticated relay, never on its normal API" is a property of
  `packages/svalld/src/api/server.ts`, not of the gateway, and nothing here tests it. It stays an
  explicit Task 31 obligation: an ordinary API socket presenting a relay-shaped identity frame must
  be refused, with its own test.
- **Every frame is untrusted input, on both sides of the relay.** The contract now says a peer that
  sends a frame the other end cannot parse — a binary frame whose declared header length overruns
  it, a text frame that is not JSON, a frame carrying no string `id`, or anything over the maximum
  frame size — has that one socket closed with **1008**, and the gateway keeps serving everyone
  else. A decode must never throw inside a message handler. **Maximum frame size: 4 MiB**, four
  times the 1 MiB terminal burst the spec names, which leaves room for a header and a screenful of
  backlog while staying far below the `ws` default of 100 MiB. Task 31 must set `maxPayload` to the
  same figure on the real relay and on `api/server.ts`, so an oversized frame is refused by the
  library rather than buffered first.

### Test and verification evidence

```console
$ pnpm vitest run --project svalld test/gateway/relay-contract.test.ts
 Test Files  1 passed (1)
      Tests  14 passed (14)

$ pnpm typecheck        # clean
$ pnpm vitest run --project svalld
 Test Files  47 passed (47)
      Tests  544 passed (544)
```

### Remote cleanup

Nothing was installed on `test-server`; no package was added, `~/.config/systemd` and
`~/.local` were not written to, and no credential was copied. Afterwards:

```bash
tailscale serve --https=443 --set-path /svall-spike off   # `/` mapping verified intact
pkill -f gateway-probe.mjs
tmux -S /tmp/svall-spike-1790013049/fleet/tmux.sock kill-server
rm -rf /tmp/svall-spike-1790013049
```

Verified after: no process matching `svall.spike`, no `/tmp/svall-spike-1790013049`, serve status
back to the single `/` mapping, and no `~/.local/share/svall` or `~/.svall`.

### Clean-container run (Docker)

The Ubuntu host run avoided the system `node` by restricting `PATH`; this run proves absence. Both
architectures were built from the same script, which reads the architecture out of the Node tarball
name and needed no change:

```bash
node scripts/spikes/build-companion.mjs \
  --node-tarball <scratch>/node-dist/node-v22.23.2-linux-arm64.tar.xz \
  --node-shasums <scratch>/node-dist/SHASUMS256.txt \
  --out <scratch>/docker/arm64 --sign-key <scratch>/release-key
# and the same with -linux-x64.tar.xz into <scratch>/docker/x64
```

| Archive | Bytes | SHA-256 | Node tarball SHA-256 |
| --- | --- | --- | --- |
| `svall-companion-0.0.0-spike+v22.23.2-linux-arm64.tar.gz` | 58,323,073 | `8035e0a772c2b633acbc726820cfd98a451705e058f978fcb4496ebc65464070` | `fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8` |
| `svall-companion-0.0.0-spike+v22.23.2-linux-x64.tar.gz` | 58,472,714 | `29bbba4e20ebc861092ce247bb3cdcb93a62aa6c89bf5fe5ac6a888b8f66f6b9` | `d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307` |

Each archive directory also holds the probe script, `install-release.mjs` and the tmux config from
the host run, and is mounted read-only:

```bash
docker run --rm --platform linux/arm64 -v <scratch>/docker/arm64:/in:ro ubuntu:24.04 bash /in/run.sh
docker run --rm --platform linux/amd64 -v <scratch>/docker/x64:/in:ro   ubuntu:24.04 bash /in/run.sh
```

Image: `ubuntu:24.04`, index digest
`sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3`, per-platform manifests
`sha256:11dc1ccb427f0464a2369e645454c272bb0baece7357c892ba69d313b3a332cf` (arm64) and
`sha256:496754492fb28b4d3049432f2ca787449331e23fb14f0dd3fffea86bf5a93eb4` (amd64), reporting
`Ubuntu 24.04.5 LTS`. Docker Desktop 29.4.3 on Apple Silicon, so linux/arm64 is native and
linux/amd64 runs under Rosetta rather than QEMU (`UseVirtualizationFrameworkRosetta: true`).

The container has no `node`, `nodejs`, `npm`, `pnpm` or `git`, and no repository. The bundled
runtime is bootstrapped out of the archive itself — `tar -xzf … releases/<version>/node/bin/node`
— and every later step is run by that binary. It started with no added package: Ubuntu's base
`libstdc++6` and `libc` are enough.

| Step | linux/arm64 (native) | linux/amd64 (Rosetta) |
| --- | --- | --- |
| `node -v` from the archive | `v22.23.2`, `linux arm64` | `v22.23.2`, `linux x64` |
| `install-release.mjs` | `filesVerified: 4846`, `current` → `releases/0.0.0-spike+v22.23.2` | identical |
| install wall-clock | 1 s | 3 s |
| re-install of the same archive | `Error: … is already installed` | identical |
| `bin/svall --help` | full command list, exit 0 | identical |
| `bin/svalld --help` | no output, exit 1 | identical |
| `svall doctor --json` | `node v22.23.2` ok; `tmux` fail; `claude` fail; exit 1 | identical |
| `lib/locate-probe.mjs` | hooks and home template ok; `MOBILE_DIST` missing; `REPO_ROOT` a false positive | identical |
| `apt-get update && apt-get install -y tmux` | 3 s, `tmux 3.4` | 5 s, `tmux 3.4` |
| generated config via `-f` | exit 0, empty stderr | identical |
| generated config via `source-file` | exit 1, one line: `…:17: invalid option: extended-keys-format` | identical |
| `svall doctor` tmux check, tmux installed | `warn: tmux 3.4: Shift+Enter needs tmux 3.5 or newer` | identical |
| total wall-clock, `docker run` to exit | 8 s | 13 s |

Rosetta costs roughly 1.6× on this workload; nothing about the amd64 run differed in behaviour.

The `locate-probe` output is the same failure the host run recorded, with the release now under a
real `~/.local/share`:

```json
{
  "bundleUrl": "file:///root/.local/share/svall/releases/0.0.0-spike+v22.23.2/lib/locate-probe.mjs",
  "releaseRootEnv": "/root/.local/share/svall/current",
  "mobileDist": "/root/.local/share/apps/desktop/web/dist-mobile",
  "mobileDistExists": false,
  "repoRoot": "/root/.local/share/svall/",
  "repoRootExists": true,
  "hookScripts": { "ok": true, "hookScript": "/tmp/probe-home/hooks/agent-hook.mjs", "bytes": 3198 },
  "homeTemplate": { "ok": true, "done": ["home CLAUDE.md -> …", "home skills -> …", "home settings -> …"] }
}
```

`REPO_ROOT` lands on the install prefix, which exists, so the false positive that would run `pnpm`
survives the real install path exactly as predicted. The release's own `web-mobile/` is present and
correct (`index.html`, 771 B) — the assets ship, only the lookup is wrong.

Three things this run found that the host run could not:

- **`svalld --help` is not a flag.** The daemon ignores it and starts. Without tmux it dies and
  exits 1 writing nothing to stderr (the reason goes only to `~/.svall/svalld.log`); with
  tmux installed, a follow-up container ran `timeout 20 bin/svalld --help` and got exit 124, a
  listening daemon on `127.0.0.1:47800` and a full `~/.svall`. Task 12 must give `svalld` a
  `--help` that prints and exits, alongside the missing `svall version` command.
- **`ssh-keygen` is absent from a bare Ubuntu 24.04**, so the release signature cannot be verified
  as designed. `install-release.mjs --allowed-signers` fails closed, and the prefix is left empty,
  but the message misattributes the cause:
  `Error: …: SHA256SUMS is not signed by svall-release: spawnSync ssh-keygen ENOENT`. Task 13
  must either depend on `openssh-client` in the Add Machine checks or verify the ed25519 signature
  in Node, and must distinguish "no verifier" from "bad signature".
- **`svall doctor`'s remedies are macOS-only.** On Linux it says `not found on PATH: brew install
  tmux`, `brew install gh` and `brew upgrade tmux`, and checks `launchd` and
  `com.svall.svalld`. Task 12 needs platform-aware remedies and a systemd check.

No system node ever existed here, so no `PATH` restriction was needed and the run also confirms the
archive carries every file the release needs: 4,846 digests verified against `SHA256SUMS` by the
bundled runtime with nothing else on the machine.

**Not proven.** A systemd user unit installing and surviving a reboot; the gateway serving the
release's real `web-mobile/` assets to a phone; a phone adding the PWA to a Home Screen; the
signature path on a machine with `openssh-client`; and arm64 on real arm64 hardware — the arm64
companion is now proven in a native linux/arm64 container, and the amd64 companion in both a
container and on the real Ubuntu host.

---

## Environment findings

These are properties of the machines rather than of the design, and every one of them changes a
later task.

- **Ubuntu 24.04 ships tmux 3.4, not 3.5.** Shift+Enter's `extended-keys-format` is unknown to it;
  everything else in the generated config applies, and tmux keeps reading the file past the unknown
  line. Recorded in the spec's supported environment and in Add Machine's checks as a warning.
- **macOS `/usr/bin/rsync` is openrsync, not rsync 3.x**, and it lacks `--info=progress2`,
  `--protect-args` and `-s`, splits remote paths on spaces, and mangles non-ASCII names in
  `--itemize-changes` and `--out-format` output. The Mac release must bundle rsync 3.x.
- **macOS `tar` writes Apple xattr headers** that GNU tar warns about on every file, and falls back
  to AppleDouble `._` members when only `--no-xattrs` is given. Release builds need `--no-xattrs`
  and `COPYFILE_DISABLE=1`.
- **`tailscale serve --set-path` strips the prefix** before proxying, and the removal command it
  prints on success (`tailscale serve --https=443 off`) removes every handler on that port, not just
  the one just added. Use `--set-path <path> off`.
- **Tailscale overwrites `Tailscale-User-*` headers**, including on WebSocket upgrades, so a client
  cannot forge one.
- **Node's official linux-x64 tarball unpacks to 199 MB**, 78 MB of which is headers, npm and
  corepack the companion never uses.
- **A bare `ubuntu:24.04` has no `ssh-keygen`.** `openssh-client` is not in the base image, so a
  companion machine cannot verify the release signature until something installs it.
- **Docker Desktop on Apple Silicon runs linux/amd64 under Rosetta**, not QEMU, so an emulated
  amd64 container costs about 1.6× the native arm64 run rather than an order of magnitude.
- **The Linux target has no Codex CLI installed**, so cross-machine agent-session resume stays
  unproven; see Tasks 1 and 2.
