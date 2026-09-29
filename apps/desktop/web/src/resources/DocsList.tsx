import { useEffect } from 'react';
import { app, deps } from '../boot.js';
import { useApp } from '../hooks.js';
import { chooseResource } from './choose.js';
import { deleteDoc } from './docs.js';
import { loadResources } from './load.js';
import { docsOf } from './model.js';

/** An island's or a character's docs as the agent is told of them: name and description. The shelf is where one is written. */
export function DocsList({ tier, id }: { tier: 'island' | 'character'; id: string }) {
  const sources = useApp((s) => s.resources);
  // nothing watches the docs tree, so the card reads it again each time it opens
  useEffect(() => { void loadResources(deps()); }, [tier, id]);
  const { source, items } = docsOf(sources, tier, id);
  if (!source) return null;
  const open = (naming: boolean) => app.store.getState().toggleResources(true, { where: source.rootId, what: 'docs', naming });
  return (
    <div className="sec side-docs" data-testid="side-docs">
      <div className="kicker">Docs<button className="side-docs-new res-open" data-testid="side-docs-new" title="Write a doc in the shelf" onClick={() => open(true)}>+ new doc</button></div>
      {items.map((i) => {
        const o = i.open;
        return (
          <div key={i.id} className="side-doc-row">
            <button className="side-doc res-open" data-testid={`side-doc-${i.name}`} title={i.reveal}
              onClick={() => { open(false); void chooseResource(deps(), i); }}>
              <b>{i.name}</b>{(i.error ?? i.detail) && <span data-error={Boolean(i.error)}>{i.error ?? i.detail}</span>}
            </button>
            {o && (
              <button className="side-doc-del res-open" data-testid={`side-doc-delete-${i.name}`} aria-label={`Delete ${i.name}`} title={`Delete ${o.path}`}
                onClick={() => { void deleteDoc(deps(), o.rootId, o.path); }}>×</button>
            )}
          </div>
        );
      })}
    </div>
  );
}
