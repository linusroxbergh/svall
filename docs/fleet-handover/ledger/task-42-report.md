# Task 42: main's newer fleet data travels, and one daemon holds a fleet home on Linux

Branch `experimental-remote-sessions`, base dff49798. Four commits, 632b71cd..8db67a32; not pushed. Uncommitted: this
report. `$S` is the session scratchpad
`/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/3739c9b8-51d0-4aa6-ac32-19bc0b56eee0/scratchpad/t42`,
where every red and green log named here is kept.

| Step | Commit | Subject |
| --- | --- | --- |
| 3, 4a | 632b71cd | The state leaves its machine without a pid, a tmux id, the codex-silent hint or the agents that machine found, and a value nobody classified fails the tests |
| 1, 2 | 4cbce3c7 | A moved fleet brings its entity docs and agent profiles, found on the destination by the same keys and names |
| 4b | 738711fd | Every entry a fleet home can hold is classified as travelling or machine-local, and one the code names that the list does not fails the tests |
| 5 | 8db67a32 | One archid holds a fleet home on Linux too, through an abstract socket the kernel lets go however the daemon dies |

## What changed

**1, 2. Docs and agent profiles** (`inventory.ts`, `replicas.ts`, protocol `TransferRoot.kind`, spec "Transfer inventory")
- Two new root kinds, `docs` and `profiles`. The inventory offers `<fleetHome>/docs` and `<fleetHome>/agent-profiles`
  when the source has them, as roots at the same path in the destination's fleet home. A destination whose fleet home
  differs blocks with `path_unsupported`, as the `.env` already did.
- The whole `agent-profiles` folder travels: the spec's replica rules then need nothing new. A profile is found by name,
  so a moved character keeps its role. The destination seeds the bundled profiles only when the folder is absent, and
  at activation it is already there.
- The inventory's fleet-home check exempts what travels: mission control's folder, the docs and the profiles. A context
  ref inside the docs folds into the docs root instead of blocking.
- `ReplicaStore.clash` accepts a `docs` or `profiles` root only at `paths.docs` or `paths.agentProfiles`, reached
  through no link. Replica records, divergence, `--delete` and archive then work as for any other root.
- Repo-doc keys hash the repository's absolute path, and paths no longer change, so every key still resolves.
- Spec amended in one bullet: the inventory's entity docs line now names the `agent-profiles` folder.

**3. Other process-bound fields.** Walked every value of `FleetState` and `FleetConfig`:
- `agent.pid` and `second.agent.pid` are stripped (F2); they are now classified entries, not a special case.
- `characters.*.hint` (`codex-silent`) is new from main and bound to a live window. It is now stripped at export.
  `markDormant` already dropped it at import.
- `agentsFound` lists the CLIs this machine's archid finds. It is now machine-local and stripped. The destination's
  `syncAgents` sets its own at activation.
- `shell.lastOutputAt`, `agent.status`, `agent.background` and `agent.promptId` travel.
  - The first is a time.
  - The rest describe a turn: the rest settles it and `markSlotDormant` resets it at import.
- `panePath` and the tmux ids were already forbidden. Nothing else of main's is bound to a machine or process.

**4a. Classification test for process-bound fields** (`portable-path.ts`, `inventory.test.ts`)
- The test walks every number, flag and enum of the state and fleet.json, not only strings.
- Each must be in `PATH_FIELDS` or in the new `NOT_BOUND` list. `PATH_FIELDS` classes a pid or the hint as
  `forbidden` and `agentsFound` as `machine-local`.
- `exportSnapshot` strips every non-portable `FleetState` entry through one loop.
- The stale-name check now covers every kind of field. A name ending `[]` lies under the name without it.

**4b. Fleet-home entries** (`test/handover/fleet-home.test.ts`)
- `ENTRIES` lists every top-level entry and what a handover does with it. `BESIDE` lists what a write, repair,
  migration or archive leaves next to an entry.
- The code's entries are found three ways:
  - every path `resolvePaths` and `installedScripts` return;
  - a source scan:
    - a literal joined onto `home`, `fleetHome` or `….home` in `packages/*/src` and the hook scripts;
    - `ArchiHome.path + "/…"` in Swift;
    - `path`/`home + "/…"` and `read("…")` in `ArchiHome.swift`;
    - `$home/…` in `scripts/*.sh`;
    - `~/.archipelago/…` literals.
  - A daemon is started and stopped in a temp home, and every entry it leaves must be classified (needs tmux).
- `ELSEWHERE` lists the four files where a scanned `home` is a user's home or CODEX_HOME.
- A linking test builds a fleet home holding one of each entry, with a character's context naming every entry that
  does not travel as a root. The inventory must:
  - carry exactly the `root` entries;
  - refuse every other entry as an overlap of the fleet home.

**5. Linux lock** (`main.ts`)
- On Linux, `lockHome` binds an abstract unix socket named
  `\0archipelago-archid-<sha256 of the fleet home's real path>`. `EADDRINUSE` means `archid is already running for <home>`.
- macOS keeps `O_EXLOCK` on `daemon.lock`. `startDaemon` awaits the lock before anything in the home is read or written,
  as before.
- Why an abstract socket rather than an `flock` held by a child:
  - The kernel drops the name when the last descriptor closes, however the process dies. No helper process has to
    notice its parent's death, and there is no window where one outlives it.
  - It needs nothing beyond node: no util-linux `flock`.
  - libuv opens sockets close-on-exec, so the tmux server the daemon starts cannot inherit the name. That server
    outlives the daemon under `KillMode=process`. The SIGKILL test proves it with that server still up.
  - Abstract names ignore file permissions and live per network namespace; see Concerns.

## Fleet-home classification

| Entry | Written by | Handover |
| --- | --- | --- |
| `state.json` | archid store | travels, as the manifest's snapshot (stripped of bound fields) |
| `fleet.json` | setup, provision, `archi agent`, destination activation | travels, as the manifest's fleet |
| `docs/` | docs RPCs, workspace | travels as root `docs` |
| `agent-profiles/` | archid seed, docs RPCs | travels as root `profiles` |
| `home/` | archid `ensureHome` (mission control's default cwd) | travels as root `home` while fleet.json's `home.cwd` names it |
| `.env` | the user | travels as root `env` only with `handover.transferFleetEnv` |
| `node.json`, `config.json` | setup, config migration | machine-local |
| `owner.json`, `handover/`, `replicas/`, `relay-secret` | ownership, handover | machine-local |
| `token`, `port`, `archid.log`, `daemon.lock` (macOS) | archid | machine-local |
| `hooks/`, `hooks.sock`, `hooks.down` | setup, hook receiver, hook scripts | machine-local |
| `tmux.sock`, `tmux.conf`, `tmux-binary` | archid, tmux | machine-local |
| `mobile-key`, `push.json`, `vapid.json` | mobile, push | machine-local |
| `usage/`, `scribe/`, `*.prompt` | usage fetcher, scribe, `char.run` prompt files | machine-local |
| `controller/` | cli controller (route, journal, lock, events, log, socket, recoveries) | machine-local |
| `app.pid`, `browser-store` | Mac app (browser store id) | machine-local |
| `*.tmp`, `*.tmp-*`, `*.broken-*`, `*.archived-*`, `state.json.v*`, `config.json.bak`, `archid.log.1` | atomic and durable writes, repairs, migrations, archive | machine-local |

A daemon started and stopped in a fresh home left `agent-profiles config.json.bak daemon.lock fleet.json hooks
mobile-key node.json owner.json state.json tmux-binary tmux.conf tmux.sock token vapid.json`, all classified
(`$S/daemon-entries.json`).

## Tests added, failing first

- **632b71cd** (`$S/A-red.log`, with an empty `NOT_BOUND`): 3 failed.
  - 54 unclassified values, `agent.pid`, `hint` and `agentsFound[]` among them.
  - The pid test named its `shellPid` among them.
  - The strip test still saw `hint` and `agentsFound`.
- **Stale pid** (`sessions.test`): the source's pids are the test process's own, so they are live here. The pipeline
  runs `buildInventory`, `buildManifest`, `importState`, then `applyHook(SessionStart)` for a new session from another
  pid, in both terminals.
  - It passes with F2's strip.
  - With the two pid entries removed from `PATH_FIELDS` (`$S/A-pid-red.log`), it fails:
    `expected sessionId 9a8b…, pid 999999; received 3f2b…, pid 62765`. The reducer kept the old session because 62765
    was alive.
- **4cbce3c7** (`$S/B-red.log`): 3 failed.
  - inventory: the doc context ref `…/.archipelago/docs/fleet/conventions.md overlaps the fleet home`.
  - replicas: the `docs` claim was refused.
  - destination: after prepare, activate and complete, `readAgentProfile(…, 'reviewer')` gave `{ error: 'is missing' }`.
    That is the smoke's D5.
  - The destination test is a fake-dependency handover: the real `buildInventory` and `buildManifest`, a claim and copy
    per root, the real `DestinationHandover`. It then finds all four doc tiers by `fleetDir`/`repoSlug`/`docsDir`, the
    profile by name, and sealed replicas of both roots for the way back.
- **738711fd**:
  - Dropping `browser-store` from the list fails the first test, naming `ShellRouter.swift` (`$S/C-red-unlisted.log`).
  - The linking test against 632b71cd's `inventory.ts` fails: docs and agent-profiles are not carried
    (`$S/C-red-linking.log`).
  - The "fails on an entry nobody classified" test feeds the scan a TS join, a template and a Swift append.
- **8db67a32**:
  - The holder in `home-lock.test` is now a real archid, run as one node process. It is killed with SIGKILL while the
    tmux server it started stays up, and the next start must succeed.
  - It passes on macOS before and after. On Linux it failed before the change (below).

## Linux lock run

Colima was stopped. I started it, which switched the docker context to `colima`; at the end I stopped it and set the
context back to `desktop-linux`. Image `archi-tmux34`: Ubuntu 24.04.5, node v24.21.0, tmux 3.4, aarch64, left from
Task 40.

```sh
git archive HEAD | tar -x -C $S/linux-red     # HEAD 738711fd: the old lockHome
cp packages/archid/test/home-lock.test.ts $S/linux-red/packages/archid/test/
docker run -d --name t42 archi-tmux34 sleep infinity
docker cp -q $S/linux-red/. t42:/work
# pnpm 12.6.0's tarball fetched from registry.npmjs.org inside the container; its sha512 matched dist.integrity
docker exec t42 bash -c 'cd /work && CI=1 pnpm install --frozen-lockfile'     # 314 packages
docker exec t42 bash -c 'cd /work && pnpm test packages/archid/test/home-lock.test.ts'
docker cp -q packages/archid/src/main.ts t42:/work/packages/archid/src/main.ts # 8db67a32's
docker exec t42 bash -c 'cd /work && pnpm test packages/archid/test/home-lock.test.ts packages/archid/test/handover/fleet-home.test.ts'
```

Before (`$S/linux-red.log`): 3 failed, 2 passed.

```
× refuses a second daemon before it touches the state, the hooks, tmux.conf or the tmux server
    expected … /archid is already running for/ but got 'hook receiver already running at /tmp/archi-t-4c38e7/hooks.sock'
× refuses a start while another archid runs for the home, and starts once that one is killed, its tmux server still up
    (same: the second start got as far as the hook socket)
× leaves the running daemon's log unrotated when archid is started again for its home
    expected true to be false   (archid.log.1 exists: the second start rotated the running daemon's log)
```

After (`$S/linux-green.log`, `$S/linux-green-verbose.log`): 10 passed; all five home-lock tests by name, and fleet-home's five.

By hand in the same container (`$S/probe.sh`, `$S/linux-probe.log`):

```
first archid pid 751, port 34953
abstract name held: 1                       # @archipelago-archid-<hash> in /proc/net/unix
second archid exit 1                        # log: archid failed to start: Error: archid is already running for /tmp/fh
first killed with SIGKILL
tmux server still up: fleet
abstract name held: 0
third archid started: 2 starts logged in all; name held: 1
```

Container `t42` removed afterwards; the image stays.

## Verification (8db67a32)

| Command | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm vitest run --project protocol --project archid --project cli` | 126 files passed, 1 skipped; 2239 passed, 5 skipped |
| Linux lock test (above) | home-lock 5/5 and fleet-home 5/5 on Ubuntu 24.04 |

The baseline at dff49798 with the same command was 125 files passed, 1 skipped; 2227 passed, 5 skipped. The run added
12 tests: 3 in step 3/4a, 4 in steps 1 and 2, 5 in step 4b. No known flake fired.

## Concerns

1. **Destinations that ran the fleet before this build.**
   - Such a machine, m3b among them, holds a seeded `agent-profiles/`, and maybe `docs/`, with no replica record.
   - The first handover to it blocks `destination_occupied` on that root, unless the folder happens to be identical.
   - `--archive <root>` clears it, leaving `agent-profiles.archived-<stamp>` in its fleet home.
   - A fresh gateway never activated the fleet, so the root is absent there. The M3b gate should expect this once on m3b.
2. **Absent folders are not carried.**
   - A source without `docs/` or `agent-profiles/` carries nothing for it, and the destination keeps what it had.
   - A source without `agent-profiles/` therefore gets the bundled profiles seeded on the destination at activation,
     and they travel back.
   - The app never removes either folder itself.
3. **Excludes.**
   - Docs and profile roots take the fleet's excludes like every root. The defaults cannot match a doc or profile name.
   - A user exclude such as `*.md` would drop docs.
4. **The entry scan is a tripwire, not a proof.**
   - A writer that names an entry through a variable not called `home`/`fleetHome`, or through `path.resolve`,
     escapes the scan.
   - The resolvePaths walk and the started-daemon listing cover what goes through `resolvePaths` or a daemon start.
5. **The abstract socket has no permissions.**
   - Another local user who binds the same name first keeps the fleet's daemon from starting. That is a denial of
     service, with no access to the fleet.
   - It holds within one network namespace. Our units set no `PrivateNetwork=`.
   - Linux no longer writes `daemon.lock`.
6. **No protocol or transfer-schema bump.** `TransferRoot.kind` gained `docs` and `profiles`, and a handover already
   requires an exact release match.
7. **What the destination re-derives.**
   - `agentsFound` now leaves the snapshot. `mainAgent` and `scribeAgent` travel as the source resolved them.
   - The destination sets all three at activation (`syncAgents`), so its state differs from the source's there, as
     intended.

Status: DONE_WITH_CONCERNS — 632b71cd..8db67a32; typecheck clean; vitest protocol+archid+cli 126 files / 2239 passed,
5 skipped (baseline 2227); Linux container home-lock 5/5 + fleet-home 5/5 (3 of 5 failed before the fix); a first
handover to a machine that ran the fleet before this build (m3b) blocks once on `agent-profiles`, cleared with `--archive`.
