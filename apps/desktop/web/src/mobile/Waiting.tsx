import { useState, type JSX } from 'react';
import type { Robot } from '@svall/protocol';
import { memoByValue, useApp } from '../hooks.js';
import { Caret } from '../icons.js';
import { MachineLine } from '../indicators.js';
import { machineOf } from '../placement.js';
import { figureOf, figureUrl } from '../portraits.js';
import { useAnswer } from './answer.js';
import { CloseRobot } from './CloseRobot.js';
import { Row } from './Fleet.js';
import { answersInline, blockedAsk, waitingOn } from './list.js';

const AskCard = memoByValue(function AskCard({ c, onOpen }: { c: Robot; onOpen(id: string): void }): JSX.Element | null {
  const island = useApp((s) => s.fleet.islands[c.islandId]?.name);
  const machine = useApp((s) => machineOf(s.fleet, c, s.via));
  const online = useApp((s) => s.status === 'online');
  const via = useApp((s) => s.via);
  const ask = blockedAsk(c);
  const { answering, error, answer } = useAnswer(c.id, ask?.agent.promptId, !!ask);
  if (!ask) return null;
  const prompt = ask.agent.prompt ?? `${c.name} is waiting on you`;
  const command = ask.agent.askedFor !== ask.agent.prompt ? ask.agent.askedFor : undefined;
  const inline = answersInline(c, ask, via);
  return (
    <article className="ask-card" aria-label={c.name}>
      <button type="button" className="ask-head" onClick={() => onOpen(c.id)}>
        <span className="face figure"><img src={figureUrl(figureOf(c))} alt="" /></span>
        <span className="row-text">
          <span className="row-name"><span>{c.name}</span>{machine && <MachineLine name={machine} short className="row-on" testid={`phone-machine-${c.id}`} />}</span>
          {island && <span className="row-sub">{island}</span>}
        </span>
        {/* the phone shows the main terminal only */}
        {!inline && <span className="ask-go">{ask.term === 2 ? 'on the Mac' : 'open'}<Caret dir="right" size="sm" /></span>}
      </button>
      <p className="ask-text">{prompt}</p>
      {command && <code>{command}</code>}
      {inline && (
        <span className="ask-acts">
          <button type="button" className="ask-yes" disabled={answering || !online} onClick={() => void answer('approve')}>approve</button>
          <button type="button" disabled={answering || !online} onClick={() => void answer('deny')}>deny</button>
        </span>
      )}
      {error && <p className="sheet-error">{error}</p>}
    </article>
  );
});

/** What waits on the user across the fleet: the asks, answered here when they are a yes or no, then the unread work. */
export function Waiting({ onOpen, onBack }: { onOpen(id: string): void; onBack(): void }): JSX.Element {
  const fleet = useApp((s) => s.fleet);
  const via = useApp((s) => s.via);
  const { asks, unread } = waitingOn(fleet, via);
  const status = useApp((s) => s.status);
  const [revealed, setRevealed] = useState<string>();
  const [closing, setClosing] = useState<string>();
  return (
    <div className="fleet waiting">
      <header className="top">
        <button type="button" className="back" onClick={onBack}><Caret dir="left" /> fleet</button>
        <h1>Waiting</h1>
        {status !== 'online' && <span className="conn" data-status={status}>{status}</span>}
      </header>
      {asks.length === 0 && unread.length === 0 && <p className="empty">Nothing waits on you.</p>}
      {asks.length > 0 && (
        <section aria-label="Needs you">
          <h2>Needs you · {asks.length}</h2>
          {asks.map((c) => <AskCard key={c.id} c={c} onOpen={onOpen} />)}
        </section>
      )}
      {unread.length > 0 && (
        <section aria-label="To review">
          <h2>To review · {unread.length}</h2>
          {unread.map((c) => (
            <Row key={c.id} c={c} revealed={revealed === c.id} onOpen={onOpen} onReveal={setRevealed}
              onClose={(id) => { setRevealed(undefined); setClosing(id); }} />
          ))}
        </section>
      )}
      {closing && <CloseRobot id={closing} onClose={() => setClosing(undefined)} />}
    </div>
  );
}
