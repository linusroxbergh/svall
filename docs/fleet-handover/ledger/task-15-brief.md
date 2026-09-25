### Task 15: Implement host add, doctor, upgrade and remove

**Depends on:** Tasks 13, 14

**Files:**

- Create: `packages/cli/src/controller/install.ts`, `host.ts`
- Create: `packages/cli/src/commands/host.ts`
- Modify: `packages/cli/src/main.ts`, doctor/uninstall formatting
- Create: `packages/cli/test/controller/install.test.ts`, `packages/cli/test/host.test.ts`

**Steps:**

- [ ] Add `host add/list/doctor/upgrade/remove`, `host enable <name> --fleet <profile>` and NDJSON
  output used by the app.
- [ ] Run one interactive SSH probe for host-key/auth establishment, then require batch mode for all
  automated operations.
- [ ] Probe OS/arch/home/Tailscale/tmux/Git/rsync/systemd/space; render actionable blockers.
- [ ] Download or locate the exact companion asset, verify signed manifest/digest, upload to a temp
  path, install atomically and start/verify gateway service.
- [ ] Open an interactive terminal for explicit package installation, linger and agent login/trust;
  never copy credentials or silently run sudo.
- [ ] Upgrade by installing a new release, switching `current`, restarting and probing; rollback the
  symlink and restart when the probe fails.
- [ ] Remove registry routes only after remote uninstall succeeds or the user explicitly chooses
  “forget unreachable host.” Never delete fleet replicas by default.

**Verify:** CLI unit tests plus a localhost-sshd integration test; `pnpm typecheck`.

**Commit:** `One command provisions and maintains a remote Archipelago host`

