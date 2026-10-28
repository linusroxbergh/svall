import type { JSX } from 'react';
import type { AgentKind } from '@svall/protocol';
import { keyGroups } from './keys.js';
import { Sheet } from './Sheet.js';

type Props = { kind: AgentKind | undefined; fontSize: number; onKey(seq: string): void; onSize(step: 1 | -1): void; onClose(): void };

/** The keys the row has no room for: the agent's own, the terminal's, and the type size. */
export function KeysSheet({ kind, fontSize, onKey, onSize, onClose }: Props): JSX.Element {
  return (
    <Sheet title="Keys" onClose={onClose}>
      {keyGroups(kind).map((g) => (
        <div key={g.title} className="m-sec">
          <h4>{g.title}</h4>
          {g.keys.map((k) => (
            <button key={k.label} type="button" className="m-key" onClick={() => { onKey(k.seq); onClose(); }}>
              <kbd>{k.label}</kbd>
              <span>{k.hint}</span>
            </button>
          ))}
        </div>
      ))}
      <div className="m-sec">
        <h4>Text</h4>
        <div className="m-rows">
          <div>
            <span>size</span>
            <span className="m-nav">
              <button type="button" aria-label="Smaller text" onClick={() => onSize(-1)}>−</button>
              <b>{fontSize}</b>
              <button type="button" aria-label="Larger text" onClick={() => onSize(1)}>+</button>
            </span>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
