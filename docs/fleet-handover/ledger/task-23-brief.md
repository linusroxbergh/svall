### Task 23: Implement the controller rsync engine and progress journal

**Depends on:** Tasks 14, 19, 20

**Files:**

- Create: `packages/cli/src/controller/rsync.ts`, `transfer.ts`, `progress.ts`
- Create: `packages/cli/test/controller/rsync.test.ts`, `transfer.test.ts`
- Modify: artifact build to include the bundled macOS rsync 3.x

**Steps:**

- [ ] Pin/verify a compatible rsync feature set, including protected remote arguments; use the
  bundled Mac binary. Task 4 measured macOS openrsync rejecting `--info=progress2`,
  `--protect-args` and `-s`, splitting remote paths on spaces, and mangling non-ASCII names in
  `--itemize-changes` output, so the system binary is a fallback the doctor flags rather than a
  supported configuration.
- [ ] Support local→remote and remote→local from the Mac controller using the same SSH control
  socket and explicit source/destination roles.
- [ ] Generate exclude files in transaction temp storage and pass paths/remote shell as argv-safe
  data. Redact `.env` and tokens from logs.
- [ ] Allow `--delete` only after the destination reservation/replica proof from Task 20.
- [ ] Parse item/byte progress into durable per-root events without treating stderr warnings as
  success; preserve exit codes and partial progress for resume.
- [ ] Run a verification pass and re-hash source/target. Retry a changing source at most three times,
  then return an external-writer blocker.
- [ ] Make cancellation stop child processes but leave replica/journal data resumable.

**Tests:** spaces/unicode, hostile-looking names, excluded caches, partial exit, disconnect/resume,
source mutation, destination reservation, both transfer directions.

**Verify:** `pnpm vitest run --project cli test/controller/rsync.test.ts test/controller/transfer.test.ts`

**Commit:** `The Mac mirrors a verified fleet replica in either direction`

