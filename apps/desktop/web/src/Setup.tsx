import { useEffect, useState, type ReactNode } from 'react';
import { AGENT_LABEL, type AgentKind } from '@svall/protocol';
import { copyText, createBridge, openUrl, type Bridge } from './bridge.js';
import { shortPath } from './resources/model.js';

type Plan = {
  agents: { kind: AgentKind; path: string; version?: string; folderOnly?: boolean }[]; integrations?: AgentKind[]; writes: { what: string; path: string; agent?: AgentKind }[];
  shimDir: string; shimOnPath: boolean; blockers: string[]; projects: string; install?: { kind: AgentKind; command: string; url: string }[];
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
      <p className="setup-error">{error}</p>
      <div className="setup-acts"><button type="button" className="btn" disabled={busy} onClick={check}>Check again</button></div>
    </Page>
  );
  if (!plan) return <div className="connect" data-testid="setup">Looking for the claude and codex commands…</div>;
  const on = plan.agents.filter((a) => !off.includes(a.kind));
  const writes = plan.writes.filter((w) => !w.agent || !off.includes(w.agent));
  const line = `export PATH="$HOME/.local/bin:$PATH"`;
  return (
    <Page>
      <h1>Set up Svall</h1>
      {plan.blockers.map((b) => <p key={b} className="setup-blocker">{b}</p>)}
      {plan.install && <section>
        <h2>Install</h2>
        {plan.install.map((i) => (
          <div key={i.kind} className="setup-install">
            <div className="setup-install-head">
              <span>{AGENT_LABEL[i.kind]}</span>
              <a href={i.url} target="_blank" rel="noreferrer" aria-label={`Other ways to install ${AGENT_LABEL[i.kind]}`} onClick={(e) => { e.preventDefault(); openUrl(bridge, i.url); }}>Other ways</a>
            </div>
            <Command bridge={bridge} text={i.command} />
          </div>
        ))}
      </section>}
      {plan.agents.length > 0 && <section>
        <h2>Agents</h2>
        <p>Your characters run these. Uncheck one to leave it alone.</p>
        <div className="setup-list">
          {plan.agents.map((a) => (
            <label key={a.kind} className="setup-row">
              <span>
                <input type="checkbox" checked={!off.includes(a.kind)} aria-label={AGENT_LABEL[a.kind]}
                  onChange={(e) => setOff((o) => (e.target.checked ? o.filter((k) => k !== a.kind) : [...o, a.kind]))} />
                {AGENT_LABEL[a.kind]}
              </span>
              <code title={a.path}>{[a.version, shortPath(a.path), a.folderOnly && `no ${a.kind} command`].filter(Boolean).join(' · ')}</code>
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
      <section>
        <h2>What setup writes</h2>
        <ul className="setup-list">{writes.map((w) => <li key={w.path} className="setup-row"><span>{w.what}</span><code title={w.path}>{shortPath(w.path)}</code></li>)}</ul>
      </section>
      {!plan.shimOnPath && <section>
        <h2>The svall command</h2>
        <p>{shortPath(plan.shimDir)} is not on your PATH; add this line to your shell profile.</p>
        <Command bridge={bridge} text={line} />
      </section>}
      {error && <p className="setup-error">{error}</p>}
      <div className="setup-acts">
        {/* the main agent must be one whose CLI setup found */}
        <button type="button" className="btn pri" disabled={busy || !on.some((a) => !a.folderOnly) || plan.blockers.length > 0 || !projects.trim()} onClick={() => { setBusy(true); bridge.send({ type: 'setup.run', agents: on.map((a) => a.kind), found: plan.agents.map((a) => a.kind), projects: projects.trim() }); }}>Set up</button>
        {plan.blockers.length > 0 && <button type="button" className="btn" disabled={busy} onClick={check}>Check again</button>}
      </div>
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
