# M3 on-machine fix wave — O1–O11 (binding)

Source: W/m3-onmachine-A-report.md, section "Defects" (numbers 1–11 there = O1–O11 here) and the step
evidence above it. Environment notes: W/m3-env.md. Each item below carries the controller's ruling where
the report left a design choice open; the spec wins over anything here that contradicts it.

O1 (Critical, defect 1). A fleet cannot be handed to a freshly added machine: `host add` provisions the
far private fleet with its own id and `host enable` never gives the far machine a copy of the fleet it
enables, so the first handover dies at connection.ts:101 ("answered with fleetId X, not Y"), retried 3×,
`safe: []`.
Ruling: `host enable` provisions the far copy of each fleet it enables (spec Add Machine flow steps 5
and 10: per-fleet `archipelago-archid@<fleet>` units, initial authority record). The far fleet lives
under the same profile the controller addresses (`remoteConnectionInfo(…, { profile })`). Three cases:
- the far profile home is absent: create it with the local fleet's id and `gatewayMachineId`, start its
  unit;
- it exists with the same id: nothing to do (idempotent);
- it exists with another id: re-key it only when it is pristine as `host add` left it (no characters,
  no journal, no transaction, no owner record naming a generation above 0). Re-keying writes the fleet
  id and `gatewayMachineId`, removes `owner.json` so the gateway names the owner (the existing ruling:
  a gated fleet with no owner.json owns nothing until the gateway names it), and restarts the unit —
  what D1–D3 in the report did by hand, done by the companion over the master, argv only. Otherwise
  refuse, naming the far home and why.
Also: a connection-info fleet-id mismatch is not transient. Stop retrying it, and let the handover's
blocked/interrupted result name `archi host enable <machine>` as the next step.
Test: enable against a fresh far home, then a same-id one, a pristine other-id one and a used other-id one.

O2 (Critical, defect 2). `rsync -rlpt` itemizes `.L...p.....` for every symlink moving Mac → Linux (the
Mac link is 0755, a Linux link is always 0777 and cannot be chmodded). `compare()` counts it as
instability, and after 3 passes the handover aborts as `external_writer`. Any repo with a committed
symlink cannot move to Linux.
Ruling: permission-only itemizations of symlinks are not changes: in the transfer's stability compare,
and anywhere else an itemized line is read as a difference (verification dry run). Content, target
and type changes on links still count.
Test: a link whose only itemized change is `p`.

O3 (Important, defect 3). `--archive <root>` cannot clear the `destination_occupied` /
`destination_diverged` blocker it is offered for: `destinationChecks` ignores `choices.archiveRoots`
(controller/handover.ts:217-218, 236). The interactive menu's Archive re-runs the same preflight.
Ruling: a root the user chose to archive is no longer a blocker at preflight. It becomes a notice that
it will be archived at claim, and claim still archives it as today.
Test: preflight with the choice clears the blocker; the claim archives the root.

O4 (Important, defect 4). Setup's own mission-control folder (`~/.archipelago/home` on the far machine,
setup.ts:156-161) occupies the carried `home.cwd` root on a fresh destination. Its content is
byte-identical to the source's.
Ruling: a destination root whose content equals the incoming manifest exactly (same paths, types,
sizes and hashes, no extra entries) is not occupied. Claim re-proves the equality against the final
manifest and records it as a replica whose baseline is that content. Only then may `--delete` touch it,
per the delivery rule that `--delete` needs a matching replica record. If it is no longer equal at
claim, claim refuses as occupied, before Commit.
Test: an identical root passes preflight and claim; a root that is identical at preflight but changed
before claim is refused.

O5 (Important, defect 5), with O7 (Minor, defect 7). Under a path root declared through a symlink, the
destination places the carried Claude transcript under the slug of the lexical mapped cwd
(sessions/claude.ts:137), but Claude slugs the real path. After a return trip the resumed agent picks up
a stale pre-handover transcript and silently loses the turns made on the other machine (4 records → 2).
With no older copy, the resume fails outright (60 s SessionStart timeout).
Also, `sessionPathMap` pairs roots lexically (sessions/registry.ts:32-38), so records keep the source's
real-path cwd.
Ruling: place each carried transcript where the agent on the destination will look for it: the slug
of the destination cwd's real path, computed on the destination after the roots land. Map path fields
under both the declared and the real spelling of each root. An older transcript of the same session
already at the target is superseded only when it is a prefix of the carried one. Otherwise it blocks
before Commit as divergence. Apply the same to Codex wherever it keys by cwd.
Test: a root declared through a symlink, carried there and back, resumes the carried transcript with
every turn.

O6 (Important, defect 6). A registered worktree that no character uses breaks on its own machine after a
round trip. On return, the transfer's `--delete` removes its `.git/worktrees/<name>` (the returning
`.git` never had it), and git-repair.ts:77-81 prunes every registration the manifest does not carry.
`git status` there fails "not a git repository", and its per-worktree HEAD and index are gone. This
breaks the spec's "never silently deletes destination-only work".
Ruling: a worktree that stays on a machine keeps its registration there. The transfer protects
`.git/worktrees/<name>/` of every uncarried worktree whose path exists on the destination. Git repair
keeps those registrations instead of pruning them. If the returning object store no longer holds the
commit a kept worktree's HEAD names, that is a preflight blocker naming the worktree, never a silent
loss.
Test: an unused registered worktree survives Mac → Linux → Mac with `git -C <wt> status` clean.

O8 (Minor, defect 8). The Mac's `core.ignorecase=true` and `core.precomposeunicode=true` travel
unchanged to Linux's case-sensitive filesystem.
Ruling: git import sets both to what `git init` would probe on the destination filesystem (the root
probe already knows whether the destination is case-insensitive). Other config stays byte-exact.

O9 (Minor, defect 9). A handover aborted during Transfer leaves `handover/sessions-<tx>` on the
destination (destination.ts:516-518: abort without a destination journal returns `{}`).
Ruling: `handover.abort` on the destination removes that transaction's session stage even when no
destination journal exists. It removes nothing else.

O10 (Minor, defect 10). `host doctor` reports claude "not found on PATH" because it asks the non-login
ssh shell, while the daemon finds claude in `~/.local/bin`.
Ruling: doctor checks agents with the resolved PATH the units run under (or asks the daemon's
system.info), so it matches what the daemon sees.

O11 (Minor, defect 11). `host list` still shows `gateway: no` after `host enable` (host.ts:355 writes
false, and enableHost never sets it).
Ruling: enableHost sets it. Test it.

Not a defect — Ruling: step 7's "controller on the gateway machine" is not a supported configuration.
The spec's Roles section puts the controller on the Mac ("does not require the Linux machine to SSH back
into the Mac"). The carried Task 27 item is closed by `archi handover local` from the Mac, which Part A
passed.

Verification: a failing test first for each item. Covering suites while iterating. At the end, run
typecheck and the archid, cli and protocol full suites once. Run web/Playwright/swift only if you
touch them. Known load flakes (rerun them alone; they are not findings): archid fleet.test.ts revive
tests and "marks the agent working", e2e "two turns against a fake claude", processes.test.ts real-ps
case, source.test.ts FIFO timer; cli cli.test.ts browser, ssh.test.ts spawn-count.
