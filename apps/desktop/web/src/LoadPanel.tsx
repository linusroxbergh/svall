import type { ReactNode } from 'react';
import type { Robot, LoadRobot, LoadSnapshot, LoadUsage, MachineId } from '@svall/protocol';
import { sleepRobot } from './actions.js';
import { app, deps } from './boot.js';
import { useApp } from './hooks.js';
import { Close, Moon } from './icons.js';
import { useLoad } from './load.js';
import { coresText, memText } from './loadText.js';
import { destinationName, myMachine } from './placement.js';
import { slotStatus } from './selectors.js';

// the figure large, its unit small
function Total({ label, text, testid }: { label: string; text: string; testid?: string }) {
  const n = /^[\d.]+/.exec(text)?.[0] ?? '';
  return <div><span>{label}</span><b className="tnum" data-testid={testid}>{n}<small>{text.slice(n.length)}</small></b></div>;
}

// the bar is the row's share of all the cpu the panel counts
function Row({ testid, name, use, of, appRow, children }: { testid: string; name: ReactNode; use: LoadUsage; of: number; appRow?: boolean; children?: ReactNode }) {
  return (
    <div className="load-row list-row sm" data-testid={testid} data-app={appRow || undefined}>
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
      {c.tmux && use.sleepable && <button className="ib load-ib" data-testid={`load-sleep-${c.id}`} data-tip={"Sleep\nEnds its terminal to free memory; opening it resumes the session"} aria-label="Sleep" onClick={sleep}><Moon /></button>}
      <button className="ib load-ib dan" data-testid={`load-delete-${c.id}`} data-tip="Delete" aria-label="Delete" onClick={() => app.store.getState().setClosingRobot(c.id)}><Close /></button>
    </Row>
  );
}

/** One machine's robots and Svall itself by what they cost it, each robot with its Sleep and Delete. */
function MachineLoad({ load }: { load: LoadSnapshot }) {
  const robots = useApp((s) => s.fleet.robots);
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

/** Each machine of the fleet in a column of its own, named once there is more than one. */
export function LoadPanel() {
  const { load, error } = useLoad(true);
  const machines = useApp((s) => s.fleet.machines);
  const via = useApp((s) => s.via);
  const me = useApp((s) => myMachine(s));
  const note = error ? <div className="use-note" data-testid="load-error">{error}</div> : null;
  if (!load) return note;

  const named = load.machines.length > 1;
  const name = (id: MachineId) => (id === me ? 'This Mac' : destinationName({ machines }, id, via));
  return (
    <>
      {note}
      <div className="load-machines">
        {load.machines.map((m) => (
          <section key={m.machine} className="load-mach" data-testid={`load-machine-${m.machine}`}>
            {named && <div className="load-mach-nm">{name(m.machine)}</div>}
            {m.load ? <MachineLoad load={m.load} />
              : <div className="use-note">{machines?.[m.machine]?.reachable === false ? 'Out of reach' : 'No reading'}</div>}
          </section>
        ))}
      </div>
    </>
  );
}
