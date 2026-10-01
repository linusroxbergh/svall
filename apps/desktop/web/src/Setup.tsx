import { useEffect, useState } from 'react';
import { AGENT_LABEL, type AgentKind } from '@svall/protocol';
import { createBridge } from './bridge.js';

type Plan = {
  agents: { kind: AgentKind; path: string; version?: string; folderOnly?: boolean }[]; integrations?: AgentKind[]; writes: { what: string; path: string; agent?: AgentKind }[];
  shimDir: string; shimOnPath: boolean; blockers: string[]; projects: string;
};

export function Setup() {
  const [bridge] = useState(createBridge);
  const [plan, setPlan] = useState<Plan>();
  const [off, setOff] = useState<AgentKind[]>([]);
  const [projects, setProjects] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [warnings, setWarnings] = useState<string[]>();

  useEffect(() => bridge.onMessage((m) => {
    if (m.type === 'folder.picked') { setProjects(m.path); return; }
    if (m.type !== 'setup.result') return;
    setBusy(false);
    if (!m.ok) { setError(m.json.trim()); return; }
    if (m.step === 'plan') {
      const p = JSON.parse(m.json) as Plan;
      setPlan(p);
      // an agent turned off at an earlier setup starts off
      setOff(p.agents.map((a) => a.kind).filter((k) => p.integrations && !p.integrations.includes(k)));
      setProjects((typed) => typed || p.projects);
      setError(undefined);
      return;
    }
    const run = JSON.parse(m.json) as { warnings: string[] };
    if (run.warnings.length) setWarnings(run.warnings);
    else window.location.replace('/');
  }), [bridge]);
  const check = () => { setBusy(true); bridge.send({ type: 'setup.plan' }); };
  useEffect(check, [bridge]);

  if (warnings) return (
    <div className="setup" data-testid="setup">
      <h1>Svall is set up</h1>
      <section>
        <h2>Before you start</h2>
        <ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
      </section>
      <button type="button" onClick={() => window.location.replace('/')}>Continue</button>
    </div>
  );
  if (!plan && error) return (
    <div className="setup" data-testid="setup">
      <p className="setup-error">{error}</p>
      <button type="button" disabled={busy} onClick={check}>Check again</button>
    </div>
  );
  if (!plan) return <div className="connect" data-testid="setup">Looking for Claude Code and Codex…</div>;
  const on = plan.agents.filter((a) => !off.includes(a.kind));
  const writes = plan.writes.filter((w) => !w.agent || !off.includes(w.agent));
  const line = `export PATH="$HOME/.local/bin:$PATH"`;
  return (
    <div className="setup" data-testid="setup">
      <h1>Set up Svall</h1>
      {plan.blockers.map((b) => <p key={b} className="setup-blocker">{b}</p>)}
      {plan.agents.length > 0 && <section>
        <h2>Agents</h2>
        {plan.agents.map((a) => (
          <label key={a.kind}>
            <input type="checkbox" checked={!off.includes(a.kind)} aria-label={AGENT_LABEL[a.kind]}
              onChange={(e) => setOff((o) => (e.target.checked ? o.filter((k) => k !== a.kind) : [...o, a.kind]))} />
            {AGENT_LABEL[a.kind]} <small>{a.version ?? ''} {a.path}</small>
          </label>
        ))}
      </section>}
      <section>
        <h2>Projects folder</h2>
        <p>New characters start here, so agents work in your code rather than your whole home folder.</p>
        <div className="setup-folder">
          <input type="text" value={projects} aria-label="Projects folder" spellCheck={false} onChange={(e) => setProjects(e.target.value)} />
          <button type="button" onClick={() => bridge.send({ type: 'folder.pick', start: projects.trim() || '~' })}>Choose…</button>
        </div>
      </section>
      <section>
        <h2>What setup writes</h2>
        <ul>{writes.map((w) => <li key={w.path}>{w.what} <code>{w.path}</code></li>)}</ul>
      </section>
      {!plan.shimOnPath && <section>
        <h2>The svall command</h2>
        <p>{plan.shimDir} is not on your PATH. Add this line to your shell profile:</p>
        <code>{line}</code> <button type="button" onClick={() => bridge.send({ type: 'copy', text: line })}>Copy</button>
      </section>}
      {error && <p className="setup-error">{error}</p>}
      {/* the main agent must be one whose CLI setup found */}
      <button type="button" disabled={busy || !on.some((a) => !a.folderOnly) || plan.blockers.length > 0 || !projects.trim()} onClick={() => { setBusy(true); bridge.send({ type: 'setup.run', agents: on.map((a) => a.kind), found: plan.agents.map((a) => a.kind), projects: projects.trim() }); }}>Set up</button>
      {plan.blockers.length > 0 && <button type="button" disabled={busy} onClick={check}>Check again</button>}
    </div>
  );
}
