### Task 6: Add the machine registry and named path roots

**Depends on:** Task 5

**Files:**

- Create: `packages/cli/src/controller/registry.ts`, `paths.ts`
- Create: `packages/cli/test/controller/registry.test.ts`, `paths.test.ts`
- Modify: `packages/cli/src/target.ts`

**Interfaces:** `MachineRegistry.load/save`, `localMachine`, `resolvePortablePath`,
`mapPortablePath`, longest-boundary root matching, global machine id file.

**Steps:**

- [ ] Store the local machine identity and controller registry under
  `~/.config/archipelago/`, mode 0600, with atomic writes and schema validation.
- [ ] Auto-create the local record with `home`; add CRUD for validated remote names and ids.
- [ ] Implement lexical normalization, component-boundary matching and realpath containment.
- [ ] Represent portable paths as `{ root, relative }`; reject NUL/newline, `..`, missing roots and
  symlink escapes for cwd/transfer roots.
- [ ] Add a destination filesystem probe for writable roots, case sensitivity, unsupported
  collisions and free-space reporting.
- [ ] Keep `local` as a controller alias resolved to the invoking machine id; never serialize it as
  ownership.

**Tests:** prefix confusion (`/home/a` vs `/home/ab`), longest root, spaces/unicode, symlink escape,
case collisions, missing destination root, corrupt registry recovery.

**Verify:** `pnpm vitest run --project cli test/controller/registry.test.ts test/controller/paths.test.ts`

**Commit:** `The controller knows machines by stable identity and named roots`

