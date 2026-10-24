import type { ReactNode } from 'react';
import type { Robot, LoadRobot, LoadUsage } from '@svall/protocol';
import { sleepRobot } from './actions.js';
import { app, deps } from './boot.js';
import { useApp } from './hooks.js';
import { useLoad } from './load.js';
import { coresText, memText } from './loadText.js';
import { slotStatus } from './selectors.js';

const Moon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
  </svg>
);

const Cross = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

// the figure large, its unit small
function Total({ label, text, testid }: { label: string; text: string; testid?: string }) {
  const n = /^[\d.]+/.exec(text)?.[0] ?? '';
  return <div><span>{label}</span><b className="tnum" data-testid={testid}>{n}<small>{text.slice(n.length)}</small></b></div>;
}

// the bar is the row's share of all the cpu the panel counts
function Row({ testid, name, use, of, appRow, children }: { testid: string; name: ReactNode; use: LoadUsage; of: number; appRow?: boolean; children?: ReactNode }) {
  return (
    <div className="load-row" data-testid={testid} data-app={appRow || undefined}>
      {name}
      <span className="load-n">{coresText(use.cpu)}</span>
      <span className="load-n">{memText(use.mem)}</span>
      <span className="load-n">{use.procs}</span>
      <span className="load-acts">{children}</span>
      <span className="load-bar"><i style={{ width: `${of > 0 ? Math.min(use.cpu / of, 1) * 100 : 0}%` }} /></span>
    </div>
  );
}

function RobotRow({ c, use, of }: { c: Robot; use: LoadRobot; of: number }) {
  const open = () => { app.store.getState().focus(c.id); app.store.getState().toggleLoad(false); };
  // a robot mid-turn in either terminal, working or waiting on the user, would lose that turn, so its sleep asks first
  const sleep = () => {
    if (([1, 2] as const).some((t) => ['working', 'blocked'].includes(slotStatus(c, t)))) app.store.getState().setSleepingRobot(c.id);
    else void sleepRobot(deps(), c.id);
  };
  return (
    <Row testid={`load-row-${c.id}`} use={use} of={of}
      name={<button className="load-nm" onClick={open}>{c.name}{!c.tmux && <small>asleep</small>}</button>}>
      {c.tmux && use.sleepable && <button className="load-ib" data-testid={`load-sleep-${c.id}`} title="Sleep" onClick={sleep}><Moon /></button>}
      <button className="load-ib dan" data-testid={`load-delete-${c.id}`} title="Delete" onClick={() => app.store.getState().setClosingRobot(c.id)}><Cross /></button>
    </Row>
  );
}

/** Every robot and Svall itself by what they cost the machine, each robot with its Sleep and Delete. */
export function LoadPanel() {
  const { load, error } = useLoad(true);
  const robots = useApp((s) => s.fleet.robots);
  const note = error ? <div className="use-note" data-testid="load-error">{error}</div> : null;
  if (!load) return note;

  const of = load.total.cpu;
  // a robot running only its shell costs nothing worth a row
  const rows = Object.entries(load.robots).flatMap(([id, use]) => {
    const c = robots[id];
    return c && !use.shellOnly ? [{ cpu: use.cpu, row: <RobotRow key={id} c={c} use={use} of={of} /> }] : [];
  });
  if (load.codex) rows.push({ cpu: load.codex.cpu, row: <Row key="codex" testid="load-codex" name={<span className="load-nm">Codex server (shared)</span>} use={load.codex} of={of} /> });
  rows.sort((a, b) => b.cpu - a.cpu);

  return (
    <>
      {note}
      <div className="load-tot">
        <Total label="CPU" text={`${coresText(load.total.cpu)} of ${load.cores} cores`} testid="load-total-cpu" />
        <Total label="RAM" text={memText(load.total.mem)} />
        <Total label="Procs" text={String(load.total.procs)} />
      </div>
      <div className="load-row load-head"><span /><span className="load-n">cores</span><span className="load-n">ram</span><span className="load-n">#</span></div>
      <div className="load-grp" data-testid="load-robots">Robots <em>{rows.length}</em></div>
      {rows.map((r) => r.row)}
      <Row testid="load-app" name={<span className="load-nm">Svall itself</span>} use={load.app} of={of} appRow />
    </>
  );
}
