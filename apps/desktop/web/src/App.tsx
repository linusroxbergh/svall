import { useEffect, useState } from 'react';
import { app } from './boot.js';
import { Board } from './Board.js';
import { revealFile, shim } from './bridge.js';
import { ConfirmClose, ConfirmDeleteColumn, ConfirmDeleteIsland, ConfirmSleep } from './Confirm.js';
import { ContextMenu } from './ContextMenu.js';
import { FeedbackPopover } from './FeedbackPanel.js';
import { connectDiagnostics } from './feedback.js';
import { FleetPicker } from './FleetPicker.js';
import { FleetSummary } from './FleetSummary.js';
import { useApp } from './hooks.js';
import { HostSetup } from './HostSetup.js';
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
import { Tips } from './Tips.js';
import { Tour } from './Tour.js';
import { UtilityDock } from './UtilityDock.js';
import { theme } from './theme.js';

const OUTDATED = () => (window.__svallVariant === 'release'
  ? 'Svall and svalld versions differ: quit and reopen Svall'
  : 'App and svalld versions differ: run pnpm desktop:install, then reopen the app');

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
  const feedbackOpen = useApp((s) => s.feedbackOpen);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const selectedId = useApp((s) => (s.selectedId && s.fleet.robots[s.selectedId] ? s.selectedId : undefined));
  const selectedIslandId = useApp((s) => s.selectedIslandId);
  const toast = useApp((s) => s.toast);
  const bindings = useApp((s) => s.settings.bindings);
  // a launch finds svalld in moments, even one still starting; the setup hint and the log wait out that grace
  const [waiting, setWaiting] = useState(true);
  useEffect(() => { const t = setTimeout(() => setWaiting(false), theme.connectGraceMs); return () => clearTimeout(t); }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => app.store.getState().clearToast(), toast.action ? theme.toastActionMs : theme.toastMs);
    return () => clearTimeout(t);
  }, [toast]);

  if (!loaded && waiting && !feedbackOpen && status !== 'outdated') return <div className="connect" data-testid="connect-screen"><Starting /></div>;
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
          <button className="btn" data-testid="connect-feedback" onClick={() => app.store.getState().toggleFeedback()}>Send feedback</button>
        </div>
        {feedbackOpen && <FeedbackPopover onClose={() => app.store.getState().toggleFeedback(false)} hint="The last lines of svalld.log."
          diagnostics={async () => connectDiagnostics(shell ?? { home: '', log: [], op: false }, status === 'outdated')} />}
      </div>
    );
  }
  return (
    <div className="app">
      {status !== 'online' && <div className="banner" data-testid="offline-banner">{status === 'outdated' ? OUTDATED() : 'svalld connection lost, reconnecting…'}</div>}
      {configErrors.length > 0 && (
        <div className="banner warn" data-testid="config-errors">
          Ghostty config: {configErrors.join('; ')}
          <button data-testid="config-errors-dismiss" onClick={() => app.store.getState().setConfigErrors([])}>dismiss</button>
        </div>
      )}
      <div className="main">
        {sidebarOpen && <Sidebar />}
        {sidebarOpen && <SideGrip side="sidebar" />}
        {!sidebarOpen && (
          <button className="sb-show" data-testid="sidebar-show" data-tip="Show the islands" aria-label="Show the islands"
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
          <button className="side-show" data-testid="side-show" data-tip={keyTip('Show the side card', 'toggleSideCard', bindings)}
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
      <ScribeAsk />
      <PlacingAsk />
      <FleetPicker />
      <LinkAsk />
      <ContextMenu />
      <Tour />
      <Tips />
    </div>
  );
}
