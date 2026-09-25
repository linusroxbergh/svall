import type { ContextItem } from '@archipelago/protocol';

export type Rect = { x: number; y: number; width: number; height: number };
export type Attach = { socket: string; session: string };
export type Connection = { host: string; port: number; token: string };
// what only the native shell can see: the fleet's home, the tail of its daemon log, installed apps
// ghosttyKeys: the chords the user spends in their own Ghostty config, so the app can leave them alone
export type ShellInfo = { home: string; log: string[]; op: boolean; ghosttyKeys?: Record<string, string> };
// what macOS allows for banners: unknown until the app has asked
export type NotifyPermission = 'unknown' | 'denied' | 'granted';

export type ToShell =
  | { type: 'connection' }
  | { type: 'term.show'; id: string; rect: Rect; attach?: Attach; opacity?: number }
  | { type: 'term.move'; id: string; rect: Rect }
  | { type: 'term.hide'; id: string }
  | { type: 'term.close'; id: string }
  | { type: 'term.focus'; id?: string }
  | { type: 'browser.show'; tab: string; rect: Rect; url?: string; focus?: boolean }
  | { type: 'browser.move'; tab: string; rect: Rect }
  | { type: 'browser.hide'; tab: string }
  | { type: 'browser.close'; tab: string }
  | { type: 'browser.load'; tab: string; url: string }
  | { type: 'browser.go'; tab: string; action: 'back' | 'forward' | 'reload' }
  | { type: 'browser.importCookies' }
  | { type: 'browser.fill'; tab: string }
  | { type: 'browser.focus'; tab: string }
  // the rect the page draws an overlay into, which the surfaces above it give up; no rect leaves them whole
  | { type: 'shell.cutout'; rect?: Rect }
  | { type: 'keys.register'; chords: string[] }
  | { type: 'keys.capture'; on: boolean }
  // the chord that quits, for the shell's menu and for a page too stuck to hear it; none leaves quitting unbound
  | { type: 'keys.quit'; chord?: string }
  | { type: 'openUrl'; url: string }
  | { type: 'openFolder'; path: string }
  | { type: 'reveal'; path: string }
  | { type: 'copy'; text: string }
  | { type: 'openConfig'; which: 'ghostty' | 'fleet' }
  | { type: 'zoom'; factor: number; fontDelta: number }
  // a banner in Notification Center; a new one for the same session key replaces the last
  | { type: 'notify.post'; key: string; title: string; subtitle: string; body: string; sound: boolean; actions: boolean; promptId?: string }
  | { type: 'notify.remove'; key: string }
  | { type: 'notify.enable' }
  | { type: 'notify.settings' }
  | { type: 'quit' }
  // the files a quit would drop, by name, once the docs waiting to be written are
  | { type: 'quit.answer'; unsaved: string[] };

export type FromShell =
  | { type: 'connection'; host: string; port: number; token: string }
  | ({ type: 'shell.info' } & ShellInfo)
  | { type: 'key'; chord: string }
  | { type: 'term.exited'; id: string }
  | { type: 'term.failed'; id: string; reason: string }
  | { type: 'term.focused'; id: string }
  // a link followed in a terminal, for the character's own browser
  | { type: 'term.openUrl'; id: string; url: string }
  // error: what stopped the last navigation, empty once one gets somewhere
  | { type: 'browser.state'; tab: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error?: string }
  | { type: 'browser.opened'; from: string; tab: string; url: string }
  | { type: 'browser.closed'; tab: string }
  // a press that landed on a surface instead of the page, while an overlay held a cutout
  | { type: 'shell.pressedAway' }
  | { type: 'app.active'; active: boolean }
  | { type: 'ghostty.configErrors'; errors: string[] }
  | { type: 'drag.over'; x: number; y: number }
  | { type: 'drag.exit' }
  | { type: 'drag.drop'; paths: string[]; x: number; y: number }
  | { type: 'notify.permission'; state: NotifyPermission }
  // a banner was clicked, or answered from its buttons; promptId is the question it showed, empty when it named none
  | { type: 'notify.open'; key: string }
  | { type: 'notify.action'; key: string; action: 'approve' | 'deny'; promptId?: string }
  // the app is about to quit and waits for a quit.answer
  | { type: 'quit.ask' };

type Handler = (msg: FromShell) => void;
type Port = { postMessage(json: string): void };

declare global {
  interface Window {
    webkit?: { messageHandlers?: { archi?: Port } };
    __archi?: { receive(json: string): void };
  }
}

export type Bridge = { present: boolean; send(msg: ToShell): void; onMessage(h: Handler): () => void };

export function createBridge(win: Window = window): Bridge {
  const handlers = new Set<Handler>();
  const port = win.webkit?.messageHandlers?.archi;
  win.__archi = { receive: (json) => { const msg = JSON.parse(json) as FromShell; for (const h of handlers) h(msg); } };
  return {
    present: Boolean(port),
    send: (msg) => port?.postMessage(JSON.stringify(msg)),
    onMessage: (h) => { handlers.add(h); return () => { handlers.delete(h); }; },
  };
}

// a bare host like xyz.com is a web link; any other scheme is refused
export function webUrl(input: string): string | undefined {
  const raw = input.trim();
  const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  return /^(https?|mailto):/i.test(url) ? url : undefined;
}

export function openUrl(bridge: Bridge, input: string): void {
  const url = webUrl(input);
  if (!url) return;
  if (bridge.present) bridge.send({ type: 'openUrl', url });
  else window.open(url, '_blank');
}

// a folder is shown in Finder; only the shell can do this
export function openFolder(bridge: Bridge, path: string): void {
  if (!path.startsWith('/') || !bridge.present) return;
  bridge.send({ type: 'openFolder', path });
}

// a file is shown selected in Finder; only the shell can do this
export function revealFile(bridge: Bridge, path: string): void {
  if (!path.startsWith('/') || !bridge.present) return;
  bridge.send({ type: 'reveal', path });
}

export function copyText(bridge: Bridge, text: string): void {
  if (bridge.present) bridge.send({ type: 'copy', text });
  else void navigator.clipboard?.writeText(text);
}

export function openItem(bridge: Bridge, item: ContextItem): void {
  if (item.kind === 'folder') openFolder(bridge, item.ref);
  else if (item.kind === 'file') revealFile(bridge, item.ref);
  else openUrl(bridge, item.ref);
}

// the shell knows where each config lives, and creates one that is not there yet
export function openConfig(bridge: Bridge, which: 'ghostty' | 'fleet'): void {
  if (bridge.present) bridge.send({ type: 'openConfig', which });
}

export function connectionFromUrl(search: string): Connection | undefined {
  const q = new URLSearchParams(search);
  const port = Number(q.get('port'));
  const token = q.get('token');
  if (!port || !token) return undefined;
  return { host: q.get('host') ?? '127.0.0.1', port, token };
}
