# Final fix wave — Fixer A re-review (daemon and protocol)

Scope: `48d0e51c..b7d94143` over packages/archid, packages/protocol, docs/remote-machines, docs/security, with the
createCharacter follow-up `7b9830a2`. Verdict: **Approved.** Every item is ADDRESSED. The new findings are three Minors.

## Verification

- A scratch copy (`git archive b7d94143`) passes protocol + archid (2203 passed, 4 skipped), and `tsc -p tsconfig.json` is clean.
- Each fix was mutated away in the scratch copy and its tests run:

| Mutation | Result |
| --- | --- |
| C01: `settle()` waits only on `background` (+`creating`) | fails "opens no window for a revive admitted before a freeze…" |
| C01: both `assertOwner('terminal')` in `doRevive` removed | fails, same test |
| C01: `openingSecond` dropped from `settle()` | **passes** (Minor 3) |
| C01: `assertOwner` in `doOpenSecond` removed | **passes** (Minor 3) |
| follow-up: `creating` dropped from `settle()`, or `creating.add` removed | fails "settles only once a character created before a freeze…" |
| follow-up: `assertOwner` before `openCharacter` removed | fails, same test |
| follow-up: either `!writable()` check after the create disabled alone | passes. The two checks back each other up; the prompt test is caught by whichever runs |
| C04: kill recheck removed | fails "stops with the journal open and the slot live…" |
| C19: `source.complete.deactivate` removed | fails source complete test (fault world also asserts `active: false`) |
| C20: back to `answeredAs !== undefined && …` | fails "refuses an answer whose archi names no machine…" |
| C33: claim seal record not written, or `dropStage` not sealing | fails "seals each root it claimed as the transfer left it…" |
| F3: resume record never set | fails both "lays a revived terminal … dormant again" tests |
| D1: tick line removed | fails D1 test and "re-attaches a character whose window is still alive" |
| D1: tick deletes `revive` unconditionally | fails ed25ada8's "keeps the resume command of a terminal a handover has yet to answer for…", so its guarantee holds |

- **Window-opening paths.** `createCharacter`, `doRevive` and `doOpenSecond` are archid's only `newWindow` calls. Each
  checks `assertOwner('terminal')` with no await before `newWindow`, and `settle()` waits for all three.
- **Dormant-marking paths.** The tick's F3 close, `windowClosed` and `endIdleAgents` each check `writable()` after
  their last await, or run inside a tracked tick that `settle()` drains. No path lays a slot dormant while its window lives.
- **D1 vs ed25ada8.** The tick drops `revive` only while `carried()` is false. After a destination restart the journal
  is open and the row missing, so `carried()` stays true and `wakeSlot`'s `lay(s, carried)` still has the flags.

## Items

ADDRESSED: C01 (+ createCharacter follow-up), C04, C05, C19, C20, C21, C22, C23 (archid side), C24 (archid side;
`--force` flag is B's), C26, C27, C28, C29, C30, C33, C11 (protocol types), C07 (helper), L38, L40, L41, L42, L44,
L45, L46, L47, L48, L50, L51, L52, I1, I7, I10/L43, 39b F2, F3, D1.

## Fixer's concerns

- **C22's watch ends at Complete, relying on F3.** This holds while the terminal was opened by this daemon's
  `doRevive`. It fails in one case (Minor 1).
- **A create admitted just before a freeze gets no run prompt.** Acceptable. Not typing into a terminal about to rest
  is the safe side. The answer says `runSent: false`, and `archi char new` prints "(prompt not sent)", as does the
  web app.

## New findings

Critical 0 · Important 0 · Minor 3

1. **Minor: C22 + F3 leave a gap after a destination crash.** `destination.ts` `wakeSlot`: a window that survived a
   daemon crash and holds its agent (`held === 'agent'`) skips `openSlot`. The restarted Fleet then holds no resume
   record for it. The watch now ends when the journal closes. Suppose that agent waits at an untrusted folder's trust
   prompt and exits after Complete. The tick then deletes `agent` and `revive`, which leaves a plain shell without its
   session. Before C22 the watch outlived Complete and laid it dormant. Suggested fix: record the resume in the Fleet
   for a held agent too, or keep the watch until heard or restedBy changes.
2. **Minor: F3 treats every early Codex quit as a failed resume.** Codex sends no SessionStart until its first turn
   (`sessionStartOnResume: false`). So any revived Codex terminal quit before its first prompt gets its window
   killed, even outside a handover. It is laid dormant with "codex exited back to its shell before that session
   started…". No session is lost, but the user's shell closes and the error misleads.
3. **Minor: test gap in the second-terminal half of C01.** `openingSecond` in `settle()` and `doOpenSecond`'s
   `assertOwner` can each be removed with every test green. The code is correct as read.
