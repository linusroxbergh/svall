import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { DORMANT_AFTER_HOURS, type PushStatus } from '@archipelago/protocol';
import { loadMobileStatus, setDormancy, setScribe } from './actions.js';
import { app, deps } from './boot.js';
import { openConfig, openUrl } from './bridge.js';
import { useApp } from './hooks.js';
import { chordLabel, chordsOf, keyLabel, keyTip } from './keys.js';
import { MobileSwitch } from './PhonePanel.js';
import { NO_PAGE, phonesHere } from './phoneText.js';
import { canFill, OPACITY, placeTip, zoomBy, type NotifySettings, type Settings } from './settings.js';

const set = (patch: Partial<Settings>) => app.store.getState().setSettings(patch);

// long enough for the pointer to cross the gap from the mark onto the tip it opened
const TIP_LINGER = 400;

// the panel says what each control is; what it is for waits behind the mark, hovered or focused
function Info({ id, children }: { id: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ above: false, maxHeight: 0 });
  const tip = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = () => { clearTimeout(timer.current); setOpen(true); };
  const hide = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), TIP_LINGER); };
  useEffect(() => () => clearTimeout(timer.current), []);

  // the row at the foot of the panel has no room under it, so the tip is placed against the panel it lives in,
  // and placed again whenever the panel scrolls or the window resizes under an open tip
  useLayoutEffect(() => {
    const el = tip.current;
    const row = el?.offsetParent as HTMLElement | null;
    if (!open || !el || !row) return;
    const measure = () => {
      const panel = el.closest('.side')?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
      setPlace(placeTip(row.getBoundingClientRect(), el.scrollHeight, panel));
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => { window.removeEventListener('scroll', measure, true); window.removeEventListener('resize', measure); };
  }, [open]);

  return (
    <span className="set-info" onPointerEnter={show} onPointerLeave={hide} onFocus={show} onBlur={hide}>
      <button type="button" aria-label="What this does" aria-describedby={`set-tip-${id}`} data-testid={`set-info-${id}`}>ⓘ</button>
      <span ref={tip} className="set-tip" role="tooltip" id={`set-tip-${id}`}
        data-open={open} data-place={place.above ? 'up' : 'down'}
        style={place.maxHeight ? { maxHeight: place.maxHeight } : undefined}>{children}</span>
    </span>
  );
}

function Opacity({ label, name, value, info }: { label: string; name: 'cardOpacity' | 'fullOpacity'; value: number; info?: ReactNode }) {
  return (
    <div className="row">
      <span>{label}{info}</span>
      <b className="set-slider">
        <input type="range" aria-label={label} data-testid={`set-${name}`} min={OPACITY.min} max={OPACITY.max} step={OPACITY.step}
          value={value} onChange={(e) => set({ [name]: Number(e.target.value) })} />
        <span className="tnum">{Math.round(value * 100)}%</span>
      </b>
    </div>
  );
}

function Phone() {
  const status = useApp((s) => s.mobile);
  const blocked = status?.error;
  useEffect(() => loadMobileStatus(deps()), []);
  return (
    <>
      <div className="kicker">Your phone</div>
      <div className="rows">
        <div className="row">
          <span>serve this fleet<Info id="phone">Serves this fleet's own page on your tailnet only, never the open internet. Needs <a href="https://tailscale.com/download" target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); openUrl(app.bridge, e.currentTarget.href); }}>Tailscale</a> signed in on this Mac and on the phone. On the phone, use Share → Add to Home Screen. The Phone button at the bottom of the island sidebar shows the link and a QR code.</Info></span>
          <b>{blocked ? <span data-testid="set-mobile-blocked">unavailable</span> : <MobileSwitch testId="set-mobile" />}</b>
        </div>
        {status?.serving && (
          <>
            <div className="row">
              <span>link</span>
              <b title={status.url}>{status.url}</b>
            </div>
            <div className="row">
              <span>on your phone</span>
              <b data-testid="set-mobile-here">{phonesHere(status.phones, 'nobody')}</b>
            </div>
          </>
        )}
      </div>
      {(blocked || status?.pageMissing) && (
        <div className="desc">{blocked ?? <b data-testid="set-mobile-nopage">{NO_PAGE}</b>}</div>
      )}
    </>
  );
}

// 0 is never, the longest wait of all
const DORMANCY = [4, 12, 24, 72, 0];
const dormancyLabel = (h: number) => (h === 0 ? 'never' : h % 24 ? `${h} hours` : h === 24 ? '1 day' : `${h / 24} days`);

function Dormancy() {
  const hours = useApp((s) => s.fleet.dormantAfterHours ?? DORMANT_AFTER_HOURS);
  const at = DORMANCY.indexOf(hours);
  const step = (by: -1 | 1) => DORMANCY[at + by];
  return (
    <div className="row">
      <span>dormant after<Info id="dormancy">An agent left idle this long is closed, freeing the memory it and its tools hold. Opening its terminal resumes the conversation where it stopped. One still running something in the background stays up.</Info></span>
      <b className="set-zoom">
        <button data-testid="dormancy-less" aria-label="Sooner" disabled={at <= 0} onClick={() => setDormancy(deps(), step(-1))}>−</button>
        <span className="tnum" data-testid="dormancy-level">{dormancyLabel(hours)}</span>
        <button data-testid="dormancy-more" aria-label="Later" disabled={at === DORMANCY.length - 1} onClick={() => setDormancy(deps(), step(1))}>+</button>
      </b>
    </div>
  );
}

function Scribe() {
  const on = useApp((s) => !s.fleet.scribeOff && !s.fleet.scribeAsk);
  const error = useApp((s) => s.fleet.scribeError);
  const flip = () => setScribe(deps(), !on);
  return (
    <>
      <div className="kicker">The fleet</div>
      <div className="rows">
        <div className="row">
          <span>scribe<Info id="scribe">About a minute after an agent stops, the scribe updates the character's name, note and links, and its island's description. Each pass is one headless call to Claude, or to Codex when <code>scribe.agent</code> is <code>codex</code>. API keys may incur charges.</Info></span>
          <b><button className="set-switch" role="switch" aria-checked={on} data-testid="set-scribe" onClick={flip}>{on ? 'on' : 'off'}</button></b>
        </div>
        {error && (
          <div className="row" data-testid="set-scribe-error">
            <span>last failure</span>
            <b title={new Date(error.at).toLocaleString()}>{error.message}</b>
          </div>
        )}
        <Dormancy />
      </div>
    </>
  );
}

function Notifications() {
  const n = useApp((s) => s.settings.notifications);
  const permission = useApp((s) => s.notifyPermission);
  const setN = (patch: Partial<NotifySettings>) => set({ notifications: { ...n, ...patch } });
  // on is stored at once; the switch reads on only once macOS allows it too
  const shown = n.on && permission === 'granted';
  const flip = () => {
    if (shown) { setN({ on: false }); return; }
    setN({ on: true });
    if (permission === 'unknown') app.bridge.send({ type: 'notify.enable' });
  };
  const toggle = (id: string, on: boolean, change: () => void) => (
    <b><button className="set-switch" role="switch" aria-checked={on} data-testid={id} onClick={change}>{on ? 'on' : 'off'}</button></b>
  );
  const event = (status: PushStatus, label: string) => {
    const on = n.statuses.includes(status);
    return (
      <div className="row">
        <span>{label}</span>
        {toggle(`set-notify-${status}`, on, () => setN({ statuses: on ? n.statuses.filter((x) => x !== status) : [...n.statuses, status] }))}
      </div>
    );
  };
  return (
    <>
      <div className="kicker">Notifications</div>
      <div className="rows">
        <div className="row">
          <span>notifications<Info id="notify">A macOS banner when a character needs you or is done, unless it's the one you're looking at. When it needs you, the banner's Approve and Deny answer without opening the app.</Info></span>
          <b><button className="set-switch" role="switch" aria-checked={shown} data-testid="set-notify" disabled={permission === 'denied'} onClick={flip}>{shown ? 'on' : 'off'}</button></b>
        </div>
        {shown && (
          <>
            <div className="row">
              <span>sound</span>
              {toggle('set-notify-sound', n.sound, () => setN({ sound: !n.sound }))}
            </div>
            {event('blocked', 'needs you')}
            {event('done', 'is done')}
          </>
        )}
      </div>
      {permission === 'denied' && (
        <>
          <div className="desc" data-testid="set-notify-denied">macOS has notifications turned off for Archipelago.</div>
          <div className="opens">
            <button className="btn" data-testid="set-notify-settings" onClick={() => app.bridge.send({ type: 'notify.settings' })}>Open System Settings</button>
          </div>
        </>
      )}
    </>
  );
}

export function SettingsCard() {
  const { cardOpacity, fullOpacity, zoom, onePassword, usageTab, autoArrange, bindings } = useApp((s) => s.settings);
  const zoomOut = keyLabel('zoomOut', bindings), zoomReset = keyLabel('zoomReset', bindings);
  // on its shipped chord zoom in also answers ⌘+, the name macOS gives the key
  const zoomIn = chordsOf('zoomIn', bindings).includes('cmd++') ? chordLabel('cmd++') : keyLabel('zoomIn', bindings);
  const fillKey = keyLabel('fillLogin', bindings);
  const op = useApp((s) => !!s.shell?.op);
  const fills = useApp(canFill);
  const shell = app.bridge.present;
  return (
    <aside className="side" data-testid="settings">
      {/* kept in this window's storage, not the fleet's: another machine on the same fleet keeps its own */}
      <div className="kicker">
        This machine
        <span className="spacer" />
        <button className="side-x" data-testid="settings-close" title={keyTip('Close', 'toggleSettings', bindings)} aria-label="Close the settings"
          onClick={() => app.store.getState().toggleSettings(false)}>×</button>
      </div>
      <h2 className="h2">Settings</h2>
      <div className="rows">
        <div className="row">
          <span>zoom<Info id="zoom">{zoomOut && zoomIn ? `${zoomOut} and ${zoomIn} scale` : 'Scales'} the map, the panels and the terminal's text together.{zoomReset && ` ${zoomReset} is 100%.`}</Info></span>
          <b className="set-zoom">
            <button data-testid="zoom-out" aria-label="Smaller" onClick={() => set({ zoom: zoomBy(zoom, -1) })}>−</button>
            <span className="tnum" data-testid="zoom-level">{Math.round(zoom * 100)}%</span>
            <button data-testid="zoom-in" aria-label="Bigger" onClick={() => set({ zoom: zoomBy(zoom, 1) })}>+</button>
          </b>
        </div>
      </div>
      <div className="rows">
        <Opacity label="terminal card" name="cardOpacity" value={cardOpacity}
          info={<Info id="opacity">How much of the map shows through a terminal, whether it floats as a card or fills the view.</Info>} />
        <Opacity label="full screen" name="fullOpacity" value={fullOpacity} />
      </div>
      <div className="rows">
        <div className="row">
          <span>arrange on its own<Info id="auto-arrange">Runs mission control's arrange for you, refitting the fleet to the map after you leave a full-screen card or resize the window.</Info></span>
          <b><button className="set-switch" role="switch" aria-checked={autoArrange} data-testid="set-auto-arrange"
            onClick={() => set({ autoArrange: !autoArrange })}>{autoArrange ? 'on' : 'off'}</button></b>
        </div>
        <div className="row">
          <span>usage meter<Info id="usage">Shows a Usage button at the bottom of the island sidebar, with how much of each plan limit the running agents have used and when it resets.</Info></span>
          <b><button className="set-switch" role="switch" aria-checked={usageTab} data-testid="set-usage-tab"
            onClick={() => { if (usageTab) app.store.getState().toggleUsage(false); set({ usageTab: !usageTab }); }}>{usageTab ? 'on' : 'off'}</button></b>
        </div>
      </div>
      <div className="opens">
        <button className="btn" data-testid="settings-ghostty" disabled={!shell} title="Font, colours and cursor for every terminal"
          onClick={() => openConfig(app.bridge, 'ghostty')}>Ghostty config</button>
        <button className="btn" data-testid="settings-fleet" disabled={!shell} title="Port, mission control and the fleet's defaults"
          onClick={() => openConfig(app.bridge, 'fleet')}>Fleet config</button>
      </div>
      <div className="kicker">The browser</div>
      <div className="rows">
        <div className="row">
          <span>1Password<Info id="1password">The key button beside the address bar{fillKey && `, or ${fillKey},`} fills the page's sign-in with the login saved for its site, or the one-time code when the page asks for one. 1Password asks for Touch ID.</Info></span>
          <b><button className="set-switch" role="switch" aria-checked={fills} data-testid="set-1password" disabled={!op}
            onClick={() => set({ onePassword: !onePassword })}>{fills ? 'on' : 'off'}</button></b>
        </div>
      </div>
      {!op && <div className="desc">Needs the 1Password CLI: run <code>brew install 1password-cli</code>, then turn on Integrate with 1Password CLI in 1Password's Developer settings.</div>}
      <div className="opens">
        <button className="btn" data-testid="settings-cookies" disabled={!shell} title="Pick a Chrome profile to copy from"
          onClick={() => app.bridge.send({ type: 'browser.importCookies' })}>Import Chrome cookies</button>
        <Info id="cookies">Copies a Chrome profile's cookies into the fleet's browser once, so the sites you're signed in to in Chrome are signed in here too. macOS asks before handing over the key that decrypts them.</Info>
      </div>
      <div className="kicker">The keyboard</div>
      <div className="rows">
        <div className="row">
          <span>keyboard shortcuts<Info id="keys">Lists every shortcut Archipelago handles. Only the chords listed there reach the app; every other ⌘ chord goes straight to the terminal.</Info></span>
          <b><button className="btn set-open" data-testid="settings-keys" onClick={() => app.store.getState().toggleKeys(true)}>Edit</button></b>
        </div>
      </div>
      {shell && <Notifications />}
      <Phone />
      <Scribe />
    </aside>
  );
}
