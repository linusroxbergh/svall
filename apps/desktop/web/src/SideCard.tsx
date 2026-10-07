import { stepPortrait, type Character, type ContextItem, type Params, type Portrait } from '@svall/protocol';
import { AgentProfilePick } from './AgentProfilePick.js';
import { app, deps } from './boot.js';
import { saveCharacter, saveCharacterContext, setStar } from './actions.js';
import { copyText, openFolder } from './bridge.js';
import { AddLink, ContextPills } from './ContextList.js';
import { FollowLine, FollowTextarea } from './Field.js';
import { useApp, useTick } from './hooks.js';
import { Info } from './Info.js';
import { keyTip } from './keys.js';
import { ago, hintText } from './map/tokenText.js';
import { portraitTint, portraitUrl } from './portraits.js';
import { usePromptHistory } from './promptHistory.js';
import { DocsList } from './resources/DocsList.js';
import { ResourcesButton } from './ResourcesButton.js';
import { Section } from './Section.js';
import { contextPctOf, islandsSorted, isUnread, resumeErrorOf, statusOf } from './selectors.js';
import { StarIcon } from './Sidebar.js';

type Patch = Omit<Params<'char.update'>, 'id'>;

// collapsing is sticky: the card stays shut until the user opens it again.
export function Collapse() {
  const bindings = useApp((s) => s.settings.bindings);
  return (
    <button className="side-collapse" data-testid="side-collapse" title={keyTip('Hide the side card', 'toggleSideCard', bindings)}
      aria-label="Hide the side card" onClick={() => app.store.getState().toggleSideCard(false)}>›</button>
  );
}

function LastCommand({ id, agent }: { id: string; agent: Character['agent'] }) {
  const { list, at, step } = usePromptHistory(app.api, id, agent);
  if (!agent) return null;
  return (
    <Section name="character.command" title="Last command" testid="side-prompt" head={list.length > 0 && (
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

function PortraitPicker({ id, portrait }: { id: string; portrait: Portrait }) {
  const step = (by: 1 | -1) => saveCharacter(deps(), id, { portrait: stepPortrait(portrait, by) });
  return (
    <div className="side-portrait" data-testid="side-portrait" data-portrait={portrait}>
      <button className="pnav" data-testid="portrait-prev" aria-label="Previous animal" onClick={() => step(-1)}>‹</button>
      <span className="pdisc" data-tint={portraitTint(portrait)}><img className="portrait-img" src={portraitUrl(portrait)} alt={portrait} draggable={false} /></span>
      <button className="pnav" data-testid="portrait-next" aria-label="Next animal" onClick={() => step(1)}>›</button>
    </div>
  );
}

export function SideCard({ id }: { id: string }) {
  const c = useApp((s) => s.fleet.characters[id]);
  const fleet = useApp((s) => s.fleet);
  const onBoard = useApp((s) => s.view === 'board');
  const hover = useApp((s) => s.dropHover?.kind === 'char' && s.dropHover.id === id);
  // last activity counts on while a busy agent sends nothing
  useTick(10_000);
  const handover = useApp((s) => !!s.shell?.handoverEnabled);
  const failed = useApp((s) => resumeErrorOf(s, s.fleet.characters[id]));
  if (!c) return null;

  const status = statusOf(c);
  const accent = `var(--${status})`;
  const pct = contextPctOf(c);
  const starred = c.star !== undefined;
  const save = (patch: Patch) => saveCharacter(deps(), id, patch);
  const saveContext = (context: ContextItem[]) => saveCharacterContext(deps(), id, context);

  return (
    <aside className="side" data-testid="side-card" data-drop={`char:${id}`} data-drop-hover={hover}>
      <div className="kicker" style={{ color: accent }}>
        <i className="sdot" data-status={status} />{status}{isUnread(c) ? ' · unread' : ''}
      </div>
      <div className="side-head">
        <PortraitPicker id={id} portrait={c.portrait} />
        <FollowLine className="h2" aria-label="Name" key={`name-${id}`} value={c.name} data-testid="side-name"
          onSave={(v) => { const name = v.trim(); if (!name || name === c.name) return false; save({ name }); }} />
        <button className="side-star" data-testid="side-star" aria-pressed={starred} title={starred ? 'Unstar' : 'Star'}
          aria-label="Star" onClick={() => setStar(deps(), id, !starred)}><StarIcon on={starred} /></button>
      </div>
      {c.repo && (
        <div className="side-branch" data-testid="side-branch">
          <span className="mono">{c.repo.branch}</span>{c.repo.isWorktree && <span className="badge">wt</span>}
        </div>
      )}
      {c.hint && <div className="side-hint" data-testid="side-hint">{hintText(c)}</div>}
      <div className="side-secs">
        <Section name="character.note" title="Note" head={<Info id="char-note">Sent to the agent when it starts; your change mid-session reaches it with your next prompt. The scribe fills it in until you write one.</Info>}>
          <FollowTextarea className="fld desc" rows={6} placeholder="What this character is doing" key={`note-${id}`} value={c.note} data-testid="side-note"
            onSave={(v) => { if (v !== c.note) save({ note: v }); }} />
        </Section>
        <Section name="character.instructions" title="Agent instructions" head={<Info id="char-instructions">Sent to the agent when it starts; your change mid-session reaches it with your next prompt. A new profile is sent whole.</Info>}>
          <AgentProfilePick id={id} />
          <FollowTextarea className="fld desc" rows={3} placeholder="Anything else this agent should know" key={`instructions-${id}`} value={c.instructions} data-testid="side-instructions"
            onSave={(v) => { if (v !== c.instructions) save({ instructions: v }); }} />
        </Section>
        <Section name="character.context" title="Context" head={<Info id="char-context">Listed for the agent when it starts, pinned items to read first; your change mid-session reaches it with your next prompt.</Info>}>
          <ContextPills items={c.context} ids={{ list: 'side-context', remove: 'context-remove', pin: 'context-pin' }}
            charId={id} onChange={saveContext} />
          <AddLink id={id} ids={{ ref: 'context-ref', add: 'context-add' }} onAdd={(item) => saveContext([...c.context, item])} />
        </Section>
        <DocsList tier="character" id={id} />
        <LastCommand key={id} id={id} agent={c.agent} />
        <Section name="character.details" title="Details">
          <div className="rows">
            <div className="row"><span>island</span>
              <b><select className="fld inline" aria-label="Island" value={c.islandId} data-testid="side-island" onChange={(e) => save({ islandId: e.target.value })}>
                {islandsSorted(fleet).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select></b>
            </div>
            <div className="row"><span>model</span><b className="mono">{c.agent?.model ?? 'no agent'}</b></div>
            <div className="row"><span>cwd</span><b className="mono">
              <button className="copy clip-head" title={`Copy ${c.cwd}`} data-testid="side-cwd"
                onClick={() => { copyText(app.bridge, c.cwd); app.store.getState().showToast('Copied', 'ok'); }}><bdi>{c.cwd}</bdi></button>
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
            {failed && <div className="row" data-testid="side-resume-error"><span>resume failed</span><b>{failed}</b></div>}
            {handover && (
              <label className="row" title="A handover of this fleet waits until this is off">
                <span>keep on this machine</span>
                <b><input type="checkbox" data-testid="side-keep-here" checked={!!c.keepHere} onChange={(e) => save({ keepHere: e.target.checked })} /></b>
              </label>
            )}
          </div>
        </Section>
      </div>
      <div className="opens">
        <button className="btn" data-testid="side-finder" title={`Reveal ${c.cwd} in Finder`}
          onClick={() => openFolder(app.bridge, c.cwd)}>Finder</button>
        <ResourcesButton root={c.repo?.mainRoot ?? c.cwd} testid="side-resources" />
      </div>
      <div className="acts">
        {!onBoard && <button className="btn pri" data-testid="side-open" onClick={() => app.store.getState().focus(id)}>Open terminal</button>}
        <button className="btn dan" data-testid="side-close" title="Deletes the character and kills its terminal"
          onClick={() => app.store.getState().setClosingCharacter(id)}>Delete character</button>
      </div>
    </aside>
  );
}
