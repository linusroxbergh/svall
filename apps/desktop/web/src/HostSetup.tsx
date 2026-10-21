import { useEffect, useRef, useState } from 'react';
import { app } from './boot.js';
import type { HostArgs, HostOp, HostStep } from './bridge.js';
import { groupSteps, machineName, OP_TITLE, outcomeOf, sshDestination, stepLabel, stepSaid, type HostRun } from './host.js';
import { useApp } from './hooks.js';

const MARK: Record<HostStep['status'], string> = { start: '·', ok: '✓', warn: '!', fail: '×', skip: '–' };

/** Runs one `svall host …` in the shell, and has the panel follow it. */
export function startHost(op: HostOp, args: HostArgs): void {
  app.store.getState().hostStarted(op, args);
  app.bridge.send({ type: 'host.start', op, args });
}

/** What can be done to a machine in the registry, each on that machine and in the panel that follows it. */
export function MachineActions({ name }: { name: string }) {
  const gateway = useApp((s) => s.shell?.gateway);
  const running = useApp((s) => !!s.host?.running);
  const store = () => app.store.getState();
  const run = (op: HostOp) => { store().toggleHost(true, name); startHost(op, { name }); };
  const ask = (forget: boolean) => { store().toggleHost(true, name); store().confirmHost({ name, forget }); };
  return (
    <span className="machine-acts">
      <button className="btn set-open" data-testid="machine-doctor" disabled={running} title="What the machine needs for a handover, checked now" onClick={() => run('doctor')}>Check</button>
      <button className="btn set-open" data-testid="machine-upgrade" disabled={running} title="Install this Mac's release there" onClick={() => run('upgrade')}>Upgrade</button>
      <button className="btn set-open" data-testid="machine-rollback" disabled={running} title="Put back the release the machine ran before" onClick={() => run('rollback')}>{OP_TITLE.rollback}</button>
      {gateway !== name && (
        <button className="btn set-open" data-testid="machine-enable" disabled={running}
          title="Make this machine the gateway that keeps this fleet's ownership record; the fleet stays on this Mac" onClick={() => run('enable')}>Make gateway</button>
      )}
      <button className="btn set-open dan" data-testid="machine-remove" disabled={running} title="Uninstall Svall on this machine and drop its route" onClick={() => ask(false)}>Remove</button>
      <button className="btn set-open dan" data-testid="machine-forget" disabled={running}
        title="Drop the route for a machine that cannot be reached, leaving it untouched" onClick={() => ask(true)}>Forget</button>
    </span>
  );
}

function Outcome({ run }: { run: HostRun }) {
  const gateway = useApp((s) => s.shell?.gateway);
  if (run.running) return <div className="host-note" data-testid="host-running">{OP_TITLE[run.op]}: running…</div>;
  const o = outcomeOf(run, gateway);
  const name = run.args.name;
  return (
    <div className="host-note" data-testid="host-outcome">
      {o.text}
      {o.list && <ul>{o.list.map((a) => <li key={a}>{a}</li>)}</ul>}
      {o.next && (
        <div className="acts">
          {o.next === 'gateway' && (
            <button className="btn" data-testid="host-next-gateway" onClick={() => startHost('enable', { name })}>{OP_TITLE.enable}</button>
          )}
          {o.next === 'handover' && (
            <button className="btn" data-testid="host-next-handover"
              onClick={() => { app.store.getState().toggleHost(false); app.store.getState().toggleHandover(true); }}>Open Handover</button>
          )}
          {o.next === 'rollback' && (
            <button className="btn" data-testid="host-rollback" title="Put back the release the machine ran before"
              onClick={() => startHost('rollback', { name })}>{OP_TITLE.rollback} {name}</button>
          )}
        </div>
      )}
    </div>
  );
}

function Checklist({ run }: { run: HostRun }) {
  return (
    <div className="host-steps" data-testid="host-steps">
      {groupSteps(run.steps).map((group, i) => (
        <div key={`${group.phase}-${i}`} className="host-phase">
          <div className="kicker" data-testid="host-phase">{group.label}</div>
          {group.rows.map((row, at) => (
            <div key={`${row.step}-${at}`} className="host-step" data-testid={`host-step-${row.step}`} data-status={row.status}>
              <span className="host-mark">{MARK[row.status]}</span>
              <span className="host-name">{stepLabel(row.step)}</span>
              <span className="host-said">
                {stepSaid(row, run.args.name)}
                {row.action && <em data-testid={`host-action-${row.step}`}>{row.action}</em>}
              </span>
            </div>
          ))}
        </div>
      ))}
      <Outcome run={run} />
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
        <span>
          The machine needs Ubuntu LTS with systemd, and an account reached over ssh whose home is the same path as yours
          on this Mac. Add machine installs Svall on an x86-64 machine and lists anything left for you to do; add an arm64
          one with <code>svall host add … --release</code>, as Setting up a Linux machine in Svall&apos;s docs describes.
          Then Make it this fleet&apos;s gateway, and Handover can move the fleet there.
        </span>
      </div>
      <div className="host-form">
        <input className="fld" data-testid="host-name" placeholder="machine name" aria-label="Machine name"
          value={name} onChange={(e) => setName(e.target.value.trim())} />
        <input className="fld" data-testid="host-ssh" placeholder="ssh destination, e.g. linus@studio" aria-label="Ssh destination"
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
  const enabled = useApp((s) => !!s.shell?.handoverEnabled);
  const run = useApp((s) => s.host);
  const confirm = useApp((s) => s.hostConfirm);
  const machine = useApp((s) => s.hostMachine);
  const known = useApp((s) => !!s.machines?.some((m) => m.name === s.hostMachine));
  const shut = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    shut.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      app.store.getState().toggleHost(false);
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open]);

  if (!open || !enabled) return null;
  const running = run?.running ?? false;
  // a run another machine's panel started stays in sight while it runs, so it can be stopped
  const shown = run && (running || run.args.name === machine) ? run : undefined;
  const gone = shown?.op === 'remove' && !running && shown.code === 0;
  // a machine an add has yet to put in the registry is added again, not acted on
  const adding = !machine || (!known && shown?.op === 'add');
  const close = () => app.store.getState().toggleHost(false);

  return (
    <div className="modal-back" data-testid="host-setup" onPointerDown={close}>
      <div className="modal host panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="kicker">
          {machine ? <span data-testid="host-machine">{machine}</span> : 'Add a machine'}
          <span className="spacer" />
          <button ref={shut} className="side-x" data-testid="host-close" title="Close" aria-label="Close" onClick={close}>×</button>
        </div>
        {adding ? !running && <AddForm key={machine ?? ''} running={running} from={shown?.args} /> : machine && !gone && <div className="acts"><MachineActions name={machine} /></div>}
        {confirm && (
          <div className="host-note" data-testid="host-confirm" data-op={confirm.forget ? 'forget' : 'remove'}>
            {confirm.forget
              ? `Forgetting ${confirm.name} leaves Svall installed on it and drops its route here. Nothing on that machine is uninstalled, and a fleet it owns stays where it is.`
              : `Removing ${confirm.name} uninstalls Svall there and drops its route here. The fleets on it and their files stay on that machine.`}
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
        {shown && <Checklist run={shown} />}
        {running && (
          <div className="acts">
            <button className="btn" data-testid="host-cancel" onClick={() => app.bridge.send({ type: 'host.cancel' })}>Stop</button>
          </div>
        )}
      </div>
    </div>
  );
}
