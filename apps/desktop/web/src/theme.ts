export const theme = {
  cell: 44,                       // world px per cell
  // a coastline's squircle exponent and how far the wobble strays from it, as a share of the short radius
  coast: { n: 4.5, wobble: 0.08 },
  pad: 132,                       // 3 * cell, drawing room around an island
  scale: { min: 0.42, max: 1.5 },
  // screen px the fit keeps clear of the world: the top clears the wordmark, mission control keeps its own water below
  fit: { x: 24, top: 56, bottom: 0 },
  bounds: { left: 1.4, right: 1.4, top: 1.3, bottom: 1.3 },  // cells; top reserves the island label
  panMargin: 40,
  fitEaseMs: 200,
  dragSettleMs: 140,
  hoverDelayMs: 300,
  hoverCardWidth: 274,
  hoverCardMaxH: 320,             // the hover card's tallest form; the flip threshold
  islandHotGraceMs: 400,
  // how long the window has to stand still before an auto arrange follows a resize
  autoArrangeMs: 320,
  toastMs: 2600,
  // how long launch waits on svalld before the connect screen shows the log
  connectGraceMs: 2500,
  // a toast offering to take something back stands long enough to be read and acted on
  toastActionMs: 9000,
  docSaveMs: 800,                 // a doc is written this long after the last edit
  card: { margin: 26, easeMs: 160 },
  // the little box that asks where a link should open, kept clear of the window's own edges
  linkAsk: { width: 200, height: 112, gap: 6, margin: 8 },
  // card box in token units; unit is one token unit in world px. a card keeps its screen size between map
  // scales `floor` and 1: below, it shrinks with the map so the ground an island reserves for it is finite;
  // above, it takes `grow` of the map's growth. `floor` is therefore how wide a card stands in cells at its
  // largest: at .78 a card and the rail of links down its right come to a hair under the three cells the
  // fleet keeps between crew, so the rail never reaches the card beside it
  token: { w: 2.56, h: 3.32 * 1.05, unit: 34, floor: 0.78, grow: 0.3 },
  // an island's label pill scales with the map up to 1, then takes `grow` of the map's growth
  label: { grow: 0.2 },
  // the home island: visible land above the bottom edge, gap to its label row, the row's own height and
  // its height from the edge when collapsed. the map height kept clear of the world is that row plus
  // `water`, so the fleet comes down to half a cell above the header pill
  home: { visible: 132, rowGap: 28, row: 28, bar: 16, water: 22 },
};

export const tokenPx = { w: theme.token.w * theme.token.unit, h: theme.token.h * theme.token.unit };
