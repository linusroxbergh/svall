# Task 28a — obligations carried from earlier reviews (binding)

Scope: every step of task-28-brief.md except `fleet recover --force-owner` (that is 28b, running in
parallel on another branch: do not touch `packages/archid`, `commands/fleet-recover.ts`,
`controller/authority.ts` or the gateway). The helper's app-facing surface is fixed by
task-28-29-contract.md; build it exactly.

Commands
1. The contract's command set, output, detached helper, events file, control socket, `attach` and exit
   codes. Task 29 builds the app against it in parallel.
2. `local` is the invoking machine's stable id; a handover to the machine that owns the fleet (by the
   gateway's record) is refused before any other work. A fleet with no gateway is refused before
   anything with the command that gives it one (`archi host enable <host> --fleet <profile>`).
3. Blockers print before Begin, each with what it names resolved for a human: character name (not only
   id), path, file (Task 22: an unknown file kind in a Claude session folder names the file). Warnings
   (`config_difference`, `codex_trust`, `platform_heuristic`) print too and do not stop the run.
   Non-interactive (no TTY, or `--json`, and not a detached helper) never prompts: blockers exit 1.

Choices (Task 24, 27)
4. Rest choices are read once per Freeze call. Interactive "Interrupt and carry" while Freeze still
   waits is `Handover.choose()`; an answer to a `handover.blocked` decision is `decide`'s return. The
   prompt names the exact characters and paths each choice affects and what it does: Continue waiting,
   Interrupt and carry (Escape, then the hook or process tree must confirm rest), Terminate and carry
   (kills the foreground process; the shell reopens in its directory), archive (the destination root
   is moved to a timestamped sibling first), Cancel.
5. `--terminate-shells` help text says it also terminates an interrupted agent that will not settle,
   and that a Claude agent with a background command still running counts as not settled.
6. The daemons' rest and activation events reach the stream (contract: relay `handover.changed` and
   `handover.entity` as they arrive — the controller's daemon clients do not forward them today).

Cancel and recovery (Task 27)
7. Ctrl-C (and a control `cancel`) is `Handover.cancel()`: before Freeze a clean stop, after Freeze a
   safe abort, after Commit the move goes on. Print what happened and the next command
   (`archi handover status`, `--resume`, `--abort`). After Commit the foreground run keeps going until
   the move finishes; a second Ctrl-C exits and names `archi handover --resume`.
8. A superseded controller journal has no exit today (resume/abort loop until handover.json is
   deleted by hand). `status` names it; `--resume` and `--abort` on it name `--forget`; `--forget`
   removes only this controller's journal and its per-transaction files, only when `assess` says
   `superseded` (or finds no transaction the journal could still drive), and never a daemon journal
   or the gateway record.

Supported paths (M2)
9. F12: `archi host remove` refuses a gateway whose fleet another machine owns with the action
   "disable handover…", which has no command. Its action names the real next step: `archi handover
   local` (with `-p <profile>` for a named fleet), then `archi host remove <name>`.
10. I5 / H1–H4: a Linux-owned fleet must be reachable from the Mac through supported commands, not hand
    steps. After `archi handover <host>` completes, `archi status`, `archi char list` and `archi
    connect --json` on the Mac reach the new owner (Task 17's owner resolution through the gateway,
    Task 27's `moved` route cache). Prove it with a test at the command level.

Keep on this machine (Task 25)
11. `archi char update <id> --keep-here` / `--no-keep-here` sets `keepHere` through `char.update`
    (the protocol field exists). `archi char list`/show marks a kept character.

Not 28a's: the upgrade rollback checklist order (web, Task 29); everything marked "→ M3 fix wave".
