# Task 4 — clean-container half of the packaging spike

Status: DONE_WITH_CONCERNS. Both architectures installed and ran in a fresh `ubuntu:24.04` with no
`node`, `pnpm` or `git` and no repository. Three new packaging defects fell out, all recorded, none
fixed here. No commits: `build-companion.mjs` already derives the architecture from the Node tarball
name, so no script needed an `--arch` option and the repository is untouched.

## What changed

- Repo: **nothing**. `git status --porcelain` in the worktree is empty; HEAD is still
  `bbcbe8e The handover probes prune before they rewrite and refuse a symlinked session`.
- Gitignored, main checkout: `docs/superpowers/plans/fleet-handover-spike-results.md` gained
  `### Clean-container run (Docker)` under Task 4 (with the "Not proven" paragraph the Task 4
  section previously lacked) and two bullets under Environment findings. 693 lines, was 585.
- Scratchpad only (`…/f03f771b-…/scratchpad`): `node-dist/node-v22.23.2-linux-arm64.tar.xz`,
  `docker/{arm64,x64}/` staging directories, `docker/run.sh`, `docker/run2.sh`, `docker/build-both.sh`
  and the two run logs. No secret is in any of them; the ephemeral `release-key` from the earlier
  pass was reused for signing and never left the scratchpad.

## Build

`scripts/spikes/build-companion.mjs` reads `node-(vX)-linux-(x64|arm64).tar.xz` and names the
tarball `…-linux-<arch>.tar.gz`, so the only thing per-architecture is `--out`:

```bash
node scripts/spikes/build-companion.mjs \
  --node-tarball <scratch>/node-dist/node-v22.23.2-linux-arm64.tar.xz \
  --node-shasums <scratch>/node-dist/SHASUMS256.txt \
  --out <scratch>/docker/arm64 --sign-key <scratch>/release-key
# same with -linux-x64.tar.xz into <scratch>/docker/x64
```

The arm64 Node tarball was downloaded fresh and its digest matched the `SHASUMS256.txt` already in
the scratchpad (`fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8`); the x64 tarball
was reused. Both builds: 4,846 files, esbuild bundles `archi` 590,030 B / `archid` 902,301 B /
`locate-probe` 298,135 B, 23 bundled licences, `SHA256SUMS.sig` written.

| Archive | Bytes | SHA-256 |
| --- | --- | --- |
| `…-linux-arm64.tar.gz` | 58,323,073 | `8035e0a772c2b633acbc726820cfd98a451705e058f978fcb4496ebc65464070` |
| `…-linux-x64.tar.gz` | 58,472,714 | `29bbba4e20ebc861092ce247bb3cdcb93a62aa6c89bf5fe5ac6a888b8f66f6b9` |

## Container runs

```bash
docker pull ubuntu:24.04
docker run --rm --platform linux/arm64 -v <scratch>/docker/arm64:/in:ro ubuntu:24.04 bash /in/run.sh
docker pull --platform linux/amd64 ubuntu:24.04
docker run --rm --platform linux/amd64 -v <scratch>/docker/x64:/in:ro   ubuntu:24.04 bash /in/run.sh
docker run --rm --platform linux/arm64 -v <scratch>/docker/arm64:/in:ro ubuntu:24.04 bash /in/run2.sh
```

`/in` also carries `install-release.mjs`, `linux-tmux.conf` (the config archid generated in the
host run) and `allowed_signers`, all read-only. `run.sh` takes no arguments and interpolates
nothing untrusted; the archive path comes from a glob and the version from `tar -tzf`.

Image `ubuntu:24.04`, index digest
`sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3`; per-platform manifests
`sha256:11dc1ccb427f0464a2369e645454c272bb0baece7357c892ba69d313b3a332cf` (arm64) and
`sha256:496754492fb28b4d3049432f2ca787449331e23fb14f0dd3fffea86bf5a93eb4` (amd64). Reported
`Ubuntu 24.04.5 LTS`. Docker Desktop 29.4.3 on Apple Silicon with
`UseVirtualizationFrameworkRosetta: true`, so amd64 ran under **Rosetta**, not QEMU.

### Absence, proven rather than avoided

```text
absent   node      absent   nodejs   absent   npm
absent   pnpm      absent   git      ssh-keygen: absent
tar:  /usr/bin/tar
```

No `PATH` restriction was used. The bundled runtime is bootstrapped out of the archive itself
(`tar -xzf <archive> -C /tmp/boot releases/<version>/node/bin/node`) and runs every later step. It
started with **no package installed** — the base image's `libstdc++6` and `libc` suffice.

### Results

| Step | linux/arm64 (native) | linux/amd64 (Rosetta) |
| --- | --- | --- |
| bundled `node -v` | `v22.23.2`, `linux arm64` | `v22.23.2`, `linux x64` |
| `install-release.mjs` into `$HOME/.local/share/archipelago` | `filesVerified: 4846`, `current` → `releases/0.0.0-spike+v22.23.2`, `rollbackTo: null` | identical |
| install wall-clock | 1 s | 3 s |
| second install of the same archive | `Error: /root/.local/share/archipelago/releases/0.0.0-spike+v22.23.2 is already installed` | identical |
| `bin/archi` / `bin/archid` modes after the tar round trip | `-rwxr-xr-x` | identical |
| `current/bin/archi --help` | full command list, exit 0 | identical |
| `current/bin/archid --help` | **no output, exit 1** | identical |
| `archi doctor --json` | `node v22.23.2` ok, `tmux` fail, `claude` fail, `archid` fail, `launchd` fail, exit 1 | identical |
| `lib/locate-probe.mjs` | hooks ok (3,198 B), home template ok, `MOBILE_DIST` missing, `REPO_ROOT` false positive | identical |
| `web-mobile/` in the release | present, `index.html` 771 B | identical |
| `apt-get update && apt-get install -y tmux` | 3 s, `tmux 3.4` | 5 s, `tmux 3.4` |
| config via `tmux -f … new-session -d` | exit 0, **stderr empty** | identical |
| options actually applied | `extended-keys on`, `escape-time 0`, `history-limit 20000`, `status off`, `mouse on`, `default-size 120x40`, `window-size latest`, `default-terminal xterm-256color` | identical |
| config via `source-file` | exit 1, **exactly one** error line: `/in/linux-tmux.conf:17: invalid option: extended-keys-format` | identical |
| session survives the bad line | `spike: 1 windows` | identical |
| `archi doctor` tmux check with tmux present | `warn: tmux 3.4: Shift+Enter needs tmux 3.5 or newer; brew upgrade tmux` | identical |
| **total wall-clock, `docker run` to exit** | **8 s** | **13 s** |

Emulation cost on this workload: ≈1.6×, with no behavioural difference anywhere.

### locate-probe, verbatim (arm64; the x64 output is identical)

```json
{
  "bundleUrl": "file:///root/.local/share/archipelago/releases/0.0.0-spike+v22.23.2/lib/locate-probe.mjs",
  "releaseRootEnv": "/root/.local/share/archipelago/current",
  "mobileDist": "/root/.local/share/apps/desktop/web/dist-mobile",
  "mobileDistExists": false,
  "repoRoot": "/root/.local/share/archipelago/",
  "repoRootExists": true,
  "hookScripts": { "ok": true, "hookScript": "/tmp/probe-home/hooks/agent-hook.mjs", "bytes": 3198 },
  "homeTemplate": { "ok": true, "done": [
    "home CLAUDE.md -> /tmp/probe-home/crew/CLAUDE.md",
    "home skills -> /tmp/probe-home/crew/.claude/skills",
    "home settings -> /tmp/probe-home/crew/.claude/settings.json" ] } }
```

Same as the host run, now against a real `~/.local/share` prefix rather than a `/tmp` stand-in:
the two `setup.ts` climbs still work by layout coincidence, `MOBILE_DIST` still breaks outright,
and `REPO_ROOT` still resolves to a directory that exists — the install prefix — so the
`pnpm --filter … build:mobile` false positive survives the real install path. The release's own
`web-mobile/` assets are present and correct; only the lookup is wrong.

## What broke — three findings the host run could not produce

1. **`archid --help` is not a flag; the daemon starts.** Without tmux it exits 1 having written
   nothing to stdout or stderr — the reason (`archid failed to start: Error: tmux not found on
   PATH: brew install tmux`) goes only to `~/.archipelago/archid.log`. A follow-up container with
   tmux installed ran `timeout 20 current/bin/archid --help` and got **exit 124**, a listening
   daemon on `127.0.0.1:47800`, and a populated `~/.archipelago` (`state.json`, `tmux.conf`,
   `tmux.sock`, and `token`, `mobile-key`, `vapid.json` at 0600). Task 12 owes `archid` a `--help`
   that prints and exits, next to the already-recorded missing `archi version`.

2. **`ssh-keygen` is not in a bare `ubuntu:24.04`**, so the release signature cannot be verified as
   designed. `install-release.mjs --allowed-signers /in/allowed_signers` fails closed and leaves
   the prefix empty (`find /tmp/signed -maxdepth 2` → the directory and nothing else), but the
   message misattributes the cause:

   ```text
   Error: /in/archipelago-companion-0.0.0-spike+v22.23.2-linux-arm64.tar.gz: SHA256SUMS is not
   signed by archipelago-release: spawnSync ssh-keygen ENOENT
   ```

   Task 13 must either require `openssh-client` in the Add Machine checks or verify the ed25519
   signature in Node, and must not report a missing verifier as a bad signature. The digest
   verification itself is unaffected: 4,846 files checked by the bundled runtime alone.

3. **`archi doctor`'s remedies are macOS-only.** On Linux it prints `brew install tmux`,
   `brew install gh`, `brew upgrade tmux`, and checks `launchd`/`com.archipelago.archid` rather
   than a systemd user unit. Task 12 needs platform-aware remedies.

Everything else matched the host run exactly, including the single `extended-keys-format` error and
tmux continuing past it.

## Differences from the real-host run

- Absence rather than avoidance: no system `node` existed, so nothing had to be shadowed.
- `ssh-keygen -Y verify` could not run at all (above); on `linus-vault` it passed.
- The prefix is a real `$HOME/.local/share/archipelago` with an atomic `current` swap performed by
  `install-release.mjs`, not a hand-made symlink in `/tmp`.
- arm64 is now covered; it behaved identically to x64 in every step.
- Timings are seconds rather than the host run's upload-dominated minutes, because nothing crosses
  a network except `apt`.

## Cleanup

All three `docker run` invocations used `--rm`; `docker ps -a --filter ancestor=ubuntu:24.04` is
empty. The amd64 pull untagged the arm64 image and vice versa, leaving one untagged `ubuntu:24.04`
layer set behind, which was removed (`docker image rm 6232b3879100`). **Left in place:**
`ubuntu:24.04` (arm64, `sha256:8494c74c…`), as the brief allows. The two other `<none>` images on
this machine (`postgis/postgis`, `redis`) are pre-existing and were not touched. No container was
started outside Docker's own storage, and nothing was written outside the scratchpad, the
gitignored results doc and this report.

**The remote server was not touched at all.** No `ssh`, no `tailscale`, nothing on `linus-vault`.

## Verification

No repository file changed, so `pnpm vitest run --project archid test/gateway/relay-contract.test.ts`
and `pnpm typecheck` were not re-run — they were the gate on a script change, and there was none.
`git status --porcelain` in the worktree is empty.
