import { coastPath } from './map/coast.js';
import { theme } from './theme.js';

// the app icon's island (scripts/app-icon/gen.mjs), its wave-line contours washing out from the shore while svalld starts
const W = 56, H = 51, ROOM = 30, ICON = { n: 2.3, wobble: 0.1 };
const SAND = coastPath(W, H, 'round-2', 0, ICON);
const GRASS = coastPath(W, H, 'round-2', -4, ICON);

export function Starting() {
  return (
    <div className="starting">
      <svg viewBox={`${theme.pad - ROOM} ${theme.pad - ROOM} ${W + ROOM * 2} ${H + ROOM * 2}`} width={W + ROOM * 2} height={H + ROOM * 2} aria-hidden="true">
        {[0, 1, 2].map((i) => <path key={i} className="starting-wave" d={SAND} />)}
        <path d={SAND} fill="var(--bank)" transform="translate(0,3.3)" />
        <path d={SAND} fill="var(--sand)" />
        <path d={GRASS} fill="var(--grass)" />
      </svg>
      Starting the fleet…
    </div>
  );
}
