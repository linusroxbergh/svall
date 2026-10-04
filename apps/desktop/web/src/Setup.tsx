import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AGENT_LABEL, type AgentKind, type SetupPlan } from '@svall/protocol';
import { copyText, createBridge, openUrl, type Bridge } from './bridge.js';
import { shortPath } from './resources/model.js';

export function Setup() {
  const [bridge] = useState(createBridge);
  const [plan, setPlan] = useState<SetupPlan>();
  const [off, setOff] = useState<AgentKind[]>([]);
  const [projects, setProjects] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [warnings, setWarnings] = useState<string[]>();
  const [installAgent, setInstallAgent] = useState<AgentKind>('claude');
  const [running, setRunning] = useState(false);
  const pending = useRef<'plan' | 'run' | undefined>(undefined);
  const previousPlan = useRef<SetupPlan | undefined>(undefined);
  const check = useCallback(() => {
    if (pending.current) return;
    pending.current = 'plan';
    setBusy(true);
    setError(undefined);
    bridge.send({ type: 'setup.plan' });
  }, [bridge]);

  useEffect(() => bridge.onMessage((m) => {
    if (m.type === 'folder.picked') { if (pending.current !== 'run') setProjects(m.path); return; }
    if (m.type !== 'setup.result') return;
    pending.current = undefined;
    setBusy(false);
    setRunning(false);
    if (!m.ok) { setError(m.json.trim()); return; }
    let data: unknown;
    // output that is not JSON is shown as it came, rather than leaving the screen waiting
    try { data = JSON.parse(m.json); } catch { setError(m.json.trim()); return; }
    if (m.step === 'plan') {
      const p = data as SetupPlan;
      setPlan(p);
      // Rechecking after an external install keeps choices made on this screen.
      const seen = previousPlan.current?.agents.map((a) => a.kind) ?? [];
      setOff((old) => [...new Set([...old, ...p.agents.map((a) => a.kind).filter((k) => !seen.includes(k) && p.integrations && !p.integrations.includes(k))])]);
      if (!previousPlan.current) setProjects((typed) => typed || p.projects);
      previousPlan.current = p;
      setError(undefined);
      return;
    }
    const run = data as { warnings: string[] };
    if (run.warnings.length) setWarnings(run.warnings);
    else window.location.replace('/');
  }), [bridge]);
  useEffect(check, [check]);
  useEffect(() => {
    const recheck = () => { if (previousPlan.current?.blockers.length) check(); };
    const visible = () => { if (document.visibilityState === 'visible') recheck(); };
    const unsubscribe = bridge.onMessage((m) => { if (m.type === 'app.active' && m.active) recheck(); });
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', visible);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [bridge, check]);

  if (warnings) return (
    <Page>
      <h1>Svall is set up</h1>
      <section>
        <h2>Before you start</h2>
        <ul className="setup-list">{warnings.map((w) => <li key={w} className="setup-note">{w}</li>)}</ul>
      </section>
      <div className="setup-acts"><button type="button" className="btn pri" onClick={() => window.location.replace('/')}>Continue</button></div>
    </Page>
  );
  if (!plan && error) return (
    <Page>
      <p className="setup-error" role="alert">{error}</p>
      <div className="setup-acts"><button type="button" className="btn" disabled={busy} onClick={check}>Check again</button></div>
    </Page>
  );
  if (!plan) return <div className="connect" data-testid="setup" role="status">Looking for Claude Code and Codex…</div>;
  const on = plan.agents.filter((a) => !off.includes(a.kind));
  const writes = plan.writes.filter((w) => !w.agent || !off.includes(w.agent));
  const line = `export PATH="$HOME/.local/bin:$PATH"`;
  const installer = plan.install?.find((i) => i.kind === installAgent) ?? plan.install?.[0];
  const run = () => {
    if (pending.current) return;
    pending.current = 'run';
    setBusy(true);
    setRunning(true);
    setError(undefined);
    bridge.send({ type: 'setup.run', agents: on.map((a) => a.kind), found: plan.agents.map((a) => a.kind), projects: projects.trim() });
  };
  return (
    <Page>
      <header className="setup-intro">
        <h1>Set up Svall</h1>
        <p>Connect your agents and choose where new characters start.</p>
      </header>
      <fieldset className="setup-fields" disabled={running} aria-busy={busy} aria-label="Setup options">
        {plan.blockers.map((b) => <p key={b} className="setup-blocker">{b}</p>)}
        {plan.install && <section>
          <h2>Choose an agent to install</h2>
          <div className="setup-agent-choice" role="radiogroup" aria-label="Agent to install">
            {plan.install.map((i) => <label key={i.kind}><input type="radio" name="install-agent" checked={installer?.kind === i.kind} onChange={() => setInstallAgent(i.kind)} />{AGENT_LABEL[i.kind]}</label>)}
          </div>
          {installer && (
            <div className="setup-install">
              <div className="setup-install-head">
                <span>Run in Terminal</span>
                <a href={installer.url} target="_blank" rel="noreferrer" aria-label={`Other ways to install ${AGENT_LABEL[installer.kind]}`} onClick={(e) => { e.preventDefault(); openUrl(bridge, installer.url); }}>Other ways</a>
              </div>
              <Command bridge={bridge} text={installer.command} />
            </div>
          )}
          <p>Svall checks again when you return to this window.</p>
          {!plan.shimOnPath && <div className="setup-install">
            <p>The installer puts the command in {shortPath(plan.shimDir)}, which is not on your PATH; add this line to ~/.zshrc, or your shell's startup file, then check again.</p>
            <Command bridge={bridge} text={line} />
          </div>}
        </section>}
        {plan.agents.length > 0 && <section>
          <h2>Your agents</h2>
          <p>Your characters run these. Uncheck one to leave it alone.</p>
          <div className="setup-list">
            {plan.agents.map((a) => (
              <label key={a.kind} className="setup-row">
                <span>
                  <input type="checkbox" checked={!off.includes(a.kind)} aria-label={AGENT_LABEL[a.kind]}
                    onChange={(e) => setOff((o) => (e.target.checked ? o.filter((k) => k !== a.kind) : [...o, a.kind]))} />
                  <span className="setup-agent-name">{AGENT_LABEL[a.kind]}<small title={a.path}>{shortPath(a.path)}</small></span>
                </span>
                <span className="setup-agent-status">{a.folderOnly ? 'CLI not found' : 'Ready'}{a.version && <small>{a.version}</small>}</span>
              </label>
            ))}
          </div>
        </section>}
        <section>
          <h2>Projects folder</h2>
          <p>New characters start here instead of your home folder.</p>
          <div className="setup-folder">
            <input type="text" value={projects} aria-label="Projects folder" spellCheck={false} onChange={(e) => setProjects(e.target.value)} />
            <button type="button" className="btn" onClick={() => bridge.send({ type: 'folder.pick', start: projects.trim() || '~' })}>Choose…</button>
          </div>
        </section>
        {/* the installers write to the svall command's folder, so the Install section gives this line */}
        {!plan.shimOnPath && !plan.install && <section>
          <h2>The svall command</h2>
          <p>{shortPath(plan.shimDir)} is not on your PATH; add this line to your shell profile.</p>
          <Command bridge={bridge} text={line} />
        </section>}
      </fieldset>
      <section className="setup-review">
        <p>Svall adds agent hooks, a background service and the svall command. The hooks only act inside Svall.</p>
        <details>
          <summary>Review changes <span>{writes.length} locations</span></summary>
          <ul className="setup-list">{writes.map((w) => <li key={w.path} className="setup-write"><span>{w.what}</span><code>{shortPath(w.path)}</code></li>)}</ul>
        </details>
      </section>
      {error && <p className="setup-error" role="alert">{error}</p>}
      <div className="setup-acts">
        {/* the main agent must be one whose CLI setup found */}
        <button type="button" className="btn pri" disabled={busy || !on.some((a) => !a.folderOnly) || plan.blockers.length > 0 || !projects.trim()} onClick={run}>{running ? 'Setting up…' : 'Set up Svall'}</button>
        {plan.blockers.length > 0 && <button type="button" className="btn" disabled={busy} onClick={check}>{busy ? 'Checking…' : 'Check again'}</button>}
      </div>
      <p className="setup-status" role="status">{running ? 'Connecting your agents and configuring Svall…' : busy ? 'Looking for your agents…' : ''}</p>
    </Page>
  );
}

function Command({ bridge, text }: { bridge: Bridge; text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="setup-code">
      <code>{text}</code>
      <button type="button" className="btn sm" onClick={() => { copyText(bridge, text); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

// the column sits in the middle of the window, and scrolls from its top once it is taller
const Page = ({ children }: { children: ReactNode }) => (
  <div className="setup" data-testid="setup"><div className="setup-body">{children}</div></div>
);
