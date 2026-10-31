import { useEffect, useRef, useState } from 'react';
import { ellipsis } from '@svall/protocol';
import { activateBrowserTab, closeBrowserTab } from './actions.js';
import { app, deps } from './boot.js';
import { rectOf } from './bridge.js';
import { AS_TYPED } from './Field.js';
import { useApp } from './hooks.js';
import { Caret, Close, Plus, Reload } from './icons.js';
import { canFill } from './settings.js';
import { isVeiled } from './selectors.js';

export function BrowserArea({ id, aside }: { id: string; aside?: boolean }) {
  const c = useApp((s) => s.fleet.robots[id]);
  const veiled = useApp(isVeiled);
  // read as the veil lifts, from the render that lifted it
  const keepPageFocus = useApp((s) => s.keepPageFocus);
  const active = c?.browser?.active;
  const view = useApp((s) => (active ? s.webviews[active] : undefined));
  const failure = view?.error;
  const addressFocus = useApp((s) => s.addressFocus);
  const fills = useApp(canFill);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // what the user is typing; undefined shows the page's own url
  const [draft, setDraft] = useState<string | undefined>();
  // + asked for a tab of its own, so the next url opens one instead of loading into the active tab
  const fresh = useRef(false);
  // a tab the address bar just asked svalld for takes the keys when it arrives
  const takeKeys = useRef(false);
  const tabs = c?.browser?.tabs ?? [];
  // the pane opens on the start page; closing the last tab leaves it empty until it is opened again
  const started = useRef(false);

  useEffect(() => {
    if (!c || started.current) return;
    started.current = true;
    app.browser().start(id);
  }, [id, c]);

  useEffect(() => {
    if (!active || veiled) return;
    const el = ref.current;
    if (!el) return;
    const m = app.browser();
    // the right pane waits to be reached for; the left pane is what the user turned to
    m.show(id, active, rectOf(el), !keepPageFocus && (takeKeys.current || (!aside && !app.store.getState().settingsOpen)));
    takeKeys.current = false;
    const ro = new ResizeObserver(() => m.move(active, rectOf(el)));
    ro.observe(el);
    return () => { ro.disconnect(); m.hide(active); };
  }, [id, active, veiled, aside]);

  // the tab may hold the keys, so the page takes them back before the input selects itself
  useEffect(() => {
    if (!addressFocus) return;
    app.store.getState().addressFocused();
    app.bridge.send({ type: 'term.focus' });
    input.current?.select();
  }, [addressFocus]);

  useEffect(() => { setDraft(undefined); fresh.current = false; }, [active]);

  if (!c) return null;
  const shown = draft ?? (view?.url || tabs.find((t) => t.id === active)?.url) ?? '';
  const submit = () => {
    if (draft === undefined) return;
    const into = fresh.current ? undefined : active;
    fresh.current = false;
    app.browser().load(id, into, draft);
    setDraft(undefined);
    input.current?.blur();
    // the keys follow the url: into the page the tab is going to, or into the tab that is about to arrive
    if (into && view && ref.current) app.browser().show(id, into, rectOf(ref.current));
    else takeKeys.current = true;
  };

  return (
    <div className="browser" data-testid="browser-area">
      <div className="dtabs" data-testid="browser-tabs">
        {tabs.map((t) => (
          <span key={t.id} className="dtab" data-testid={`btab-${t.id}`} data-active={t.id === active}
            onClick={() => activateBrowserTab(deps(), id, t.id)} data-tip={t.url}>
            <span className="dtab-name">{ellipsis(t.title || t.url.replace(/^https?:\/\//, '') || 'New tab', 24)}</span>
            <button className="ib bar" data-testid={`btab-close-${t.id}`} aria-label="Close tab"
              onClick={(e) => { e.stopPropagation(); closeBrowserTab(deps(), id, t.id); }}><Close size="xs" /></button>
          </span>
        ))}
        <button className="ib" data-testid="browser-new" data-tip="New tab" aria-label="New tab" onClick={() => { fresh.current = true; setDraft(''); input.current?.focus(); }}><Plus /></button>
      </div>
      <div className="baddr">
        <button className="ib bar" data-testid="browser-back" disabled={!view?.canGoBack} onClick={() => active && app.browser().go(active, 'back')}><Caret dir="left" /></button>
        <button className="ib bar" data-testid="browser-forward" disabled={!view?.canGoForward} onClick={() => active && app.browser().go(active, 'forward')}><Caret dir="right" /></button>
        <button className="ib bar" data-testid="browser-reload" disabled={!active} onClick={() => active && app.browser().go(active, view?.loading ? 'stop' : 'reload')}>{view?.loading ? <Close /> : <Reload />}</button>
        <input ref={input} data-testid="browser-address" className="fld mono" value={shown} placeholder="Search or enter a url"
          {...AS_TYPED} onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            // the page's own Escape would close the card around the field
            if (e.key === 'Escape') { e.stopPropagation(); fresh.current = false; setDraft(undefined); e.currentTarget.blur(); }
          }} />
        {failure && <span className="baddr-err" data-testid="browser-error" data-tip={failure}>{ellipsis(failure, 40)}</span>}
        {fills && <button className="ib bar" data-testid="browser-fill" disabled={!active} data-tip="Fill from 1Password" aria-label="Fill from 1Password"
          onClick={() => active && app.bridge.send({ type: 'browser.fill', tab: active })}>⚿</button>}
      </div>
      {active ? (
        <div ref={ref} className="bsurface" data-testid="browser-surface" data-tab={active}>
          {!app.bridge.present && <span>browser · {tabs.find((t) => t.id === active)?.url}</span>}
        </div>
      ) : (
        <div className="bsurface browser-empty" data-testid="browser-empty"><span>No tabs. Type a url above.</span></div>
      )}
    </div>
  );
}
