# Creation actions implementation plan

Approved direction: the sidebar is the predictable place to create islands and characters; an empty island invites its first character on the map. Follow the visual concepts in the `discover-creation-actions` worktree. This branch starts from `main` at `8c326042`.

## Changes

1. Replace the sidebar heading's tiny `+` with a compact, labelled **New island** button. Use the existing `--sand`, `--sand-fill`, `--line`, spacing, radius, and type tokens. Confirm it fits when the sidebar is resized to its 180 px minimum.
2. Add a persistent local character action to populated island rows in the sidebar, with an accessible name that includes the island. Show a full text **New character** row for empty islands, including when they are collapsed. Stop row click and double-click propagation so creation never selects or renames the island.
3. Move the existing island-card **New character** action next to the editable name. Reuse `.btn.pri` and `.btn.sm`; let a long name wrap and the header adapt at the 240 px side-card minimum. Keep the empty-island Delete action below the content.
4. On expanded empty map islands, center a persistent **New character** action on the land. On occupied islands, retain the current hover/selection action at the coast, but name its destination explicitly. Preserve its test ID and pointer handling.
5. Spell out **New island** and **New character** in the home row. Keep the existing create and focus behavior.

## Verification

- Typecheck and build the desktop web app.
- Run the focused map and side-card browser tests, including creation and pointer handling. Add a focused test for the sidebar's island-specific action and empty-island state.
- Inspect a rendered desktop view at default and minimum sidebar/card widths, plus an empty island and a populated island. Check keyboard focus, overflow, and home-row wrapping. Run the design detector once over changed UI files.

The app's current Outfit type, slate surfaces, sand primary action, tokenized spacing and radii, island coast, and token cards remain the visual authority. No permanent creation island is added to the water.

## Execution

Implemented all five changes above. The empty-land prompt and the right-card action were checked in screenshots of the running desktop web app at the default view and with the sidebar/card resized to 180/240 px. The home creation actions are grouped on the second line when the map has room; the group wraps within the map at narrower widths, leaving the Resources islet clear.

Validation: `pnpm typecheck` and `pnpm --filter @archipelago/desktop-web build` passed. Six focused Chromium tests passed, covering each creation route and minimum panel widths. The Impeccable detector reported only the existing `transition: width, height` warning on `styles.css:333`, outside the changed CSS.
