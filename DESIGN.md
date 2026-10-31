---
name: Svall
description: A map of your coding agents at night; a calm dark sea and sand chrome, where the robots carry the color.
colors:
  surface-0: "#172029"
  surface-1: "#1E2A38"
  surface-2: "#243140"
  glass: "rgba(22,32,44,.66)"
  glass-hi: "rgba(32,46,62,.94)"
  panel: "rgba(38,52,66,.92)"
  map-0: "#4B5F72"
  map-1: "#374959"
  map-2: "#26303D"
  ink: "#F4EEDF"
  ink-2: "#CCC5B1"
  ink-3: "#B5AF9A"
  ink-cool: "#9FB1C1"
  line-soft: "rgba(240,230,206,.07)"
  line: "rgba(240,230,206,.13)"
  line-strong: "rgba(240,230,206,.45)"
  fill-1: "rgba(240,230,206,.06)"
  fill-2: "rgba(240,230,206,.10)"
  fill-3: "rgba(240,230,206,.17)"
  sand: "#E6D8B8"
  sand-hi: "#F6ECD1"
  sand-fill: "rgba(230,216,184,.2)"
  ink-sand: "#3D3418"
  sel: "#8ED0FF"
  working: "#FFC95C"
  blocked: "#FF7766"
  done: "#63D7C0"
  idle: "#8A9CAB"
  moving: "#9CB3F0"
  unknown: "#A6A094"
  shell: "#EAF1EE"
  danger: "#FC9B8A"
  ink-on-blocked: "#3A0E09"
  working-ink: "#EB992E"
  blocked-ink: "#C94A45"
  done-ink: "#4BB3A1"
  moving-ink: "#5F7282"
  unknown-ink: "#6E685E"
  cream: "#FFFDF4"
  card-0: "#EDE5CF"
  card-1: "#E2D7BE"
  card-2: "#D4C6A7"
  card-band: "#C4B184"
  ink-land: "#2C3B31"
  grass: "#71876C"
typography:
  display:
    fontFamily: "Funnel Sans, ui-sans-serif, -apple-system, Segoe UI, sans-serif"
    fontSize: "25px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Funnel Sans, ui-sans-serif, -apple-system, Segoe UI, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.2
  body:
    fontFamily: "Funnel Sans, ui-sans-serif, -apple-system, Segoe UI, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.45
  control:
    fontFamily: "Funnel Sans, ui-sans-serif, -apple-system, Segoe UI, sans-serif"
    fontSize: "12.5px"
    fontWeight: 600
    lineHeight: 1.2
  meta:
    fontFamily: "Funnel Sans, ui-sans-serif, -apple-system, Segoe UI, sans-serif"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.45
  kicker:
    fontFamily: "Funnel Sans, ui-sans-serif, -apple-system, Segoe UI, sans-serif"
    fontSize: "10.5px"
    fontWeight: 600
    letterSpacing: "0.12em"
  badge:
    fontFamily: "Funnel Sans, ui-sans-serif, -apple-system, Segoe UI, sans-serif"
    fontSize: "9.5px"
    fontWeight: 700
  mono:
    fontFamily: "JetBrains Mono, SF Mono, ui-monospace, Menlo, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  card: "10px"
  lg: "12px"
  pill: "999px"
spacing:
  2xs: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  2xl: "16px"
  3xl: "24px"
components:
  button:
    backgroundColor: "{colors.fill-2}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  button-hover:
    backgroundColor: "{colors.fill-3}"
  button-primary:
    backgroundColor: "{colors.sand}"
    textColor: "{colors.ink-sand}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  button-primary-hover:
    backgroundColor: "{colors.sand-hi}"
  button-small:
    backgroundColor: "{colors.fill-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "26px"
  icon-button:
    textColor: "{colors.ink-3}"
    rounded: "{rounded.xs}"
    size: "22px"
  icon-button-hover:
    backgroundColor: "{colors.fill-2}"
    textColor: "{colors.ink}"
  chip:
    backgroundColor: "{colors.fill-1}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
    padding: "0 10px"
    height: "26px"
  chip-pressed:
    backgroundColor: "{colors.sand-fill}"
    textColor: "{colors.sand-hi}"
  segmented:
    backgroundColor: "{colors.fill-1}"
    textColor: "{colors.ink-3}"
    rounded: "{rounded.md}"
    height: "26px"
  field:
    backgroundColor: "{colors.fill-1}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
  list-row:
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "6px 8px"
  list-row-selected:
    backgroundColor: "{colors.fill-2}"
  count:
    backgroundColor: "{colors.blocked}"
    textColor: "{colors.ink-on-blocked}"
    typography: "{typography.badge}"
    rounded: "{rounded.pill}"
    height: "16px"
  dialog:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "24px"
  board-card:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
  map-card:
    backgroundColor: "{colors.card-0}"
    textColor: "{colors.ink-land}"
---

# Design System: Svall

## Overview

**Creative North Star: "The Night Harbour"**

Svall looks like a harbour at night. The sea is a calm, dark blue-slate. The chrome around it is sand and cream. The robots on their cards carry the color, so status is the loudest thing on screen and reads at a glance: working, blocked or done, from across the room. Everything else stays quiet.

The app is a tool people keep open all day. It is dense but calm: small type on a fixed scale, cream hairlines, glass over the map, solid surfaces for dialogs. Controls are warm and tactile: a sand primary button, cream fills that light under the pointer, a chip pressed in sand, buttons that give a little when pressed.

All values come from `apps/desktop/web/src/tokens.css`. All repeated controls are one primitive each, mostly in `base.css`. The phone app and svall.dev load the same tokens.

**Key Characteristics:**
- One blue-slate family for every surface, one cream family for every ink, sand for what is active or primary.
- Status colors belong to robots; they stay apart under color blindness, and beyond the sidebar's dots each comes with its word.
- The map is scenery: textured, quiet, no loud rings on its pills.
- Every text and icon is checked against the ground it is drawn on.

## Colors

A night sea of blue-slate surfaces, cream inks, sand chrome, and a small set of bright status colors that only robots wear.

### Primary
- **Harbour Sand** (sand): focus rings, a field's focus border, the active tab's underline, a pressed chip, the chosen option and its check, the primary button, and the text cursor in every field, the editor and the terminal. Hover lifts it to **Lit Sand** (sand-hi). Text on sand is **Sand Ink** (ink-sand).

### Secondary
- **Selection Blue** (sel): a selected item (the board card's ring), drop targets and drag markers, links, and the text-selection tint. Nothing else.

### Tertiary: status
- **Working Amber** (working), **Blocked Coral** (blocked), **Done Teal** (done), **Idle Slate** (idle), **Moving Periwinkle** (moving, the same blue as a robot on a worker), **Unknown Stone** (unknown), and **Shell White** (shell, a terminal with no agent).
- On a map card's cream paper the statuses print in darker inks (working-ink, blocked-ink, done-ink, moving-ink, unknown-ink), each with its word on the card's foot. Idle keeps the paper's band (card-band).
- **Danger** (danger) is blocked mixed toward ink: an error, or the word on a destructive control, on dark chrome.

### Neutral
- **Surfaces**, darkest first: surface-0 under terminals and the editor, surface-1 for the app's ground and the board, surface-2 for the sidebar, side card, dialogs and popovers.
- **Glass** over the map: glass for labels and pills, glass-hi when one is lit, panel for a panel whose text must read over the cards (terminal card, hover card, resources shelf).
- **Map sea**: map-0 (lightest) to map-2 (deepest), with a grain and contour lines.
- **Inks**: ink for primary text, ink-2 for secondary, ink-3 for tertiary text, placeholders and ghost icons, ink-cool for a section's kicker.
- **Lines and fills**, cream at low alpha: line-soft and line for hairlines, line-strong for a field's border and a lit pill's edge; fill-1, fill-2 and fill-3 for hover, selected and pressed.
- **Card paper**: card-0 to card-2 with a grain, card-band for the foot, ink-land for the printed name.

### Named Rules
**The Accent Rule.** Sand means focus, active, current or primary, and the text cursor. Blue means a selected item, a drop target, a link or selected text. Never swap them, and never use either as decoration.

**The Robots Carry the Color Rule.** Working, blocked, done, idle, moving and unknown use the same token in the app, the phone, the board card, the map card and the site. Where a status shows as color alone (the sidebar's dots), any two stay apart under protanopia and deuteranopia (ΔE2000 of 10 or more); everywhere else it also carries its word or a shape. Chrome uses a status color only for the same meaning, such as the coral count of robots that need you.

**The Contrast Floor Rule.** Text and icons hold 4.5:1 against the ground they are drawn on, including hover and selected fills and glass over the map. Large text, and non-text UI (field borders, focus rings, status dots, selected rings, a glyph beside its own label) hold 3:1. ink-3 is the dimmest ink for text. Disabled controls, at `--disabled` (.45), are exempt.

**The One Source Rule.** Colors live only in `tokens.css`. Stylesheets and scripts use `var(--…)` or a `color-mix()` of tokens; `test/tokens.test.ts` fails on a raw hex or `rgb()` anywhere else (the robot body colors in `portraits.ts` mirror their drawings and are the exception). The site's page tokens are mixed from the app's.

## Typography

**Body Font:** Funnel Sans (with ui-sans-serif, -apple-system)
**Mono Font:** JetBrains Mono (with SF Mono, ui-monospace)

**Character:** A plain, slightly rounded sans for everything a person reads, and a mono for code, paths, commands and the terminal.

### Hierarchy
Every size is one of the `--text-*` rungs; the app's page zoom (0.8 to 1.5, default 0.9) scales them all together.
- **Display** (600, 25px, -0.02em): a name in a dialog, the setup screen's heading.
- **Title** (600, 17px): a robot's name on the side card or hover card, the phone's headings.
- **Body** (400, 13.5px, 1.45): the default; 1.6 for a document read at length.
- **Control** (600, 12.5px): buttons, tabs, list rows, menu items.
- **Meta** (400, 11.5px): secondary rows, tips, small buttons.
- **Kicker** (600, 10.5px, 0.12em, uppercase, ink-cool): a section's label.
- **Badge** (700, 9.5px): counts and badges.
- On the phone a field's text is 16px, so iOS does not zoom.

### Named Rules
**The Rung Rule.** No font size, weight or tracking outside its token rung.

## Layout

The desktop app is three columns: the sidebar (islands and robots), the map or the board, and the side card. Grips resize the sidebar and side card. The board's bar and the map's view switch share one height (52px). The map is a grid of 44px cells (`--cell`, matched in `theme.ts`); its world zooms between 0.42 and 1.5, and robot cards keep their screen size. A robot opens in a terminal card over the map, with up to two panes (terminal, browser, files, changes).

Spacing uses the eight `--sp-*` rungs (2 to 24px); a gap or padding off the scale is a bug. Dense rows sit on 4 to 8px, sections on 16px, dialogs on 24px. The phone is its own bundle: one column, sheets from the bottom, 40px touch targets.

## Elevation & Depth

Depth is tonal first. Surfaces step lighter as they rise (surface-0, surface-1, surface-2). Over the map, glass blurs what is under it (7px for a label, 18px for a panel). Shadows come from one dark shade at four strengths: shadow-1 for a lifted pill, shadow-2 for a popover, shadow-3 for a dialog or panel. Map cards sit pressed into the ground on a soft dark patch, lift 6px on hover, and lift and grow a little when selected.

### Named Rules
**The Calm Map Rule.** On the map a selected pill (an island's label, the resources pill) brightens its border to line-strong and its glass to glass-hi; it never wears a blue ring. The board card keeps its blue selection ring.

## Shapes

Gently rounded and consistent: xs (4px) for icon buttons and badges, sm (6px) for fields, small buttons and rows, md (8px) for buttons, popovers and map labels, card (10px) for board cards, lg (12px) for dialogs and panels, pill for chips and counts. Borders are 1px cream hairlines. Icons are line drawings on 10, 12 or 24 unit grids with round caps.

## Components

Each repeated control is one primitive. New UI uses these classes instead of one-off rules, and puts only true differences in its own stylesheet. Primitives live in `base.css` under short label comments (`/* controls */`, `/* rows */`); the icon button and icons in `iconbutton.css` and `icons.css`, which the app, the phone and the site all load.

### Control scale
Three heights: 22px (`--ctl-sm`) for any control inside a settings or detail row, 26px (`--ctl-md`) for `.btn.sm`, chips and segmented controls, then the full `.btn`. A dense icon button can drop to 18px (`--ctl-xs`).

### Buttons
- **Button** (`.btn`): fill-2 at rest, fill-3 on hover, 600 weight, md radius. It scales to .97 while pressed.
- **Primary** (`.btn.pri`): sand with sand ink; hover lifts to sand-hi.
- **Small** (`.btn.sm`): 26px, sm radius, meta size; 22px inside a row.
- **Ghost** (`.btn.ghost`) and **danger** (`.btn.dan`, danger word).

### Icon buttons
- **Icon button** (`.ib`): a fixed 22px square (`.ib.xs` 18px, `.ib.touch` 40px on the phone), ghost in ink-3 until pointed at, then fill-2 and ink. `.ib.filled` keeps its fill; `.ib.bar` stretches to its bar's height and draws its focus ring inside.
- An icon-only control is a fixed box that centres its svg with grid and `place-items`, to within 0.5px. Icons come from `icons.tsx` (`display: block`, sized by `--icon-xs/sm/md/lg`: 10, 12, 15, 18px), never from text glyphs.

### Chips, segments and tabs
- **Chip** (`.pill`, `.pill.xs` 18px): a filter or toggle; fill-1 and ink-2, pressed in sand-fill with sand-hi text. Its count (`.n`) follows the pressed ink.
- **Segmented control** (`.seg`): one mode of a few; a sliding fill-3 glide sits behind the pressed button.
- **Document tab** (`.dtab`): the open tab is underlined in sand; an unsaved dot, then its close.

### Rows, menus and counts
- **List row** (`.list-row`, `.list-row.sm`): lights fill-1 under the pointer and keeps its pick at fill-2; its count turns ink-2 when picked.
- **Menu** (`.menu` with `.menu-item`, `.menu-sep`): lights only the row the pointer or keys are on; a destructive item reads in danger.
- **Count** (`.count`): a coral pill of robots that need you.
- **Banner** (`.banner.dan`, `.banner.warn`): a strip over what it is about, in the tone of what it reports.

### Surfaces
- **Dialog** (`.dialog`): solid surface-2, lg radius, shadow-3, over a dimmed backdrop.
- **Popover** (`.popover`): a menu, tip or utility panel; surface-2, md radius, shadow-2.
- **Panel** (`.panel`): glass over the map with an 18px blur, so its text reads over the cards.
- **Grips** (`.width-grip`, `.sec-grip`): invisible handles over an edge that show a line-strong hairline under the pointer and through the drag.

### Inputs / Fields
- **Field** (`.fld`): fill-1 inside a line-strong border (3:1 against its ground), sm radius, ink-3 placeholder. Focus turns the border sand; no glow.

### Robot cards
- **Map card**: cream paper with grain, a printed frame, the robot's portrait, its name in ink-land, and a foot in its status ink with the status word and a terminal toggle. Focus inside the paper is drawn in ink-sand, because sand would vanish there.
- **Board card** (`.kc`): surface-2 with a status dot and word, its note in ink-3, a coral tint when it needs you, and the blue selection ring when picked.

## Do's and Don'ts

### Do:
- **Do** build new UI from the primitives above (`.ib`, `.seg`, `.dtab`, `.pill`, `.btn.sm`, `.list-row`, `.menu-item`, `.menu`, `.count`, `.banner`, `.dialog`, `.popover`, `.panel`, `.width-grip`, `.sec-grip`) and icons from `icons.tsx`.
- **Do** write CSS in the house style: one rule per line, `prop: value;` with a space after the colon, wrapped by hand when long, token values only.
- **Do** add a token only when a value repeats or two places must match.
- **Do** measure contrast where the color is drawn, on the real ground, in hover and selected states too.
- **Do** give a status its word or shape wherever it is more than a dot.
- **Do** comment only what the code cannot say, in a line or two.

### Don't:
- **Don't** put a raw color in a stylesheet or script, or a raw spacing, radius, type size, duration or easing in a stylesheet.
- **Don't** use blue for focus or sand for selection.
- **Don't** put a blue ring on a map pill.
- **Don't** use a text glyph as an icon, or centre an icon with padding or line height.
- **Don't** write a one-off button, chip, row or menu when a primitive fits.
- **Don't** set text dimmer than ink-3.
