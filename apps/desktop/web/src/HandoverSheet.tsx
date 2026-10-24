import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Blocker, HandoverChoices } from '@svall/protocol';
import { app } from './boot.js';
import { openFolder } from './bridge.js';
import {
  accountHome, actionsOf, answered, asksStatus, blockerHint, blockerSide, blockersIn, CHOICE_LABEL, choiceFor, chosen, decisionPending, destinationName, destinationOf, detailOf,
  entityLabel, entityPath, formatBytes, fraction, goesOnByItself, headline, isCommitted, namesOn, planOf, problemOf, restPlan, resumeTally, rowText, sectionStates, staysInSight,
  svallFor, transferBytes, transferPace, transferTotals, upgradeAsked, verdictOf, verified, wayOut, withChoice,
  type HandoverRun, type HintContext, type RestHow, type Row, type SectionId, type SectionState,
} from './handover.js';
import { useApp } from './hooks.js';
import { startHost } from './HostSetup.js';

const MARK: Record<SectionState, string> = { pending: '·', active: '›', waiting: '!', done: '✓', stopped: '×' };

const store = () => app.store.getState();

// `check`: the checks alone, which the sheet shows before anything is rested
function start(to: string, choices: HandoverChoices = {}, check = false): void {
  store().handoverFollow(to, choices);
  const picked = Object.keys(choices).length > 0;
  app.bridge.send({ type: 'handover.start', to, ...(picked && { choices }), ...(check && { check }) });
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

function openCard(id: string): void {
  store().select(id, true);
  store().toggleHandover(false);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Text with the commands it names, between backticks, as code a click selects whole. */
const withCode = (text: string): ReactNode[] => text.split('`').map((part, i) => (i % 2 ? <code key={i} className="ho-cmd">{part}</code> : part));

function More({ label, children, testid }: { label: string; children: ReactNode; testid?: string }) {
  return (
    <details className="ho-more" data-testid={testid}>
      <summary>{label}</summary>
      <div className="ho-more-body">{children}</div>
    </details>
  );
}

/** One thing in the way, with the one choice that clears it or the way out beside it. */
function BlockerRow({ b, ctx, run, warning, blockers = [b] }: { b: Blocker; ctx: HintContext; run: HandoverRun; warning?: boolean; blockers?: Blocker[] }) {
  const side = blockerSide(b, run.decision?.phase ?? (run.result?.status === 'blocked' ? run.result.phase : undefined));
  const names = namesOn(run.preflight?.names, side);
  const choice = warning ? undefined : choiceFor(b);
  const hint = blockerHint(b, ctx, warning);
  const who = b.entity?.kind === 'character' ? b.entity.id : undefined;
  const path = entityPath(b.entity, names, b.message);
  const upgrade = upgradeAsked(b, ctx);
  // the shell opens a folder only on this Mac, and only while the fleet runs here
  const finder = !ctx.pull && side === 'source' && app.bridge.present;
  const picked = !!choice && chosen(run.choices, b);
  const { problem, remedy, quote } = problemOf(b.message, !!choice || !!hint);
  const more = [remedy, choice && hint].filter(Boolean) as string[];
  const toggle = () => store().setHandoverChoices(withChoice(run.choices, b, blockers));
  return (
    <div className="host-step ho-issue" data-testid={`handover-${warning ? 'warning' : 'blocker'}-${b.code}`} data-status={warning ? 'warn' : picked ? 'ok' : 'fail'} data-picked={picked || undefined}>
      <span className="host-mark">{warning ? '!' : picked ? '✓' : '×'}</span>
      <span className="ho-who" title={path}>{entityLabel(b.entity, ctx.name, names, b.message, ctx.home) ?? ''}</span>
      <span className="host-said">
        {picked ? <span className="ho-plan">{planOf(choice!, b, ctx, names)}</span> : !answered(run, b) && problem}
        <small className="ho-code">{b.code}</small>
        {!picked && quote && <q className="ho-quote">{quote.slice(1, -1)}</q>}
        {!picked && !choice && hint && <em>{withCode(hint)}</em>}
        {!warning && (
          <span className="ho-acts">
            {choice && (
              <button className="btn ho-choice" data-testid={`handover-choice-${choice}`} aria-pressed={picked} title={picked ? 'Undo this choice' : undefined} onClick={toggle}>
                {CHOICE_LABEL[choice]}
              </button>
            )}
            {picked && <button className="btn ghost ho-undo" data-testid={`handover-undo-${choice}`} onClick={toggle}>Undo</button>}
            {!picked && who && (
              <button className="btn ho-choice" data-testid="handover-open-card" onClick={() => openCard(who)}>Open {ctx.name(who)}</button>
            )}
            {!picked && !who && path && (finder
              ? <button className="btn ho-choice" data-testid="handover-show-folder" onClick={() => openFolder(app.bridge, path)}>Show in Finder</button>
              : <span className="ho-path" data-testid="handover-path">{path}{side && ` on ${side === 'source' ? ctx.source : ctx.destination}`}</span>)}
            {upgrade && (
              <button className="btn ho-choice" data-testid="handover-upgrade" onClick={() => { store().toggleHandover(false); store().toggleHost(true, upgrade); }}>Upgrade {upgrade}…</button>
            )}
          </span>
        )}
        {!picked && more.length > 0 && <More label="Details">{more.map((m, i) => <span key={i}>{withCode(m)}</span>)}</More>}
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
  const names = run.preflight?.names;
  const path = entityPath(row.kind === 'root' ? row : undefined, names);
  const f = row.section === 'transfer' ? fraction(row) : undefined;
  const retry = () => {
    const api = app.api();
    api.call('char.revive', { id: row.id }).then(() => (c?.second && !c.second.tmux ? api.call('char.second', { id: row.id }) : undefined))
      .catch((e: Error) => store().showToast(e.message));
  };
  return (
    <div className="host-step" data-testid={`handover-row-${row.section}-${row.id}`} data-status={row.error && !running ? 'fail' : 'ok'}>
      <span className="host-mark">{row.error && !running ? '×' : verified(row) || (row.section === 'rest' && row.done === row.total && row.total !== undefined) ? '✓' : '·'}</span>
      <span className="ho-who" title={path}>{entityLabel(row, ctx.name, names, undefined, ctx.home)}</span>
      <span className="host-said">
        {text}
        {f !== undefined && <span className="ho-bar"><i style={{ width: `${Math.round(f * 100)}%` }} /></span>}
        {failed && (
          <span className="ho-acts">
            <button className="btn ho-choice" data-testid={`handover-retry-${row.id}`} disabled={!reached} onClick={retry}>Retry</button>
            <button className="btn ho-choice" onClick={() => openCard(row.id)}>Open {ctx.name(row.id)}</button>
          </span>
        )}
      </span>
    </div>
  );
}

const REST_TEXT: Record<RestHow, (one: boolean, to: string) => string> = {
  resume: (one, to) => (one ? `stops now and resumes from its transcript on ${to}.` : `stop now and resume from their transcripts on ${to}.`),
  wait: (one) => `${one ? 'is' : 'are'} working: the handover waits up to three minutes for ${one ? 'its turn' : 'each turn'} to end, then asks you.`,
  answer: (one) => `${one ? 'waits on an answer' : 'wait on answers'}: answer first, or interrupt when the handover asks.`,
  background: (one) => `left ${one ? 'a command' : 'commands'} running in the background: the handover waits for ${one ? 'it' : 'them'} to end, or you terminate ${one ? 'it' : 'them'}.`,
  shell: (one, to) => (one ? `closes; the shell reopens in its folder on ${to}, and a command still running there does not move.`
    : `close; each shell reopens in its folder on ${to}, and a command still running there does not move.`),
  dormant: (one) => (one ? 'is dormant and stays so.' : 'are dormant and stay so.'),
};

/** Before anything is rested: who stops for the move, and how each comes back on the other machine. */
function RestPlan({ ctx }: { ctx: HintContext }) {
  const characters = useApp((s) => s.fleet.characters);
  return restPlan(characters).map(({ how, names }) => (
    <div key={how} className="host-step" data-testid={`handover-rest-${how}`}>
      <span className="host-mark" />
      <span className="host-said">{names.join(', ')} {REST_TEXT[how](names.length === 1, ctx.destination)}</span>
    </div>
  ));
}

/** Every folder and session as one bar, with each row behind it. */
function Transfer({ rows, ctx, run, done }: { rows: Row[]; ctx: HintContext; run: HandoverRun; done: boolean }) {
  const t = transferTotals(rows);
  // a finished transfer is the rows it verified; one under way is everything preflight found
  const whole = done ? t.totalBytes : transferBytes(run);
  const pace = done ? undefined : transferPace(run);
  const failed = rows.filter((r) => r.error);
  // a row whose copy kept files aside stays in sight like one that failed
  const loud = rows.filter((r) => r.error || r.notice);
  const fine = rows.filter((r) => !r.error && !r.notice);
  const f = whole ? Math.min(1, t.bytes / whole) : t.total ? t.done / t.total : 0;
  const counts = [[rows.filter((r) => r.kind === 'root').length, 'folder'], [rows.filter((r) => r.kind === 'session').length, 'session']] as const;
  const what = counts.filter(([n]) => n > 0).map(([n, one]) => plural(n, one)).join(' and ');
  return (
    <>
      <div className="host-step" data-testid="handover-transfer-total" data-status={failed.length ? 'fail' : 'ok'}>
        <span className="host-mark">{done ? '✓' : failed.length ? '×' : '·'}</span>
        <span className="host-said">
          {done ? `${what} verified on ${ctx.destination}, ${formatBytes(t.totalBytes)}` : `${formatBytes(t.bytes)} of ${formatBytes(whole)} · ${t.done} of ${t.total} verified${pace ? ` · ${pace.text}` : ''}`}
          <span className="ho-bar ho-bar-all"><i style={{ width: `${Math.round(f * 100)}%` }} /></span>
          {!done && !failed.length && <span className="ho-sub">Files already on {ctx.destination} are not sent again, so a bar can stop short until its folder is verified.</span>}
        </span>
      </div>
      {loud.map((row) => <EntityRow key={`${row.kind}:${row.id}`} row={row} ctx={ctx} run={run} />)}
      {fine.length > 0 && (
        <div className="host-step"><span className="host-mark" /><span className="host-said">
          <More label={what} testid="handover-transfer-rows">
            {fine.map((row) => <EntityRow key={`${row.kind}:${row.id}`} row={row} ctx={ctx} run={run} />)}
          </More>
        </span></div>
      )}
    </>
  );
}

function Section({ id, label, state, run, ctx }: { id: SectionId; label: string; state: SectionState; run: HandoverRun; ctx: HintContext }) {
  const rows = run.rows.filter((r) => r.section === id);
  const blockers = blockersIn(run, id);
  const pre = id === 'checks' ? run.preflight : undefined;
  const notes = pre?.warnings.filter((w) => !staysInSight(w)) ?? [];
  const done = state === 'done';
  // a freeze still waiting on agents takes new choices without anyone having to wait for it to give up
  const interrupt = id === 'rest' && state === 'active' && run.choices.interruptAfterMs === undefined && rows.some((x) => x.total === undefined && !x.error);
  const tally = id === 'resume' ? resumeTally(run) : undefined;
  const quiet = rows.filter((r) => !r.error);
  const loud = rows.filter((r) => r.error);
  const fold = done && id === 'rest' && quiet.length > 0;
  return (
    <div className="ho-section" data-testid={`handover-section-${id}`} data-state={state}>
      <div className="ho-head"><span className="host-mark">{MARK[state]}</span>{label}</div>
      {pre && (
        <div className="host-step" data-testid="handover-summary">
          <span className="host-mark" />
          <span className="host-said">
            {plural(pre.summary.roots, 'folder')}, {pre.summary.files} files, {formatBytes(pre.summary.bytes)}, {plural(pre.summary.sessions, 'session')}
          </span>
        </div>
      )}
      {pre && !run.phase && (run.following || actionsOf(run).tryAgain) && <RestPlan ctx={ctx} />}
      {blockers.map((b, i) => <BlockerRow key={`b${i}`} b={b} ctx={ctx} run={run} blockers={blockers} />)}
      {pre?.warnings.filter(staysInSight).map((w, i) => <BlockerRow key={`s${i}`} b={w} ctx={ctx} run={run} warning />)}
      {notes.length > 0 && (
        <div className="host-step">
          <span className="host-mark" />
          <span className="host-said">
            <More label={plural(notes.length, 'note')} testid="handover-notes">
              {notes.map((w, i) => <BlockerRow key={`w${i}`} b={w} ctx={ctx} run={run} warning />)}
            </More>
          </span>
        </div>
      )}
      {tally && (done || rows.length > 0) && (
        <div className="host-step" data-testid="handover-resume-tally" data-status={tally.failed ? 'fail' : 'ok'}>
          <span className="host-mark">{tally.failed ? '×' : done ? '✓' : '·'}</span>
          <span className="host-said">
            {plural(tally.resumed, 'agent')} resumed{tally.failed ? `, ${tally.failed} did not` : ''}
            {tally.shells > 0 && `; ${plural(tally.shells, 'terminal')} reopen${tally.shells === 1 ? 's' : ''} in ${tally.shells === 1 ? 'its' : 'their'} folder when you open ${tally.shells === 1 ? 'it' : 'them'}`}
          </span>
        </div>
      )}
      {id === 'transfer' && rows.length > 0
        ? <Transfer rows={rows} ctx={ctx} run={run} done={done} />
        : fold
          ? (
            <>
              {loud.map((row) => <EntityRow key={`${row.kind}:${row.id}`} row={row} ctx={ctx} run={run} />)}
              <div className="host-step"><span className="host-mark" /><span className="host-said">
                <More label={`${plural(quiet.length, 'character')} at rest`} testid="handover-rest-rows">
                  {quiet.map((row) => <EntityRow key={`${row.kind}:${row.id}`} row={row} ctx={ctx} run={run} />)}
                </More>
              </span></div>
            </>
          )
          : rows.map((row) => <EntityRow key={`${row.kind}:${row.id}`} row={row} ctx={ctx} run={run} />)}
      {id === 'commit' && (state === 'active' || done) && (
        <div className="host-step" data-testid="handover-no-way-back"><span className="host-mark" /><span className="host-said ho-sub">
          From here there is no way back: the gateway gives the fleet to {ctx.destination}, and the move can only go on.
        </span></div>
      )}
      {interrupt && (
        <div className="host-step"><span className="host-mark" /><span className="host-said"><span className="ho-acts">
          <button className="btn ho-choice" data-testid="handover-interrupt" title={`Stops every agent still at work with Escape; each resumes from its transcript on ${ctx.destination}`}
            onClick={() => { const choices = { ...run.choices, interruptAfterMs: 0 }; store().setHandoverChoices(choices); app.bridge.send({ type: 'handover.choose', choices }); }}>
            Interrupt and carry
          </button>
        </span></span></div>
      )}
    </div>
  );
}

/** No gateway to move to: a machine this Mac knows made the gateway, or a new one added, and back to the sheet after. */
function NoGateway() {
  const machines = useApp((s) => s.machines);
  const error = useApp((s) => s.machinesError);
  const running = useApp((s) => !!s.host?.running);
  const list = () => { app.bridge.send({ type: 'host.list' }); };
  useEffect(list, []);
  const known = machines?.filter((m) => m.ssh) ?? [];
  const enable = (name: string) => { store().hostFromHandover(name); startHost('enable', { name }); };
  return (
    <div className="host-note" data-testid="handover-no-gateway">
      {error ?? (known.length ? "Make a machine this fleet's gateway to move the fleet there." : 'Add a Linux machine to move this fleet to.')}
      <div className="acts">
        {error && <button className="btn" data-testid="handover-machines-reload" onClick={list}>Read again</button>}
        {known.map((m) => (
          <button key={m.id} className="btn pri" data-testid={`handover-enable-${m.name}`} disabled={running} onClick={() => enable(m.name)}>
            Make {m.name} this fleet&apos;s gateway
          </button>
        ))}
        <button className={known.length ? 'btn' : 'btn pri'} data-testid="handover-add-machine" disabled={running} onClick={() => store().hostFromHandover()}>Add machine</button>
      </div>
    </div>
  );
}

/** The one place the fleet can go: the gateway from this Mac, and this Mac from the gateway. */
function Destination({ owner, gateway, onChose }: { owner: string; gateway?: string; onChose(): void }) {
  const to = owner === 'local' ? gateway : 'local';
  if (!to) return <NoGateway />;
  return (
    <div className="acts" data-testid="handover-destinations">
      <button className="btn pri" data-testid={to === 'local' ? 'handover-to-local' : 'handover-to-gateway'} onClick={() => { onChose(); start(to, {}, true); }}>
        Move to {destinationName(to)}
      </button>
    </div>
  );
}

/** Which way the fleet goes, and which end it is at now. */
function Route({ run, ctx }: { run: HandoverRun; ctx: HintContext }) {
  const landed = isCommitted(run);
  return (
    <div className="ho-route" data-testid="handover-route" data-landed={landed || undefined}>
      <span className="ho-end" data-here={!landed || undefined}>{ctx.source}</span>
      <span className="ho-arrow" aria-label="to">→</span>
      <span className="ho-end" data-here={landed || undefined}>{ctx.destination}</span>
    </div>
  );
}

/** What the footer says beside its buttons: the one line on where things stand, and how much of a decision is made. */
function footerNote(run: HandoverRun, ctx: HintContext): { tone: 'ok' | 'wait' | 'done' | 'stop'; sub?: string } {
  const r = run.result;
  if (r?.status === 'complete' || run.status?.standing === 'moved') return { tone: 'done' };
  if (decisionPending(run)) return { tone: 'wait' };
  if (r?.status === 'blocked' && !verdictOf(run)) {
    const open = r.blockers.filter((b) => choiceFor(b) && !chosen(run.choices, b)).length;
    const fix = r.blockers.filter((b) => !choiceFor(b)).length;
    const parts = [open ? `${open} ${open === 1 ? 'choice' : 'choices'} still open` : '', fix ? `${plural(fix, 'thing')} to fix outside the sheet first` : ''].filter(Boolean);
    return { tone: 'stop', sub: parts.length ? `${parts.join('; ')}. Move to ${ctx.destination} runs the checks again.` : `Everything is settled: Move to ${ctx.destination} runs the checks again and goes on.` };
  }
  if (r?.status === 'ready' && actionsOf(run).tryAgain) return { tone: 'ok', sub: `Move to ${ctx.destination} runs the checks once more, then rests the characters above; until the commit, Abort gives the fleet back.` };
  const a = actionsOf(run);
  if (a.resume === 'Resume') return { tone: 'stop', sub: `Resume goes on from where it stopped${a.abort ? `; Abort gives the fleet back to ${ctx.source}` : ''}.` };
  if (a.resume === 'Retry') return { tone: 'stop', sub: `Retry finishes resuming on ${ctx.destination}; nothing goes back from here.` };
  if (r || run.status || run.error) return { tone: 'stop' };
  return { tone: 'ok' };
}

// onAgain: how to pick another destination, while none is in sight
function Footer({ run, ctx, onAgain }: { run: HandoverRun; ctx: HintContext; onAgain?: () => void }) {
  const acts = actionsOf(run);
  const said = headline(run, ctx.destination);
  const way = wayOut(run, ctx);
  const detail = detailOf(run);
  const { tone, sub } = footerNote(run, ctx);
  const close = () => store().toggleHandover(false);
  let buttons: ReactNode[];
  if (decisionPending(run)) {
    const blockers = run.decision!.blockers;
    const picked = Object.keys(run.choices).length > 0;
    const go = picked ? 'Carry on' : blockers.length > 0 && blockers.every((b) => b.code === 'agent_working') ? 'Continue waiting' : 'Try again';
    buttons = [
      <button key="go" className="btn pri" data-testid="handover-go" autoFocus onClick={() => choose(run.choices)}>{go}</button>,
      <button key="abort" className="btn dan" data-testid="handover-abort" onClick={cancel}>Abort</button>,
    ];
  } else {
    buttons = [
      acts.tryAgain && <button key="again" className="btn pri" data-testid="handover-try-again" onClick={() => start(run.to!, run.choices)}>Move to {ctx.destination}</button>,
      acts.resume && <button key="resume" className="btn pri" data-testid="handover-resume" onClick={() => follow(run, 'handover.resume')}>{acts.resume}</button>,
      acts.cancel && <button key="cancel" className="btn dan" data-testid="handover-abort" onClick={cancel}>Abort</button>,
      acts.abort && <button key="abort" className="btn dan" data-testid="handover-abort" onClick={() => follow(run, 'handover.abort')}>Abort</button>,
      acts.forget && (
        <button key="forget" className="btn" data-testid="handover-forget" title="The gateway has moved on from this handover; drop this Mac's record of it"
          onClick={() => follow(run, 'handover.forget')}>Forget</button>
      ),
      acts.follow && <button key="follow" className="btn" data-testid="handover-follow" onClick={() => follow(run, 'handover.attach')}>Check again</button>,
      tone === 'done' && !acts.resume && <button key="close" className="btn pri" data-testid="handover-done" onClick={close}>Close</button>,
      tone === 'stop' && !acts.tryAgain && !acts.resume && !acts.follow && !acts.forget && <button key="close" className="btn" data-testid="handover-done" onClick={close}>Close</button>,
    ].filter(Boolean);
  }
  return (
    <div className="ho-foot" data-testid="handover-footer" data-tone={tone}>
      {said && <div className="ho-status" data-testid="handover-headline" aria-live="polite">{said}</div>}
      {sub && <div className="ho-sub" data-testid="handover-footnote">{sub}</div>}
      {way && <div className="ho-sub" data-testid="handover-way-out">{withCode(way)}</div>}
      {detail && <More label="Details" testid="handover-detail">{withCode(detail)}</More>}
      {buttons.length > 0 && <div className="acts">{buttons}</div>}
      {acts.start && onAgain && (
        <button className="btn ghost ho-again" data-testid="handover-again" onClick={onAgain}>Move the fleet somewhere else…</button>
      )}
    </div>
  );
}

/** Moving the fleet to another machine: the six steps of the helper's transaction, as they arrive. */
export function HandoverSheet() {
  const open = useApp((s) => s.handoverOpen);
  const enabled = useApp((s) => !!s.shell?.handoverEnabled);
  const run = useApp((s) => s.handover);
  const gateway = useApp((s) => s.shell?.gateway);
  const runsOn = useApp((s) => s.connection?.owner);
  const owner = runsOn ?? 'local';
  const characters = useApp((s) => s.fleet.characters);
  const home = useApp((s) => accountHome(s.shell?.home));
  const svall = useApp((s) => svallFor(s.shell?.profile));
  const shut = useRef<HTMLButtonElement>(null);
  // the user asked to pick a destination over a run the sheet still shows
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPicking(false);
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

  // what the sheet does without asking; read from the store, so a second run of this effect finds it under way
  useEffect(() => {
    if (!enabled) return;
    if (goesOnByItself(store().handover)) {
      store().handoverGoOn();
      app.bridge.send({ type: 'handover.resume' });
    } else if (asksStatus(store().handover)) {
      store().handoverCheck();
      app.bridge.send({ type: 'handover.attach' });
    }
  }, [run, enabled]);

  if (!open || !enabled) return null;
  const to = run && destinationOf(run, runsOn, gateway);
  const destination = destinationName(to);
  const ctx: HintContext = {
    destination, source: to === 'local' ? gateway ?? 'the gateway' : to ? 'This Mac' : 'the machine it came from', pull: to === 'local', home, svall, gateway,
    name: (id) => characters[id]?.name ?? run?.preflight?.names?.characters[id] ?? id,
  };
  const close = () => store().toggleHandover(false);
  const shown = !!run && !!(run.phase || run.preflight || run.result || run.status?.phase) && !picking;
  const choosing = !shown && actionsOf(run).start;
  // with nothing open, the status has nothing to add to the destination above it
  const idle = choosing && run?.status?.standing === 'none' && !run.status.safe.length;

  return (
    <div className="modal-back" data-testid="handover-sheet" onPointerDown={close}>
      <div className="modal host panel ho" onPointerDown={(e) => e.stopPropagation()}>
        <div className="ho-top">
          <div className="kicker">
            Handover
            <span className="spacer" />
            <button ref={shut} className="side-x" data-testid="handover-close" title="Close" aria-label="Close" onClick={close}>×</button>
          </div>
          {shown && to && <Route run={run} ctx={ctx} />}
        </div>
        <div className="ho-body">
          {!shown && (
            <div className="host-note" data-testid="handover-intro">
              A handover moves the whole fleet: its islands, characters, repositories and agent sessions. Agents resume from
              their transcripts and shells reopen in their folders on the other machine; a command still running does not
              move. Choosing a machine runs the checks alone, and nothing moves until you choose Move.
            </div>
          )}
          {choosing && <Destination owner={owner} gateway={gateway} onChose={() => setPicking(false)} />}
          {shown && (
            <div className="host-steps" data-testid="handover-sections">
              {sectionStates(run).map((s) => <Section key={s.id} {...s} run={run} ctx={ctx} />)}
            </div>
          )}
        </div>
        {run && !picking && !idle && <Footer run={run} ctx={ctx} onAgain={choosing ? undefined : () => setPicking(true)} />}
      </div>
    </div>
  );
}
