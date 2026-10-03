import { useEffect, useState } from 'react';
import { contextKind, type ContextItem } from '@svall/protocol';
import { followLink } from './LinkAsk.js';
import { LinkIcon } from './map/LinkIcon.js';
import { linkText } from './map/tokenText.js';

// a pinned item is read before the agent starts; the toggle flips that flag
export function ContextPills({ items, ids, charId, onChange }: { items: ContextItem[]; ids: { list: string; remove: string; pin: string }; charId?: string; onChange(next: ContextItem[]): void }) {
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

export function AddLink({ id, ids, onAdd }: { id: string; ids: { ref: string; add: string }; onAdd(item: ContextItem): void }) {
  const [ref, setRef] = useState('');
  // the card stays mounted as the selection moves, so a half typed link would be offered to the next character or island
  useEffect(() => setRef(''), [id]);
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
