# M3 deep review — 1168d22..9fc7bf6 (validator floor 70)
Panel: Bug Hunter 7, Architect 20, Guardian 7; Interpreter 10 (5 known); deduped into 19 standards + 5 intent candidates (m3-candidates.md), 6 opus validators (m3-validated.md). No pal.
Kept ≥70: D1 (high, 80); D3, D4, D9, D10 (medium, 75); D5 (medium, 70).
Below floor, folded into the fix wave by ruling: D6, D7, D8, D2, D18, D16, D15, D12, D17, I1, I2, I3, I4.
Below floor, deferred to the final review: D11 (helper↔app types declared twice — declare once in protocol), D13 (paths.ts barrel); Architect lows A7–A11, A13–A20 (unvalidated simplifications).
Dropped: D14 (commit retry is backed off by the get), D19 (not_owner only means no journal of this tx), I5 (the --archive path form is a harmless, fail-closed superset).
Fix list: m3-fix-wave.md (F1–F34 = kept + folded + carried C1–C15).
