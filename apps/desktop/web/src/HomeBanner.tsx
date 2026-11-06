import { useEffect, useRef } from 'react';
import { app } from './boot.js';
import { useApp } from './hooks.js';
import { startHost } from './hostRun.js';
import { machineNames, plainStep } from './host.js';

// the window's words for a home it does not follow, each with what a person can do about it
function said(name: string, state: string, detail?: string): string {
  if (state === 'auth') return `this Mac cannot log in to ${name}`;
  if (state === 'version') return detail ?? `${name} runs another release than this Mac`;
  if (state === 'mismatch') return detail ?? `${name} holds a different fleet than this Mac expects`;
  return `${name} is not reachable`;
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
  if (!home || !fallback || (home.state !== 'unreachable' && home.state !== 'auth' && home.state !== 'version' && home.state !== 'mismatch')) return null;
  const { name, state, detail, newer } = home;
  const upgrades = state === 'version' && !newer;
  const failed = running ? undefined : run?.steps.filter((s) => s.status === 'fail').at(-1);
  return (
    <div className="banner warn" data-testid="home-banner" data-state={state}>
      <span>
        {said(name, state, detail)}
        {state !== 'version' && state !== 'mismatch' && detail && <small data-testid="home-detail"> {detail}</small>}
        {failed && <small data-testid="home-upgrade-failed"> {plainStep(failed.detail ?? failed.step, machineNames(machines))}</small>}
        {copied !== undefined && <small data-testid="home-age"> · showing the fleet as of {new Date(copied).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</small>}
      </span>
      {upgrades && <button className="btn sm" data-testid="home-upgrade" disabled={running} onClick={() => startHost('upgrade', { name: machine! })}>{running ? `Upgrading ${name}…` : `Upgrade ${name}`}</button>}
      <button className="btn sm" data-testid="home-retry" disabled={running} onClick={() => app.api().retryHome()}>Try again</button>
    </div>
  );
}
