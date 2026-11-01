import { useEffect, useRef, useState } from 'react';
import { app, deps } from './boot.js';
import { AS_TYPED } from './Field.js';
import { useApp } from './hooks.js';
import { dispatchKey, openFleetPicker, type KeyDeps } from './keyboard.js';
import { ACTIONS, actionIds, keyLabel, type Bindings } from './keys.js';

type Command = { label: string; key?: string; run: () => void };

// the browser comes up with the socket, and only the first-link command needs it
const keyDeps = (): KeyDeps => { const d = deps(); try { return { ...d, browser: app.browser() }; } catch { return d; } };

// every action the keys reach, then the menu's commands that have none; Quit stays with the shell
const commandsOf = (b: Bindings): Command[] => [
  ...actionIds().filter((id) => id !== 'palette' && id !== 'quit').map((id) => ({
    label: ACTIONS[id].label,
    key: keyLabel(id, b),
    run: () => void dispatchKey(ACTIONS[id].action, keyDeps()).catch((e: Error) => app.store.getState().showToast(e.message)),
  })),
  { label: 'New fleet', run: () => openFleetPicker(app.store, 'new') },
  { label: 'Keyboard shortcuts', run: () => app.store.getState().toggleSettings(true, 'keyboard') },
  { label: 'Send feedback', run: () => app.store.getState().toggleFeedback(true) },
];

// each word typed has to be in the label, in any order
const matching = (list: Command[], query: string): Command[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((c) => words.every((w) => c.label.toLowerCase().includes(w)));
};

export function CommandPalette() {
  const open = useApp((s) => s.palette);
  // each opening starts with an empty field
  return open ? <Palette /> : null;
}

function Palette() {
  const bindings = useApp((s) => s.settings.bindings);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = matching(commandsOf(bindings), query);
  const rows = useRef<HTMLDivElement>(null);
  useEffect(() => { rows.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const close = () => app.store.getState().setPalette(false);
  // the palette is gone before the command runs, so a dialog the command opens is the only one up
  const run = (c?: Command) => { if (!c) return; close(); c.run(); };
  const move = (step: number) => setActive((a) => (list.length ? (a + step + list.length) % list.length : 0));

  return (
    <div className="modal-back palette-back" data-testid="palette" onPointerDown={close}>
      <div className="modal dialog palette" onPointerDown={(e) => e.stopPropagation()}>
        <input className="fld" placeholder="Type a command" aria-label="Command" autoFocus value={query} data-testid="palette-query" {...AS_TYPED}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            const act = { ArrowDown: () => move(1), ArrowUp: () => move(-1), Enter: () => run(list[active]), Escape: close }[e.key];
            if (!act) return;
            // the page's own Enter and Escape would open or close what lies under the palette
            e.preventDefault();
            e.stopPropagation();
            act();
          }} />
        <div className="palette-rows" ref={rows} role="listbox" aria-label="Commands">
          {list.map((c, i) => (
            <button key={c.label} className="palette-row menu-item wide" role="option" aria-selected={i === active} data-active={i === active} data-testid="palette-row"
              tabIndex={-1} onMouseMove={() => setActive(i)} onClick={() => run(c)}>
              <span className="palette-label">{c.label}</span>
              {c.key && <kbd className="palette-key">{c.key}</kbd>}
            </button>
          ))}
          {list.length === 0 && <div className="modal-note" data-testid="palette-none">No command matches.</div>}
        </div>
      </div>
    </div>
  );
}
