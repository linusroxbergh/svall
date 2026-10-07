---
description: Fleet handover M0 spikes done on branch fleet-handover-task1; what they proved, what they changed in the spec, and what gates Task 5
---

# Fleet handover handoff

As of 2026-09-21 the M0 spikes (plan Tasks 1–4) are complete on branch `fleet-handover-task1` in
`.claude/worktrees/fleet-handover-task1`, 8 commits ahead of main (4101fde..bbcbe8e), unmerged.
Canonical docs stay gitignored in the main checkout under `docs/superpowers/`: the spec
`specs/2026-09-20-fleet-handover-design.md`, the plan `plans/2026-09-20-fleet-handover.md` (Tasks 1–4
boxes ticked) and the M0 evidence `plans/fleet-handover-spike-results.md`. Typecheck clean; the
whole vitest workspace is green (95 files, 990 tests).

Evidence lives beside the tests: `packages/svalld/test/fixtures/handover/{claude,codex}/README.md`,
`packages/svalld/test/handover/*-portability.test.ts`, `packages/svalld/test/gateway/relay-contract.test.ts`,
`scripts/spikes/probe-*-handover.mjs`.

## What the spikes changed in the spec and plan

- Codex: the rollout file alone resumes; no index or sqlite moves. `codex login status` is the
  preflight login check (a missing login otherwise surfaces as a mid-turn 401).
- Git graphs: prune unlisted registrations, then rewrite gitfiles, then `git worktree repair`.
  Repair run first corrupts the still-reachable source. `git worktree prune` is forbidden at import.
  Submodule `origin` remotes are not rewritten (warning).
- tmux: 3.x required, 3.5+ recommended; Ubuntu 24.04 apt ships 3.4, which rejects only
  `extended-keys-format` (Shift+Enter). Add Machine's tmux check is a warning.
- rsync: macOS openrsync rejects `--info=progress2`, `--protect-args`, `-s` and splits remote paths
  on spaces; the desktop release bundles rsync 3.x (Task 23 no longer conditional).
- Packaging: esbuild bundles both entry points for Node 22; `import.meta.url` climbs in
  `api/bundle.ts`, `mobile.ts`, `setup.ts` break under bundling, so Task 12 adds `release.ts` +
  `SVALL_RELEASE_ROOT` and a real `svall version`. Install = authenticate in staging, then rename
  into `releases/<version>/`, then atomic `current` swap (Task 13).
- Relay: `tailscale serve` strips the path prefix, so Task 30 needs a configured public base for
  PWA `start_url`/`scope`. Viewer-identity HMAC key is derived from the per-fleet relay secret
  (HKDF); max frame 4 MiB; owner-side "identity only on the relay" is a Task 31 test obligation.

The packaging half was also run from clean `ubuntu:24.04` Docker images on 2026-09-22: arm64
native and amd64 under Rosetta both install and run `svall` with no node, pnpm or git present.
Task 12/13 inherit: `svalld` has no `--help` (it starts the daemon); bare Ubuntu lacks `ssh-keygen`
so signature verification fails closed with a misleading message; `svall doctor` remedies are
macOS-only.

## Not proven (release integration checks, not blockers)

Cross-OS and independent-auth resume for Claude and Codex (test-server has Claude 2.1.251 logged
out and no Codex; Mac is 2.1.278 / codex 0.155.1); systemd units on a real host; real phone
Add-to-Home-Screen through the gateway.

## Parked from review (fix on next touch)

- `scripts/spikes/build-companion.mjs:131-137`: `--version ..` passes the charset check and the
  following `rmSync` deletes the whole `--out` dir; needs the same containment check
  `install-release.mjs` has.
- `relay-contract.test.ts` bad-frame test does not prove a peer socket survives the other's
  malformed frame; guard code is correct.

Next: the user reviews `fleet-handover-spike-results.md` (the plan's M0 gate) and decides how to land
the branch; then Task 5. Remote test-server was left exactly as found (serve `/` -> :8787 intact,
no temp files).
