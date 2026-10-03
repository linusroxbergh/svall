import type { AgentKind, ContextItem, HandoverChoices } from '@svall/protocol';
import type { HandoverEvent } from './handover.js';

export type Rect = { x: number; y: number; width: number; height: number };
export type Attach = { socket: string; session: string };
export type Connection = { host: string; port: number; token: string };
// what only the native shell can see: the fleet's home, the tail of its daemon log, installed apps
// ghosttyKeys: the chords the user spends in their own Ghostty config, so the app can leave them alone
// handoverEnabled: fleet.json's handover.enabled, which every control for another machine waits on
// gateway: the registry name of the machine fleet.json names as its gateway
export type ShellInfo = { home: string; log: string[]; op: boolean; ghosttyKeys?: Record<string, string>; handoverEnabled?: boolean; gateway?: string };
// what macOS allows for banners: unknown until the app has asked
export type NotifyPermission = 'unknown' | 'denied' | 'granted';

// the machines a fleet can be handed to: what the shell may run `svall host …` for, and with what
export type HostOp = 'add' | 'doctor' | 'upgrade' | 'remove' | 'enable';
// enable names no fleet: the shell supplies the one this window runs
export type HostArgs = { name: string; ssh?: string; forget?: boolean };
export type StepStatus = 'start' | 'ok' | 'warn' | 'fail' | 'skip';
export type HostStep = { step: string; status: StepStatus; detail?: string; action?: string };

// where the fleet this window shows is running, as the shell's connect helper reports it
export type ConnectionState = {
  state: 'connecting' | 'online' | 'error' | 'owner-changed';
  owner: string;
  kind?: string;
  message?: string;
};

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
  | { type: 'browser.go'; tab: string; action: 'back' | 'forward' | 'reload' | 'stop' }
  | { type: 'browser.importCookies' }
  | { type: 'browser.fill'; tab: string }
  | { type: 'browser.focus'; tab: string }
  // the rects the page draws overlays into, which the surfaces above it give up; presses in a passive one stay with the surface
  | { type: 'shell.cutout'; rects: Rect[]; passive: Rect[] }
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
  // brings up Sparkle's window for the update update.available named
  | { type: 'update.install' }
  // the shell runs the bundled svall for one host operation at a time, and stops it on cancel
  | { type: 'host.start'; op: HostOp; args: HostArgs }
  | { type: 'host.cancel' }
  // the shell starts, resumes or aborts a handover as a detached helper, then follows it with `handover attach`,
  // whose stdin carries the user's answers; `to` is `local` or the gateway's name
  | { type: 'handover.start'; to: string; choices?: HandoverChoices }
  | { type: 'handover.resume' }
  | { type: 'handover.abort' }
  // follows a live helper, or reads back the last run and the status when none is live
  | { type: 'handover.attach' }
  | { type: 'handover.forget' }
  | { type: 'handover.choose'; choices: HandoverChoices }
  | { type: 'handover.cancel' }
  // the files a quit would drop, by name, once the docs waiting to be written are, and the agents it would stop mid-task
  | { type: 'quit.answer'; unsaved: string[]; working: number }
  // the fleet has stopped, or could not be asked to
  | { type: 'quit.stopped'; ok: boolean }
  // brings up the window open on another fleet, or opens one; quit then leaves that window alone
  | { type: 'openFleet'; home: string; quit?: boolean }
  // the fleet was renamed, and the window title follows
  | { type: 'retitle' }
  | { type: 'setup.plan' }
  | { type: 'setup.run'; agents: AgentKind[]; found: AgentKind[]; projects: string }
  // a native folder picker opened at `start`, answered by folder.picked unless cancelled
  | { type: 'folder.pick'; start: string };

export type FromShell =
  | { type: 'connection'; host: string; port: number; token: string }
  | ({ type: 'connection.state' } & ConnectionState)
  // something the page asked for that only the machine the fleet runs on can do
  | { type: 'notice'; text: string }
  | { type: 'host.step'; op: HostOp; event: HostStep }
  | { type: 'host.done'; op: HostOp; code: number }
  // each line the helper printed, and the end of the process the page was following
  | { type: 'handover.event'; event: HandoverEvent }
  | { type: 'handover.replay'; events: HandoverEvent[] }
  | { type: 'handover.exit'; code: number; error?: string }
  | ({ type: 'shell.info' } & ShellInfo)
  | { type: 'key'; chord: string }
  | { type: 'term.exited'; id: string }
  | { type: 'term.failed'; id: string; reason: string }
  | { type: 'term.focused'; id: string }
  // a link followed in a terminal, for the character's own browser
  | { type: 'term.openUrl'; id: string; url: string; x: number; y: number }
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
  // the version a scheduled check found, empty when none waits
  | { type: 'update.available'; version: string }
  // a banner was clicked, or answered from its buttons; promptId is the question it showed
  | { type: 'notify.open'; key: string }
  | { type: 'notify.action'; key: string; action: 'approve' | 'deny'; promptId: string }
  | { type: 'setup.result'; step: 'plan' | 'run'; ok: boolean; json: string }
  | { type: 'folder.picked'; path: string }
  // the app is about to quit and waits for a quit.answer
  | { type: 'quit.ask' }
  // the quit goes ahead: the fleet stops, and the shell waits for quit.stopped
  | { type: 'quit.stop' }
  // the menu's Open Fleet…
  | { type: 'fleets' }
  | { type: 'openFleet.failed'; home: string; reason: string };

type Handler = (msg: FromShell) => void;
type Port = { postMessage(json: string): void };

declare global {
  interface Window {
    webkit?: { messageHandlers?: { svall?: Port } };
    __svall?: { receive(json: string): void };
  }
}

export type Bridge = { present: boolean; send(msg: ToShell): void; onMessage(h: Handler): () => void };

export function createBridge(win: Window = window): Bridge {
  const handlers = new Set<Handler>();
  const port = win.webkit?.messageHandlers?.svall;
  // a handler that throws leaves the ones after it their message
  win.__svall = { receive: (json) => {
    const msg = JSON.parse(json) as FromShell;
    for (const h of handlers) { try { h(msg); } catch (e) { console.error(e); } }
  } };
  return {
    present: Boolean(port),
    send: (msg) => port?.postMessage(JSON.stringify(msg)),
    onMessage: (h) => { handlers.add(h); return () => { handlers.delete(h); }; },
  };
}

// the CLI of the build whose shell shows this page; with no shell, Svall Dev's
export const shim = (): string => (globalThis.window?.__svallVariant === 'release' ? 'svall' : 'svall-dev');

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
