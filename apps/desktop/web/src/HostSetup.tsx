import { useEffect, useRef, useState } from 'react';
import { app } from './boot.js';
import type { HostArgs, HostOp, HostStep } from './bridge.js';
import { groupSteps, machineName, readyForHandover, runActions, sshDestination, type HostRun } from './host.js';
import { useApp } from './hooks.js';

const MARK: Record<HostStep['status'], string> = { start: '·', ok: '✓', warn: '!', fail: '×', skip: '–' };

const OP_TITLE: Record<HostOp, string> = {
  add: 'Add machine', doctor: 'Check', upgrade: 'Upgrade', remove: 'Remove', enable: "Make it this fleet's gateway",
};

function start(op: HostOp, args: HostArgs): void {
  app.store.getState().hostStarted(op, args);
  app.bridge.send({ type: 'host.start', op, args });
}

function Outcome({ run }: { run: HostRun }) {
  const actions = runActions(run);
  if (run.running) return <div className="host-note" data-testid="host-running">{OP_TITLE[run.op]}: running…</div>;
  if (readyForHandover(run)) return <div className="host-note" data-testid="host-outcome">ready for handover</div>;
  if (actions.length > 0) {
    return (
      <div className="host-note" data-testid="host-outcome">
        still to do:
        <ul>{actions.map((a) => <li key={a}>{a}</li>)}</ul>
      </div>
    );
  }
  return (
    <div className="host-note" data-testid="host-outcome">
      {OP_TITLE[run.op]}: {run.code === 0 ? 'done' : `ended with exit ${run.code}`}
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
              <span className="host-name">{row.step}</span>
              <span className="host-said">
                {row.detail}
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

/** Adding a Linux machine, and looking after one: the steps `svall host …` reports, as they arrive. */
export function HostSetup() {
  const open = useApp((s) => s.hostOpen);
  const enabled = useApp((s) => !!s.shell?.handoverEnabled);
  const run = useApp((s) => s.host);
  const confirm = useApp((s) => s.hostConfirm);
  const [name, setName] = useState('');
  const [ssh, setSsh] = useState('');
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
  const named = machineName(name);
  const close = () => app.store.getState().toggleHost(false);

  return (
    <div className="modal-back" data-testid="host-setup" onPointerDown={close}>
      <div className="modal host panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="kicker">
          Machines
          <span className="spacer" />
          <button ref={shut} className="side-x" data-testid="host-close" title="Close" aria-label="Close" onClick={close}>×</button>
        </div>
        {!run && (
          <div className="host-note" data-testid="host-intro">
            The machine needs Ubuntu LTS on x86-64 or arm64, with systemd, and an account reached over ssh whose home is the
            same path as yours on this Mac. Add machine installs Svall there and lists anything left for you to do.
            Then Make it this fleet&apos;s gateway, and Handover can move the fleet there.
          </div>
        )}
        <div className="host-form">
          <input className="fld" data-testid="host-name" placeholder="machine name" aria-label="Machine name"
            value={name} onChange={(e) => setName(e.target.value.trim())} />
          <input className="fld" data-testid="host-ssh" placeholder="ssh destination, e.g. linus@studio" aria-label="Ssh destination"
            value={ssh} onChange={(e) => setSsh(e.target.value.trim())} />
        </div>
        <div className="acts">
          <button className="btn" data-testid="host-add" disabled={running || !named || !sshDestination(ssh)}
            onClick={() => start('add', { name, ssh })}>Add machine</button>
          <button className="btn" data-testid="host-doctor" disabled={running || !named}
            onClick={() => start('doctor', { name })}>Check</button>
          <button className="btn" data-testid="host-upgrade" disabled={running || !named}
            onClick={() => start('upgrade', { name })}>Upgrade</button>
        </div>
        <div className="acts">
          <button className="btn" data-testid="host-enable" disabled={running || !named}
            title="Make this machine the gateway that keeps this fleet's ownership record; the fleet stays on this Mac"
            onClick={() => start('enable', { name })}>{OP_TITLE.enable}</button>
          <button className="btn dan" data-testid="host-remove" disabled={running || !named}
            title="Uninstall Svall on this machine and drop its route"
            onClick={() => app.store.getState().confirmHost({ name, forget: false })}>Remove</button>
          <button className="btn dan" data-testid="host-forget" disabled={running || !named}
            title="Drop the route for a machine that cannot be reached, leaving it untouched"
            onClick={() => app.store.getState().confirmHost({ name, forget: true })}>Forget</button>
        </div>
        {confirm && (
          <div className="host-note" data-testid="host-confirm" data-op={confirm.forget ? 'forget' : 'remove'}>
            {confirm.forget
              ? `Forgetting ${confirm.name} leaves Svall installed on it and drops its route here. Nothing on that machine is uninstalled, and a fleet it owns stays where it is.`
              : `Removing ${confirm.name} uninstalls Svall there and drops its route here. The fleets on it and their files stay on that machine.`}
            <div className="acts">
              <button className="btn dan" data-testid="host-confirm-yes"
                onClick={() => start('remove', confirm.forget ? { name: confirm.name, forget: true } : { name: confirm.name })}>
                {confirm.forget ? 'Forget' : 'Remove'} {confirm.name}
              </button>
              <button className="btn" data-testid="host-confirm-no"
                onClick={() => app.store.getState().confirmHost(undefined)}>Cancel</button>
            </div>
          </div>
        )}
        {run && <Checklist run={run} />}
        {running && (
          <div className="acts">
            <button className="btn" data-testid="host-cancel" onClick={() => app.bridge.send({ type: 'host.cancel' })}>Stop</button>
          </div>
        )}
      </div>
    </div>
  );
}
