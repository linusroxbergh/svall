# Task 7 — Both terminals survive as resumable character state

## What was implemented

**Protocol (schema v7)**

- `TerminalSlot` in `state.ts`: `{ cwd, tmux?, agent?, unread, revive? }`; `Second = TerminalSlot`.
  `Character` keeps its flat primary fields, which already have that shape, so one helper takes either.
- `FleetState.version` is `z.literal(7)`; `emptyState()` writes 7.
- `migrate.ts`: frozen `SecondV6` / `CharacterV6` / `FleetStateV6`, and `liftV7` which gives an existing
  second the character's `cwd` (the second pane's cwd was never captured) and keeps `tmux`/`agent`/`unread`.
  An absent second stays absent. `CharacterV5` now derives from `CharacterV6` so the v5 lift still produces
  a v6 character. `NewerStateVersion` and the `> 6` / `=== 6` checks moved to 7.

**archid**

- `reviveCommand` takes a `TerminalSlot`; new `markSlotDormant` (drops `tmux`, sets `revive.command`) is what
  `markDormant` now uses for the character, and what the second uses too. New `attachSlot` builds the slot a
  live window leaves behind: its pane path as `cwd`, its tmux ids, no `revive`.
- `reconcile()` and `Fleet.tick()`: a second with a live window takes the window's `cwd` and ids; a second whose
  window is gone goes dormant instead of being deleted. The `hadSecond` guard still protects a second opened
  during the await.
- Control-client `window-close` for a second window marks it dormant rather than deleting the record.
- `closeCharacter` kills the second's window only when it has one.
- `openSecond` revives a dormant second: a new `<id>-2` window at `second.cwd`, `revive.command` typed through
  `tmux.sendLine` (never a shell string), agent status reset to idle, same in-flight guard as before.
- `terminal(id, 2)` throws `Dormant` ("the second terminal of <id> is dormant; revive it first") — so
  `char.run`, `char.read` and `term.attach` with `--term 2` report dormancy the way the main terminal does.
  `waitFor(..., 2)` already answered `'gone'` for a slot without tmux.
- No new RPC to forget a dormant second: no existing API deletes one deliberately (`char.second` opens,
  `closeCharacter` takes the whole character).

**CLI / web**

- `archi` status: `sessionState` takes a `TerminalSlot`, so a dormant second prints `dormant` (`shell +dormant`).
- `selectors.slotStatus(c, 2)` returns `'dormant'` for `c.second && !c.second.tmux`; `isDormant` takes any slot.
- `terminals.ts` `live()`, `CharPanes` (splitting asks `char.second` for a dormant second too) and
  `TerminalArea` (`Revive` button firing `char.second`; "Starting the terminal…" only while there is no record)
  read `second.tmux`.
- `store.ts` `pruneIde` needed no change — a dormant second keeps its record, so its pane stays; the comment
  now says so, and a test pins it.
- `e2e/split.spec.ts` updated to the new behaviour (pane and token pips stay after the second's shell exits).
  Playwright was not run.

## TDD evidence

RED — tests written first, implementation untouched:

    $ pnpm vitest run --project protocol
     Test Files  2 failed | 6 passed (8)
          Tests  11 failed | 68 passed (79)
     FAIL test/state.test.ts > keeps both terminals of an imported state that carries no tmux ids
       ZodError: path ["second","tmux"] Required
     FAIL test/migrate.test.ts > gives a version 6 second terminal a cwd of its own, and leaves an absent one absent
     FAIL test/migrate.test.ts > refuses a file newer than the version it reads
     (+ the version 7 assertions in the v1/v2/v4/v5 migrations)

    $ pnpm vitest run --project archid -t second
          Tests  6 failed | 10 passed | 549 skipped (565)
     FAIL test/reconcile.test.ts > a second terminal whose window is gone stays as a dormant record with its revive command
       AssertionError: expected undefined to deeply equal { cwd: '/side', unread: true, …(2) }
     FAIL test/reconcile.test.ts > a live second terminal takes its pane cwd and loses the command that revived it
       AssertionError: expected { unread: true, cwd: '/old', …(2) } to deeply equal { cwd: '/repo', tmux: { …(2) }, …(1) }
     FAIL test/fleet.test.ts > opens one second terminal … leaves a dormant record when its shell ends
       AssertionError: expected undefined to be defined
     FAIL test/fleet.test.ts > types into, reads and waits on the second terminal when a call names it
       AssertionError: expected error to be instance of Dormant
     FAIL test/fleet.test.ts > revives a dormant second terminal in its own cwd, typing the command that brings its session back

    $ pnpm vitest run --project @archipelago/desktop-web
          Tests  2 failed | 317 passed (319)
     FAIL test/selectors.test.ts > reads a second terminal without a window as dormant, as it does the main one
     FAIL test/terminals.test.ts > shows a second terminal under its own key, attached by term, and closes it when it goes dormant

GREEN — after the implementation:

    $ pnpm vitest run --project protocol --project archid
     Test Files  57 passed (57)
          Tests  644 passed (644)

    $ pnpm vitest run --project cli
     Test Files  14 passed (14)
          Tests  84 passed (84)

    $ pnpm vitest run --project @archipelago/desktop-web
     Test Files  29 passed (29)
          Tests  319 passed (319)

    $ pnpm typecheck
     tsc --noEmit -p tsconfig.json && tsc --noEmit -p apps/desktop/web/tsconfig.json   (clean)

## Tests added or changed

- `protocol/test/state.test.ts`: a v7 character and its second both without tmux, both carrying `revive.command`,
  parse and keep both sessions (ruling 7). Version assertions moved to 7.
- `protocol/test/migrate.test.ts`: v6→v7 gives the second the character's cwd and leaves an absent one absent;
  a version 8 file is refused with the "(7)" message; the older migrations now land on 7.
- `protocol/test/messages.test.ts`: `Second` accepts a live and a dormant slot.
- `archid/test/reconcile.test.ts`: a live second takes its pane cwd and drops its revive command; a second whose
  window is gone keeps its cwd, agent and unread and gains `revive.command`.
- `archid/test/fleet.test.ts` (real tmux): exiting the second's shell leaves a dormant record; `run`/`readScreen`
  with `--term 2` on it throw `Dormant`; `openSecond` reopens the window at `second.cwd` and types its revive
  command (asserted through the pane's screen and the window's path).
- `archid/test/store.test.ts`, `api.test.ts`, `push.test.ts`: version and fixture updates.
- `cli/test/char.test.ts`: `shell +dormant` for a dormant second.
- web `selectors.test.ts` (dormant slot status), `store.test.ts` (the pane stays while the second is dormant),
  `terminals.test.ts` (a dormant second's surface is closed), `fixtures.ts` (version 7).

## Files changed

    packages/protocol/src/state.ts, migrate.ts
    packages/protocol/test/state.test.ts, migrate.test.ts, messages.test.ts
    packages/archid/src/reconcile.ts, fleet.ts
    packages/archid/test/reconcile.test.ts, fleet.test.ts, store.test.ts, api.test.ts, push.test.ts
    packages/cli/src/commands/char.ts, packages/cli/test/char.test.ts
    apps/desktop/web/src/selectors.ts, terminals.ts, CharPanes.tsx, TerminalArea.tsx, store.ts
    apps/desktop/web/test/fixtures.ts, selectors.test.ts, store.test.ts, terminals.test.ts
    apps/desktop/web/e2e/split.spec.ts

## Self-review

- Every call site that read `second.tmux` was visited: archid `reconcile`, `tick`, `window-close`,
  `closeCharacter`, `terminal`, `openSecond`, `waitFor`; web `selectors`, `terminals`, `CharPanes`,
  `TerminalArea`, `store`; CLI `stateOf`/`contextOf`; `push/pusher.ts` reads only `second.agent`, so a dormant
  second keeps its session entry with an unchanged status and sends nothing new. `apps/desktop/web/src/mobile`
  never reads `second` (it only shows the character's own `tmux`), so no mobile work was needed.
- `markDormant`/`markSlotDormant`/`attachSlot` keep one definition of what dormancy and re-attachment mean,
  rather than repeating the spread in three places.
- `PROTOCOL_VERSION` untouched (ruling 8).

## Concerns

- A second terminal can no longer be got rid of: exiting its shell leaves a dormant record and the pane offers
  Revive. That follows the spec and ruling 4 (no new RPC invented), but it is a visible change to the local
  experience, and there is now no way to forget one short of deleting the character.
- `openSecond` types `revive.command` as it is. The main terminal's revive runs it through `withAddDirs` to add
  island/character context folders; I left that out of the side shell to keep the change minimal. Easy to add
  if the handover wants the second's resumed agent to carry the same context roots.
- The fleet tests that exercise the revive path need a real tmux binary (`runIf(hasTmux())`); they ran here.
- Playwright was not run; `e2e/split.spec.ts` was updated by reading, not by executing.

---

# Fix report — coordinator rulings A and B

## What changed

**Ruling A — only an agent's second survives its window**

- `reconcile.ts` gains `loseSecond(c)`: a second with an agent goes dormant (`markSlotDormant`), a plain side
  shell is deleted, exactly as before this task. `reconcile()`, `Fleet.tick()` and the control client's
  `window-close` path all go through it, so the explicit-close paths follow the same rule.
- All three call sites are gated on `c.second?.tmux`, so a second that arrived already dormant — what the
  handover's rest step will produce — is left untouched by reconciliation rather than being deleted for having
  no agent. Ruling 7's protocol test (both slots without tmux, both with `revive.command`) is unchanged.
- Web: nothing to change. A deleted record closes the pane through `pruneIde` as it used to; a dormant one
  keeps it, which the store test already pins.

**Ruling B — the second's revive carries the context folders**

- `openSecond` now types `withAddDirs(second.revive.command, [...island.context, ...character.context])`,
  the same expression `reviveCharacter` uses. A non-agent command is returned untouched by `withAddDirs`,
  so a plain shell revive is unaffected.

**Test fixture**

- `packages/archid/test/fixtures/fake-claude.mjs` now sends `term` from `ARCHI_TERM`, as the real
  `agent-hook.mjs` does. Without it a fake agent started in a second terminal reported against the main slot,
  so the e2e agent case could not be expressed. Main-terminal uses are unaffected (`term` stays undefined).

## Tests

- `archid/test/reconcile.test.ts`: a plain second whose window is gone is dropped; a second that ran an agent
  stays dormant with its revive command; a second that came in already dormant is left as it is.
- `archid/test/fleet.test.ts`: the original "ends it with its shell or with the character" expectation restored
  (the plain second disappears); the revive test now gives the second an agent first, asserts the dormant
  record's `revive.command` is `claude --resume <id>`, and asserts through a `vi.spyOn(tmux, 'sendLine')` that
  the reopened pane is typed `claude --resume <id> --add-dir '/tmp'` — the island's context folder, ruling B.
- web `terminals.test.ts`: title now says "closes it when its window goes" (the same `live()` check covers a
  dropped and a dormant second).
- `e2e/split.spec.ts`: the plain-shell case is back to the original expectation (pane and pips go); a new case
  runs FAKE_CLAUDE in the second terminal, kills its window, and expects the right pane to offer Revive, the
  token pips to stay, and the click to bring the surface back.

## Commands and output

    $ pnpm vitest run --project protocol --project archid
     Test Files  57 passed (57)
          Tests  646 passed (646)

    $ pnpm vitest run --project cli
     Test Files  14 passed (14)
          Tests  84 passed (84)

    $ pnpm vitest run --project @archipelago/desktop-web
     Test Files  29 passed (29)
          Tests  319 passed (319)

    $ pnpm typecheck
     tsc --noEmit -p tsconfig.json && tsc --noEmit -p apps/desktop/web/tsconfig.json   (clean)

    $ pnpm --filter @archipelago/desktop-web exec playwright test e2e/split.spec.ts
     Running 4 tests using 1 worker
       ✓  1 e2e/split.spec.ts:15:1 › a card opens on one pane, splits in two, and each side closes on its own (859ms)
       ✓  2 e2e/split.spec.ts:37:1 › a split starts the second terminal, and it shows on the token and ends with its shell (637ms)
       ✓  3 e2e/split.spec.ts:52:1 › a second terminal that ran an agent stays dormant when its window goes, and revives (847ms)
       ✓  4 e2e/split.spec.ts:70:1 › the board shows the same panes as the card (526ms)
       4 passed (4.0s)

    $ pnpm --filter @archipelago/desktop-web exec playwright test        (whole suite, since fake-claude.mjs is shared)
       91 passed, 1 failed (1.1m)
       ✘ e2e/card.spec.ts:122 › the half card keeps the size it was dragged to, for the next character too
         expect(card.width).toBeGreaterThan(before.width + 100) — received 511
    $ pnpm --filter @archipelago/desktop-web exec playwright test e2e/card.spec.ts
       4 passed (4.6s)

  That one failure is a drag-resize flake in the card spec: it has no second terminal, no agent and no state
  schema in it, and it passes on its own. No fake-claude or terminal spec failed.

## Concerns after the fix

- The earlier concern about a second terminal that can never be forgotten is resolved by ruling A.
- `markSlotDormant` is now used only inside `reconcile.ts`, but stays exported: it is what the handover rest
  step will call to mark both slots dormant before export.
