---
name: svall-status
description: Report what every robot is doing and which ones need the user, and save the report as this robot's note.
---

# Report on the fleet

Change nothing except your own note.

1. `svall status` lists every id, name, island and state.
2. For each robot that is `blocked`, `done`, or otherwise seems to want
   something, run `svall robot read <name>`, and
   `svall robot read <name> --transcript --lines 30` when the screen is not
   enough.
3. Print a one-line count, then these sections in this order, a blank line
   between them, skipping empty ones. Write each robot's name as a link to its
   id, which selects it on click:

       12 robots: 1 needs you, 2 to review, 2 working, 7 quiet

       Needs you
       - [bob](svall://robot/c_abc123) — asks whether to drop the failing auth test (SV-41)

       Ready to review
       - [review-472](svall://robot/c_def456) — reviewed PR #472, 2 blocking comments
       - [deploy](svall://robot/c_ghi789) — shipped 0.8.1 to svall.dev

       Working
       - [api-tests](svall://robot/c_jkl012), [docs](svall://robot/c_mno345)

       Quiet
       - 6 dormant, 1 idle

   Needs you: blocked, or asking a question. Ready to review: done or unread,
   PRs waiting on the user, failures only the user can fix. Each of these gets
   a very short line on what it asks or did. Working: one line each only when
   notable, else one comma list. Quiet: one count line.
4. Save the same report as your own note, so it shows on your card. The card
   shows the note as plain text, so write the names there without links. Your
   id is the `c_…` in the `svall robot show` line that ends your Svall context.
   Write the id out: a command holding `$SVALL_ROBOT_ID` waits for the user's
   approval. The quoted heredoc keeps quotes and backticks copied from other
   agents intact:

       svall robot update c_abc123 --note-file /dev/stdin <<'EOF'
       3 robots: 1 needs you, 1 to review, 1 quiet

       Needs you
       - bob — asks whether to drop the failing auth test (SV-41)

       Ready to review
       - review-472 — reviewed PR #472, 2 blocking comments

       Quiet
       - 1 dormant
       EOF
