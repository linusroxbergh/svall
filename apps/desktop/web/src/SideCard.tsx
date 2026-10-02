import { useState } from 'react';
import { contextKind, stepPortrait, type Character, type ContextItem, type Params, type Portrait } from '@svall/protocol';
import { AgentProfilePick } from './AgentProfilePick.js';
import { app, deps } from './boot.js';
import { newCharacterOn, saveCharacter, saveCharacterContext, saveIsland, saveIslandContext } from './actions.js';
import { copyText, openFolder } from './bridge.js';
import { followLink } from './LinkAsk.js';
import { FollowLine, FollowTextarea } from './Field.js';
import { useApp, useTick } from './hooks.js';
import { Info } from './Info.js';
import { keyTip } from './keys.js';
import { LinkIcon } from './map/LinkIcon.js';
import { ago, hintText, linkText } from './map/tokenText.js';
import { portraitTint, portraitUrl } from './portraits.js';
import { usePromptHistory } from './promptHistory.js';
import { DocsList } from './resources/DocsList.js';
import { sourceOfRoot } from './resources/model.js';
import { charactersOf, contextPctOf, islandsSorted, isUnread, statusOf } from './selectors.js';

type Patch = Omit<Params<'char.update'>, 'id'>;

// a pinned item is read before the agent starts; the toggle flips that flag
function ContextPills({ items, ids, charId, onChange }: { items: ContextItem[]; ids: { list: string; remove: string; pin: string }; charId?: string; onChange(next: ContextItem[]): void }) {
  const toggle = (i: number) => onChange(items.map((it, j) => (j !== i ? it : it.pinned ? (({ pinned: _p, ...r }) => r)(it) : { ...it, pinned: true })));
  return (
    <div className="pills" data-testid={ids.list}>
      {items.map((it, i) => (
        <span key={`${it.ref}-${i}`} className="lp" data-pinned={Boolean(it.pinned)}>
          <i className="lg"><LinkIcon item={it} /></i>
          <a className="clip-head" href={/^(https?|mailto):/i.test(it.ref) ? it.ref : undefined} title={it.ref}
            onClick={(e) => { e.preventDefault(); followLink(it, charId, { x: e.clientX, y: e.clientY }); }}>{linkText(it)}</a>
          <button data-testid={ids.pin} title={it.pinned ? 'Unpin' : 'Pin: the agent reads it first'} onClick={() => toggle(i)}>{it.pinned ? '●' : '○'}</button>
          {it.source === 'manual' && <button data-testid={ids.remove} onClick={() => onChange(items.filter((_, j) => j !== i))}>×</button>}
        </span>
      ))}
    </div>
  );
}

// keyed by the card's id, so a link half typed for one character or island is never offered to the next
function AddLink({ ids, onAdd }: { ids: { ref: string; add: string }; onAdd(item: ContextItem): void }) {
  const [ref, setRef] = useState('');
  const add = () => {
    if (!ref.trim()) return;
    onAdd({ kind: contextKind(ref), ref: ref.trim(), label: '', source: 'manual' });
    setRef('');
  };
  return (
    <div className="addlink">
      <input className="fld" placeholder="Add a url or path" value={ref} data-testid={ids.ref} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} onChange={(e) => setRef(e.target.value)} />
      <button className="btn sm" data-testid={ids.add} onClick={add}>Add</button>
    </div>
  );
}

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
    <div className="sec cmd" data-testid="side-prompt">
      <div className="kicker cmd-head">
        Last command
        {list.length > 0 && (
          <span className="cmd-nav">
            <button data-testid="side-prompt-prev" aria-label="Earlier command" disabled={at >= list.length - 1} onClick={() => step(1)}>‹</button>
            <b className="tnum" data-testid="side-prompt-pos">{at + 1}/{list.length}</b>
            <button data-testid="side-prompt-next" aria-label="Later command" disabled={at === 0} onClick={() => step(-1)}>›</button>
          </span>
        )}
      </div>
      <p className="cmd-text" data-testid="side-prompt-text">{list[at] ?? 'nothing sent yet'}</p>
    </div>
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

function ResourcesButton({ root, testid }: { root: string | undefined; testid: string }) {
  const sources = useApp((s) => s.resources);
  const source = sourceOfRoot(sources, root);
  return (
    <button className="btn res-open" data-testid={testid} title="Open the resources shelf"
      onClick={() => app.store.getState().toggleResources(true, { where: (source ?? sources[0])?.rootId, what: 'all' })}>Resources</button>
  );
}

export function SideCard({ id }: { id: string }) {
  const c = useApp((s) => s.fleet.characters[id]);
  const fleet = useApp((s) => s.fleet);
  const onBoard = useApp((s) => s.view === 'board');
  const hover = useApp((s) => s.dropHover?.kind === 'char' && s.dropHover.id === id);
  // last activity counts on while a busy agent sends nothing
  useTick(10_000);
  if (!c) return null;

  const status = statusOf(c);
  const accent = `var(--${status})`;
  const pct = contextPctOf(c);
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
      </div>
      {c.repo && (
        <div className="side-branch" data-testid="side-branch">
          <span className="mono">{c.repo.branch}</span>{c.repo.isWorktree && <span className="badge">wt</span>}
        </div>
      )}
      {c.hint && <div className="side-hint" data-testid="side-hint">{hintText(c)}</div>}
      <div className="sec">
        <div className="kicker"><span>Note</span><Info id="char-note">Sent to the agent when it starts; your change mid-session reaches it with your next prompt. The scribe fills it in until you write one.</Info></div>
        <FollowTextarea className="fld desc" rows={4} placeholder="What this character is doing" key={`note-${id}`} value={c.note} data-testid="side-note"
          onSave={(v) => { if (v !== c.note) save({ note: v }); }} />
      </div>
      <div className="sec">
        <div className="kicker"><span>Agent instructions</span><Info id="char-instructions">Sent to the agent when it starts; your change mid-session reaches it with your next prompt. A new profile is sent whole.</Info></div>
        <AgentProfilePick id={id} />
        <FollowTextarea className="fld desc" rows={3} placeholder="Anything else this agent should know" key={`instructions-${id}`} value={c.instructions} data-testid="side-instructions"
          onSave={(v) => { if (v !== c.instructions) save({ instructions: v }); }} />
      </div>
      <div className="sec">
        <div className="kicker"><span>Context</span><Info id="char-context">Listed for the agent when it starts, pinned items to read first; your change mid-session reaches it with your next prompt.</Info></div>
        <ContextPills items={c.context} ids={{ list: 'side-context', remove: 'context-remove', pin: 'context-pin' }}
          charId={id} onChange={saveContext} />
        <AddLink key={id} ids={{ ref: 'context-ref', add: 'context-add' }} onAdd={(item) => saveContext([...c.context, item])} />
      </div>
      <DocsList tier="character" id={id} />
      <LastCommand key={id} id={id} agent={c.agent} />
      <div className="sec">
        <div className="kicker">Details</div>
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
        </div>
        <div className="opens">
          <button className="btn" data-testid="side-finder" title={`Reveal ${c.cwd} in Finder`}
            onClick={() => openFolder(app.bridge, c.cwd)}>Finder</button>
          <ResourcesButton root={c.repo?.mainRoot ?? c.cwd} testid="side-resources" />
        </div>
      </div>
      <div className="acts">
        {!onBoard && <button className="btn pri" data-testid="side-open" onClick={() => app.store.getState().focus(id)}>Open terminal</button>}
        <button className="btn dan" data-testid="side-close" title="Deletes the character and kills its terminal"
          onClick={() => app.store.getState().setClosingCharacter(id)}>Delete character</button>
      </div>
    </aside>
  );
}

export function DeleteIsland({ id, testid, label }: { id: string; testid: string; label: string }) {
  return <button className="btn dan" data-testid={testid} onClick={() => app.store.getState().setDeletingIsland(id)}>{label}</button>;
}

// the repository most of the island's characters stand in
const commonRoot = (chars: Character[]): string | undefined => {
  const n = new Map<string, number>();
  for (const c of chars) { const r = c.repo?.mainRoot ?? c.cwd; n.set(r, (n.get(r) ?? 0) + 1); }
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};

export function IslandCard({ id }: { id: string }) {
  const i = useApp((s) => s.fleet.islands[id]);
  const fleet = useApp((s) => s.fleet);
  const hover = useApp((s) => s.dropHover?.kind === 'island' && s.dropHover.id === id);
  if (!i) return null;
  const chars = charactersOf(fleet, id);
  const save = (patch: Omit<Params<'island.update'>, 'id'>) => saveIsland(deps(), id, patch);
  const saveContext = (context: ContextItem[]) => saveIslandContext(deps(), id, context);
  return (
    <aside className="side" data-testid="side-island-card" data-drop={`island:${id}`} data-drop-hover={hover}>
      <div className="kicker">Island</div>
      <div className="side-island-head">
        <FollowLine className="h2" aria-label="Island name" key={`name-${id}`} value={i.name} data-testid="side-island-name"
          onSave={(v) => { const name = v.trim(); if (!name || name === i.name) return false; save({ name }); }} />
        <button className="btn pri sm" data-testid="side-island-new" onClick={() => newCharacterOn(deps(), id)}>+ New character</button>
      </div>
      <div className="sec">
        <div className="kicker">Description</div>
        <FollowTextarea className="fld desc" rows={4} placeholder="What this island is for" key={`description-${id}`} value={i.description} data-testid="side-island-description"
          onSave={(v) => { if (v !== i.description) save({ description: v }); }} />
      </div>
      <div className="sec">
        <div className="kicker">Instructions</div>
        <FollowTextarea className="fld desc" rows={3} placeholder="How agents on this island should work" key={`instructions-${id}`} value={i.instructions} data-testid="side-island-instructions"
          onSave={(v) => { if (v !== i.instructions) save({ instructions: v }); }} />
      </div>
      <div className="sec">
        <div className="kicker">Context</div>
        <ContextPills items={i.context} ids={{ list: 'side-island-context', remove: 'island-context-remove', pin: 'island-context-pin' }}
          charId={chars[0]?.id} onChange={saveContext} />
        <AddLink key={id} ids={{ ref: 'island-context-ref', add: 'island-context-add' }} onAdd={(item) => saveContext([...i.context, item])} />
      </div>
      <DocsList tier="island" id={id} />
      <div className="opens"><ResourcesButton root={commonRoot(chars)} testid="side-island-resources" /></div>
      {chars.length === 0 && i.kind !== 'home' && <div className="acts">
        <DeleteIsland id={id} testid="side-island-delete" label="Delete" />
      </div>}
    </aside>
  );
}
