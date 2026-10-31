import { useEffect } from 'react';
import { app, deps } from '../boot.js';
import { useApp } from '../hooks.js';
import { Close, Plus } from '../icons.js';
import { Section } from '../Section.js';
import { chooseResource } from './choose.js';
import { deleteDoc } from './docs.js';
import { loadResources } from './load.js';
import { docsOf } from './model.js';

/** An island's or a robot's docs as its agent is told of them; the shelf is where one is written. */
export function DocsList({ tier, id }: { tier: 'island' | 'robot'; id: string }) {
  const sources = useApp((s) => s.resources);
  // nothing watches the docs tree, so the card reads it again each time it opens
  useEffect(() => { void loadResources(deps()); }, [tier, id]);
  const { source, items } = docsOf(sources, tier, id);
  if (!source) return null;
  const open = (naming: boolean) => app.store.getState().toggleResources(true, { where: source.rootId, what: 'docs', naming });
  return (
    <Section name={`${tier}.docs`} title="Docs" testid="side-docs"
      head={<button className="side-docs-new res-open" data-testid="side-docs-new" data-tip="Write a doc in the shelf" onClick={() => open(true)}><Plus size="xs" />new doc</button>}>
      {items.map((i) => {
        const o = i.open;
        return (
          <div key={i.id} className="side-doc-row">
            <button className="side-doc res-open" data-testid={`side-doc-${i.name}`} data-tip={i.reveal}
              onClick={() => { open(false); void chooseResource(deps(), i); }}>
              <b>{i.name}</b>{(i.error ?? i.detail) && <span data-error={Boolean(i.error)}>{i.error ?? i.detail}</span>}
            </button>
            {o && (
              <button className="ib xs filled side-doc-del res-open" data-testid={`side-doc-delete-${i.name}`} aria-label={`Delete ${i.name}`} data-tip={`Delete ${o.path}`}
                onClick={() => { void deleteDoc(deps(), o.rootId, o.path); }}><Close size="xs" /></button>
            )}
          </div>
        );
      })}
    </Section>
  );
}
