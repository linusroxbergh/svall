import { useEffect, useRef, useState } from 'react';
import { convertLine, moveSummary, type MachineId, type MoveSheet as What, type Refusal } from '@svall/protocol';
import { app } from './boot.js';
import { CloseX } from './CloseX.js';
import { useApp } from './hooks.js';
import { machineName } from './placement.js';

const store = () => app.store.getState();

/** A terminal on a worker in the Machines panel, `run` typed at its prompt; the registry it reads names the way there. */
export function terminalOn(machine: string, run?: string): void {
  app.bridge.send({ type: 'host.list' });
  store().openHostTerminal(machine, run);
}

// check 7's refusals, which the sheet answers itself by choosing the interrupt
const INTERRUPTS = new Set(['interrupt after this turn', 'move anyway and it ends']);
// as the handover sheet's interrupt: Escape at once
const INTERRUPT_AFTER_MS = 0;

type Answer = { ok: true; sheet: What } | { ok: false; refusal: Refusal } | { error: string };

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
  const [interrupt, setInterrupt] = useState(false);
  const [asked, setAsked] = useState(0);
  const [answer, setAnswer] = useState<Answer>();
  const shut = useRef<HTMLButtonElement>(null);
  const params = machine && { id, machine, ...(carry.length > 0 && { carry }), ...(interrupt && { interruptAfterMs: INTERRUPT_AFTER_MS }) };
  const close = () => store().setMoveSheet(undefined);

  useEffect(() => { shut.current?.focus(); }, []);
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
  }, [machine, carry.join('\n'), interrupt, asked]);

  if (!c) return null;
  const sheet = answer && 'ok' in answer && answer.ok ? answer.sheet : undefined;
  const refusal = answer && 'ok' in answer && !answer.ok ? answer.refusal : undefined;
  const failed = answer && 'error' in answer ? answer.error : undefined;
  const again = () => setAsked((n) => n + 1);
  const go = () => {
    if (!params) return;
    app.api().call('robot.moveTo', params).catch((e: Error) => store().showToast(e.message));
    close();
  };
  const pick = (f: string) => setCarry((was) => (was.includes(f) ? was.filter((x) => x !== f) : [...was, f]));

  return (
    <div className="modal-back" data-testid="move-sheet" onPointerDown={close}>
      <div className="modal panel" onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // the page's own Enter and Esc would act on the map behind the sheet
          if (e.key === 'Enter') e.stopPropagation();
          if (e.key === 'Escape') { e.stopPropagation(); close(); }
        }}>
        <div className="kicker"><span data-testid="move-title">Move {c.name} to {where}</span><CloseX ref={shut} onClose={close} testid="move-close" /></div>
        {!answer && <div className="modal-note">Checking…</div>}
        {sheet && (
          <>
            <div className="host-note">
              <span data-testid="move-summary">{moveSummary(sheet, c.repo && c.repo.mainRoot.split('/').pop(), where)}</span>
              {sheet.converts && <span data-testid="move-converts">{convertLine(sheet.converts)}</span>}
              {sheet.question && <span data-testid="move-question">its open question is dropped; it asks again</span>}
            </div>
            {sheet.credentialFiles.map((f) => (
              <label key={f} className="move-pick"><input type="checkbox" checked={carry.includes(f)} onChange={() => pick(f)} />copy {f} to {where}</label>
            ))}
            {interrupt && <label className="move-pick"><input type="checkbox" checked onChange={() => setInterrupt(false)} />Interrupt after this turn</label>}
            <div className="acts"><button className="btn pri" data-testid="move-go" onClick={go}>Move</button></div>
          </>
        )}
        {refusal && (
          <>
            <div className="host-note" data-testid="move-refusal">
              <span><span data-testid="move-reason">{refusal.reason}</span><span className="ho-sub">{refusal.action}</span></span>
              {refusal.details.length > 0 && (
                <details className="ho-more" data-testid="move-details">
                  <summary>details</summary>
                  <div className="ho-more-body">{refusal.details.map((d) => <span key={d}>{d}</span>)}</div>
                </details>
              )}
            </div>
            <div className="acts">
              {refusal.run ? (
                <button className="btn pri" data-testid="move-action" title={`Opens a terminal on ${where} with ${refusal.run} typed, for you to run`}
                  onClick={() => { close(); terminalOn(where, refusal.run); }}>Open terminal</button>
              ) : INTERRUPTS.has(refusal.action) ? (
                <button className="btn pri" data-testid="move-action" onClick={() => setInterrupt(true)}>{refusal.action[0].toUpperCase()}{refusal.action.slice(1)}</button>
              ) : (
                <button className="btn pri" data-testid="move-action" onClick={again}>Check again</button>
              )}
            </div>
          </>
        )}
        {failed && (
          <>
            <div className="host-note" data-testid="move-failed">{failed}</div>
            <div className="acts"><button className="btn pri" data-testid="move-action" onClick={again}>Check again</button></div>
          </>
        )}
      </div>
    </div>
  );
}
