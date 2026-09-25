# Task 13 — Linux systemd installation and daemon setup

Commit: `e3502a5 The companion installs as persistent Linux user services`

## What was implemented

**Unit templates** — `packages/archid/systemd/archipelago-archid@.service.in` and
`archipelago-gateway.service.in`, `@NAME@` placeholders, rendered at setup time. Both carry
absolute paths through `current`, `Type=simple`, `Restart=always`, `RestartSec=2`,
`Environment=HOME/PATH/LANG=C.UTF-8` (plus `ARCHI_HOME` for a fleet),
`StandardOutput=append:<prefix>/log/<unit>.log` and the same for stderr, and
`[Install] WantedBy=default.target`. `PATH` is resolved at render time as
`<current>/node/bin:<home>/.local/bin:/usr/local/bin:/usr/bin:/bin` (a development checkout uses
the directory of the node running setup). The daemon unit is written per fleet as a concrete
`archipelago-archid@<fleet>.service`, so `ARCHI_HOME` can be explicit; systemd prefers a literal
instance file over the template. The templates ship in a release: `release-stage.mjs` stages
`systemd/` beside `hooks/` and `home/`, and `release.ts` gained `systemdDir()`.

**`packages/archid/src/linux/service.ts`** — argv-only wrappers over
`systemctl --user daemon-reload | enable --now | disable --now | restart | show` and
`loginctl show-user <user> --property=Linger`. Failures become a `SystemdError`
(`{ code: 'no_systemd' | 'unit_failed', message, stderr }`): a missing binary or a session with no
user bus is `no_systemd`, anything else is `unit_failed`. `lingerState` returns
`{ user, linger, action: 'loginctl enable-linger <user>' }` and never runs the action. The process
runner is injected (`Run`), with `realRun` the only place that spawns.

**`packages/archid/src/linux/setup.ts`** — `archidUnit`/`gatewayUnit` render the units;
`writeUnits` writes them atomically into `~/.config/systemd/user/` only when the text differs;
`setupLinux` reads the Claude and Codex settings first, installs the fleet home
(`setupFleetHome`, extracted from `setupHome` so no launchd file is written), the per-user half
(`setupUser`: hooks, statusline, Codex hooks, shims, mission-control template), then the units, and
— when `--launchctl` is on — daemon-reloads, enables the fleet's unit and appends the linger action.
A machine without systemd keeps every file that was written and says why the unit did not start.
`probeOrRollback` puts `current` back and restarts the unit when the daemon does not answer.

**Rollback** — `rollbackRelease(prefix, to?)` in `scripts/install-release.mjs` renames a staged
symlink over `current`, exactly as the install does; without `to` it takes the newest release that
is not the current one, and throws when there is none. Declared in `install-release.d.mts`.

**tmux config** — `tmuxConfText(config, { platform, tmuxVersion })`. `copy-command "pbcopy"` is
emitted only on darwin; `extended-keys-format csi-u` is left out when the tmux version is older
than 3.5. Every other line is identical. `main.ts` now reads the tmux version before writing the
conf, and `archi setup` on Linux passes the version it reads from `tmux -V`.

**Platform switches** — `archi setup` calls `setupLinux` on linux and `runSetup` on darwin;
`--release` installs through `installRelease` on both, and on linux a release that had a previous
one is probed and rolled back. `archi doctor` on linux replaces the launchd check with a `systemd`
unit check and a `linger` check, and names `sudo apt install tmux` / "Ubuntu 24.04 ships 3.4"
instead of the brew remedies. `archi uninstall` on linux stops and removes only Archipelago units,
the shims and `<prefix>/{releases,current,log}`; fleet homes stay unless `--purge`.

No sudo anywhere; a missing package is reported as text.

## Gateway-unit decision

The gateway unit is **rendered but never enabled**. Its `ExecStart` is the real spec command
(`<current>/bin/archi gateway serve`) rather than an `archid --gateway` placeholder, and the
template's first comment says the command arrives with the gateway service and that enabling is
left to that task. Rationale: a placeholder ExecStart would have to be unwound later and would
make `enable --now` fail loudly on a machine that is otherwise healthy; a rendered, unenabled unit
is inert, `systemd-analyze verify`s clean, and the later task only has to enable it.

## Tests and results

New `packages/archid/test/linux-setup.test.ts` (18 tests): golden unit text for the private fleet
and for the gateway; a named fleet on a path with a space and a `%` (quoting and `%%` escaping);
a development checkout's tsx ExecStart; `setupLinux` writing the home, the shims and both units
with no `.plist` anywhere under the temp home; a repeat run that leaves the unit's mtime and text
untouched and reports no unit line; the exact argv for daemon-reload/enable/loginctl and the linger
action text; a machine with no `systemctl` keeping its files; the wrapper errors
(`no_systemd` for ENOENT and for a missing bus, `unit_failed` with stderr); linger on/off/unknown;
`rollbackRelease` symlink flips (named target, single remaining release, nothing to go back to);
`probeOrRollback` leaving a healthy release alone, swapping back and restarting, and reporting when
there is nothing to go back to.

Extended: `test/tmux.test.ts` (Linux and Mac output differ only by the `pbcopy` line; 3.4 and 3.5
differ only by `extended-keys-format`), `test/uninstall.test.ts` (Linux branch removes only our
units and the release tree, keeps a foreign unit and the fleet home), `packages/cli/test/doctor.test.ts`
(systemd/linger checks replace launchd, a stopped and an absent unit, the apt remedy).

- `pnpm vitest run --project archid --project cli` — 795 passed. One later run showed
  `fleet.test.ts > keeps a second terminal that ran an agent…` failing; it passes alone and passed
  in the other full runs — a known tmux timing flake, untouched by this change.
- `pnpm typecheck` — clean.

### TDD evidence

`linux-setup.test.ts` and the two tmux cases were written first and run before any implementation:
the tmux cases failed on the assertion (`expected [] to deeply equal ['set -s extended-keys-format csi-u']`)
and the Linux file failed to collect (no `src/linux/setup.js`) — 2 failed, 11 passed. After the
implementation the same command reported 31 passed.

### Docker verification (ran)

Docker was running, so the rendered units were verified for real:

- `systemd-analyze verify` inside `ubuntu:24.04` (systemd 255) on all three units —
  `verify ok` for each, including the fleet whose paths hold a space, once stub executables existed.
  Before the stubs the only complaint was the missing binary, which proves systemd parsed
  `"/home/l s/.../bin/archid"` as one command.
- The Linux/3.4 `tmuxConfText` output in the same image (tmux 3.4): `tmux -f conf new-session`
  exit 0 and `source-file` **exit 0**, with `mouse on` and `extended-keys on` taking effect.

## Files changed

Added: `packages/archid/systemd/archipelago-archid@.service.in`,
`packages/archid/systemd/archipelago-gateway.service.in`, `packages/archid/src/linux/setup.ts`,
`packages/archid/src/linux/service.ts`, `packages/archid/test/linux-setup.test.ts`.
Modified: `packages/archid/src/{setup,release,main,uninstall}.ts`,
`packages/archid/src/tmux/conf.ts`, `packages/archid/package.json`,
`packages/cli/src/commands/{setup,doctor,uninstall}.ts`,
`scripts/{install-release.mjs,install-release.d.mts,release-stage.mjs}`,
`packages/archid/test/{tmux,uninstall}.test.ts`, `packages/cli/test/doctor.test.ts`.

## Self-review

- Every unit path is absolute and goes through `<prefix>/current`; the log path is under the data
  directory.
- No launchd file is written on the Linux branch — asserted by walking the whole temp home for
  `.plist`.
- No sudo is run. `sudo apt install tmux` appears only as reported text.
- Every systemctl/loginctl call is argv; no shell, no interpolation. The exact argv is asserted.
- The Mac path is unchanged: `setupHome` still writes the plist and bootstraps, and all existing
  archid and cli tests pass.
- Unit files are written temp + rename and skipped when unchanged.

## Rulings bent

1. **`status` is read with `systemctl --user show -p …`, not `systemctl --user status`.** `status`
   exits 3 for a merely stopped unit and prints prose; `show` exits 0 and answers in fields, which
   is what doctor and the structured errors need. Same four operations, machine-readable form.
2. **Log file name** is `<unit without .service>.log` (`archipelago-archid@private.log`), reading
   the ruling's `<unit>.log` as the unit name rather than the file name.
3. `rollbackRelease` takes an optional second argument (the exact target the install reported).
   Called with the prefix alone it still works, as ruling 5 wrote it.

## Concerns

- The gateway unit is inert until the task that adds `archi gateway serve`; nothing enables it and
  `archi doctor` does not check it yet.
- The release layout grows a `systemd/` directory, so a companion archive built before this commit
  has no unit templates and `archi setup` from it would fail to render. Anything built from this
  commit carries them.
- Nothing has run on the real remote; everything here is fakes, temp dirs and the Ubuntu container.
  An on-machine pass on `trift` is still owed.

---

# Fix report — review round 1

Commit: `dc92c03 A Linux unit escapes what systemd reads, and only a started one is probed`

## Finding 1 — escape coverage was a blind spot

**What changed.** The golden case now renders every value from a path carrying a space, a `%` and a
`$` (`/tmp/x y%z/$home/…`) and asserts the escaped form on `ExecStart`, all three `Environment`
lines and both log lines, for the fleet unit and for the gateway. A new case pins an argument that
holds a `$` (a development checkout at `/src/a$b%c`).

**A real bug the new coverage exposed.** Verifying the tricky unit in the container showed systemd
reporting the command it had resolved as `/tmp/x y%z/$$home/…/archid` — the `$$` was *not*
unescaped. Two probes under a real systemd in `ubuntu:24.04` settled the rule:

- command name: a unit with `ExecStart="/tmp/d$$x/run"` fails (`Command /tmp/d$$x/run is not
  executable`), while `ExecStart="/tmp/d$x/run"` verifies ok — the command name is literal;
- arguments: `ExecStart=/usr/bin/touch "/tmp/probe/a$$b"` created the file `a$b`, so `$$` is the
  escape there (a bare `$dv-end` came through untouched as `c$dv-end`).

So `execArg` was replaced by `execLine`, which escapes `$` in arguments only and leaves the command
name literal. `%` is still doubled everywhere, including the log paths.

**Mutation evidence** (each mutation applied to `packages/archid/src/linux/setup.ts`, then
`pnpm vitest run --project archid test/linux-setup.test.ts`, then reverted):

| Mutation | Result |
| --- | --- |
| drop `%`→`%%` from `esc` | 3 failed, 19 passed |
| drop `$`→`$$` from arguments | 1 failed, 21 passed |
| apply `$$` to the command name too (`i === 0` → `i === -1`) | 3 failed, 19 passed |
| drop `%`→`%%` from the log path | 1 failed, 21 passed |

**Docker re-verification** (Docker was up). `systemd-analyze verify` in `ubuntu:24.04`:

```
verify ok: archipelago-archid@work.service
verify ok: archipelago-gateway.service
verify ok: archipelago-archid@private.service
```

and, booting systemd for real in a privileged container, the fleet unit started from the awkward
path and wrote its append log:

```
active
{ path=/tmp/x y%z/$home/.local/share/archipelago/current/bin/archid  argv[]=/tmp/x y%z/$home/.local/share/archipelago/current/bin/archid ; … }
--- log file:
archipelago-archid@work.log
started with ARCHI_HOME=/tmp/x y%z/$home/.archipelago-work PATH=/tmp/x y%z/$home/.local/share/archipelago/current/node/bin:/tmp/x y%z/$home/.local/bin:/usr/local/bin:/usr/bin:/bin
```

## Finding 2 — a machine with no systemd rolled back a good release

**What changed.** `startUnit` returns `{ started: true; done } | { started: false; reason }` and
`setupLinux` returns `{ done, started }`. The probe and rollback moved out of the CLI into
`setupLinuxRelease(o)` in `packages/archid/src/linux/setup.ts`, which probes only when the unit was
really started and a previous release exists; otherwise it returns the setup lines with the reason
and leaves `current` where the install put it. `packages/cli/src/commands/setup.ts` now calls that
one function, so the CLI holds no copy of the rule.

**Covering tests** (`packages/archid/test/linux-setup.test.ts`):

- *keeps the release that installed when the machine has no systemd to start it with* — fake runner
  whose `systemctl` is ENOENT, two releases under a temp prefix: the probe is never called,
  `current` still points at the new release, and a line names the missing systemd;
- *puts a started release that does not answer back, and leaves a first install alone* — a started
  unit that does not answer flips `current` back to the previous release and restarts the unit,
  while an install with no `rollbackTo` is never probed;
- the `setupLinux` cases now assert `started` (false without systemctl, false when systemd is
  absent, true after `enable --now`).

## Commands and output

```
pnpm vitest run --project archid test/linux-setup.test.ts   → 22 passed
pnpm typecheck                                              → clean
pnpm vitest run --project archid --project cli              → 799 passed (69 files)
```
