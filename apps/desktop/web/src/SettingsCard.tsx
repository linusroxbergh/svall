import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AGENT_LABEL, AgentKind, DORMANT_AFTER_HOURS, MODELS, fleetNameProblem, placingOn, type PushStatus } from '@svall/protocol';
import { loadMobileStatus, renameFleet, setDormancy, setMainAgent, setModel, setPlacing, setScribe, setWorktrees } from './actions.js';
import { app, deps } from './boot.js';
import { openConfig, openUrl, shim, type MachineRow } from './bridge.js';
import { holdCutout } from './cutout.js';
import { AS_TYPED } from './Field.js';
import { useApp } from './hooks.js';
import { MachineActions } from './HostSetup.js';
import { Info } from './Info.js';
import { Keybindings } from './Keybindings.js';
import { chordLabel, chordsOf, keyLabel, keyTip } from './keys.js';
import { MobileSwitch } from './PhonePanel.js';
import { NO_PAGE, phonesHere } from './phoneText.js';
import { directoryName, NO_AGENTS } from './selectors.js';
import { canFill, OPACITY, zoomBy, type KeepAwake, type NotifySettings, type Settings } from './settings.js';

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
      <div className="rows">
        <div className="row">
          <span>serve this fleet<Info id="phone">Reachable only on your tailnet. Needs <a href="https://tailscale.com/download" target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); openUrl(app.bridge, e.currentTarget.href); }}>Tailscale</a> on this Mac and the phone.</Info></span>
          <b>{blocked ? <span data-testid="set-mobile-blocked">unavailable</span> : <MobileSwitch testId="set-mobile" />}</b>
        </div>
        {status?.serving && (
          <>
            <div className="row">
              <span>link</span>
              <b data-tip={status.url}>{status.url}</b>
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

function MainAgent() {
  const main = useApp((s) => s.fleet.mainAgent ?? 'claude');
  const found = useApp((s) => s.fleet.agentsFound ?? NO_AGENTS);
  return (
    <div className="row">
      <span>main agent<Info id="main-agent">What mission control, the scribe and <code>{shim()} robot new --run</code> start. A <code>home.command</code> in fleet.json overrides it for the crew.</Info></span>
      <b><select className="fld inline" aria-label="Main agent" value={main} data-testid="set-main-agent"
        onChange={(e) => setMainAgent(deps(), e.target.value as AgentKind)}>
        {AgentKind.options.map((k) => (
          <option key={k} value={k} disabled={!found.includes(k) && k !== main}>
            {found.includes(k) ? AGENT_LABEL[k] : `${AGENT_LABEL[k]} (not found: install it, then ${shim()} setup)`}
          </option>
        ))}
      </select></b>
    </div>
  );
}

// the models `agent`'s CLI takes, the one set when it is none of them, and the default, which drops the pick; none for OpenCode
function ModelPick({ of, agent, model, label }: { of: 'scribe' | 'home'; agent: AgentKind; model: string | undefined; label: string }) {
  const models = MODELS[agent];
  if (!models.length) return null;
  const options = model && !models.includes(model) ? [model, ...models] : models;
  return (
    <div className="row">
      <span>{label}</span>
      <b><select className="fld inline" aria-label={label} value={model ?? ''} data-testid={`set-${of}-model`}
        onChange={(e) => setModel(deps(), of, agent, e.target.value || undefined)}>
        <option value="">{model ? 'default' : `${AGENT_LABEL[agent]}'s own`}</option>
        {options.map((m) => <option key={m} value={m}>{m}</option>)}
      </select></b>
    </div>
  );
}

function HomeModel() {
  const main = useApp((s) => s.fleet.mainAgent ?? 'claude');
  const model = useApp((s) => s.fleet.home.model);
  return <ModelPick of="home" agent={main} model={model} label="mission control model" />;
}

function ScribeModel() {
  const agent = useApp((s) => s.fleet.scribeAgent ?? 'claude');
  const model = useApp((s) => s.fleet.scribeModel);
  return <ModelPick of="scribe" agent={agent} model={model} label="scribe model" />;
}

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
        <span>name<Info id="fleet-name"><code>{shim()} &lt;name&gt;</code> opens this fleet from a terminal.</Info></span>
        <b><input className="fld inline" aria-label="Fleet name" data-testid="set-fleet-name" key={name} defaultValue={name ?? ''} {...AS_TYPED}
          placeholder={home ? directoryName(home) : undefined}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} onBlur={(e) => save(e.currentTarget)} /></b>
      </div>
      {error && <div className="row" data-testid="set-fleet-name-error"><span /><b className="fleet-error">{error}</b></div>}
    </>
  );
}

const checked = (c: NonNullable<MachineRow['check']>): string => {
  const when = new Date(c.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const found = c.failed ? `${c.failed} ${c.failed === 1 ? 'check' : 'checks'} failed` : c.warned ? `${c.warned} ${c.warned === 1 ? 'warning' : 'warnings'}` : 'ready';
  return `checked ${when}: ${found}`;
};

function Machines() {
  const machines = useApp((s) => s.machines);
  const error = useApp((s) => s.machinesError);
  const list = () => { app.bridge.send({ type: 'host.list' }); };
  useEffect(list, []);
  return (
    <div className="rows" data-testid="machines">
      {machines && !machines.some((m) => m.ssh) && (
        <div className="row" data-testid="machines-empty"><span>A machine is a Linux computer that runs this fleet's robots while this Mac sleeps.</span></div>
      )}
      {machines?.filter((m) => m.ssh).map((m) => (
        <div key={m.id} className="machine" data-testid={`machine-${m.name}`}>
          <div className="row">
            <span><b>{m.name}</b> {m.ssh}</span>
            <b className="machine-said">
              {[m.check?.release ? `release ${m.check.release}` : '', m.check ? checked(m.check) : 'not checked yet']
                .filter(Boolean).join(' · ')}
            </b>
          </div>
          <MachineActions name={m.name} />
        </div>
      ))}
      {error && (
        <div className="row" data-testid="machines-error">
          <span>{error}</span>
          <b><button className="btn set-open" data-testid="machines-reload" onClick={list}>Read again</button></b>
        </div>
      )}
      <div className="row">
        <span>another machine<Info id="hosts">Svall installs itself on a Linux machine over ssh and reports what is left to do. From a terminal: <code>svall host</code></Info></span>
        <b><button className="btn set-open" data-testid="machine-add" onClick={() => app.store.getState().toggleHost(true)}>Add machine</button></b>
      </div>
    </div>
  );
}

function Scribe() {
  const on = useApp((s) => !s.fleet.scribeOff && !s.fleet.scribeAsk);
  const error = useApp((s) => s.fleet.scribeError);
  const scribeAgent = useApp((s) => s.fleet.scribeAgent ?? 'claude');
  const flip = () => setScribe(deps(), !on);
  const placing = useApp((s) => placingOn(s.fleet));
  const worktrees = useApp((s) => !s.fleet.worktreesOff);
  return (
    <>
      <div className="rows">
        <FleetName />
        <MainAgent />
        <HomeModel />
        <div className="row">
          <span>scribe<Info id="scribe">Updates names, notes and links after an agent stops. Each pass is a headless {AGENT_LABEL[scribeAgent]} call and may cost API credits.</Info></span>
          <b><button className="set-switch" role="switch" aria-checked={on} data-testid="set-scribe" onClick={flip}>{on ? 'on' : 'off'}</button></b>
        </div>
        <div className="row" data-testid="set-placing-row" data-dim={!on}>
          <span>board placing<Info id="placing">Each scribe pass also chooses the robot&apos;s board column from your column names. A robot moved by hand is left alone. Needs the scribe.</Info></span>
          <b>{on
            ? <button className="set-switch" role="switch" aria-checked={placing} data-testid="set-placing" onClick={() => setPlacing(deps(), !placing)}>{placing ? 'on' : 'off'}</button>
            : 'needs the scribe'}</b>
        </div>
        <ScribeModel />
        {error && (
          <div className="row" data-testid="set-scribe-error">
            <span>last failure</span>
            <b data-tip={new Date(error.at).toLocaleString()}>{error.message}</b>
          </div>
        )}
        <div className="row">
          <span>work in worktrees<Info id="worktrees">Each agent in a git repo is told to make a new worktree for its task and leave the main checkout alone unless you say so.</Info></span>
          <b><button className="set-switch" role="switch" aria-checked={worktrees} data-testid="set-worktrees" onClick={() => setWorktrees(deps(), !worktrees)}>{worktrees ? 'on' : 'off'}</button></b>
        </div>
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
    if (permission !== 'granted') app.bridge.send({ type: 'notify.enable' });
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
      <div className="rows">
        <div className="row">
          <span>notifications<Info id="notify">macOS banners when a robot needs you or is done. Approve and Deny work from the banner.</Info></span>
          <b><button className="set-switch" role="switch" aria-checked={shown} data-testid="set-notify" onClick={flip}>{shown ? 'on' : 'off'}</button></b>
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

function Update() {
  const version = useApp((s) => s.update);
  if (!version) return null;
  return (
    <>
      <div className="rows">
        <div className="row">
          <span>Svall {version} is out</span>
          <b><button className="btn set-open" data-testid="set-update" onClick={() => app.bridge.send({ type: 'update.install' })}>Update</button></b>
        </div>
      </div>
    </>
  );
}

// kept in this window's storage, not the fleet's: another machine on the same fleet keeps its own
function Machine() {
  const { cardOpacity, fullOpacity, zoom, usageTab, autoArrange, cardLinks, robotMotion, bindings, keepAwake } = useApp((s) => s.settings);
  const zoomOut = keyLabel('zoomOut', bindings), zoomReset = keyLabel('zoomReset', bindings);
  // on its shipped chord zoom in also answers ⌘+, the name macOS gives the key
  const zoomIn = chordsOf('zoomIn', bindings).includes('cmd++') ? chordLabel('cmd++') : keyLabel('zoomIn', bindings);
  const shell = app.bridge.present;
  return (
    <>
      <div className="rows">
        <div className="row">
          <span>zoom<Info id="zoom">{zoomOut && zoomIn ? `${zoomOut} and ${zoomIn} scale` : 'Scales'} the map, panels and terminal text.{zoomReset && ` ${zoomReset} sets 100%.`}</Info></span>
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
          <span>arrange on its own<Info id="auto-arrange">Arranges the fleet when you come back to the map, show a hidden island or resize the window.</Info></span>
          <b><button className="set-switch" role="switch" aria-checked={autoArrange} data-testid="set-auto-arrange"
            onClick={() => set({ autoArrange: !autoArrange })}>{autoArrange ? 'on' : 'off'}</button></b>
        </div>
        <div className="row">
          <span>links on cards<Info id="card-links">Link chips beside each card on the map. Hovering a card lists its links either way.</Info></span>
          <b><button className="set-switch" role="switch" aria-checked={cardLinks} data-testid="set-card-links"
            onClick={() => set({ cardLinks: !cardLinks })}>{cardLinks ? 'on' : 'off'}</button></b>
        </div>
        <div className="row">
          <span>usage meter<Info id="usage">A sidebar button showing plan limits and when they reset.</Info></span>
          <b><button className="set-switch" role="switch" aria-checked={usageTab} data-testid="set-usage-tab"
            onClick={() => { if (usageTab) app.store.getState().toggleUsage(false); set({ usageTab: !usageTab }); }}>{usageTab ? 'on' : 'off'}</button></b>
        </div>
        <div className="row">
          <span>robot motion<Info id="robot-motion">Robots on the map act now and then, and stand still while a terminal is open.</Info></span>
          <b><button className="set-switch" role="switch" aria-checked={robotMotion} data-testid="set-robot-motion"
            onClick={() => set({ robotMotion: !robotMotion })}>{robotMotion ? 'on' : 'off'}</button></b>
        </div>
        {shell && (
          <div className="row">
            <span>keep Mac awake<Info id="keep-awake">Stops idle sleep so agents keep running and your phone reaches the fleet. The screen still dims and locks, and nothing is held on battery. A server an agent leaves running keeps it awake up to 30 minutes after an agent last did something, and so does a robot waiting on you or your phone when set to need you. Each fleet sets its own.</Info></span>
            <b><select className="fld inline" aria-label="Keep Mac awake" value={keepAwake} data-testid="set-keep-awake"
              onChange={(e) => set({ keepAwake: e.target.value as KeepAwake })}>
              <option value="off">off</option>
              <option value="working">while agents work</option>
              <option value="needs">while agents work or need you</option>
            </select></b>
          </div>
        )}
      </div>
      <div className="opens">
        <button className="btn" data-testid="settings-ghostty" disabled={!shell} data-tip="Terminal font, colours and cursor"
          onClick={() => openConfig(app.bridge, 'ghostty')}>Ghostty config</button>
        <button className="btn" data-testid="settings-fleet" disabled={!shell} data-tip="Mission control, fleet defaults, scribe and phone logins"
          onClick={() => openConfig(app.bridge, 'fleet')}>Fleet config</button>
      </div>
    </>
  );
}

function Browser() {
  const onePassword = useApp((s) => s.settings.onePassword);
  const op = useApp((s) => !!s.shell?.op);
  const fills = useApp(canFill);
  const shell = app.bridge.present;
  return (
    <>
      <div className="rows">
        <div className="row">
          <span>1Password<Info id="1password">The key button by the address bar fills the saved login or one-time code.</Info></span>
          <b><button className="set-switch" role="switch" aria-checked={fills} data-testid="set-1password" disabled={!op}
            onClick={() => set({ onePassword: !onePassword })}>{fills ? 'on' : 'off'}</button></b>
        </div>
      </div>
      {!op && <div className="desc">Run <code>brew install 1password-cli</code>, then turn on Integrate with 1Password CLI in 1Password's Developer settings.</div>}
      <div className="opens">
        <button className="btn" data-testid="settings-cookies" disabled={!shell} data-tip="Pick a Chrome profile to copy from"
          onClick={() => app.bridge.send({ type: 'browser.importCookies' })}>Import Chrome cookies</button>
        <Info id="cookies">A one-time copy, so your Chrome sign-ins work here too.</Info>
      </div>
    </>
  );
}

const PANES = [
  ['machine', 'This machine', Machine], ['browser', 'Browser', Browser], ['keyboard', 'Keyboard', Keybindings],
  ['notifications', 'Notifications', Notifications], ['phone', 'Phone', Phone], ['fleet', 'The fleet', Scribe], ['machines', 'Machines', Machines],
  ['updates', 'Updates', Update],
] as const;

// a window of its own over the middle of the app, so the terminals its sliders change stay in sight around it
export function SettingsCard() {
  const bindings = useApp((s) => s.settings.bindings);
  const update = useApp((s) => s.update);
  const shell = app.bridge.present;
  const box = useRef<HTMLDivElement>(null);
  // the Machines panel covers it, and a terminal that panel shows must not give up the window's rect
  const covered = useApp((s) => s.hostOpen);
  useEffect(() => (box.current && !covered ? holdCutout(app.bridge, box.current) : undefined), [covered]);
  const ask = useApp((s) => s.settingsAsk);
  const [picked, pick] = useState<string>(ask?.pane ?? 'machine');
  useEffect(() => { if (ask) pick(ask.pane); }, [ask]);
  // banners need the shell, and Updates stands only while one waits; a pane that goes leaves the first in its place
  const tabs = PANES.filter(([p]) => (p !== 'notifications' || shell) && (p !== 'updates' || update));
  const [pane, , Shown] = tabs.find(([p]) => p === picked) ?? tabs[0];
  return (
    <div className="set-win dialog" ref={box} data-testid="settings" role="dialog" aria-label="Settings">
      <div className="set-bar">
        <h2>Settings</h2>
        <button className="side-x" data-testid="settings-close" data-tip={keyTip('Close', 'toggleSettings', bindings)} aria-label="Close the settings"
          onClick={() => app.store.getState().toggleSettings(false)}>×</button>
      </div>
      <nav className="set-nav" role="tablist" aria-orientation="vertical">
        {tabs.map(([p, label]) => (
          <button key={p} className="list-row" role="tab" aria-selected={p === pane} data-testid={`settings-tab-${p}`} onClick={() => pick(p)}>
            {label}{p === 'updates' && <i aria-hidden="true" />}
          </button>
        ))}
      </nav>
      <div className="side" role="tabpanel">
        <Shown />
      </div>
    </div>
  );
}
