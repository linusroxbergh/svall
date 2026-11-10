import { useEffect, useRef } from 'react';
import { crewAway } from '@svall/protocol';
import { app } from './boot.js';
import type { HostStep } from './bridge.js';
import { useApp } from './hooks.js';
import { startHost } from './hostRun.js';
import { machineNames, onThisMac, plainStep } from './host.js';
import { interruptOf, KEPT } from './MoveSheet.js';
import { myMachine } from './placement.js';

// the window's words for a home it does not follow, each with what a person can do about it
function said(name: string, state: string, detail?: string): string {
  if (state === 'auth') return `this Mac cannot log in to ${name}`;
  if (state === 'version') return detail ?? `${name} runs another version of Svall`;
  if (state === 'mismatch') return detail ?? `${name} holds a different fleet than this Mac expects`;
  if (state === 'machine') return detail ?? `${name} is a different machine than this Mac expects`;
  return `${name} is not reachable`;
}

const WAIT_MS = 5000;

// where the machine holding the fleet says the move stands, for a person who has not followed it
const STANDS: Record<string, (name: string) => string> = {
  unreachable: (n) => `${n} does not answer; the move waits until it does.`,
  unknown: (n) => `${n} cannot say how the move went; the move waits until it can.`,
  staging: (n) => `${n} has not received the fleet's files yet.`,
  staged: (n) => `${n} holds the fleet's files and has not taken over.`,
  installed: (n) => `${n} has the fleet's files in place and is starting as its home.`,
  stopping: (n) => `${n} went back as it was, and its daemon has not started again.`,
  rolledback: (n) => `${n} tried to take over and went back as it was.`,
  adopted: (n) => `${n} has taken over.`,
  done: (n) => `${n} has taken over.`,
};
const stands = (phase: string, name: string): string => STANDS[phase]?.(name) ?? `${name} is at work on the move.`;

// a run that failed, in the window's words: why, then what to do here; the sheet's own says why alone, as what it says to do was for the sheet
const failedLine = (s: HostStep, sheet: boolean): string => onThisMac([s.detail ?? s.step, !sheet && (s.say ?? s.action)].filter(Boolean).join('. '));

/** A move of the fleet's home that nothing is driving: this Mac's daemon waits on how it ends, and a person finishes it or calls it off. */
export function HomeMoveBanner() {
  const moving = useApp((s) => s.homeMove);
  // this Mac by its id, which a window that no longer follows another home still knows
  const here = useApp((s) => !!s.homeMove && s.homeMove.to === myMachine(s));
  const online = useApp((s) => s.status === 'online');
  const run = useApp((s) => (s.host?.op === 'home' || s.host?.op === 'home-retry' || s.host?.op === 'home-abort' ? s.host : undefined));
  const sheet = useApp((s) => s.homeSheet);
  useEffect(() => {
    if (!online) return;
    let left = false;
    const said = (m?: typeof moving) => { if (!left) app.store.getState().setHomeMove(m); };
    // a poll that fails says nothing of the move, whose last answer stands
    const look = () => { void (app.api().local ?? app.api()).call('fleet.homeMove', { op: 'status' }).then((r) => said(r.moving), () => undefined); };
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
        {moving.unmarked ? `A move of the fleet to this Mac has not taken hold, and ${moving.from ?? 'its old home'} is still the home. Abort clears it, which a new move needs.`
          : here ? `The fleet is moving to this Mac, and ${moving.from ?? 'its old home'} takes no changes until the move ends; robots keep running.`
            : `The fleet is moving to ${moving.name}, and this Mac takes no changes until the move ends; robots keep running.`}
        {moving.phase && <small data-testid="home-move-answer" data-tip={moving.answer}> {stands(moving.phase, moving.name)}</small>}
        {failed && <small data-testid="home-move-failed"> {failedLine(failed, run?.op === 'home')}</small>}
      </span>
      {!moving.unmarked && <button className="btn sm" data-testid="home-move-retry" disabled={running} onClick={() => startHost('home-retry', { name: '' })}>{run?.op === 'home-retry' && running ? 'Finishing…' : 'Finish the move'}</button>}
      <button className="btn sm" data-testid="home-move-abort" disabled={running} data-tip={moving.unmarked ? undefined : 'Works once the machine that holds the move says it was not taken'} onClick={() => startHost('home-abort', { name: '' })}>{run?.op === 'home-abort' && running ? 'Calling it off…' : 'Abort'}</button>
    </div>
  );
}

/** Mission control's robots a move that stopped left away from the home, and the way to bring them back. */
export function CrewAwayBanner() {
  const away = useApp((s) => crewAway(s.fleet).map((r) => r.name).join(', '));
  const run = useApp((s) => (s.host?.op === 'home-crew' ? s.host : undefined));
  // a move that stands holds them where they are, so bringing them back could only fail
  const busy = useApp((s) => s.homeSheet !== undefined || s.homeMove !== undefined || (s.host?.running === true && s.host.op.startsWith('home')));
  const running = run?.running === true;
  if (!away || (busy && !running)) return null;
  const failed = running ? undefined : run?.steps.filter((s) => s.status === 'fail').at(-1);
  // one at work held them back: the next press carries the move sheet's choice, in its words
  const chosen = failed?.say ? interruptOf(failed.say) : undefined;
  return (
    <div className="banner warn" data-testid="crew-away-banner">
      <span>
        Mission control's {away} stayed where a move that stopped sent them
        {failed && <small data-testid="crew-away-failed"> {chosen ? onThisMac(failed.detail ?? failed.step) : failedLine(failed, false)}</small>}
      </span>
      <button className="btn sm" data-testid="crew-away-back" disabled={running} onClick={() => startHost('home-crew', { name: '', ...(chosen && { interrupt: true }) })}>
        {running ? 'Bringing them back…' : chosen ? KEPT[chosen] : 'Bring them back'}
      </button>
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
