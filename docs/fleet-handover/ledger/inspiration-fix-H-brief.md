# Fixer H — host add: identity on a repeat add, and the auth hint

Worktree `/Users/linusroxbergh/linus_laboratory/svall/.claude/worktrees/fix2-readd-check`, branch
`fix2-readd-check`. Read `ledger/inspiration-fix-common.md` first.

Exclusive files: `packages/cli/src/controller/host.ts`, `packages/cli/src/commands/host.ts`,
`packages/cli/test/host.test.ts` (and other cli host tests if needed), `docs/remote-machines/errors.md`,
`docs/remote-machines/setup.md`, and only row 28 ("An alias that now reaches another machine") of
`docs/security/fleet-handover.md`. Don't edit anything else in the security doc.

## H1. A repeat `host add` checks the machine before installing (confirmed and reproduced)

`claimName` (`controller/host.ts:313-322`) allows re-adding a name with the same ssh destination
(setup.md:98, spec.md:352 call repeated setup idempotent). But `addHost` uploads (`:384`) and installs
(`:388`) before reading any machine id (`:397-403`), never compares it with `held.id`, then does
`if (held) d.registry.remove(held.id)` and adds the new id (`:413-414`). Upgrade (`:507-510`), remove
(`:657`) and enable (`:772`) all check with `sameMachine` first.

Failure: fleet `lab` lives on box A, its gateway. The alias `trift` now reaches box B (same home path).
Re-running `host add trift` installs on B, replaces A's registry entry, and from then on
`resolveOwner` (`connection.ts:283`) / `connectHandover` (`reach.ts:168`) throw "names gateway A, which
is not a machine in the registry"; `host enable trift --fleet lab` would no longer refuse (`:756-757`).
A verifier reproduced the registry swap in a scratch test:
`/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-svall/1fea589a-48ef-40a2-91ea-c4396c770512/scratchpad/verify-ab/readd.test.ts`
(read it; reuse its setup in the real test file).

Fix:
- When `held` exists, check the opened master with the existing `sameMachine` before upload (as Upgrade
  does), so a B that already runs svall stops before anything is installed.
- In the `identity` step, when `held` exists and the id read differs from `held.id`, stop with a
  StepError whose action names the way out (point the ssh destination back at that machine, or
  `svall host remove <name> --forget` and add again). This catches a fresh B, where the early check
  can't read an id.
- Keep the held entry's gateway flag on a same-machine re-add (`:409` resets it to false today).
- Tests: a re-add whose far end answers as another machine installs nothing and keeps the registry
  entry; a fresh far end (no svall) stops at identity and keeps the entry; a same-machine re-add keeps
  `gateway: true`.
- Docs: add `host add` (run again for a registered name) to security row 28's list beside upgrade,
  remove and enable, with its test names in that row's test column; update the errors.md
  `master`/`identity` step rows so they cover a repeat add.

## H2. An auth refusal at the `master` step says what to do

`commands/host.ts:30` runs one interactive `ssh -- dest true` (askpass in the app), then
`controller/host.ts:336-342` opens a separate BatchMode master. A user who logged in with a password, or
answered a key passphrase that isn't kept in the agent, passes the first step and fails the second with
`✗ master  ssh could not reach ada@studio: … Permission denied (publickey,password). -> ssh ada@studio and see what it answers`
— "could not reach" is wrong and the action repeats the command that just worked. Everything after
setup requires prompt-free key auth anyway (spec.md:258, :583; errors.md:68 `ssh_interactive`, :240).

Fix:
- When the master fails with `SshError` kind `auth`, give a detail that says ssh refused the login and
  an action like: install a key (`ssh-copy-id <dest>`) and keep its passphrase in the agent
  (`ssh-add --apple-use-keychain`), then add the machine again. Keep other kinds as they are.
- Test it (RED first).
- Docs: one clause in setup.md (the Network/SSH prerequisite and step 1) and in the errors.md `master`
  row: Svall needs a key ssh can use without asking; a password only gets past the first step.
