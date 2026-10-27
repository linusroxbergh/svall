import type { MachineId, SetupRow } from '@svall/protocol';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { app } from './boot.js';
import type { HostArgs, HostOp, HostStep } from './bridge.js';
import { CloseX } from './CloseX.js';
import { AS_TYPED } from './Field.js';
import {
  groupSteps, machineName, machineNames, OP_TITLE, outcomeOf, plainStep, rowToStep, sshDestination, stepLabel, stepSaid, type HostRun,
} from './host.js';
import { useApp, useMeasure } from './hooks.js';
import { MachineTerminal } from './MachineTerminal.js';
import { placeTip } from './settings.js';

const MARK: Record<HostStep['status'], string> = { start: '·', ok: '✓', warn: '!', fail: '×', skip: '–' };

/** Runs one `svall host …` in the shell, and has the panel follow it. */
export function startHost(op: HostOp, args: HostArgs): void {
  app.store.getState().hostStarted(op, args);
  app.bridge.send({ type: 'host.start', op, args });
}

/** What can be done to a machine in the registry, each on that machine and in the panel that follows it. */
export function MachineActions({ name }: { name: string }) {
  const running = useApp((s) => !!s.host?.running);
  // a terminal needs the destination the registry has for it, which the page may not have read yet
  const reachable = useApp((s) => !!s.machines?.find((m) => m.name === name)?.ssh);
  const id = useApp((s) => s.machines?.find((m) => m.name === name)?.id);
  const placed = useApp((s) => Object.values(s.fleet.robots).filter((r) => id && (r.machine === id || r.moving?.to === id)).length);
  const up = useApp((s) => !!id && s.fleet.machines?.[id as MachineId]?.reachable === true);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>();
  const box = useRef<HTMLSpanElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = (refocus = true) => { setOpen(false); if (refocus) more.current?.focus(); };
  const items = () => [...menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []];
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) close(); };
    // taken before the panel and the settings window read the same keys
    const key = (e: KeyboardEvent) => {
      const all = items(), at = all.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'Tab') { close(); return; }
      const next = e.key === 'ArrowDown' ? all[(at + 1) % all.length] : e.key === 'ArrowUp' ? all[(at <= 0 ? all.length : at) - 1] : undefined;
      if (e.key !== 'Escape' && !next) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (next) next.focus(); else close();
    };
    document.addEventListener('pointerdown', away);
    window.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', away); window.removeEventListener('keydown', key, true); };
  }, [open]);
  // fixed to the window under ⋯, or over it where the window has more room there, so the panel scrolling it does not clip it
  useMeasure(open, () => {
    const at = more.current?.getBoundingClientRect();
    const el = menu.current;
    if (!at || !el) return;
    const { above, maxHeight } = placeTip(at, el.scrollHeight, { top: 0, bottom: window.innerHeight });
    setPlace({ left: Math.max(0, Math.min(at.left, window.innerWidth - el.offsetWidth)), maxHeight: maxHeight || undefined,
      ...(above ? { bottom: window.innerHeight - at.top + 4 } : { top: at.bottom + 4 }) });
  });
  const store = () => app.store.getState();
  const run = (op: HostOp) => { store().toggleHost(true, name); startHost(op, { name }); };
  const ask = (forget: boolean) => { store().toggleHost(true, name); store().confirmHost({ name, forget }); };
  const item = (fn: () => void) => () => { close(); fn(); };
  return (
    <span className="machine-acts" ref={box}>
      <button className="btn set-open" data-testid="machine-doctor" disabled={running} title="What to fix on the machine and what will not work there yet, checked now" onClick={() => run('doctor')}>Check</button>
      <button ref={more} className="btn set-open" data-testid="machine-more" aria-haspopup="menu" aria-expanded={open} aria-label="More for this machine" onClick={() => setOpen(!open)}>⋯</button>
      {open && (
        <div ref={menu} className="machine-menu popover" role="menu" style={place}>
          <button role="menuitem" data-testid="machine-upgrade" disabled={running} title="Install this Mac's release there" onClick={item(() => run('upgrade'))}>Upgrade to this Mac's release</button>
          <button role="menuitem" data-testid="machine-terminal" disabled={running || !reachable} title="A terminal on this machine, for what Svall leaves to you there"
            onClick={item(() => store().openHostTerminal(name))}>Open a terminal there</button>
          <button role="menuitem" className="dan" data-testid="machine-remove" disabled={running || placed > 0}
            title={placed ? `${placed === 1 ? '1 robot is' : `${placed} robots are`} placed there; move ${placed === 1 ? 'it' : 'them'} back first` : 'Uninstall Svall on this machine and drop its route'}
            onClick={item(() => ask(false))}>Remove</button>
          {!up && (
            <button role="menuitem" className="dan" data-testid="machine-forget" disabled={running}
              title="Drop the route for a machine that cannot be reached, leaving it untouched" onClick={item(() => ask(true))}>Forget</button>
          )}
        </div>
      )}
    </span>
  );
}

// the footer: the run's one line, then Stop while it runs, Set them up now while parts of the agent setup will not work
// there and the page shows every step, and Done, or Check again on a machine in the registry while something is left to fix
function Outcome({ run, narrow }: { run: HostRun; narrow?: () => void }) {
  const known = useApp((s) => !!s.machines?.some((m) => m.name === run.args.name));
  if (run.running) {
    return (
      <div className="host-foot" data-testid="host-running">
        <span className="host-verdict">{OP_TITLE[run.op]}: running…</span>
        <div className="acts">
          <button className="btn" data-testid="host-cancel" onClick={() => app.bridge.send({ type: 'host.cancel' })}>Stop</button>
        </div>
      </div>
    );
  }
  const o = outcomeOf(run);
  const name = run.args.name;
  return (
    <div className="host-foot" data-testid="host-outcome">
      <span className="host-verdict">{o.text}</span>
      <div className="acts">
        {o.next === 'rollback' && (
          <button className="btn" data-testid="host-rollback" title="Put back the release the machine ran before"
            onClick={() => startHost('rollback', { name })}>{OP_TITLE.rollback} {name}</button>
        )}
        {o.setup && narrow && <button className="btn" data-testid="host-set-up" onClick={narrow}>Set them up now</button>}
        {o.done || !known
          ? <button className="btn" data-testid="host-done" onClick={() => app.store.getState().toggleHost(false)}>Done</button>
          : <button className="btn" data-testid="host-check-again" onClick={() => startHost('doctor', { name })}>Check again</button>}
      </div>
    </div>
  );
}

type Terminal = (command: string, forward?: number) => void;

/** One line: what the step is, one sentence, and the one thing to do about it; the recipe behind details. */
function Row({ row, run, terminal }: { row: HostStep; run: HostRun; terminal?: Terminal }) {
  const name = run.args.name;
  const id = useApp((s) => s.machines?.find((m) => m.name === name)?.id);
  // the tick asked for while svalld pushes it
  const [asked, setAsked] = useState<boolean>();
  const [failed, setFailed] = useState<string>();
  const sentence = useId();
  const said = stepSaid(row, name);
  const idle = !run.running;
  // svalld keeps a tick it could not push, so a refusal is followed by the rows as it kept them; they go to the run the tick
  // was made in, known by its args, which its rows keep, or to a check of the machine since
  const tick = (machine: MachineId, on: boolean) => {
    const shown = app.store.getState().host?.args;
    const show = ({ rows }: { rows: SetupRow[] }) => {
      const now = app.store.getState().host;
      if (now && !now.running && (now.args === shown || (now.op === 'doctor' && now.args.name === name))) app.store.getState().hostRows(rows.map(rowToStep));
    };
    setAsked(on);
    setFailed(undefined);
    app.api().call('machines.consent', { machine, item: row.tick!.item, fields: row.tick!.fields, on })
      .catch((e: Error) => {
        setFailed(plainStep(e.message, machineNames(app.store.getState().machines)));
        return app.api().call('machines.setup', { machine });
      })
      .then(show, () => {})
      .finally(() => setAsked(undefined));
  };
  return (
    <div className="host-step" data-testid={`host-step-${row.step}`} data-status={row.status}>
      <span className="host-mark">{MARK[row.status]}</span>
      <span className="host-name" title={stepLabel(row.step)}>{stepLabel(row.step)}</span>
      <span className="host-said">
        {asked !== undefined ? <span id={sentence} data-testid={`host-pushing-${row.step}`}>pushing to {name}…</span>
          : row.action ? <em id={sentence} data-testid={`host-action-${row.step}`}>{row.action}</em> : <span id={sentence}>{said}</span>}
        {row.action && said && <details className="modal-more" data-testid={`host-details-${row.step}`}><summary>details</summary>{said}</details>}
        {failed && <span className="host-failed" role="status" data-testid={`host-tick-failed-${row.step}`}>{failed}</span>}
      </span>
      {row.tick ? (
        // a tick under way keeps the box, and focus on it, and takes no second change
        <input type="checkbox" data-testid={`host-tick-${row.step}`} aria-label={stepLabel(row.step)} aria-describedby={sentence} checked={asked ?? row.tick.on}
          disabled={!id || !idle} aria-disabled={asked !== undefined || undefined} title={id ? undefined : 'listed once the machine is added'}
          onChange={(e) => { if (id && asked === undefined) tick(id as MachineId, e.target.checked); }} />
      ) : row.run && terminal && idle ? (
        <button className="btn set-open" data-testid={`host-terminal-${row.step}`} title={`Opens a terminal on ${name} with ${row.run} typed, for you to run`}
          onClick={() => terminal(row.run!, row.forward)}>Open terminal</button>
      ) : !row.action && row.status === 'fail' && idle ? (
        <button className="btn set-open" data-testid={`host-again-${row.step}`} onClick={() => startHost(run.op, run.args)}>
          {run.op === 'doctor' ? 'Check again' : 'Try again'}
        </button>
      ) : null}
    </div>
  );
}

// terminal: opens a terminal on the machine with a step's command typed, where the panel knows how to reach it; wide, while
// the page shows only the agent setup rows of what will not work there and those with a tick, which keep it once it does
function Checklist({ run, terminal, wide }: { run: HostRun; terminal?: Terminal; wide?: () => void }) {
  const steps = wide ? run.steps.filter((s) => s.step.startsWith('mirror:') && (s.gap || s.tick)) : run.steps;
  return (
    <div className="host-steps" data-testid="host-steps">
      {wide && <div className="acts"><button className="btn set-open" data-testid="host-show-all" onClick={wide}>Show every step</button></div>}
      {groupSteps(steps).map((group) => (
        <div key={group.phase} className="host-phase">
          <div className="kicker" data-testid="host-phase">{group.label}</div>
          {group.rows.map((row, at) => <Row key={`${row.step}-${at}`} row={row} run={run} terminal={terminal} />)}
        </div>
      ))}
    </div>
  );
}

/** Adding a machine by its name and ssh, before it is in the registry; an add that stopped short fills them in again. */
function AddForm({ running, from }: { running: boolean; from?: HostArgs }) {
  const [name, setName] = useState(from?.name ?? '');
  const [ssh, setSsh] = useState(from?.ssh ?? '');
  return (
    <>
      <div className="host-note" data-testid="host-intro">
        <span>Svall installs itself on the machine over ssh and lists what is left for you to do.</span>
        <span>The machine needs:</span>
        <ul>
          <li>Ubuntu 22.04 LTS or newer, with systemd</li>
          <li>x86-64 or arm64</li>
          <li>An account you reach over ssh, with any home</li>
        </ul>
      </div>
      <div className="host-form">
        <input className="fld" data-testid="host-name" placeholder="machine name" aria-label="Machine name" {...AS_TYPED}
          value={name} onChange={(e) => setName(e.target.value.trim())} />
        <input className="fld" data-testid="host-ssh" placeholder="ssh destination, e.g. linus@studio" aria-label="Ssh destination" {...AS_TYPED}
          value={ssh} onChange={(e) => setSsh(e.target.value.trim())} />
      </div>
      <div className="acts">
        <button className="btn" data-testid="host-add" disabled={running || !machineName(name) || !sshDestination(ssh)}
          onClick={() => startHost('add', { name, ssh })}>Add machine</button>
      </div>
    </>
  );
}

/** One machine and what is done to it, or a new one being added: the steps `svall host …` reports, as they arrive. */
export function HostSetup() {
  const open = useApp((s) => s.hostOpen);
  const run = useApp((s) => s.host);
  const confirm = useApp((s) => s.hostConfirm);
  const machine = useApp((s) => s.hostMachine);
  const known = useApp((s) => !!s.machines?.some((m) => m.name === s.hostMachine));
  const terminal = useApp((s) => s.hostTerminal);
  const narrow = useApp((s) => !!s.hostNarrow);
  // the registry's destination, or the one an add not yet in the registry was given
  const ssh = useApp((s) => s.machines?.find((m) => m.name === s.hostMachine)?.ssh ?? (s.host?.args.name === s.hostMachine ? s.host?.args.ssh : undefined));
  const shut = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    shut.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.machine-menu')) return;
      e.stopPropagation();
      // a terminal there hangs up what runs in it, so only Done or × closes it
      if (!app.store.getState().hostTerminal) app.store.getState().toggleHost(false);
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open]);

  if (!open) return null;
  const running = run?.running ?? false;
  // a run another machine's panel started stays in sight while it runs, so it can be stopped
  const shown = run && (running || run.args.name === machine) ? run : undefined;
  const gone = shown?.op === 'remove' && !running && shown.code === 0;
  // a machine an add has yet to put in the registry is added again, not acted on
  const adding = !machine || (!known && shown?.op === 'add');
  const term = terminal && machine && ssh;
  // the logins and fixes made there are what the machine's own checks look at again
  const ended = () => {
    app.store.getState().closeHostTerminal();
    if (known && machine && !running) startHost('doctor', { name: machine });
  };
  const close = () => {
    if (term) ended();
    app.store.getState().toggleHost(false);
  };

  return (
    <div className="modal-back" data-testid="host-setup" onPointerDown={term ? undefined : close}>
      <div className="modal host panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="kicker">
          {machine ? <span data-testid="host-machine">{machine}</span> : 'Add a machine'}
          <CloseX ref={shut} onClose={close} testid="host-close" />
        </div>
        <div className="host-body">
          {term ? <MachineTerminal name={machine} ssh={ssh} run={terminal.run} forward={terminal.forward} onEnd={ended} /> : (
            <>
              {adding ? !running && <AddForm key={machine ?? ''} running={running} from={shown?.args} /> : machine && !gone && <div className="acts"><MachineActions name={machine} /></div>}
              {confirm && (
                <div className="host-note" data-testid="host-confirm" data-op={confirm.forget ? 'forget' : 'remove'}>
                  <span>
                    {confirm.forget ? `Forget drops the route to ${confirm.name} and leaves the machine as it is.` : `Remove uninstalls Svall on ${confirm.name} and drops its route.`}
                    <span className="modal-sub">{confirm.forget ? 'Svall and its fleets stay on that machine.' : 'Its fleets and their files stay on that machine.'}</span>
                  </span>
                  <div className="acts">
                    <button className="btn dan" data-testid="host-confirm-yes"
                      onClick={() => startHost('remove', confirm.forget ? { name: confirm.name, forget: true } : { name: confirm.name })}>
                      {confirm.forget ? 'Forget' : 'Remove'} {confirm.name}
                    </button>
                    <button className="btn" data-testid="host-confirm-no"
                      onClick={() => app.store.getState().confirmHost(undefined)}>Cancel</button>
                  </div>
                </div>
              )}
              {shown && (
                <Checklist run={shown} terminal={machine && ssh ? (run, forward) => app.store.getState().openHostTerminal(machine, run, forward) : undefined}
                  wide={narrow ? () => app.store.getState().narrowHost(false) : undefined} />
              )}
            </>
          )}
        </div>
        {!term && shown && <Outcome run={shown} narrow={narrow ? undefined : () => app.store.getState().narrowHost(true)} />}
      </div>
    </div>
  );
}
