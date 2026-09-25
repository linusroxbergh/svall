# Fleet handover landed on main: squash report

Branch `experimental-remote-sessions`, one commit a7aca29f on `origin/main` 56cc133 (#166), 279 files, +42116 −571. Source: `fleet-handover-history`
2415ab4 (139 commits since 25abac7). Not pushed.

## Base moved during the work

`origin/main` was ed3619e when the task started. Another session pulled twice while I was resolving
(#165 "Plainer copy across the README, the app, the CLI and mission control's docs" and #166 "A collapsed
empty island hides its New character row"). I finished and verified the squash on ed3619e, saved it as a
temporary commit, then replayed that diff onto 56cc133 (`git cherry-pick -n`) and resolved the five files the
two new PRs touched, then verified everything again on 56cc133. `git ls-remote origin refs/heads/main` said
56cc133 before the replay.

## Conflicts, grouped

64 files conflicted on ed3619e (62 content, 2 delete/modify), plus 5 more on the replay.

**Protocol** (`messages.ts`, `migrate.ts`, tests `messages`, `migrate`, `state`, `state-version`)
- PROTOCOL_VERSION set to 12 once. Main's un-exported timeouts stay un-exported; the branch's handover
  methods, timeouts, parts and error frame kept.
- State v8 (below). Test fixtures that meant "the current version" moved from 7 to 8.

**Config split** (`archid/src/config.ts`, `protocol/src/handover.ts`, `paths.ts`)
- The branch's fleet.json + node.json split and `.bak` migration kept. Main's config changes moved into
  `FleetConfig`/`NodeConfig`: object defaults use `.prefault({})`; `mobile.pushContact` is optional with no
  default (main: unset means the served page); the `mobile.logins` comment says an empty list lets in only the
  Mac's own login. Placement by the branch's rule: `logins`, `origins`, `pushContact`, `home`, `scribe`,
  `linear`, `defaultCwd`, `handover` in fleet.json; `port`, `host`, `shell`, `mobile.httpsPort` in node.json.
- Main's `paths.repoRoot()` dropped: the branch's `release.ts` is the one place the layout is named. Main's
  callers (cli `version.ts`, `setup`, `launch`, `mobile`) now use `@archipelago/archid/release`; `archi
  --version` prints the release version when it runs from an installed release.
- User-facing text that named config.json now names fleet.json (mobile errors, PhonePanel, cli mobile, README).

**Daemon** (`store.ts`, `fleet.ts`, `reconcile.ts`, `main.ts`, `api/server.ts`, `api/methods.ts`,
`mobile.ts`, `setup.ts`, `uninstall.ts`, `tmux/conf.ts`, `tmux/tmux.ts`, `links/git.ts`, `codex/install.ts`,
`profile.ts`)
- store: main's quarantine/salvage load (dropped entities, `.v6-` backup copy) plus the branch's durable
  temp cleanup; the branch's `commit`/`publish`/`replace`/`promote` with `writeDurable` (fsync, 0600). The
  write still lands before any listener runs, which is what main's "written before it is taken" asked.
- fleet: main's `windowClosed` (asks tmux whether the window is really gone), `windowOf` dormancy rule,
  `unplaced` logging, link sweep with `refreshMany`/`slice`, docs, codex rollout cwd, nested-run guard,
  `characterKeyEnv` for every window; the branch's ownership gate (`writable()`), `carried` terminals,
  tracked background writes (`track`/`settle` now also cover the async window-close and the link sweep),
  dormant second terminals (`attachSlot`/`loseSecond`, its own cwd and revive command), `session-start`.
  `doRevive`'s reattach-to-a-live-window path also clears `resumeError`.
- reconcile: main's strays-keep-their-id, `IslandFull` private, codex `-c tui.resume_cwd=session`; the
  branch's `TerminalSlot`, `markSlotDormant`, `carried`. A stray's second window is attached through
  `attachSlot`, so it gets a cwd.
- main.ts: main's kernel lock and `start()`, `rotateLog`, phone key, `watchServed`, tmux-binary file, hook
  receiver after the API; the branch's ownership, handover service, startup mode, conf written after the tmux
  version is read, `sourceConf` only when writable.
- api/server: main's phone admission (empty list admits no one; the owner login from tailscale; a refused
  phone asks tailscale again), phone sockets closed when the link turns over, heartbeat; the branch's parts,
  ownership/handover broadcast, revocation on every send. The branch's `loginAdmitted` (empty admits all) is
  gone; revocation uses main's rule.
- methods: `Ctx` has both `docs` and `ownership`/`handover`. `guard.ts` classifies main's new methods:
  `char.reorder`, `docs.create`, `docs.rename`, `docs.delete` are mutations.
- setup: main's full-path `isOurs`, `statusWrapper`, `$PPID` in the hook, `installedNode`,
  `requireWritableHooks`, `claudeHooksCurrent`/`codexHooksCurrent`/`shimsCurrent`, launchd env, Homebrew
  opt path, `writeAtomic`, seeded CLAUDE.md; the branch's `RunFrom` (release or checkout), `daemonProgram`,
  `setupFleetHome`, release shims as relative links, `moveProfileAgents` (now also writes the launchd env),
  `--replace-settings`, `HOOK_GUARD` in both hook commands. A release install writes the hooks with the
  release's node. `shimsCurrent` accepts a shim that links into `current/bin/archi`. The branch's Linux setup
  also runs `requireWritableHooks` before writing, as `runSetup` does.
- uninstall: main's multi-settings removal, phone links turned off, tmux servers stopped, refusal inside a
  fleet's tmux; the branch's systemd units, releases and release shims. Both platforms stop tmux servers.
- tmux: main's paste-buffer input (with `-S` detection) and token-separated listing; the branch's `panePid`,
  abort signals (the paste now takes one), `noServer`. The paste runs with `paneEnv()` like every other tmux
  call, so a release root never leaks into a server it starts. tmux.conf keeps `set-clipboard off` on both
  platforms; `pbcopy` only on macOS.
- git: the branch's `GitRunner`; `resolveRepo` does main's single rev-parse and runs on a runner killed with
  SIGKILL after 10 s (main's "git is killed after ten seconds").
- mobile: main's `phoneKey`, `tailnetSelf`, owner fallback, key rotation; the branch's `ensureBundle` and
  `mobileDistDir()`. `mobileControl` takes `logins` as a function, and `startApi` takes `origins` as one, so a
  handover that replaces fleet.json's lists is seen at once (the branch's intent, on main's API).
- profile: every top-level command is reserved (main's rule and main's test): the branch's `host`,
  `handover`, `gateway`, `fleet`, `connect`, `connection-info`, `version` were added.

**CLI** (`client.ts`, `main.ts`→`program.ts`, `setup`, `doctor`, `uninstall`, `launch`, `mobile`, `char`)
- client: both. `connectEndpoint` takes `restart`; `Client.connect(home)` passes it, so a local daemon on
  another protocol is refused with main's message; tunnels skip the check as before (the controller checks
  the far protocol itself and names it). `ApiError` exported with `data`; call on a closed socket fails at
  once; timers unref'd; parts for large requests.
- program: main split `main.ts` into `program.ts`; the branch's `--host`, `connectFor` + ssh-master cleanup
  and its seven commands moved there. `mobileCommand` is main's daemon-driven one, reached through
  `connectFor`.
- setup: main's check (`requireWritableHooks`, hooks/shims current) plus the branch's release install,
  rollback, systemd path; paths from `userPaths()` (CLAUDE_CONFIG_DIR aware).
- doctor: union. Main's hook receiver, daemon node/env (macOS only), hooks/codex "out of date", node ≥ 24,
  `archi <commit>` line; the branch's Linux systemd/gateway/linger checks, rsync, agent PATH, config lines.
- mobile: main's version (the daemon serves); a missing page on a release says so instead of naming pnpm.
- char: main's `render.ts` owns `stateOf`; the branch's dormant-second state moved there; `--keep-here`.

**Web** (`store.ts`, `Corner.tsx` deleted on main; `boot.ts`, `bridge.ts`, `styles.css`, `TerminalArea`,
`CharPanes`, `SideCard`, `Sidebar`, tests `api`, `store`)
- Main split the store into `store/*`. The branch's host/handover/connection state went into a new
  `store/handover.ts` slice; `setFleet`'s `awaitingOwner` release went into `store/fleet.ts`.
- Main replaced `Corner.tsx` with `UtilityDock.tsx` (sidebar foot). The owner badge and the Handover control
  moved there as dock items (`data-testid` unchanged).
- boot/bridge/TerminalArea/CharPanes/SideCard/Sidebar: both sides; main's action helpers
  (`openSecondTerminal`, `reviveCharacter`) used for the branch's dormant-second revive.

**Swift** (`AppDelegate`, `ArchiHome`, `Bridge`, `SurfaceManager`, `build.sh`)
- Main moved the page routing out of AppDelegate into `ShellRouter`. The branch's `RemoteConnection`,
  `HostProcess`, `HandoverSession`, `isHere`, host/handover messages and shell info fields moved into
  `ShellRouter`; main's `listening` flag stands in for the branch's `pageReady`. AppDelegate is main's.
- SurfaceManager: main's `OverlayViews` plus the branch's `AttachCommand`, route, remembered attaches,
  `rebuild`, injectable view factory. The tmux path is main's (the daemon's `tmux-binary`, else a search).
  `onFailed` keeps main's `(id, reason)`; a surface that quits at once names ssh for a remote route.
- build.sh: the branch's controller release and companion are staged into the bundle before main's
  `CFBundleVersion` stamp and ad-hoc signing (checked: `codesign` signs and verifies a bundle carrying Mach-O
  files under Resources).
- ArchiHome/Bridge: both.

**Scripts, README, root**
- `desktop-install.sh`: main's all-at-once missing checks; the branch's unconditional release setup (so
  main's "set up again when out of date" branch is moot and gone).
- `package.json`: main's toolchain plus the branch's `esbuild` devDependency; `pnpm-lock.yaml` is main's plus
  `pnpm install` (adds root `esbuild` and cli `zod`).
- `test/isolate.ts`: both lists of cleared variables.
- README: main's (latest) text with the config split, `--replace-settings`, and the installed release.

**Replay onto 56cc133**: README, PhonePanel, archid `mobile.ts`, cli `char.ts`, cli `doctor.ts`: main's new
wording kept, config.json → fleet.json, the branch's additions kept.

## Dependency-upgrade ports

- zod 4
  - `.default({})` → `.prefault({})` on object schemas with inner defaults (`FleetConfig.home/scribe/mobile/
    handover`, `NodeConfig.mobile`, the merged `Config.mobile`); zod 4's `.default` would hand back `{}`
    unparsed.
  - `.removeDefault()` → `.unwrap()` (on `ZodPrefault`).
  - `MachineId`/`FleetId`: `z.string().uuid()` → `z.guid()`, which keeps zod 3's acceptance (zod 4's `uuid`
    rejects ids without RFC variant bits, including test fixtures and any machine.json already written).
  - `durable.ts`: `ZodType<T, ZodTypeDef, unknown>` → `ZodType<T>`.
  - `inventory.test.ts` schema walk rewritten on `_zod.def.type` (refine and brand no longer wrap).
  - `cli` gets its own `zod` dependency (main dropped it from the root).
- TypeScript 7 / main's `noUnusedLocals`: dropped unused imports and bindings (`manifest.ts`,
  `controller/connection.ts`, two tests).
- Vitest 5: no API port needed; `describe(name, { timeout }, fn)` used for the git-heavy suite.
- commander 15: no port needed (`--keep-here`/`--no-keep-here` behave as before).
- React 19: the branch's components typecheck under React 19's types unchanged.
- Node 24 minimum: the release's pinned runtime moved from Node v22.23.2 to v24.21.0 (latest 24 LTS on
  nodejs.org) and esbuild targets `node24`. Without it `archi setup` from an installed release would fail
  main's `node ≥ 24` preflight. The build downloads and verifies the new tarballs on the next
  `desktop:install`.

## Schema and protocol

- State v8 on main's framework: `CURRENT` from the schema literal, `OLDEST` 6, `NewerStateVersion`,
  `salvage`. 6 and 7 are lifted by `liftV8`, which gives a second terminal its character's cwd, then salvaged
  as 8; 8 is salvaged as is. Main's 6→7 meaning (codex agents, same shape) is untouched: 6 and 7 both take
  the same lift. New tests: 7→8 with a second terminal (and one without), 6 through to 8, newer = 9.
  `state-version.test.ts` gets `8: '67b1550a608dbcde'`.
- PROTOCOL_VERSION 12, one bump for main's 11 surface plus the branch's handover surface.

## Design tokens

`.use-owner`/`.use-handover` restyled as dock items and every `.host-*`/`.ho-*` rule tokenised:
gaps and paddings on `--sp-*` (18px list indent → `--sp-2xl`, the choice button's 3px → `--sp-2xs`),
`border-radius: 99px` → `--r-pill`, weights on `--w-*`, letter-spacing on `--track-loose`. Opacities stay
raw numbers, as main's own rules keep them (the guard does not cover opacity). `tokens.test.ts` passes.

## Tests ported to the merged behaviour

- main's tests on the durable writer: three failure injections used a `state.json.tmp` directory; they now
  make the home read-only for the write (`store.test`, `guards.test` ×2).
- main's tests given ownership where the daemon now needs it (`guards`, `methods`, `push`, `api`), and
  `panePid` in a `LiveWindow` fixture; `tmux-listing` mocks the private `call`.
- the branch's tests on main's API: phone logins listed instead of "empty admits all" (`api`, `mobile`,
  `destination`), live `logins`/`origins`/`key` functions, `statusWrapper`, full-path hook fixtures
  (`sessions`), codex resume with `-c tui.resume_cwd=session`, protocol in fake handshakes that go through
  `Client.connect`, a second terminal's cwd in a web fixture.
- `bridge-swift.test.ts` (main) reads a message's top-level Swift dictionary plus fields set on it after, so
  optional fields count and a nested `event` dictionary does not.
- `fleet.test` "keeps a second terminal that ran an agent": main's paste-based `sendLine` takes long enough
  for two polls to see the pane at a shell and drop the agent before `exit` lands; the test types `exit`
  with `send-keys`.
- `worktree-portability.test.ts`: 30 s suite timeout (0.4-0.7 s alone, over 5 s under the full parallel run).
- `setup.test`: a release install's shims are the relative link and `shimsCurrent` accepts them.

## Verification (final base 56cc133)

| Command | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm vitest run --project protocol` | 10 files, 137 passed |
| `pnpm vitest run --project archid` | 77 files passed, 1 skipped; 1421 passed, 4 skipped |
| `pnpm vitest run --project cli` | 30 files, 508 passed, 3 skipped |
| `pnpm vitest run --project @archipelago/desktop-web` | 60 files, 632 passed |
| `swift test --package-path apps/desktop/mac` | 65 tests, 0 failures, no warnings in our sources |
| `pnpm --filter @archipelago/desktop-web exec playwright test` | see below |

Playwright: 144 passed on 56cc133 (3.2 min), exit code 0; also 144 passed on ed3619e. Both runs sat idle
after the last test until I stopped the `vite` the webServer had started: `pnpm exec` leaves it orphaned
(ppid 1, its own process group), and Playwright waits for it at shutdown; with vite stopped it printed its
totals and exited within 2 s. The Playwright config and e2e harness are main's, unchanged by this merge; I did
not run plain origin/main's e2e to show the same wait there.

Skips are environment-gated (live ssh, no rsync 3, no Ghostty).

## Unsure / worth a look

- Linux daemon lock: main's `lockHome` opens with macOS's `O_EXLOCK` (0x20), which Linux ignores, so on the
  gateway a second archid for one home is not refused by the lock (systemd runs one per unit). Not changed.
- `codex resume -c tui.resume_cwd=session` resumes in the session's recorded cwd. The handover rewrites the
  rollout's cwd for the destination, so this should hold, but the codex trust preflight checks the
  character's cwd, which can differ from the session's when codex followed its commands into a worktree.
- `archi --version` (main) and `archi version` (branch) both exist and print different things.
- Setup's hooks probe for handover (`probeAgent`) checks the private fleet's scripts, as main's doctor does.
- The release now pins Node 24.21.0; the owner's next `desktop:install` downloads it.
- Temporary local branch `fleet-handover-squash-ed3619e` (the squash on the old base) was deleted after the
  commit. Nothing was pushed.
