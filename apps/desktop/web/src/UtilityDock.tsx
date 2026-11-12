import { useEffect, useRef } from 'react';
import { app } from './boot.js';
import { CloseX } from './CloseX.js';
import { holdCutout } from './cutout.js';
import { FeedbackPanel } from './FeedbackPanel.js';
import { useApp, usePanelWidth } from './hooks.js';
import { Feedback, Gear, Meter, Phone, Pulse } from './icons.js';
import { refocusSurface } from './keyboard.js';
import { keyTip } from './keys.js';
import { LoadPanel } from './LoadPanel.js';
import { MobilePanel, MobileSwitch, PhoneAway, usePhoneAway } from './PhonePanel.js';
import { UsagePanel } from './Usage.js';

/** The fleet utilities share the fixed foot of the island sidebar. */
export function UtilityDock() {
  const usageOpen = useApp((s) => s.usageOpen);
  // a worker's daemon holds no phone link, which is its home's to serve: apart from the home its panel says so
  const away = usePhoneAway();
  const mobileOpen = useApp((s) => s.mobileOpen);
  const loadOpen = useApp((s) => s.loadOpen);
  const feedbackOpen = useApp((s) => s.feedbackOpen);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const width = usePanelWidth('sidebar');
  const usageTab = useApp((s) => s.settings.usageTab);
  const bindings = useApp((s) => s.settings.bindings);
  // the control stands whether the fleet is served, not served, cannot be or is out of reach, so its panel switches the link on or says why not
  const phoneTab = useApp((s) => !!s.mobile) || !!away.home;
  const serving = useApp((s) => !!s.mobile?.serving) && !away.home;
  const phoneLabel = away.home ? 'Phone link' : serving ? 'Phone link on' : 'Phone link off';
  // an open sidebar names a waiting update itself
  const update = useApp((s) => !!s.update && !s.sidebarOpen);
  const settingsLabel = update ? 'Settings, update available' : 'Settings';
  const box = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const open = usageOpen || mobileOpen || loadOpen || feedbackOpen;

  useEffect(() => {
    // the surfaces have answered this close; the next one takes the keyboard as it always does
    if (!open) { app.store.getState().pageFocusSettled(); return; }
    const shut = () => {
      app.store.getState().toggleUsage(false, { keepPageFocus: true });
      app.store.getState().toggleMobile(false, { keepPageFocus: true });
      app.store.getState().toggleLoad(false, { keepPageFocus: true });
      app.store.getState().toggleFeedback(false, { keepPageFocus: true });
    };
    app.bridge.send({ type: 'term.focus' });
    // the press that opened the panel lands on the tab, which counts as inside; a press anywhere else
    // (a pointerdown, since the map's send no mousedown) is where the user wants the keys, so the surface leaves them there
    const away = (e: PointerEvent) => {
      // the dialogs the panel's buttons open stand outside the dock, and answering one is no press away
      // the sidebar's feedback link toggles the panel itself
      if (!box.current?.contains(e.target as Node) && !(e.target instanceof Element && e.target.closest('.modal-back, .sb-feedback'))) shut();
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
      <div className="use-tabs" ref={tabs} style={width}>
        {/* the sidebar's own link stands in while it is open */}
        <button className="use-tab" data-rail data-testid="feedback-tab" aria-expanded={feedbackOpen} aria-controls="corner-panel"
          data-tip="Send feedback" aria-label="Send feedback" onClick={() => app.store.getState().toggleFeedback()}><Feedback size="lg" /><span className="use-tab-label">Feedback</span></button>
        {phoneTab && (
          <button className="use-tab" data-testid="mobile-tab" aria-expanded={mobileOpen} aria-controls="corner-panel"
            data-tip={phoneLabel} aria-label={phoneLabel} data-off={!serving || undefined}
            onClick={() => app.store.getState().toggleMobile()}><Phone size="lg" /><span className="use-tab-label">Phone</span><i className="use-status" data-on={serving} aria-hidden="true" /></button>
        )}
        {usageTab && (
          <button className="use-tab" data-testid="usage-tab" aria-expanded={usageOpen} aria-controls="corner-panel"
            data-tip="Plan usage" aria-label="Plan usage" onClick={() => app.store.getState().toggleUsage()}><Meter size="lg" /><span className="use-tab-label">Usage</span></button>
        )}
        <button className="use-tab" data-testid="load-tab" aria-expanded={loadOpen} aria-controls="corner-panel"
          data-tip="Load" aria-label="Load" onClick={() => app.store.getState().toggleLoad()}><Pulse size="lg" /><span className="use-tab-label">Load</span></button>
        <button className="use-tab" data-testid="settings-open" aria-expanded={settingsOpen} data-tip={keyTip(settingsLabel, 'toggleSettings', bindings)} aria-label={settingsLabel}
          onClick={() => app.store.getState().toggleSettings()}><Gear size="lg" /><span className="use-tab-label">Settings</span>
          {update && <i className="use-status" data-update data-testid="settings-update" aria-hidden="true" />}</button>
      </div>
      {open && (
        // the load reads anew every few seconds, which a live region would announce each time
        <div className="use-panel popover" ref={panel} id="corner-panel" data-testid={usageOpen ? 'usage-panel' : loadOpen ? 'load-panel' : feedbackOpen ? 'feedback-panel' : 'mobile-panel'}
          data-load={loadOpen || undefined} aria-live={loadOpen || feedbackOpen ? 'off' : 'polite'}>
          <div className="use-panel-title">
            <span>{usageOpen ? 'Plan usage' : loadOpen ? 'Load' : feedbackOpen ? 'Send feedback' : 'Phone link'}</span>
            {mobileOpen && !away.home && <MobileSwitch testId="mobile-switch" />}
            {/* closing any one of the four closes whichever is open */}
            <CloseX onClose={() => app.store.getState().toggleUsage(false)} testid="corner-panel-close" />
          </div>
          {usageOpen ? <UsagePanel /> : loadOpen ? <LoadPanel /> : feedbackOpen ? <FeedbackPanel diagnostics={() => app.api().call('feedback.preview', {}).then((r) => r.text)} />
            : away.home ? <PhoneAway home={away.home} dialed={away.dialed} className="use-note" testid="mobile-away" /> : <MobilePanel />}
        </div>
      )}
    </div>
  );
}
