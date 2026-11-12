import { useEffect, useRef, useState } from 'react';
import { CONFIG_WORD, type Blocker, type MachineId, type Result } from '@svall/protocol';
import { loadMobileStatus } from './actions.js';
import { app, deps } from './boot.js';
import { openFolder, type HostStep } from './bridge.js';
import { CloseX } from './CloseX.js';
import { dialogKeys, useApp } from './hooks.js';
import { onThisMac, plural, splitRaw, stepLabel } from './host.js';
import { startHost } from './hostRun.js';
import { Caret, Mark } from './icons.js';
import { Info } from './Info.js';
import { blockersOf, INTERRUPT_AFTER_MS, interruptOf, KEPT, type Interrupt } from './MoveSheet.js';
import { MobilePanel, PhoneProblem } from './PhonePanel.js';
import { phoneProblem } from './phoneText.js';
import { Said } from './Said.js';

type Check = Result<'fleet.homeCheck'> | { error: string };

// what a move's run says of itself, in the order it goes: its marker is its own business
const STEPS = (name: string, back: boolean): [string, string][] => [
  ['check', 'Check'],
  ['mission', `Mission control's robots move to ${back ? 'this Mac' : name}`],
  ['pause', back ? `Pause ${name}` : 'Pause this Mac'],
  ['copy', 'Copy the fleet'],
  ['adopt', back ? 'This Mac takes over' : `${name} takes over`],
  ['join', back ? `${name} joins` : 'This Mac joins'],
  ['probe', 'Reconnect'],
  ['workers', 'The other workers join'],
];
// any move's id lets mission control's robots be checked, which moves nothing
const CHECK_MOVE = 'hm_crewcheck0';
// the refusal of a fleet too big to carry, whose files a person trims on this Mac
const TOO_BIG = /^the fleet's files /i;
type Row = { step: string; words: string; row?: HostStep; now: 'todo' | 'doing' | 'failed' | 'warned' | 'done' };

/** A sentence that carries what a tool said apart, or, with none, cut where a tool's words begin. */
const rawOf = (text: string, raw?: string): { line: string; raw?: string } => (raw ? { line: text, raw } : splitRaw(text));

/** What mission control's robots answer a move to `machine`, asked of the home that holds them, each refusal by the robot's name. */
async function crewChecks(mission: { id: string; name: string }[], machine: MachineId, interrupt: boolean): Promise<Blocker[]> {
  const answers = await Promise.all(mission.map(async (r) => ({
    r, a: await app.api().call('robot.moveCheck', { id: r.id, machine, homeMove: CHECK_MOVE, ...(interrupt && { interruptAfterMs: INTERRUPT_AFTER_MS }) }),
  })));
  return answers.flatMap(({ r, a }) => (a.ok ? [] : blockersOf(a.refusal).map((b) => ({ ...b, reason: b.reason.startsWith(r.name) ? b.reason : `${r.name}: ${b.reason}` }))));
}

/** Moving the fleet's home to a worker, or back here, in the move sheet's style: what moves, its checks, then its steps as they run. */
export function HomeSheet() {
  const ask = useApp((s) => s.homeSheet);
  const host = useApp((s) => (s.host?.op === 'home' ? s.host : undefined));
  const busy = useApp((s) => !!s.host?.running);
  // where the fleet's home goes, and whether the window follows it there, whose phone the sheet ends on
  const target = useApp((s) => (s.homeSheet?.back ? s.via?.machine : s.homeSheet?.to));
  const reached = useApp((s) => (s.homeSheet?.back ? !s.via : s.via?.home === s.homeSheet?.to && !!s.via?.online));
  const [check, setCheck] = useState<Check>();
  // what mission control's robots answer the move, undefined while they are asked; a robot at work is interrupted only on the
  // choice its box keeps, as in the move sheet, `working` saying why
  const [crew, setCrew] = useState<Blocker[]>();
  const [interrupt, setInterrupt] = useState<Interrupt | false>();
  const [working, setWorking] = useState<string>();
  const [started, setStarted] = useState(false);
  const [unfolded, setUnfolded] = useState(false);
  // a move that stopped past its mark stands until it is finished or called off, which holds the crew where it is
  const stands = useApp((s) => !!s.homeMove && !s.homeMove.unmarked);
  // the fleet's files are trimmed where they are: on this Mac, when it is the home
  const fleetHome = useApp((s) => (s.via ? undefined : s.shell?.home));
  const shut = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => { app.store.getState().setHomeSheet(undefined); };
  const look = () => {
    if (!target) return;
    setCheck(undefined);
    setCrew(undefined);
    const api = app.api().local ?? app.api();
    api.call('fleet.homeCheck', { to: target }).then(setCheck, (e: Error) => setCheck({ error: e.message }));
  };
  useEffect(() => { setStarted(false); setInterrupt(undefined); setWorking(undefined); setUnfolded(false); look(); }, [ask?.to, ask?.back]);
  const mission = check && 'ok' in check && check.ok ? check.sheet.mission : undefined;
  // the last answer stands while a choice is asked about again
  useEffect(() => {
    if (!mission?.length || !target) return;
    let live = true;
    crewChecks(mission, target, !!interrupt).then((refused) => {
      if (!live) return;
      const at = interrupt === undefined ? refused.filter((b) => interruptOf(b.action)) : [];
      if (!at.length) return setCrew(refused);
      setWorking(at.map((b) => b.reason).join('; '));
      setInterrupt(interruptOf(at[0].action));
    }, (e: Error) => { if (live) setCrew([{ reason: e.message, action: 'check again' }]); });
    return () => { live = false; };
  }, [check, interrupt]);
  // the focus stays in the sheet: on its ×, or on the sheet itself while a run hides that
  useEffect(() => { if (ask && !panel.current?.contains(document.activeElement)) (shut.current ?? panel.current)?.focus(); });
  const run = started ? host : undefined;
  const failed = run?.steps.find((s) => s.status === 'fail');
  const ended = !!run && !run.running;
  const done = ended && !failed && run.code === 0;
  // the phone's link is the old home's until the new home answers for its own
  useEffect(() => { if (done) app.store.getState().setMobile(undefined); }, [done]);
  if (!ask) return null;
  const { name, back } = ask;
  const dest = back ? 'this Mac' : name;
  const shutUnlessRunning = () => { if (!(started && host?.running)) close(); };
  const go = () => {
    if (startHost('home', { name: back ? 'local' : name, ...(interrupt && { interrupt: true }) })) setStarted(true);
  };
  // a press at the foot of a stopped move hands it to the run that finishes it, calls it off or brings the crew back, which its banner then shows
  const then = (op: 'home-retry' | 'home-abort' | 'home-crew') => () => { close(); startHost(op, { name: '' }); };
  const refused = check && 'ok' in check && !check.ok ? check.refusal : undefined;
  const sheet = check && 'sheet' in check ? check.sheet : undefined;
  const crewSaid = mission && !mission.length ? [] : crew;
  const ready = !!mission && crewSaid?.length === 0;
  const checking = !check || (!!mission && !crewSaid);
  const steps = STEPS(name, back);
  // what the run reports past its rows, as a failure at the mark or the shell's own, or mission control left away
  const more = run?.steps.filter((s) => (s.status === 'fail' || s.status === 'warn') && !steps.some(([k]) => k === s.step)).map((s): [string, string] => [s.step, stepLabel(s.step)]) ?? [];
  // each step the run shows, a move that carried no other worker showing none of that row
  const rows = !run ? [] : [...steps, ...more].flatMap(([step, words]): Row[] => {
    const row = run.steps.find((s) => s.step === step);
    if (row?.status === 'skip' || (!row && step === 'workers')) return [];
    const now = !row ? 'todo' : row.status === 'start' ? 'doing' : row.status === 'fail' ? 'failed' : row.status === 'warn' ? 'warned' : 'done';
    return [{ step, words, row, now }];
  });
  const shown = failed ? rows.filter((r) => r.now !== 'todo') : rows;
  const item = ({ step, words, row, now }: Row) => {
    const said = (now === 'failed' || now === 'warned') && row ? row : undefined;
    const todo = said && (said.say ?? said.action);
    // why, and what to do under it; a row that says only what to do says that
    const told = said?.detail ? { ...rawOf(onThisMac(said.detail), said.raw), fix: todo && onThisMac(todo) } : todo ? { line: onThisMac(todo) } : undefined;
    return (
      <li key={step} data-state={now} data-testid={`home-step-${step}`}>
        <span className="move-mark" aria-hidden>{now === 'doing' ? <span className="move-spin" /> : <Mark status={({ done: 'ok', failed: 'fail', warned: 'warn', todo: 'todo' } as const)[now]} />}</span>
        <div>{words}{told && <div data-testid={now === 'failed' ? 'home-failed' : undefined}><Said {...told} /></div>}</div>
      </li>
    );
  };
  const crewLeft = !!run?.steps.some((s) => s.step === 'crew' && s.status === 'warn');
  return (
    <div className="modal-back" data-testid="home-sheet" onPointerDown={shutUnlessRunning}>
      <div className="modal sheet dialog" ref={panel} tabIndex={-1} role="dialog" aria-label={back ? 'Bring the fleet back' : `Make ${name} the home`} onPointerDown={(e) => e.stopPropagation()} onKeyDown={dialogKeys(shutUnlessRunning)}>
        <div className="kicker"><span data-testid="home-title">{back ? 'Bring the fleet back to this Mac' : `Make ${name} this fleet's home`}</span>{!run?.running && <CloseX ref={shut} onClose={close} testid="home-close" />}</div>
        {!run && checking && <div className="host-note" data-testid="home-checking"><span className="move-state"><span className="move-mark"><span className="move-spin" /></span>Checking that the fleet can move…</span></div>}
        {!run && ready && <span className="move-state" data-state="ready" data-testid="home-ready"><span className="move-mark"><Mark status="ok" /></span>Ready to move</span>}
        {!run && (!!refused || !!crewSaid?.length) && <span className="move-state" data-state="blocked" data-testid="home-blocked"><span className="move-mark"><Mark status="warn" /></span>Not ready to move yet</span>}
        {!run && check && 'error' in check && <div data-testid="home-error"><Said {...splitRaw(check.error)} /></div>}
        {!run && sheet && (
          <div className="rows" data-testid="home-summary">
            <div className="row"><span>moves<Info id="home-moves">Push keys and phone pairing move too, so paired phones stay paired. Open the phone once from the new QR code.</Info></span><b>islands, notes, settings, phone link</b></div>
            <div className="row"><span>robots</span><b>stay where they run · {back ? `${sheet.there} here, ${sheet.here}` : `${sheet.here} here, ${sheet.there}`} on {name}</b></div>
            {sheet.mission.length > 0 && <div className="row"><span>mission control</span><b data-testid="home-mission">{sheet.mission.length === 1 ? '1 robot moves' : `${sheet.mission.length} robots move`} to {dest} first</b></div>}
            {sheet.rewrites.map((r) => <div key={r.key} className="row" data-testid="home-rewrite"><span>{CONFIG_WORD[r.key] ?? r.key}</span><b>{r.to}{r.lacks && ` · not on ${dest} yet`}</b></div>)}
            {sheet.waits?.map((w) => <div key={w.id} className="row" data-testid="home-waits"><span>{w.name}</span><b>not answering · joins {dest} when it does</b></div>)}
          </div>
        )}
        {!run && refused && blockersOf(refused).map((b, i) => {
          const { line, raw } = rawOf(onThisMac(b.reason), b.raw);
          const tail = [raw, ...(i === 0 ? refused.details : [])].filter(Boolean).join('\n');
          return (
            <div key={b.reason} className="move-blocker" data-testid="home-refusal">
              <span className="move-mark" aria-hidden><Mark status="warn" /></span>
              <Said line={line} fix={onThisMac(b.action)} raw={tail || undefined} run={b.run} on={name} />
              {!back && fleetHome && TOO_BIG.test(b.reason) && (
                <button className="btn sm" data-testid="home-show-files" onClick={() => openFolder(app.bridge, fleetHome, undefined)}>Show in Finder</button>
              )}
            </div>
          );
        })}
        {!run && crewSaid?.map((b) => {
          const answerable = interruptOf(b.action);
          const { line, raw } = rawOf(b.reason, b.raw);
          return (
            <div key={b.reason} className="move-blocker" data-testid="home-crew-refusal">
              <span className="move-mark" aria-hidden><Mark status="warn" /></span>
              {/* a robot at work is answered by its button, whose words say what to do */}
              <Said line={line} fix={answerable ? undefined : b.action} raw={raw} run={b.run} on={back ? undefined : name} />
              {answerable && <button className="btn sm" data-testid="home-crew-action" onClick={() => setInterrupt(answerable)}>{b.action[0].toUpperCase()}{b.action.slice(1)}</button>}
            </div>
          );
        })}
        {!run && interrupt && (
          <label className="move-pick" data-testid="home-interrupt"><input type="checkbox" checked onChange={() => setInterrupt(false)} /><span>{KEPT[interrupt]}{working && <span className="modal-sub">{working}</span>}</span></label>
        )}
        {!run && check && (
          <div className="acts">
            {ready && <button className="btn pri" data-testid="home-go" disabled={busy} onClick={go}>{back ? 'Bring it back' : 'Make it the home'}</button>}
            {(!('ok' in check) || !check.ok || crewSaid?.some((b) => !interruptOf(b.action))) && <button className="btn" data-testid="home-again" onClick={look}>Check again</button>}
          </div>
        )}
        {run && !done && (
          <>
            <div className="move-bar" role="progressbar" aria-valuemin={0} aria-valuemax={rows.length} aria-valuenow={rows.filter((r) => r.now === 'done' || r.now === 'warned').length} data-testid="home-bar">
              {rows.map((r) => <i key={r.step} data-state={r.now} />)}
            </div>
            <ol className="move-steps" data-testid="home-steps" aria-live="polite">{shown.map(item)}</ol>
          </>
        )}
        {done && (
          <div className="move-end" data-testid="home-done">
            <span className="move-state" data-state="ready"><span className="move-mark"><Mark status="ok" /></span>The fleet runs on {dest}</span>
            {rows.some((r) => r.now === 'warned') && <ol className="move-steps" data-testid="home-steps">{rows.filter((r) => r.now === 'warned').map(item)}</ol>}
            {reached ? <PhoneDone name={dest} waits={!!run?.steps.some((s) => s.step === 'phone')} />
              : <span className="move-state" data-testid="home-reaching"><span className="move-mark"><span className="move-spin" /></span>Reaching the fleet on {dest}…</span>}
            <button type="button" className="sec-fold host-fine" data-testid="home-steps-fold" aria-expanded={unfolded} onClick={() => setUnfolded(!unfolded)}>
              <Caret dir={unfolded ? 'down' : 'right'} />{plural(rows.filter((r) => r.now === 'done').length, 'step')} done
            </button>
            {unfolded && <ol className="move-steps" data-testid="home-steps-done">{rows.filter((r) => r.now === 'done').map(item)}</ol>}
            <div className="acts"><button className="btn pri" data-testid="home-finish" autoFocus onClick={close}>Done</button></div>
          </div>
        )}
        {ended && !done && !failed && <div data-testid="home-ended"><Said line="The move stopped without saying why." raw={`exit ${run.code}`} /></div>}
        {ended && !done && (
          <div className="acts">
            {stands ? (
              <>
                <button className="btn pri" data-testid="home-retry" onClick={then('home-retry')}>Finish the move</button>
                <button className="btn" data-testid="home-abort" onClick={then('home-abort')}>Call it off</button>
              </>
            ) : (
              <>
                {crewLeft && <button className="btn pri" data-testid="home-crew-back" onClick={then('home-crew')}>Bring them back</button>}
                <button className="btn" data-testid="home-close-failed" onClick={close}>Close</button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// the new home turns its phone link on within seconds of taking the fleet, which the window's one read on reconnect may come before
const PHONE_ASK_MS = 2000;
const PHONE_WAIT_MS = 30_000;

/**
 * The new home's phone link once the window reaches it: its code to scan, or what keeps it off. A link the move turned on is
 * asked about again until it serves or says why not, for a while, and then said to be off.
 */
function PhoneDone({ name, waits }: { name: string; waits: boolean }) {
  const status = useApp((s) => s.mobile);
  const settled = !!status && (status.serving || !!status.error || !!status.reason);
  const [late, setLate] = useState(false);
  useEffect(() => { loadMobileStatus(deps()); }, []);
  useEffect(() => {
    if (settled || !waits) return;
    const began = Date.now();
    const t = window.setInterval(() => {
      if (Date.now() - began >= PHONE_WAIT_MS) { window.clearInterval(t); setLate(true); return; }
      loadMobileStatus(deps());
    }, PHONE_ASK_MS);
    return () => window.clearInterval(t);
  }, [settled]);
  if (status?.serving) return <><MobilePanel compact /><span className="modal-sub">Scan once with your phone. Paired phones stay paired.</span></>;
  const problem = !!status && phoneProblem(status) !== undefined;
  if (problem || (waits && late)) {
    return (
      <div data-testid={problem ? undefined : 'home-phone-wait'}>
        {problem ? <PhoneProblem /> : <Said line={`${name} has not turned its phone link on yet`} />}
        <span className="modal-sub">Turn it on later in Settings → Phone.</span>
      </div>
    );
  }
  return waits ? <span className="move-state"><span className="move-mark"><span className="move-spin" /></span>Starting the phone link on {name}…</span> : null;
}
