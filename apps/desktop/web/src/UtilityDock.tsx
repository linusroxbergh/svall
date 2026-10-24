import { useEffect, useRef } from 'react';
import { app } from './boot.js';
import { CloseX } from './CloseX.js';
import { holdCutout } from './cutout.js';
import { badgeOf } from './handover.js';
import { useApp } from './hooks.js';
import { refocusSurface } from './keyboard.js';
import { keyTip } from './keys.js';
import { LoadPanel } from './LoadPanel.js';
import { MobilePanel, MobileSwitch } from './PhonePanel.js';
import { UsagePanel } from './Usage.js';

// the glyphs share one 24-square and stroke weight
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

const Pulse = () => (
  <svg className="use-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />
  </svg>
);

const Gear = () => (
  <svg className="use-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

// the fleet goes from the machine it is on to another
const Move = () => (
  <svg className="use-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2.5" y="3" width="9" height="7" rx="1.5" />
    <rect x="12.5" y="14" width="9" height="7" rx="1.5" />
    <path d="M14.5 6.5h2.5a2.5 2.5 0 0 1 2.5 2.5v2M17.5 9.5l2 2 2-2" />
  </svg>
);

/** The fleet utilities share the fixed foot of the island sidebar. */
export function UtilityDock() {
  const usageOpen = useApp((s) => s.usageOpen);
  const mobileOpen = useApp((s) => s.mobileOpen);
  const loadOpen = useApp((s) => s.loadOpen);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const usageTab = useApp((s) => s.settings.usageTab);
  const bindings = useApp((s) => s.settings.bindings);
  // the control stands whether or not the fleet is served, so it can be switched on from here
  const phoneTab = useApp((s) => !!s.mobile && !s.mobile.error);
  const serving = useApp((s) => !!s.mobile?.serving);
  const phoneLabel = serving ? 'Phone link on' : 'Phone link off';
  // an open sidebar names a waiting update itself
  const update = useApp((s) => !!s.update && !s.sidebarOpen);
  const settingsLabel = update ? 'Settings, update available' : 'Settings';
  // the machine the fleet runs on, whenever that is not this Mac
  const owner = useApp((s) => (s.connection && s.connection.owner !== 'local' ? s.connection.owner : undefined));
  const where = useApp((s) => s.connection?.state);
  const handover = useApp((s) => !!s.shell?.handoverEnabled);
  const handoverOpen = useApp((s) => s.handoverOpen);
  const moving = useApp((s) => badgeOf(s.handover));
  const box = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const open = usageOpen || mobileOpen || loadOpen;

  useEffect(() => {
    // the surfaces have answered this close; the next one takes the keyboard as it always does
    if (!open) { app.store.getState().pageFocusSettled(); return; }
    const shut = () => {
      app.store.getState().toggleUsage(false, { keepPageFocus: true });
      app.store.getState().toggleMobile(false, { keepPageFocus: true });
      app.store.getState().toggleLoad(false, { keepPageFocus: true });
    };
    app.bridge.send({ type: 'term.focus' });
    // the press that opened the panel lands on the tab, which counts as inside; a press anywhere else
    // (a pointerdown, since the map's send no mousedown) is where the user wants the keys, so the surface leaves them there
    const away = (e: PointerEvent) => {
      // the dialogs the panel's buttons open stand outside the dock, and answering one is no press away
      if (!box.current?.contains(e.target as Node) && !(e.target instanceof Element && e.target.closest('.modal-back'))) shut();
    };
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
        {owner && (
          <span className="use-owner" data-testid="owner-badge" data-state={where}
            title={`This fleet runs on ${owner}`}>{owner}</span>
        )}
        {handover && (
          <button className="use-tab use-handover" data-testid="handover-tab" data-state={moving} aria-expanded={handoverOpen}
            title="Move this fleet to another machine" aria-label="Handover" onClick={() => app.store.getState().toggleHandover()}><Move /><span className="use-tab-label">Handover</span></button>
        )}
        {phoneTab && (
          <button className="use-tab" data-testid="mobile-tab" aria-expanded={mobileOpen} aria-controls="corner-panel"
            title={phoneLabel} aria-label={phoneLabel} data-off={!serving || undefined}
            onClick={() => app.store.getState().toggleMobile()}><Phone /><span className="use-tab-label">Phone</span><i className="use-status" data-on={serving} aria-hidden="true" /></button>
        )}
        {usageTab && (
          <button className="use-tab" data-testid="usage-tab" aria-expanded={usageOpen} aria-controls="corner-panel"
            title="Plan usage" aria-label="Plan usage" onClick={() => app.store.getState().toggleUsage()}><Meter /><span className="use-tab-label">Usage</span></button>
        )}
        <button className="use-tab" data-testid="load-tab" aria-expanded={loadOpen} aria-controls="corner-panel"
          title="Load" aria-label="Load" onClick={() => app.store.getState().toggleLoad()}><Pulse /><span className="use-tab-label">Load</span></button>
        <button className="use-tab" data-testid="settings-open" aria-expanded={settingsOpen} title={keyTip(settingsLabel, 'toggleSettings', bindings)} aria-label={settingsLabel}
          onClick={() => app.store.getState().toggleSettings()}><Gear /><span className="use-tab-label">Settings</span>
          {update && <i className="use-status" data-update data-testid="settings-update" aria-hidden="true" />}</button>
      </div>
      {open && (
        // the load reads anew every few seconds, which a live region would announce each time
        <div className="use-panel popover" ref={panel} id="corner-panel" data-testid={usageOpen ? 'usage-panel' : loadOpen ? 'load-panel' : 'mobile-panel'}
          data-load={loadOpen || undefined} aria-live={loadOpen ? 'off' : 'polite'}>
          <div className="use-panel-title">
            <span>{usageOpen ? 'Plan usage' : loadOpen ? 'Load' : 'Phone link'}</span>
            {mobileOpen && <MobileSwitch testId="mobile-switch" />}
            {/* closing any one of the three closes whichever is open */}
            <CloseX onClose={() => app.store.getState().toggleUsage(false)} testid="corner-panel-close" />
          </div>
          {usageOpen ? <UsagePanel /> : loadOpen ? <LoadPanel /> : <MobilePanel />}
        </div>
      )}
    </div>
  );
}
