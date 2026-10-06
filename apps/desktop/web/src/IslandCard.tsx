import type { Character, ContextItem, Params } from '@svall/protocol';
import { newCharacterOn, saveIsland, saveIslandContext } from './actions.js';
import { app, deps } from './boot.js';
import { AddLink, ContextPills } from './ContextList.js';
import { FollowLine, FollowTextarea } from './Field.js';
import { useApp } from './hooks.js';
import { DocsList } from './resources/DocsList.js';
import { ResourcesButton } from './ResourcesButton.js';
import { Section } from './Section.js';
import { charactersOf } from './selectors.js';

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
      <div className="side-secs">
        <Section name="island.description" title="Description">
          <FollowTextarea className="fld desc" rows={6} placeholder="What this island is for" key={`description-${id}`} value={i.description} data-testid="side-island-description"
            onSave={(v) => { if (v !== i.description) save({ description: v }); }} />
        </Section>
        <Section name="island.instructions" title="Instructions">
          <FollowTextarea className="fld desc" rows={3} placeholder="How agents on this island should work" key={`instructions-${id}`} value={i.instructions} data-testid="side-island-instructions"
            onSave={(v) => { if (v !== i.instructions) save({ instructions: v }); }} />
        </Section>
        <Section name="island.context" title="Context">
          <ContextPills items={i.context} ids={{ list: 'side-island-context', remove: 'island-context-remove', pin: 'island-context-pin' }}
            charId={chars[0]?.id} onChange={saveContext} />
          <AddLink id={id} ids={{ ref: 'island-context-ref', add: 'island-context-add' }} onAdd={(item) => saveContext([...i.context, item])} />
        </Section>
        <DocsList tier="island" id={id} />
      </div>
      <div className="opens"><ResourcesButton root={commonRoot(chars)} testid="side-island-resources" /></div>
      {chars.length === 0 && i.kind !== 'home' && <div className="acts">
        <DeleteIsland id={id} testid="side-island-delete" label="Delete" />
      </div>}
    </aside>
  );
}
