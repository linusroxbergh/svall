import { useEffect, useRef, useState, type JSX } from 'react';
import { bodyOf, type ResourceItem } from '@svall/protocol';
import { useApp } from '../hooks.js';
import { loadResources } from '../resources/load.js';
import { docsOf } from '../resources/model.js';
import { phone } from './boot.js';
import { Sheet } from './Sheet.js';

/** The docs of an island or a character, to read: the phone writes none. */
export function DocsList({ tier, id }: { tier: 'island' | 'character'; id: string }): JSX.Element | null {
  const sources = useApp((s) => s.resources);
  const [reading, setReading] = useState<{ item: ResourceItem; text?: string; error?: string }>();
  const asked = useRef(0);
  useEffect(() => { void loadResources({ api: phone.api(), store: phone.store }); }, [tier, id]);
  const { items } = docsOf(sources, tier, id);
  if (!items.length) return null;
  const read = (item: ResourceItem) => {
    setReading({ item });
    if (!item.open) return;
    // a read the reader has moved on from lands in nobody's sheet
    const mine = ++asked.current;
    const show = (r: { text?: string; error?: string }) => { if (asked.current === mine) setReading({ item, ...r }); };
    phone.api().call('fs.read', { id: item.open.rootId, path: item.open.path })
      .then((r) => show({ text: r.text }), (e: Error) => show({ error: e.message }));
  };
  return (
    <div className="m-docs">
      <h4>Docs</h4>
      {items.map((i) => (
        <button key={i.id} type="button" className="m-doc" onClick={() => read(i)}>
          <b>{i.name}</b>{(i.error ?? i.detail) && <span>{i.error ?? i.detail}</span>}
        </button>
      ))}
      {reading && (
        <Sheet title={reading.item.name} onClose={() => { asked.current += 1; setReading(undefined); }}>
          {reading.error ? <p className="sheet-error">{reading.error}</p> : <pre className="m-doc-text">{bodyOf(reading.text ?? '')}</pre>}
        </Sheet>
      )}
    </div>
  );
}
