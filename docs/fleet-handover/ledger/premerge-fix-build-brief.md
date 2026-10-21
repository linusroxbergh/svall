# Fixer build — S2 (Svall.app carries one Node)

Worktree `/Users/linusroxbergh/linus_laboratory/svall/.claude/worktrees/pm-fix-build`, branch `pm-fix-build`.
Read `ledger/premerge-fix-common.md` and item S2 of `ledger/pr2-premerge-review.md` first.

Exclusive files: `apps/desktop/mac/build.sh`, `scripts/app-build.sh`, `scripts/sign.sh`, `scripts/release-scan.mjs`,
and tests under `test/` for them. Don't edit docs (the docs fixer rewrites deferred.md's two-controllers item; put the
measured sizes in your report).

Every release build copies the carried release into `Svall.app/Contents/Resources/release` (`build.sh:51-61`),
including `node/bin/node`, byte-identical to `Contents/Helpers/node` (same pinned v24.21.0). In the app copy only,
make `Resources/release/node/bin/node` a relative symlink to `../../../../Helpers/node`, after `release-scan` (which
refuses links out of the release).

Prove it holds, without touching /Applications or signing with a Developer ID:
- Everything that resolves the release root or the node path still works through the link: the shim
  (`bin/svall`, `$SVALL_RELEASE_ROOT/node/bin/node`), `packages/svalld/src/release.ts`, `process.execPath` users
  (grep, e.g. `packages/cli/src/controller/handover.ts` ~553), `ControllerProcess.locate`. Node may report
  `process.execPath` as the link target; check what each caller does with it.
- `sign.sh` and an ad hoc hardened sign of a bundle with the link pass `codesign --verify --strict --deep`; the app
  smoke checks still pass (find them under `test/` and `scripts/`).
- If the Helpers node pin and the carried node pin can ever differ, the build must fail rather than link the wrong one.
- Test first where a test can see it (e.g. a test that runs build.sh's release block or its helper against a fake
  bundle and asserts the link); RED then GREEN.
- Report the sizes: `du -sh` of the app's Resources/release before and after, and a compressed estimate
  (`ditto -c -k`), against the 0.9.0 DMG's 50,650,996 bytes.
