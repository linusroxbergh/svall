# Global constraints (plan Delivery rules, verbatim)
## Delivery rules

- This is one implementation plan for the whole feature. The milestone gates are mandatory; a later
  phase may remain on the same branch, but it does not start until the earlier gate passes.
- Work in a dedicated worktree. Preserve unrelated dirty files in the main checkout.
- Write the failing test first whenever the task changes executable behavior.
- Use dependency injection for filesystem, process, SSH, rsync, clock and authority operations so
  failure paths are deterministic in unit tests.
- Never run rsync `--delete` against a path that is neither absent/reserved by the transaction nor
  represented by a matching replica record.
- Never activate a destination terminal before the authority Commit.
- Never automatically reactivate the source after Commit.
- Spawn subprocesses with executable plus argv. Shell interpolation is forbidden for SSH, rsync,
  Git, tmux, systemctl and agent commands.
- Persistent JSON writes use a same-directory temporary file, `fsync` where durability matters,
  rename, and mode 0600 for ownership, journal, registry and secret files.
- Keep the existing local-only experience working throughout. New UI stays behind
  `handover.enabled` until the release gate in Task 39.
- Bump the RPC protocol once when the new wire surface lands. During development all components use
  the same checkout; published handover later requires an exact companion release match.
- Commit subjects follow the repository style: one plain sentence, no attribution lines.

