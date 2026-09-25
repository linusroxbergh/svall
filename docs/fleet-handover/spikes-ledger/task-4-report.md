# Task 4 report — Prove release packaging and stable relay assumptions

Status: DONE_WITH_CONCERNS. Nothing was blocked; two assumptions failed and are recorded, not
hidden: macOS openrsync cannot serve Task 23, and the daemon's `import.meta.url` path climbs do not
survive bundling.

Commit: `caa7c0d The release and relay assumptions have executable probes`.

## What was built

Repo (committed):

- `scripts/spikes/build-companion.mjs` — stages a Linux companion release: esbuild bundles of
  `packages/cli/src/main.ts` and `packages/archid/src/bin.ts`, a third `locate-probe` bundle built
  from the same sources to report what the path climbs resolve to, an unpacked pinned Node tarball,
  hooks, home template, phone assets, licences, `SHA256SUMS`, an optional `ssh-keygen -Y` signature,
  `release.json`, and a tarball.
- `packages/archid/test/gateway/relay-contract.test.ts` — 12 hermetic tests of the relay contract.
- `packages/archid/test/gateway/fake-gateway.ts` — the minimal fake gateway plus the frame codec and
  identity signing the test drives.
- `package.json` / `pnpm-lock.yaml` — **esbuild ^0.28.2 added as a root devDependency** (allowed by
  the brief). The lock gained three lines only, because tsx already resolved esbuild 0.28.2.

Gitignored, in the main checkout:

- `docs/superpowers/plans/fleet-handover-spike-results.md` — new; Task 1, Task 2, a Task 3
  placeholder, Task 4 and Environment findings.
- `docs/superpowers/specs/2026-09-20-fleet-handover-design.md` — tmux and rsync in "Supported
  environment", Add Machine step 3's tmux check demoted to a warning, and the release-signature
  mechanism added to "Companion release".
- `docs/superpowers/plans/2026-09-20-fleet-handover.md` — Task 4 boxes ticked; Tasks 12, 23 and 30
  updated.

## Live experiments

Target: `ssh 100.117.42.24` (`linus-vault`, Ubuntu 24.04.2 x86-64, tmux 3.4, rsync 3.2.7,
Tailscale 1.84). All work confined to `/tmp/archi-spike-1790013049`. No package installed, nothing
written to `~/.local` or `~/.config/systemd`, no credential copied. Every subprocess was spawned as
executable plus argv from Node; the only shell text was short remote `bash -c` probes with no
interpolated untrusted data.

### 1. tmux 3.4 against the config archid generates

Generated `tmuxConfText(loadConfig(...))` with the `pbcopy` line stripped, as the plan's Task 13
requires, and uploaded it.

```console
$ tmux -S <tmp>/tmux.sock -f <tmp>/linux-tmux.conf new-session -d -s spike
exit=0                    # empty stderr
$ tmux -S <tmp>/tmux.sock show-options -s extended-keys
extended-keys on
$ tmux -S <tmp>/tmux.sock show-options -s extended-keys-format
invalid option: extended-keys-format
```

`history-limit`, `default-size`, `window-size`, `mouse` and `status` all took effect, and
`send-keys` into the session ran a command that wrote the expected file.

Ordering probe (`history-limit 11111`, unknown option, `default-shell`, `history-limit 22222`):
3.4 **continues past the unknown option** — `history-limit 22222` and `default-shell /bin/bash`
both applied, for `-f` at startup and for `source-file` into a running server. `-f` swallows the
error; `source-file` prints `<conf>:2: invalid option: extended-keys-format` and exits 1. The live
archid run logged exactly that as an error. Only Shift+Enter is lost.

### 2. rsync interop, macOS openrsync → rsync 3.2.7

`/usr/bin/rsync` is openrsync ("protocol version 29", "rsync version 2.6.9 compatible"); no
Homebrew rsync exists on this Mac. Tree with `a dir with spaces/`, `ö-unicode-dir/smörgås 🏝.txt`,
a `cache/` to exclude, both directions.

Accepted and correct: `-a`, `--delete`, `--exclude-from=FILE`, `--files-from=FILE`, `--partial`,
`--itemize-changes`, `--progress`, `--stats`, `--out-format=FMT`.

Rejected:

```text
rsync: unrecognized option `--info=progress2'
rsync: unrecognized option `--protect-args'
rsync: invalid option -- s
```

Two behavioural failures beyond the rejections:

- Remote paths split on spaces. `host:/tmp/…/awk ward/ö dir/` created `/tmp/…/awk`
  (`created directory /tmp/archi-spike-1790013049/awk`). Backslash-escaping the remote path works,
  which is exactly the hand-quoting `--protect-args` exists to avoid.
- Non-ASCII names are mangled in reporting: openrsync printed
  `ö-unicode-dir/smörgås �\#237\#217\#235.txt` where rsync 3.2.7 printed the real name, and its
  itemize flag field is 9 columns against rsync 3's 11. Files on disk were correct throughout;
  only `--itemize-changes` / `--out-format` output is unusable for parsing.

`--exclude-from` was re-tested against a *clean* destination because the first result was ambiguous
(excluded files are also protected from `--delete`); on a clean destination `cache/` was correctly
never copied.

**Decision: the Mac controller bundles rsync 3.x.** Recorded in the spec's supported environment,
in Task 23, and in the results doc.

### 3. Companion build and clean-machine run

```bash
pnpm --filter @archipelago/desktop-web build:mobile
node scripts/spikes/build-companion.mjs \
  --node-tarball <scratch>/node-v22.23.2-linux-x64.tar.xz \
  --out <scratch>/companion --sign-key <scratch>/release-key
```

Node **v22.23.2** (`lts: Jod`, the current 22.x LTS), verified against `SHASUMS256.txt`:
`d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307`.

esbuild produced zero warnings. Nothing needed an escape hatch beyond
`--external:bufferutil --external:utf-8-validate` (optional `ws` accelerators) and a
`createRequire` banner for the CJS dependencies. `web-push` bundled with no dynamic require.
`lib/archi.mjs` 590,030 B, `lib/archid.mjs` 902,301 B. The only `linusroxbergh` string in either
product bundle is the repository URL in `pushContact`'s config default — no developer paths.

Uploaded, unpacked and pointed at by an atomic
`ln -sfn … current.tmp && mv -T current.tmp current`. Then, with `PATH=/usr/bin:/bin` and `HOME`
inside the temp dir:

```text
node/bin/node -v            v22.23.2   (linux x64)
bin/archi, bin/archid       -rwxr-xr-x after the tar round trip
sha256sum -c SHA256SUMS     OK
ssh-keygen -Y verify        Good "archipelago-release" signature … ED25519 SHA256:mx90bRPj…
archi --help                full command list, exit 0
archi doctor --json         node v22.23.2 ok; tmux 3.4 warn; claude fail (not installed)
archid                      started, listened on 127.0.0.1:47800, stopped on SIGTERM
```

`archid` wrote `state.json`, `port`, `tmux.conf`, `hooks.sock`, `tmux.sock`, and `token`,
`mobile-key`, `vapid.json` at 0600.

### 4. What breaks under bundling

`lib/locate-probe.mjs`, run from the installed release:

```json
{ "bundleUrl": "file:///…/releases/0.0.0-spike+v22.23.2/lib/locate-probe.mjs",
  "releaseRootEnv": "/…/install/current",
  "mobileDist": "/tmp/archi-spike-1790013049/apps/desktop/web/dist-mobile",
  "mobileDistExists": false,
  "repoRoot": "/tmp/archi-spike-1790013049/install/",
  "repoRootExists": true,
  "hookScripts": { "ok": true, "bytes": 3198 },
  "homeTemplate": { "ok": true, "done": ["home CLAUDE.md -> …", "home skills -> …", "home settings -> …"] } }
```

- `setup.ts:134` and `setup.ts:151` **keep working by coincidence**: both climb one `..`, and
  `lib/` happens to sit one level under the root carrying `hooks/` and `home/`. Silently coupled to
  the layout.
- `api/bundle.ts:4` `MOBILE_DIST` **breaks**; every phone request would answer
  `The phone bundle is not built.`
- `mobile.ts:18` `REPO_ROOT` **breaks silently and worse**: it resolves to `<install>/`, which
  exists, so an existence check passes and `mobile.ts:47-48` would run `pnpm --filter … build:mobile`
  there on a machine with no pnpm.

Task 12 must add `packages/archid/src/release.ts` with `releaseRoot()` reading `ARCHI_RELEASE_ROOT`
(already exported by the shims) and falling back to the repo layout, with `hooksDir()`,
`homeTemplateDir()` and `mobileDistDir()` derived from it. Recorded in the plan. No production code
was changed in this task.

Two more packaging facts, both recorded:

- **`archi version` does not exist.** The root action treats a bare positional as a profile name;
  `archi version` printed `archi: no profile version; run archi version in a terminal to create it`
  and exited 0. Task 12's "run `archi version --json` from a clean artifact" needs the command added.
- **macOS tar taints the archive, and it takes two flags.** A plain bsdtar `-czf` made GNU tar print
  5,957 `Ignoring unknown extended header keyword 'LIBARCHIVE.xattr.com.apple.provenance'` warnings
  on the target. `--no-xattrs` alone only makes bsdtar fall back to AppleDouble `._` members;
  `COPYFILE_DISABLE=1` removes those. The spike script now passes both and the archive verifies
  clean (0 `LIBARCHIVE` keywords, 0 `._` members; 58,460,924 B against 59,034,579 B before).
- The runtime should be pruned: of 199 MB unpacked, `node/include` is 62 MB and
  `node/lib/node_modules` 16 MB.

### 5. Tailscale serve

The existing `/` → `http://127.0.0.1:8787` mapping was never modified. Exactly one path mapping was
added and removed.

```console
$ tailscale serve status                                                  # BEFORE
https://linus-vault.prawn-turtle.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:8787

$ tailscale serve --bg --yes --set-path /archi-spike http://127.0.0.1:8799
$ tailscale serve status                                                  # DURING
https://linus-vault.prawn-turtle.ts.net (tailnet only)
|-- /            proxy http://127.0.0.1:8787
|-- /archi-spike proxy http://127.0.0.1:8799

$ tailscale serve --https=443 --set-path /archi-spike off
$ tailscale serve status                                                  # AFTER
https://linus-vault.prawn-turtle.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:8787
```

The success message from the add command suggests `tailscale serve --https=443 off`, which would
have removed the existing `/` mapping too. It was not used; `--set-path <path> off` removes only
the one handler.

Origin: a WebSocket echo plus static server run with the **uploaded pinned Node**, serving
`/f/demo-fleet/`.

```console
$ curl -sSI https://linus-vault.prawn-turtle.ts.net/archi-spike/f/demo-fleet/manifest.webmanifest
HTTP/2 200
content-type: application/manifest+json
```

The manifest carried `"start_url": "/archi-spike/f/demo-fleet/"` and the same `scope`. Headers the
origin saw: `tailscale-user-login: linus.roxbergh@gmail.com`, `tailscale-user-name: Linus`,
`tailscale-user-profile-pic`, `tailscale-headers-info`, plus `x-forwarded-for/host/proto`.

Three findings:

- **Serve strips the mapping prefix**: `/archi-spike/f/demo-fleet/headers` arrived as
  `/f/demo-fleet/headers`. Task 30 must build absolute URLs from a configured public base.
- **`Tailscale-User-Login` cannot be spoofed**: a curl sending
  `Tailscale-User-Login: attacker@example.com` still arrived as the real login.
- **Identity headers reach the WebSocket handshake**, not only plain HTTP.

### 6. Relay over the real mapping

```json
{ "gatewaySawUrl": "/f/demo-fleet/ws",
  "tailscaleUserLogin": "linus.roxbergh@gmail.com", "tailscaleUserName": "Linus",
  "rpcBytes": 2124, "rpcEchoMatches": true, "rpcRoundTripMs": 11.1,
  "binaryIsBinary": true, "binaryBytes": 1048576, "binaryEchoMatches": true,
  "binaryRoundTripMs": 181.8 }
```

A 2,124 B JSON RPC frame and a 1 MiB binary frame both round-tripped byte-identical over one
`wss://` socket through the path mapping, at 11.1 ms and 181.8 ms.

## Tests

`packages/archid/test/gateway/relay-contract.test.ts`, 12 tests, fully hermetic (loopback `ws://`,
no network, no remote, no skips):

1. owner accepted with the fleet secret and a generation;
2. wrong secret → 401;
3. unknown fleet → 401;
4. second owner at the same generation → 409, first kept;
5. stale generation → 409;
6. newer generation takes over and closes the incumbent with 4410;
7. viewer without `Tailscale-User-Login` → 401;
8. viewer with no owner holding the fleet → 503;
9. gateway signs the identity it mints from the header; verification fails on a tampered claim and
   on the wrong key;
10. a viewer-supplied identity is discarded;
11. RPC and 1 MiB + 7 B terminal frames multiplexed both ways over one owner socket, matched by id
    rather than arrival order, with responses and an event coming back;
12. two viewers on one owner socket each receive only their own frames.

Mutation check: removing the generation fence and letting a viewer-supplied identity win turned
3 of the 12 red, then restored.

```console
$ pnpm vitest run --project archid test/gateway/relay-contract.test.ts
 Test Files  1 passed (1)        Tests  12 passed (12)

$ pnpm typecheck                 clean

$ pnpm vitest run --project archid
 Test Files  47 passed (47)      Tests  541 passed (541)
```

Output pristine in all three.

## Files changed

Committed (path-scoped `git add`, never `-A`):

- A `scripts/spikes/build-companion.mjs`
- A `packages/archid/test/gateway/relay-contract.test.ts`
- A `packages/archid/test/gateway/fake-gateway.ts`
- M `package.json` (esbuild devDependency; the `engines` line pnpm reflowed was restored)
- M `pnpm-lock.yaml` (3 lines)

Gitignored, not committed:

- A `docs/superpowers/plans/fleet-handover-spike-results.md`
- M `docs/superpowers/specs/2026-09-20-fleet-handover-design.md`
- M `docs/superpowers/plans/2026-09-20-fleet-handover.md`

Not committed and not intended to be: `apps/desktop/web/dist-mobile` (gitignored build output,
produced so the archive could carry real phone assets).

## Remote cleanup

```bash
tailscale serve --https=443 --set-path /archi-spike off
pkill -f gateway-probe.mjs
tmux -S /tmp/archi-spike-1790013049/fleet/tmux.sock kill-server
kill -9 370361                      # the tmux server archid had left behind
rm -rf /tmp/archi-spike-1790013049
```

Verified afterwards over a fresh ssh: no process matching `archi.spike`, no
`/tmp/archi-spike-1790013049`, `tailscale serve status` back to the single `/` mapping, and no
`~/.local/share/archipelago` or `~/.archipelago`. `~/.config/systemd/user` was pre-existing and
untouched. One `pkill -f "archi-spike-1790013049"` killed its own ssh session (the pattern matched
the remote `bash -c` string); the follow-up connection confirmed the state, and a leftover tmux
server from the archid run was killed by pid.

## Self-review

- Against the brief: all five steps done, file names and commit subject verbatim, all eight
  controller rulings followed.
- Ruling 1: only `/tmp/archi-spike-<timestamp>` touched; system node deliberately shadowed with
  `PATH=/usr/bin:/bin` for every exercise; nothing installed.
- Ruling 2: read `tailscale serve --help` on the remote first, used `--set-path`, removed exactly
  that mapping with `--set-path … off` rather than the suggested `--https=443 off`, and showed
  before/during/after.
- Ruling 5: no production code was modified. The `import.meta.url` breakage is reported, not fixed.
- Ruling 6: the relay test is hermetic and always runs; it is a framing and auth contract, with no
  product types imported. `ws://` with the TLS comment in the file header.
- No secret ever entered argv or a log. The ephemeral release key lives only in the scratchpad and
  is not in the repo. The ssh public key and the fleet relay secret in the test are fabricated.
- YAGNI: the build script's redundant `--arch` option was removed once the tarball name already
  carries it; the fake gateway has no heartbeat, backpressure or reconnect, which are Task 31's.
- Comments: the two flags esbuild needed and the two tar flags macOS needs are commented because
  neither is inferable; nothing else is.
- The spike script's `tar --no-xattrs` fix was verified locally by inspecting the archive, not by a
  second remote round trip, because the remote had already been cleaned. The 5,957-warning
  observation stands from the real unpack; the clean-archive claim rests on 0 `LIBARCHIVE` keywords
  and 0 `._` members in the rebuilt tarball.

## Concerns / failed assumptions

1. **openrsync is not usable for Task 23** — `--info=progress2`, `--protect-args` and `-s` are all
   rejected, remote paths split on spaces, and non-ASCII names are mangled in itemize output. The
   Mac release must bundle rsync 3.x; Task 23's "if Task 4 requires it" is now unconditional.
2. **The daemon's `import.meta.url` path climbs do not survive bundling.** `MOBILE_DIST` breaks
   outright and `REPO_ROOT` breaks into a false positive that would try to run `pnpm` on the
   gateway. `setup.ts`'s two lookups work only by layout coincidence. Task 12 must land `release.ts`
   before any published companion serves a phone.
3. **`archi version` does not exist**, so Task 12's own verification step cannot run as written
   until the command is added.
4. **Shift+Enter is unavailable on Ubuntu 24.04's tmux 3.4.** The config is otherwise fully
   accepted, and tmux keeps reading past the unknown line, but `source-file` returns 1 and archid
   logs an error. Task 13 should omit the line below 3.5.
5. **Tailscale Serve strips the mapping prefix**, so the gateway cannot derive its own public base
   from a request. Recorded in Task 30.
6. Task 3 (`9e00063 A fixture proves linked worktrees can move safely`) landed on this branch just
   before my commit. Ruling 3 said to leave the results doc's Task 3 section as
   `Pending: filled in after Task 3 lands`, so I did — the controller may want to fill it now.
7. Not proven here and out of scope: arm64 (only linux-x64 was built and run), a systemd unit
   install, the gateway serving the release's real `web-mobile` assets rather than a synthetic
   manifest, and a phone actually adding the PWA to a Home Screen.

## Fix pass (review round 1)

Commit: `c4171e4 The spike verifies the runtime it ships and fences viewers by fleet`.

### Important 1 — the fake gateway routed owner→viewer frames without a fleet check

Real. `viewers` stored each viewer's `fleet` but the owner's send path never compared it, so an
owner of fleet A naming a viewer id from fleet B delivered into fleet B. Invisible because every
test booted one fleet.

`fake-gateway.ts` now resolves a viewer through a `target()` helper that returns the socket only
when `viewer.fleet === fleet`, used by both the JSON and the binary send path. The test's
`boot()` registers a second fleet and `dialOwner`/`dialViewer` take a `fleet` option.

Covering test: `drops an owner frame that names a viewer of another fleet`. Two owners, one viewer
on the second fleet; the first fleet's owner sends a JSON response and a binary terminal frame both
naming that viewer id, the second fleet's owner sends a legitimate response, and after a 100 ms
settle the viewer has received exactly one frame — its own owner's.

RED/GREEN: with `target()` reduced to `viewer?.ws`, `1 failed | 12 passed`. Restored:
`13 passed`.

### Important 2 — the pinned runtime entered the signed release unverified

Real. `--node-tarball` was taken on trust and unpacked, so `SHA256SUMS`, `release.json` and the
signature attested to an unchecked runtime.

`build-companion.mjs` now calls `verifyNodeTarball()` before anything is staged: it reads
`https://nodejs.org/dist/<version>/SHASUMS256.txt` with Node's `fetch` (no shell) or a local copy
via `--node-shasums`, finds the line for the tarball's own basename, and throws on a missing entry
or a mismatch. `release.json` and the script's stdout record
`node: { version, tarball, sha256, verifiedAgainst }`.

Covering runs:

```console
$ node scripts/spikes/build-companion.mjs --node-tarball <tampered>/node-v22.23.2-linux-x64.tar.xz --out <tmp>
Error: node-v22.23.2-linux-x64.tar.xz is not the published runtime:
  expected d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307,
  got 13c76c47a06521b78f8cb25cda8e646dc3ba00aaf6c473333632c938b73203dc
# --out was never created

$ node scripts/spikes/build-companion.mjs … --node-shasums <scratch>/node-dist/SHASUMS256.txt
"node": { "version": "v22.23.2", "sha256": "d60acfe0…", "verifiedAgainst": "<scratch>/…/SHASUMS256.txt" }
```

The tampered tarball was one byte appended to a copy; the original was untouched.

### Spec gap A — the atomic `current` swap is now executable

Added `scripts/spikes/install-release.mjs`:

```bash
node scripts/spikes/install-release.mjs --tarball <archive.tar.gz> --prefix <dir> \
  [--allowed-signers <file>] [--signer <identity>]
```

It reads the version from the archive's member names (`tar -tzf`, exactly one `releases/<v>/`
prefix) rather than guessing which directory it just wrote, unpacks into
`<prefix>/releases/<version>/`, verifies every `SHA256SUMS` line, optionally verifies
`SHA256SUMS.sig`, then `symlink → current.tmp-<pid>` and `rename` over `current`. Nothing is
deleted, so the previous release stays as the rollback target and is reported as `rollbackTo`.

Exercised locally in a scratchpad temp directory, not on the remote. A second release was built
with `--version 0.0.1-spike` for the upgrade case.

| Case | Observed |
| --- | --- |
| install first release | `current` → `releases/0.0.0-spike+v22.23.2`, `filesVerified: 4846`, `signatureVerified: true`, `rollbackTo: null` |
| upgrade | `current` → `releases/0.0.1-spike`, `rollbackTo` = the first release, `releasesKept` = both |
| `--signer someone-else` | `Error: … SHA256SUMS is not signed by someone-else` |
| one byte appended to `lib/archi.mjs`, repacked | `Error: lib/archi.mjs: expected 0c708051…, got e8944b64…`; `current` was never created |

### Spec gap B — bundled dependency licences now ship

`bundledLicenses()` maps every esbuild metafile input back to its `node_modules/<pkg>` (handling
pnpm's nested layout and scoped names) and copies the first `LICENSE`/`LICENCE`/`COPYING` it finds.
23 packages were collected — `ws`, `web-push`, `zod`, `commander`, `qrcode`, `fast-json-patch`,
`smol-toml` and their transitive dependencies — so `licenses/` now holds 25 files. The list is also
written to `release.json` as `bundledLicenses`, so a new dependency without a licence file is
visible in the manifest rather than silently dropped. 38 lines including the release.json wiring;
under the ~30-line bar for the collector itself.

### Carry-forward notes added to the results doc

Both are in the Task 4 section under "Relay framing contract":

- (a) The HMAC identity scheme needs every owner to hold the gateway's signing key, and nothing
  provisions it. Decision recorded for Task 31: derive the identity key from the per-fleet relay
  secret the spec already provisions mode 0600, via HKDF with a fixed info string, so no second
  secret exists and the key rotates with the relay secret. Public-key signing buys nothing while
  the only signer an owner trusts is the gateway it authenticated to.
- (b) "The owner accepts a forwarded identity only on the authenticated relay, never on its normal
  API" is a property of `api/server.ts` and was not exercised. Recorded as an explicit Task 31
  obligation with its own test.

Plan updates that fell out: Task 12 gained the digest-verification and licence-collection steps;
Task 13 gained the verify-then-atomically-swap install step naming `install-release.mjs`; Task 31's
secret step says to derive the identity key from the relay secret, and its owner-side step now says
the gateway contract test does not cover it.

### Verification

```console
$ pnpm vitest run --project archid test/gateway/relay-contract.test.ts
 Test Files  1 passed (1)        Tests  13 passed (13)

$ pnpm typecheck                 clean

$ pnpm vitest run --project archid
 Test Files  47 passed (47)      Tests  542 passed (542)
```

No remote work in this pass; `linus-vault` was not touched again and stays as the earlier cleanup
left it.

Minor findings 3–11 were deferred per the coordinator; none fell out of these fixes. One latent bug
did: `install-release.mjs` originally picked the unpacked version by scanning the releases
directory, which would pick the wrong one with three or more releases installed. It reads the
version from the archive instead.

## Final-review fix wave

Commits: `08b83ac A release is authenticated in staging and a bad frame closes only its own socket`
and `bbcbe8e The handover probes prune before they rewrite and refuse a symlinked session`.

### Important 1 — install-release unpacked before it authenticated

Real, and the destination came from the untrusted archive. `install-release.mjs` now:

- derives the version from the archive's members, then checks it against `/^[A-Za-z0-9._+-]+$/`
  *and* that `path.join(prefix, 'releases', version)` still starts with `<prefix>/releases/`. The
  regex alone is not enough: `..` matches it, so the containment check is what actually refuses it.
- refuses a release directory that already exists, rather than overwriting it;
- unpacks into `<prefix>/.staging-<pid>/`, verifies there, and renames the whole verified tree into
  `releases/<version>/` only after digests and signature pass;
- refuses a `SHA256SUMS` line whose path resolves outside the release, and a line whose first field
  is not 64 hex characters;
- removes the staging directory in a `finally`, so a refusal leaves the prefix empty.

Re-run locally (scratchpad temp dirs, nothing remote):

| Case | Observed |
| --- | --- |
| install | `current` → `releases/0.0.0-spike+v22.23.2`, `filesVerified: 4846`, `signatureVerified: true`, `rollbackTo: null` |
| upgrade | `current` → `releases/0.0.1-spike`, `rollbackTo` = the first release, both kept |
| `--signer someone-else` | `Error: …: SHA256SUMS is not signed by someone-else` |
| tampered bundle | `Error: lib/archi.mjs: expected 0c708051…, got e8944b64…` |
| archive whose release dir is `..` | `Error: … names an unusable release directory: ".."` |
| `SHA256SUMS` line naming `../../../etc/hosts` | `Error: SHA256SUMS names a path outside the release: ../../../etc/hosts` |

`find` over each refused prefix afterwards showed the prefix directory and nothing else — no
`releases/`, no `current`, no staging.

The results doc's Decisions table gained an "Install order" row so Task 13 inherits
"authenticate in staging, then rename into `releases/`".

### Important 2 — the relay contract had no frame-validation obligation

`decodeBinary` now rejects a frame shorter than its header, a zero-length header and a header
length that overruns the frame. A new `decodeFrame(data, isBinary)` wraps it, enforces
`MAX_FRAME = 4 MiB`, requires a string `id` on a text frame, and returns `undefined` instead of
throwing. Both message handlers close that one socket with **1008** on `undefined` and never throw.

Covering test: `closes the socket that sent a malformed frame and keeps serving`. A viewer sends a
binary frame declaring a 65,535-byte header over an 11-byte body and is closed with 1008; the owner
sends `not json at all` and is closed with 1008; a fresh owner at generation 2 and a fresh viewer
then complete an RPC, so the gateway kept serving. Relay contract went 13 → 14 tests.

Maximum frame size decision recorded in the results doc: **4 MiB**, four times the 1 MiB terminal
burst the spec names, with the obligation that Task 31 set `maxPayload` to the same figure on the
relay and on `api/server.ts`.

### Important 3 — reconstruct() rewrote before it pruned

The spec has the importer prune unlisted registrations "before anything else touches the graph";
`reconstruct()` did rewrite → prune → repair. The two loops are swapped, so it is now prune →
rewrite → repair. The spec needed no change. The 7 tests in
`packages/archid/test/handover/worktree-portability.test.ts` are unchanged and still pass,
including `touches nothing on a still-reachable source when the registrations are pruned first`.

### Minors

- `build-companion.mjs` validates `--version` against `/^[A-Za-z0-9._+-]+$/` before the
  `fs.rmSync` that wipes the staging directory.
- `probe-claude-handover.mjs` now `lstat`s the transcript and throws
  `Refusing session symlink: <path>`, matching the Codex probe and what the Claude fixture README
  already claimed. Covered by a new test, `refuses a transcript that is a symlink`
  (claude-portability 3 → 4 tests).
- `reconstruct()` throws `Refusing to prune every registration: name the worktrees to keep` on an
  empty worktree list instead of silently deleting every registration.
- Results doc gained a Task 12 obligation: `walk()` treats a symlink as a file and hashes its
  target, so `node/bin/npm`, `node/bin/npx` and `node/bin/corepack` are listed with their targets'
  digests and no record that they are links; the installer also checks no mode and never notices a
  file the archive carries that the manifest omits. Verified by `ls -l` on the staged `node/bin`
  against the four `node/bin/` lines in `SHA256SUMS`.

### Verification

```console
$ pnpm vitest run --project archid test/gateway/relay-contract.test.ts \
    test/handover/worktree-portability.test.ts test/handover/claude-portability.test.ts
 Test Files  3 passed (3)        Tests  25 passed (25)
   relay-contract 14, claude-portability 4, worktree-portability 7

$ pnpm typecheck                 clean

$ pnpm vitest run --project archid
 Test Files  47 passed (47)      Tests  544 passed (544)
```

No remote work in this wave; `linus-vault` stays as the first pass's cleanup left it.
