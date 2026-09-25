### Task 12: Build reproducible Mac controller and Linux companion artifacts

**Depends on:** M1 and Task 4 decisions

**Files:**

- Create: `scripts/build-controller.sh`, `scripts/build-companion.sh`,
  `scripts/release-manifest.mjs`
- Create: `packages/archid/src/release.ts`
- Modify: root/package package manifests, `apps/desktop/mac/build.sh`,
  `scripts/desktop-install.sh`, `packages/archid/src/setup.ts`,
  `packages/archid/src/api/bundle.ts`, `packages/archid/src/mobile.ts`,
  `packages/cli/src/main.ts`, `.gitignore`
- Create: `packages/archid/test/release.test.ts`

**Steps:**

- [ ] Turn the Task 4 spike into production builds: esbuild bundles per entry point
  (`--external:bufferutil --external:utf-8-validate` and a `createRequire` banner), the pinned Node
  22 LTS tarball whose SHA-256 is checked against `nodejs.org`'s `SHASUMS256.txt` before it is
  staged, phone assets, templates, and a machine-readable release manifest. Archive layout
  `releases/<version>/{bin,lib,node,hooks,home,web-mobile,licenses}`.
- [ ] Ship the licence of everything the archive redistributes: Archipelago's, Node's, and one per
  package esbuild inlined, collected by mapping the metafile's inputs to `node_modules/<pkg>/LICENSE*`
  so a new dependency cannot be forgotten.
- [ ] Build architecture-specific archives in a clean staging directory; include no source checkout,
  node_modules, tests, credentials or developer absolute paths. Prune `node/include` and
  `node/lib/node_modules` from the runtime, and tar with `--no-xattrs` under `COPYFILE_DISABLE=1`
  so macOS writes neither Apple extended headers nor AppleDouble members.
- [ ] Give every artifact release/protocol/state/transfer/authority and agent-adapter versions.
- [ ] Generate SHA-256 digests over every staged file and detached-sign the manifest with
  `ssh-keygen -Y sign -n archipelago-release`; verify with `ssh-keygen -Y verify` against a pinned
  allowed-signers entry, and make the verifier injectable so tests use an ephemeral key.
- [ ] Replace the `import.meta.url` climbs with `release.ts`: `releaseRoot()` reads
  `ARCHI_RELEASE_ROOT` exported by the `bin/` shims and falls back to the repository layout for
  `pnpm archid`. `hooksDir()`, `homeTemplateDir()` and `mobileDistDir()` come from it, and
  `setup.ts`, `api/bundle.ts` and `mobile.ts` become its callers. A published release must not
  reach for the repository or run `pnpm` to build the phone bundle.
- [ ] Add a real `archi version` command reporting the release, protocol and runtime versions with
  `--json`; a bare positional must not swallow it as a profile name.
- [ ] Bundle matching production `archi` and `archid`, phone assets and the pinned macOS runtime
  inside `Archipelago.app`, together with the bundled rsync 3.x Task 23 requires. Install them into
  the per-user releases/current layout and point launchd plus CLI shims at `current`, never at the
  repository or `tsx`.
- [ ] Make developer `desktop:install` exercise the same installed-runtime layout while retaining an
  explicit source-tree dev command for `pnpm archid` and `desktop:dev`.
- [ ] Add reproducibility tests that compare archive file lists/modes and run `archi version --json`
  from an unpacked clean artifact.

**Verify:** build both host artifacts locally where possible, run
`pnpm vitest run --project archid test/release.test.ts`, and inspect archives for source paths.

**Commit:** `Published builds carry a versioned controller and companion`

