# Task 37b — fix round 1 findings

From `ledger/task-37b-review.md` (review of 0d85957b..ac94cf15). Read each item there in full; fix these, test first:

- **I1 (Important, product).** `host upgrade` and `setup --rollback` restart only the private fleet's daemon and the
  gateway; a second fleet's `archipelago-archid@<fleet>.service` keeps the old release. Fix in `restartUnits`
  (`packages/cli/src/commands/setup.ts:163`) with a unit test, and add a second fleet to the fresh-install run.
- **I2 (Important).** The fresh install always passes `--release`; add the route the app takes (companion looked up from
  the controller release's manifest, downloaded, digest checked) — the reviewer ran it with a loopback `--url-base`.
- **I3 (Important).** The scan misses a private key inlined in a JS bundle (escaped `\n`) and Codex's `auth.json` and its
  JWT tokens; add planted cases for each.
- **M1.** Keep the credential file-name rule under `--secrets-only`, and give `ci.yml`'s integration log upload the same
  scan gate as `release.yml`.
- **M2.** `retention-days: 1` on the signed build uploads in `release.yml`.
- **Concern 3 (release.yml).** The build job fails at once, with the cause named, when the signing key's public half is
  not in `scripts/release/allowed_signers`; tags with a `-` (e.g. `v1.0.0-test1`) never publish, so a dry run stays
  possible once the secret exists.

Deferred (not this round): M3 (Mac `setup --rollback` restarts nothing) and the long-home gateway socket (refuse at
`host add`'s home step with the cause named; name the gateway's `listen EINVAL`) → Task 38a.
