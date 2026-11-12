import { useEffect, useRef, useState } from 'react';
import { app } from './boot.js';
import { copyText } from './bridge.js';
import { holdCutout } from './cutout.js';
import { useApp } from './hooks.js';
import { splitRaw } from './host.js';
import { refocusSurface } from './keyboard.js';
import { theme } from './theme.js';

const CORNERS = ['bottom-left', 'bottom-right', 'top-left', 'top-right'] as const;
type Corner = (typeof CORNERS)[number];
// the toast takes the first corner the open card leaves free
export function toastCorner(card: { x: number; y: number; width: number; height: number } | undefined, host: { w: number; h: number }): Corner {
  if (!card) return 'bottom-left';
  const m = theme.card.margin;
  const free = (c: Corner) => {
    const x = c.endsWith('left') ? m : host.w - m;
    const y = c.startsWith('top') ? m : host.h - m;
    return x < card.x || x > card.x + card.width || y < card.y || y > card.y + card.height;
  };
  return CORNERS.find(free) ?? 'bottom-left';
}

// a toast can land on a terminal or a browser tab, which the shell draws above the page, so it takes a hole in them;
// one with nothing to press leaves the presses in that hole to the surface
export function Toast({ corner = 'bottom-left' }: { corner?: Corner }) {
  const live = useApp((s) => s.toast);
  // a cleared toast stays on the page while it sinks away, its hole in the surfaces given back at once
  const [last, setLast] = useState(live);
  const [copied, setCopied] = useState(false);
  if (live && live !== last) { setLast(live); setCopied(false); }
  useEffect(() => {
    if (live) return;
    const t = setTimeout(() => setLast(undefined), theme.toastLeaveMs);
    return () => clearTimeout(t);
  }, [live]);
  const toast = live ?? last;
  const ref = useRef<HTMLDivElement>(null);
  const shown = Boolean(live);
  const presses = Boolean(live?.action || live?.dismiss || live?.tone === 'error');
  useEffect(() => (shown && ref.current ? holdCutout(app.bridge, ref.current, presses) : undefined), [shown, presses, corner]);
  const [over, setOver] = useState(false);
  // a toast taken off the page from under the pointer never sees it leave
  if (over && !live) setOver(false);
  const waiting = over && live?.tone === 'error';
  useEffect(() => {
    if (!live || waiting) return;
    const t = setTimeout(() => app.store.getState().clearToast(), live.tone === 'error' ? theme.toastErrorMs : live.action || live.tone === 'info' ? theme.toastActionMs : theme.toastMs);
    return () => clearTimeout(t);
  }, [live, waiting]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  // a press on an error takes the keys off any terminal under it; they go back as it leaves, unless they have moved on
  const pressed = useRef(false);
  useEffect(() => {
    if (live || !pressed.current) return;
    pressed.current = false;
    const at = document.activeElement;
    if (document.hasFocus() && (!at || at === document.body || ref.current?.contains(at))) refocusSurface(app);
  }, [live]);
  if (!toast) return null;
  // an error shows its sentence; what a tool said after it is copied, not shown
  const { line, raw } = toast.tone === 'error' ? splitRaw(toast.text) : { line: toast.text, raw: undefined };
  return (
    <div ref={ref} className="toast" data-testid="toast" data-tone={toast.tone} data-corner={corner} data-leaving={!live || undefined}
      onPointerEnter={() => setOver(true)} onPointerLeave={() => setOver(false)} onPointerDown={() => { setOver(true); pressed.current = toast.tone === 'error'; }}>
      <span className="toast-text" data-testid="toast-text">{line}</span>
      {toast.action && <button className="toast-act" data-testid="toast-action" onClick={() => { pressed.current = false; app.store.getState().runToastAction(); }}>{toast.action.label}</button>}
      {raw && <button className="toast-act" data-testid="toast-copy" onClick={() => { copyText(app.bridge, raw); setCopied(true); }}>{copied ? 'Copied' : 'Copy details'}</button>}
      {(toast.dismiss || toast.tone === 'error') && <button className="toast-act toast-dismiss" data-testid="toast-dismiss" onClick={() => app.store.getState().clearToast()}>Dismiss</button>}
    </div>
  );
}
