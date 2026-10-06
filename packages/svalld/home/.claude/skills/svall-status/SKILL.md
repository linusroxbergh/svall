---
name: svall-status
description: Report what every character is doing and which ones need the user, and save the report as this character's note.
---

# Report on the fleet

Change nothing except your own note.

1. `svall status` lists every id, name, island and state.
2. For each character that is `blocked`, `done`, or otherwise seems to want
   something, run `svall char read <name>`, and
   `svall char read <name> --transcript --lines 30` when the screen is not
   enough.
3. Print a one-line count, then these sections in this order, skipping empty
   ones. Plain text, no markdown: the report is also your card note.

       12 characters: 1 needs you, 2 to review, 2 working, 7 quiet

       Needs you
         bob — asks whether to drop the failing auth test (SV-41)
       Ready to review
         review-472 — PR #472 waiting for your review
         deploy — done, unread
       Working
         api-tests, docs
       Quiet
         6 dormant, 1 idle

   Needs you: blocked, or asking a question. Ready to review: done or unread,
   PRs waiting on the user, failures only the user can fix. Working: one line
   each only when notable, else one comma list. Quiet: one count line.
4. Save the whole report as your own note, so it shows on your card. Your id is
   the `c_…` in the `svall char show` line that ends your Svall context.
   Write the id out: a command holding `$SVALL_CHAR_ID` waits for the user's
   approval. The quoted heredoc keeps quotes and backticks copied from other
   agents intact:

       svall char update c_abc123 --note-file /dev/stdin <<'EOF'
       3 characters: 1 needs you, 1 to review, 1 quiet

       Needs you
         bob — asks whether to drop the failing auth test (SV-41)
       Ready to review
         review-472 — PR #472 waiting for your review
       Quiet
         1 dormant
       EOF
