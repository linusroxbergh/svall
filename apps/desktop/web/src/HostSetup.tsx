import { useEffect, useRef, useState } from 'react';
import { app } from './boot.js';
import type { HostArgs, HostOp, HostStep } from './bridge.js';
import { CloseX } from './CloseX.js';
import { AS_TYPED } from './Field.js';
import { added, groupSteps, machineName, OP_TITLE, outcomeOf, runActions, sshDestination, stepLabel, stepSaid, type HostRun } from './host.js';
import { useApp } from './hooks.js';
import { MachineTerminal } from './MachineTerminal.js';

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
  // a terminal needs the destination the registry has for it, which the page may not have read yet
  const reachable = useApp((s) => !!s.machines?.find((m) => m.name === name)?.ssh);
  const store = () => app.store.getState();
  const run = (op: HostOp) => { store().toggleHost(true, name); startHost(op, { name }); };
  const ask = (forget: boolean) => { store().toggleHost(true, name); store().confirmHost({ name, forget }); };
  return (
    <span className="machine-acts">
      <button className="btn set-open" data-testid="machine-doctor" disabled={running} title="What the machine needs for a handover, checked now" onClick={() => run('doctor')}>Check</button>
      <button className="btn set-open" data-testid="machine-upgrade" disabled={running} title="Install this Mac's release there" onClick={() => run('upgrade')}>Upgrade</button>
      <button className="btn set-open" data-testid="machine-terminal" disabled={running || !reachable} title="A terminal on this machine, for what Svall leaves to you there"
        onClick={() => store().openHostTerminal(name)}>Terminal</button>
      {gateway !== name && (
        <button className="btn set-open" data-testid="machine-enable" disabled={running}
          title="It keeps this fleet's ownership record; the fleet stays on this Mac" onClick={() => run('enable')}>Make gateway</button>
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

// terminal: opens a terminal on the machine with a step's command typed, where the panel knows how to reach it
function Checklist({ run, terminal }: { run: HostRun; terminal?: (command: string) => void }) {
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
                {row.run && terminal && !run.running && (
                  <button className="btn set-open" data-testid={`host-terminal-${row.step}`} title={`Opens a terminal on ${run.args.name} with ${row.run} typed, for you to run`}
                    onClick={() => terminal(row.run!)}>Open terminal</button>
                )}
                {!row.action && row.status === 'fail' && !run.running && (
                  <button className="btn set-open" data-testid={`host-again-${row.step}`} onClick={() => startHost(run.op, run.args)}>
                    {run.op === 'doctor' ? 'Check again' : 'Try again'}
                  </button>
                )}
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
  // the registry's destination, or the one an add not yet in the registry was given
  const ssh = useApp((s) => s.machines?.find((m) => m.name === s.hostMachine)?.ssh ?? (s.host?.args.name === s.hostMachine ? s.host?.args.ssh : undefined));
  const forHandover = useApp((s) => s.hostForHandover);
  const gateway = useApp((s) => s.shell?.gateway);
  const shut = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    shut.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      // a terminal there hangs up what runs in it, so only Done or × closes it
      if (!app.store.getState().hostTerminal) app.store.getState().toggleHost(false);
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open]);

  // for the handover sheet: an add with nothing left to do goes on to make the gateway, and the gateway made goes back to the sheet
  useEffect(() => {
    if (!forHandover || !run || run.running || run.code !== 0) return;
    if (added(run) && !runActions(run).length) startHost('enable', { name: run.args.name });
    else if (run.op === 'enable' && gateway === run.args.name) {
      app.store.getState().toggleHost(false);
      app.store.getState().toggleHandover(true);
    }
  }, [forHandover, run, gateway]);

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
        {term ? <MachineTerminal name={machine} ssh={ssh} run={terminal.run} onEnd={ended} /> : (
          <>
            {adding ? !running && <AddForm key={machine ?? ''} running={running} from={shown?.args} /> : machine && !gone && <div className="acts"><MachineActions name={machine} /></div>}
            {confirm && (
              <div className="host-note" data-testid="host-confirm" data-op={confirm.forget ? 'forget' : 'remove'}>
                <span>
                  {confirm.forget ? `Forget drops the route to ${confirm.name} and leaves the machine as it is.` : `Remove uninstalls Svall on ${confirm.name} and drops its route.`}
                  <span className="ho-sub">{confirm.forget ? 'Svall stays installed there, and a fleet it owns stays where it is.' : 'Its fleets and their files stay on that machine.'}</span>
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
            {shown && <Checklist run={shown} terminal={machine && ssh ? (run) => app.store.getState().openHostTerminal(machine, run) : undefined} />}
            {running && (
              <div className="acts">
                <button className="btn" data-testid="host-cancel" onClick={() => app.bridge.send({ type: 'host.cancel' })}>Stop</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
