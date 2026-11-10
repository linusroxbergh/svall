import { ROBOT_NOTE_MAX, lastActive, type Robot, type ContextItem, type FleetState, type MachineId, type Params } from '@svall/protocol';
import { AgentProfilePick } from './AgentProfilePick.js';
import { app, deps } from './boot.js';
import { saveRobot, saveRobotContext, setStar } from './actions.js';
import { copyText, openFolder } from './bridge.js';
import { AddLink, ContextPills } from './ContextList.js';
import { FollowLine, FollowTextarea } from './Field.js';
import { useApp, usePanelWidth, useTick } from './hooks.js';
import { startHost } from './hostRun.js';
import { Caret, Mac, Machine, Star } from './icons.js';
import { MachineLine } from './indicators.js';
import { Info } from './Info.js';
import { keyTip } from './keys.js';
import { ago, hintText } from './map/tokenText.js';
import { OnMachine, TerminalThere } from './OnMachine.js';
import { buttonTry, fieldTry, useRefusal } from './frozen.js';
import { answers, awayLine, frozenWhy, homeName, machineOf, robotMachine } from './placement.js';
import { figureOf, figureUrl, stepFigure } from './portraits.js';
import { usePromptHistory } from './promptHistory.js';
import { DocsList } from './resources/DocsList.js';
import { ResourcesButton } from './ResourcesButton.js';
import { Section } from './Section.js';
import { contextPctOf, islandsSorted, isUnread, resumeErrorOf, statusOf } from './selectors.js';

type Patch = Omit<Params<'robot.update'>, 'id'>;

// collapsing is sticky: the card stays shut until the user opens it again.
export function Collapse() {
  const bindings = useApp((s) => s.settings.bindings);
  const width = usePanelWidth('card');
  return (
    <button className="side-collapse" style={width} data-testid="side-collapse" data-tip={keyTip('Hide the side card', 'toggleSideCard', bindings)}
      aria-label="Hide the side card" onClick={() => app.store.getState().toggleSideCard(false)}><Caret dir="right" /></button>
  );
}

function LastCommand({ id, agent }: { id: string; agent: Robot['agent'] }) {
  const { list, at, step } = usePromptHistory(app.api, id, agent);
  if (!agent) return null;
  return (
    <Section name="robot.command" title="Last command" testid="side-prompt" head={list.length > 1 && (
      <span className="cmd-nav">
        <button className="ib xs" data-testid="side-prompt-prev" aria-label="Earlier command" disabled={at >= list.length - 1} onClick={() => step(1)}><Caret dir="left" /></button>
        <b className="tnum" data-testid="side-prompt-pos">{at + 1}/{list.length}</b>
        <button className="ib xs" data-testid="side-prompt-next" aria-label="Later command" disabled={at === 0} onClick={() => step(-1)}><Caret dir="right" /></button>
      </span>
    )}>
      <p className="cmd-text" data-testid="side-prompt-text">{list[at]?.trim().replace(/\n{3,}/g, '\n\n') ?? 'nothing sent yet'}</p>
    </Section>
  );
}

function PortraitPicker({ id, portrait, figure, refuse }: Pick<Robot, 'id' | 'portrait' | 'figure'> & { refuse?: () => void }) {
  const step = (by: 1 | -1) => saveRobot(deps(), id, { figure: stepFigure(figureOf({ portrait, figure }), by) });
  return (
    <div className="side-portrait" data-testid="side-portrait">
      <button className="ib pnav" data-testid="portrait-prev" aria-label="Previous portrait" {...buttonTry(refuse)} onClick={() => step(-1)}><Caret dir="left" /></button>
      <img className="side-figure" src={figureUrl(figureOf({ portrait, figure }))} alt="robot" draggable={false} />
      <button className="ib pnav" data-testid="portrait-next" aria-label="Next portrait" {...buttonTry(refuse)} onClick={() => step(1)}><Caret dir="right" /></button>
    </div>
  );
}

// last activity counts on while a busy agent sends nothing
function LastActivity({ at }: { at: number }) {
  useTick(10_000);
  return <div className="row"><span>last activity</span><b className="tnum">{ago(at)} ago</b></div>;
}

export function SideCard({ id }: { id: string }) {
  const c = useApp((s) => s.fleet.robots[id]);
  const refuse = useRefusal(id);
  const home = useApp((s) => s.home);
  const homeState = home?.state;
  const readOnly = useApp((s) => { const why = frozenWhy(s, id); return why && `Read-only until ${why.once}.`; });
  const machines = useApp((s) => s.fleet.machines);
  const via = useApp((s) => s.via);
  const shell = useApp((s) => s.shell);
  const islands = useApp((s) => s.fleet.islands);
  const fleet = { machines, islands };
  const hover = useApp((s) => s.dropHover?.kind === 'robot' && s.dropHover.id === id);
  const failed = resumeErrorOf(c);
  const width = usePanelWidth('card');
  const hostRunning = useApp((s) => !!s.host?.running);
  // its name alone, so the starter's other changes redraw nothing here
  const by = useApp((s) => (c?.startedBy && Object.hasOwn(s.fleet.robots, c.startedBy) ? s.fleet.robots[c.startedBy].name : undefined));
  // the ids alone, so another robot's change redraws nothing here
  const started = useApp((s) => Object.values(s.fleet.robots).filter((k) => k.startedBy === id).map((k) => k.id).join(' '));
  if (!c) return null;

  const status = statusOf(c, fleet, via);
  // a robot on a worker: its folder buttons act there or step aside, and it moves back here
  const placed = machineOf(fleet, c, via);
  const away = awayLine(fleet, c, via, home);
  const cwd = placed ? `${placed}:${c.cwd}` : c.cwd;
  // one on a worker moves back from wherever on the map it stands
  const onHome = c.machine === undefined || c.machine === via?.home;
  // and nothing moves while the page stands in for a home it cannot reach
  const movable = (!onHome || fleet.islands[c.islandId]?.kind !== 'home') && !c.moving && (!via || via.online === true);
  const workers = Object.entries(fleet.machines ?? {}).filter(([, m]) => answers(m));
  const accent = `var(--${status})`;
  const pct = contextPctOf(c);
  const starred = c.star !== undefined;
  const save = (patch: Patch) => saveRobot(deps(), id, patch);
  const saveContext = (context: ContextItem[], removed?: string) => saveRobotContext(deps(), id, context, removed);

  return (
    <aside className="side" style={width} data-testid="side-card" data-drop={`robot:${id}`} data-drop-hover={hover}>
      <div className="kicker" style={{ color: accent }}>
        <i className="sdot" data-status={status} />{status !== 'unknown' ? status : readOnly && homeState && homeState !== 'unreachable' && homeState !== 'connecting' ? 'read-only' : 'unreachable'}{isUnread(c) ? ' · unread' : ''}
      </div>
      <div className="side-id">
        <div className="side-head">
          <PortraitPicker id={id} portrait={c.portrait} figure={c.figure} refuse={refuse} />
          <FollowLine className="h2" aria-label="Name" key={`name-${id}`} value={c.name} {...fieldTry(refuse)} data-testid="side-name"
            onSave={(v) => { const name = v.trim(); if (!name || name === c.name) return false; return save({ name }); }} />
          <button className="ib side-star" data-testid="side-star" aria-pressed={starred} data-tip={starred ? 'Unstar' : 'Star'}
            aria-label="Star" {...buttonTry(refuse)} onClick={() => setStar(deps(), id, !starred)}><Star on={starred} size="lg" /></button>
        </div>
        {placed && <MachineLine name={placed} className="side-on" testid="side-machine" />}
        {placed && away && <AwayLine name={placed} line={away} running={hostRunning} readOnly={readOnly} />}
        {c.repo && (
          <div className="side-branch" data-testid="side-branch">
            <span className="mono">{c.repo.branch}</span>{c.repo.isWorktree && <span className="badge">wt</span>}
          </div>
        )}
        {c.hint && <div className="side-hint" data-testid="side-hint">{hintText(c)}</div>}
        {by && <div className="side-by" data-testid="side-started-by">started by <RobotLink c={{ id: c.startedBy!, name: by }} /></div>}
        {c.relayed?.held && <Held id={id} n={c.relayed.n} promptId={c.relayed.held} refuse={refuse} />}
      </div>
      <div className="side-secs">
        {placed && c.machine && !onHome && !c.moving && <OnMachine key={`${id}:${c.machine}:${c.placement?.generation}`} id={id} machine={c.machine} name={placed} />}
        <Section name="robot.note" title="Note" head={<Info id="robot-note">Sent to the agent when it starts; your change mid-session reaches it with your next prompt. The scribe fills it in until you write one.</Info>}>
          <FollowTextarea className="fld desc" rows={6} placeholder="What this robot is doing" key={`note-${id}`} value={c.note} {...fieldTry(refuse)} maxLength={ROBOT_NOTE_MAX} data-testid="side-note"
            onSave={(v) => (v !== c.note ? save({ note: v }) : undefined)} />
        </Section>
        <Section name="robot.instructions" title="Agent instructions" shut head={<Info id="robot-instructions">Sent to the agent when it starts; your change mid-session reaches it with your next prompt. A new profile is sent whole.</Info>}>
          <AgentProfilePick id={id} refuse={refuse} />
          <FollowTextarea className="fld desc" rows={3} placeholder="Anything else this agent should know" key={`instructions-${id}`} value={c.instructions} {...fieldTry(refuse)} data-testid="side-instructions"
            onSave={(v) => (v !== c.instructions ? save({ instructions: v }) : undefined)} />
        </Section>
        <Section name="robot.context" title="Context" head={<Info id="robot-context">Listed for the agent when it starts, pinned items to read first; your change mid-session reaches it with your next prompt.</Info>}>
          <ContextPills items={c.context} ids={{ list: 'side-context', remove: 'context-remove' }}
            robotId={id} onChange={refuse ? undefined : saveContext} />
          {!refuse && <AddLink id={id} ids={{ ref: 'context-ref', add: 'context-add' }} onAdd={(item) => saveContext([...c.context, item])} />}
        </Section>
        {started && (
          <Section name="robot.started" title="Robots it started">
            <div className="rows" data-testid="side-started">
              {started.split(' ').map((k) => <StartedRow key={k} id={k} machines={machines} />)}
            </div>
          </Section>
        )}
        <DocsList tier="robot" id={id} />
        <LastCommand key={id} id={id} agent={c.agent} />
        <Section name="robot.details" title="Details">
          <div className="rows">
            <div className="row"><span>island</span>
              <b><select className="fld inline" aria-label="Island" value={c.islandId} data-testid="side-island" aria-disabled={refuse && true}
                onMouseDownCapture={refuse && ((e) => { e.preventDefault(); refuse(); })} onChange={(e) => (refuse ? refuse() : save({ islandId: e.target.value }))}>
                {islandsSorted(fleet).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select></b>
            </div>
            <div className="row"><span>model</span><b className="mono">{c.agent?.model ?? 'no agent'}</b></div>
            <div className="row"><span>cwd</span><b className="mono">
              <button className="copy clip-head" data-tip={`Copy ${cwd}`} data-testid="side-cwd"
                onClick={() => { copyText(app.bridge, cwd); app.store.getState().showToast('Copied', 'ok'); }}><bdi>{c.cwd}</bdi></button>
            </b></div>
            {pct !== undefined && (
              <div className="row"><span>context</span>
                <div className="meter" data-testid="side-meter">
                  <span><i style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: accent }} /></span>
                  <b className="tnum">{Math.round(pct)}%</b>
                </div>
              </div>
            )}
            <LastActivity at={c.agent ? lastActive(c.agent) : c.shell.lastOutputAt} />
            {failed && <div className="row" data-testid="side-resume-error"><span>resume failed</span><b data-error>{failed}</b></div>}
            {placed && <div className="row" data-testid="side-dev-server"><span>dev server</span><b>stays on {placed}; forward its port by hand to open it here</b></div>}
          </div>
        </Section>
      </div>
      <div className="acts">
        {movable && (!onHome || workers.length > 0) && (
          <div className="moves">
            {!onHome
              ? <button className="btn sm move" data-testid="side-move-home" onClick={() => app.store.getState().setMoveSheet({ id, ...(via && { to: via.home }) })}>{via ? <Machine /> : <Mac />}<span>Move to {via ? homeName(fleet, via) : 'this Mac'}</span><Caret dir="right" /></button>
              : workers.map(([m, w]) => (
                <button key={m} className="btn sm move" data-testid={`side-move-${m}`} onClick={() => app.store.getState().setMoveSheet({ id, to: m as MachineId })}>{m === via?.machine ? <Mac /> : <Machine />}<span>Move to {m === via?.machine ? 'this Mac' : w.name}</span><Caret dir="right" /></button>
              ))}
          </div>
        )}
        {placed ? <TerminalThere name={placed} dir={c.cwd} testid="side-finder" /> : (
          <button className="btn sm" data-testid="side-finder" data-tip={`Reveal ${c.cwd} in Finder`}
            onClick={() => openFolder(app.bridge, c.cwd, robotMachine(c, { via, shell }))}>Finder</button>
        )}
        <ResourcesButton root={c.repo?.mainRoot ?? c.cwd} machine={c.machine} testid="side-resources" />
        <button className="btn sm pri" data-testid="side-open" onClick={() => app.store.getState().focus(id)}>Open terminal</button>
        <button className="btn sm dan" data-testid="side-close" data-tip="Deletes the robot and kills its terminal" {...buttonTry(refuse)}
          onClick={() => app.store.getState().setClosingRobot(id)}>Delete robot</button>
      </div>
    </aside>
  );
}

const RobotLink = ({ c }: { c: Pick<Robot, 'id' | 'name'> }) => (
  <button className="copy side-link" data-tip={`Show ${c.name}`} onClick={() => app.store.getState().select(c.id)}>{c.name}</button>
);

function StartedRow({ id, machines }: { id: string; machines: FleetState['machines'] }) {
  const c = useApp((s) => s.fleet.robots[id]);
  const via = useApp((s) => s.via);
  if (!c) return null;
  const status = statusOf(c, { machines }, via);
  return (
    <div className="row"><b><RobotLink c={c} /></b>
      <span className="side-started-status"><i className="sdot" data-status={status} />{status}{c.report ? ' · reports back' : ''}</span>
    </div>
  );
}

// robot messages waiting on the user, past the run of them a loop between robots would make
function Held({ id, n, promptId, refuse }: { id: string; n: number; promptId: string; refuse?: () => void }) {
  const answer = (a: 'approve' | 'deny') => app.api().call('robot.answer', { id, answer: a, promptId })
    .catch((e: Error) => app.store.getState().showToast(e.message, 'error'));
  return (
    <div className="side-away" data-testid="side-held">
      <span>{n} robot messages since your last prompt; the next waits on you</span>
      <span className="side-held-acts">
        <button className="btn sm" data-testid="side-held-let" {...buttonTry(refuse)} onClick={() => void answer('approve')}>Let in</button>
        <button className="btn sm" data-testid="side-held-drop" {...buttonTry(refuse)} onClick={() => void answer('deny')}>Drop</button>
      </span>
    </div>
  );
}

// why the robot's machine is out of reach, and a check of it, whose release row offers the upgrade when it is the machine's to take
function AwayLine({ name, line, running, readOnly }: { name: string; line: string; running: boolean; readOnly?: string }) {
  const run = () => { app.store.getState().toggleHost(true, name); startHost('doctor', { name }); };
  return (
    <div className="side-away" data-testid="side-away">
      <span>{line}{readOnly && <small data-testid="side-away-read-only">{readOnly}</small>}</span>
      <button className="btn sm" data-testid="side-away-run" disabled={running} data-tip="What is wrong on the machine, checked now" onClick={run}>Check {name}</button>
    </div>
  );
}
