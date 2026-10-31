import { useEffect, useRef, useState } from 'react';
import {
  AGENT_LABEL, ApiError, convertLine, INTERRUPT_ACTIONS, MovePhase, moveParts, UPGRADE_ACTION, updatesIn, WORKTREE_ACTION,
  type AgentKind, type Blocker, type MachineId, type MoveSheet as What, type Moving, type Refusal,
} from '@svall/protocol';
import { app } from './boot.js';
import { CloseX } from './CloseX.js';
import { machineNames, plainStep, stepLabel } from './host.js';
import { Caret, Mark } from './icons.js';
import { startHost } from './hostRun.js';
import { dialogKeys, useApp } from './hooks.js';
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
const KEPT: Record<Interrupt, string> = { agent: 'Interrupt it now', command: 'Move anyway and end it' };
// a credential file's box says whether it stays
const staying = (w: What): What => ({ ...w, stays: w.stays.filter((x) => !w.credentialFiles.some((f) => x === `${f} stays here`)) });
const OWN_WORKTREE = `${WORKTREE_ACTION[0].toUpperCase()}${WORKTREE_ACTION.slice(1)}`;
// every check a move failed, the first and the rest alike
const blockersOf = (r: Refusal): Blocker[] => [r, ...(r.more ?? [])];
// whether a blocker's row has a button of its own; one without leaves checking again to the sheet's foot
const hasButton = (b: Blocker): boolean => b.action === UPGRADE_ACTION || b.action === WORKTREE_ACTION || !!b.run || interruptOf(b.action) !== undefined;
// the interrupt: Escape at once
const INTERRUPT_AFTER_MS = 0;

type Answer = { ok: true; sheet: What } | { ok: false; refusal: Refusal } | { error: string };
// a refusal fixed from the sheet: on its way, `upgrade` the machine's upgrade the Machines panel's run carries, or failed
type Fix = { doing: string; upgrade?: true } | { failed: string };

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
// where a run stands, the robot's moving mark first, since a move stalled after its commit is retried from its step;
// `reached` is the last step a mark showed, which stands until the move's answer comes
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
  // each undefined until the user chooses: a robot at work is interrupted, and one sharing a main checkout gets its own
  // worktree, as their boxes in the sheet say, `working` and `shared` saying why
  const [interrupt, setInterrupt] = useState<Interrupt | false>();
  const [working, setWorking] = useState<string>();
  const [own, setOwn] = useState<boolean>();
  const [shared, setShared] = useState<string>();
  const [fix, setFix] = useState<Fix>();
  const [asked, setAsked] = useState(0);
  const [answer, setAnswer] = useState<Answer>();
  const [run, setRun] = useState<Run>();
  const [retried, setRetried] = useState<Retry>();
  const [setup, setSetup] = useState<string>();
  const here = useApp((s) => { const m = s.fleet.robots[id]?.machine; return m ? machineName(s.fleet, m) : 'this Mac'; });
  const host = useApp((s) => s.host);
  const hostOpen = useApp((s) => s.hostOpen);
  // a terminal opened from a blocker stands over the sheet
  const [away, setAway] = useState(false);
  // the machine a refusal is about: the one the robot goes to, or the one it comes back from
  const far = to ? where : here;
  // a move that fails once the sheet is closed says so in a toast
  const shown = useRef(true);
  const reached = useRef<Step>(undefined);
  const shut = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const steps = to ? OUT : BACK;
  const params = machine && { id, machine, ...(carry.length > 0 && { carry }), ...(interrupt && { interruptAfterMs: INTERRUPT_AFTER_MS }), ...(own && { ownWorktree: true }) };
  const close = () => store().setMoveSheet(undefined);

  // the focus stays in the sheet, but for a terminal over it: a button that goes, as Move once pressed, leaves it on the ×
  useEffect(() => { if (!hostOpen && !panel.current?.contains(document.activeElement)) shut.current?.focus(); });
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
    app.api().call('robot.moveCheck', params).then((a) => {
      if (!live) return;
      // a fix that failed is told until the check says something new
      setFix((f) => (f && 'failed' in f ? undefined : f));
      // a blocker the sheet answers itself, wherever it stands in the list, is ticked and the rest asked about again
      const refused = 'ok' in a && !a.ok ? blockersOf(a.refusal) : [];
      const wt = own === undefined ? refused.find((b) => b.action === WORKTREE_ACTION) : undefined;
      const busy = interrupt === undefined ? refused.find((b) => interruptOf(b.action)) : undefined;
      if (wt) {
        setShared(wt.reason);
        setOwn(true);
      } else if (busy) {
        setWorking(busy.reason);
        setInterrupt(interruptOf(busy.action)!);
      } else setAnswer(a);
    }, (e: Error) => { if (live) setAnswer({ error: e.message }); });
    return () => { live = false; };
  }, [machine, carry.join('\n'), interrupt, own, asked]);
  // a fix's end checks again from scratch
  const recheck = () => { setFix(undefined); setAnswer(undefined); setAsked((n) => n + 1); };
  // the sheet checks again once the terminal over it closes
  useEffect(() => {
    if (!away || hostOpen) return;
    setAway(false);
    recheck();
  }, [away, hostOpen]);
  // an upgrade that ran through but left things to do there ends non-zero, and the check says what they are
  useEffect(() => {
    if (!fix || !('upgrade' in fix) || host?.op !== 'upgrade' || host.args.name !== far || host.running) return;
    const stop = host.steps.find((s) => s.status === 'fail');
    if (stop) setFix({ failed: `Upgrade stopped at ${stepLabel(stop.step)}${stop.detail ? `: ${stop.detail}` : ''}` });
    else recheck();
  }, [host]);
  // through, as answered or, with the answer lost, as the robot's arrival says
  const through = run?.at === 'moved' || (run?.at === 'lost' && c?.machine === to);
  useEffect(() => {
    if (!through || !to) return;
    let live = true;
    app.api().call('machines.setup', { machine: to, robot: id }).then(({ rows }) => { if (live) setSetup(setupNote(rows)); }, () => {});
    return () => { live = false; };
  }, [through]);

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
  const farId = to ?? c.machine;
  const blockers = refusal ? blockersOf(refusal) : [];
  const upgrade = () => { setFix({ doing: `Upgrading ${far}`, upgrade: true }); startHost('upgrade', { name: far }); };
  const update = (kinds: AgentKind[], machine: MachineId) => {
    setFix({ doing: `Updating ${kinds.map((k) => AGENT_LABEL[k]).join(' and ')} on ${far}` });
    app.api().call('machines.updateAgents', { machine, kinds }).then(recheck, (e: Error) => setFix({ failed: plainStep(e.message, machineNames(store().machines)) }));
  };
  const doing = fix && 'doing' in fix ? fix : undefined;
  const step = doing?.upgrade && host?.running ? host.steps.at(-1)?.step : undefined;
  // the agents a move out checks there: the robot's, and its second terminal's
  const kinds = [...new Set([c.agent?.kind, c.second?.agent?.kind].filter((k) => k !== undefined))];
  const pick = (f: string) => setCarry((was) => (was.includes(f) ? was.filter((x) => x !== f) : [...was, f]));

  return (
    <div className="modal-back" data-testid="move-sheet" onPointerDown={close}>
      <div className="modal dialog" ref={panel} onPointerDown={(e) => e.stopPropagation()} onKeyDown={dialogKeys(close)}>
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
        {!run && !answer && (
          <div className="host-note" data-testid="move-checking">
            <span className="move-state"><span className="move-mark"><span className="move-spin" /></span>Checking that {c.name} can move…</span>
            <ul className="move-checks">
              <li>{far} is reachable{to && " and on this Mac's release"}</li>
              {to && kinds.length > 0 && <li>{kinds.map((k) => AGENT_LABEL[k]).join(' and ')} {kinds.length === 1 ? 'is' : 'are'} installed, current and logged in on {where}</li>}
              <li>{c.repo ? 'its branch, changes and session can travel' : 'its session can travel'}</li>
            </ul>
          </div>
        )}
        {!run && sheet && (
          <>
            <div className="host-note">
              <span className="move-state" data-state="ready" data-testid="move-ready"><span className="move-mark"><Mark status="ok" /></span>Ready to move</span>
              <ul data-testid="move-summary">
                {moveParts(staying(sheet), c.repo && c.repo.mainRoot.split('/').pop(), where).map((p) => <li key={p}>{p}</li>)}
              </ul>
              {sheet.converts && <span data-testid="move-converts">{convertLine(sheet.converts)}</span>}
              {sheet.question && <span data-testid="move-question">its open question is dropped; it asks again</span>}
            </div>
            {sheet.credentialFiles.map((f) => (
              <label key={f} className="move-pick"><input type="checkbox" checked={carry.includes(f)} onChange={() => pick(f)} />copy {f} to {where}</label>
            ))}
            {own && <label className="move-pick"><input type="checkbox" checked onChange={() => setOwn(false)} /><span>{OWN_WORKTREE}{shared && <span className="modal-sub">{shared}</span>}</span></label>}
            {interrupt && <label className="move-pick"><input type="checkbox" checked onChange={() => setInterrupt(false)} /><span>{KEPT[interrupt]}{working && <span className="modal-sub">{working}</span>}</span></label>}
            <div className="acts"><button className="btn pri" data-testid="move-go" onClick={go}>Move</button></div>
          </>
        )}
        {!run && doing && <div className="modal-note" data-testid="move-fixing">{doing.doing}{step && `: ${stepLabel(step)}`}…</div>}
        {!run && !doing && refusal && (
          <>
            <span className="move-state" data-state="blocked" data-testid="move-blocked"><span className="move-mark"><Mark status="warn" /></span>Not ready to move yet</span>
            {blockers.map((b, i) => {
              const answerable = interruptOf(b.action);
              const updates = b.run ? updatesIn(b.run) : undefined;
              const at = (id: string) => (i ? `${id}-${i}` : id);
              const button = b.action === UPGRADE_ACTION ? (
                <button className="btn pri" data-testid={at('move-action')} disabled={host?.running} data-tip={`Installs this Mac's release on ${far}, then checks again`}
                  onClick={upgrade}>Upgrade {far}</button>
              ) : updates && farId ? (
                <button className="btn pri" data-testid={at('move-action')} data-tip={`Runs ${b.run} on ${far}, then checks again`}
                  onClick={() => update(updates, farId)}>Update {updates.map((k) => AGENT_LABEL[k]).join(' and ')}</button>
              ) : b.run ? (
                <button className="btn pri" data-testid={at('move-action')} data-tip={`Opens a terminal on ${where} with ${b.run} typed, for you to run`}
                  onClick={() => { setAway(true); terminalOn(where, b.run); }}>Open terminal</button>
              ) : b.action === WORKTREE_ACTION ? (
                <button className="btn pri" data-testid={at('move-action')} onClick={() => setOwn(true)}>{OWN_WORKTREE}</button>
              ) : answerable ? (
                <button className="btn pri" data-testid={at('move-action')} onClick={() => setInterrupt(answerable)}>{b.action[0].toUpperCase()}{b.action.slice(1)}</button>
              ) : undefined;
              return (
                <div key={b.reason} className="move-blocker">
                  <div className="host-note" data-testid={at('move-refusal')}>
                    {/* a blocker whose button says what to do needs no line saying it */}
                    <span><span data-testid={at('move-reason')}>{b.reason}</span>{!button && <span className="modal-sub">{b.action}</span>}</span>
                    {i === 0 && fix && 'failed' in fix && <span className="host-failed" role="status" data-testid="move-fix-failed">{fix.failed}</span>}
                    {i === 0 && refusal.details.length > 0 && (
                      <details className="modal-more" data-testid="move-details">
                        <summary><Caret dir="right" />details</summary>
                        <div className="modal-more-body">{refusal.details.map((d) => <span key={d}>{d}</span>)}</div>
                      </details>
                    )}
                  </div>
                  {button}
                </div>
              );
            })}
            {blockers.some((b) => !hasButton(b)) && (
              <div className="acts"><button className="btn pri" data-testid="move-again" onClick={again}>Check again</button></div>
            )}
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

/** A failure is one sentence on its step, the rest behind details, and one button that tries again, checks again or retries. */
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
              <span className="move-mark" aria-hidden>{now === 'doing' ? <span className="move-spin" /> : <Mark status={({ done: 'ok', failed: 'fail', todo: 'todo' } as const)[now]} />}</span>
              <span>{now === 'failed' ? sentence : words[s][now]}</span>
            </li>
          );
        })}
      </ol>
      {st.done && <div className="host-note" data-testid="move-through">{robot} runs on {where}.{setup && ` ${setup}`}</div>}
      {details.length > 0 && (
        <details className="modal-more" data-testid="move-run-details">
          <summary><Caret dir="right" />details</summary>
          <div className="modal-more-body">{details.map((d) => <span key={d}>{d}</span>)}</div>
        </details>
      )}
      {act && <div className="acts"><button className="btn pri" data-testid={act.testid} autoFocus onClick={act.run}>{act.label}</button></div>}
    </>
  );
}
