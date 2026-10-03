import { deletable, type ResourceItem } from '@svall/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { app, deps } from '../boot.js';
import { useApp } from '../hooks.js';
import { openFile } from '../ide/files.js';
import { Tree } from '../ide/Tree.js';
import { followLink } from '../LinkAsk.js';
import { LinkIcon } from '../map/LinkIcon.js';
import { createDoc, deleteDoc, deleteResource, renameDoc } from './docs.js';
import { chooseResource } from './choose.js';
import { badgeOf, countsBySource, isCard, isField, kindLabel, kindOf, kindRows, qualifierOf, shelfSource, shortPath, tierOf, visible, whereGroups, whereTier, type CardItem, type Item, type Kind, type Source, type Tier, type What } from './model.js';

const NONE: string[] = [];

// commits on Enter, gives up on Escape or when focus leaves; the shelf keeps the Escape to itself
function NameField({ testid, initial, onCommit, onDone }: { testid: string; initial: string; onCommit(v: string): void; onDone(): void }) {
  const [v, setV] = useState(initial);
  return (
    <input className="res-find res-name" data-testid={testid} autoFocus placeholder="name" aria-label="Doc name" value={v}
      onChange={(e) => setV(e.target.value)} onBlur={onDone}
      onKeyDown={(e) => { if (e.key === 'Enter') { onCommit(v); onDone(); } if (e.key === 'Escape') { e.stopPropagation(); onDone(); } }} />
  );
}

// stays until Enter makes the doc or Escape gives up, and a refused name keeps its text; it focuses in an
// effect so it takes the keys after the shelf has taken them on opening
function NewDocField({ label, onCommit, onDone }: { label: string; onCommit(v: string): Promise<boolean>; onDone(): void }) {
  const [v, setV] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.scrollIntoView({ block: 'nearest' }); }, []);
  return (
    <label className="res-newdoc">
      <span>{label}</span>
      <input ref={input} data-testid="resources-new-doc-name" placeholder="name, then Enter" value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void onCommit(v).then((made) => { if (made) onDone(); });
          if (e.key === 'Escape') { e.stopPropagation(); onDone(); }
        }} />
    </label>
  );
}

const useChosen = (id: string) => useApp((s) => s.resourcesChosen === id);

// only memory rows differ from their kind in whether they ride in the prompt, so only they say so
const rowBadge = (kind: Kind, item: Pick<Item, 'name'>) => (kind === 'autoMemory' ? badgeOf(kind, item) : undefined);

// a field opens in the pane where a file would; a link is followed the way the side card follows it
function CardRow({ kind, item }: { kind: Kind; item: CardItem }) {
  const chosen = useChosen(item.id);
  const link = isField(item.card) ? undefined : item.card;
  return (
    <div className="res-row">
      <button className="res-item" data-testid={`resources-item-${kind}-${item.name}`} data-active={chosen} data-opens={opensItself(item)}
        title={link ? link.link.ref : `Edit the ${item.name.toLowerCase()}`}
        onClick={(e) => { if (link) followLink(link.link, link.charId, { x: e.clientX, y: e.clientY }); else void chooseResource(deps(), item); }}>
        <b>
          {link && <i className="lg"><LinkIcon item={link.link} /></i>}{item.name}
          {link?.link.pinned && <em>pinned</em>}
        </b>
        {item.detail && <span>{item.detail}</span>}
      </button>
    </div>
  );
}

function FileRow({ kind, item }: { kind: Kind; item: ResourceItem }) {
  const o = item.open;
  const dirty = useApp((s) => (o ? s.ide[o.rootId]?.dirty ?? NONE : NONE));
  const chosen = useChosen(item.id);
  const [renaming, setRenaming] = useState(false);
  const unsaved = o !== undefined && dirty.some((p) => p === o.path || (o.folder !== undefined && p.startsWith(`${o.folder}/`)));
  const badge = rowBadge(kind, item);
  const isDoc = (kind === 'docs' || kind === 'agentProfiles') && o !== undefined;
  return (
    <>
      <div className="res-row" data-doc={isDoc}>
        <button className="res-item" data-testid={`resources-item-${kind}-${item.name}`} data-active={chosen} data-dirty={unsaved} data-off={item.off ?? false} data-opens={opensItself(item)}
          title={o ? item.reveal : `${item.reveal} (opens in Finder)`} onClick={() => { void chooseResource(deps(), item); }}>
          <b>
            {item.name}{unsaved && <i className="res-unsaved" aria-label="unsaved" />}{item.off && <em>off</em>}{!o && <em>Finder</em>}
            {item.tag && <em className="res-tag" data-testid={`resources-tag-${kind}-${item.name}`}>{item.tag}</em>}
            {badge && <em className="res-bdg" data-kind={badge} data-testid={`resources-badge-${kind}-${item.name}`}>{badge}</em>}
          </b>
          {(item.error ?? item.detail) && <span data-error={Boolean(item.error)}>{item.error ?? item.detail}</span>}
        </button>
        {isDoc && renaming && <NameField testid="resources-doc-rename-name" initial={item.name} onDone={() => setRenaming(false)} onCommit={(v) => { void renameDoc(deps(), o.rootId, o.path, v); }} />}
        {isDoc && !renaming && (
          <span className="res-doc-acts">
            <button data-testid={`resources-doc-rename-${item.name}`} title={`Rename ${o.path}`} aria-label={`Rename ${item.name}`} onClick={() => setRenaming(true)}>✎</button>
            <button data-testid={`resources-doc-delete-${item.name}`} title={`Delete ${o.path}`} aria-label={`Delete ${item.name}`} onClick={() => { void deleteDoc(deps(), o.rootId, o.path); }}>×</button>
          </span>
        )}
        {o && deletable(kind, item) && (
          <span className="res-doc-acts">
            <button data-testid={`resources-delete-${kind}-${item.name}`} title={`Delete ${shortPath(item.reveal)}`} aria-label={`Delete ${item.name}`} onClick={() => { void deleteResource(deps(), item.name, o); }}>×</button>
          </span>
        )}
      </div>
      {chosen && o?.folder && (
        <div className="res-files"><Tree id={o.rootId} dir={o.folder} depth={0} tick={0} onOpen={(p) => { void openFile(deps(), o.rootId, p); }} /></div>
      )}
    </>
  );
}

// a link is followed, never shown, so the pane only opens by itself for what it can hold
const opensItself = (i: Item): boolean => (isCard(i) ? isField(i.card) : i.open !== undefined);

/** The kinds a source holds, as chips that narrow the list. The chosen one stays even when this source has
 *  none of it, and Docs and Agent profiles stay wherever one can be written, since that is where a new one is made. */
function Kinds({ source, what }: { source: Source; what: What }) {
  const offered = (w: { what: What; zero: boolean }) => w.what === 'all' || !w.zero || w.what === what
    || (w.what === 'docs' && source.docs !== undefined) || (w.what === 'agentProfiles' && source.agentProfiles !== undefined);
  return (
    <div className="res-kinds" role="group" aria-label="Kind">
      {kindRows(source).filter(offered).map((w) => (
        <button key={w.what} className="res-chip" data-testid={`resources-what-${w.what}`} aria-pressed={w.what === what} data-none={w.zero}
          onClick={() => app.store.getState().setResourcesFilter({ what: w.what })}>
          {w.colour && <i className="res-dot" style={{ background: `var(${w.colour})` }} />}{w.label}<span className="n">{w.n}</span>
        </button>
      ))}
    </div>
  );
}

/** A tier picked in the tree lists its sources, as opening a folder does; a press on one stands the shelf on it. */
function TierRows({ tier, query }: { tier: Tier; query: string }) {
  const sources = useApp((s) => s.resources);
  const fleet = useApp((s) => s.fleet);
  const group = whereGroups(sources, fleet, query).find((g) => g.tier === tier);
  const counts = useMemo(() => countsBySource(sources, fleet), [sources, fleet]);
  const t = tierOf(tier);
  if (!group || group.count === 0) return <div className="res-none">Nothing here.</div>;
  return group.sections.map((sec) => (
    <section key={sec.id ?? tier}>
      {sec.heading && <h4>{sec.heading}</h4>}
      {sec.sources.map((s) => (
        <button key={s.rootId} className="res-item" data-testid={`resources-list-source-${s.rootId}`} data-opens="false" title={s.root}
          onClick={() => app.store.getState().setResourcesFilter({ where: s.rootId })}>
          <b><i className="res-glyph" style={{ color: `var(${t.colour})` }}>{t.glyph}</i>{s.name}<em className="res-tag">{counts.get(s.rootId) ?? 0}</em></b>
          <span>{qualifierOf(s, fleet)}</span>
        </button>
      ))}
    </section>
  ));
}

export function List() {
  const sources = useApp((s) => s.resources);
  const fleet = useApp((s) => s.fleet);
  const resourcesWhere = useApp((s) => s.resourcesWhere);
  const what = useApp((s) => s.resourcesWhat);
  const [query, setQuery] = useState('');
  const [naming, setNaming] = useState(false);
  const asked = useApp((s) => s.resourcesNaming);
  useEffect(() => { if (asked) { setNaming(true); app.store.getState().setResourcesNaming(false); } }, [asked]);
  const tier = whereTier(resourcesWhere);
  const source = shelfSource({ resources: sources, resourcesWhere, fleet });
  const groups = visible(source, what, query);
  // a new agent profile is made where the list shows them; a new doc wherever else docs show
  const profile = what === 'agentProfiles';
  const addTo = profile ? source?.agentProfiles : what === 'all' || what === 'docs' ? source?.docs : undefined;
  const noun = profile ? 'profile' : 'doc';
  // a filter that leaves one file needs no choosing — CLAUDE.md is the usual one — so the pane shows it
  const only = groups.length === 1 && groups[0].items.length === 1 ? groups[0].items[0] : undefined;
  useEffect(() => { if (only && opensItself(only)) void chooseResource(deps(), only); }, [source?.rootId, what, only?.id]);
  return (
    <div className="res-list" data-testid="resources-list">
      <input className="res-find" data-testid="resources-filter" placeholder="filter" aria-label="Filter resources" value={query} onChange={(e) => setQuery(e.target.value)} />
      {source && <Kinds source={source} what={what} />}
      <div className="res-rows">
        {tier ? <TierRows tier={tier} query={query} /> : (
          <>
            {addTo && naming && <NewDocField label={`New ${noun}`} onDone={() => setNaming(false)} onCommit={(v) => createDoc(deps(), addTo, v)} />}
            {groups.length === 0 && <div className="res-none">Nothing here.</div>}
            {groups.map((g) => {
              const badge = g.kind === 'autoMemory' ? undefined : badgeOf(g.kind, { name: '' });
              return (
                <section key={g.kind}>
                  <h4>
                    <i className="res-dot" style={{ background: `var(${kindOf(g.kind).colour})` }} />{kindLabel(g.kind, source?.tier)}
                    {badge && <em className="res-bdg" data-kind={badge} data-testid={`resources-kind-badge-${g.kind}`}>{badge}</em>}
                    <span className="n">{g.items.length}</span>
                  </h4>
                  {g.items.map((i) => (isCard(i) ? <CardRow key={i.id} kind={g.kind} item={i} /> : <FileRow key={i.id} kind={g.kind} item={i} />))}
                </section>
              );
            })}
            {addTo && !naming && <button className="res-new" data-testid="resources-new-doc" onClick={() => setNaming(true)}>+ new {noun}</button>}
          </>
        )}
      </div>
    </div>
  );
}
