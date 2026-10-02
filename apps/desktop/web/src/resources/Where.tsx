import { useMemo, useState } from 'react';
import type { ResourceSource } from '@svall/protocol';
import { app } from '../boot.js';
import { useApp } from '../hooks.js';
import { countsBySource, qualifierOf, tierOf, tierWhere, whereGroups, whereTier, type Tier } from './model.js';

const pick = (where: string) => app.store.getState().setResourcesFilter({ where });

// a tier is a folder: the press picks it, the caret and a double press open and shut it
function TierNode({ tier, count, on, open }: { tier: Tier; count: number; on: boolean; open: boolean }) {
  const t = tierOf(tier);
  const flip = () => app.store.getState().toggleResourceGroup(tier);
  return (
    <button className="res-node" data-testid={`resources-group-${tier}`} aria-pressed={on} aria-expanded={open}
      onClick={() => pick(tierWhere(tier))} onDoubleClick={flip}>
      <i className="res-car" data-testid={`resources-caret-${tier}`} onClick={(e) => { e.stopPropagation(); flip(); }}>{open ? '▾' : '▸'}</i>
      <i className="res-glyph" style={{ color: `var(${t.colour})` }}>{t.glyph}</i>
      <span className="res-node-n">{t.label}</span><span className="n">{count}</span>
    </button>
  );
}

function SourceNode({ s, count, on, qualifier }: { s: ResourceSource; count: number; on: boolean; qualifier: string }) {
  const t = tierOf(s.tier);
  return (
    <button className="res-node" data-testid={`resources-where-${s.rootId}`} aria-pressed={on} title={`${qualifier}\n${s.root}`}
      style={{ '--depth': 1 } as React.CSSProperties} onClick={() => pick(s.rootId)}>
      <i className="res-car" />
      <i className="res-glyph" style={{ color: `var(${t.colour})` }}>{t.glyph}</i>
      <span className="res-node-n">{s.name}</span><span className="n">{count}</span>
    </button>
  );
}

/** The tree: one folder a tier, its sources under it, characters headed by island. */
export function Where() {
  const sources = useApp((s) => s.resources);
  const fleet = useApp((s) => s.fleet);
  const resourcesWhere = useApp((s) => s.resourcesWhere);
  const open = useApp((s) => s.resourceGroups);
  const [query, setQuery] = useState('');
  // the tier or the source picked; the first source stands picked when nothing is, as the list shows it
  const where = resourcesWhere ?? sources[0]?.rootId;
  const tier = whereTier(where);
  const groups = whereGroups(sources, fleet, query);
  // every row shows what its own source holds, card included, read once for the whole tree
  const counts = useMemo(() => countsBySource(sources, fleet), [sources, fleet]);
  return (
    <nav className="res-tree" aria-label="Sources">
      <input className="res-find" data-testid="resources-source-find" placeholder="find a source" aria-label="Find a source" value={query} onChange={(e) => setQuery(e.target.value)} />
      {groups.map((g) => {
        // a query shows what it found without asking for the folder to be opened first
        const shown = open.includes(g.tier) || (query.trim() !== '' && g.count > 0);
        return (
          <section key={g.tier}>
            <TierNode tier={g.tier} count={g.count} on={tier === g.tier} open={shown} />
            {shown && g.sections.map((sec) => (
              <div key={sec.id ?? g.tier}>
                {sec.heading && <div className="res-subh">{sec.heading}</div>}
                {sec.sources.map((s) => <SourceNode key={s.rootId} s={s} count={counts.get(s.rootId) ?? 0} on={s.rootId === where} qualifier={qualifierOf(s, fleet)} />)}
              </div>
            ))}
          </section>
        );
      })}
    </nav>
  );
}
