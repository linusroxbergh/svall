### Task 16b: Gateway CLI wrappers and `host enable` authority creation (follow-up to Task 16)

**Depends on:** Tasks 15, 16 (both landed on fleet-handover-impl at 8f75910)

**From the plan's Task 16 steps still open:**

- [ ] Expose the authority through a mode-0600 local Unix socket and an `archi gateway owner` SSH
  command. Do not bind it to the tailnet.
- [ ] Finish `host enable` by creating the absent generation-zero authority record with the invoking
  Mac as owner; treat an existing record as idempotent only when fleet and owner ids match.

**What already exists (Task 16, packages/archid/src/gateway/):** `authority.ts` (`transition()`,
`FleetAuthority` with `owner.create/get/begin/ready/commit/abort/complete`, durable 0600 records at
`<prefix>/gateway/fleets/<fleetId>.json`, restart-surviving `.quarantined` marker), `server.ts`
(`startAuthorityServer`, JSON-lines over `<prefix>/gateway/authority.sock`), `client.ts`
(`AuthorityClient`), `bin.ts` (`gatewayPrefix`, `startGatewayFromEnv`, `main()` — not wired to any
command yet). Package exports `@archipelago/archid/gateway/{authority,server,client,bin}`.

**What this task adds:**

1. `archi gateway serve` — the command the Linux systemd unit already renders as ExecStart
   (`packages/archid/src/linux/setup.ts:67` → `archiProgram(o, 'gateway', 'serve')`). It runs
   `main()` from `gateway/bin.ts`; a `close()` rejection must exit non-zero, not hang.
2. `archi gateway owner <op> --fleet <fleetId> [--json …]` — a thin wrapper the controller invokes
   over SSH (`master.run(['archi','gateway','owner', …])` with every value `shellQuote`d). It connects
   to the local Unix socket with `AuthorityClient`, forwards exactly one op (`get`, `create`, and the
   transaction ops so later tasks can reuse it), prints the `{ result }` or `{ error: { code, message } }`
   frame as one JSON line on stdout, exits 0 on result and non-zero on error. It never opens a TCP
   port. Params come from flags or a single `--params <json>` (your call — pick one, keep it small).
3. `host enable <name> --fleet <profile>` finishes: after the `machine` step and BEFORE writing
   `gatewayMachineId` into fleet.json, the `authority` step opens the master to the machine and runs
   `archi gateway owner get`; if `not_found` it runs `create` with `ownerMachineId` = the Mac's own
   machine id (`packages/archid/src/machine.ts`) and the fleet's id from fleet.json; an existing
   record is `ok` (idempotent) only when its fleetId and ownerMachineId match, otherwise the step
   fails with a message naming the current owner and generation and fleet.json is NOT touched.
   `authority_corrupt` fails the step with the repair action. The `fleet` step (gatewayMachineId
   write) runs only after `authority` succeeded. Keep the NDJSON step shape from Task 15.
4. Test-only fix carried from Task 14: `packages/cli/test/controller/ssh.test.ts`'s real-sshd case
   sits under the `SshMaster` describe whose `beforeEach` installs the fake ssh, so with
   `ARCHI_TEST_SSH` set it talks to the fake and fails on empty stdout. Strip the fake's bin dir from
   PATH for that case exactly as `packages/cli/test/host.test.ts`'s sshd case does.

**Tests:** cli unit tests through the fake ssh for `host enable` (create path, idempotent path,
different-owner refusal, corrupt path, unreachable → fleet.json untouched); a cli test for
`gateway owner` against a real `startAuthorityServer` on a temp prefix (real socket, real
records); `gateway serve` stop path. TDD for every behavior change.

**Verify:** `pnpm vitest run --project cli --project archid`, `pnpm typecheck`.

**Commit:** `The gateway answers ownership over SSH and host enable seeds the first record`
