# Final review — targeted fix D (host remove's far uninstall)

From `final-fix-B-review.md` (Important) and `final-fix-C2-report.md` (concerns):

- **D1 (Important).** `host remove` runs the far `archi uninstall --force` (packages/cli/src/controller/host.ts:649),
  and `--force` skips every far check (open handovers, fleets the machine runs, fleet records it keeps as a gateway),
  while `host remove` itself checks only this Mac's fleets. A fleet another Mac keeps on that machine is taken down
  without a refusal. Fix: the far uninstall forces only the fleets this controller checked (pass their ids; e.g.
  `archi uninstall --force-fleet <id>…`) and still refuses anything else it finds; `host remove` reports that refusal
  with its reason. Test first on both sides (archid `uninstall.ts`, cli `host.ts`). Update the four places that
  document the current behaviour (spec, `docs/remote-machines/setup.md`, `errors.md`, the security doc's accepted
  risks) to the new one.
- **D2.** `packages/archid/src/setup.ts:469` tells users to run `archi -p <name>-fleet setup` after a reserved-name
  rename, which setup refuses (it sets up only the private fleet); give the command that works.
- **D3.** The "Manual: … no CI runs it" header on `scripts/spikes/probe-*` is wrong — the portability tests import and
  run them; say what is manual (running the probe by hand against real agents) and what the tests cover.
