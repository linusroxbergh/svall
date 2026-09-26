# Task 41a fix round 2 — report

Branch `experimental-remote-sessions`, FIX_BASE 6da5d341, commits 6da5d341..ad9fc063 (four, not pushed). Uncommitted:
this report.

| Commit | Item |
| --- | --- |
| 42d4498c | F1 |
| 4571fc9c | F2 |
| 58afe28f | F3 |
| ad9fc063 | F4 |

## Per item

**F1** (`archid/src/handover/probe.ts`): `probeFolders` writes nothing now.
- **Writable:** `accessSync(dir, W_OK)`.
- **Case folding (`foldsCase`):** the folder's own name is looked up with its ASCII letters' case swapped, and the
  result is compared by `dev` and `ino` with `lstat` of the folder.
  - The lookup happens in the parent's filesystem, so it is used only when the parent's `stat().dev` matches the
    folder's `lstat().dev`, and only when the name has letters.
  - Otherwise, as for a mount point or a name without letters, the first entry inside the folder whose name has
    letters is swapped the same way.
  - With no such entry, or an error, it reads `false`.
- Free space is still read with `statfs`. `ProbeFs` is now `existsSync`, `accessSync`, `lstatSync`, `statSync`,
  `readdirSync` and `statfsSync`.
- The controller keeps asking about each carried folder root and keeps reading case from the root's own probe
  (question 3), so no controller change was needed.
- A folder that cannot be written now reports its volume's real case folding; before, it always read `false`.
- Sanity check on this Mac (not a test):
  - `/Volumes`: not writable, folds case.
  - `/Volumes/Ollama`, a mounted volume: not writable, folds case, read through an entry inside it.
  - `$HOME`: writable, folds case.

`probeFsRules` stays as it is. Its `ignoreCase` reading is already read-only (`existsSync(<common>/CoNfIg)`). Its
`precomposeUnicode` reading has no read-only form: a composed and a decomposed name differ only in non-ASCII
characters, and a Git common directory holds only Git's own ASCII names, so nothing there can be looked up in the
other form. It also runs at prepare, inside a root this transaction has claimed, not at preflight. The known leftover
risk for the seal is unchanged.

**F2** (`controller/host.ts` doctor): `home` also fails when the far `$HOME` equals the registry record but is not this
Mac's home: `X is U's home on trift and Y is this Mac's; a fleet moves only between accounts with the same home path;
archi host remove trift, then archi host add again at an account whose home is Y`. A mismatch with the registry is
checked first, with its round-1 text.

**F3** (`handover.test.ts`): a file root `/Volumes/work/notes.md` that holds its replica, under an unwritable
`/Volumes/work`, blocks with `/Volumes/work on mac cannot be written`. With `c.entry === 'file' ||` deleted, this test
fails, and it is the only one that does.

**F4** (`divergence.ts`): the blocker now ends with "Recover the changes by hand, or archive it to continue". The
replica divergence test now asserts the tail of the text.

## Failing first (logs in the session scratchpad)

- F1 failed on the write probe in four tests:
  - probe test on a real folder: the folder's `mtimeNs` changed;
  - folder it cannot write (0555): read `caseInsensitive: false` on this case-folding volume;
  - mount-point fake: failed;
  - destination inspect over landed roots, one of them diverged: each root's snapshot (`mtimeNs` of the root and every
    entry, plus file bytes) changed.
- F2: the doctor test answered `{ name: 'home', status: 'ok', … }` where `fail` was expected.
- F3 (a test of an existing rule): it fails only when the file-root clause is removed, as above.
- F4 (not required test-first): the new text assertion failed on the old wording.

## Verification

| Command | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm vitest run --project protocol --project archid --project cli` | 125 files passed, 1 skipped; 2241 passed, 6 skipped |

The +4 against round 1 (2237) are the probe mount-point test (the probe file went from 3 to 4 tests), the destination
inspect test, the F2 doctor test and the F3 controller test.

## Concerns

- F1: reading case folding reads a folder's parent (`stat`), and for a mount point or a name without letters, the
  folder's entries (`readdir`). A mount-point folder that is empty, or whose own entries all lack letters (such as
  `2024/`), reads as not folding case. An empty folder has nothing to collide. The other case would miss a collision
  deeper down, such as `2024/Notes` against `2024/notes`. Reading one level deeper would close that, but no layout here
  needs it.
- F1: the real-filesystem test of an unwritable folder is skipped when the tests run as root, since root can write
  anywhere.
