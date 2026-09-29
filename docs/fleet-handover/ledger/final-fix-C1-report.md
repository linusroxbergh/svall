# Final fix wave — Fixer C1 report

Status: DONE_WITH_CONCERNS. 15 commits, `465f471d` … `7d58cc8c` (interleaved with Fixer A's), all on
`experimental-remote-sessions`, not pushed.

## Items

| Item | Commit | What changed | RED → GREEN |
| --- | --- | --- | --- |
| C11 (web) | 465f471d | `readable(e)` in `web/src/handover.ts` checks every field the sheet reads, per event and per outcome; `applyEvent` passes over a line that fails it, and the store's `handoverEvent` does too (its `needsUser` read `safe`). Event type declarations untouched. Contract test "the helper lines the sheet reads": one line per event/outcome as the cli prints it, the field list the sheet reads from each, and a line missing any of them is passed over without throwing; an older events file replays to its status. | RED: replay threw `Cannot read properties of undefined (reading 'map')`; store test threw `(reading 'length')`. GREEN. |
| L22 + L23 | cb7d29c3 | `terminals.ts`: an attach answered after the page's hold began shows no surface and is remembered; `frozen` joins `not_owner` as a retried refusal (no sticky error); remembered attaches retry on reconnect and when the page's hold on terminals lifts. | RED: 2 new tests (surface shown over the hold; sticky "frozen" error). GREEN. |
| C31 + L26, L27, L33 | 3af528d4 | New `LineChild.swift`: one NDJSON child (DispatchGroup join of exit, stdout and stderr ends; lines on main in order) with one bounded `stop()` (stdin closed + 1 s when it has one, SIGTERM + 2 s, SIGKILL). ControllerProcess (stderr left to the app, as before), HostProcess and HandoverSession run on it. Shared `String.allowed(by:)` and `machineNamePattern`. | RED: L27 cancel hung past 10 s; the handover attach survived `stop()` (pgrep found it). L26 test ("every step arrives before the end", 20 rounds) passed on the old code too: the race was not reproducible; kept as a guard. GREEN. |
| L28 | c3dcc01f | `--interrupt-after <ms>ms`, unchanged. | RED: `0s`/`2s` against `0ms`/`1500ms`. GREEN. |
| C12 | 20a536b8 | After an `enable` or `remove` run ends, ShellRouter re-sends `shell.info` (gateway and `handover.enabled` read fresh). `HostOp.rewritesFleetConfig` is the tested rule; the ShellRouter wiring needs a WebView and has no unit test. | RED: compile (no member). GREEN. |
| C13 | d7ec0adb | `RemoteConnection(localOnly:)`, wired to `!ArchiHome.namesGateway()` (fleet.json's `gatewayMachineId`): a helper that exits or reports an error before its first `online` falls back to `.local` for such a fleet; a fleet naming a gateway stays `.pending`. | RED: compile. GREEN: 3 new tests plus a `.pending` assertion. |
| C14 | bceeda4a | `RemoteConnection.notice(forConfig:at:)`; Settings → Fleet config shows "… is on <machine>; open it there" while the fleet runs elsewhere; Ghostty config always opens. | RED: compile. GREEN. |
| C15 | db178d5b | `AttachCommand.build` builds a remote command only while `ControlSocket.answers(controlSocket)` (a unix `connect()`, so a killed master's leftover file counts as gone); otherwise nil, and the surface waits for the helper's next `online` like a pending route. Command gains `-o ControlMaster=no -o BatchMode=yes`. | RED: compile / new expectations. GREEN (incl. a live listening socket vs a stale file). |
| C18 | 38925a89 | `stageArchive` in `install-release.mjs` (below). `verifyRelease` split into `verifySignature` + `verifyTree`. `installRelease` stages archives through it; directories keep `verifyRelease`. | RED: not a function / message. GREEN. GNU tar (colima, `archi-it:machine`): with the SHA256SUMS compare removed an archive writing its own files through `d -> .` staged ("staged"); with it, refused. |
| C16 | ce1edeb4 | `rollbackTo` is the release `current` named before unless that is the tree just replaced; then the newest other release, or null. | RED: `rollbackTo` was the replaced path. GREEN. |
| C17 | 687d8ff7 | After `current` moves, every release but the new one and `rollbackTo` is removed (dot-named in-flight folders left alone). | RED: `['1.0.0','1.0.1','1.0.2']` kept. GREEN. |
| L32 / I11 | 5f4ed177 | `schemaVersions` (exported) records protocol, stateSchema, transferSchema, authoritySchema only. | RED: `agentAdapters` present. GREEN. |
| L36 | c8d79369 | `pins.json` pins `node.sha256` per platform (checked against nodejs.org's `SHASUMS256.txt` fetched 2026-09-29 and the cached tarballs); `nodeRuntime` refuses a tarball that differs from the pin, before the published check. `pinnedRsync` moved into `release-stage.mjs`; with `fresh` (set when `ARCHI_RELEASE_KEY` signs the build) it rebuilds from the pinned source instead of taking vendor/'s binary. | RED: tampered cached tarball accepted; fresh build returned the planted binary. GREEN (fresh build test gated by `ARCHI_TEST_RSYNC_BUILD=1`, ~30 s, run once). |
| L35 | 3c235f21 | ci.yml: `ghostty-kit.sh fetch` (GH_TOKEN), link the xcframework, `swift test --package-path apps/desktop/mac`. README development notes list `swift test`. | actionlint (with shellcheck 0.11.0) clean. |
| I12 | 7d58cc8c | `scripts/probe-*` and the `.d.mts` moved to `scripts/spikes/`, each with a "Manual:" header line; usage strings, the three archid portability tests' paths and the two fixture READMEs updated (single-line path edits in Fixer A's tree, checked unmodified first). | Portability tests 18/18. |

## C15 decision: terminals 11+ keep working

The surface keeps the real destination after `--`, so a surface past sshd's MaxSessions still rides its own login
("Session open refused by peer", then a login), as the M2 ruling and the security doc's Limits section accept. What
changed: no command is built unless the helper's master answers on its socket, so a dead master never leads ssh to
dial the destination on its own; and `BatchMode=yes` means the extra login authenticates as the master did (keys or
agent), never prompts for a password or accepts an unknown host key, so a destination that now reaches a machine with
another key fails. Refusing 11+ would have broken the accepted behaviour for a rarer risk. Residual: the master dying
between the socket check and ssh's mux connect still falls back to a non-interactive login (milliseconds).

## Export for Fixer B

`scripts/install-release.mjs`: `stageArchive(archive, staging, { verify, allowUnsigned, signer }) → { version, dir, release, entries, signed }`
(typed in `install-release.d.mts` as `Staged`). Synchronous (`execFileSync`, 120 s timeout, 16 MiB listing cap). Order:
listing → `archiveRelease` member refusals → name check `"<archive> names its release \"<v>\", which no installer takes"`
→ `"<archive> carries no releases/<v>/release.json"` → SUMS+SIG extracted → `verifySignature` → full unpack → SUMS
unchanged → `verifyTree` → `"<archive> unpacks as <v> but its release.json says <x>"`. Errors between extraction and
the tree check come wrapped as `"<archive>: <message>"`. For `inspectCompanion`: in a `mkdtemp` work dir removed in
`finally`, `const s = stageArchive(archive, work, { verify: o.verify, allowUnsigned: true })`, then
`{ archive, version: s.version, platform: String(s.release.platform ?? ''), protocol: Number(s.release.protocol), signed: s.signed && s.release.unsigned !== true }`.
The existing install.test.ts messages all match.

## Left for others

- **Fixer B (C16's second half):** `controller/host.ts` upgrade rollback still passes `to: before` and says "the one it
  ran before" when `before === companion.version` (a same-named reinstall), where that tree is gone. Suggested: in that
  case run `archi setup --rollback` with no release (it now lands on the one install-release kept) and word the action
  from what `currentRelease` then says, or say no earlier tree is kept.
- **Fixer C2 (docs):** `docs/security/fleet-handover.md` — the installer checks the signature once, then that the
  SHA256SUMS it checked is still the one unpacked (not "the signature again"); the destructive-operations row for
  install-release now removes releases other than the new one and the one before; the app's remote terminals attach
  only while the master answers and use `BatchMode=yes` (the "every command on a master names archi-remote.invalid"
  line is the CLI's). `ledger/task-28-29-contract.md` says the app sends `0s`; it sends `<ms>ms`. The node pins in
  `pins.json` need bumping with `node.version`.

## Verification

- `pnpm typecheck` clean; `pnpm vitest run --project @archipelago/desktop-web --project scripts` 788 passed, 2 skipped
  (the gated GNU tar and rsync build tests, both run by hand and green).
- Playwright: 155 passed, 1 failed (`e2e/card.spec.ts:122`, a listed load flake), which passed alone.
- `swift test --package-path apps/desktop/mac`: 75 tests, 0 failures.
- Also run: archid `release.test.ts` (incl. both build-script tests), `linux-setup.test.ts`, the portability tests;
  cli `install.test.ts`, `host.test.ts`, `setup.test.ts` — all green.
- actionlint clean; no shell script changed. colima started for the GNU tar check and actionlint, stopped after (no
  containers of mine left), docker context back on `desktop-linux`.

## Concerns

- CI's new Swift step has never run in Actions (billing blocks jobs).
- L26's race was not reproduced RED; the fix is structural.
- L23: a `frozen` refusal during a freeze this page does not follow retries only on reconnect or when a hold lifts; the
  terminal's own effect re-drives it when the character's state changes.
- C17 removes older releases while a process started from one could still run (setup restarts the daemons it moves; a
  long-lived `archi` started from an older release would lose its files).
