### Task 13: Implement Linux systemd installation and daemon setup

**Depends on:** Task 12

**Files:**

- Create: `packages/archid/systemd/archipelago-gateway.service.in`,
  `archipelago-archid@.service.in`
- Create: `packages/archid/src/linux/setup.ts`, `service.ts`
- Modify: setup/paths/tmux config modules
- Test: `packages/archid/test/linux-setup.test.ts`

**Steps:**

- [ ] Render user units with absolute `current` paths, fleet home argument, resolved PATH, HOME/LANG,
  restart policy and append-only logs.
- [ ] Make setup idempotently install hooks/templates/config, daemon profile units and the one global
  gateway unit without writing launchd files.
- [ ] Remove `pbcopy` from Linux tmux config and keep all shared tmux behavior identical.
- [ ] Install a release by unpacking into `releases/<version>/` named by the archive itself,
  verifying every `SHA256SUMS` line and the signature before anything is activated, then renaming a
  temporary symlink over `current`. Keep the previous release as the rollback target. Task 4's
  `scripts/spikes/install-release.mjs` is the working shape.
- [ ] Add `systemctl --user daemon-reload/enable --now/status` wrappers with structured errors.
- [ ] Detect linger with `loginctl show-user`; report the exact action but never assume sudo.
- [ ] Add uninstall that stops/removes only Archipelago units/releases and keeps fleet data unless
  explicit purge is requested.

**Tests:** golden units, escaping spaces, named fleets, repeat setup, rollback symlink, missing
systemd/linger, Linux tmux config.

**Verify:** `pnpm vitest run --project archid test/linux-setup.test.ts`; manual clean Ubuntu install.

**Commit:** `The companion installs as persistent Linux user services`

