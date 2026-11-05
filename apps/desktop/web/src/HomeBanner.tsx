import { useEffect, useRef, useState } from 'react';
import { crewAway, type Result } from '@svall/protocol';
import { app } from './boot.js';
import { useApp } from './hooks.js';
import { startHost } from './hostRun.js';
import { machineNames, plainStep } from './host.js';

// the window's words for a home it does not follow, each with what a person can do about it
function said(name: string, state: string, detail?: string): string {
  if (state === 'auth') return `this Mac cannot log in to ${name}`;
  if (state === 'version') return detail ?? `${name} runs another version of Svall`;
  if (state === 'mismatch') return detail ?? `${name} holds a different fleet than this Mac expects`;
  if (state === 'machine') return detail ?? `${name} is a different machine than this Mac expects`;
  return `${name} is not reachable`;
}

const WAIT_MS = 5000;

/** A move of the fleet's home that nothing is driving: this Mac's daemon waits on how it ends, and a person finishes it or calls it off. */
export function HomeMoveBanner() {
  const [moving, setMoving] = useState<Result<'fleet.homeMove'>['moving']>();
  const online = useApp((s) => s.status === 'online');
  const run = useApp((s) => (s.host?.op === 'home' || s.host?.op === 'home-retry' || s.host?.op === 'home-abort' ? s.host : undefined));
  const sheet = useApp((s) => s.homeSheet);
  useEffect(() => {
    if (!online) return;
    let left = false;
    const look = () => { void (app.api().local ?? app.api()).call('fleet.homeMove', { op: 'status' }).then((r) => { if (!left) setMoving(r.moving); }, () => { if (!left) setMoving(undefined); }); };
    look();
    const timer = setInterval(look, WAIT_MS);
    return () => { left = true; clearInterval(timer); };
  }, [online]);
  if (!moving || sheet) return null;
  const running = run?.running === true;
  const failed = running ? undefined : run?.steps.filter((s) => s.status === 'fail').at(-1);
  return (
    <div className="banner warn" data-testid="home-move-banner">
      <span>
        {moving.to === app.store.getState().via?.machine ? 'Finishing the move to this Mac…' : `Finishing the move to ${moving.name}…`}
        {moving.answer && <small data-testid="home-move-answer"> {moving.answer}</small>}
        {failed && <small data-testid="home-move-failed"> {failed.detail ?? failed.step}</small>}
      </span>
      <button className="btn sm" data-testid="home-move-retry" disabled={running} onClick={() => startHost('home-retry', { name: '' })}>{run?.op === 'home-retry' && running ? 'Finishing…' : 'Finish the move'}</button>
      <button className="btn sm" data-testid="home-move-abort" disabled={running} data-tip="Works once the machine that holds the move says it was not taken" onClick={() => startHost('home-abort', { name: '' })}>Abort</button>
    </div>
  );
}

/** Mission control's robots a move that stopped left away from the home, and the way to bring them back. */
export function CrewAwayBanner() {
  const away = useApp((s) => crewAway(s.fleet).map((r) => r.name).join(', '));
  const run = useApp((s) => (s.host?.op === 'home-crew' ? s.host : undefined));
  const busy = useApp((s) => s.homeSheet !== undefined || (s.host?.running === true && s.host.op.startsWith('home')));
  const running = run?.running === true;
  if (!away || (busy && !running)) return null;
  const failed = running ? undefined : run?.steps.filter((s) => s.status === 'fail').at(-1);
  return (
    <div className="banner warn" data-testid="crew-away-banner">
      <span>
        Mission control's {away} stayed where a move that stopped sent them
        {failed && <small data-testid="crew-away-failed"> {failed.detail ?? failed.step}</small>}
      </span>
      <button className="btn sm" data-testid="crew-away-back" disabled={running} onClick={() => startHost('home-crew', { name: '' })}>{running ? 'Bringing them back…' : 'Bring them back'}</button>
    </div>
  );
}

/** How this window stands with a fleet's home on another machine; nothing while it follows one, or has yet to hear. */
export function HomeBanner() {
  const home = useApp((s) => s.home);
  const fallback = useApp((s) => !!s.via && !s.via.online);
  const copied = useApp((s) => (s.via && !s.via.online ? s.fleet.machines?.[s.via.home]?.snapshot?.at : undefined));
  const machine = useApp((s) => s.via?.home);
  const run = useApp((s) => (s.host?.op === 'upgrade' && s.host.args.name === s.via?.home ? s.host : undefined));
  const machines = useApp((s) => s.machines);
  const running = run?.running === true;
  const was = useRef(running);
  // an upgrade that ran through or not says so by what the home answers next
  useEffect(() => {
    if (was.current && !running) app.api().retryHome();
    was.current = running;
  }, [running]);
  if (!home || !fallback || (home.state !== 'unreachable' && home.state !== 'auth' && home.state !== 'version' && home.state !== 'mismatch' && home.state !== 'machine')) return null;
  const { name, state, detail, newer } = home;
  const upgrades = state === 'version' && !newer;
  const failed = running ? undefined : run?.steps.filter((s) => s.status === 'fail').at(-1);
  return (
    <div className="banner warn" data-testid="home-banner" data-state={state}>
      <span>
        {said(name, state, detail)}
        {state !== 'version' && state !== 'mismatch' && state !== 'machine' && detail && <small data-testid="home-detail"> {detail}</small>}
        {failed && <small data-testid="home-upgrade-failed"> {plainStep(failed.detail ?? failed.step, machineNames(machines))}</small>}
        {copied !== undefined && <small data-testid="home-age"> · showing the fleet as of {new Date(copied).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</small>}
      </span>
      {upgrades && <button className="btn sm" data-testid="home-upgrade" disabled={running} onClick={() => startHost('upgrade', { name: machine! })}>{running ? `Upgrading ${name}…` : `Upgrade ${name}`}</button>}
      <button className="btn sm" data-testid="home-retry" disabled={running} onClick={() => app.api().retryHome()}>Try again</button>
    </div>
  );
}
