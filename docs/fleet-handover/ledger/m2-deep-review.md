# M2 deep review — a67e100..11f3f3d (validator floor 70)
Panel: Bug Hunter 15, Architect 30, Guardian 14; Interpreter 16 intent findings; deduped into 45 candidates (m2-candidates.md), 7 opus validators (m2-validated.md).
Kept ≥70: D3, D1, D2, D7, I9, D4, D5, I7, D9, D10, I10 (high); D17, D21, D23, I11, D8, D11, I4, I5 (medium); A19, G14 (low).
Below floor, folded in by ruling (cheap, same code): D6, D14, D20, D26, D12, G13, I3; carried 17a minors.
Below floor, carried to M3: D13 (local authority socket on the gateway itself — Task 26/28), D24 (enable refuses a second gateway / requires owner.json — Task 28), D18 + D19 (owner-change surfaces and endpoint switch — Task 29), I14 (endToEnd gateway/tmux/path probes — after F15).
Below floor, deferred to the final review: D15, D25, D22, I15, A21, A22; Architect lows A9–A18, A20, A23–A30 (unvalidated simplifications).
Dropped: D16 (documented manual entry point), I16 (accepted Task 12 fix), I6 (ssh falls back past MaxSessions — verified), I12 (remote-owner display must stay truthful).
Fix list: m2-fix-wave.md (F1–F27).
