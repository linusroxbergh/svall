import type { Bridge } from './bridge.js';
import { commitFocused } from './Field.js';
import { chordFor } from './keys.js';
import { flushDocs } from './resources/autosave.js';
import type { IdeState } from './store/ide.js';
import type { AppStore } from './store/index.js';

// how long a quit waits on docs still being written before it names them as unsaved instead
export const QUIT_FLUSH_MS = 3000;

/** The files whose edits a quit would drop, by name, or by path where two share a name. */
export const unsavedFiles = (ide: Record<string, IdeState>): string[] => {
  const paths = Object.values(ide).flatMap((s) => s.dirty);
  const name = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  return paths.map((p) => (paths.filter((q) => name(q) === name(p)).length > 1 ? p : name(p)));
};

/** Tells the shell which chord quits, and answers it before a quit: the docs waiting to be saved are written, and the files still unsaved are named for it to ask about. */
export function followQuit({ store, bridge }: { store: AppStore; bridge: Pick<Bridge, 'send' | 'onMessage'> }): () => void {
  const tell = () => bridge.send({ type: 'keys.quit', chord: chordFor('quit', store.getState().settings.bindings) ?? undefined });
  tell();
  const unwatch = store.subscribe((s, prev) => { if (s.settings.bindings !== prev.settings.bindings) tell(); });
  const off = bridge.onMessage((m) => {
    if (m.type !== 'quit.ask') return;
    // a field saves on blur, which a quit from the shell never sends
    commitFocused();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((resolve) => { timer = setTimeout(resolve, QUIT_FLUSH_MS); });
    void Promise.race([flushDocs().catch(() => {}), waited]).then(() => {
      clearTimeout(timer);
      bridge.send({ type: 'quit.answer', unsaved: unsavedFiles(store.getState().ide) });
    });
  });
  return () => { unwatch(); off(); };
}
