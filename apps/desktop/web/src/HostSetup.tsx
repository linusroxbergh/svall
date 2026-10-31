import { AGENT_UPDATE, notNeeded, updatesHere, updatesIn, type AgentKind, type MachineId, type SetupRow } from '@svall/protocol';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { app } from './boot.js';
import type { HostArgs, HostOp, HostStep } from './bridge.js';
import { CloseX } from './CloseX.js';
import { AS_TYPED } from './Field.js';
import {
  asideStep, groupSteps, machineName, machineNames, OP_TITLE, outcomeOf, plainStep, plural, rowToStep, sshDestination, stepLabel, stepSaid, type HostRun,
} from './host.js';
import { useApp, useMeasure } from './hooks.js';
import { startHost } from './hostRun.js';
import { MachineTerminal } from './MachineTerminal.js';
import { answers } from './placement.js';
import { placeTip } from './settings.js';
import { Caret, Mark, More } from './icons.js';
import { VarField } from './VarField.js';

// the machine's own setup, which installing this Mac's release there runs again
const SETUP = /^svall(-dev)? setup$/;
const FORGET = /\bhost remove \S+ --forget\b/;

/** What can be done to a machine in the registry, each on that machine and in the panel that follows it. */
export function MachineActions({ name }: { name: string }) {
  const running = useApp((s) => !!s.host?.running);
  // a terminal needs the destination the registry has for it, which the page may not have read yet
  const reachable = useApp((s) => !!s.machines?.find((m) => m.name === name)?.ssh);
  const id = useApp((s) => s.machines?.find((m) => m.name === name)?.id);
  const placed = useApp((s) => Object.values(s.fleet.robots).filter((r) => id && (r.machine === id || r.moving?.to === id)).length);
  const up = useApp((s) => !!id && answers(s.fleet.machines?.[id as MachineId]));
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
      <button className="btn sm" data-testid="machine-doctor" disabled={running} data-tip="What to fix on the machine and what will not work there yet, checked now" onClick={() => run('doctor')}>Check</button>
      <button ref={more} className="btn sm" data-testid="machine-more" aria-haspopup="menu" aria-expanded={open} aria-label="More for this machine" onClick={() => setOpen(!open)}><More /></button>
      {open && (
        <div ref={menu} className="machine-menu menu popover" role="menu" style={place}>
          <button role="menuitem" className="menu-item" data-testid="machine-upgrade" disabled={running} data-tip="Install this Mac's release there" onClick={item(() => run('upgrade'))}>Upgrade to this Mac's release</button>
          <button role="menuitem" className="menu-item" data-testid="machine-terminal" disabled={running || !reachable} data-tip="A terminal on this machine, for what Svall leaves to you there"
            onClick={item(() => store().openHostTerminal(name))}>Open a terminal there</button>
          <button role="menuitem" className="menu-item dan" data-testid="machine-remove" disabled={running || placed > 0}
            data-tip={placed ? `${placed === 1 ? '1 robot is' : `${placed} robots are`} placed there; move ${placed === 1 ? 'it' : 'them'} back first` : 'Uninstall Svall on this machine and drop its route'}
            onClick={item(() => ask(false))}>Remove</button>
          {!up && (
            <button role="menuitem" className="menu-item dan" data-testid="machine-forget" disabled={running}
              data-tip="Drop the route for a machine that cannot be reached, leaving it untouched" onClick={item(() => ask(true))}>Forget</button>
          )}
        </div>
      )}
    </span>
  );
}

// the footer: the run's one line, then Stop while it runs, and Done; the panel's Check button is the one that runs the check again
function Outcome({ run }: { run: HostRun }) {
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
      <span className="host-verdict">{o.text}{o.note && <span className="modal-sub" data-testid="host-outcome-note">{o.note}</span>}</span>
      <div className="acts">
        {o.next === 'rollback' && (
          <button className="btn" data-testid="host-rollback" data-tip="Put back the release the machine ran before"
            onClick={() => startHost('rollback', { name })}>{OP_TITLE.rollback} {name}</button>
        )}
        <button className="btn" data-testid="host-done" onClick={() => app.store.getState().toggleHost(false)}>Done</button>
      </div>
    </div>
  );
}

type Terminal = (command: string, forward?: number) => void;

function Row({ row, run, terminal }: { row: HostStep; run: HostRun; terminal?: Terminal }) {
  const name = run.args.name;
  const id = useApp((s) => s.machines?.find((m) => m.name === name)?.id);
  // the tick asked for while svalld pushes it, and an agent update under way there
  const [asked, setAsked] = useState<boolean>();
  const [updating, setUpdating] = useState(false);
  const [failed, setFailed] = useState<string>();
  const updates = row.run ? updatesIn(row.run) : undefined;
  const onMac = updatesHere(`${row.detail ?? ''}; ${row.action ?? ''}`);
  const sentence = useId();
  const whole = stepSaid(row, name);
  // a check whose sentence ends in the command its terminal types says only what is wrong, the command behind details
  const from = row.run && !row.action && whole ? whole.lastIndexOf(row.run) : -1;
  const cut = from > 0 ? Math.max(whole!.lastIndexOf(': ', from), whole!.lastIndexOf('; ', from)) : -1;
  const said = cut > 0 ? whole!.slice(0, cut) : whole;
  const more = cut > 0 ? whole!.slice(cut + 2) : row.action && whole;
  const idle = !run.running;
  // no upgrade from a row while the machine runs a newer release or serves another Mac
  const noUpgrade = run.steps.some((s) => (s.step === 'release' || s.step === 'worker') && s.action);
  // the rows svalld answers a change with go to the run the change was made in, known by its args, which its rows keep,
  // or to a check of the machine since
  const take = () => {
    const shown = app.store.getState().host?.args;
    return (rows: SetupRow[]) => {
      const now = app.store.getState().host;
      if (now && !now.running && (now.args === shown || (now.op === 'doctor' && now.args.name === name))) app.store.getState().hostRows(rows.map(rowToStep));
    };
  };
  const fail = (e: Error) => setFailed(plainStep(e.message, machineNames(app.store.getState().machines)));
  // svalld keeps a tick it could not push, so a refusal is followed by the rows as it kept them
  const tick = (machine: MachineId, on: boolean) => {
    const show = take();
    setAsked(on);
    setFailed(undefined);
    app.api().call('machines.consent', { machine, item: row.tick!.item, fields: row.tick!.fields, on })
      .catch((e: Error) => {
        fail(e);
        return app.api().call('machines.setup', { machine });
      })
      .then(({ rows }) => show(rows), () => {})
      .finally(() => setAsked(undefined));
  };
  // the machine checked again once its agents and this Mac's are updated, unless a run started meanwhile holds the panel
  const update = (machine: MachineId, there?: AgentKind[], mac?: AgentKind[]) => {
    setUpdating(true);
    setFailed(undefined);
    (there ? app.api().call('machines.updateAgents', { machine, kinds: there }) : Promise.resolve({}))
      .then(() => mac && app.api().call('machines.updateAgents', { kinds: mac }))
      .then(() => { if (!app.store.getState().host?.running) startHost('doctor', { name }); },
        (e: Error) => setFailed(plainStep(e.message, machineNames(app.store.getState().machines))))
      .finally(() => setUpdating(false));
  };
  return (
    <div className="host-step" data-testid={`host-step-${row.step}`} data-status={row.status}>
      <span className="host-mark"><Mark status={isSetup(row) && row.status === 'warn' ? 'todo' : row.status} /></span>
      <span className="host-name" data-tip={stepLabel(row.step)}>{stepLabel(row.step)}</span>
      <span className="host-said">
        {updating ? <span id={sentence} data-testid={`host-updating-${row.step}`}>updating {[updates && `on ${name}`, onMac && 'on this Mac'].filter(Boolean).join(' and ')}…</span>
          : asked !== undefined ? <span id={sentence} data-testid={`host-pushing-${row.step}`}>pushing to {name}…</span>
          : row.action ? <em id={sentence} data-testid={`host-action-${row.step}`}>{row.action}</em> : <span id={sentence}>{said}</span>}
        {more && <details className="modal-more" data-testid={`host-details-${row.step}`}><summary><Caret dir="right" />details</summary>{more}</details>}
        {failed && <span className="host-failed" role="status" data-testid={`host-tick-failed-${row.step}`}>{failed}</span>}
      </span>
      {/* a program row keeps its install command's terminal beside the box that says the machine does not need it */}
      {notNeeded(row) && row.run && terminal && idle && (
        <button className="btn sm" data-testid={`host-terminal-${row.step}`} data-tip={`Opens a terminal on ${name} with ${row.run} typed, for you to run`}
          onClick={() => terminal(row.run!, row.forward)}>Open terminal</button>
      )}
      {row.tick ? (
        // a tick under way keeps the box, and focus on it, and takes no second change
        <input type="checkbox" data-testid={`host-tick-${row.step}`} aria-label={notNeeded(row) ? `${stepLabel(row.step)} is not needed on ${name}` : stepLabel(row.step)} aria-describedby={sentence}
          checked={asked ?? row.tick.on} disabled={!id || !idle} aria-disabled={asked !== undefined || undefined}
          data-tip={!id ? 'listed once the machine is added' : notNeeded(row) ? `Tick when ${name} does not need it; the row then stands aside` : undefined}
          onChange={(e) => { if (id && asked === undefined) tick(id as MachineId, e.target.checked); }} />
      ) : (updates || onMac) && id && idle ? (
        <button className="btn sm" data-testid={`host-update-${row.step}`} disabled={updating}
          data-tip={`Runs ${[updates && `${row.run} on ${name}`, onMac && `${onMac.map((k) => AGENT_UPDATE[k]).join(' && ')} on this Mac`].filter(Boolean).join(', then ')}, then checks again`}
          onClick={() => update(id as MachineId, updates, onMac)}>Update</button>
      ) : run.op === 'doctor' && row.step === 'release' && row.status === 'fail' && !row.action && idle ? (
        <button className="btn sm" data-testid="host-upgrade" data-tip="Install this Mac's release there" onClick={() => startHost('upgrade', { name })}>Upgrade</button>
      ) : run.op === 'doctor' && row.step === 'worker' && row.status === 'fail' && !noUpgrade && idle ? (
        <button className="btn sm" data-testid="host-worker" data-tip={`Install this Mac's release there and run this fleet's robots on ${name}`}
          onClick={() => startHost('upgrade', { name })}>Set up</button>
      ) : run.op === 'doctor' && row.run && SETUP.test(row.run) && run.steps.some((s) => s.step === 'release' && s.status === 'ok') && !noUpgrade && idle ? (
        <button className="btn sm" data-testid={`host-repair-${row.step}`} data-tip={`Install this Mac's release on ${name} again, whose setup puts this right`}
          onClick={() => startHost('upgrade', { name })}>Repair</button>
      ) : row.step.startsWith('mirror:var:') && row.status === 'warn' && row.action && id && idle ? (
        <VarField machine={id as MachineId} name={name} varName={row.step.slice('mirror:var:'.length)} here={row.here} testid={`host-var-${row.step}`}
          take={() => { setFailed(undefined); return take(); }} failed={(m) => fail(new Error(m))} />
      ) : row.status === 'fail' && row.action && FORGET.test(row.action) && id && idle ? (
        <button className="btn sm" data-testid={`host-forget-${row.step}`} data-tip={`Drop the route to ${name}, leaving the machine untouched`}
          onClick={() => app.store.getState().confirmHost({ name, forget: true })}>Forget</button>
      ) : row.run && terminal && idle ? (
        <button className="btn sm" data-testid={`host-terminal-${row.step}`} data-tip={`Opens a terminal on ${name} with ${row.run} typed, for you to run`}
          onClick={() => terminal(row.run!, row.forward)}>Open terminal</button>
      ) : run.op !== 'doctor' && !row.action && row.status === 'fail' && idle ? (
        <button className="btn sm" data-testid={`host-again-${row.step}`} onClick={() => startHost(run.op, run.args)}>Try again</button>
      ) : null}
    </div>
  );
}

// a step the user has something to do about or to know: one that failed, warns, or never finished
const needs = (s: HostStep): boolean => s.status !== 'ok' && s.status !== 'skip';
const isSetup = (s: HostStep): boolean => s.step.startsWith('mirror:');

// which folded parts of the checklist are open: the fine checks, and the agent setup
type Open = { fine: boolean; setup: boolean };
const SHUT: Open = { fine: false, setup: false };

/** The steps that need the user, by phase, then the fine ones and the agent setup, each folded behind one line. */
function Checklist({ run, terminal, open: { fine, setup }, unfold }: { run: HostRun; terminal?: Terminal; open: Open; unfold: (o: Open) => void }) {
  const steps = run.steps.filter((s) => !isSetup(s));
  const now = run.running ? steps.filter((s) => s.status === 'start').at(-1) : undefined;
  const ended = run.running ? steps.filter((s) => s.status !== 'start') : steps;
  const ok = ended.filter((s) => !needs(s));
  const rows = run.steps.filter(isSetup);
  // the rows that stand aside go last, under their own line
  const apart = rows.filter(asideStep);
  // keyed by its place in the run, so a row keeps its update under way as the folds open and shut
  const row = (r: HostStep) => <Row key={`${r.step}-${run.steps.indexOf(r)}`} row={r} run={run} terminal={terminal} />;
  return (
    <div className="host-steps" data-testid="host-steps">
      {groupSteps(fine ? ended : ended.filter(needs)).map((group) => (
        <div key={group.phase} className="host-phase">
          <div className="kicker" data-testid="host-phase">{group.label}</div>
          {group.rows.map(row)}
        </div>
      ))}
      {now && (
        <div className="host-step" data-testid="host-now">
          <span className="host-mark"><span className="move-spin" /></span><span className="host-said">{stepLabel(now.step)}…</span>
        </div>
      )}
      {ok.length > 0 && (
        <button type="button" className="sec-fold host-fine" data-testid="host-fine" aria-expanded={fine} onClick={() => unfold({ fine: !fine, setup })}>
          <Caret dir={fine ? 'down' : 'right'} />{plural(ok.length, 'check')} fine
        </button>
      )}
      {rows.length > 0 && (
        <div className="host-phase host-setup-rows">
          <div className="kicker">
            <button type="button" className="sec-fold" data-testid="host-setup-fold" aria-expanded={setup} onClick={() => unfold({ fine, setup: !setup })}>
              <Caret dir={setup ? 'down' : 'right'} />Your agent setup{' '}<span className="host-optional">optional</span>
            </button>
          </div>
          {setup && rows.filter((r) => !asideStep(r)).map(row)}
          {setup && apart.length > 0 && <div className="kicker" data-testid="host-aside">Runs only on a Mac, or not needed there</div>}
          {setup && apart.map(row)}
        </div>
      )}
    </div>
  );
}

// from: an add that stopped short, whose name and ssh fill the form in again
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
        {name && !machineName(name) && <div className="fleet-error" data-testid="host-name-problem">Name the machine with up to 32 lowercase letters, digits and dashes, starting with a letter</div>}
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
  const shut = useRef<HTMLButtonElement>(null);
  // kept while a terminal there stands in for the checklist, and folded again once the panel closes
  const [unfolded, unfold] = useState<Open>(SHUT);

  useEffect(() => {
    if (!open) { unfold(SHUT); return; }
    // a terminal there holds the keys, and a focused button would take its Return
    if (!app.store.getState().hostTerminal) shut.current?.focus();
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
  // a terminal opened from the panel goes back to its checks, which look again at the logins and fixes made there; one
  // opened from elsewhere closes the panel, back to where it was opened
  const ended = () => {
    if (!terminal?.fromPanel) { app.store.getState().toggleHost(false); return; }
    app.store.getState().closeHostTerminal();
    if (known && machine && !running) startHost('doctor', { name: machine });
  };
  const close = () => {
    if (term) ended();
    app.store.getState().toggleHost(false);
  };

  return (
    <div className="modal-back" data-testid="host-setup" onPointerDown={term ? undefined : close}>
      <div className="modal host dialog" onPointerDown={(e) => e.stopPropagation()}>
        <div className="kicker">
          {machine ? <span data-testid="host-machine">{machine}</span> : 'Add a machine'}
          <CloseX ref={shut} onClose={close} testid="host-close" />
        </div>
        <div className="host-body">
          {term ? <MachineTerminal name={machine} ssh={ssh} run={terminal.run} forward={terminal.forward} back={!!terminal.fromPanel && known} onEnd={ended} /> : (
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
                  open={unfolded} unfold={unfold} />
              )}
            </>
          )}
        </div>
        {!term && shown && <Outcome run={shown} />}
      </div>
    </div>
  );
}
