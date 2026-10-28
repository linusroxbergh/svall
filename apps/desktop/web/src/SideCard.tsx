import type { Robot, ContextItem, MachineId, Params } from '@svall/protocol';
import { AgentProfilePick } from './AgentProfilePick.js';
import { app, deps } from './boot.js';
import { saveRobot, saveRobotContext, setStar } from './actions.js';
import { copyText, openFolder } from './bridge.js';
import { AddLink, ContextPills } from './ContextList.js';
import { FollowLine, FollowTextarea } from './Field.js';
import { useApp, usePanelWidth, useTick } from './hooks.js';
import { startHost } from './hostRun.js';
import { MachineLine } from './indicators.js';
import { Info } from './Info.js';
import { keyTip } from './keys.js';
import { useLoad } from './load.js';
import { coresText, memText } from './loadText.js';
import { ago, hintText } from './map/tokenText.js';
import { terminalOn } from './MoveSheet.js';
import { OnMachine } from './OnMachine.js';
import { awayLine, isPlaced, machineOf } from './placement.js';
import { figureOf, figureUrl, stepFigure } from './portraits.js';
import { usePromptHistory } from './promptHistory.js';
import { DocsList } from './resources/DocsList.js';
import { ResourcesButton } from './ResourcesButton.js';
import { Section } from './Section.js';
import { contextPctOf, islandsSorted, isUnread, resumeErrorOf, statusOf } from './selectors.js';
import { StarIcon } from './Sidebar.js';

type Patch = Omit<Params<'robot.update'>, 'id'>;

// collapsing is sticky: the card stays shut until the user opens it again.
export function Collapse() {
  const bindings = useApp((s) => s.settings.bindings);
  const width = usePanelWidth('card');
  return (
    <button className="side-collapse" style={width} data-testid="side-collapse" data-tip={keyTip('Hide the side card', 'toggleSideCard', bindings)}
      aria-label="Hide the side card" onClick={() => app.store.getState().toggleSideCard(false)}>›</button>
  );
}

function LastCommand({ id, agent }: { id: string; agent: Robot['agent'] }) {
  const { list, at, step } = usePromptHistory(app.api, id, agent);
  if (!agent) return null;
  return (
    <Section name="robot.command" title="Last command" testid="side-prompt" head={list.length > 0 && (
      <span className="cmd-nav">
        <button data-testid="side-prompt-prev" aria-label="Earlier command" disabled={at >= list.length - 1} onClick={() => step(1)}>‹</button>
        <b className="tnum" data-testid="side-prompt-pos">{at + 1}/{list.length}</b>
        <button data-testid="side-prompt-next" aria-label="Later command" disabled={at === 0} onClick={() => step(-1)}>›</button>
      </span>
    )}>
      <p className="cmd-text" data-testid="side-prompt-text">{list[at] ?? 'nothing sent yet'}</p>
    </Section>
  );
}

function PortraitPicker({ id, portrait, figure }: Pick<Robot, 'id' | 'portrait' | 'figure'>) {
  const step = (by: 1 | -1) => saveRobot(deps(), id, { figure: stepFigure(figureOf({ portrait, figure }), by) });
  return (
    <div className="side-portrait" data-testid="side-portrait">
      <button className="pnav" data-testid="portrait-prev" aria-label="Previous portrait" onClick={() => step(-1)}>‹</button>
      <img className="side-figure" src={figureUrl(figureOf({ portrait, figure }))} alt="robot" draggable={false} />
      <button className="pnav" data-testid="portrait-next" aria-label="Next portrait" onClick={() => step(1)}>›</button>
    </div>
  );
}

export function SideCard({ id }: { id: string }) {
  const c = useApp((s) => s.fleet.robots[id]);
  const fleet = useApp((s) => s.fleet);
  const hover = useApp((s) => s.dropHover?.kind === 'robot' && s.dropHover.id === id);
  // last activity counts on while a busy agent sends nothing
  useTick(10_000);
  const details = useApp((s) => !s.sections['robot.details']?.shut);
  const active = useApp((s) => s.active);
  const load = useLoad(details && active).load?.robots?.[id];
  const failed = resumeErrorOf(c);
  const width = usePanelWidth('card');
  const hostRunning = useApp((s) => !!s.host?.running);
  if (!c) return null;

  const status = statusOf(c, fleet);
  // a robot on a worker: its folder buttons act there or step aside, and it moves back here
  const placed = machineOf(fleet, c);
  const away = awayLine(fleet, c);
  const cwd = placed ? `${placed}:${c.cwd}` : c.cwd;
  // one on a worker moves back from wherever on the map it stands
  const movable = (placed !== undefined || fleet.islands[c.islandId]?.kind !== 'home') && !c.moving;
  const workers = Object.entries(fleet.machines ?? {}).filter(([, m]) => m.reachable);
  const accent = `var(--${status})`;
  const pct = contextPctOf(c);
  const starred = c.star !== undefined;
  const save = (patch: Patch) => saveRobot(deps(), id, patch);
  const saveContext = (context: ContextItem[], removed?: string) => saveRobotContext(deps(), id, context, removed);

  return (
    <aside className="side" style={width} data-testid="side-card" data-drop={`robot:${id}`} data-drop-hover={hover}>
      <div className="kicker" style={{ color: accent }}>
        <i className="sdot" data-status={status} />{status === 'unknown' ? 'unreachable' : status}{isUnread(c) ? ' · unread' : ''}
      </div>
      <div className="side-head">
        <PortraitPicker id={id} portrait={c.portrait} figure={c.figure} />
        <FollowLine className="h2" aria-label="Name" key={`name-${id}`} value={c.name} data-testid="side-name"
          onSave={(v) => { const name = v.trim(); if (!name || name === c.name) return false; save({ name }); }} />
        <button className="side-star" data-testid="side-star" aria-pressed={starred} data-tip={starred ? 'Unstar' : 'Star'}
          aria-label="Star" onClick={() => setStar(deps(), id, !starred)}><StarIcon on={starred} /></button>
      </div>
      {placed && <MachineLine name={placed} className="side-on" testid="side-machine" />}
      {placed && away && <AwayLine name={placed} line={away} running={hostRunning} />}
      {c.repo && (
        <div className="side-branch" data-testid="side-branch">
          <span className="mono">{c.repo.branch}</span>{c.repo.isWorktree && <span className="badge">wt</span>}
        </div>
      )}
      {c.hint && <div className="side-hint" data-testid="side-hint">{hintText(c)}</div>}
      <div className="side-secs">
        {placed && isPlaced(c) && !c.moving && <OnMachine key={`${id}:${c.machine}:${c.placement?.generation}`} id={id} machine={c.machine} name={placed} />}
        <Section name="robot.note" title="Note" head={<Info id="robot-note">Sent to the agent when it starts; your change mid-session reaches it with your next prompt. The scribe fills it in until you write one.</Info>}>
          <FollowTextarea className="fld desc" rows={6} placeholder="What this robot is doing" key={`note-${id}`} value={c.note} data-testid="side-note"
            onSave={(v) => { if (v !== c.note) save({ note: v }); }} />
        </Section>
        <Section name="robot.instructions" title="Agent instructions" head={<Info id="robot-instructions">Sent to the agent when it starts; your change mid-session reaches it with your next prompt. A new profile is sent whole.</Info>}>
          <AgentProfilePick id={id} />
          <FollowTextarea className="fld desc" rows={3} placeholder="Anything else this agent should know" key={`instructions-${id}`} value={c.instructions} data-testid="side-instructions"
            onSave={(v) => { if (v !== c.instructions) save({ instructions: v }); }} />
        </Section>
        <Section name="robot.context" title="Context" head={<Info id="robot-context">Listed for the agent when it starts, pinned items to read first; your change mid-session reaches it with your next prompt.</Info>}>
          <ContextPills items={c.context} ids={{ list: 'side-context', remove: 'context-remove' }}
            robotId={id} onChange={saveContext} />
          <AddLink id={id} ids={{ ref: 'context-ref', add: 'context-add' }} onAdd={(item) => saveContext([...c.context, item])} />
        </Section>
        <DocsList tier="robot" id={id} />
        <LastCommand key={id} id={id} agent={c.agent} />
        <Section name="robot.details" title="Details">
          <div className="rows">
            <div className="row"><span>island</span>
              <b><select className="fld inline" aria-label="Island" value={c.islandId} data-testid="side-island" onChange={(e) => save({ islandId: e.target.value })}>
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
            <div className="row"><span>last activity</span><b className="tnum">{ago(c.agent?.lastActivityAt ?? c.shell.lastOutputAt)} ago</b></div>
            {load && !placed && (
              <>
                <div className="row"><span>cpu</span><b className="tnum" data-testid="side-cpu">{coresText(load.cpu)} cores</b></div>
                <div className="row"><span>ram</span><b className="tnum" data-testid="side-ram">{memText(load.mem)}</b></div>
                <div className="row"><span>procs</span><b className="tnum" data-testid="side-procs">{load.procs}</b></div>
              </>
            )}
            {failed && <div className="row" data-testid="side-resume-error"><span>resume failed</span><b>{failed}</b></div>}
          </div>
        </Section>
      </div>
      <div className="acts">
        {placed ? (
          <button className="btn" data-testid="side-finder" data-tip={`A terminal on ${placed} in ${c.cwd}`}
            onClick={() => terminalOn(placed, `cd '${c.cwd.replaceAll("'", "'\\''")}'`)}>Terminal there</button>
        ) : (
          <button className="btn" data-testid="side-finder" data-tip={`Reveal ${c.cwd} in Finder`}
            onClick={() => openFolder(app.bridge, c.cwd)}>Finder</button>
        )}
        <ResourcesButton root={c.repo?.mainRoot ?? c.cwd} machine={c.machine} testid="side-resources" />
        {movable && (placed || workers.length > 0) && (
          <div className="moves">
            {placed
              ? <button className="btn" data-testid="side-move-home" onClick={() => app.store.getState().setMoveSheet({ id })}>Move to this Mac</button>
              : workers.map(([m, w]) => (
                <button key={m} className="btn" data-testid={`side-move-${m}`} onClick={() => app.store.getState().setMoveSheet({ id, to: m as MachineId })}>Move to {w.name}</button>
              ))}
          </div>
        )}
        <button className="btn pri" data-testid="side-open" onClick={() => app.store.getState().focus(id)}>Open terminal</button>
        <button className="btn dan" data-testid="side-close" data-tip="Deletes the robot and kills its terminal"
          onClick={() => app.store.getState().setClosingRobot(id)}>Delete robot</button>
      </div>
    </aside>
  );
}

// why the robot's machine is out of reach, and a check of it, whose release row offers the upgrade when it is the machine's to take
function AwayLine({ name, line, running }: { name: string; line: string; running: boolean }) {
  const run = () => { app.store.getState().toggleHost(true, name); startHost('doctor', { name }); };
  return (
    <div className="side-away" data-testid="side-away">
      <span>{line}</span>
      <button className="btn set-open" data-testid="side-away-run" disabled={running} data-tip="What is wrong on the machine, checked now" onClick={run}>Check {name}</button>
    </div>
  );
}
