import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AGENT_LABEL, type AgentKind, type SetupPlan } from '@svall/protocol';
import { copyText, createBridge, openUrl, type Bridge } from './bridge.js';
import { FeedbackPopover } from './FeedbackPanel.js';
import { AS_TYPED } from './Field.js';
import { shortPath } from './paths.js';
import { Close } from './icons.js';
import { DEFAULT_SETTINGS } from './settings.js';
import { localAppStorage, TOUR_KEY } from './store/persist.js';

export function Setup() {
  const [bridge] = useState(createBridge);
  const [feedback, setFeedback] = useState(false);
  useEffect(() => bridge.onMessage((m) => { if (m.type === 'menu.run' && m.action === 'feedback') setFeedback(true); }), [bridge]);
  return (
    <>
      <SetupScreen bridge={bridge} />
      {feedback && <FeedbackPopover onClose={() => setFeedback(false)} diagnostics={() => Promise.reject(new Error('no diagnostics before setup'))} />}
    </>
  );
}

function SetupScreen({ bridge }: { bridge: Bridge }) {
  const [plan, setPlan] = useState<SetupPlan>();
  const [step, setStep] = useState(1);
  const [main, setMain] = useState<AgentKind>('claude');
  const [firstProject, setFirstProject] = useState('');
  const [notify, setNotify] = useState(true);
  const [scribe, setScribe] = useState(true);
  const [permissions, setPermissions] = useState(true);
  const [newRobots, setNewRobots] = useState<'agent' | 'shell'>('agent');
  const picking = useRef<'projects' | 'project'>('projects');
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
    if (m.type === 'folder.picked') { if (pending.current !== 'run') { if (picking.current === 'project') setFirstProject(m.path); else setProjects(m.path); } return; }
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
      if (!previousPlan.current) {
        setProjects((typed) => typed || p.projects);
        setMain(p.mainAgent ?? p.agents.find((a) => !a.folderOnly && (!p.integrations || p.integrations.includes(a.kind)))?.kind ?? 'claude');
        if (p.agents.length === 1 && p.agents[0]?.signedIn === true && !p.blockers.length) setStep(2);
      }
      previousPlan.current = p;
      setError(undefined);
      return;
    }
    const storage = localAppStorage(window.__svallHome);
    const settings = storage?.getSettings() ?? DEFAULT_SETTINGS;
    storage?.setSettings({ ...settings, notifications: { ...settings.notifications, on: notify } });
    try { localStorage.setItem(TOUR_KEY, '0'); } catch { /* optional persistence */ }
    if (notify) bridge.send({ type: 'notify.enable' });
    const run = data as { warnings: string[] };
    if (run.warnings.length) setWarnings(run.warnings);
    else window.location.replace('/');
  }), [bridge, notify]);
  useEffect(check, [check]);
  useEffect(() => {
    const recheck = () => { if (previousPlan.current) check(); };
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
  if (!plan) return <div className="connect" data-testid="setup" role="status">Looking for Claude Code, Codex and OpenCode…</div>;
  const on = plan.agents.filter((a) => !off.includes(a.kind));
  const runnable = on.filter((a) => !a.folderOnly);
  const agent = runnable.find((a) => a.kind === main)?.kind ?? runnable[0]?.kind ?? main;
  const writes = plan.writes.filter((w) => !w.agent || !off.includes(w.agent)).map((w) => ({ ...w,
    what: w.agent === 'claude' ? `Claude Code: hooks, status line${permissions ? ' and svall permissions' : ''}`
      : w.agent === 'codex' ? 'Codex: hooks' : w.agent === 'opencode' ? 'OpenCode: plugin' : w.what }));
  if (permissions && on.some((a) => a.kind === 'codex') && plan.codexRules) writes.push({ what: 'Codex: svall permissions', path: plan.codexRules });
  if (plan.trustPaths?.[agent]) writes.splice(1, 0, { what: `${AGENT_LABEL[agent]}: folder trust for mission control${firstProject ? ` and ${firstProject.split('/').filter(Boolean).at(-1) ?? '/'}` : ''}`, path: plan.trustPaths[agent]! });
  const pick = (which: 'projects' | 'project') => { picking.current = which; bridge.send({ type: 'folder.pick', start: projects.trim() || '~' }); };
  const line = `export PATH="$HOME/.local/bin:$PATH"`;
  const installer = plan.install?.find((i) => i.kind === installAgent) ?? plan.install?.[0];
  const run = () => {
    if (pending.current) return;
    pending.current = 'run';
    setBusy(true);
    setRunning(true);
    setError(undefined);
    bridge.send({ type: 'setup.run', agents: on.map((a) => a.kind), found: plan.agents.map((a) => a.kind), projects: projects.trim(), mainAgent: agent, firstProject: firstProject || undefined, scribe, svallPermissions: permissions, newRobotStart: newRobots });
  };
  return (
    <Page>
      <header className="setup-intro">
        <div className="setup-progress" aria-label={`Step ${step} of 3`}><div>{[1, 2, 3].map((n) => <span key={n} data-complete={n <= step} />)}</div><span>Step {step} of 3</span></div>
        <h1>{step === 1 ? 'Connect your agents' : step === 2 ? 'Choose where you work' : 'While your agents work'}</h1>
        <p>{step === 1 ? 'Svall runs your robots with these.' : step === 2 ? 'Robots start in your projects folder.' : 'Change any of these later in Settings.'}</p>
      </header>
      <fieldset className="setup-fields" disabled={running} aria-busy={busy} aria-label="Setup options">
        {step === 1 && <>{plan.blockers.map((b) => <p key={b} className="setup-blocker">{b}</p>)}
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
            {/* OpenCode's installer uses ~/.opencode/bin and puts that on PATH itself */}
            <p>{installer?.kind === 'opencode' ? "Svall's command goes" : 'The installer puts the command'} in {shortPath(plan.shimDir)}, which is not on your PATH; add this line to ~/.zshrc, or your shell's startup file, then check again.</p>
            <Command bridge={bridge} text={line} />
          </div>}
        </section>}
        {plan.agents.length > 0 && <section>
          <div className="setup-list">
            {plan.agents.map((a) => (
              <div key={a.kind} className="setup-row">
                <label>
                  <input type="checkbox" checked={!off.includes(a.kind)} aria-label={AGENT_LABEL[a.kind]}
                    onChange={(e) => setOff((o) => (e.target.checked ? o.filter((k) => k !== a.kind) : [...o, a.kind]))} />
                  <span className="setup-agent-name">{AGENT_LABEL[a.kind]}<small data-tip={a.path}>{shortPath(a.path)}</small></span>
                </label>
                <div className="setup-agent-actions">
                  <span className="setup-agent-status" data-warning={!a.folderOnly && a.signedIn !== true}>{a.folderOnly ? 'CLI not found' : a.signedIn === true ? 'Signed in' : a.signedIn === false ? 'Not signed in' : 'Sign-in unknown'}{a.version && <small>{a.version}</small>}</span>
                  {!a.folderOnly && a.signedIn !== true && <button type="button" className="btn sm" onClick={() => bridge.send({ type: 'setup.login', agent: a.kind })}>Sign in…</button>}
                  {plan.agents.filter((r) => !r.folderOnly).length > 1 && !a.folderOnly && <label className="setup-main"><input type="radio" name="main-agent" aria-label={`${AGENT_LABEL[a.kind]} main`} checked={agent === a.kind} disabled={off.includes(a.kind)} onChange={() => setMain(a.kind)} />Main</label>}
                </div>
              </div>
            ))}
          </div>
          <p className="setup-hint">The main agent also runs mission control and the note updates. Uncheck an agent to leave it alone.</p>
        </section>}
        </>}
        {step === 2 && <>
          <section>
            <h2>Projects folder</h2>
            <div className="setup-folder">
              <input type="text" className="fld" value={projects} aria-label="Projects folder" {...AS_TYPED} onChange={(e) => setProjects(e.target.value)} />
              <button type="button" className="btn" onClick={() => pick('projects')}>Choose…</button>
            </div>
          </section>
          <section>
            <h2>First project <span className="setup-optional">· optional</span></h2>
            <div className="setup-folder">
              <div className="fld setup-project">{firstProject ? <><span>{firstProject.split('/').filter(Boolean).at(-1) ?? '/'}</span><code>{shortPath(firstProject)}</code><button type="button" className="ib" aria-label="Clear first project" onClick={() => setFirstProject('')}><Close /></button></> : <span className="setup-hint">None. Your first robot starts in {projects || 'your projects folder'}.</span>}</div>
              <button type="button" className="btn" onClick={() => pick('project')}>{firstProject ? 'Change…' : 'Choose a project…'}</button>
            </div>
            {firstProject && <p className="setup-hint">Svall makes an island for it and starts your main agent there.</p>}
          </section>
        </>}
        {step === 3 && <>
          <div className="setup-list setup-preferences">
            {[
              { title: 'Notify me when an agent needs me', text: 'A banner with Approve and Deny when an agent asks for permission, and one when it finishes.', value: notify, set: setNotify },
              { title: 'Automatically update robot notes', text: "When an agent finishes, Svall asks your main agent for a short summary and updates the robot’s name and note. Each update uses a little of your plan or API credit.", value: scribe, set: setScribe },
              { title: 'Let robots run svall without asking', text: 'Robots can start, message and wait for other robots without a permission prompt.', value: permissions, set: setPermissions },
            ].map((p) => <label className="setup-preference" key={p.title}><span><input type="checkbox" aria-label={p.title} checked={p.value} onChange={(e) => p.set(e.target.checked)} />{p.title}</span><small>{p.text}</small></label>)}
            <div className="setup-preference"><label className="setup-new">New robots start<select className="fld" aria-label="New robots start" value={newRobots} onChange={(e) => setNewRobots(e.target.value as 'agent' | 'shell')}><option value="agent">Your main agent</option><option value="shell">A shell</option></select></label><small>What ⌘T opens.</small></div>
          </div>
          {!plan.shimOnPath && !plan.pathFile && <section><p>{shortPath(plan.shimDir)} is not on your PATH; add this line to your shell profile.</p><Command bridge={bridge} text={line} /></section>}
          <section className="setup-review">
            <p>Svall adds agent hooks, a background service and the svall command. The hooks only act inside Svall.</p>
            <details>
              <summary>Review changes <span>{writes.length} locations</span></summary>
              <ul className="setup-list">{writes.map((w) => <li key={w.path} className="setup-write"><span>{w.what}</span><code>{shortPath(w.path)}</code></li>)}</ul>
            </details>
          </section>
        </>}
      </fieldset>
      {error && <p className="setup-error" role="alert">{error}</p>}
      <div className="setup-acts">
        {/* the main agent must be one whose CLI setup found */}
        <button type="button" className="btn pri" disabled={busy || !on.some((a) => !a.folderOnly) || plan.blockers.length > 0 || (step > 1 && !projects.trim())} onClick={() => step < 3 ? setStep(step + 1) : run()}>{running ? 'Setting up…' : step < 3 ? 'Continue' : 'Set up Svall'}</button>
        {step > 1 && <button type="button" className="btn" disabled={running} onClick={() => setStep(step - 1)}>Back</button>}
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
