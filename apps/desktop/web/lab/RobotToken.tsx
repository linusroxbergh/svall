import type { Cell, Character } from '@svall/protocol';
import { contextPctOf, isUnread, slotStatus, type DisplayStatus } from '../src/selectors.js';
import { LinkIcon } from '../src/map/LinkIcon.js';
import { theme, tokenPx } from '../src/theme.js';
import { statusWord } from '../src/map/tokenText.js';

export type Variant = 'stand' | 'cells' | 'wide' | 'band' | 'footer' | 'pole' | 'signal' | 'pack' | 'seam' | 'screen' | 'lcd';
export type Robot = { id: string; ar: number; tint: string };

function footInner(c: Character, status: DisplayStatus, word: string | undefined) {
  return (
    <>
      {c.second && (
        <span className="pips"><i className="pip" data-status={slotStatus(c, 1)} /><i className="pip" data-status={slotStatus(c, 2)} /></span>
      )}
      {status === 'working' && <span className="dots" aria-hidden="true"><i /><i /><i /></span>}
      {word && <span className="sw" style={{ background: `var(--${status})`, color: `var(--ink-on-${status})` }}>{word}</span>}
    </>
  );
}

function gem(status: DisplayStatus, unread: boolean) {
  if (status === 'blocked') return <span className="gem blocked">!</span>;
  if (status === 'done' && unread) return <span className="gem done">✓</span>;
  if (status === 'working') return <span className="gem working" />;
  return null;
}

// the artwork as an image, or as a one-colour mask for the silhouette palettes;
// a pale copy sits under the mask, shown only by the riso palette as an offset print
const Robo = ({ r }: { r: Robot }) => {
  const style = { ['--art' as string]: `url(./robots/${r.id}.svg)`, ['--ar' as string]: r.ar };
  return (
    <>
      <img className="robo art" src={`./robots/${r.id}.svg`} alt="" draggable={false} style={style} />
      <i className="robo shade" style={style} />
      <i className="robo" style={style} />
    </>
  );
};

// the standing robots wear the status gem as a badge on the card's corner; the screens light it inside the screen
const STANDING = new Set<Variant>(['stand', 'cells', 'wide', 'band', 'footer', 'pole', 'signal', 'pack', 'seam']);

// every gauge is a battery: it shows the context still left, so it drains as the session fills
const left = (pct: number | undefined): number => (pct == null ? 0 : 100 - pct);

// n cells, lit for the context left
const Cells = ({ pct, n = 5, cls = '' }: { pct: number | undefined; n?: number; cls?: string }) => (
  <div className={`cells ${cls}`} aria-hidden="true">
    {Array.from({ length: n }, (_, i) => <i key={i} data-on={pct != null && left(pct) > (i * 100) / n + 4} />)}
  </div>
);

// one battery whose charge is the context left, low at a fifth
const Pack = ({ pct, cls }: { pct: number | undefined; cls: string }) => (
  <span className={`pack ${cls}`} data-low={pct != null && left(pct) <= 20} aria-hidden="true"><i style={{ width: `${left(pct)}%` }} /></span>
);

function art(v: Variant, c: Character, r: Robot, status: DisplayStatus) {
  const pct = contextPctOf(c);
  const name = <div className="nm"><span>{c.name}</span></div>;
  if (STANDING.has(v)) {
    return (
      <>
        {name}
        <div className="stage">
          {v === 'pole' && <Cells pct={pct} cls="pole" />}
          {v === 'signal' && <Cells pct={pct} n={4} cls="signal" />}
          <Robo r={r} />
        </div>
        {v === 'cells' && <Cells pct={pct} />}
        {v === 'wide' && <Cells pct={pct} cls="wide" />}
        {v === 'pack' && <Pack pct={pct} cls="floor" />}
        {v === 'seam' && <div className="seam" aria-hidden="true"><i style={{ width: `${left(pct)}%` }} /></div>}
      </>
    );
  }
  const g = gem(status, isUnread(c));
  if (v === 'lcd') {
    return (
      <>
        <div className="screen">
          <Robo r={r} />
          {g}
          <span className="batt" aria-hidden="true">
            {[0, 1, 2].map((i) => <i key={i} data-on={pct != null && left(pct) > i * 33 + 4} />)}
          </span>
        </div>
        {name}
      </>
    );
  }
  return (
    <>
      <div className="screen">
        <Robo r={r} />
        {g}
      </div>
      <Cells pct={pct} />
      {name}
    </>
  );
}

export function RobotToken({ c, robot, variant, status, world }: {
  c: Character;
  robot: Robot;
  variant: Variant;
  status: DisplayStatus;
  world: Cell;
}) {
  const word = statusWord(status);
  const pct = contextPctOf(c);
  return (
    <div
      className={`tok s-${status} rv-${variant}${STANDING.has(variant) ? ' standing' : ' screened'}`}
      data-status={status}
      data-tint={robot.tint}
      style={{
        left: `calc(${(world.x + 0.5) * theme.cell}px * var(--ms))`,
        top: `calc(${(world.y + 0.5) * theme.cell}px * var(--ms))`,
        ['--tok' as string]: `${theme.token.unit}px`,
        ['--card-w' as string]: `${tokenPx.w}px`,
        ['--card-h' as string]: `${tokenPx.h}px`,
        ['--tint' as string]: `var(--pt-${robot.tint})`,
      }}
    >
      <div className="card">
        {variant === 'band' ? <div className="edge"><i style={{ width: `${left(pct)}%` }} /></div> : <div className="edge" />}
        {art(variant, c, robot, status)}
        <button type="button" className="foot" tabIndex={-1}>
          {footInner(c, status, word)}
          {variant === 'footer' && <Pack pct={pct} cls="in-foot" />}
          <svg className="tg" viewBox="0 0 10 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1.4 1.6 4 4.4 1.4 7.2" />
            <path d="M5.8 7.2h2.8" />
          </svg>
        </button>
      </div>
      {STANDING.has(variant) && <span className="corner">{gem(status, isUnread(c))}</span>}
      {c.context.length > 0 && (
        <div className="rail">
          {c.context.map((l, i) => (
            <span key={`${l.ref}-${i}`} className="chip lk" title={l.ref}><LinkIcon item={l} /></span>
          ))}
        </div>
      )}
    </div>
  );
}
