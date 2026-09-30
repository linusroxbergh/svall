import { useEffect, useState, type ReactNode } from 'react';
import { AGENT_LABEL, AgentKind, DORMANT_AFTER_HOURS, fleetNameProblem, type PushStatus } from '@svall/protocol';
import { loadMobileStatus, renameFleet, setDormancy, setMainAgent, setScribe } from './actions.js';
import { app, deps } from './boot.js';
import { openConfig, openUrl } from './bridge.js';
import { useApp } from './hooks.js';
import { Info } from './Info.js';
import { chordLabel, chordsOf, keyLabel, keyTip } from './keys.js';
import { MobileSwitch } from './PhonePanel.js';
import { NO_PAGE, phonesHere } from './phoneText.js';
import { directoryName } from './selectors.js';
import { canFill, OPACITY, zoomBy, type NotifySettings, type Settings } from './settings.js';

const set = (patch: Partial<Settings>) => app.store.getState().setSettings(patch);

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
          <span>serve this fleet<Info id="phone">Reachable only on your tailnet. Needs <a href="https://tailscale.com/download" target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); openUrl(app.bridge, e.currentTarget.href); }}>Tailscale</a> on this Mac and the phone.</Info></span>
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
const DORMANCY = [...Array.from({ length: 24 }, (_, n) => 2 * (n + 1)), 0];
const dormancyLabel = (h: number) => (h === 0 ? 'never' : h % 24 ? `${h} hours` : h === 24 ? '1 day' : `${h / 24} days`);
const rank = (h: number) => (h === 0 ? Infinity : h);

function Dormancy() {
  const hours = useApp((s) => s.fleet.dormantAfterHours ?? DORMANT_AFTER_HOURS);
  // a wait off the steps moves to the nearest step either side
  const less = DORMANCY.filter((h) => rank(h) < rank(hours)).at(-1);
  const more = DORMANCY.find((h) => rank(h) > rank(hours));
  return (
    <div className="row">
      <span>close idle agents after<Info id="dormancy">Frees memory. Opening the terminal resumes the conversation, and agents with background work stay up.</Info></span>
      <b className="set-zoom">
        <button data-testid="dormancy-less" aria-label="Sooner" disabled={less === undefined} onClick={() => setDormancy(deps(), less!)}>−</button>
        <span className="tnum" data-testid="dormancy-level">{dormancyLabel(hours)}</span>
        <button data-testid="dormancy-more" aria-label="Later" disabled={more === undefined} onClick={() => setDormancy(deps(), more!)}>+</button>
      </b>
    </div>
  );
}

// a stable identity, so a selector defaulting to "no CLIs found" does not retrigger on every render
const NO_AGENTS: AgentKind[] = [];

function MainAgent() {
  const main = useApp((s) => s.fleet.mainAgent ?? 'claude');
  const found = useApp((s) => s.fleet.agentsFound ?? NO_AGENTS);
  return (
    <div className="row">
      <span>main agent<Info id="main-agent">What mission control, the scribe and <code>svall char new --run</code> start. A <code>home.command</code> in config.json overrides it for the crew.</Info></span>
      <b><select className="fld inline" aria-label="Main agent" value={main} data-testid="set-main-agent"
        onChange={(e) => setMainAgent(deps(), e.target.value as AgentKind)}>
        {AgentKind.options.map((k) => (
          <option key={k} value={k} disabled={!found.includes(k) && k !== main}>
            {found.includes(k) ? AGENT_LABEL[k] : `${AGENT_LABEL[k]} (not found: install it, then svall setup)`}
          </option>
        ))}
      </select></b>
    </div>
  );
}

// only the label changes; an empty or unchanged field writes nothing
function FleetName() {
  const name = useApp((s) => s.fleet.name);
  const home = useApp((s) => s.shell?.home ?? window.__svallHome);
  const [error, setError] = useState<string>();
  const save = (input: HTMLInputElement) => {
    const next = input.value.trim();
    if (!next || next === name) { input.value = name ?? ''; setError(undefined); return; }
    const problem = fleetNameProblem(next, []);
    if (problem) { setError(problem); return; }
    renameFleet(deps(), next).then(() => setError(undefined), (e: Error) => setError(e.message));
  };
  return (
    <>
      <div className="row">
        <span>name<Info id="fleet-name"><code>svall &lt;name&gt;</code> opens this fleet from a terminal.</Info></span>
        <b><input className="fld inline" aria-label="Fleet name" data-testid="set-fleet-name" key={name} defaultValue={name ?? ''}
          placeholder={home ? directoryName(home) : undefined}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} onBlur={(e) => save(e.currentTarget)} /></b>
      </div>
      {error && <div className="row" data-testid="set-fleet-name-error"><span /><b className="fleet-error">{error}</b></div>}
    </>
  );
}

function Scribe() {
  const on = useApp((s) => !s.fleet.scribeOff && !s.fleet.scribeAsk);
  const error = useApp((s) => s.fleet.scribeError);
  const scribeAgent = useApp((s) => s.fleet.scribeAgent ?? 'claude');
  const flip = () => setScribe(deps(), !on);
  return (
    <>
      <div className="kicker">The fleet</div>
      <div className="rows">
        <FleetName />
        <MainAgent />
        <div className="row">
          <span>scribe<Info id="scribe">Updates names, notes and links after an agent stops. Each pass is a headless {AGENT_LABEL[scribeAgent]} call and may cost API credits.</Info></span>
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
          <span>notifications<Info id="notify">macOS banners when a character needs you or is done. Approve and Deny work from the banner.</Info></span>
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
          <div className="desc" data-testid="set-notify-denied">macOS has notifications turned off for Svall.</div>
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
          <span>zoom<Info id="zoom">{zoomOut && zoomIn ? `${zoomOut} and ${zoomIn} scale` : 'Scales'} the map, panels and terminal text.{zoomReset && ` ${zoomReset} resets.`}</Info></span>
          <b className="set-zoom">
            <button data-testid="zoom-out" aria-label="Smaller" onClick={() => set({ zoom: zoomBy(zoom, -1) })}>−</button>
            <span className="tnum" data-testid="zoom-level">{Math.round(zoom * 100)}%</span>
            <button data-testid="zoom-in" aria-label="Bigger" onClick={() => set({ zoom: zoomBy(zoom, 1) })}>+</button>
          </b>
        </div>
      </div>
      <div className="rows">
        <Opacity label="terminal card" name="cardOpacity" value={cardOpacity}
          info={<Info id="opacity">How much of the map shows through a terminal.</Info>} />
        <Opacity label="full screen" name="fullOpacity" value={fullOpacity} />
      </div>
      <div className="rows">
        <div className="row">
          <span>arrange on its own<Info id="auto-arrange">Arranges the fleet when you come back to the map or resize the window.</Info></span>
          <b><button className="set-switch" role="switch" aria-checked={autoArrange} data-testid="set-auto-arrange"
            onClick={() => set({ autoArrange: !autoArrange })}>{autoArrange ? 'on' : 'off'}</button></b>
        </div>
        <div className="row">
          <span>usage meter<Info id="usage">A sidebar button showing plan limits and when they reset.</Info></span>
          <b><button className="set-switch" role="switch" aria-checked={usageTab} data-testid="set-usage-tab"
            onClick={() => { if (usageTab) app.store.getState().toggleUsage(false); set({ usageTab: !usageTab }); }}>{usageTab ? 'on' : 'off'}</button></b>
        </div>
      </div>
      <div className="opens">
        <button className="btn" data-testid="settings-ghostty" disabled={!shell} title="Terminal font, colours and cursor"
          onClick={() => openConfig(app.bridge, 'ghostty')}>Ghostty config</button>
        <button className="btn" data-testid="settings-fleet" disabled={!shell} title="Port, mission control and fleet defaults"
          onClick={() => openConfig(app.bridge, 'fleet')}>Fleet config</button>
      </div>
      <div className="kicker">The browser</div>
      <div className="rows">
        <div className="row">
          <span>1Password<Info id="1password">The key button by the address bar{fillKey && `, or ${fillKey},`} fills the saved login or one-time code.</Info></span>
          <b><button className="set-switch" role="switch" aria-checked={fills} data-testid="set-1password" disabled={!op}
            onClick={() => set({ onePassword: !onePassword })}>{fills ? 'on' : 'off'}</button></b>
        </div>
      </div>
      {!op && <div className="desc">Run <code>brew install 1password-cli</code>, then turn on Integrate with 1Password CLI in 1Password's Developer settings.</div>}
      <div className="opens">
        <button className="btn" data-testid="settings-cookies" disabled={!shell} title="Pick a Chrome profile to copy from"
          onClick={() => app.bridge.send({ type: 'browser.importCookies' })}>Import Chrome cookies</button>
        <Info id="cookies">A one-time copy, so your Chrome sign-ins work here too.</Info>
      </div>
      <div className="kicker">The keyboard</div>
      <div className="rows">
        <div className="row">
          <span>keyboard shortcuts<Info id="keys">Unlisted ⌘ chords go to the terminal.</Info></span>
          <b><button className="btn set-open" data-testid="settings-keys" onClick={() => app.store.getState().toggleKeys(true)}>Edit</button></b>
        </div>
      </div>
      {shell && <Notifications />}
      <Phone />
      <Scribe />
    </aside>
  );
}
