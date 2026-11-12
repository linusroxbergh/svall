import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AGENT_LABEL, AgentKind, DORMANT_AFTER_HOURS, MODELS, fleetNameProblem, placingOn, type MachineId, type PushStatus, type Result } from '@svall/protocol';
import { AgentSetup } from './AgentSetup.js';
import { loadMobileStatus, renameFleet, setDormancy, setMainAgent, setModel, setPlacing, setScribe, setWorktrees } from './actions.js';
import { app, deps } from './boot.js';
import { copyText, openConfig, openUrl, shim, type MachineRow } from './bridge.js';
import { holdCutout } from './cutout.js';
import { AS_TYPED } from './Field.js';
import { useApp } from './hooks.js';
import { plural, splitRaw } from './host.js';
import { MachineActions } from './HostSetup.js';
import { Close, Minus, Plus } from './icons.js';
import { Group, Info } from './Info.js';
import { Keybindings } from './Keybindings.js';
import { chordLabel, chordsOf, keyLabel, keyTip } from './keys.js';
import { MobilePanel, MobileSwitch, PhoneProblem, useMobileSwitch } from './PhonePanel.js';
import { NO_PAGE, phonesHere } from './phoneText.js';
import { homeName } from './placement.js';
import { openFleetConfig } from './resources/docs.js';
import { Said } from './Said.js';
import { directoryName, NO_AGENTS } from './selectors.js';
import { canFill, OPACITY, SETTINGS_SIZE, zoomBy, type KeepAwake, type NotifySettings, type Settings } from './settings.js';
import { useWidthGrip } from './widthGrip.js';

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
  const sw = useMobileSwitch();
  const status = sw.status;
  const home = useApp((s) => s.via && homeName(s.fleet, s.via));
  const [copied, setCopied] = useState(false);
  const revert = useRef<number>(undefined);
  useEffect(() => { loadMobileStatus(deps()); return () => window.clearTimeout(revert.current); }, []);
  // the copied link pairs the phone, as the QR code does
  const copy = () => {
    if (!status) return;
    copyText(app.bridge, status.pair ?? status.url);
    setCopied(true);
    window.clearTimeout(revert.current);
    revert.current = window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Group name="Phone link">
      <div className="row">
        <span>phone link<Info id="phone">Reachable only on your tailnet; needs <a href="https://tailscale.com/download" target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); openUrl(app.bridge, e.currentTarget.href); }}>Tailscale</a> on {home ?? 'this Mac'} and the phone. After switching it off, turn notifications on again on each phone.</Info></span>
        <b>{status?.error ? <span data-testid="set-mobile-blocked">unavailable</span> : <MobileSwitch testId="set-mobile" sw={sw} />}</b>
      </div>
      {sw.busy && !status?.serving && <div className="set-note" data-testid="set-mobile-starting">Starting; the first time can take a few minutes.</div>}
      {status?.serving && (
        <>
          <div className="row">
            <span>address</span>
            <b><button className="btn ghost" data-testid="set-mobile-url" data-tip="Copy the link" onClick={copy}>{copied ? 'copied' : status.url}</button></b>
          </div>
          <div className="row">
            <span>connected</span>
            <b data-testid="set-mobile-here">{phonesHere(status.phones, 'nobody')}</b>
          </div>
        </>
      )}
      {status && (
        <div className="row">
          <span>who can connect<Info id="phone-logins">Tailscale logins that may open this fleet. To change them, list every login in mobile.logins in fleet.json, then restart Svall.</Info></span>
          <b data-testid="set-mobile-logins">{status.logins.length ? status.logins.join(', ') : 'nobody yet'}</b>
        </div>
      )}
      {status?.serving && (
        <div className="set-qr">
          <MobilePanel compact="qr" />
          <span className="set-note">Scan with your phone. Then: Share → Add to Home Screen, and open Svall from the new icon.</span>
        </div>
      )}
      <PhoneProblem settings />
      {status?.pageMissing && <div className="set-note" data-testid="set-mobile-nopage">{NO_PAGE}</div>}
    </Group>
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
      <span>close idle agents after<Info id="dormancy">Frees memory. Opening the terminal resumes the conversation; agents with background work stay up.</Info></span>
      <b className="set-zoom">
        <button className="ib filled" data-testid="dormancy-less" aria-label="Sooner" disabled={less === undefined} onClick={() => setDormancy(deps(), less!)}><Minus /></button>
        <span className="tnum" data-testid="dormancy-level">{dormancyLabel(hours)}</span>
        <button className="ib filled" data-testid="dormancy-more" aria-label="Later" disabled={more === undefined} onClick={() => setDormancy(deps(), more!)}><Plus /></button>
      </b>
    </div>
  );
}

function MainAgent() {
  const main = useApp((s) => s.fleet.mainAgent ?? 'claude');
  const found = useApp((s) => s.fleet.agentsFound ?? NO_AGENTS);
  return (
    <div className="row">
      <span>main agent<Info id="main-agent">What mission control, the scribe and new robots start.</Info></span>
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
      {error && <div className="set-note fleet-error" data-testid="set-fleet-name-error">{error}</div>}
    </>
  );
}

const when = (at: number): string => new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const checked = (c: NonNullable<MachineRow['check']>): string =>
  `checked ${when(c.at)} · ${c.failed ? `${plural(c.failed, 'check')} failed` : c.warned ? plural(c.warned, 'warning') : 'ready'}`;
const DOT = { ok: 'reachable', off: 'not reachable', upgrade: 'needs an upgrade' } as const;
const ROLE_TIP = { home: 'Holds the fleet and starts new robots.', worker: 'Runs robots moved to it.' } as const;

type FleetMachine = Result<'machines.list'>['machines'][number];

function Machines() {
  const machines = useApp((s) => s.machines);
  const error = useApp((s) => s.machinesError);
  const via = useApp((s) => s.via);
  const links = useApp((s) => s.fleet.machines);
  const home = useApp((s) => (s.via ? homeName(s.fleet, s.via) : 'this Mac'));
  const online = useApp((s) => s.status === 'online');
  const [fleetRows, setFleetRows] = useState<FleetMachine[]>();
  const [asks, setAsks] = useState(0);
  const list = () => { app.bridge.send({ type: 'host.list' }); };
  useEffect(list, []);
  // the fleet's machines as its home knows them; what this machine's registry adds is how it reaches one
  useEffect(() => {
    if (!online) return;
    let left = false;
    let again: ReturnType<typeof setTimeout> | undefined;
    deps().api.call('machines.list', {}).then((r) => { if (!left) setFleetRows(r.machines); }, () => { if (!left) again = setTimeout(() => setAsks((n) => n + 1), 5000); });
    return () => { left = true; clearTimeout(again); };
  }, [links, online, asks]);
  const registered = new Map(machines?.map((m) => [m.id, m]));
  const known = new Set<string>(fleetRows?.map((m) => m.id));
  const rows = [
    ...fleetRows?.map((f) => {
      const r = registered.get(f.id);
      return { id: f.id, name: r?.name ?? f.name, role: f.role as string | undefined, dialsIn: f.dialsIn, robots: f.robots as number | undefined, ssh: r?.ssh, check: r?.check,
        joining: f.joining, reachable: f.reachable as boolean | undefined, since: f.since, release: f.release ?? r?.check?.release };
    }) ?? [],
    // on a registry here and not yet a machine of this fleet
    ...machines?.filter((m) => m.ssh && !known.has(m.id)).map((m) => ({ id: m.id, name: m.name, role: undefined, dialsIn: undefined, robots: undefined, ssh: m.ssh, check: m.check,
      joining: undefined, reachable: undefined, since: undefined, release: m.check?.release })) ?? [],
  ];
  // a home on this Mac with no worker is what it always was
  const shown = !via && !rows.some((r) => r.role !== 'home') ? [] : rows;
  return (
    <Group name="Machines" info={<Info id="machines">The home holds the fleet and starts new robots. A worker runs robots moved to it.</Info>}
      end={(!via || via.online) && <button className="btn sm" data-testid="machine-add" onClick={() => app.store.getState().toggleHost(true)}>Add machine</button>}>
      <div data-testid="machines">
        {machines === undefined && !error && app.bridge.present && <div className="set-note"><span className="move-spin" />Reading the machines…</div>}
        {machines && !shown.length && (
          <div className="set-note" data-testid="machines-empty">No other machine yet. A Linux machine can run this fleet&apos;s robots while this Mac sleeps, or run the whole fleet.</div>
        )}
        {shown.map((m) => {
          const label = m.id === via?.machine || (m.role === 'home' && !via) ? 'this Mac' : m.name;
          const acts = !!m.ssh && (via ? m.role === 'home' || !!registered.get(m.id)?.far : m.role !== 'home');
          const mismatch = !!links?.[m.id as MachineId]?.mismatch;
          // a machine not in this fleet has no link to say anything of
          const dot = m.role === undefined ? undefined : mismatch ? 'upgrade' : m.reachable ? 'ok' : 'off';
          const robots = m.robots ? plural(m.robots, 'robot') : '';
          const meta = (m.dialsIn ? [`connects out to ${home}`, robots] : [m.ssh, robots, m.release && `release ${m.release}`]).filter(Boolean).join(' · ');
          const joining = m.joining ? splitRaw(m.joining) : undefined;
          return (
            <div key={m.id} className="machine" data-testid={`machine-${m.name}`} data-role={m.role}>
              {dot ? <i className="machine-dot" data-state={dot} role="img" aria-label={DOT[dot]} /> : <i />}
              <span className="machine-name">
                <b>{label}</b>
                {(m.role === 'home' || m.role === 'worker') && <span className={m.role === 'home' ? 'badge' : 'badge quiet'} data-tip={ROLE_TIP[m.role]}>{m.role}</span>}
              </span>
              {acts && <MachineActions id={m.id} name={m.name} home={m.role === 'home'} worker={!via && m.role === 'worker' && !m.dialsIn} />}
              {meta && <span className="machine-meta" data-tip={m.dialsIn ? `${label === 'this Mac' ? 'This Mac' : label} connects to ${home}; nothing connects in.` : undefined}>{meta}</span>}
              {m.joining !== undefined ? (
                <div className="machine-said" data-testid={`machine-joining-${m.name}`}>
                  <span>has not joined yet</span>
                  {joining && <Said line={joining.line} raw={joining.raw} settings />}
                </div>
              ) : dot === 'off' ? (
                <div className="machine-said">
                  <span>{m.since ? `not reachable since ${when(m.since)}` : 'not reachable'}</span>
                  {acts && m.role === 'worker' && <span className="set-note">Removed it by hand? Forget drops it from this list.</span>}
                </div>
              ) : mismatch ? <div className="machine-said">needs an upgrade</div>
                : m.role === 'home' ? null
                : m.check ? <div className="machine-said">{checked(m.check)}</div>
                : m.ssh ? <div className="machine-said">not checked yet</div> : null}
            </div>
          );
        })}
        {error && (
          <div className="row" data-testid="machines-error">
            <div className="set-said" data-error><Said {...splitRaw(error)} settings /></div>
            <b><button className="btn sm" data-testid="machines-reload" onClick={list}>Read again</button></b>
          </div>
        )}
      </div>
    </Group>
  );
}

function RobotPreferences() {
  const start = useApp((s) => s.fleet.newRobotStart ?? 'shell');
  const permissions = useApp((s) => s.fleet.svallPermissions ?? false);
  const set = (p: { newRobotStart?: 'agent' | 'shell'; svallPermissions?: boolean }) => {
    const d = deps();
    d.api.call('robotPreferences.set', p).catch((e: Error) => d.store.getState().showToast(e.message));
  };
  return <>
    <div className="row"><span>new robots start</span><b><select className="fld inline" aria-label="New robots start" value={start} onChange={(e) => set({ newRobotStart: e.target.value as 'agent' | 'shell' })}><option value="agent">Your main agent</option><option value="shell">A shell</option></select></b></div>
    <div className="row"><span>run svall without asking<Info id="svall-permissions">Robots can start, message and wait for other robots without a permission prompt. New sessions read this choice.</Info></span><b><button className="set-switch" role="switch" aria-label="Let robots run svall without asking" aria-checked={permissions} onClick={() => set({ svallPermissions: !permissions })}>{permissions ? 'on' : 'off'}</button></b></div>
  </>;
}

function Scribe() {
  const on = useApp((s) => !s.fleet.scribeOff && !s.fleet.scribeAsk);
  const error = useApp((s) => s.fleet.scribeError);
  const scribeAgent = useApp((s) => s.fleet.scribeAgent ?? 'claude');
  const flip = () => setScribe(deps(), !on);
  const placing = useApp((s) => placingOn(s.fleet));
  const worktrees = useApp((s) => !s.fleet.worktreesOff);
  const failure = error && splitRaw(error.message);
  return (
    <>
      <Group name="Fleet">
        <FleetName />
        <MainAgent />
        <HomeModel />
      </Group>
      <Group name="New robots">
        <RobotPreferences />
        <div className="row">
          <span>work in worktrees<Info id="worktrees">Agents in a git repo make a worktree for their task and leave the main checkout alone.</Info></span>
          <b><button className="set-switch" role="switch" aria-checked={worktrees} data-testid="set-worktrees" onClick={() => setWorktrees(deps(), !worktrees)}>{worktrees ? 'on' : 'off'}</button></b>
        </div>
      </Group>
      <Group name="Scribe">
        <div className="row">
          <span>scribe<Info id="scribe">Updates names, notes and links after an agent stops. Each pass is one headless {AGENT_LABEL[scribeAgent]} call.</Info></span>
          <b><button className="set-switch" role="switch" aria-checked={on} data-testid="set-scribe" onClick={flip}>{on ? 'on' : 'off'}</button></b>
        </div>
        <div className="row" data-testid="set-placing-row" data-dim={!on}>
          <span>board placing<Info id="placing">Each scribe pass also picks the robot&apos;s board column. A robot moved by hand is left alone.</Info></span>
          <b>{on
            ? <button className="set-switch" role="switch" aria-checked={placing} data-testid="set-placing" onClick={() => setPlacing(deps(), !placing)}>{placing ? 'on' : 'off'}</button>
            : 'needs the scribe'}</b>
        </div>
        <ScribeModel />
        {error && failure && (
          <div className="row" data-testid="set-scribe-error">
            <span>last failure</span>
            <div className="set-said" data-error data-tip={new Date(error.at).toLocaleString()}><Said line={failure.line} raw={failure.raw} settings /></div>
          </div>
        )}
      </Group>
      <Group name="Idle agents">
        <Dormancy />
      </Group>
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
    <Group name="Notifications">
      <div className="row">
        <span>notifications<Info id="notify">macOS banners when a robot needs you or is done. Approve and Deny work from the banner.</Info></span>
        <b><button className="set-switch" role="switch" aria-checked={shown} data-testid="set-notify" onClick={flip}>{shown ? 'on' : 'off'}</button></b>
      </div>
      {permission === 'denied' && (
        <div className="row" data-testid="set-notify-denied">
          <span>macOS</span>
          <b className="set-pair">off for Svall<button className="btn sm" data-testid="set-notify-settings" onClick={() => app.bridge.send({ type: 'notify.settings' })}>Open System Settings</button></b>
        </div>
      )}
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
    </Group>
  );
}

function Update() {
  const version = useApp((s) => s.update);
  if (!version) return null;
  return (
    <Group name="Updates">
      <div className="row">
        <span>Svall {version} is out</span>
        <b><button className="btn sm" data-testid="set-update" onClick={() => app.bridge.send({ type: 'update.install' })}>Update</button></b>
      </div>
    </Group>
  );
}

// kept in this window's storage, not the fleet's: another machine on the same fleet keeps its own
function Machine() {
  const { cardOpacity, fullOpacity, zoom, usageTab, autoArrange, cardLinks, robotMotion, bindings, keepAwake } = useApp((s) => s.settings);
  const zoomOut = keyLabel('zoomOut', bindings), zoomReset = keyLabel('zoomReset', bindings);
  // on its shipped chord zoom in also answers ⌘+, the name macOS gives the key
  const zoomIn = chordsOf('zoomIn', bindings).includes('cmd++') ? chordLabel('cmd++') : keyLabel('zoomIn', bindings);
  const shell = app.bridge.present;
  const via = useApp((s) => s.via);
  const machines = useApp((s) => s.fleet.machines);
  // a worker holds no fleet's config, so with no way to the home there is none to open
  const apart = !!via && (!via.online || via.served === true);
  const home = via && homeName({ machines }, via);
  return (
    <>
      <Group name="Display">
        <div className="row">
          <span>zoom<Info id="zoom">{zoomOut && zoomIn ? `${zoomOut} and ${zoomIn} scale` : 'Scales'} the map, panels and terminal text.{zoomReset && ` ${zoomReset} sets 100%.`}</Info></span>
          <b className="set-zoom">
            <button className="ib filled" data-testid="zoom-out" aria-label="Smaller" onClick={() => set({ zoom: zoomBy(zoom, -1) })}><Minus /></button>
            <span className="tnum" data-testid="zoom-level">{Math.round(zoom * 100)}%</span>
            <button className="ib filled" data-testid="zoom-in" aria-label="Bigger" onClick={() => set({ zoom: zoomBy(zoom, 1) })}><Plus /></button>
          </b>
        </div>
        <Opacity label="terminal card" name="cardOpacity" value={cardOpacity}
          info={<Info id="opacity">How much of the map shows through a terminal.</Info>} />
        <Opacity label="full screen" name="fullOpacity" value={fullOpacity} />
      </Group>
      <Group name="Map">
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
          <span>robot motion<Info id="robot-motion">Robots on the map act now and then, and stand still while a terminal is open.</Info></span>
          <b><button className="set-switch" role="switch" aria-checked={robotMotion} data-testid="set-robot-motion"
            onClick={() => set({ robotMotion: !robotMotion })}>{robotMotion ? 'on' : 'off'}</button></b>
        </div>
        <div className="row">
          <span>usage meter<Info id="usage">A sidebar button showing plan limits and when they reset.</Info></span>
          <b><button className="set-switch" role="switch" aria-checked={usageTab} data-testid="set-usage-tab"
            onClick={() => { if (usageTab) app.store.getState().toggleUsage(false); set({ usageTab: !usageTab }); }}>{usageTab ? 'on' : 'off'}</button></b>
        </div>
      </Group>
      {shell && (
        <Group name="Power">
          <div className="row">
            <span>keep Mac awake<Info id="keep-awake">Stops idle sleep while agents work, so they keep running and your phone reaches the fleet. The screen still dims and locks, and nothing is held on battery.</Info></span>
            <b><select className="fld inline" aria-label="Keep Mac awake" value={keepAwake} data-testid="set-keep-awake"
              onChange={(e) => set({ keepAwake: e.target.value as KeepAwake })}>
              <option value="off">off</option>
              <option value="working">while agents work</option>
              <option value="needs">while agents work or need you</option>
            </select></b>
          </div>
        </Group>
      )}
      <Group name="Config files">
        <div className="row">
          <span>Ghostty config<Info id="ghostty-config">Terminal font, colours and cursor.</Info></span>
          <b><button className="btn sm" data-testid="settings-ghostty" aria-label="Open Ghostty config" disabled={!shell}
            onClick={() => openConfig(app.bridge, 'ghostty')}>Open</button></b>
        </div>
        <div className="row">
          <span>Fleet config<Info id="fleet-config">Mission control, fleet defaults, scribe and phone logins.</Info></span>
          <b><button className="btn sm" data-testid="settings-fleet" aria-label="Open Fleet config" disabled={!shell || apart}
            data-tip={via?.served ? `This window has no route to ${home}, where fleet.json is.` : apart ? `${home} is not reachable; its fleet.json is there.` : undefined}
            onClick={() => (via ? void openFleetConfig(deps()) : openConfig(app.bridge, 'fleet'))}>Open</button></b>
        </div>
      </Group>
    </>
  );
}

function Browser() {
  const onePassword = useApp((s) => s.settings.onePassword);
  const op = useApp((s) => !!s.shell?.op);
  const fills = useApp(canFill);
  const shell = app.bridge.present;
  return (
    <Group name="Sign-ins">
      <div className="row">
        <span>1Password<Info id="1password">The key button by the address bar fills the saved login or one-time code.</Info></span>
        <b><button className="set-switch" role="switch" aria-checked={fills} data-testid="set-1password" disabled={!op}
          onClick={() => set({ onePassword: !onePassword })}>{fills ? 'on' : 'off'}</button></b>
      </div>
      {!op && <div className="set-note" data-testid="set-1password-needs">Needs the 1Password CLI: <code>brew install 1password-cli</code>, then switch on Integrate with 1Password CLI in 1Password&apos;s Developer settings.</div>}
      <div className="row">
        <span>Chrome cookies<Info id="cookies">A one-time copy from a Chrome profile, so your Chrome sign-ins work here too.</Info></span>
        <b><button className="btn sm" data-testid="settings-cookies" aria-label="Import Chrome cookies" disabled={!shell}
          onClick={() => app.bridge.send({ type: 'browser.importCookies' })}>Import</button></b>
      </div>
    </Group>
  );
}

const PANES = [
  ['machine', 'This machine', Machine], ['browser', 'Browser', Browser], ['keyboard', 'Keyboard', Keybindings],
  ['notifications', 'Notifications', Notifications], ['phone', 'Phone', Phone], ['fleet', 'The fleet', Scribe], ['machines', 'Machines', Machines], ['setup', 'Agent setup', AgentSetup],
  ['updates', 'Updates', Update],
] as const;

// a window of its own over the middle of the app, so the terminals its sliders change stay in sight around it
export function SettingsCard() {
  const bindings = useApp((s) => s.settings.bindings);
  const update = useApp((s) => s.update);
  const shell = app.bridge.present;
  const box = useRef<HTMLDivElement>(null);
  const nav = useRef<HTMLElement>(null);
  // the Machines panel covers it, and a terminal that panel shows must not give up the window's rect
  const covered = useApp((s) => s.hostOpen);
  useEffect(() => (box.current && !covered ? holdCutout(app.bridge, box.current) : undefined), [covered]);
  const ask = useApp((s) => s.settingsAsk);
  const [picked, pick] = useState<string>(ask?.pane ?? 'machine');
  useEffect(() => { if (ask) pick(ask.pane); }, [ask]);
  // the window stays centred, so its corner moves half of what its size does; the size it lands on is kept on release
  const saved = useApp((s) => s.settings.settingsSize) ?? SETTINGS_SIZE;
  const [drag, setDrag] = useState<{ w: number; h: number }>();
  const size = drag ?? saved;
  const save = () => { if (drag && box.current) set({ settingsSize: { w: box.current.offsetWidth, h: box.current.offsetHeight } }); setDrag(undefined); };
  const wide = useWidthGrip(() => box.current!.offsetWidth, (from, dx) => setDrag((d) => ({ ...(d ?? saved), w: from + 2 * dx })), save);
  const tall = useWidthGrip(() => box.current!.offsetHeight, (from, dy) => setDrag((d) => ({ ...(d ?? saved), h: from + 2 * dy })), save, 'y');
  const grip = Object.fromEntries(Object.keys(wide).map((k) => [k, (e: React.PointerEvent<HTMLElement>) => {
    const on = k as keyof typeof wide;
    wide[on](e);
    tall[on](e);
  }]));
  // banners need the shell, and Updates stands only while one waits; a pane that goes leaves the first in its place
  const fallback = useApp((st) => !!st.via && (!st.via.online || st.via.served === true));
  // a window on the home holds its agent setup in the Mac's own folders
  const far = useApp((st) => !!st.via);
  // a worker's daemon holds no phone link, which is its home's to serve
  const tabs = PANES.filter(([p]) => (p !== 'notifications' || shell) && (p !== 'updates' || update) && (p !== 'phone' || !fallback) && (p !== 'setup' || far));
  const [pane, , Shown] = tabs.find(([p]) => p === picked) ?? tabs[0];
  const step = (e: React.KeyboardEvent) => {
    const at = tabs.findIndex(([p]) => p === pane);
    const to = ({ ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: tabs.length - 1 } as Record<string, number>)[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = (to + tabs.length) % tabs.length;
    pick(tabs[next][0]);
    nav.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div className="set-win dialog" ref={box} data-testid="settings" role="dialog" aria-label="Settings" style={{ width: size.w, height: size.h }}>
      <div className="set-bar">
        <h2>Settings</h2>
        <button className="ib side-x" data-testid="settings-close" data-tip={keyTip('Close', 'toggleSettings', bindings)} aria-label="Close the settings"
          onClick={() => app.store.getState().toggleSettings(false)}><Close /></button>
      </div>
      <nav ref={nav} className="set-nav" role="tablist" aria-orientation="vertical" onKeyDown={step}>
        {tabs.map(([p, label]) => (
          <button key={p} id={`set-tab-${p}`} className="list-row" role="tab" aria-selected={p === pane} aria-controls="set-panel" tabIndex={p === pane ? 0 : -1}
            data-testid={`settings-tab-${p}`} onClick={() => pick(p)}>
            {label}{p === 'updates' && <i aria-hidden="true" />}
          </button>
        ))}
      </nav>
      <div className="side" role="tabpanel" id="set-panel" aria-labelledby={`set-tab-${pane}`}>
        <Shown />
      </div>
      <i className="set-grip" data-testid="settings-grip" role="separator" aria-label="Resize the settings" data-tip="Drag to resize, double-click to reset" {...grip}
        onDoubleClick={() => { setDrag(undefined); set({ settingsSize: undefined }); }} />
    </div>
  );
}
