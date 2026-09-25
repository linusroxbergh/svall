# Task 25 fix round 1 — findings (from the review at 2b4f015) and controller rulings

## Important 1 — source-path blockers found in the freeze are discovered only after every window is closed (source.ts:137 against :150-151, then :255)
The pre-rest `check()` runs only `buildInventory`, which checks recorded path fields. Everything `buildManifest` detects appears only after `restTerminals` has killed every window: unsupported names inside roots (`path_unsupported`, manifest.ts:114); a root that no longer exists (`worktree_unresolved`, manifest.ts:109); a missing transcript (manifest.ts:175); a destination with no agent home (manifest.ts:181). `refuse()` then keeps the fleet frozen until a gateway-proved Abort. The spec (Resting characters) says Freeze repeats the source-path checks, and a newly found blocker returns the source to normal ownership "without killing a window". A file created after preflight, or a new session whose transcript is not on disk yet, dismisses the whole crew and locks it.

Controller ruling (binding): do both —
- run the manifest's names-and-existence checks (and anything else detectable without the terminals at rest) before rest, preferably as a pass that does not hash file contents, so a blocker found there releases without killing a window;
- for a blocker only discoverable after rest (session content written during rest), revive exactly the `stoppedTerminals` and release — no manifest was answered, the same safety argument `refuse()` at :255 already relies on.
Tests for both paths (no window killed in the first; the stopped terminals revived and the fence released in the second).

## Important 2 — platform and "Keep on this machine" blockers have no owner (plan gap)
`.archipelago/handover.json` → `platform_unsupported`; heuristic warnings → `platform_heuristic`; a pinned character → `character_pinned`. All three codes exist (protocol/src/handover.ts:128-130) but nothing emits them. Only the source holds the repository files and character state.

Controller ruling (binding):
- Build the platform check in source preflight now (`destination.info.platform` is already in the params): a carried repository root whose `.archipelago/handover.json` lists supported destination platforms that exclude the destination's → `platform_unsupported` blocker naming the file; heuristics (e.g. an Xcode project, `*.xcodeproj`/`*.xcworkspace`, when the destination is Linux) → `platform_heuristic` warning, never a blocker. Define the file's shape minimally (e.g. `{ "platforms": ["darwin", "linux"] }`); an unreadable or invalid file is a blocker naming it.
- Add an optional character field for "Keep on this machine" (settable through the existing character update RPC; additive, no schema-version bump) and the `character_pinned` blocker naming the character. The CLI to set it is Task 28's and the UI toggle Task 29's.

## Promoted minor (controller ruling) — defense in depth at source.ts:236
`mayTakeBack` refuses only when the gateway's open transaction is this one. A different transaction from this machine already past `preparing` (e.g. `ready-to-commit`) would still let the source unfreeze — fails open against the single-owner invariant, reachable only by a misbehaving controller. Refuse on any open transaction from this machine past `preparing`. Test it.

## Carried into this round (controller) — wire Task 21's `discoverGit`
Task 21 is now on this branch. `buildInventory` takes `discoverGit(...)` as its 4th argument; without it every Git root blocks at prepare. Wire it at the source's `buildInventory` call sites (preflight and freeze), with a test that a carried repo's graph reaches the manifest.
