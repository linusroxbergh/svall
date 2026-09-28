# Task 38a report: security, destructive operations, licences and permissions

Status: **DONE_WITH_CONCERNS**

- **m6, the must-fix.** `host upgrade` checks the staged release on the far machine before anything in it runs:
  `ssh-keygen -Y verify` against the installed release's `current/release/allowed_signers`, then
  `sha256sum -c --strict`.
  - `--allow-unsigned` stays explicit: it checks the digests alone and says so in the `install` step.
  - An installed release that pins no key falls back to the controller's check and says so. Every release before the
    first signing key is one.
  - The signed path is tested with throwaway keys, and so is a refusal of a key the installed release does not pin,
    before any staged file runs.
- **37b's install items.**
  - On a Mac, `setup --rollback` kickstarts every fleet's launchd agent.
  - `host add` stops at a Linux home too long for the gateway's socket, and `doctor` names the `listen EINVAL`.
  - An upgrade probes every fleet daemon it restarted, not only the private one.
- **Findings fixed beyond the carried ones:**
  - a root could carry an agent login or `~/.ssh`;
  - host commands trusted whatever machine an alias reaches;
  - the bundles searched folders above the release for optional modules;
  - the units' logs were world-readable;
  - licences: no NOTICE, a bundled package's licence silently dropped, the phone page's packages unlicensed, rsync
    shipped without its source, Ghostty's licence not in the app.
- **The doc.** `docs/security/fleet-handover.md` has the threat model, the secrets channels, the destructive-site
  table, the licences, the permissions, what uninstall keeps and the agent-version process. 38b adds its performance
  section beside these.
- **Concerns.** Three licence items only the owner can settle: GhosttyKit's dependency texts, a statically linked
  LGPL libintl, and Flaticon art in a published archive. Details below.

Commits, BASE `e4379790`. The range also holds the orchestrator's ledger commits (`f648ba3d`, `1a271c5d`,
`a2da2e3f`) and Task 39a's, made in the same worktree meanwhile (`469e5321`, `5135a8ab`, `8a60fdcb`, `1edc82ab`,
`0d07da9e`, `dee440ba`, `49d1d213`, `7a83d84e`); those are not 38a's.

| Commit | Subject |
| --- | --- |
| `53051df9` | An upgrade checks the new release on the far machine with ssh-keygen and sha256sum against the signers the installed release pins, before anything the upload carries runs |
| `c9387b13` | The release bundles resolve the modules their dependencies only try for to nothing, so Node never looks for them in a folder above the release, and the scan refuses any it would |
| `b5c162af` | On a Mac, setup --rollback starts every fleet's launchd agent again so none keeps running the release it went back from, and --no-launchctl says the daemons change release at their next start |
| `730a1c4f` | Host add stops at a home too long for the gateway's socket on Linux, and the doctor names the listen EINVAL of a gateway that keeps restarting for it |
| `e3e67b2e` | After an upgrade the companion asks every fleet whose daemon it restarted, not only the private one, and goes back when any does not answer, naming it |
| `89a8ec19` | Preflight blocks a root that holds an agent's login or config, or holds or lies in the ssh folder, on either machine, so a handover never carries one or lands on one |
| `562b562b` | Linux setup keeps the units' logs in a folder only the account opens, closing one an earlier setup left open |
| `3bf64226` | Every release archive carries a NOTICE naming each component with its licence text, the phone page's packages included, the build stops at a bundled package with no licence, and the controller ships rsync's source beside it |
| `264d3c99` | The app carries Ghostty's licence and a NOTICE naming every component GhosttyKit links, and a test fails on any object file in the kit no named component accounts for |
| `69c0c268` | Host remove, upgrade and enable first check that the machine the ssh destination reaches is the one the registry names, so an alias that now leads elsewhere is never uninstalled, upgraded or given an ownership record |
| `cae6fb82` | Tests show that no daemon token reaches the daemon's log or host upgrade's events, no fleet key or .env secret reaches a transfer manifest, and no ssh destination can carry a name a ProxyCommand would expand |
| `3e920585` | A test shows a daemon start keeps its fleet home at 0700 and its token, phone key, push keys and hook socket at 0600 |
| `4c671f4d` | The fleet handover security doc says what a handover trusts and refuses, what it deletes on whose authority, what a release carries under which licences, what uninstall keeps, and which risks are accepted |

## Findings fixed, ranked

Each fix went test first. RED is the new test failing on the code before the fix; GREEN is the file or group after it.

| Rank | Finding | Fix | Test (RED → GREEN) |
| --- | --- | --- | --- |
| Important | **m6.** The far machine ran the uploaded archive's own `archi`, which checked the archive against signers inside that same archive. | `verifyStaged` runs `ssh-keygen -Y verify` and `sha256sum -c --strict` on the far machine, against `current/release/allowed_signers`, before the staged `archi` runs (`53051df9`). | `cli/test/host.test.ts` host upgrade, exec-mode far machine: 4 new cases, 4 failed → 9/9 in the group; `install.test.ts` 20/20. The fresh-install run shows "unsigned, checked by its digests alone" on the real upgrade. |
| Important | A character standing in `~/.claude`, `~/.codex`, `~/.ssh`, or a context ref to a key or `.claude.json`, made a root. It carried Claude's `.credentials.json`, Codex's `auth.json`, `.claude.json` (MCP keys) or ssh keys, and after an archive it landed on the destination's. The brief's secrets rule says these never enter a root. | Preflight blocks a root that holds or is one of those files, or holds or lies in `~/.ssh`, on either machine. It uses the source daemon's real `CLAUDE_CONFIG_DIR` and `CODEX_HOME` and the destination's reported agent homes (`89a8ec19`). | `inventory.test.ts` 1 failed → 33/33; `source.test.ts` (CLAUDE_CONFIG_DIR) 1 failed → passes; the fleet-home guard learns the account-home names (5/5). |
| Important | Licences. There was no NOTICE. `http_ece` (in archid, via web-push) ships no licence file and was silently left out. The phone page's bundled packages had no licences in the archive. rsync (GPL-3.0) shipped without source or offer. The app carried no Ghostty licence. | `licenses/NOTICE` lists every component with version, licence and file. The build stops at a bundled package without a licence unless `scripts/release/licenses/<name>-LICENSE` holds its upstream text (http_ece's, fetched from its repository). The controller ships the pinned rsync source tarball and names its configure flags (`3bf64226`). The app gets `LICENSE.ghostty` and a GhosttyKit NOTICE (`264d3c99`). | `archid/test/release.test.ts`: 4 failed → 32/32; then the real build hit `http_ece` → 33/33 with the controller build test (1 failed → pass). `test/app-notice.test.ts`: 1 failed → 2/2. |
| Medium | `host remove`, `host upgrade` and `host enable` ran on whatever machine the ssh destination reaches. A repointed alias would get `archi uninstall` (units removed, every fleet's tmux killed), an upgrade, or a new ownership record. | Each first asks `archi version --json`, stops on another machine id, and names `--forget`. An `archi` that gives no answer is left to the step, so a broken install can still be upgraded (`69c0c268`). | `host.test.ts`: 3 new cases plus the updated remove argv, 4 failed → 66/66 (1 skipped). |
| Medium | The bundles left `bufferutil`, `utf-8-validate` and `supports-color` to Node's resolution. Node searched every folder above `lib/`: the staging folder on an upgrade (a member outside `releases/<v>` ran; reproduced), `~/node_modules`, and `/Applications/node_modules`, which admin accounts can write without sudo. | An esbuild plugin resolves them to a module that throws, so the dependencies take their pure-JS path. The scan drops its allowance for them (`c9387b13`). | Real build: planted modules loaded and bare requires present, 1 failed → 29/29. `release-scan.test.ts` 1 failed → 16/16. A real companion build scans clean (114 files). |
| Minor (37b M3) | On a Mac, `setup --rollback` moved `current` and restarted nothing. | It kickstarts every Archipelago agent through an injectable `launchctl` runner. `--no-launchctl` restarts nothing and says the daemons change release at their next start (`b5c162af`). | `cli/test/setup.test.ts` 2 failed → 6/6. |
| Minor (37b concern 1) | A Linux home over 59 bytes made the gateway crash-loop with an unnamed `listen EINVAL`. | `host add`'s home step stops, naming the socket, its length and the 59-byte limit. `doctor`'s gateway check names it when the unit is not active, and the service step shows that detail (`730a1c4f`). | `host.test.ts` (60 bytes refused, 59 taken) and `doctor.test.ts`: 2 failed → 102/102. |
| Minor (37b re-review) | After an upgrade only the private fleet's daemon was probed. | `probeOrRollback` asks every `archipelago-archid@<fleet>` it restarted, and rolls back naming the fleet that did not answer (`e3e67b2e`). | `linux-setup.test.ts` 1 failed → 33/33 with `cli/test/setup.test.ts`. |
| Minor | The units' log folder was 0755, with logs 0644, on homes that are not 0750. | `writeUnits` makes `log/` 0700 and closes one left open (`562b562b`). | `linux-setup.test.ts` 1 failed (mode 0755) → 28/28. |

Coverage tests added for untested channels and modes (`cae6fb82`, `3e920585`). Each passed on first run, as the code
already held:

- the daemon API's log never holds its token or one offered;
- host upgrade's events hold no token;
- a manifest holds no fleet key or `.env` value, even with the fleet `.env` carried;
- no ssh destination can carry a `%r`/`%h` shell expansion;
- a daemon start leaves the home at 0700, and its keys and hook socket at 0600.

## Accepted, with reasons

Each is also in the doc's "Accepted risks".

- **Gateway ownership calls do not check the gateway's machine id.** The daemons at either end are always identified.
  Begin needs the gateway's record to name the source at the generation the source's daemon holds. A gateway reached
  by mistake has no such record unless it holds a copy of the real one.
  - To close it: an `archi version --json` check once per master in `Masters.for` or `authorityOp`. That costs an ssh
    round trip per handover and touches every controller test that fakes ssh.
- **A root swapped for a symlink between claim and rsync**, on either side, is followed. Verification catches the
  source side, but the copy has landed. Both need a process running as the user, which can already read or delete
  the files.
- **Another account can squat the Linux daemon's abstract lock name** (Task 42 m2). A 0600 key mixed into the name
  would stop it. But during an upgrade, a daemon of the earlier release, still under the old name, would then not
  exclude a new one. On a machine that is usually single-user, a local denial of service does not justify that risk.
- **An archive member outside `releases/<v>`** is still unpacked into staging. Nothing runs from staging but the
  checked release, the bundles no longer search above it, `install-release` moves only `releases/<v>` into place, and
  staging is removed.
- **A version name from the archive**, such as `..`, reaches the remote staging and archive names. Each path is one
  quoted word under `~/.cache/archipelago`, and `install-release` refuses a version that leaves `releases/`.
- **`setup` replaces `~/.local/bin/archi` and `archipelago`**, which are its own names.
- **An upgrade restarts a unit the user disabled** (37b re-review m1). A rollback must not leave a failed daemon down.
- **The phone page's package list is the web app's whole production closure** (161 packages), not only what Vite
  inlined. Listing more than was bundled is harmless in a NOTICE. A module list from the Vite build would need
  `dist-mobile` rebuilt before every release build.

## Destructive-site table

The full table, with each test's name, is in `docs/security/fleet-handover.md` under "Destructive operations".

| Site | Authorised by | Refusal tested in |
| --- | --- | --- |
| `rsync --delete` | an ok replica claim: reserved, own partial copy, or proven replica; kept folders and excludes spared | `transfer.test.ts`, `replicas.test.ts` |
| Archive rename | a choice naming the root; not holding the fleet home; exclusive sibling | `replicas.test.ts`, `destination.test.ts` |
| Worktree registrations | the manifest's graph in a claimed root; a real folder; no git refusal | `git-import.test.ts` |
| Destination stages, prepared state, seals | the journal's transaction id, one encoded segment, after the gateway let go or completion | `destination.test.ts` |
| Source's kept manifest | the source journal's transaction | `source.test.ts` |
| Controller journal and transaction folder | the journal's id, `.` and `..` encoded | `recovery.test.ts` |
| Unreadable records renamed `*.broken-*` | a failed parse; nothing deleted | `journal.test.ts`, `gateway/authority.test.ts`, `ownership.test.ts` |
| Far copy's `owner.json` on rekey | a home only `host add` made, never used | `linux-provision.test.ts` |
| Remote staging and upload | registry home and the archive's one release name, quoted | `host.test.ts` |
| Release install and rollback | a version that stays under `releases/`; atomic `current` | `release.test.ts` |
| `host remove` → remote uninstall | the registry record, a far machine answering with its id, no open or away fleet; never `--purge` | `host.test.ts` (new identity case) |
| `archi uninstall` | each unit, plist, shim and hook recognised as Archipelago's | `uninstall.test.ts` |
| `archi uninstall --purge` | a fleet home must hold `fleet.json` or `config.json`; asked or `--purge` | `uninstall.test.ts` |

No site reached a path without such a record, except the three host commands, now checked (`69c0c268`).

## Licence inventory

**Companion archive** (`linux-*`), in `licenses/`, indexed by `licenses/NOTICE`:

- Archipelago (MIT);
- Node v24.21.0 (`node-LICENSE`, which covers what Node bundles);
- the 24 npm packages esbuild bundles into `lib/`, `http_ece` included;
- the phone page's packages: 161 in the closure, 4 of them, `zod` among them, also in `lib/`;
- the phone page's fonts: JetBrains Mono and Outfit, OFL 1.1, in `web-mobile/fonts/OFL.txt`;
- the Flaticon art notes: `web-mobile/animals/LICENSE`, `web-mobile/resources/LICENSE`.

That is 188 files, 968 KiB unpacked. The archive went from 114 to 277 files.

**Controller archive** (`darwin-arm64`): the same, plus rsync 3.4.4:

- its licence (GPL-3.0-or-later, `rsync-LICENSE`);
- its pinned source tarball (`rsync-3.4.4.tar.gz`, sha256 `bd88cf82…`);
- a NOTICE line naming `./configure --disable-xxhash --disable-zstd --disable-lz4 --disable-openssl --disable-md2man`,
  `make` and `strip -S`.

It scans clean (281 files).

**App** (`Contents/Resources/licenses/`):

- `LICENSE.ghostty` (MIT);
- `NOTICE`, naming each component GhosttyKit links, by object file:
  - Ghostty and Zig compiler-rt (MIT);
  - FreeType (FTL OR GPL-2.0+);
  - libpng; zlib;
  - Oniguruma (BSD-2);
  - glslang (BSD-3/BSD-2/MIT/Apache-2.0/GPL-3.0 with Bison exception);
  - SPIRV-Cross (Apache-2.0);
  - simdutf; Highway;
  - utfcpp (BSL-1.0);
  - GNU gettext libintl (LGPL-2.1+);
  - Dear ImGui (MIT); stb; Wuffs;
  - and the iTerm2 Color Schemes themes (MIT).

  The object check maps all 230 objects in `libghostty-fat.a` to these.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm vitest run --project protocol --project archid --project cli --project @archipelago/desktop-web --project scripts` | 196 files passed, 1 failed, 1 skipped; 4372 passed, 1 failed, 5 skipped |
| Fresh install, arm64 (colima), releases built from HEAD `7a83d84e` | ALL PASS in 20.6 s: add by download, second fleet, restart with no login, upgrade by download (the far check said "unsigned, checked by its digests alone"), rollback |
| Handover, arm64, `--scenarios none` | ALL PASS in 28 s: local → remote → local with a turn on each |
| Companion and controller builds from the tree, scanned | ok (277 and 281 files) |

The one failure is `cli/test/controller/connect.test.ts` "catches a stale cached route on the tick once the gateway
has refused its key": under the full run's load its error came back `other`, not `auth`. The file passes 21/21 alone,
three runs of three. Neither it nor `controller/connect.ts` is touched by this task.

colima's default profile was stopped. I started it for these runs, stopped it after, and set the docker context back
to `desktop-linux`. No containers are left. The images `archi-it:latest`, `archi-it:machine`, `archi-tmux34` and
`ubuntu:24.04` stay in the profile as a cache.

## Concerns

1. **Licence items only the owner can settle.**
   - GhosttyKit's dependencies ship as names and licence ids only. FreeType's FTL wants its credit in the
     documentation, and MIT, BSD, zlib, libpng and Apache-2.0 want their texts. `ghostty-build.sh` could copy them
     from zig's package cache into the kit at the next kit build, which needs the Metal toolchain.
   - libintl (LGPL-2.1+) is linked statically. Relinking is possible only once the source is public.
   - The Flaticon art ships as files in the published companion archive and in the app, though its licence note
     forbids redistributing the files. It needs replacing, or the owner's reading of the licence.
2. **The app's `build.sh` change is not built.** The test checks the `cp` line and the NOTICE; no app build ran.
3. **Full fault scenarios and x86-64 were not rerun.** The fixes do not touch the fault paths. The clean round trip
   and the fresh install cover the changed install, bundle and preflight code on arm64.
4. **The first signed release.** An install from any release before it pins no key, so upgrading to the first signed
   release rests on the controller's check alone, and says so. From the next signed release on, the far check applies.
5. **Task 39a in the same worktree.** Its error catalogue test reads codes from the code. 39a covered the messages
   this task added (`7a83d84e`). Any later message needs the same catch-up.
