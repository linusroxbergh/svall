# Final review fix wave — Fixer C1 (app, scripts, CI)

You own `apps/desktop/**` (mac and web) and `scripts/**` and `.github/**`. Fixer A works at the same time in
`packages/archid/**` and `packages/protocol/**`; don't touch those or `packages/cli/**` (Fixer B, after you). In
`apps/desktop/web/src/handover.ts` leave the event type declarations alone (Fixer B switches them to imports later);
runtime guards there are yours.

Each item's claim and evidence: `final-review-candidates.md` (by id) and `final-review-validation.md` (validator and
Gemini verdicts). Test first for every behaviour change; one commit per item where practical.

## Medium

- **C11 (web part)** — `applyEvent` must not throw on a line missing the fields it reads (a replayed older
  events.ndjson, a new field shape): skip or tolerate it, and add a contract test pinning the fields the sheet reads.
- **C12** after a host enable or remove run ends, re-send `shell.info` (gateway read fresh) so the sheet follows
  fleet.json without a reload.
- **C13** a helper that exits or errors before its first `online`, for a fleet whose fleet.json names no gateway, falls
  back to `.local` as a helper that cannot start already does.
- **C14** Settings → Fleet config while the fleet runs elsewhere gets the same "… is on <machine>; open it there" notice
  as openFolder/reveal.
- **C15** a remote terminal surface must not dial the real destination when the helper's master is gone (Gemini's
  suggestion: check the control socket exists; add `-o BatchMode=yes`). Constraint: surfaces past sshd's MaxSessions
  (10) were observed on the machines to print "Session open refused by peer" and ride their own login (ledger M2 ruling,
  line 275); keep terminals 11+ working, or refuse them with a clear message — say which, and why, in the report.
- **C16** `install-release.mjs` — a same-version reinstall keeps a real rollback target (don't return the path it just
  replaced), and `host upgrade`'s rollback message tells the truth.
- **C17** prune installed releases after `current` moves: keep the new one and the one `current` named before.
- **C18** one archive staging/verification function in `install-release.mjs` (name check, SUMS+SIG extraction,
  signature check before the rest is unpacked, member checks, full unpack, `verifyRelease` without a second signature
  check) — Fixer B will switch `packages/cli/src/controller/install.ts` `inspectCompanion` to it; export it and say so
  in your report. Keep every refusal the current two copies have (see `docs/security/fleet-handover.md` and the GNU tar
  test in cli `host.test.ts`).
- **C31** one Swift NDJSON child wrapper (LineChild's DispatchGroup join) for ControllerProcess, HostProcess and the
  handover child, with one bounded stop (fixes **L26** and **L27**; share the `matches` helper and name regex, **L33**).
- **L22** a `term.attach` answered after the freeze began doesn't show the surface. **L23** a `frozen` refusal retries like
  `not_owner` (also when the fleet unfreezes).
- **L28** (nit) pass `--interrupt-after <ms>ms` unchanged.
- **L32 / I11** drop `agentAdapters` from `release.json`.
- **L35** a `swift test` step in CI (after fetching GhosttyKit) and in the README's development notes.
- **L36** pin each platform's Node tarball sha256 in `pins.json` and check against it; keep the built rsync out of the
  cache or check its digest.
- **I12** move the M0 spike probes (`scripts/probe-*-handover.mjs`, `probe-claude-hook.mjs` and their `.d.mts`) under
  `scripts/spikes/` marked manual, and keep their tests passing (update imports).

## Verify

`pnpm typecheck`; `pnpm vitest run --project @archipelago/desktop-web --project scripts`; `pnpm --filter
@archipelago/desktop-web exec playwright test`; `swift test --package-path apps/desktop/mac`; `actionlint` on the
workflows; `shellcheck` on changed scripts. Known load flakes: `docs/fleet-handover/README.md`. Every shell:
`unset -f node npm npx pnpm _load_nvm nvm 2>/dev/null; export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"; unset ARCHI_HOME ARCHI_CHAR_ID TMUX TMUX_PANE`.
