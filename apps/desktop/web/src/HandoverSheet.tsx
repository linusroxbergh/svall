import { useEffect, useRef } from 'react';
import type { Blocker, HandoverChoices } from '@svall/protocol';
import { app } from './boot.js';
import {
  actionsOf, blockerHint, blockersIn, CHOICE_LABEL, choiceFor, chosen, decisionPending, destinationName, entityLabel, formatBytes, fraction,
  headline, rowText, sectionStates, withChoice, type HandoverRun, type HintContext, type Row, type SectionId, type SectionState,
} from './handover.js';
import { useApp } from './hooks.js';

const MARK: Record<SectionState, string> = { pending: '·', active: '›', waiting: '!', done: '✓', stopped: '×' };

const store = () => app.store.getState();

function start(to: string, choices: HandoverChoices = {}): void {
  store().handoverFollow(to, choices);
  const picked = Object.keys(choices).length > 0;
  app.bridge.send({ type: 'handover.start', to, ...(picked && { choices }) });
}

// a resume or an abort starts a helper of its own, which the shell then follows as it did the first
function follow(run: HandoverRun, type: 'handover.resume' | 'handover.abort' | 'handover.attach' | 'handover.forget'): void {
  store().handoverFollow(run.to);
  app.bridge.send({ type });
}

function choose(choices: HandoverChoices): void {
  store().handoverChoose(choices);
  app.bridge.send({ type: 'handover.choose', choices });
}

function cancel(): void {
  store().handoverCancelled();
  app.bridge.send({ type: 'handover.cancel' });
}

function BlockerRow({ b, ctx, run, warning, blockers = [b] }: { b: Blocker; ctx: HintContext; run: HandoverRun; warning?: boolean; blockers?: Blocker[] }) {
  const choice = warning ? undefined : choiceFor(b);
  const hint = blockerHint(b, ctx);
  const who = b.entity?.kind === 'character' ? b.entity.id : undefined;
  return (
    <div className="host-step" data-testid={`handover-${warning ? 'warning' : 'blocker'}-${b.code}`} data-status={warning ? 'warn' : 'fail'}>
      <span className="host-mark">{warning ? '!' : '×'}</span>
      <span className="ho-who">{entityLabel(b.entity, ctx.name, run.preflight?.names) ?? ''}</span>
      <span className="host-said">
        {b.message}
        {hint && <em>{hint}</em>}
        {choice && (
          <button className="btn ho-choice" data-testid={`handover-choice-${choice}`} aria-pressed={chosen(run.choices, b)}
            onClick={() => store().setHandoverChoices(withChoice(run.choices, b, blockers))}>{CHOICE_LABEL[choice]}</button>
        )}
        {b.code === 'character_pinned' && who && (
          <button className="btn ho-choice" data-testid="handover-open-card"
            onClick={() => { store().select(who, true); store().toggleHandover(false); }}>Open {ctx.name(who)}’s card</button>
        )}
      </span>
    </div>
  );
}

function EntityRow({ row, ctx, run }: { row: Row; ctx: HintContext; run: HandoverRun }) {
  const c = useApp((s) => (row.kind === 'character' ? s.fleet.characters[row.id] : undefined));
  // the page reaches the destination's daemon only once the fleet has loaded from it
  const reached = useApp((s) => s.status === 'online' && !s.handover?.awaitingOwner);
  // until the fleet has loaded from its new owner, the old owner's word on a terminal says nothing
  const running = row.section === 'resume' && !!row.error && !run.awaitingOwner && !!c?.tmux;
  const failed = row.section === 'resume' && !!row.error && !!run.result && !running;
  const text = running ? 'resumed' : rowText(row);
  const f = row.section === 'transfer' ? fraction(row) : undefined;
  const retry = () => {
    const api = app.api();
    api.call('char.revive', { id: row.id }).then(() => (c?.second && !c.second.tmux ? api.call('char.second', { id: row.id }) : undefined))
      .catch((e: Error) => store().showToast(e.message));
  };
  return (
    <div className="host-step" data-testid={`handover-row-${row.section}-${row.id}`} data-status={row.error && !running ? 'fail' : 'ok'}>
      <span className="host-mark">{row.error ? '×' : '·'}</span>
      <span className="ho-who">{entityLabel(row, ctx.name, run.preflight?.names)}</span>
      <span className="host-said">
        {text}
        {f !== undefined && <span className="ho-bar"><i style={{ width: `${Math.round(f * 100)}%` }} /></span>}
        {failed && <button className="btn ho-choice" data-testid={`handover-retry-${row.id}`} disabled={!reached} onClick={retry}>Retry</button>}
      </span>
    </div>
  );
}

function Section({ id, label, state, run, ctx }: { id: SectionId; label: string; state: SectionState; run: HandoverRun; ctx: HintContext }) {
  const rows = run.rows.filter((r) => r.section === id);
  const blockers = blockersIn(run, id);
  const pre = id === 'checks' ? run.preflight : undefined;
  // a freeze still waiting on agents takes new choices without anyone having to wait for it to give up
  const interrupt = id === 'rest' && state === 'active' && run.choices.interruptAfterMs === undefined && rows.some((x) => x.total === undefined && !x.error);
  return (
    <div className="ho-section" data-testid={`handover-section-${id}`} data-state={state}>
      <div className="ho-head"><span className="host-mark">{MARK[state]}</span>{label}</div>
      {pre && (
        <div className="host-step" data-testid="handover-summary">
          <span className="host-mark" />
          <span className="host-said">
            {pre.summary.roots} {pre.summary.roots === 1 ? 'folder' : 'folders'}, {pre.summary.files} files, {formatBytes(pre.summary.bytes)}, {pre.summary.sessions} {pre.summary.sessions === 1 ? 'session' : 'sessions'}
          </span>
        </div>
      )}
      {pre?.warnings.map((w, i) => <BlockerRow key={`w${i}`} b={w} ctx={ctx} run={run} warning />)}
      {rows.map((row) => <EntityRow key={`${row.kind}:${row.id}`} row={row} ctx={ctx} run={run} />)}
      {blockers.map((b, i) => <BlockerRow key={`b${i}`} b={b} ctx={ctx} run={run} blockers={blockers} />)}
      {interrupt && (
        <div className="acts">
          <button className="btn" data-testid="handover-interrupt" title={`Stops every agent still at work with Escape; each resumes from its transcript on ${ctx.destination}`}
            onClick={() => { const choices = { ...run.choices, interruptAfterMs: 0 }; store().setHandoverChoices(choices); app.bridge.send({ type: 'handover.choose', choices }); }}>
            Interrupt and carry
          </button>
        </div>
      )}
    </div>
  );
}

function Destinations({ owner, gateway }: { owner: string; gateway?: string }) {
  return (
    <div className="host-note" data-testid="handover-destinations">
      Move this fleet to
      <div className="acts">
        <button className="btn" data-testid="handover-to-local" disabled={owner === 'local'}
          title={owner === 'local' ? 'The fleet runs on this Mac' : 'Bring the fleet back to this Mac'} onClick={() => start('local')}>This Mac</button>
        {gateway && (
          <button className="btn" data-testid="handover-to-gateway" disabled={owner === gateway}
            title={owner === gateway ? `The fleet runs on ${gateway}` : `Move the fleet to ${gateway}`} onClick={() => start(gateway)}>{gateway}</button>
        )}
      </div>
      {!gateway && (
        <div data-testid="handover-no-gateway">
          No machine is this fleet&apos;s gateway yet: add one under Settings → Machines, then choose Make it this fleet&apos;s gateway.
        </div>
      )}
    </div>
  );
}

function Footer({ run }: { run: HandoverRun }) {
  const acts = actionsOf(run);
  if (decisionPending(run)) {
    const blockers = run.decision!.blockers;
    const picked = Object.keys(run.choices).length > 0;
    const go = picked ? 'Carry on' : blockers.length > 0 && blockers.every((b) => b.code === 'agent_working') ? 'Continue waiting' : 'Try again';
    return (
      <div className="acts">
        <button className="btn pri" data-testid="handover-go" autoFocus onClick={() => choose(run.choices)}>{go}</button>
        <button className="btn dan" data-testid="handover-abort" onClick={cancel}>Abort</button>
      </div>
    );
  }
  const buttons = [
    acts.tryAgain && <button key="again" className="btn pri" data-testid="handover-try-again" onClick={() => start(run.to!, run.choices)}>Try again</button>,
    acts.resume && <button key="resume" className="btn pri" data-testid="handover-resume" onClick={() => follow(run, 'handover.resume')}>{acts.resume}</button>,
    acts.cancel && <button key="cancel" className="btn dan" data-testid="handover-abort" onClick={cancel}>Abort</button>,
    acts.abort && <button key="abort" className="btn dan" data-testid="handover-abort" onClick={() => follow(run, 'handover.abort')}>Abort</button>,
    acts.forget && (
      <button key="forget" className="btn" data-testid="handover-forget" title="The gateway has moved on from this handover; drop this Mac's record of it"
        onClick={() => follow(run, 'handover.forget')}>Forget</button>
    ),
    acts.follow && <button key="follow" className="btn" data-testid="handover-follow" onClick={() => follow(run, 'handover.attach')}>Check again</button>,
  ].filter(Boolean);
  return buttons.length ? <div className="acts">{buttons}</div> : null;
}

/** Moving the fleet to another machine: the five steps of the helper's transaction, as they arrive. */
export function HandoverSheet() {
  const open = useApp((s) => s.handoverOpen);
  const enabled = useApp((s) => !!s.shell?.handoverEnabled);
  const run = useApp((s) => s.handover);
  const gateway = useApp((s) => s.shell?.gateway);
  const owner = useApp((s) => s.connection?.owner ?? 'local');
  const characters = useApp((s) => s.fleet.characters);
  const shut = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // a waiting decision keeps the focus its answer took
    if (!decisionPending(store().handover)) shut.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      store().toggleHandover(false);
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open]);

  if (!open || !enabled) return null;
  const destination = destinationName(run?.to);
  const ctx: HintContext = {
    destination, source: run?.to === 'local' ? gateway ?? 'the gateway' : 'This Mac', pull: run?.to === 'local',
    name: (id) => characters[id]?.name ?? run?.preflight?.names?.characters[id] ?? id,
  };
  const close = () => store().toggleHandover(false);
  const said = run ? headline(run, destination) : '';
  const shown = run && (run.phase || run.preflight || run.result || run.status?.phase);

  return (
    <div className="modal-back" data-testid="handover-sheet" onPointerDown={close}>
      <div className="modal host panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="kicker">
          Handover
          <span className="spacer" />
          <button ref={shut} className="side-x" data-testid="handover-close" title="Close" aria-label="Close" onClick={close}>×</button>
        </div>
        {actionsOf(run).start && <Destinations owner={owner} gateway={gateway} />}
        {!shown && (
          <div className="host-note" data-testid="handover-intro">
            A handover moves the whole fleet: its islands, characters, repositories and agent sessions. Agents resume from
            their transcripts and shells reopen in their folders on the other machine; a command still running does not
            move. Nothing moves until the checks pass.
          </div>
        )}
        {said && <div className="host-note" data-testid="handover-headline" aria-live="polite">{said}</div>}
        {shown && (
          <div className="host-steps" data-testid="handover-sections">
            {sectionStates(run).map((s) => <Section key={s.id} {...s} run={run} ctx={ctx} />)}
          </div>
        )}
        {run && <Footer run={run} />}
      </div>
    </div>
  );
}
