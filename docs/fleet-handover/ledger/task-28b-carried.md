# Task 28b — `archi fleet recover --force-owner` (binding)

Scope: the brief's `fleet recover --force-owner` step only. 28a (the `archi handover` commands) runs in
parallel on fleet-handover-impl: do not touch `packages/cli/src/commands/handover.ts`,
`controller/handover.ts`, `controller/events.ts` or `controller/recovery.ts`. `main.ts` gets one
import and one `addCommand` line (a mechanical conflict at cherry-pick is expected).

Spec: "If the gateway is permanently lost, recovery requires `archi fleet recover --force-owner
<machine>` and presents the generations and risks before writing a new authority; it is never
automatic." "On daemon start, a reachable gateway record always wins." "A force-owner recovery is a
separate, deliberately alarming disaster-recovery command and never part of ordinary retry."

What exists: the gateway has owner.get/create/begin/ready/commit/abort/complete and no forced write.
Daemons never consult the gateway at start — owner.json and the handover journal decide
(`archid/src/handover/startup.ts`); a corrupt owner.json on a gated fleet stays read-only "until
recovery" (ledger, Task 11), and that recovery is this task.

1. Gateway: a forced write reachable only through the gateway's authority channel (its Unix socket, or
   `archi gateway owner` over ssh) — never a daemon RPC, never the phone. It compares-and-swaps against
   the record it holds (or its absence, for a replacement gateway), sets the chosen owner at a
   generation strictly above every generation the controller observed, clears any transaction, and
   appends an audit record at the gateway (mode 0600: time, before, after, requesting machine, reason,
   the generations shown to the user).
2. `archi fleet recover --force-owner <machine|local>`: shows the gateway record (or that it is absent,
   corrupt or unreachable), and for every registered machine of the fleet its cached owner and
   generation, frozen/surrendered state and open journal, naming unreachable machines as unreachable;
   the controller's own journal too. Explains the risk in plain words (a machine that still runs the
   fleet unseen will be fenced when it next consults the gateway; work since the last handover on a
   machine that loses the fleet stays on that machine's disk only). Requires the fleet id typed exactly
   (interactive), or `--confirm <fleet id>` (non-interactive; otherwise refuse). Writes a local audit
   record beside the controller journal too.
3. The gateway permanently lost: a replacement gateway, a machine already in the registry, takes the
   forced record (it must hold none for this fleet) and becomes the fleet's `gatewayMachineId` on every
   reachable machine. Choose the smallest flag surface that does this and print the exact steps.
4. Taking effect without a split brain: a daemon adopts a gateway record whose generation is above its
   own — at start when the gateway answers (bounded, best effort; unreachable keeps today's behaviour),
   and on demand through a token-only, non-phone RPC `fleet recover` calls on every reachable machine.
   Naming this machine: owner, unfrozen. Naming another: read-only replica. An open journal whose
   transaction the record supersedes is never activated (a destination discards its prepared state); a
   source whose superseded transaction rested terminals revives only those when the record names it.
   Never both machines running. A corrupt owner.json on a gated fleet heals the same way. New methods
   and codes stay within the branch's single protocol bump.
5. Tests: generations shown include the unreachable machine's last known one (controller journal/route
   cache); wrong or missing confirmation writes nothing; non-interactive without `--confirm` refuses;
   the CAS refuses a record that changed underneath; both audit records written; gateway unreachable →
   refuse with the replacement-gateway step; archid: adopt at start and on demand for each case in 4,
   lower/equal generation ignored, a forced record never lets a superseded destination activate.
