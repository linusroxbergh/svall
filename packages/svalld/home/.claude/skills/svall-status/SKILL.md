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
3. Print one line per character that needs the user or is notable:

       bob — waiting for your input about the failing auth test
       review-472 — PR #472 is waiting for review
       deploy — done, unread

   Put everything quiet in one grouped line at the end:
   `working, nothing to answer: api-tests, docs, web-build`.
4. Save the whole report as your own note, so it shows on your card. Your id is
   the `c_…` in the `svall char show` line that ends your Svall context.
   Write the id out: a command holding `$SVALL_CHAR_ID` waits for the user's
   approval. The quoted heredoc keeps quotes and backticks copied from other
   agents intact:

       svall char update c_abc123 --note-file /dev/stdin <<'EOF'
       bob — waiting for your input about the failing auth test
       EOF
