export const theme = {
  cell: 44,                       // world px per cell
  // a coastline's squircle exponent and how far the wobble strays from it, as a share of the short radius
  coast: { n: 4.5, wobble: 0.08 },
  pad: 132,                       // 3 * cell, drawing room around an island
  scale: { min: 0.42, max: 1.5 },
  // screen px the fit keeps between what the world draws and the map's edges: the top and sides match, and so does
  // the bottom with the water mission control keeps above its row
  fit: { x: 56, top: 56, bottom: 34 },
  bounds: { top: 1.48 },          // cells; the island label's band over its land
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
  // a cleared toast stays this long, sinking away; --dur-slow matches it
  toastLeaveMs: 200,
  // how long launch waits on svalld before the connect screen shows the log
  connectGraceMs: 10_000,
  // a toast offering to take something back stands long enough to be read and acted on
  toastActionMs: 9000,
  docSaveMs: 800,                 // a doc is written this long after the last edit
  resourcesFreshMs: 3000,         // a listing read this recently serves the next ask
  card: { margin: 26, easeMs: 160 },
  // a press on the board that travels dragPx is a drag; a robot that arrived in a column within arriveMs glows as it is drawn
  board: { dragPx: 4, arriveMs: 1400 },
  // the little box that asks where a link should open, kept clear of the window's own edges
  linkAsk: { width: 200, height: 112, gap: 6, margin: 8 },
  // a right-click menu keeps this far inside the window
  menu: { margin: 8 },
  // card box in token units, unit one token unit in world px; a card keeps its screen size between map scales `floor`
  // and 1, above that taking `grow` of the growth. At .88 a card and the link rail on its right stay inside the three cells between crew
  // `band` is the strip a robot on a worker wears above its card, which map.css matches
  token: { w: 2.66, h: 3.73, unit: 36.1, floor: 0.88, grow: 0.5, band: 0.38 },
  // an island's label pill scales with the map up to 1, then takes `grow` of the map's growth
  label: { grow: 0.2 },
  // the home island: visible land above the bottom edge, tall enough that a crew card at its largest clears it, gap to
  // its label row, the row's own height, its height from the edge when collapsed, and how far it grows with the cards.
  // the map height kept clear of the world is that row plus `water`, so the fleet stops half a cell above the header pill
  home: { visible: 154, rowGap: 28, row: 28, bar: 16, water: 22, max: 1.1 },
};

export const tokenPx = { w: theme.token.w * theme.token.unit, h: theme.token.h * theme.token.unit };
