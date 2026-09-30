import { useEffect, useState } from 'react';
import { AGENT_LABEL, type AgentKind } from '@svall/protocol';
import { createBridge } from './bridge.js';

type Plan = { agents: { kind: AgentKind; path: string; version?: string }[]; writes: { what: string; path: string }[]; shimDir: string; shimOnPath: boolean; blockers: string[] };
const AGENT_FILE: Record<string, AgentKind> = { 'Claude Code hooks and status line': 'claude', 'Codex hooks': 'codex' };

export function Setup() {
  const [bridge] = useState(createBridge);
  const [plan, setPlan] = useState<Plan>();
  const [off, setOff] = useState<AgentKind[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => bridge.onMessage((m) => {
    if (m.type !== 'setup.result') return;
    setBusy(false);
    if (!m.ok) { setError(m.json.trim()); return; }
    if (m.step === 'plan') { setPlan(JSON.parse(m.json) as Plan); setError(undefined); }
    else window.location.replace('/');
  }), [bridge]);
  const check = () => { setBusy(true); bridge.send({ type: 'setup.plan' }); };
  useEffect(check, [bridge]);

  if (!plan && error) return (
    <div className="setup" data-testid="setup">
      <p className="setup-error">{error}</p>
      <button type="button" disabled={busy} onClick={check}>Check again</button>
    </div>
  );
  if (!plan) return <div className="connect" data-testid="setup">Looking for Claude Code and Codex…</div>;
  const on = plan.agents.filter((a) => !off.includes(a.kind));
  const writes = plan.writes.filter((w) => !AGENT_FILE[w.what] || on.some((a) => a.kind === AGENT_FILE[w.what]));
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
        <h2>What setup writes</h2>
        <ul>{writes.map((w) => <li key={w.path}>{w.what} <code>{w.path}</code></li>)}</ul>
      </section>
      {!plan.shimOnPath && <section>
        <h2>The svall command</h2>
        <p>{plan.shimDir} is not on your PATH. Add this line to your shell profile:</p>
        <code>{line}</code> <button type="button" onClick={() => bridge.send({ type: 'copy', text: line })}>Copy</button>
      </section>}
      {error && <p className="setup-error">{error}</p>}
      <button type="button" disabled={busy || on.length === 0} onClick={() => { setBusy(true); bridge.send({ type: 'setup.run', agents: on.map((a) => a.kind), found: plan.agents.map((a) => a.kind) }); }}>Set up</button>
      {plan.blockers.length > 0 && <button type="button" disabled={busy} onClick={check}>Check again</button>}
    </div>
  );
}
