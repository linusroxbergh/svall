import { useEffect, useState } from 'react';
import { app } from './boot.js';
import { Board } from './Board.js';
import { revealFile, shim } from './bridge.js';
import { ConfirmClose } from './ConfirmClose.js';
import { ContextMenu } from './ContextMenu.js';
import { ConfirmDeleteIsland } from './ConfirmDeleteIsland.js';
import { ConfirmSleep } from './ConfirmSleep.js';
import { FleetPicker } from './FleetPicker.js';
import { FleetSummary } from './FleetSummary.js';
import { HandoverSheet } from './HandoverSheet.js';
import { useApp } from './hooks.js';
import { connectionBanner, type Banner } from './host.js';
import { HostSetup } from './HostSetup.js';
import { IslandCard } from './IslandCard.js';
import { keyTip } from './keys.js';
import { LinkAsk } from './LinkAsk.js';
import { Map } from './map/Map.js';
import { MissionPrompt } from './MissionPrompt.js';
import { NewCharacter } from './NewCharacter.js';
import { ScribeAsk } from './ScribeAsk.js';
import { SettingsCard } from './SettingsCard.js';
import { boardViewed } from './selectors.js';
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

/** The banner's sentence, the one ssh to run in Terminal, what it offers, and what the helper said, folded. */
function BannerBody({ banner }: { banner: Banner }) {
  const name = banner.machine ?? '';
  return (
    <>
      {banner.text}
      {banner.ssh && <> Run <code data-testid="connection-ssh">ssh {banner.ssh}</code> once in Terminal, then Reconnect.</>}
      {banner.actions.map((a) => {
        switch (a) {
          case 'upgrade': return <button key={a} className="btn" data-testid="connection-upgrade" onClick={() => app.store.getState().toggleHost(true, name)}>Upgrade {name}…</button>;
          case 'reconnect': return <button key={a} className="btn" data-testid="connection-reconnect" onClick={() => app.bridge.send({ type: 'connection.retry' })}>Reconnect</button>;
        }
      })}
      {banner.detail && <details data-testid="connection-detail"><summary>Details</summary>{banner.detail}</details>}
    </>
  );
}

export function App() {
  const loaded = useApp((s) => s.loaded);
  const status = useApp((s) => s.status);
  const configErrors = useApp((s) => s.configErrors);
  const shell = useApp((s) => s.shell);
  const view = useApp((s) => s.view);
  const sideCardOpen = useApp((s) => s.sideCardOpen);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const settingsOpen = useApp((s) => s.settingsOpen);
  // the side card edits the board's viewed character, and on the map the explicit selection
  const selectedId = useApp((s) => (s.view === 'board' ? boardViewed(s) : s.selectedId && s.fleet.characters[s.selectedId] ? s.selectedId : undefined));
  const selectedIslandId = useApp((s) => s.selectedIslandId);
  const toast = useApp((s) => s.toast);
  const connection = useApp((s) => s.connection);
  const handoverEnabled = useApp((s) => !!s.shell?.handoverEnabled);
  // the fleet the page holds stays on the screen while its machine is away; only this line changes
  const away = connectionBanner(connection, { handoverEnabled });
  // a fleet on another machine is waited for there, so this Mac's daemon, its log and its setup say nothing about it
  const elsewhere = useApp((s) => !!s.connection && s.connection.owner !== 'local');
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
    return (
      <>
        <div className="connect" data-testid="connect-screen">{away ? <div><BannerBody banner={away} /></div> : <Starting />}</div>
        <HostSetup />
      </>
    );
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
        {/* the board draws a native terminal over this edge, so it carries its own control in the tab bar */}
        {!sidebarOpen && view === 'map' && (
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
        {!sideCardOpen && view === 'map' && (
          <button className="side-show" data-testid="side-show" title={keyTip('Show the side card', 'toggleSideCard', bindings)}
            aria-label="Show the side card" onClick={() => app.store.getState().toggleSideCard(true)}>‹</button>
        )}
      </div>
      <NewCharacter />
      <MissionPrompt />
      <ConfirmClose />
      <ConfirmSleep />
      <ConfirmDeleteIsland />
      <HostSetup />
      <HandoverSheet />
      <ScribeAsk />
      <FleetPicker />
      <LinkAsk />
      <ContextMenu />
      <Tour />
    </div>
  );
}
