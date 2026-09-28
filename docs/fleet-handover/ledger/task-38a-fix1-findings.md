# Task 38a — fix round 1 findings

From `ledger/task-38a-review.md` (review of 38a's 13 commits). Read each item there in full; fix all of them, each test
first, one commit per item where practical:

- **I1.** The far check runs `grep`, `ssh-keygen` and `sha256sum` by bare name after changing into the upload, so a
  relative far PATH entry runs the upload's tools: pin `PATH=/usr/bin:/bin` (or absolute tools) before anything else.
- **I2.** A repeat `host add` over an installed release installs with only the controller's check; give it the far
  check `host upgrade` has.
- **I3.** `host remove` looks only at fleets whose gateway is the removed machine; refuse (or leave running) a machine
  that owns any fleet, whatever its gateway.
- **I4.** The app bundles Ghostty's bash/zsh shell integration (GPL-3) and bash-preexec (MIT) with no notice or GPL text;
  ship both notices and texts, and make the licence test cover bundled resources, not only the linked kit.
- **I5.** Spec (binding) "Preflight blockers": source, destination or gateway identities disagreeing blocks. Add the
  gateway identity check (one `archi version --json`, or equivalent, per gateway connection) and remove it from the
  doc's accepted risks.
- **Minors 1–9**, all of them (see the review): a missing far signers file must not read as "pins no signer"; tie the
  verified release to the expected version (no replay of an older signed release); the destination's login/`~/.ssh`
  guard by real path, and Archipelago's own install folder (gateway authority records) guarded too; a preflight warning
  for other plaintext credentials in a root (gh, `.netrc`, `.git-credentials`, aws, docker); the four destructive sites
  the table misses and the row citing a deletion test; a test for the `.`/`..` handling of controller transaction
  folders; `host enable`'s second connection and a master that dies after the identity check; the two inaccurate
  licence items; the doc's missing accepted risks and Unicode normalization collisions at preflight (beside the case
  collisions).
- **Spec line 286** ("verify … before the archive is unpacked"): make the far and local installers verify the signed
  manifest before unpacking the rest (e.g. extract only the manifest and its signature first). If the archive layout
  makes that impossible without a format change, stop and report it (NEEDS_CONTEXT) rather than documenting around it.
