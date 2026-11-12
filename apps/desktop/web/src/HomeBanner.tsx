import { useEffect, useRef, useState } from 'react';
import { crewAway, homeMoveStands } from '@svall/protocol';
import { app } from './boot.js';
import type { HostStep } from './bridge.js';
import { useApp } from './hooks.js';
import { startHost } from './hostRun.js';
import { machineNames, onThisMac, plainStep, splitRaw } from './host.js';
import { interruptOf, KEPT } from './MoveSheet.js';
import { copiedAt, machineOf, myMachine } from './placement.js';

const WAIT_MS = 5000;

const ended = (t: string): string => (/[.!?…]$/.test(t) ? t : `${t}.`);

// a run that failed, in the window's words: why, then what to do here, unless that was said elsewhere; what a tool said waits behind the pointer
function Failed({ step, alone = false, plain = onThisMac, testid }: { step: HostStep; alone?: boolean; plain?: (text: string) => string; testid: string }) {
  const { line, raw } = splitRaw(plain(step.detail ?? step.step));
  const todo = !alone && (step.say ?? step.action);
  return <span className="banner-sub" data-testid={testid} data-tip={step.raw ?? raw}>{todo ? `${ended(line)} ${ended(plain(todo))}` : ended(line)}</span>;
}

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
  const { name } = moving;
  // the fact, where the machine taking the fleet says the move stands, and what that means here
  const [fact, stands, rest] = moving.unmarked ? ['A move to this Mac did not take hold.', undefined, `${moving.from ?? 'Its old home'} is still the home.`]
    : moving.phase === 'unreachable' ? [`${name} is not answering.`, `The move to ${name} waits for it; this Mac takes no changes until then.`, undefined]
      : [`The fleet is moving to ${here ? 'this Mac' : name}.`, moving.phase && homeMoveStands(moving.phase, name),
        `${here ? moving.from ?? 'Its old home' : 'This Mac'} takes no changes until the move ends; robots keep running.`];
  return (
    <div className="banner warn" data-testid="home-move-banner">
      <span>
        <b>{fact}</b>
        {' '}
        <span className="banner-sub">
          {stands && <span data-testid="home-move-answer" data-tip={moving.answer}>{stands}</span>}
          {stands && rest && ' '}
          {rest}
        </span>
        {failed && <>{' '}<Failed step={failed} alone={run?.op === 'home'} testid="home-move-failed" /></>}
      </span>
      {!moving.unmarked && <button className="btn sm" data-testid="home-move-retry" disabled={running} onClick={() => startHost('home-retry', { name: '' })}>{run?.op === 'home-retry' && running ? 'Finishing…' : 'Finish the move'}</button>}
      <button className="btn sm" data-testid="home-move-abort" disabled={running} data-tip={moving.unmarked ? undefined : 'Works once the machine that holds the move says it was not taken'} onClick={() => startHost('home-abort', { name: '' })}>
        {run?.op === 'home-abort' && running ? (moving.unmarked ? 'Clearing it…' : 'Calling it off…') : moving.unmarked ? 'Clear it' : 'Call it off'}
      </button>
    </div>
  );
}

/** Mission control's robots a move that stopped left away from the home, and the way to bring them back. */
export function CrewAwayBanner() {
  const names = useApp((s) => new Intl.ListFormat('en').format(crewAway(s.fleet).map((r) => r.name)));
  const one = useApp((s) => crewAway(s.fleet).length === 1);
  // a move sends them to one machine
  const where = useApp((s) => { const at = crewAway(s.fleet)[0]; return at && (machineOf(s.fleet, at, s.via) ?? 'this Mac'); });
  const run = useApp((s) => (s.host?.op === 'home-crew' ? s.host : undefined));
  // a move that stands holds them where they are, so bringing them back could only fail
  const busy = useApp((s) => s.homeSheet !== undefined || s.homeMove !== undefined || (s.host?.running === true && s.host.op.startsWith('home')));
  const running = run?.running === true;
  if (!names || (busy && !running)) return null;
  const failed = running ? undefined : run?.steps.filter((s) => s.status === 'fail').at(-1);
  // one at work held them back: the next press carries the move sheet's choice, in its words
  const chosen = failed?.say ? interruptOf(failed.say) : undefined;
  return (
    <div className="banner warn" data-testid="crew-away-banner">
      <span>
        <b>Mission control's {names} {one ? 'is' : 'are'} still on {where}.</b>
        {' '}
        <span className="banner-sub">A move that stopped left {one ? 'it' : 'them'} there.</span>
        {failed && <>{' '}<Failed step={failed} alone={chosen !== undefined} testid="crew-away-failed" /></>}
      </span>
      <button className="btn sm" data-testid="crew-away-back" disabled={running} onClick={() => startHost('home-crew', { name: '', ...(chosen && { interrupt: true }) })}>
        {running ? 'Bringing them back…' : chosen ? KEPT[chosen] : 'Bring them back'}
      </button>
    </div>
  );
}

// a sentence the daemon gives in lower case, as the line under a banner's fact
const sentence = (t: string): string => ended(`${t[0].toUpperCase()}${t.slice(1)}`);

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
  // the release this Mac runs, beside the home's, while the two differ
  const [mine, setMine] = useState<string>();
  const gap = home?.state === 'version' && home.release !== undefined;
  useEffect(() => {
    if (!gap) return;
    let live = true;
    (app.api().local ?? app.api()).call('system.info', {}).then((i) => { if (live) setMine(i.release); }, () => {});
    return () => { live = false; };
  }, [gap]);
  if (!home || !fallback || (home.state !== 'unreachable' && home.state !== 'auth' && home.state !== 'version' && home.state !== 'mismatch' && home.state !== 'machine')) return null;
  const { name, state, detail, newer, release } = home;
  const upgrades = state === 'version' && !newer;
  const failed = running ? undefined : run?.steps.filter((s) => s.status === 'fail').at(-1);
  const age = copied !== undefined && copiedAt(copied);
  const [fact, sub] = state === 'auth' ? [`This Mac cannot log in to ${name}.`, detail && sentence(detail)]
    : state === 'version' && release ? [`${name} runs ${newer ? 'a newer' : 'an older'} Svall than this Mac.`, `${release} there${mine ? `, ${mine} here` : ''}.`]
      : state === 'version' ? [detail ?? `${name} runs another version of Svall`, undefined]
        : state === 'mismatch' ? [detail ?? `${name} holds a different fleet than this Mac expects`, undefined]
          : state === 'machine' ? [detail ?? `${name} is a different machine than this Mac expects`, undefined]
            : [`${name} is not reachable.`, `${age ? `Showing the fleet as of ${age}; robots` : 'Robots'} on this Mac keep working.`];
  return (
    <div className="banner warn" data-testid="home-banner" data-state={state}>
      <span>
        <b>{fact}</b>
        {sub && <>{' '}<span className="banner-sub" data-testid={state === 'auth' ? 'home-detail' : 'home-age'} data-tip={state === 'unreachable' ? detail : undefined}>{sub}</span></>}
        {failed && <>{' '}<Failed step={failed} alone plain={(t) => plainStep(t, machineNames(machines))} testid="home-upgrade-failed" /></>}
      </span>
      {upgrades && <button className="btn sm" data-testid="home-upgrade" disabled={running} onClick={() => startHost('upgrade', { name: machine! })}>{running ? `Upgrading ${name}…` : `Upgrade ${name}`}</button>}
      <button className="btn sm" data-testid="home-retry" disabled={running} onClick={() => app.api().retryHome()}>Try again</button>
    </div>
  );
}
