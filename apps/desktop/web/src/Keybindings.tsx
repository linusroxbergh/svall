import { useEffect, useRef, useState } from 'react';
import { app } from './boot.js';
import { useApp } from './hooks.js';
import { ACTIONS, actionIds, chordFor, chordLabel, chordOf, chordsOf, holderOf, resolve, type ActionId, type Bindings, type Chord } from './keys.js';

// a chord the user picked that something else already answers, held until they say to take it
type Ask = { id: ActionId; chord: Chord; from?: ActionId; ghostty?: string };

const write = (bindings: Bindings) => app.store.getState().setSettings({ bindings });

export function Keybindings() {
  const open = useApp((s) => s.keysOpen);
  const bindings = useApp((s) => s.settings.bindings);
  const theirs = useApp((s) => s.shell?.ghosttyKeys) ?? {};
  const capturing = useApp((s) => s.capturingKey);
  const [ask, setAsk] = useState<Ask>();
  const shut = useRef<HTMLButtonElement>(null);
  const back = useRef<HTMLDivElement>(null);

  const listen = (id?: ActionId) => { setAsk(undefined); app.store.getState().setCapturingKey(id); };
  // read through the store rather than this render's copy: a key can arrive between renders
  const put = (id: ActionId, chord: Chord | null, from?: ActionId) => {
    const b = app.store.getState().settings.bindings;
    const next: Bindings = { ...b, [id]: chord };
    // an action that only carried this chord as a layout alias keeps the one it answers to by name
    if (from && chordFor(from, b) === chord) next[from] = null;
    write(next);
    setAsk(undefined);
  };
  const reset = (id: ActionId) => { const next = { ...app.store.getState().settings.bindings }; delete next[id]; write(next); };
  // a chord anything else answers is asked about first, whether it was pressed or claimed back from Ghostty
  const claim = (id: ActionId, chord: Chord, ghostty?: string) => {
    const from = holderOf(chord, app.store.getState().settings.bindings);
    if (from || ghostty) setAsk({ id, chord, from, ghostty }); else put(id, chord);
  };

  useEffect(() => {
    if (!open) { setAsk(undefined); return; }
    shut.current?.focus();
    // the card and the map both read Escape, so this one is taken before they see it
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const from = e.target as Element | null;
      // a dialog standing over this one answers its own Escape
      if (from?.closest?.('.modal-back') && !back.current?.contains(from)) return;
      e.stopPropagation();
      const s = app.store.getState();
      // the row waiting for a key is answered first, the dialog after it
      if (s.capturingKey) s.setCapturingKey(undefined); else s.toggleKeys(false);
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open]);

  useEffect(() => {
    if (!capturing) return;
    const take = (chord: Chord) => {
      const s = app.store.getState();
      const b = s.settings.bindings;
      s.setCapturingKey(undefined);
      if (chordFor(capturing, b) === chord) return;
      claim(capturing, chord, s.shell?.ghosttyKeys?.[chord]);
    };
    // the shell hands over every Cmd chord while this is up, including the ones it normally swallows
    if (app.bridge.present) {
      app.bridge.send({ type: 'keys.capture', on: true });
      const off = app.bridge.onMessage((m) => { if (m.type === 'key') take(m.chord); });
      return () => { off(); app.bridge.send({ type: 'keys.capture', on: false }); };
    }
    const onKey = (e: KeyboardEvent) => {
      const chord = chordOf(e);
      if (!chord) return;
      // the key is spent on the row: the handler that would obey it must not see it at all
      e.preventDefault();
      e.stopImmediatePropagation();
      take(chord);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing]);

  if (!open) return null;
  const close = () => app.store.getState().toggleKeys(false);
  const bound = resolve(bindings);
  return (
    <div ref={back} className="modal-back" data-testid="keys-modal" onPointerDown={close}>
      <div className="modal panel keys" onPointerDown={(e) => e.stopPropagation()}
        role="dialog" aria-label="Keyboard shortcuts">
        <div className="kicker">
          Keyboard shortcuts
          <span className="spacer" />
          <button ref={shut} className="side-x" data-testid="keys-close" title="Close" aria-label="Close the shortcuts"
            onClick={close}>×</button>
        </div>
        <div className="rows">
          {actionIds().map((id) => {
            const chord = chordFor(id, bindings);
            const shipped = ACTIONS[id].chord;
            // declined on this machine's first launch, or cleared by hand, while the user's own Ghostty answers it
            const held = chord === null ? chordsOf(id).map((c) => theirs[c]).find(Boolean) : undefined;
            return (
              <div key={id}>
                <div className="row">
                  <span>{ACTIONS[id].label}</span>
                  <b className="set-keys">
                    <button className="key-chord" data-testid={`key-${id}`} data-listening={capturing === id}
                      aria-label={capturing === id ? `Press a key for ${ACTIONS[id].label}` : `Change the key for ${ACTIONS[id].label}, now ${chordLabel(chord)}`}
                      onClick={() => listen(capturing === id ? undefined : id)}>
                      {capturing === id ? 'press a key' : chordLabel(chord)}
                    </button>
                    {chord && <button className="key-x" data-testid={`key-clear-${id}`} title="No key" aria-label={`Unbind ${ACTIONS[id].label}`}
                      onClick={() => put(id, null)}>×</button>}
                    {id in bindings && <button className="key-x" data-testid={`key-reset-${id}`} title={`Back to ${chordLabel(shipped)}`}
                      aria-label={`Reset ${ACTIONS[id].label}`} onClick={() => reset(id)}>↺</button>}
                  </b>
                </div>
                {ask?.id === id && (
                  <div className="row key-ask" role="alert" data-testid={`key-ask-${id}`}>
                    <span>{chordLabel(ask.chord)} {ask.from ? `is taken by ${ACTIONS[ask.from].label}` : `is taken by your Ghostty config (${ask.ghostty})`}</span>
                    <b className="set-keys">
                      <button className="btn" data-testid={`key-take-${id}`} onClick={() => put(id, ask.chord, ask.from)}>Override</button>
                      <button className="btn" onClick={() => setAsk(undefined)}>Cancel</button>
                    </b>
                  </div>
                )}
                {held && ask?.id !== id && (
                  <div className="row key-ask" role="alert" data-testid={`key-held-${id}`}>
                    <span>{chordLabel(shipped)} is taken by your Ghostty config ({held})</span>
                    <b className="set-keys">
                      <button className="btn" data-testid={`key-claim-${id}`} onClick={() => claim(id, shipped)}>Take it</button>
                    </b>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="desc">
          Unlisted ⌘ chords go to the terminal.
          {Object.keys(theirs).length > 0 && ` ${Object.keys(theirs).filter((c) => !bound[c]).length} of your Ghostty chords stay with Ghostty.`}
        </div>
      </div>
    </div>
  );
}
