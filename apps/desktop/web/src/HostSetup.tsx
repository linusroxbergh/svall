import { AGENT_UPDATE, notNeeded, updatesHere, updatesIn, type AgentKind, type MachineId, type SetupRow } from '@svall/protocol';
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { app } from './boot.js';
import type { HostArgs, HostOp, HostStep } from './bridge.js';
import { CloseX } from './CloseX.js';
import { AS_TYPED } from './Field.js';
import {
  addedBy, asideStep, cdDir, groupSteps, keyLabel, loginForward, machineName, machineNames, OP_TITLE, outcomeOf, overHome, plainStep, plural, rowToStep,
  removedBy, runningLine, splitRaw, sshDestination, stepLabel, stepSaid, stepTier, type HostRun,
} from './host.js';
import { useApp, useMeasure } from './hooks.js';
import { startHost } from './hostRun.js';
import { Info } from './Info.js';
import { MachineTerminal } from './MachineTerminal.js';
import { answers, homeName } from './placement.js';
import { Said } from './Said.js';
import { placeTip } from './settings.js';
import { Caret, Mark, More } from './icons.js';
import type { App } from './store/index.js';
import { VarField } from './VarField.js';

// the machine's own setup, which installing this Mac's release there runs again
const SETUP = /^svall(-dev)? setup$/;
const isFarHome = (s: App): boolean => { const id = s.machines?.find((m) => m.name === s.hostMachine)?.id; return !!id && id === s.via?.home; };
// a machine of a far home is reached through that home, whose own ssh knows it
const homeSshOf = (s: App): string | undefined => (s.via && !isFarHome(s) ? s.machines?.find((m) => m.id === s.via!.home)?.ssh : undefined);
// a login's fix runs where the login starts: on a far home through its ssh, else on this Mac, which a machine's terminal is not
const useLoginTerminal = (step: string, terminal?: Terminal): Terminal | undefined =>
  useApp((s) => (step === 'ssh' || step === 'master') && !homeSshOf(s)) ? undefined : terminal;
const FORGET = /\bhost remove \S+ --forget\b/;
const UPGRADE = /\bhost upgrade\b/;
// why a machine's Check and Upgrade are off: one run on the machines at a time
const BUSY = 'Another run on a machine is under way';
// what a failed row runs again as it ran; an add goes back to its form, a remove to its foot, a home move through its sheet
const RUN_AGAIN = new Set<HostOp>(['upgrade', 'rollback']);
// the runs the sheet's title names with their machine, as `Check studio`
const TITLED = new Set<HostOp>(['doctor', 'upgrade', 'rollback', 'remove']);
// the ssh a terminal opens for the user, ahead of what an action says to run there
const SSH_THEN = /^ssh \S+, then /;
// what the sheet's own Check again does
const SEE_WHY = /^see why: .*\bhost doctor \S+$/;
const PHONE = 'mirror:phone';
const farId = (args: HostArgs): { id?: string } => (args.id ? { id: args.id } : {});
const homeOf = (s: App): string | undefined => (s.via ? homeName(s.fleet, s.via) : undefined);

/** What can be done to a machine in the registry, each on that machine and in the panel that follows it. `id`: the machine's,
 * where the row knows it, as a far home names itself otherwise than the registry; the registry's name is what svall takes. */
export function MachineActions({ id: rowId, name: shown, home = false, worker = false, menuOnly = false }: { id?: string; name: string; home?: boolean; worker?: boolean; menuOnly?: boolean }) {
  const running = useApp((s) => !!s.host?.running);
  const row = useApp((s) => s.machines?.find((m) => (rowId ? m.id === rowId : m.name === shown)));
  const release = useApp((s) => (row?.far && s.via ? `${s.via.name ?? 'the home'}'s` : "this Mac's"));
  const name = row?.name ?? shown;
  // a terminal needs the destination the registry has for it, which the page may not have read yet
  const reachable = !!row?.ssh;
  const id = row?.id;
  const dialedBy = row?.dialedBy;
  const unread = row?.unreadWorker;
  // why neither Remove nor Forget goes, and what clears it
  const stays = dialedBy ? 'It is the home of another fleet on this Mac; bring that fleet back first.'
    : unread && `Cannot read ${unread}, which may name this machine; fix it`;
  const placed = useApp((s) => Object.values(s.fleet.robots).filter((r) => id && (r.machine === id || r.moving?.to === id)).length);
  const up = useApp((s) => !!id && answers(s.fleet.machines?.[id as MachineId]));
  // a remove of it that did not finish leaves Forget the way to drop it, as its row's action says
  const unremoved = useApp((s) => !!s.host && s.host.op === 'remove' && !s.host.running && s.host.args.name === name && !removedBy(s.host));
  // on the release it would get, with nothing to fix, an upgrade does nothing: as a check of it just found, else as its last one did
  const current = useApp((s) => {
    const checked = s.host && !s.host.running && s.host.op === 'doctor' && s.host.args.name === name ? s.host : undefined;
    if (!checked?.steps.some((x) => x.step === 'release')) return !!row?.current;
    return !checked.steps.some((x) => !x.step.startsWith('mirror:') && (x.status === 'fail' || x.status === 'warn'));
  });
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
  // fixed to the window under ⋯, or over it where the window has more room there, so the panel scrolling it does not clip it;
  // from ⋯'s left edge, or from its right edge where the sheet or settings window it is in would end before the menu
  useMeasure(open, () => {
    const at = more.current?.getBoundingClientRect();
    const el = menu.current;
    if (!at || !el) return;
    const { above, maxHeight } = placeTip(at, el.scrollHeight, { top: 0, bottom: window.innerHeight });
    const edge = Math.min(window.innerWidth, more.current!.closest('.modal, .set-win')?.getBoundingClientRect().right ?? Infinity);
    const left = at.left + el.offsetWidth <= edge ? at.left : at.right - el.offsetWidth;
    setPlace({ left: Math.max(0, left), maxHeight: maxHeight || undefined,
      ...(above ? { bottom: window.innerHeight - at.top + 4 } : { top: at.bottom + 4 }) });
  });
  const store = () => app.store.getState();
  const far = row?.far ? { id: row.id } : {};
  const run = (op: HostOp) => { store().toggleHost(true, name); startHost(op, { name, ...far }); };
  const ask = (forget: boolean) => { store().toggleHost(true, name); store().confirmHost({ name, forget, ...far }); };
  const item = (fn: () => void) => () => { close(); fn(); };
  return (
    <span className="machine-acts" ref={box}>
      {!menuOnly && <button className="btn sm" data-testid="machine-doctor" disabled={running} data-tip={running ? BUSY : 'What to fix on the machine and what will not work there yet, checked now'} onClick={() => run('doctor')}>Check</button>}
      <button ref={more} className={menuOnly ? 'ib' : 'btn sm'} data-testid="machine-more" aria-haspopup="menu" aria-expanded={open} aria-label={menuOnly ? `More for ${name}` : 'More for this machine'}
        onClick={() => setOpen(!open)}><More /></button>
      {open && (
        <div ref={menu} className="machine-menu menu popover" role="menu" style={place}>
          {!current && !unremoved && <button role="menuitem" className="menu-item" data-testid="machine-upgrade" disabled={running} data-tip={running ? BUSY : `Install ${release} release there`} onClick={item(() => run('upgrade'))}>Upgrade to {release} release</button>}
          <button role="menuitem" className="menu-item" data-testid="machine-terminal" disabled={running || !reachable}
            data-tip={reachable ? 'A terminal on this machine, for what Svall leaves to you there' : `This Mac has no ssh route to ${name}`}
            onClick={item(() => store().openHostTerminal(name))}>Open terminal</button>
          {worker && id && !unremoved && (
            <button role="menuitem" className="menu-item" data-testid="machine-make-home" disabled={running} data-tip={`The fleet's islands, notes, settings and phone pairing move to ${name}; robots stay where they run`}
              onClick={item(() => { store().toggleHost(false); store().setHomeSheet({ to: id as MachineId, name, back: false }); })}>Make {name} this fleet's home…</button>
          )}
          {home && id && (
            <button role="menuitem" className="menu-item" data-testid="machine-bring-back" disabled={running} data-tip="The fleet's islands, notes, settings and phone pairing come back here; robots stay where they run"
              onClick={item(() => { store().toggleHost(false); store().setHomeSheet({ to: id as MachineId, name, back: true }); })}>Bring the fleet back to this Mac…</button>
          )}
          {!home && <div className="menu-sep" role="separator" />}
          {!home && !unremoved && <button role="menuitem" className="menu-item dan" data-testid="machine-remove" disabled={running || placed > 0 || !!stays}
            data-tip={stays || (placed ? `${placed === 1 ? '1 robot is' : `${placed} robots are`} placed there; move ${placed === 1 ? 'it' : 'them'} back first` : 'Uninstall Svall on this machine and drop its route')}
            onClick={item(() => ask(false))}>Remove</button>}
          {!home && (!up || unremoved) && (
            <button role="menuitem" className="menu-item dan" data-testid="machine-forget" disabled={running || !!stays}
              data-tip={stays || 'Drop the route for a machine that cannot be reached, leaving it untouched'} onClick={item(() => ask(true))}>Forget</button>
          )}
        </div>
      )}
    </span>
  );
}

/** The foot of a run: Stop while it runs; then its verdict, the way on first and the way out after it. `edit`: an add not made, asked again. */
function Outcome({ run, edit }: { run: HostRun; edit(): void }) {
  const fleet = useApp((s) => s.fleet);
  if (run.running) {
    return (
      <div className="host-foot" data-testid="host-running">
        <span className="host-verdict">{runningLine(run)}</span>
        <div className="acts">
          <button className="btn" data-testid="host-cancel" onClick={() => app.bridge.send({ type: 'host.cancel' })}>Stop</button>
        </div>
      </div>
    );
  }
  const o = outcomeOf(run, fleet);
  const name = run.args.name;
  const close = (pri: boolean, label = 'Done') => (
    <button className={pri ? 'btn pri' : 'btn'} data-testid="host-done" onClick={() => app.store.getState().toggleHost(false)}>{label}</button>
  );
  // after a run that did not finish, finding out why is the way on
  const again = <button className={o.failed ? 'btn pri' : 'btn'} data-testid="machine-doctor" onClick={() => startHost('doctor', { name, ...farId(run.args) })}>Check again</button>;
  // Done after a run that went through, Close after one that did not, always last
  const end = close(!!o.done, o.failed ? 'Close' : 'Done');
  const acts = run.op === 'add' && !addedBy(run) ? <><button className="btn pri" data-testid="host-edit" data-tip="Shows the form again, filled in" onClick={edit}>Try again</button>{close(false, 'Close')}</>
    : run.op === 'remove' ? (removedBy(run) ? close(true) : <><button className="btn pri" data-testid="host-again" onClick={() => startHost('remove', run.args)}>Try again</button>{close(false, 'Close')}</>)
    : o.next === 'rollback' ? (
      <>
        <button className="btn pri" data-testid="host-rollback" data-tip="Put back the release the machine ran before"
          onClick={() => startHost('rollback', { name, ...farId(run.args) })}>{OP_TITLE.rollback} {name}</button>
        {close(false, 'Close')}
      </>
    )
    : run.op === 'add' && o.done ? close(true)
    : run.op === 'add' || TITLED.has(run.op) ? <>{again}{end}</>
    : end;
  return (
    <div className="host-foot" data-testid="host-outcome">
      <div className="host-verdict">
        {o.text}
        {o.raw && <details className="modal-more"><summary><Caret dir="right" />details</summary><div className="modal-more-body mono">{o.raw}</div></details>}
      </div>
      <div className="acts">{acts}</div>
    </div>
  );
}

/** Opens a terminal on the machine with `command` typed; `why`, what it is for. */
type Terminal = (command: string, forward?: number, step?: string, why?: string) => void;

function Row({ row, run, terminal: opener }: { row: HostStep; run: HostRun; terminal?: Terminal }) {
  const terminal = useLoginTerminal(row.step, opener);
  const name = run.args.name;
  // the run's own far id, as this Mac's registry may give its name to another machine
  const id = useApp((s) => run.args.id ?? s.machines?.find((m) => m.name === name)?.id);
  const home = useApp(homeOf);
  // the tick asked for while svalld pushes it, and an agent update under way there
  const [asked, setAsked] = useState<boolean>();
  const [updating, setUpdating] = useState(false);
  const [failed, setFailed] = useState<string>();
  const updates = row.run ? updatesIn(row.run) : undefined;
  const onMac = updatesHere(`${row.detail ?? ''}; ${row.action ?? ''}`);
  const sentence = useId();
  const { line, raw: told } = stepSaid(row, name);
  // a check whose sentence ends in the command its terminal types says only how it stands, the command behind details
  const from = row.run && !row.action && line ? line.lastIndexOf(row.run) : -1;
  const cut = from > 0 ? Math.max(line!.lastIndexOf(': ', from), line!.lastIndexOf('; ', from)) : -1;
  const said = cut > 0 ? line!.slice(0, cut) : line ?? row.action;
  const command = cut > 0 ? line!.slice(cut + 2) : undefined;
  // a state and what it leads to, which goes to the next line whole when the two do not fit on one
  const [state, leads] = said?.includes(': ') ? [said.slice(0, said.indexOf(': ')), said.slice(said.indexOf(': ') + 2)] : [said, undefined];
  const idle = !run.running;
  // no upgrade from a row while the machine runs a newer release or serves another Mac: a fix that is not an upgrade
  const noUpgrade = run.steps.some((s) => (s.step === 'release' || s.step === 'worker') && s.action && !UPGRADE.test(s.action));
  const release = useApp((s) => (s.via?.name && s.via.home !== id ? `${s.via.name}'s` : "this Mac's"));
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
  // an item with some of its keys ticked: its box reads mixed, and a click takes those back, granting none of the rest
  const partial = !!row.tick && !row.tick.on && !!row.tick.ticked?.length;
  const tick = (machine: MachineId, on: boolean) => {
    const show = take();
    setAsked(on);
    setFailed(undefined);
    app.api().call('machines.consent', { machine, item: row.tick!.item, fields: on ? row.tick!.fields : row.tick!.ticked ?? row.tick!.fields, on })
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
      .then(() => { if (!app.store.getState().host?.running) startHost('doctor', { name, ...farId(run.args) }); }, fail)
      .finally(() => setUpdating(false));
  };
  // a key's row is named by its key, and its box copies it; a program's box says the machine does not need it
  const key = !!row.tick && !notNeeded(row) && row.step !== PHONE;
  const label = key ? keyLabel(row) : stepLabel(row.step, home);
  // setup there puts it right: this fleet's, or a named fleet's, which an upgrade from here writes again
  const bySetup = row.run ? SETUP.test(row.run) : !!row.action && UPGRADE.test(row.action);
  // a key the machine has its own of, with none of its keys ticked, is nothing to copy over
  const own = key && row.status === 'ok' && !row.tick?.on && !row.tick?.ticked?.length;
  const control = row.tick && !own ? 'tick'
    : (updates || onMac) && idle ? 'update'
    : run.op === 'doctor' && row.step === 'release' && row.status === 'fail' && !(row.action && !UPGRADE.test(row.action)) && idle ? 'upgrade'
    : run.op === 'doctor' && row.step === 'worker' && row.status === 'fail' && !noUpgrade && idle ? 'worker'
    : run.op === 'doctor' && bySetup && run.steps.some((s) => s.step === 'release' && s.status === 'ok') && !noUpgrade && idle ? 'repair'
    : row.step.startsWith('mirror:var:') && row.status === 'warn' && row.action && id && idle ? 'var'
    // a remove that did not finish offers Forget in its ⋯ menu
    : run.op !== 'remove' && row.status === 'fail' && row.action && FORGET.test(row.action) && id && idle ? 'forget'
    : row.run && terminal && idle ? 'terminal'
    : RUN_AGAIN.has(run.op) && !row.action && row.status === 'fail' && idle ? 'again'
    : undefined;
  // a program row keeps its install command's terminal beside the box that says the machine does not need it, and the phone's its repair beside its own
  const opens = control === 'terminal' || ((notNeeded(row) || row.step === PHONE) && !!row.run && !!terminal && idle);
  // what to do, as the row says it or its sentence ended in it, less what its box does and the ssh its terminal opens; then what a tool said
  const fix: Fix = key && row.action ? besideBox(row.action) : { say: row.action && !SEE_WHY.test(row.action) ? row.action : undefined };
  const todo = fix.say && fix.say !== said ? fix.say : command;
  const action = opens ? todo?.replace(SSH_THEN, '') : todo;
  const more = [...new Set([row.raw, told])].filter((m): m is string => !!m && m !== said);
  // what the command a terminal types is for, where the row's state says it; a server's login takes /mcp after it, which its command says
  const purpose = row.step.startsWith('mirror:oauth:') ? undefined
    : /\bnot logged in\b/.test(said ?? '') ? `log in to ${label}` : /\bnot installed\b/.test(said ?? '') ? `install ${label}` : undefined;
  const open = (
    <button className="btn sm" data-testid={`host-terminal-${row.step}`} data-tip={`Opens a terminal on ${name} with ${row.run} typed, for you to run`}
      onClick={() => terminal!(row.run!, row.forward, row.step, purpose)}>Open terminal</button>
  );
  const box = row.tick && (
    <label className="host-tick" data-tip={id && !idle ? BUSY : undefined}>
      {/* a tick under way keeps the box, and focus on it, and takes no second change */}
      <input type="checkbox" data-testid={`host-tick-${row.step}`} aria-describedby={sentence}
        aria-label={notNeeded(row) ? `${label} is not needed on ${name}` : key ? `Copy ${label} to ${name}` : label}
        checked={asked ?? row.tick.on} disabled={!id || !idle} aria-disabled={asked !== undefined || undefined}
        ref={(el) => { if (el) el.indeterminate = asked === undefined && partial; }}
        data-tip={id && notNeeded(row) ? `Tick when ${name} does not need it; the row then stands aside` : undefined}
        onChange={(e) => { if (id && asked === undefined) tick(id as MachineId, !partial && e.target.checked); }} />
      {notNeeded(row) ? 'not needed' : key ? 'copy' : 'on'}
    </label>
  );
  const controls: Record<string, () => ReactNode> = {
    tick: () => (opens ? <span className="host-ctl">{open}{box}</span> : box),
    update: () => (
      <button className="btn sm" data-testid={`host-update-${row.step}`} disabled={updating || !id}
        data-tip={id && `Runs ${[updates && `${row.run} on ${name}`, onMac && `${onMac.map((k) => AGENT_UPDATE[k]).join(' && ')} on this Mac`].filter(Boolean).join(', then ')}, then checks again`}
        onClick={() => update(id as MachineId, updates, onMac)}>Update</button>
    ),
    upgrade: () => <button className="btn sm" data-testid="host-upgrade" data-tip={`Install ${release} release there`} onClick={() => startHost('upgrade', { name, ...farId(run.args) })}>Upgrade</button>,
    worker: () => (
      <button className="btn sm" data-testid="host-worker" data-tip={`Install ${release} release there and run this fleet's robots on ${name}`}
        onClick={() => startHost('upgrade', { name, ...farId(run.args) })}>Set up</button>
    ),
    repair: () => (
      <button className="btn sm" data-testid={`host-repair-${row.step}`} data-tip={`Install ${release} release on ${name} again, whose setup puts this right`}
        onClick={() => startHost('upgrade', { name, ...farId(run.args) })}>Repair</button>
    ),
    var: () => (
      <VarField machine={id as MachineId} name={name} varName={row.step.slice('mirror:var:'.length)} here={row.here} testid={`host-var-${row.step}`}
        take={() => { setFailed(undefined); return take(); }} failed={(m) => fail(new Error(m))} />
    ),
    forget: () => (
      <button className="btn sm" data-testid={`host-forget-${row.step}`} data-tip={`Drop the route to ${name}, leaving the machine untouched`}
        onClick={() => app.store.getState().confirmHost({ name, forget: true, ...farId(run.args) })}>Forget</button>
    ),
    terminal: () => open,
    again: () => <button className="btn sm" data-testid={`host-again-${row.step}`} onClick={() => startHost(run.op, run.args)}>Try again</button>,
  };
  return (
    <div className="host-step" data-testid={`host-step-${row.step}`} data-status={row.status}>
      <span className="host-mark"><Mark status={isSetup(row) && row.status === 'warn' ? 'start' : row.status} /></span>
      <span className="host-name" data-tip={label}>{label}</span>
      <div className="host-said">
        {updating ? <span id={sentence} data-testid={`host-updating-${row.step}`}>updating {[updates && `on ${name}`, onMac && 'on this Mac'].filter(Boolean).join(' and ')}…</span>
          : asked !== undefined ? <span id={sentence} data-testid={`host-pushing-${row.step}`}>pushing to {name}…</span>
          : <span id={sentence}>{state}{leads && <>: <span className="host-leads">{leads}</span></>}</span>}
        {(action || fix.runs || more.length > 0) && (
          <details className="modal-more" data-testid={`host-details-${row.step}`}>
            <summary><Caret dir="right" />details</summary>
            <div className="modal-more-body">
              {action && <span data-testid={`host-action-${row.step}`} className={action === row.run ? 'host-cmd' : undefined}>{action}</span>}
              {fix.runs && <code className="host-cmd" data-testid={`host-command-${row.step}`}>{fix.runs}</code>}
              {fix.then && <span>{fix.then}</span>}
              {more.map((m) => <span key={m} className="mono">{m}</span>)}
            </div>
          </details>
        )}
        {failed && <div className="host-failed" role="status" data-testid={`host-tick-failed-${row.step}`}><Said {...splitRaw(failed)} /></div>}
      </div>
      {control && controls[control]()}
    </div>
  );
}

const isSetup = (s: HostStep): boolean => s.step.startsWith('mirror:');

/** What to do about a row: a sentence, the command it names, and a sentence after that. */
type Fix = { say?: string; runs?: string; then?: string };

/** A key row's action less what its box beside it does: what else would do, as a sentence and its command, or nothing. */
function besideBox(action: string): Fix {
  const box = /^Tick to copy(?: the whole file, keys included)?(, or |\. |$)/.exec(action);
  if (!box) return { say: action };
  const rest = action.slice(box[0].length);
  if (box[1] !== ', or ') return rest ? { say: rest } : {};
  const set = /^set (.+?): (.+?)(?:\. (.+))?$/.exec(rest);
  return set ? { say: `Set ${set[1]} instead:`, runs: set[2], ...(set[3] && { then: set[3] }) } : { say: `S${rest.slice(1)} instead.` };
}

// which folded parts of the checklist are open: the notes, the fine checks, the agent setup and its rows already there
type Open = { notes: boolean; fine: boolean; setup: boolean; there: boolean };
const SHUT: Open = { notes: false, fine: false, setup: false, there: false };

const Fold = ({ open, testid, flip, children }: { open: boolean; testid: string; flip(): void; children: ReactNode }) => (
  <button type="button" className="sec-fold host-fine" data-testid={testid} aria-expanded={open} onClick={flip}><Caret dir={open ? 'down' : 'right'} />{children}</button>
);

/** The fine checks under the sections they belong to; a section of one row goes without a heading, first, so no heading seems to hold it. */
function Sections({ rows, name, row }: { rows: HostStep[]; name: string; row: (r: HostStep) => ReactNode }) {
  const groups = groupSteps(rows, name);
  const alone = groups.filter((g) => g.rows.length === 1).flatMap((g) => g.rows);
  return (
    <>
      {alone.length > 0 && <div className="host-phase">{alone.map(row)}</div>}
      {groups.filter((g) => g.rows.length > 1).map((group) => (
        <div key={group.phase} className="host-phase">
          <div className="kicker" data-testid="host-phase">{group.label}</div>
          {group.rows.map(row)}
        </div>
      ))}
    </>
  );
}

/** The rows that need the person, flat, then the step under way; then the notes, the fine checks by section, and the agent setup, each folded behind one line. */
function Checklist({ run, terminal, open, unfold }: { run: HostRun; terminal?: Terminal; open: Open; unfold: (o: Open) => void }) {
  const fleet = useApp((s) => s.fleet);
  const name = run.args.name;
  const steps = run.steps.filter((s) => !isSetup(s));
  const now = run.running ? steps.filter((s) => s.status === 'start').at(-1) : undefined;
  // a step still under way when the run ended is where it stopped; while the service is said not to run, its port's missing file
  // (svalld's one warn) only says so again, and any other port row stands
  const down = steps.some((s) => (s.step === 'systemd' || s.step === 'launchd') && s.status === 'fail' && s.detail !== 'could not be read');
  const ended = (run.running ? steps.filter((s) => s.status !== 'start') : steps).filter((s) => !(down && s.step === 'svalld' && s.status === 'warn'));
  // a run that does something to the machine is its steps, in order; an add or a check, the machine's checks by section
  const flow = run.op !== 'add' && run.op !== 'doctor';
  // a step flow's rollback says what the machine runs now, so it stays in sight whatever it found
  const tier = (s: HostStep) => (s.status === 'start' || (flow && s.step === 'rollback') ? 'todo' : stepTier(s, run.op, fleet));
  const [found, notes, fine] = (['todo', 'note', 'fine'] as const).map((t) => ended.filter((s) => tier(s) === t));
  // a check lists what failed first; a run's steps keep the order they ran in
  const todo = flow ? found : [...found.filter((s) => s.status === 'fail'), ...found.filter((s) => s.status !== 'fail')];
  // a check that waits on another that failed was not made, which no fine count holds
  const unchecked = fine.filter((s) => s.status === 'skip' && s.detail === 'not checked').length;
  // rows that act on the machine wait for this Mac's list to name it, as an add's do until the list is read again
  const waits = (s: HostStep) => !!s.tick || !!(s.run && updatesIn(s.run)) || !!updatesHere(`${s.detail ?? ''}; ${s.action ?? ''}`);
  const unlisted = useApp((s) => !run.running && !run.args.id && !s.machines?.some((m) => m.name === name)) && run.steps.some(waits);
  const setup = run.steps.filter(isSetup);
  // a row set up from here stays in sight until the machine is checked again: a run's args stay with it as its rows change
  const listed = useRef<{ of?: HostArgs; steps: Set<string> }>({ steps: new Set() });
  if (listed.current.of !== run.args) listed.current = { of: run.args, steps: new Set() };
  for (const s of setup) if (s.status !== 'ok') listed.current.steps.add(s.step);
  // what is left to set up, then what stands aside, then what is already there behind its own line
  const there = setup.filter((s) => s.status === 'ok' && !listed.current.steps.has(s.step));
  const rest = setup.filter((s) => !there.includes(s));
  const left = [...rest.filter((s) => !asideStep(s)), ...rest.filter(asideStep)];
  const gaps = setup.filter((s) => s.gap && !asideStep(s)).length;
  // keyed by its place in the run, so a row keeps its update under way as the folds open and shut
  const row = (r: HostStep) => <Row key={`${r.step}-${run.steps.indexOf(r)}`} row={r} run={run} terminal={terminal} />;
  const flip = (k: keyof Open) => () => unfold({ ...open, [k]: !open[k] });
  return (
    <div className="host-steps" data-testid="host-steps">
      {unlisted && <span className="modal-sub" data-testid="host-unlisted">Check again to list {name} here; Update and the copy boxes work after that.</span>}
      {todo.length > 0 && <div className="host-phase">{todo.map(row)}</div>}
      {now && (
        <div className="host-step host-now" data-testid="host-now">
          <span className="host-mark"><span className="move-spin" /></span><span className="host-said">{stepLabel(now.step)}…</span>
        </div>
      )}
      {notes.length > 0 && (
        <div className="host-phase host-notes-rows">
          <Fold open={open.notes} testid="host-notes" flip={flip('notes')}>{plural(notes.length, 'note')}</Fold>
          {open.notes && <div className="host-folded">{notes.map(row)}</div>}
        </div>
      )}
      {fine.length > 0 && (
        <div className="host-phase">
          <Fold open={open.fine} testid="host-fine" flip={flip('fine')}>
            {flow ? `${plural(fine.length - unchecked, 'step')} done` : `${plural(fine.length - unchecked, 'check')} fine`}
            {unchecked > 0 && ` · ${unchecked} not checked`}
          </Fold>
          {open.fine && (
            <div className="host-folded">
              {flow ? fine.map(row) : <Sections rows={fine} name={name} row={row} />}
            </div>
          )}
        </div>
      )}
      {setup.length > 0 && (
        <div className="host-phase host-setup-rows">
          <div className="host-fold">
            <Fold open={open.setup} testid="host-setup-fold" flip={flip('setup')}>Your agent setup · {gaps ? `${gaps} not on ${name} yet` : 'all there'}</Fold>
            <Info id="host-setup">None of this stops a move there. Set it up when a robot there needs it.</Info>
          </div>
          {open.setup && (
            <div className="host-folded">
              {left.map(row)}
              {/* what is there folds under its own line only below what is not */}
              {left.length > 0 && there.length > 0 && <Fold open={open.there} testid="host-setup-there" flip={flip('there')}>{there.length} already there</Fold>}
              {(open.there || !left.length) && there.map(row)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** What a new machine needs, its name and ssh, and Add machine; `from`, an add that stopped short, whose name and ssh fill it in again. */
function AddForm({ from }: { from?: HostArgs }) {
  const home = useApp(homeOf);
  const [name, setName] = useState(from?.name ?? '');
  const [ssh, setSsh] = useState(from?.ssh ?? '');
  // an example that is never the home
  const example = home === 'atlas' ? 'studio' : 'atlas';
  const wanting = !machineName(name) ? 'Needs a name: lowercase letters, digits and dashes' : !sshDestination(ssh) ? `Needs the ssh destination, such as you@${example}` : undefined;
  return (
    <>
      <div className="host-body">
        <div className="host-note" data-testid="host-intro">
          <span>
            {`${home ? `${home} installs` : 'Installs'} Svall on a Linux machine over ssh and lists what is left to do.`}
            <Info id="host-needs">Ubuntu 22.04 LTS or newer with systemd, x86-64 or arm64, and an account {home ? `${home} reaches` : 'you reach'} over ssh.</Info>
          </span>
        </div>
        <div className="host-form">
          <label>
            <span className="modal-sub">name</span>
            <input className="fld" data-testid="host-name" placeholder={example} {...AS_TYPED} value={name} onChange={(e) => setName(e.target.value.trim())} />
          </label>
          {name && !machineName(name) && <div className="fleet-error" data-testid="host-name-problem">Name the machine with up to 32 lowercase letters, digits and dashes, starting with a letter</div>}
          <label>
            <span className="modal-sub">ssh destination</span>
            <input className="fld" data-testid="host-ssh" placeholder={`you@${example}`} {...AS_TYPED} value={ssh} onChange={(e) => setSsh(e.target.value.trim())} />
          </label>
        </div>
      </div>
      <div className="host-foot">
        <div className="acts">
          <button className="btn pri" data-testid="host-add" disabled={!!wanting} data-tip={wanting} onClick={() => startHost('add', { name, ssh })}>Add machine</button>
        </div>
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
  // what the machine is to this fleet, as its row in Settings says: the far home this window follows, or a worker of this Mac's home it reaches
  const isHome = useApp((s) => { const id = s.machines?.find((m) => m.name === s.hostMachine)?.id; return !!id && id === s.via?.home; });
  const isWorker = useApp((s) => { const m = s.machines?.find((r) => r.name === s.hostMachine); return !s.via && !!m?.ssh && !!s.fleet.machines?.[m.id as MachineId]; });
  const terminal = useApp((s) => s.hostTerminal);
  // the registry's destination, or the one an add not yet in the registry was given
  const ssh = useApp((s) => s.machines?.find((m) => m.name === s.hostMachine)?.ssh ?? (s.host?.args.name === s.hostMachine ? s.host?.args.ssh : undefined));
  const homeSsh = useApp(homeSshOf);
  const homeLabel = useApp((s) => s.via?.name);
  const forward = homeSsh && terminal?.run && !terminal.bare ? loginForward(terminal.run, terminal.forward) : terminal?.forward;
  const typed = !homeSsh || terminal?.bare ? terminal?.run : terminal?.run ? overHome(ssh!, terminal.run, forward) : `ssh ${ssh}`;
  const shut = useRef<HTMLButtonElement>(null);
  // kept while a terminal there stands in for the checklist, and folded again once the panel closes
  const [unfolded, unfold] = useState<Open>(SHUT);
  // the add that did not go through, asked again with its form filled
  const [editing, edit] = useState<HostRun>();

  useEffect(() => {
    if (!open) { unfold(SHUT); edit(undefined); return; }
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
  const gone = !!shown && !running && removedBy(shown);
  // an add the registry does not hold yet is still the add, not the machine
  const adding = shown?.op === 'add' && (running || !addedBy(shown));
  const form = (!machine && !shown) || (!!editing && editing === shown);
  const term = terminal && machine && ssh;
  // the machine the terminal's command runs on: the home for its own login's fix, else the machine the sheet is about
  const at = homeSsh && terminal?.bare ? homeLabel ?? machine : machine;
  // a terminal opened from the panel goes back to its checks, which look again at the logins and fixes made there; one
  // opened from elsewhere closes the panel, back to where it was opened
  const ended = () => {
    if (!terminal?.fromPanel) { app.store.getState().toggleHost(false); return; }
    app.store.getState().closeHostTerminal();
    if (known && machine && !running) startHost('doctor', { name: machine, ...(shown && farId(shown.args)) });
  };
  const close = () => {
    if (term) ended();
    app.store.getState().toggleHost(false);
  };
  // the fix of a home that cannot log in is that home's own
  const opens: Terminal | undefined = machine && ssh ? (line, port, step, why) => app.store.getState().openHostTerminal(machine, line, port, step === 'ssh' || step === 'master', why) : undefined;
  const name = shown?.args.name ?? machine;
  const title = term ? `${terminal.run !== undefined && cdDir(terminal.run) !== undefined ? 'Shell' : 'Terminal'} on ${at}`
    : form ? 'Add a machine'
    : confirm ? `${confirm.forget ? 'Forget' : 'Remove'} ${confirm.name}`
    : !shown ? machine
    : adding ? `Add ${name}`
    : TITLED.has(shown.op) ? `${shown.args.forget ? 'Forget' : OP_TITLE[shown.op]} ${name}`
    : name;
  const menu = !!machine && !term && !form && !confirm && !adding && !gone && (!shown || shown.args.name === machine);
  const failed = adding && !running ? shown.steps.find((s) => s.status === 'fail') : undefined;

  return (
    <div className="modal-back" data-testid="host-setup" onPointerDown={term ? undefined : close}>
      <div className="modal host dialog" onPointerDown={(e) => e.stopPropagation()}>
        <div className="kicker">
          <span data-testid="host-machine">{title}</span>
          {menu && <MachineActions id={shown?.args.id} name={machine} home={isHome} worker={isWorker} menuOnly />}
          <CloseX ref={shut} onClose={close} testid="host-close" />
        </div>
        {term ? (
          <div className="host-body">
            <MachineTerminal name={machine} on={at} ssh={homeSsh ?? ssh} run={typed} asked={terminal.run} why={terminal.why} forward={forward} back={!!terminal.fromPanel && known} onEnd={ended} />
          </div>
        ) : form ? <AddForm key={machine ?? ''} from={editing?.args} /> : confirm ? (
          <>
            <div className="host-body">
              <div className="host-note" data-testid="host-confirm" data-op={confirm.forget ? 'forget' : 'remove'}>
                {confirm.forget ? `Forget drops ${confirm.name} from this list. Nothing on it changes.` : `Remove uninstalls Svall on ${confirm.name}. Its fleets and files stay there.`}
              </div>
            </div>
            <div className="host-foot">
              <div className="acts">
                <button className="btn dan" data-testid="host-confirm-yes"
                  onClick={() => startHost('remove', { name: confirm.name, ...(confirm.forget && { forget: true }), ...(confirm.id && { id: confirm.id }) })}>
                  {confirm.forget ? 'Forget' : 'Remove'} {confirm.name}
                </button>
                <button className="btn" data-testid="host-confirm-no" onClick={() => app.store.getState().confirmHost(undefined)}>Cancel</button>
              </div>
            </div>
          </>
        ) : !shown ? (
          <>
            <div className="host-body" />
            <div className="host-foot">
              <div className="acts">
                <button className="btn pri" data-testid="machine-doctor" onClick={() => startHost('doctor', { name: machine! })}>Check</button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="host-body">
              {adding && running && <span className="modal-sub">{shown.args.ssh}</span>}
              {adding && !running ? failed && <NotAdded row={failed} terminal={opens} />
                : <Checklist run={shown} terminal={opens} open={unfolded} unfold={unfold} />}
            </div>
            <Outcome run={shown} edit={() => edit(shown)} />
          </>
        )}
      </div>
    </div>
  );
}

/** Where an add that did not go through stopped, as a row of the checklist: the step, how it stands, what to do under it, a tool's words behind details. */
function NotAdded({ row, terminal: opener }: { row: HostStep; terminal?: Terminal }) {
  const terminal = useLoginTerminal(row.step, opener);
  const { line, raw } = splitRaw(row.detail ?? row.action ?? '');
  return (
    <div className="host-steps" data-testid="host-not-added">
      <div className="host-step" data-testid={`host-step-${row.step}`} data-status="fail">
        <span className="host-mark"><Mark status="fail" /></span>
        <span className="host-name">{stepLabel(row.step)}</span>
        <div className="host-said">
          <Said line={line} fix={row.detail ? row.action : undefined} raw={[raw, row.raw].filter(Boolean).join('\n') || undefined} mark={false} />
        </div>
        {row.run && terminal && <button className="btn sm" data-testid={`host-terminal-${row.step}`} onClick={() => terminal(row.run!, row.forward, row.step)}>Open terminal</button>}
      </div>
    </div>
  );
}
