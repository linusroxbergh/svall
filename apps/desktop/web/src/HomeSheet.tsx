import { useEffect, useRef, useState } from 'react';
import type { Blocker, MachineId, Result } from '@svall/protocol';
import { app } from './boot.js';
import { CloseX } from './CloseX.js';
import { dialogKeys, useApp } from './hooks.js';
import { onThisMac, stepLabel } from './host.js';
import { startHost } from './hostRun.js';
import { Mark } from './icons.js';
import { blockersOf, INTERRUPT_AFTER_MS, interruptOf, KEPT, type Interrupt } from './MoveSheet.js';
import { MobilePanel } from './PhonePanel.js';

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
];
// any move's id lets mission control's robots be checked, which moves nothing
const CHECK_MOVE = 'hm_crewcheck0';

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
  const reached = useApp((s) => (s.homeSheet?.back ? !s.via : s.via?.home === s.homeSheet?.to));
  const [check, setCheck] = useState<Check>();
  // what mission control's robots answer the move, undefined while they are asked; a robot at work is interrupted only on the
  // choice its box keeps, as in the move sheet, `working` saying why
  const [crew, setCrew] = useState<Blocker[]>();
  const [interrupt, setInterrupt] = useState<Interrupt | false>();
  const [working, setWorking] = useState<string>();
  const [started, setStarted] = useState(false);
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
  useEffect(() => { setStarted(false); setInterrupt(undefined); setWorking(undefined); look(); }, [ask?.to, ask?.back]);
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
  if (!ask) return null;
  const { name, back } = ask;
  const shutUnlessRunning = () => { if (!(started && host?.running)) close(); };
  const go = () => { if (startHost('home', { name: back ? 'local' : name, ...(interrupt && { interrupt: true }) })) setStarted(true); };
  const run = started ? host : undefined;
  const refused = check && 'ok' in check && !check.ok ? check.refusal : undefined;
  const sheet = check && 'sheet' in check ? check.sheet : undefined;
  const crewSaid = mission && !mission.length ? [] : crew;
  const ready = !!mission && crewSaid?.length === 0;
  const failed = run?.steps.find((s) => s.status === 'fail');
  const ended = !!run && !run.running;
  const done = ended && !failed && run.code === 0;
  const steps = STEPS(name, back);
  // what the run reports past its rows, as a failure at the mark or the shell's own, or mission control left away
  const more = run?.steps.filter((s) => (s.status === 'fail' || s.status === 'warn') && !steps.some(([k]) => k === s.step)).map((s): [string, string] => [s.step, stepLabel(s.step)]) ?? [];
  const at = (step: string) => run?.steps.find((s) => s.step === step);
  return (
    <div className="modal-back" data-testid="home-sheet" onPointerDown={shutUnlessRunning}>
      <div className="modal dialog" ref={panel} tabIndex={-1} role="dialog" aria-label={back ? 'Bring the fleet back' : `Make ${name} the home`} onPointerDown={(e) => e.stopPropagation()} onKeyDown={dialogKeys(shutUnlessRunning)}>
        <div className="kicker"><span data-testid="home-title">{back ? 'Bring the fleet back to this Mac' : `Make ${name} this fleet's home`}</span>{!run?.running && <CloseX ref={shut} onClose={close} testid="home-close" />}</div>
        {!run && (!check || (mission && !crewSaid)) && <div className="host-note" data-testid="home-checking"><span className="move-state"><span className="move-mark"><span className="move-spin" /></span>Checking that the fleet can move…</span></div>}
        {!run && check && 'error' in check && <div className="host-note" data-testid="home-error"><span>{check.error}</span></div>}
        {!run && sheet && (
          <div className="host-note" data-testid="home-summary">
            <span>The fleet's islands, notes, settings, phone pairing and push keys. Robots stay where they run: {back
              ? `${sheet.there} here, ${sheet.here} on ${name}`
              : `${sheet.here} here, ${sheet.there} on ${name}`}.</span>
            {sheet.mission.length > 0 && <span className="modal-sub" data-testid="home-mission">Mission control's {sheet.mission.length === 1 ? 'robot moves' : `${sheet.mission.length} robots move`} to {back ? 'this Mac' : name} first.</span>}
            {sheet.rewrites.map((r) => <span key={r.key} className="modal-sub" data-testid="home-rewrite">{r.key} becomes {r.to}</span>)}
          </div>
        )}
        {!run && refused && [refused, ...refused.more ?? []].map((b) => (
          <div key={b.reason} className="host-note" data-testid="home-refusal"><span><span data-testid="home-reason">{onThisMac(b.reason)}</span><span className="modal-sub">{onThisMac(b.action)}</span></span></div>
        ))}
        {!run && crewSaid?.map((b) => {
          const answerable = interruptOf(b.action);
          return (
            <div key={b.reason} className="host-note" data-testid="home-crew-refusal">
              <span><span data-testid="home-crew-reason">{b.reason}</span>{!answerable && <span className="modal-sub">{b.action}</span>}</span>
              {answerable && <button className="btn pri" data-testid="home-crew-action" onClick={() => setInterrupt(answerable)}>{b.action[0].toUpperCase()}{b.action.slice(1)}</button>}
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
        {run && (
          <ol className="move-steps" data-testid="home-steps">
            {[...steps, ...more].map(([step, words]) => {
              const row = at(step);
              const now = !row ? 'todo' : row.status === 'start' ? 'doing' : row.status === 'fail' ? 'failed' : row.status === 'warn' ? 'warned' : 'done';
              if (failed && now === 'todo') return null;
              if (row?.status === 'skip') return null;
              const said = now === 'failed' || now === 'warned' ? row : undefined;
              const todo = said && (said.say ?? said.action);
              return (
                <li key={step} data-state={now} data-testid={`home-step-${step}`}>
                  <span className="move-mark" aria-hidden>{now === 'doing' ? <span className="move-spin" /> : <Mark status={({ done: 'ok', failed: 'fail', warned: 'warn', todo: 'todo' } as const)[now]} />}</span>
                  <span>{words}{said?.detail && <span className="modal-sub" data-testid={now === 'failed' ? 'home-failed' : undefined}>{onThisMac(said.detail)}</span>}{todo && <span className="modal-sub">{onThisMac(todo)}</span>}</span>
                </li>
              );
            })}
          </ol>
        )}
        {done && (
          <div data-testid="home-done">
            <div className="host-note">The fleet runs on {back ? 'this Mac' : name}. Open the phone from its new QR code once.</div>
            {reached ? <MobilePanel /> : <div className="host-note" data-testid="home-reaching">Reaching the fleet on {back ? 'this Mac' : name}…</div>}
            <div className="acts"><button className="btn pri" data-testid="home-finish" autoFocus onClick={close}>Done</button></div>
          </div>
        )}
        {ended && !done && !failed && <div className="host-note" data-testid="home-ended">The move ended with exit {run.code}, saying nothing more.</div>}
        {ended && !done && <div className="acts"><button className="btn" data-testid="home-close-failed" onClick={close}>Close</button></div>}
      </div>
    </div>
  );
}
