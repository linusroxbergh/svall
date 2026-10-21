# OC-C review (oc-handover-c, 8d5efd6e..efc37353)

Verdict: **Approved** (no Critical/Important; Minors optional).

## Checked
- Version floor: host.ts reuses `AGENTS.opencode.minVersion` [2,0,22] + `versionOk` (same table OC-A's `adapterFor`/probe use); 2.0.21 warns "update OpenCode", missing → exit 127 → "install OpenCode" (Ruling 952).
- Login probe: `opencode auth list --standalone` matches OC-A `probeAgent` (registry.ts:160, exit 0 = logged in; `AGENTS.opencode.loggedIn` is `() => true`). `--standalone` keeps the shared `serve --service` unstarted (spike: without it `auth list` hung). Bounded by PROBE_TIMEOUT 30s; runProcess resolves on timeout (code null), so a hang reads as a warn, never stops Add Machine.
- Plugin path: doctor uses `opencodePaths(daemonEnv)` (login-shell `agentHomesEnv` on Linux, `launchdEnv` on Mac); setup --check uses `opencodePaths(env, homedir)` with the same wanted-predicate as OC-B `setupLinux`; uninstall adds `opencodePaths(agentHomes)` when XDG_CONFIG_HOME is set. All three agree with OC-B 521f80ec's unit env.
- host doctor relays the companion doctor, so it gets the `opencode plugin` row; preflight `config_difference` and handover-view "Terminate and carry" are already kind-generic; grep of packages/cli/src finds no remaining claude/codex-only handover enumeration.
- Tests: typecheck clean. At HEAD 2 cli + 1 svalld test fail (need 521f80ec, as reported). With 521f80ec cherry-picked in a scratch worktree: the 4 touched cli files 253 passed, svalld uninstall+linux-setup 72 passed. Mutations: 8/10 caught (doctor paths, doctor text, setup env, setup agents-predicate, uninstall XDG line, HOOK_CHECKS entry removed (5 fail), check name renamed).

- Full cli with 521f80ec: 1581 passed, 3 failed — 2 faults.test.ts load flakes (pass alone) and error-catalogue.test.ts "Steps", which expects `HANDOVER_KINDS` (no opencode until OC-A fd59f678) and now sees host.ts's `opencode` step. Passes once OC-A lands; merge OC-A with or before OC-C.

## Minor
0. Merge order: OC-C alone fails cli error-catalogue (needs OC-A) and 2 cli + 1 svalld tests (need OC-B 521f80ec).
1. packages/cli/test/setup.test.ts:44 — mutations survive: dropping the `integrations?.includes('opencode')` gate (setup.ts:231) and checking existence instead of `opencodePluginCurrent` (setup.ts:232). Add: integrations without opencode → no row; stale plugin text → row.
2. packages/cli/test/controller/handover.test.ts:248 — the config_difference test passes on 8d5efd6e (logic was already generic); coverage, not a red→green test. Fine to keep; don't count it as test-first.
3. packages/cli/src/controller/host.ts:240 — the remote `auth list --standalone` runs with the ssh shell's env, not the login shell's, so with a login-shell XDG_DATA_HOME it reads (and its private server may create/migrate) the default ~/.local/share/opencode, and a timeout leaves that private server orphaned on the remote. Same shape as claude/codex today; at most note it in errors.md, or run the probe via the unit's env (`agentHomesEnv`) later.
4. packages/cli/test/host.test.ts — no case for `auth list --standalone` exiting non-zero (→ "not logged in", action `opencode auth login`). Add one reply with `code: 1`.
