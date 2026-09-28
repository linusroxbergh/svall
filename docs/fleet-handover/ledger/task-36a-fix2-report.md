# Task 36a fix round 2 — report

Commits `fd6e6d1f..ead06bdd` on `experimental-remote-sessions` (not pushed), on top of `c6763d3a`:

1. `fd6e6d1f` An activation leaves a window named for a dormant terminal to the fleet's reconcile, which the fault suite's fleet runs as the real one does (F1)
2. `ead06bdd` The fault suite finds no path under any home that names a handover once it has settled (F2)

## F1

The fault suite's fake fleet now reconciles as the real one does:

- `reconcileNow` runs the real `reconcile` from `src/reconcile.ts` over the fake tmux's windows, with the carried
  terminals the destination registered. Like the real one, it does nothing while the daemon is not writable.
- `activate` runs it, as the real `Fleet.activate` → `begin` does.

`closeLeft` and its `else if (!held)` branch are gone from `wakeSlot`. What stays of `9680eca4` is the corrected comment
on `carried`: since fix A, the fleet keeps a carried revive when it opens the terminal.

The `destination.activate.kill:before#1` cases stay, and pass in both variants on the real path:

- The first crash comes after c_di's open. The second comes before the kill in `lay`, which had already laid c_di
  dormant while its window lived on.
- The next activation's reconcile, inside `destination.activate.fleet`, takes that window back with the carried revive.
- `wakeSlot` reads it as `shell` with an agent, `lay` kills it at `destination.activate.kill` (the second hit), and
  `destination.activate.open` opens c_di afresh with `claude --effort 'high' --resume <sid>`.

Checks:

- With the reconcile modelled, all 421 cases pass both with and without `closeLeft`.
- Mutation: with `closeLeft` gone and the fake's reconcile made a no-op, `destination.activate.kill:before#1` fails in
  both variants. The model is what carries these cases.

## F2

- `World.record()` collects every transaction id the gateway's record names. It runs at every step of `check()`, so
  it also sees a Begin whose answer never arrived.
- `settledOn` also asserts that no path under the world's base names any of those ids. The base holds `home/`, both
  fleet homes, `gw/` and `ctl/`. The existing checks on `handover/` and `ctl/` stay, since they also catch files that do
  not carry the id.

Check: the review's mutation writes `mac/stage-<tx>.json` inside `source.freeze.manifest` and removes it only in
complete. Against the previous `settledOn`, all 421 cases pass. With F2, 141 fail. The abort probe reports
`mac/stage-<tx>.json`.

## Verification

- `pnpm typecheck`: clean.
- `pnpm test packages/archid/test/handover/faults.test.ts`: 421 passed in about 20 s. Shuffled with seeds 36, 2026 and
  7, and once in order: 421 passed each time.
- `pnpm vitest run --project archid --project cli --project @archipelago/desktop-web`: 181 files passed and 1 skipped;
  3267 tests passed and 5 skipped.

## Concerns

None new. The fake now runs the real `reconcile`, so a later change there reaches the fault world directly.
