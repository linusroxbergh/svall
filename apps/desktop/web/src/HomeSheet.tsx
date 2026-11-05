import { useEffect, useRef, useState } from 'react';
import type { Result } from '@svall/protocol';
import { app } from './boot.js';
import { CloseX } from './CloseX.js';
import { dialogKeys, useApp } from './hooks.js';
import { startHost } from './hostRun.js';
import { Mark } from './icons.js';
import { MobilePanel } from './PhonePanel.js';

type Check = Result<'fleet.homeCheck'> | { error: string };

// what a move's run says of itself, in the order it goes: its marker is its own business
const STEPS = (name: string, back: boolean): [string, string][] => [
  ['check', 'Check'],
  ['mission', `Mission control's robots move to ${back ? 'this Mac' : name}`],
  ['pause', back ? `Pause ${name}` : 'Pause this Mac'],
  ['copy', 'Copy the fleet'],
  ['adopt', back ? 'This Mac takes over' : `${name} takes over`],
  ['join', back ? `${name} joins` : 'This Mac joins'],
  ['probe', 'Reconnect'],
];
const robotsAt = (n: number, where: string): string => `${n} ${where}`;

/** Moving the fleet's home to a worker, or back here, in the move sheet's style: what moves, its checks, then its steps as they run. */
export function HomeSheet() {
  const ask = useApp((s) => s.homeSheet);
  const host = useApp((s) => (s.host?.op === 'home' ? s.host : undefined));
  const [check, setCheck] = useState<Check>();
  const [started, setStarted] = useState(false);
  const shut = useRef<HTMLButtonElement>(null);
  const close = () => { app.store.getState().setHomeSheet(undefined); };
  const look = () => {
    if (!ask) return;
    setCheck(undefined);
    const api = app.api().local ?? app.api();
    api.call('fleet.homeCheck', { to: ask.back ? app.store.getState().via!.machine : ask.to }).then(setCheck, (e: Error) => setCheck({ error: e.message }));
  };
  useEffect(() => { setStarted(false); look(); }, [ask?.to, ask?.back]);
  if (!ask) return null;
  const { name, back } = ask;
  const shutUnlessRunning = () => { if (!(started && host?.running)) close(); };
  const go = () => { setStarted(true); startHost('home', { name: back ? 'local' : name }); };
  const run = started ? host : undefined;
  const refused = check && 'ok' in check && !check.ok ? check.refusal : undefined;
  const sheet = check && 'sheet' in check ? check.sheet : undefined;
  const failed = run?.steps.find((s) => s.status === 'fail');
  const done = !!run && !run.running && !failed && run.code === 0;
  const steps = STEPS(name, back);
  const reached = (step: string) => run?.steps.find((s) => s.step === step);
  return (
    <div className="modal-back" data-testid="home-sheet" onPointerDown={shutUnlessRunning}>
      <div className="modal dialog" role="dialog" aria-label={back ? 'Bring the fleet back' : `Make ${name} the home`} onPointerDown={(e) => e.stopPropagation()} onKeyDown={dialogKeys(shutUnlessRunning)}>
        <div className="kicker"><span data-testid="home-title">{back ? 'Bring the fleet back to this Mac' : `Make ${name} this fleet's home`}</span>{!run?.running && <CloseX ref={shut} onClose={close} testid="home-close" />}</div>
        {!run && !check && <div className="host-note" data-testid="home-checking"><span className="move-state"><span className="move-mark"><span className="move-spin" /></span>Checking that the fleet can move…</span></div>}
        {!run && check && 'error' in check && <div className="host-note" data-testid="home-error"><span>{check.error}</span></div>}
        {!run && sheet && (
          <div className="host-note" data-testid="home-summary">
            <span>The fleet's islands, notes, settings, phone pairing and push keys. Robots stay where they run: {back
              ? `${robotsAt(sheet.there, 'here')}, ${robotsAt(sheet.here, `on ${name}`)}`
              : `${robotsAt(sheet.here, 'here')}, ${robotsAt(sheet.there, `on ${name}`)}`}.</span>
            {sheet.mission.length > 0 && <span className="modal-sub" data-testid="home-mission">Mission control's {sheet.mission.length === 1 ? 'robot moves' : `${sheet.mission.length} robots move`} to {back ? 'this Mac' : name} first.</span>}
            {sheet.rewrites.map((r) => <span key={r.key} className="modal-sub" data-testid="home-rewrite">{r.key} becomes {r.to}</span>)}
          </div>
        )}
        {!run && refused && [refused, ...refused.more ?? []].map((b) => (
          <div key={b.reason} className="host-note" data-testid="home-refusal"><span><span data-testid="home-reason">{b.reason}</span><span className="modal-sub">{b.action}</span></span></div>
        ))}
        {!run && check && (
          <div className="acts">
            {check && 'ok' in check && check.ok && <button className="btn pri" data-testid="home-go" onClick={go}>{back ? 'Bring it back' : 'Make it the home'}</button>}
            {(!('ok' in check) || !check.ok) && <button className="btn" data-testid="home-again" onClick={look}>Check again</button>}
          </div>
        )}
        {run && (
          <ol className="move-steps" data-testid="home-steps">
            {steps.map(([step, words]) => {
              const at = reached(step);
              const now = !at ? 'todo' : at.status === 'start' ? 'doing' : at.status === 'fail' ? 'failed' : 'done';
              if (failed && now === 'todo') return null;
              if (at?.status === 'skip') return null;
              return (
                <li key={step} data-state={now} data-testid={`home-step-${step}`}>
                  <span className="move-mark" aria-hidden>{now === 'doing' ? <span className="move-spin" /> : <Mark status={({ done: 'ok', failed: 'fail', todo: 'todo' } as const)[now]} />}</span>
                  <span>{words}{now === 'failed' && at?.detail && <span className="modal-sub" data-testid="home-failed">{at.detail}</span>}{now === 'failed' && at?.action && <span className="modal-sub">{at.action}</span>}</span>
                </li>
              );
            })}
          </ol>
        )}
        {done && (
          <div data-testid="home-done">
            <div className="host-note">The fleet runs on {back ? 'this Mac' : name}. Open the phone from its new QR code once.</div>
            <MobilePanel />
            <div className="acts"><button className="btn pri" data-testid="home-finish" autoFocus onClick={close}>Done</button></div>
          </div>
        )}
        {run && !run.running && failed && <div className="acts"><button className="btn" data-testid="home-close-failed" onClick={close}>Close</button></div>}
      </div>
    </div>
  );
}
