import { useEffect, useRef, useState } from 'react';
import { ApiError, convertLine, INTERRUPT_ACTIONS, MovePhase, moveSummary, WORKTREE_ACTION, type MachineId, type MoveSheet as What, type Moving, type Refusal } from '@svall/protocol';
import { app } from './boot.js';
import { CloseX } from './CloseX.js';
import { useApp } from './hooks.js';
import { setupNote } from './landings.js';
import { machineName } from './placement.js';

const store = () => app.store.getState();

/** A terminal on a worker in the Machines panel, `run` typed at its prompt, `forward` its login's port; the registry it reads names the way there. */
export function terminalOn(machine: string, run?: string, forward?: number): void {
  app.bridge.send({ type: 'host.list' });
  store().openHostTerminal(machine, run, forward);
}

type Interrupt = keyof typeof INTERRUPT_ACTIONS;
// the refusals the sheet answers itself by choosing the interrupt, and the box that then keeps it, worded for what it ends
const interruptOf = (action: string): Interrupt | undefined => (Object.keys(INTERRUPT_ACTIONS) as Interrupt[]).find((k) => INTERRUPT_ACTIONS[k] === action);
const KEPT: Record<Interrupt, string> = { agent: 'Interrupt after this turn', command: 'a command is running; move anyway and it ends' };
const OWN_WORKTREE = `${WORKTREE_ACTION[0].toUpperCase()}${WORKTREE_ACTION.slice(1)}`;
// the interrupt: Escape at once
const INTERRUPT_AFTER_MS = 0;

type Answer = { ok: true; sheet: What } | { ok: false; refusal: Refusal } | { error: string };

// the steps of a move as the sheet shows them while it runs, each over the phases it covers; before its first phase the
// move checks itself again. On the way back the worker packs and carries in its bundle, and this Mac lands what came
const STEPS = ['check', 'rest', 'pack', 'carry', 'land', 'start'] as const;
type Step = (typeof STEPS)[number];
type Steps = Record<MovePhase, Step>;
const OUT: Steps = { rest: 'rest', bundle: 'pack', prepare: 'carry', commit: 'land', activate: 'start', release: 'start', done: 'start', aborted: 'check' };
const BACK: Steps = { ...OUT, prepare: 'land' };
type Said = { todo: string; doing: string; done: string; name: string };
const said = (robot: string, where: string, what: string): Record<Step, Said> => ({
  check: { todo: 'Check', doing: 'Checking…', done: 'Checked', name: 'Check' },
  rest: { todo: `Rest ${robot}`, doing: `Resting ${robot}…`, done: `Rested ${robot}`, name: 'Rest' },
  pack: { todo: `Pack ${what}`, doing: `Packing ${what}…`, done: `Packed ${what}`, name: 'Pack' },
  carry: { todo: `Carry to ${where}`, doing: `Carrying to ${where}…`, done: `Carried to ${where}`, name: 'Carry' },
  land: { todo: `Land on ${where}`, doing: `Landing on ${where}…`, done: `Landed on ${where}`, name: 'Land' },
  start: { todo: `Start ${robot} there`, doing: `Starting ${robot} there…`, done: `Started ${robot} there`, name: 'Start' },
});

// a move started from the sheet: on its way, through, undone before its commit with the step it failed at, or its answer
// lost with the link to svalld, when the robot's mark tells how it ends
type Run = { at: 'going' } | { at: 'moved' } | { at: 'failed'; step: Step; error: string; moveId?: string; refused: boolean } | { at: 'lost'; error: string };
// a retry of a stalled move: on its way, or failed with `error`, which the mark's error `over` it retried still stands for
type Retry = { at: 'running' } | { at: 'failed'; error: string; over: string };
// where a run stands, the robot's moving mark first: a move stalled after its commit is retried from its step. `reached`
// is the last step a mark showed, none before one came, which stands until the move's answer comes; `arrived` is whether
// the robot is there
type Stand = { step: Step; done?: true; failed?: { error: string; moveId?: string; landed: boolean; refused?: boolean } };

function stand(run: Run, moving: Moving | undefined, retry: Retry | undefined, reached: Step | undefined, steps: Steps, arrived: boolean): Stand {
  if (moving?.error && retry?.at !== 'running') {
    const error = retry?.at === 'failed' && retry.over === moving.error ? retry.error : moving.error;
    return { step: steps[moving.phase], failed: { error, moveId: moving.id, landed: true } };
  }
  if (moving) return { step: steps[moving.phase] };
  if (run.at === 'failed') return { step: run.step, failed: { error: run.error, moveId: run.moveId, landed: false, refused: run.refused } };
  // a lost answer with no mark yet goes on until one comes, or the robot arrives
  if (run.at === 'lost' && !arrived) return reached ? { step: reached, failed: { error: run.error, landed: false } } : { step: 'check' };
  return run.at === 'going' ? { step: reached ?? 'check' } : { step: 'start', done: true };
}

/** What a move of one robot carries, or the first check that stops it, and the one button that starts it. */
export function MoveSheet() {
  const ask = useApp((s) => s.moveSheet);
  return ask ? <Sheet key={`${ask.id}:${ask.to ?? ''}`} id={ask.id} to={ask.to} /> : null;
}

function Sheet({ id, to }: { id: string; to?: MachineId }) {
  const c = useApp((s) => s.fleet.robots[id]);
  const where = useApp((s) => (to ? machineName(s.fleet, to) : 'this Mac'));
  // the way back names this Mac by the id its daemon gives itself
  const [machine, setMachine] = useState(to);
  const [carry, setCarry] = useState<string[]>([]);
  const [interrupt, setInterrupt] = useState<Interrupt>();
  const [own, setOwn] = useState(false);
  const [asked, setAsked] = useState(0);
  const [answer, setAnswer] = useState<Answer>();
  const [run, setRun] = useState<Run>();
  const [retried, setRetried] = useState<Retry>();
  const [setup, setSetup] = useState<string>();
  const here = useApp((s) => { const m = s.fleet.robots[id]?.machine; return m ? machineName(s.fleet, m) : 'this Mac'; });
  // a move that fails once the sheet is closed says so in a toast
  const shown = useRef(true);
  const reached = useRef<Step>(undefined);
  const shut = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const steps = to ? OUT : BACK;
  const params = machine && { id, machine, ...(carry.length > 0 && { carry }), ...(interrupt && { interruptAfterMs: INTERRUPT_AFTER_MS }), ...(own && { ownWorktree: true }) };
  const close = () => store().setMoveSheet(undefined);

  // the focus stays in the sheet: a button that goes, as Move once pressed, leaves it on the ×
  useEffect(() => { if (!panel.current?.contains(document.activeElement)) shut.current?.focus(); });
  useEffect(() => {
    shown.current = true;
    return () => { shown.current = false; };
  }, []);
  useEffect(() => {
    if (machine) return;
    let live = true;
    app.api().call('system.info', {}).then((i) => { if (live) setMachine(i.machineId); }, (e: Error) => { if (live) setAnswer({ error: e.message }); });
    return () => { live = false; };
  }, [machine, asked]);
  // the last answer stands while a choice is asked about again
  useEffect(() => {
    if (!params) return;
    let live = true;
    app.api().call('robot.moveCheck', params).then((a) => { if (live) setAnswer(a); }, (e: Error) => { if (live) setAnswer({ error: e.message }); });
    return () => { live = false; };
  }, [machine, carry.join('\n'), interrupt, own, asked]);
  useEffect(() => {
    if (run?.at !== 'moved' || !to) return;
    let live = true;
    app.api().call('machines.setup', { machine: to, robot: id }).then(({ rows }) => { if (live) setSetup(setupNote(rows)); }, () => {});
    return () => { live = false; };
  }, [run?.at]);

  if (!c) return null;
  if (c.moving) reached.current = steps[c.moving.phase];
  const sheet = answer && 'ok' in answer && answer.ok ? answer.sheet : undefined;
  const refusal = answer && 'ok' in answer && !answer.ok ? answer.refusal : undefined;
  const failed = answer && 'error' in answer ? answer.error : undefined;
  const again = () => setAsked((n) => n + 1);
  // a refusal that comes after the sheet closed offers to open it again, where the refusal shows with its button
  const go = () => {
    if (!params) return;
    reached.current = undefined;
    setRun({ at: 'going' });
    app.api().call('robot.moveTo', params).then(() => { if (shown.current) setRun({ at: 'moved' }); }, (e: Error) => {
      const refused = e instanceof ApiError && e.code === 'refused';
      const data = e instanceof ApiError ? e.data : undefined;
      const phase = MovePhase.safeParse(data?.phase).data;
      const moveId = typeof data?.moveId === 'string' ? data.moveId : undefined;
      if (!shown.current) store().showToast(e.message, 'error', refused ? { label: 'Check again', run: () => store().setMoveSheet({ id, to }) } : undefined);
      else if (e instanceof ApiError) setRun({ at: 'failed', step: phase ? steps[phase] : 'check', error: e.message, moveId, refused });
      else setRun({ at: 'lost', error: e.message });
    });
  };
  // a retry that fails says why, until the robot's mark says more
  const retry = (moveId: string) => {
    const over = c.moving?.error ?? '';
    setRetried({ at: 'running' });
    app.api().call('robot.moveRetry', { moveId }).then(() => { setRetried(undefined); setRun({ at: 'moved' }); }, (e: Error) => setRetried({ at: 'failed', error: e.message, over }));
  };
  const answerable = refusal && interruptOf(refusal.action);
  const pick = (f: string) => setCarry((was) => (was.includes(f) ? was.filter((x) => x !== f) : [...was, f]));

  return (
    <div className="modal-back" data-testid="move-sheet" onPointerDown={close}>
      <div className="modal panel" ref={panel} onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // the page's own Enter and Esc would act on the map behind the sheet
          if (e.key === 'Enter') e.stopPropagation();
          if (e.key === 'Escape') { e.stopPropagation(); close(); }
        }}>
        <div className="kicker"><span data-testid="move-title">Move {c.name} to {where}</span><CloseX ref={shut} onClose={close} testid="move-close" /></div>
        {run && (
          <Progress stand={stand(run, c.moving, retried, reached.current, steps, c.machine === to)} words={said(c.name, where, c.repo ? 'branch and session' : 'session')}
            robot={c.name} where={where} here={here} setup={setup} close={close}
            again={(s) => {
              if (s.failed?.landed && s.failed.moveId) return retry(s.failed.moveId);
              if (!s.failed?.refused) return go();
              setRun(undefined);
              again();
            }} />
        )}
        {!run && !answer && <div className="modal-note">Checking…</div>}
        {!run && sheet && (
          <>
            <div className="host-note">
              <span data-testid="move-summary">{moveSummary(sheet, c.repo && c.repo.mainRoot.split('/').pop(), where)}</span>
              {sheet.converts && <span data-testid="move-converts">{convertLine(sheet.converts)}</span>}
              {sheet.question && <span data-testid="move-question">its open question is dropped; it asks again</span>}
            </div>
            {sheet.credentialFiles.map((f) => (
              <label key={f} className="move-pick"><input type="checkbox" checked={carry.includes(f)} onChange={() => pick(f)} />copy {f} to {where}</label>
            ))}
            {own && <label className="move-pick"><input type="checkbox" checked onChange={() => setOwn(false)} />{OWN_WORKTREE}</label>}
            {interrupt && <label className="move-pick"><input type="checkbox" checked onChange={() => setInterrupt(undefined)} />{KEPT[interrupt]}</label>}
            <div className="acts"><button className="btn pri" data-testid="move-go" onClick={go}>Move</button></div>
          </>
        )}
        {!run && refusal && (
          <>
            <div className="host-note" data-testid="move-refusal">
              <span><span data-testid="move-reason">{refusal.reason}</span><span className="modal-sub">{refusal.action}</span></span>
              {refusal.details.length > 0 && (
                <details className="modal-more" data-testid="move-details">
                  <summary>details</summary>
                  <div className="modal-more-body">{refusal.details.map((d) => <span key={d}>{d}</span>)}</div>
                </details>
              )}
            </div>
            <div className="acts">
              {refusal.run ? (
                <button className="btn pri" data-testid="move-action" title={`Opens a terminal on ${where} with ${refusal.run} typed, for you to run`}
                  onClick={() => { close(); terminalOn(where, refusal.run); }}>Open terminal</button>
              ) : refusal.action === WORKTREE_ACTION ? (
                <button className="btn pri" data-testid="move-action" onClick={() => setOwn(true)}>{OWN_WORKTREE}</button>
              ) : answerable ? (
                <button className="btn pri" data-testid="move-action" onClick={() => setInterrupt(answerable)}>{refusal.action[0].toUpperCase()}{refusal.action.slice(1)}</button>
              ) : (
                <button className="btn pri" data-testid="move-action" onClick={again}>Check again</button>
              )}
            </div>
          </>
        )}
        {!run && failed && (
          <>
            <div className="host-note" data-testid="move-failed">{failed}</div>
            <div className="acts"><button className="btn pri" data-testid="move-action" onClick={again}>Check again</button></div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A running move: a bar of its steps and one line for each as it gets there; a failure is one sentence on its step,
 * with the rest behind details, and one button that tries again, checks again or retries the step.
 */
function Progress({ stand: st, words, robot, where, here, setup, close, again }: {
  stand: Stand; words: Record<Step, Said>; robot: string; where: string; here: string; setup?: string; close(): void; again(s: Stand): void;
}) {
  const at = STEPS.indexOf(st.step);
  const state = (i: number) => (i < at || st.done ? 'done' : i > at ? 'todo' : st.failed ? 'failed' : 'doing');
  const f = st.failed;
  const [first, ...more] = (f?.error ?? '').split('\n').filter(Boolean);
  // undone before its commit, the robot is back where it was, but for a check that never moved it
  const back = f && !f.landed && st.step !== 'check' ? `; ${robot} is back on ${here}` : '';
  const sentence = f && `${words[st.step].name} failed: ${(first ?? '').replace(/\.$/, '')}${back}.`;
  const details = f ? [...more, ...(f.moveId ? [`move ${f.moveId}`] : [])] : [];
  const act = st.done ? { testid: 'move-done', label: 'Done', run: close }
    : f && { testid: 'move-action', label: f.landed ? 'Retry' : f.refused ? 'Check again' : 'Try again', run: () => again(st) };
  return (
    <>
      <div className="move-bar" role="progressbar" aria-valuemin={0} aria-valuemax={STEPS.length} aria-valuenow={STEPS.filter((_, i) => state(i) === 'done').length} data-testid="move-bar">
        {STEPS.map((s, i) => <i key={s} data-state={state(i)} />)}
      </div>
      <ol className="move-steps" data-testid="move-steps">
        {STEPS.map((s, i) => {
          const now = state(i);
          if (f && now === 'todo') return null;
          return (
            <li key={s} data-state={now} data-testid={`move-step-${s}`}>
              <span className="move-mark" aria-hidden>{now === 'doing' ? <span className="move-spin" /> : { done: '✓', failed: '✕', todo: '○' }[now]}</span>
              <span>{now === 'failed' ? sentence : words[s][now]}</span>
            </li>
          );
        })}
      </ol>
      {st.done && <div className="host-note" data-testid="move-through">{robot} runs on {where}.{setup && ` ${setup}`}</div>}
      {details.length > 0 && (
        <details className="modal-more" data-testid="move-run-details">
          <summary>details</summary>
          <div className="modal-more-body">{details.map((d) => <span key={d}>{d}</span>)}</div>
        </details>
      )}
      {act && <div className="acts"><button className="btn pri" data-testid={act.testid} autoFocus onClick={act.run}>{act.label}</button></div>}
    </>
  );
}
