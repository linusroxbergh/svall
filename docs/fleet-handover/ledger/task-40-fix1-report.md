# Task 40 fix round 1: report

Branch `experimental-remote-sessions`, FIX_BASE c25a2f25. Six commits, a30024da..4354a256, one per item; not pushed.
Uncommitted: this report. `$X` below is
`/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/3739c9b8-51d0-4aa6-ac32-19bc0b56eee0/scratchpad/t40x`,
where every before/after log named here is kept.

| Item | Commit | Subject |
| --- | --- | --- |
| R4 (m5) | a30024da | archi doctor's line for a config layout archid refuses ends its reason without a stray full stop |
| R1 (m1) | 2b73371d | archi setup on Linux looks for claude and codex on the PATH the units run with, as archi doctor does |
| R2 (m2) | 9b386cdb | A terminal whose wake fails on the destination stays dormant with the launch flags its carried resume had |
| R3 (m3, m4) | 2384e5d2 | archid reads a window name or pane path on tmux 3.4 exactly, a backslash, a $ before a letter and a control character included |
| R6 (N2) | 9f4ae12e | archi setup leaves mission control's folder alone on a machine whose ownership record names another owner |
| R5 (N1) | 4354a256 | archi host upgrade installs a release with that release's own setup, and a rollback returns to the release the machine ran before and says which it runs |

## Items

**R4.** Doctor drops the refusal's closing full stop before `; a stopped archid waits for it to be fixed`. The layout
test now pins both endings (`… and delete it; a stopped …`, `… and start again; a stopped …`).
- Red (`r4-before.log`): the detail read `… and delete it.; a stopped archid waits for it to be fixed`.

**R1.** `setupCommand` builds `realPreflightDeps(t.home, platform)` once and finds the agents with
`findAgents(pre.agentPath ?? pre.pathEnv)`, as doctor does. It takes a `platform` (default `process.platform`, as
`provisionCommand` does), so a Linux run can be tested on the Mac.
- Test (`cli/test/setup.test.ts`): `setup --check` on `linux`, with claude only in `~/.local/bin` and the login PATH
  `/usr/bin:/bin`, must list `! hooks  missing or out of date`.
- Red (`r1-before.log`, with the platform threaded but the old `process.env.PATH` lookup): no hooks warning.

**R2.** `wakeSlot` keeps the slot's revive before opening it (opening deletes it), and `lay()` puts it back after
`markDormant`/`markSlotDormant` while the slot's agent still has that session. All three `lay()` calls pass it, so a
terminal reopened after a gone window also resumes with its flags.
- Test (`destination.test`): bo carries `claude --dangerously-skip-permissions --effort 'high' --resume …` and never
  reports its SessionStart; dee carries `codex resume -c tui.resume_cwd=session -m 'gpt-6' …` and its window fails to
  open. Both must stay dormant with those commands.
- Red (`r2-before.log`, `r2-before-dee.log`): bo came back `claude --resume …`, and dee
  `codex resume -c tui.resume_cwd=session …` without `-m`.
- The scene's dee carried `codex resume <id>`, which no rest writes. It now carries the shape `reviveCommand` builds.
  Three existing tests had matched the rebuilt command rather than the carried one.

**R3.**
- `listing()` wraps every field as `#{s/\\\\/(<token>)/:field}`, so tmux swaps each backslash for a placeholder made
  per listing. Every backslash left in the output is then one of tmux 3.4's own escapes.
- The decode maps `\ooo` to its byte, `\a \b \f \r \v` to their control characters and `\$` to `$`, reads the bytes as
  UTF-8 and puts the placeholder back as `\`.
- Tests (`tmux-listing.test`):
  - the 3.4 shape adds C escapes and `\$` before a letter, `_` or `{`;
  - the mock applies the `s/…/` swap;
  - rows gain `$odd\name\x1f\r` and `/w/$work/back\slash\037\$x\x7f`, and a session named `$work\x`;
  - the real-tmux test gains `$work` and `back\slash\037\$x`;
  - a separate real-tmux test lists sessions under an empty locale.
- Red (`r3-before.log`): both 3.4-shape tests failed, e.g. path `/w/\$work/back\slash\037\\$x\177`, session `\$work\x`.
- Against `adcee29c^`'s `tmux.ts` (`r3-before-f8.log`), all four listing tests fail, the new real-tmux session test
  included. So the session listing now has a test that fails without it.
- **Real tmux 3.4** (`$X/tmux34/real-34.out`). colima was stopped; I started it, ran the image `archi-tmux34` from
  F8, stopped colima, and set the docker context back to `desktop-linux`. The command, per bundle:
  `id=$(docker create archi-tmux34 node /tmp/run.mjs); docker cp -q run-$v.mjs $id:/tmp/run.mjs; docker start -a $id`.
  The probe made 16 directories and windows under no LANG: control characters, `a$b`, `$work`, `a$`, `a${b}`, `a$_b`,
  `a$1`, `a\b`, `back\slash\037\$x`, bell/CR/DEL and `lit\r\n\t` as literal text.

  | Build | Paths exact | Names |
  | --- | --- | --- |
  | HEAD before R3 | 7 of 16 (`\$work`, `\037`, `\a`, `\177` kept as printed) | escaped the same way |
  | R3 | 16 of 16 | 16 of 16 as asked |

  Sessions were `fleet` and `v-c_0` in both runs. On the Mac's 3.7c both builds read 16 of 16 paths
  (`$X/tmux34/mac.out`), so the `s/…/` format works there too.

**R6.** `setupUser` reads `owner.json`. If it names a machine other than this one, setup leaves `home.cwd` alone and
says `home folder left as it is, as <id> owns this fleet`. A missing or unreadable record, or one that names this
machine, refreshes the folder as main does. The Mac's `runSetup` goes through the same `setupUser`.
- Test (`linux-setup.test`): mission control's folder holds an older template, the same as the owner's, and
  `owner.json` names another machine. Then:
  - `setupLinux` leaves the tree byte-identical, mtimes included;
  - `ReplicaStore.claim` of it as the `home` root, with the owner's content incoming, answers `replica`, so the next
    handover adopts it without `--archive`;
  - once `owner.json` names this machine, setup brings the folder up to date.
- Red (`r6-before.log`): the tree gained `.agents/`, `AGENTS.md`, the new rules and skills. With the snapshot
  assertion removed (`r6-before-claim.log`), the claim answered `ok: false`, as N2's `destination_occupied` did.

**R5.**
- `upgradeHost` first reads the far machine's current release (`readlink <archiBase>/current`). It then installs with
  `bootstrapSetup`, the new release's own `archi` unpacked into staging, as `host add` does, so no client older than
  the new daemon probes it.
- The probe also requires the daemon's `system.info` release to be the one installed. A new release whose own setup
  put the old one back no longer passes as upgraded.
- The rollback runs `<archiBase>/releases/<new>/bin/archi setup --rollback <before>`. That archi can name a release,
  which the one being replaced may not.
- After the rollback the controller reads `current` again. The action says `<name> runs release <now>, the one it ran
  before`, or `…, not <before>, …` if they differ. A rollback that fails says the same in its action.
- `archi setup --rollback [release]` takes an optional release name and refuses one that leads out of `releases/`.
  With no name it still goes to the newest other release.
- `installedSetup` is gone.
- Tests (`host.test`, at the controller): exec-mode fake ssh on a far machine in the test's temp folder. `current` is a
  real link, and each release's `archi` is a script that answers `connection-info` and `doctor` as that release. Its
  setup unpacks an archive and keeps it only while the new daemon comes up and speaks this archi's protocol. The fake
  daemon answers `system.info` with the release `current` names.
  - Upgrade across a protocol bump (1.2.2 speaks `PROTOCOL_VERSION - 1`): `ready`, no rollback, `current` on 1.2.3,
    setup run from staging.
  - A new release that does not answer the tunnel, with an older 1.2.1 newest by mtime: rolls back to 1.2.2 by name,
    and the action says `trift runs release 1.2.2, the one it ran before`.
  - A new release whose own setup put 1.2.2 back: the probe warns `answers from release 1.2.2, not 1.2.3`, and the
    rollback names and reports 1.2.2.
  - `cli.test`: `setup --rollback 1.0.0` goes there with 1.2.0 current, and `--rollback ../releases` is refused.
- Red (`r5-before-host.log`):
  - the protocol-bump case reproduced N1 exactly: `actions: ["ssh trift.test and read the daemon log; the machine is
    back on the release it ran before"]`;
  - the no-answer case ended on `1.2.1`;
  - the setup-rolled-back case reported `ready`.
  - (`r5-before-cli.log`) the named rollback exited 1.
- Replaced tests:
  - `installs with the release already on the machine and probes it` asserted the old behaviour; the protocol-bump
    case replaces it.
  - The static `puts the machine back on its old release …` is replaced by the no-answer case.
  - The two other static upgrade tests gained `readlink`/`tar` replies, and the archive test now expects bootstrap's
    `rm -rf <staging> <archive>`.

## Verification (4354a256)

| Command | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm vitest run --project protocol --project archid --project cli --project @archipelago/desktop-web` | 189 files passed, 1 skipped; 2949 passed, 6 skipped |
| per project | protocol 137; archid 1561 passed, 3 skipped; cli 543 passed, 3 skipped; web 708; scripts 26 |

Baseline at f1bceb6b (fix-wave report): 2943 passed, 6 skipped. The +6 are R1, R2, R6 and the session test (+1 each),
and R5 (+3 host −2 replaced +1 cli). Swift and Playwright were not run, as nothing in them changed.

## Concerns

1. **R5, trust.** An upgrade now authenticates the archive on the far machine against the signers it carries itself,
   as `host add` always has. The installed release's pinned `allowed_signers` no longer vouches for it. The gate is the
   controller: it refuses an archive its own signers do not vouch for before upload, and an unsigned one without
   `--allow-unsigned`.
2. **R5, gateway after a rollback.** `archi setup --rollback` (and setup's own `probeOrRollback`) restarts only
   `archipelago-archid@<fleet>`. The gateway keeps running the rolled-back-from code until it restarts. This was so
   before; left.
3. **R5, the install line.** The install step still shows only setup's last line, `ok`, even when the new release's
   own setup put the old one back. The probe step then names the release that answers, and the rollback step names
   the release `current` is on.
4. **R2, a daemon that died mid-wake.** When an earlier attempt opened the window, that open already deleted the
   carried revive. A later `lay()` then has nothing to keep, and the terminal resumes bare. Only the carried revive can
   hold the flags, so this is left.
5. **R6.** A gateway-held fleet whose record still names no owner (`0000…`) also counts as owned elsewhere, so setup
   leaves the folder alone there too. That is the same rule as for a replica.
6. **R3, names.** tmux stores a window name through its own escaping: 3.7c doubles a backslash, and 3.4 does not. The
   listing now reads the stored name exactly on both. What tmux stored can still differ from what was asked, as for
   `rename-window a\b` on 3.7c.
