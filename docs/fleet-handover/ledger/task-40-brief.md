# Task 40a — rebase experimental-remote-sessions onto origin/main

Plan: `docs/fleet-handover/plan.md` Task 40. Spec (`docs/fleet-handover/spec.md`) is binding. Delivery rules:
`docs/fleet-handover/ledger/review-constraints.md`. The last rebase's report, which shows how every earlier
conflict was resolved and why, is `docs/fleet-handover/ledger/rebase-report.md` — read it first.

## Where

Worktree `/Users/linusroxbergh/linus_laboratory/archipelago/.claude/worktrees/fleet-handover-impl`, branch
`experimental-remote-sessions` at 809d5b4e: four commits on 45856c9b (43d2a586 the feature, then three docs
commits). `origin/main` is 615da858, 20 commits ahead (#2–#17: bundle ids moved to io.github.linusroxbergh,
agent profiles, dormant after idle and quiet dormant, agent status fixes, release-audit fixes, GhosttyKit
prebuilt, card grounding, web/native fixes). About 44 files conflict, mostly in 43d2a586.

## Do

1. `git rebase origin/main`, keeping the four commits. Resolve conflicts inside 43d2a586 by keeping both sides'
   behaviour, as the last rebase did. Semantic ports that no textual conflict forces (tests or behaviour that
   break on main's new code) go in one follow-up commit on top, subject
   `The fleet handover branch runs on current main`, placed after 43d2a586 or at the tip — your call.
2. `PROTOCOL_VERSION` goes one above main's (main is 14, so 15). The branch's state schema stays one above
   main's (main is still 7; the branch is 8) with main's migration framework. `handover.enabled` stays off by
   default.
3. Check these integrations, which no conflict marker will show you:
   - every RPC method main added (profiles, dormant wake/revive, idle close, phone revive, status fixes) is
     classified in the ownership guard (`guard.ts`); a fenced (non-owner or frozen) daemon must not wake,
     revive, idle-close or otherwise mutate. The fence test that enumerates handlers must pass for the right
     reason, not because a method was left unclassified;
   - main's idle close / dormant-after-idle and the branch's rest/activation (restedBy, resumeError, carried
     terminals, `markSlotDormant`): an idle-closed character must travel as dormant with its transcript and
     wake on the destination only after Commit; the idle timer must not close or wake terminals on a fenced
     side or mid-handover;
   - main's "fleet secrets out of Files" (#4): the branch split config.json into fleet.json + node.json and adds
     owner.json, machine.json, journals and a registry. Every file carrying a token or secret must be as hidden
     as config.json was;
   - main's bundle-id move (#11): every id, label or path the branch names (LaunchAgent labels, app bundle id,
     keychain/defaults names, build and install scripts, Swift) follows main's new ids; Linux systemd unit names
     keep what the branch shipped unless main's change implies otherwise;
   - main's agent profiles: anything they add to state or to the fleet home must still pass the branch's
     path-field and inventory classification tests (Task 42 widens that test later; here, only keep it green
     for the right reason);
   - main's native quit guard / crash recovery (#6) and the branch's rule that quitting the app during a
     handover detaches but never signals abort.
4. Fix the two stale fixtures the squash review found (a test fixture still saying stateSchema 7 or
   protocol 10) if they still exist.

## Verify

Every shell: `unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"; unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`
(the node shell function is broken, and character shells point at the live fleet). Run `pnpm install
--frozen-lockfile` first (or `pnpm install` if the lockfile must change; say so). Single test files run as
`pnpm test <path>` from the root, never through `--filter … exec vitest`.

- `pnpm typecheck`
- `pnpm vitest run --project protocol`, `--project archid`, `--project cli`, `--project @archipelago/desktop-web`
- `swift test --package-path apps/desktop/mac`
- `pnpm --filter @archipelago/desktop-web exec playwright test`

Known load flakes (rerun alone, report both results): archid `fleet.test.ts` revive tests, "marks the agent
working", "deactivate timeout"; archid e2e "two turns against a fake claude"; `processes.test.ts` real-ps;
`source.test.ts` FIFO timer; cli `cli.test.ts` browser and `ssh.test.ts` spawn-count; web `e2e/ide.spec.ts:136`,
`e2e/keys.spec.ts:3`, `e2e/card.spec.ts:122`. Any other failure is yours until you show origin/main fails it too:
extract main with `git archive origin/main | tar -x -C <your scratchpad>/main` (no `git worktree add`),
`pnpm install --frozen-lockfile` there, and run the same test.

## Rules

- Do not push. Do not touch `~/.archipelago`, `~/Library`, LaunchAgents, `/Applications`, `~/.ssh`, `~/.claude`,
  `~/.codex`, or linus-vault. Do not rm gitignored build output (`apps/desktop/mac/.build`, the GhosttyKit
  symlink).
- No bare `git stash`. If you must set work aside, make a WIP commit.
- Code comments: only where behaviour is not self-evident, 1–2 lines, describe what the code does now.
- Commit subjects: one plain sentence, repository style, no attribution lines.

## Report

Write `docs/fleet-handover/ledger/task-40-rebase-report.md` (leave it uncommitted), shaped like
`rebase-report.md`: conflicts grouped by area with how each was resolved, the integration checks above with
what you found and changed, schema/protocol, tests ported, the verification table with counts, and an
"Unsure / worth a look" list. End your reply with one status line: DONE, DONE_WITH_CONCERNS, BLOCKED or
NEEDS_CONTEXT, the new commit range, and the verification counts.
