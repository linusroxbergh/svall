import { useEffect, useRef } from 'react';
import { app } from './boot.js';
import { holdCutout } from './cutout.js';
import { useApp } from './hooks.js';
import { refocusSurface } from './keyboard.js';
import { keyTip } from './keys.js';
import { MobilePanel } from './PhonePanel.js';
import { UsagePanel } from './Usage.js';

// all three glyphs share one 24-square and stroke weight
const Phone = () => (
  <svg className="use-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
    <line x1="10.5" y1="18.5" x2="13.5" y2="18.5" />
  </svg>
);

const Meter = () => (
  <svg className="use-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 12V3a9 9 0 0 1 9 9Z" fill="currentColor" stroke="none" />
  </svg>
);

const Gear = () => (
  <svg className="use-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

/** The fleet utilities share the fixed foot of the island sidebar. */
export function UtilityDock() {
  const usageOpen = useApp((s) => s.usageOpen);
  const mobileOpen = useApp((s) => s.mobileOpen);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const usageTab = useApp((s) => s.settings.usageTab);
  const bindings = useApp((s) => s.settings.bindings);
  // the control stands whether or not the fleet is served, so it can be switched on from here
  const phoneTab = useApp((s) => !!s.mobile && !s.mobile.error);
  const serving = useApp((s) => !!s.mobile?.serving);
  const phoneLabel = serving ? 'Phone link on' : 'Phone link off';
  const update = useApp((s) => !!s.update);
  const settingsLabel = update ? 'Settings, update available' : 'Settings';
  const box = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const open = usageOpen || mobileOpen;

  useEffect(() => {
    // the surfaces have answered this close; the next one takes the keyboard as it always does
    if (!open) { app.store.getState().pageFocusSettled(); return; }
    const shut = () => {
      app.store.getState().toggleUsage(false, { keepPageFocus: true });
      app.store.getState().toggleMobile(false, { keepPageFocus: true });
    };
    app.bridge.send({ type: 'term.focus' });
    // the press that opened the panel lands on the tab, which counts as inside; a press anywhere else
    // (a pointerdown, since the map's send no mousedown) is where the user wants the keys, so the surface leaves them there
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) shut(); };
    window.addEventListener('pointerdown', away, true);
    // a press on a surface never reaches the listener above; the shell answers for those
    const off = app.bridge.onMessage((m) => { if (m.type === 'shell.pressedAway') shut(); });
    return () => {
      window.removeEventListener('pointerdown', away, true);
      off();
      // a close that chose where the keys go said so; any other hands them back to the terminal underneath
      if (!app.store.getState().keepPageFocus) refocusSurface(app);
    };
  }, [open]);

  useEffect(() => {
    // a collapsed sidebar leaves the rail over a native terminal too, and each takes a hole of its own
    const held = [!sidebarOpen && tabs.current, open && panel.current].filter((el) => el instanceof HTMLElement);
    const releases = held.map((el) => holdCutout(app.bridge, el));
    return () => { for (const release of releases) release(); };
  }, [open, sidebarOpen]);

  return (
    <div className="use" ref={box} data-testid="utility-dock" data-collapsed={!sidebarOpen} data-open={open}>
      <div className="use-tabs" ref={tabs}>
        {phoneTab && (
          <button className="use-tab" data-testid="mobile-tab" aria-expanded={mobileOpen} aria-controls="corner-panel"
            title={phoneLabel} aria-label={phoneLabel} data-off={!serving || undefined}
            onClick={() => app.store.getState().toggleMobile()}><Phone /><span className="use-tab-label">Phone</span><i className="use-status" data-on={serving} aria-hidden="true" /></button>
        )}
        {usageTab && (
          <button className="use-tab" data-testid="usage-tab" aria-expanded={usageOpen} aria-controls="corner-panel"
            title="Plan usage" aria-label="Plan usage" onClick={() => app.store.getState().toggleUsage()}><Meter /><span className="use-tab-label">Usage</span></button>
        )}
        <button className="use-tab" data-testid="settings-open" aria-expanded={settingsOpen} title={keyTip(settingsLabel, 'toggleSettings', bindings)} aria-label={settingsLabel}
          onClick={() => app.store.getState().toggleSettings()}><Gear /><span className="use-tab-label">Settings</span>
          {update && <i className="use-status" data-update data-testid="settings-update" aria-hidden="true" />}</button>
      </div>
      {open && (
        <div className="use-panel" ref={panel} id="corner-panel" data-testid={usageOpen ? 'usage-panel' : 'mobile-panel'} aria-live="polite">
          {usageOpen ? <><div className="use-panel-title">Plan usage</div><UsagePanel /></> : <MobilePanel />}
        </div>
      )}
    </div>
  );
}
