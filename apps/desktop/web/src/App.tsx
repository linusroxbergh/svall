import { useEffect, useState } from 'react';
import { app } from './boot.js';
import { Board } from './Board.js';
import { revealFile, shim } from './bridge.js';
import { ConfirmClose, ConfirmDeleteColumn, ConfirmDeleteIsland, ConfirmSleep } from './Confirm.js';
import { ContextMenu } from './ContextMenu.js';
import { FleetPicker } from './FleetPicker.js';
import { FleetSummary } from './FleetSummary.js';
import { HandoverSheet } from './HandoverSheet.js';
import { useApp } from './hooks.js';
import { connectionBanner, FAR_ANSWER_MS, type Banner } from './host.js';
import { HostSetup, startHost } from './HostSetup.js';
import { IslandCard } from './IslandCard.js';
import { keyTip } from './keys.js';
import { LinkAsk } from './LinkAsk.js';
import { Map } from './map/Map.js';
import { MissionPrompt } from './MissionPrompt.js';
import { MoveSheet } from './MoveSheet.js';
import { NewRobot } from './NewRobot.js';
import { PlacingAsk, ScribeAsk } from './ScribeAsk.js';
import { SettingsCard } from './SettingsCard.js';
import { Collapse, SideCard } from './SideCard.js';
import { SideGrip } from './SideGrip.js';
import { Starting } from './Starting.js';
import { Sidebar } from './Sidebar.js';
import { Tour } from './Tour.js';
import { UtilityDock } from './UtilityDock.js';
import { theme } from './theme.js';

const OUTDATED = () => (window.__svallVariant === 'release'
  ? 'Svall and svalld versions differ: quit and reopen Svall'
  : 'App and svalld versions differ: run pnpm desktop:install, then reopen the app');

// a check runs at once in the Machines panel; an upgrade waits there for the user to start it
function check(name: string): void {
  const s = app.store.getState();
  s.toggleHost(true, name);
  if (!s.host?.running) startHost('doctor', { name });
}

/** The banner's sentence, the one ssh to run in Terminal, what it offers, and what the helper said, folded. */
function BannerBody({ banner }: { banner: Banner }) {
  const name = banner.machine ?? '';
  return (
    <>
      {banner.text}
      {banner.ssh && <> Run <code data-testid="connection-ssh">ssh {banner.ssh}</code> once in Terminal, then Reconnect.</>}
      {banner.actions.map((a) => {
        switch (a) {
          case 'here': return <button key={a} className="btn" data-testid="connection-here" onClick={() => app.bridge.send({ type: 'connection.here' })}>Open this Mac&apos;s copy</button>;
          case 'upgrade': return <button key={a} className="btn" data-testid="connection-upgrade" onClick={() => app.store.getState().toggleHost(true, name)}>Upgrade {name}…</button>;
          case 'check': return <button key={a} className="btn" data-testid="connection-check" onClick={() => check(name)}>Check {name}</button>;
          case 'reconnect': return <button key={a} className="btn" data-testid="connection-reconnect" onClick={() => app.bridge.send({ type: 'connection.retry' })}>Reconnect</button>;
        }
      })}
      {banner.detail && <details data-testid="connection-detail"><summary>Details</summary>{banner.detail}</details>}
    </>
  );
}

/** The Machines panel stands beside every screen, so a terminal in it lives through the fleet loading. */
export function App() {
  return <><Screen /><HostSetup /></>;
}

function Screen() {
  const loaded = useApp((s) => s.loaded);
  const status = useApp((s) => s.status);
  const configErrors = useApp((s) => s.configErrors);
  const shell = useApp((s) => s.shell);
  const view = useApp((s) => s.view);
  const sideCardOpen = useApp((s) => s.sideCardOpen);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const selectedId = useApp((s) => (s.selectedId && s.fleet.robots[s.selectedId] ? s.selectedId : undefined));
  const selectedIslandId = useApp((s) => s.selectedIslandId);
  const toast = useApp((s) => s.toast);
  const connection = useApp((s) => s.connection);
  const handoverEnabled = useApp((s) => !!s.shell?.handoverEnabled);
  const copyHere = useApp((s) => !!s.shell?.copyHere);
  // a far daemon whose route has opened says nothing until it answers; past a while the banner says so
  const [silent, setSilent] = useState(false);
  const farOnline = !loaded && connection?.state === 'online' && connection.owner !== 'local' ? connection.owner : undefined;
  useEffect(() => {
    setSilent(false);
    if (!farOnline) return;
    const t = setTimeout(() => setSilent(true), FAR_ANSWER_MS);
    return () => clearTimeout(t);
  }, [farOnline]);
  // the fleet the page holds stays on the screen while its machine is away; only this line changes
  const away = connectionBanner(connection, { handoverEnabled, copyHere: copyHere && !loaded, silent });
  // a fleet on another machine, or one whose gateway or helper did not answer, is waited for there, so this Mac's daemon,
  // its log and its setup say nothing about it
  const trouble = connection?.state === 'error' && (connection.kind === 'helper' || (!!connection.machine && connection.machine !== 'local'));
  const elsewhere = !!connection && (connection.owner !== 'local' || (!!away && trouble));
  const sideWidths = useApp((s) => s.sideWidths);
  const bindings = useApp((s) => s.settings.bindings);
  // a launch finds svalld in moments, even one still starting; the setup hint and the log wait out that grace
  const [waiting, setWaiting] = useState(true);
  useEffect(() => { const t = setTimeout(() => setWaiting(false), theme.connectGraceMs); return () => clearTimeout(t); }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => app.store.getState().clearToast(), toast.action ? theme.toastActionMs : theme.toastMs);
    return () => clearTimeout(t);
  }, [toast]);

  if (!loaded && elsewhere) {
    return <div className="connect" data-testid="connect-screen">{away ? <div><BannerBody banner={away} /></div> : <Starting />}</div>;
  }
  if (!loaded && waiting && status !== 'outdated') return <div className="connect" data-testid="connect-screen"><Starting /></div>;
  if (!loaded) {
    const log = shell && `${shell.home}/svalld.log`;
    return (
      <div className="connect" data-testid="connect-screen">
        <div>
          {status === 'outdated' ? OUTDATED() : 'svalld not running'}<br />
          {!log && <small>run <code>{shim()} setup</code>, or open this page with <code>?port=&amp;token=</code></small>}
          {log && (
            <>
              {shell.log.length === 0 && status !== 'outdated' && <><small>run <code>{shim()} setup</code></small><br /></>}
              <small>log: <code>{log}</code> <button className="btn" data-testid="connect-log-reveal" onClick={() => revealFile(app.bridge, log)}>Reveal</button></small>
              {shell.log.length > 0 && <pre className="connect-log" data-testid="connect-log">{shell.log.join('\n')}</pre>}
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="app">
      {away && <div className="banner" data-testid="connection-banner"><BannerBody banner={away} /></div>}
      {!away && status !== 'online' && <div className="banner" data-testid="offline-banner">{status === 'outdated' ? OUTDATED() : 'svalld connection lost, reconnecting…'}</div>}
      {configErrors.length > 0 && (
        <div className="banner warn" data-testid="config-errors">
          Ghostty config: {configErrors.join('; ')}
          <button data-testid="config-errors-dismiss" onClick={() => app.store.getState().setConfigErrors([])}>dismiss</button>
        </div>
      )}
      <div className="main" style={{ '--sb-w': `${sideWidths.sidebar}px`, '--side-w': `${sideWidths.card}px` } as React.CSSProperties}>
        {sidebarOpen && <Sidebar />}
        {sidebarOpen && <SideGrip side="sidebar" />}
        {!sidebarOpen && (
          <button className="sb-show" data-testid="sidebar-show" title="Show the islands" aria-label="Show the islands"
            onClick={() => app.store.getState().toggleSidebar(true)}>›</button>
        )}
        {view === 'map' ? <Map /> : <Board />}
        {sideCardOpen && <SideGrip side="card" />}
        {sideCardOpen && <Collapse />}
        {sideCardOpen && selectedId && <SideCard id={selectedId} />}
        {sideCardOpen && !selectedId && selectedIslandId && <IslandCard id={selectedIslandId} />}
        {sideCardOpen && !selectedId && !selectedIslandId && <FleetSummary />}
        <UtilityDock />
        {settingsOpen && <SettingsCard />}
        {!sideCardOpen && (
          <button className="side-show" data-testid="side-show" title={keyTip('Show the side card', 'toggleSideCard', bindings)}
            aria-label="Show the side card" onClick={() => app.store.getState().toggleSideCard(true)}>‹</button>
        )}
      </div>
      <NewRobot />
      <MissionPrompt />
      <ConfirmClose />
      <ConfirmSleep />
      <ConfirmDeleteIsland />
      <MoveSheet />
      <ConfirmDeleteColumn />
      <HandoverSheet />
      <ScribeAsk />
      <PlacingAsk />
      <FleetPicker />
      <LinkAsk />
      <ContextMenu />
      <Tour />
    </div>
  );
}
