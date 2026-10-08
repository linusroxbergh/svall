import { useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { preloadRobots, ROBOTS, robotUrl } from './cast.js';
import type { Robot } from './RobotToken.js';
import '../src/styles.css';
import './side.css';

// The side card's head with a robot in place of the animal, in mock panels built from the app's own classes.

type Status = 'working' | 'blocked' | 'done' | 'idle' | 'shell';
type Opt = 'today' | 'swap' | 'card' | 'banner' | 'row' | 'kicker' | 'tile';

const OPTS: { o: Opt; id: string; title: string; note: string }[] = [
  { o: 'today', id: '–', title: 'Today', note: 'The animal disc beside the name, and context as a meter under Details.' },
  { o: 'swap', id: 'A', title: 'Straight swap', note: 'Today\'s card with the robot standing in the disc\'s 52px place; context stays the meter under Details.' },
  { o: 'card', id: 'B', title: 'The map card, bigger', note: 'The head is the 4f card itself on cream: status band, name, the robot standing, the cells above the foot.' },
  { o: 'banner', id: 'C', title: 'Banner', note: 'A full-width band in the robot\'s pale colour, the robot standing large on the cells; name and branch under it.' },
  { o: 'row', id: 'D', title: 'Standing beside the name', note: 'A taller robot at the left, name and branch beside it, all standing on one row of cells.' },
  { o: 'kicker', id: 'E', title: 'Cells in the status line', note: 'Compact: the cells and the percentage join the status line, the robot sits in a small tile by the name.' },
  { o: 'tile', id: 'F', title: 'Tile', note: 'The robot stands in a rounded tile in its pale colour beside the name; the cells and how much is left sit under it.' },
];

const NAME = 'checkout redesign';
const CTX = 46;

function Caret() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3.6 5 6.6l3-3" />
    </svg>
  );
}

function Star() {
  return (
    <button className="side-star" aria-label="Star">
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
        <path d="M6 1.4 7.18 4.78l3.58.08-2.86 2.16 1.04 3.43L6 8.4l-2.94 2.05 1.04-3.43-2.86-2.16 3.58-.08z" />
      </svg>
    </button>
  );
}

// the name field, as plain text so a long name wraps without the field's sizing script
const Name = ({ cls = '' }: { cls?: string }) => <div className={`h2 sname2 ${cls}`}>{NAME}</div>;

// five cells, lit for the context left
function Cells({ pct, cls = '' }: { pct: number | undefined; cls?: string }) {
  const left = pct == null ? 0 : 100 - pct;
  return (
    <div className={`scells ${cls}`} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => <i key={i} data-on={pct != null && left > i * 20 + 4} />)}
    </div>
  );
}

// the robot with the steppers that page through the set on hover
function Picker({ r, cls, children }: { r: Robot; cls: string; children?: ReactNode }) {
  return (
    <div className={`side-portrait ${cls}`}>
      <button className="pnav" aria-label="Previous robot">‹</button>
      {children}
      <img className="srobo" src={robotUrl(r)} alt="" draggable={false} style={{ aspectRatio: r.ar }} />
      <button className="pnav" aria-label="Next robot">›</button>
    </div>
  );
}

const Branch = () => (
  <div className="side-branch"><span className="mono">checkout-redesign</span><span className="badge">wt</span></div>
);

function Kicker({ status, children }: { status: Status; children?: ReactNode }) {
  return (
    <div className="kicker" style={{ color: `var(--${status})` }}>
      <i className="sdot" data-status={status} />{status}{children}
    </div>
  );
}

function Head({ o, r, status, pct }: { o: Opt; r: Robot; status: Status; pct: number | undefined }) {
  const left = pct == null ? undefined : 100 - pct;
  switch (o) {
    case 'today':
      return (
        <>
          <Kicker status={status} />
          <div className="side-head">
            <div className="side-portrait">
              <button className="pnav">‹</button>
              <span className="pdisc" data-tint="earth"><img className="portrait-img" src="./animals/fox.svg" alt="" /></span>
              <button className="pnav">›</button>
            </div>
            <Name /><Star />
          </div>
          <Branch />
        </>
      );
    case 'swap':
      return (
        <>
          <Kicker status={status} />
          <div className="side-head">
            <Picker r={r} cls="stand" />
            <Name /><Star />
          </div>
          <Branch />
        </>
      );
    case 'card':
      return (
        <>
          <Kicker status={status} />
          <div className={`mini on-cream s-${status}`}>
            <i className="edge" />
            <div className="mini-top"><Name cls="mini-name" /><Star /></div>
            <Picker r={r} cls="mini-stage" />
            <Cells pct={pct} cls="mini-cells" />
          </div>
          <Branch />
        </>
      );
    case 'banner':
      return (
        <>
          <div className={`banner on-cream s-${status}`} style={{ ['--tint' as string]: `var(--pt-${r.tint})` }}>
            <Kicker status={status} />
            <Picker r={r} cls="banner-stage" />
            <Cells pct={pct} cls="banner-cells" />
          </div>
          <div className="side-head"><Name /><Star /></div>
          <Branch />
        </>
      );
    case 'row':
      return (
        <>
          <Kicker status={status} />
          <div className="rowhead">
            <Picker r={r} cls="row-stage" />
            <div className="row-text"><div className="side-head"><Name /><Star /></div><Branch /></div>
          </div>
          <Cells pct={pct} cls="row-cells" />
        </>
      );
    case 'kicker':
      return (
        <>
          <Kicker status={status}>
            <span className="spacer" />
            <Cells pct={pct} cls="kick-cells" />
            <b className="kick-pct tnum">{left == null ? '–' : `${left}%`}</b>
          </Kicker>
          <div className="side-head">
            <Picker r={r} cls="small-tile" ><i className="tile-bg" style={{ ['--tint' as string]: `var(--pt-${r.tint})` }} /></Picker>
            <Name /><Star />
          </div>
          <Branch />
        </>
      );
    case 'tile':
      return (
        <>
          <Kicker status={status} />
          <div className="side-head">
            <Picker r={r} cls="big-tile"><i className="tile-bg" style={{ ['--tint' as string]: `var(--pt-${r.tint})` }} /></Picker>
            <div className="tile-text"><Name /><Branch /></div>
            <Star />
          </div>
          <div className="tile-meter">
            <Cells pct={pct} />
            <span className="tnum">{left == null ? 'no agent' : `${left}% left`}</span>
          </div>
        </>
      );
  }
}

function Panel({ o, r, status }: { o: Opt; r: Robot; status: Status }) {
  const pct = status === 'shell' ? undefined : CTX;
  return (
    <aside className="side" data-opt={o} style={{ ['--st' as string]: `var(--${status})` }}>
      <div className="head-wrap"><Head o={o} r={r} status={status} pct={pct} /></div>
      <div className="side-secs">
        <section className="sec" data-open="true" data-fit="true">
          <div className="kicker"><button type="button" className="sec-fold"><Caret />Note</button></div>
          <div className="sec-body">
            <textarea className="fld desc" rows={6} readOnly
              value="Rebuild the checkout page on the new design: one-page flow, saved addresses first, Apple Pay above the fold." />
          </div>
        </section>
        <section className="sec" data-open="true" data-fit="true">
          <div className="kicker"><button type="button" className="sec-fold"><Caret />Context</button></div>
          <div className="sec-body">
            <div className="pills">
              <span className="lp"><i className="lg">#</i><a className="clip-head">storefront #6</a></span>
              <span className="lp"><i className="lg">#</i><a className="clip-head">SHOP-150</a></span>
            </div>
          </div>
        </section>
        <section className="sec" data-open="true" data-fit="true">
          <div className="kicker"><button type="button" className="sec-fold"><Caret />Details</button></div>
          <div className="sec-body">
            <div className="rows">
              <div className="row"><span>island</span><b>storefront</b></div>
              <div className="row"><span>model</span><b className="mono">claude-opus-5-5</b></div>
              <div className="row"><span>context</span>
                {o === 'today' || o === 'swap'
                  ? <div className="meter"><span><i style={{ width: `${CTX}%`, background: `var(--${status})` }} /></span><b className="tnum">{CTX}%</b></div>
                  : <b className="tnum">{pct == null ? '–' : `${pct}% used`}</b>}
              </div>
              <div className="row"><span>last activity</span><b className="tnum">12s ago</b></div>
            </div>
          </div>
        </section>
      </div>
      <div className="acts">
        <button className="btn pri">Open terminal</button>
        <button className="btn dan">Delete character</button>
      </div>
    </aside>
  );
}

const STATUSES: Status[] = ['working', 'blocked', 'done', 'idle', 'shell'];

function Lab() {
  const q = new URLSearchParams(location.search);
  const [ri, setRi] = useState(Number(q.get('r') ?? 1));
  const [status, setStatus] = useState<Status>((q.get('s') as Status) ?? 'working');
  const only = q.get('o');
  const r = ROBOTS[ri];
  return (
    <main className="lab">
      <header>
        <h1>Robot side card</h1>
        <div className="ctl">
          <span>Robot</span>
          <button type="button" onClick={() => setRi((ri + ROBOTS.length - 1) % ROBOTS.length)}>‹</button>
          <b className="tnum">{ri + 1}</b>
          <button type="button" onClick={() => setRi((ri + 1) % ROBOTS.length)}>›</button>
          <span>Status</span>
          {STATUSES.map((s) => <button key={s} type="button" aria-pressed={s === status} onClick={() => setStatus(s)}>{s}</button>)}
        </div>
      </header>
      <div className="panels">
        {OPTS.map(({ o, id, title, note }) => (!only || only === o) && (
          <section key={o} className="opt" data-opt={o}>
            <h2><b>{id}</b> {title}</h2>
            <p>{note}</p>
            <div className="frame"><Panel o={o} r={r} status={status} /></div>
          </section>
        ))}
      </div>
    </main>
  );
}

await preloadRobots();
createRoot(document.getElementById('root')!).render(<Lab />);
