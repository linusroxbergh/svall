import type { Event } from '@svall/protocol';
import type { Api } from '../api.js';

export type TermEvent = Extract<Event, { event: `term.${string}` }>;

/** What a terminal has to offer the link: a grid to paint and its current size. */
export type Screen = {
  readonly cols: number;
  readonly rows: number;
  write(bytes: Uint8Array): void;
  reset(): void;
};

export type TerminalLink = {
  open(): Promise<void>;
  input(text: string): void;
  resize(): void;
  close(): void;
};

export type LinkDeps = { api: Api; subscribe(h: (e: TermEvent) => void): () => void };

const encoder = new TextEncoder();
export const decode = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
// a paste arrives as one chunk, and spreading it whole overflows the argument limit
export const encode = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
};

/**
 * One character's terminal over the daemon's streaming path. open() paints the pane as it stands and
 * starts the stream; calling it again after a reconnect repaints, which is what Safari needs every time
 * it drops the socket on lock.
 */
export function linkTerminal(deps: LinkDeps, id: string, screen: Screen, lines = 2000): TerminalLink {
  let unsubscribe: (() => void) | undefined;
  let closed = false;

  const paint = (b64: string) => { screen.reset(); screen.write(decode(b64)); };

  return {
    async open() {
      unsubscribe?.();
      unsubscribe = deps.subscribe((e) => {
        if (e.data.id !== id) return;
        if (e.event === 'term.output') screen.write(decode(e.data.data));
        else paint(e.data.screen);
      });
      try {
        const { cols, rows } = screen;
        const { screen: seed } = await deps.api.call('term.open', { id, cols, rows, lines });
        if (closed) return;
        paint(seed);
        // the daemon takes no size from a viewer still opening, so one the screen settled on meanwhile goes now
        if (screen.cols !== cols || screen.rows !== rows) deps.api.fire('term.resize', { id, cols: screen.cols, rows: screen.rows });
      } catch (e) {
        unsubscribe?.();
        unsubscribe = undefined;
        throw e;
      }
    },
    input(text) { deps.api.fire('term.input', { id, data: encode(encoder.encode(text)) }); },
    resize() { deps.api.fire('term.resize', { id, cols: screen.cols, rows: screen.rows }); },
    close() {
      closed = true;
      unsubscribe?.();
      unsubscribe = undefined;
      deps.api.fire('term.close', { id });
    },
  };
}
