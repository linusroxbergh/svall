import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AGENT_LABEL, tierOf, type AgentKind, type SetupPlan, type Tier } from '@svall/protocol';
import { copyText, createBridge, openUrl, type Bridge, type HostOp, type HostStep } from './bridge.js';
import { FeedbackPopover } from './FeedbackPanel.js';
import { AS_TYPED } from './Field.js';
import { onThisMac, plainStep, plural, splitRaw, stepLabel, withoutTokens } from './host.js';
import { shortPath } from './paths.js';
import { Caret, Close, Mark } from './icons.js';
import { Said } from './Said.js';
import { DEFAULT_SETTINGS, type Settings } from './settings.js';
import { localAppStorage, TOUR_KEY } from './store/persist.js';
import { Tips } from './Tips.js';

export function Setup() {
  const [bridge] = useState(createBridge);
  const [feedback, setFeedback] = useState(false);
  useEffect(() => bridge.onMessage((m) => { if (m.type === 'menu.run' && m.action === 'feedback') setFeedback(true); }), [bridge]);
  return (
    <>
      <SetupScreen bridge={bridge} />
      <Tips bridge={bridge} />
      {feedback && <FeedbackPopover onClose={() => setFeedback(false)} diagnostics={() => Promise.reject(new Error('no diagnostics before setup'))} />}
    </>
  );
}

// where this Mac's fleet goes to run: here, on a server this sets up, or on a fleet a server already runs. Each server path joins before any first start, so nothing here seeds a robot for a join to refuse
type Fork = 'here' | 'server' | 'join';
// a row of a server path's run: a step of its add or its join, or, with no op, the setup of this Mac before them
type FarRow = HostStep & { op?: HostOp };
// the name the fleet knows a server by, from its ssh destination, as `svall host add` holds names
const nameFromSsh = (ssh: string): string => {
  const name = (ssh.split('@').pop() ?? '').split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return /^[a-z]/.test(name) ? name.slice(0, 32) : 'server';
};

function SetupScreen({ bridge }: { bridge: Bridge }) {
  const [fork, setFork] = useState<Fork>();
  const [ssh, setSsh] = useState('');
  const [farSteps, setFarSteps] = useState<FarRow[]>();
  // a server path's run that ended short with no failed row: its exit code; and a Stop pressed during it
  const [farCode, setFarCode] = useState<number>();
  const [stopped, setStopped] = useState(false);
  const going = useRef<{ fork: Fork; ssh: string; warnings?: string[] } | undefined>(undefined);
  const farRows = useRef<FarRow[]>([]);
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
  // this machine's, once the shell can name it
  const machine = useRef<string | undefined>(undefined);
  const previousPlan = useRef<SetupPlan | undefined>(undefined);
  const check = useCallback(() => {
    if (pending.current) return;
    pending.current = 'plan';
    setBusy(true);
    setError(undefined);
    bridge.send({ type: 'setup.plan' });
  }, [bridge]);

  useEffect(() => bridge.onMessage((m) => {
    if (m.type === 'host.step') { farRows.current = [...farRows.current, { ...m.event, op: m.op }]; setFarSteps(farRows.current); return; }
    if (m.type === 'host.done') {
      const to = going.current;
      if (!to) return;
      const failed = farRows.current.some((r) => r.status === 'fail');
      // an add that warns exits 1 too, so its last step says as well that it ran through
      if (!stopped && !failed && m.op === 'add' && (m.code === 0 || farRows.current.some((r) => r.step === 'registry' && r.status === 'ok'))) bridge.send({ type: 'host.start', op: 'join', args: { name: '', ssh: to.ssh } });
      // a join that went through as Stop went out has joined, so the window opens
      else if (m.op !== 'add' && !failed && m.code === 0) { if (to.warnings?.length) setWarnings(to.warnings); else window.location.replace('/'); }
      else {
        pending.current = undefined;
        setRunning(false);
        setBusy(false);
        if (!failed) setFarCode(m.code);
      }
      return;
    }
    if (m.type === 'shell.info') { machine.current = m.machine || undefined; return; }
    if (m.type === 'folder.picked') { if (pending.current !== 'run') { if (picking.current === 'project') setFirstProject(m.path); else setProjects(m.path); } return; }
    if (m.type !== 'setup.result') return;
    pending.current = undefined;
    setBusy(false);
    setRunning(false);
    // a server path's setup of this Mac is the first row of its run
    const fail = (text: string) => {
      if (m.step === 'run' && going.current) { farRows.current = [...farRows.current, { step: 'setup', status: 'fail', detail: text }]; setFarSteps(farRows.current); } else setError(text);
    };
    if (!m.ok) { fail(m.json.trim()); return; }
    let data: unknown;
    // output that is not JSON is shown as it came, rather than leaving the screen waiting
    try { data = JSON.parse(m.json); } catch { fail(m.json.trim()); return; }
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
    // with nothing saved the keys stay unnamed, for the first window to settle against Ghostty
    const { bindings: _unnamed, ...fresh } = DEFAULT_SETTINGS;
    const settings = storage?.getSettings() ?? fresh;
    storage?.setSettings({ ...settings, notifications: { ...settings.notifications, on: notify } } as Settings);
    try { localStorage.setItem(TOUR_KEY, '0'); } catch { /* optional persistence */ }
    if (notify) bridge.send({ type: 'notify.enable' });
    const run = data as { warnings: string[] };
    const to = going.current;
    if (to && to.fork !== 'here') {
      if (stopped) return;
      // shown once the join lands, as the window opens only then
      to.warnings = run.warnings;
      // the machine runs that follow are this run's too, which a recheck must not cut into
      pending.current = 'run';
      setRunning(true);
      setBusy(true);
      bridge.send(to.fork === 'server'
        ? { type: 'host.start', op: 'add', args: { name: nameFromSsh(to.ssh), ssh: to.ssh, asHome: true } }
        : { type: 'host.start', op: 'join', args: { name: '', ssh: to.ssh } });
      return;
    }
    if (run.warnings.length) setWarnings(run.warnings);
    else window.location.replace('/');
  }), [bridge, notify, stopped]);
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
        {warnings.map((w) => { const { line, raw } = splitRaw(w); return <Said key={w} line={inMono(line)} raw={raw} mark="warn" />; })}
      </section>
      <div className="setup-acts"><button type="button" className="btn pri" onClick={() => window.location.replace('/')}>Continue</button></div>
    </Page>
  );
  if (!plan && error) return (
    <Page>
      <div className="setup-error" role="alert"><Said {...splitRaw(error)} /></div>
      <div className="setup-acts"><button type="button" className="btn" disabled={busy} onClick={check}>Check again</button></div>
    </Page>
  );
  if (!plan) return <div className="connect" data-testid="setup" role="status">Looking for Claude Code, Codex and OpenCode…</div>;
  const on = plan.agents.filter((a) => !off.includes(a.kind));
  const writes = plan.writes.filter((w) => !w.agent || !off.includes(w.agent)).map((w) => ({ ...w,
    what: w.agent === 'claude' ? `Claude Code: hooks, status line${permissions ? ' and svall permissions' : ''}`
      : w.agent === 'codex' ? 'Codex: hooks' : w.agent === 'opencode' ? 'OpenCode: plugin' : w.what }));
  if (permissions && on.some((a) => a.kind === 'codex') && plan.codexRules) writes.push({ what: 'Codex: svall permissions', path: plan.codexRules });
  // the server paths keep this Mac's agents as saved, for the robots that move here
  const farRun = (to: Fork) => {
    if (pending.current) return;
    going.current = { fork: to, ssh: ssh.trim() };
    pending.current = 'run';
    farRows.current = [];
    setFarSteps([]);
    setFarCode(undefined);
    setStopped(false);
    setBusy(true);
    setRunning(true);
    setError(undefined);
    bridge.send({ type: 'setup.join', svallPermissions: permissions });
  };
  // a Mac that only connects runs its robots on the server, so a missing agent CLI stops only the here path
  const blockers = plan.install ? [] : plan.blockers;
  if (!fork) return (
    <Page>
      <header className="setup-intro">
        <h1>Where should your fleet run?</h1>
        <p>The machine that runs the fleet is its home. You can change it later in Settings → Machines.</p>
      </header>
      {blockers.map((b) => <p key={b} className="setup-blocker">{b}</p>)}
      <div className="setup-list" data-testid="setup-fork">
        {FORKS.map(({ to, title, says }) => (
          <button key={to} type="button" className="setup-row" data-testid={`fork-${to}`} onClick={() => setFork(to)}>
            <span className="setup-agent-name">{title}<small className="plain">{says}</small></span>
            <Caret dir="right" />
          </button>
        ))}
      </div>
    </Page>
  );
  if (fork !== 'here') {
    // after a run that did not open the window, Back gives the form back as it was filled
    const back = () => {
      going.current = undefined;
      farRows.current = [];
      if (farSteps) setFarSteps(undefined); else setFork(undefined);
    };
    const wanting = busy ? 'Waits while Svall checks this Mac' : blockers.length > 0 ? 'Fix what is listed above first'
      : !/^[A-Za-z0-9][A-Za-z0-9._@:[\]-]*$/.test(ssh.trim()) ? 'Needs the server\'s ssh destination' : undefined;
    return (
      <Page>
        <header className="setup-intro">
          <h1>{fork === 'server' ? 'Set up a server' : 'Connect to your server'}</h1>
          <p>{farSteps ? ssh.trim() : 'Needs Tailscale on this Mac and on the server.'}</p>
        </header>
        {blockers.map((b) => <p key={b} className="setup-blocker">{b}</p>)}
        {farSteps ? <FarSteps rows={farSteps} running={running} code={farCode} stopped={stopped} /> : (
          <>
            <fieldset className="setup-fields" aria-busy={busy}>
              <label className="setup-field">
                <span className="kicker">server</span>
                <input {...AS_TYPED} className="fld mono" data-testid="fork-ssh" value={ssh} placeholder="you@studio" onChange={(e) => setSsh(e.target.value)} />
                <span className="setup-hint">What you type after ssh, such as you@studio.</span>
              </label>
              <div className="setup-list setup-preferences">
                <Preference {...NOTIFY} value={notify} set={setNotify} />
                <Preference {...PERMISSIONS} value={permissions} set={setPermissions} />
              </div>
            </fieldset>
            <Review writes={writes} />
            {error && <div role="alert"><Said {...splitRaw(error)} /></div>}
          </>
        )}
        <div className="setup-acts">
          {running ? <button type="button" className="btn" data-testid="fork-stop" disabled={stopped} onClick={() => { setStopped(true); bridge.send({ type: 'host.cancel' }); }}>{stopped ? 'Stopping…' : 'Stop'}</button> : (
            <>
              <button type="button" className="btn pri" data-testid="fork-go" disabled={!!wanting} data-tip={wanting} onClick={() => farRun(fork)}>
                {farSteps ? 'Try again' : fork === 'server' ? 'Set up and connect' : 'Connect'}
              </button>
              <button type="button" className="btn" data-testid="fork-back" disabled={busy} onClick={back}>Back</button>
              {blockers.length > 0 && <button type="button" className="btn" disabled={busy} onClick={check}>{busy ? 'Checking…' : 'Check again'}</button>}
            </>
          )}
        </div>
      </Page>
    );
  }
  const runnable = on.filter((a) => !a.folderOnly);
  const agent = runnable.find((a) => a.kind === main)?.kind ?? runnable[0]?.kind ?? main;
  if (plan.trustPaths?.[agent]) writes.splice(1, 0, { what: `${AGENT_LABEL[agent]}: folder trust for mission control${firstProject ? ` and ${firstProject.split('/').filter(Boolean).at(-1) ?? '/'}` : ''}`, path: plan.trustPaths[agent]! });
  const pick = (which: 'projects' | 'project') => { picking.current = which; bridge.send({ type: 'folder.pick', start: projects.trim() || '~', ...(machine.current && { machine: machine.current }) }); };
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
                  <span className="setup-agent-status" data-warning={!a.folderOnly && a.signedIn !== true}>{a.folderOnly ? 'CLI not found' : a.signedIn === true ? 'Logged in' : a.signedIn === false ? 'Not logged in' : 'Could not tell'}{a.version && <small>{a.version}</small>}</span>
                  {!a.folderOnly && a.signedIn !== true && <button type="button" className="btn sm" onClick={() => bridge.send({ type: 'setup.login', agent: a.kind })}>Log in…</button>}
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
              { ...NOTIFY, value: notify, set: setNotify },
              { title: 'Automatically update robot notes', text: "When an agent finishes, Svall asks your main agent for a short summary and updates the robot’s name and note. Each update uses a little of your plan or API credit.", value: scribe, set: setScribe },
              { ...PERMISSIONS, value: permissions, set: setPermissions },
            ].map((p) => <Preference key={p.title} {...p} />)}
            <div className="setup-preference"><label className="setup-new">New robots start<select className="fld" aria-label="New robots start" value={newRobots} onChange={(e) => setNewRobots(e.target.value as 'agent' | 'shell')}><option value="agent">Your main agent</option><option value="shell">A shell</option></select></label><small>What ⌘T opens.</small></div>
          </div>
          {!plan.shimOnPath && !plan.pathFile && <section><p>{shortPath(plan.shimDir)} is not on your PATH; add this line to your shell profile.</p><Command bridge={bridge} text={line} /></section>}
          <Review writes={writes} />
        </>}
      </fieldset>
      {error && <div className="setup-error" role="alert"><Said {...splitRaw(error)} /></div>}
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

const NOTIFY = { title: 'Notify me when an agent needs me', text: 'A banner with Approve and Deny when an agent asks for permission, and one when it finishes.' };
const PERMISSIONS = { title: 'Let robots run svall without asking', text: 'Robots can start, message and wait for other robots without a permission prompt.' };

const Preference = ({ title, text, value, set }: { title: string; text: string; value: boolean; set: (on: boolean) => void }) => (
  <label className="setup-preference"><span><input type="checkbox" aria-label={title} checked={value} onChange={(e) => set(e.target.checked)} />{title}</span><small>{text}</small></label>
);

const Review = ({ writes }: { writes: { what: string; path: string }[] }) => (
  <section className="setup-review">
    <p>Svall adds agent hooks, a background service and the svall command. The hooks only act inside Svall.</p>
    {/* opened, the list comes into view above the pinned buttons */}
    <details className="modal-more" onToggle={(e) => { if (e.currentTarget.open) e.currentTarget.scrollIntoView({ block: 'nearest' }); }}>
      <summary><Caret dir="right" />Review changes <span>{writes.length} locations</span></summary>
      {/* a launchd job reads by what it does, not by its label */}
      <ul className="setup-list">{writes.map((w) => <li key={w.path} className="setup-write"><span>{w.what}</span>
        {w.path.endsWith('.plist') ? <small>runs your robots while Svall is open</small> : <code>{shortPath(w.path)}</code>}</li>)}</ul>
    </details>
  </section>
);

const FORKS: { to: Fork; title: ReactNode; says: string }[] = [
  { to: 'here', title: 'This Mac', says: 'Robots run here and rest while this Mac sleeps.' },
  { to: 'server', title: <span>A server, set up now<span className="badge">recommended</span></span>, says: 'Svall installs itself on a Linux server over ssh. The fleet runs all day; this Mac connects to it.' },
  { to: 'join', title: 'A server that already runs your fleet', says: 'This Mac joins it.' },
];

const HERE = 'Svall on this Mac';
// the join's `home` step finds the fleet's home, where an add's looks at the home folder
const labelOf = (r: FarRow): string => (!r.op ? HERE : r.op === 'join' && r.step === 'home' ? 'The home' : stepLabel(r.step));
const STATE = { start: 'doing', ok: 'done', skip: 'done', warn: 'warned', fail: 'failed' } as const;
// a command the CLI sets in backticks, and a link, in mono
const MONO = /`([^`]+)`|(https?:\/\/\S+?)(?=[.,;)]?(?:\s|$))/g;
/** `text` with what the CLI marks as a command or link, and each of `commands`, in mono, the prose between them as it is. */
function inMono(text: string, commands: string[] = []): ReactNode {
  const spans = [...text.matchAll(MONO)].map((m) => ({ at: m.index, end: m.index + m[0].length, code: m[1] ?? m[2] }));
  for (const code of commands) {
    const at = text.indexOf(code);
    if (at >= 0 && !spans.some((s) => at < s.end && s.at < at + code.length)) spans.push({ at, end: at + code.length, code });
  }
  const parts: ReactNode[] = [];
  let from = 0;
  for (const { at, end, code } of spans.sort((a, b) => a.at - b.at)) {
    // the word before stays on the command's line, so a line never starts on a command alone
    const before = text.slice(from, at);
    const word = before.search(/\S*\s*$/);
    parts.push(before.slice(0, word), <span key={at} className="setup-keep">{before.slice(word)}<code>{code}</code></span>);
    from = end;
  }
  return parts.length ? [...parts, text.slice(from)] : text;
}
// the ssh a server's fix names ahead of what to run there
const SSH_THEN = /\b(ssh \S+), then /;

function FarStep({ row }: { row: FarRow }) {
  const plain = (text: string) => onThisMac(plainStep(text, {}));
  const action = row.action && plain(row.action);
  const said = row.detail && (row.raw ? { line: plain(row.detail), raw: withoutTokens(row.raw) } : splitRaw(plain(row.detail)));
  // what to do: the window's own words where the CLI gives them, its command behind details; else the CLI's, its commands in mono
  const fix = row.say ? plain(row.say) : action && inMono(action, [SSH_THEN.exec(action)?.[1], row.run].filter((c): c is string => !!c));
  const raw = [row.say && row.run, said && said.raw].filter(Boolean).join('\n') || undefined;
  const told = row.status === 'ok' || row.status === 'skip' ? undefined
    : said ? { line: inMono(said.line), raw, fix }
    : fix ? { line: fix, raw } : undefined;
  return (
    <li data-state={STATE[row.status]} data-step={row.step} data-status={row.status}>
      <span className="move-mark" aria-hidden><Mark status={row.status} /></span>
      <div>{labelOf(row)}{told && <Said {...told} mark={false} />}</div>
    </li>
  );
}

/**
 * A server path's run as a flow: its done steps folded behind a line, then what needs a person and the step under way, then
 * its notes folded. `code`: a run that ended short with no failed row; `stopped`: a Stop ended it.
 */
function FarSteps({ rows, running, code, stopped }: { rows: FarRow[]; running: boolean; code?: number; stopped: boolean }) {
  const [open, setOpen] = useState({ notes: false, done: false });
  const ended = rows.filter((r) => r.status !== 'start');
  // an add checks a machine, so a warning it may live with is a note; a join is a flow, whose warnings all need a person
  const tiered = (tier: Tier) => ended.filter((r) => tierOf(r, undefined, r.op !== 'add') === tier);
  const [todo, notes, done] = [tiered('todo'), tiered('note'), tiered('fine')];
  // a step is named as it starts and again as it ends; between two, and while the next run starts, the spinner stays on the last
  const now = rows.at(-1);
  const step = (r: FarRow) => <FarStep key={rows.indexOf(r)} row={r} />;
  const short = !running && (stopped || code !== undefined);
  return (
    <section data-testid="fork-steps">
      {done.length > 0 && (
        <button type="button" className="sec-fold host-fine" data-testid="fork-done" aria-expanded={open.done} onClick={() => setOpen({ ...open, done: !open.done })}>
          <Caret dir={open.done ? 'down' : 'right'} />{plural(done.length, 'step')} done
        </button>
      )}
      {open.done && <ol className="move-steps">{done.map(step)}</ol>}
      {(todo.length > 0 || running) && (
        <ol className="move-steps" aria-live="polite">
          {todo.map(step)}
          {running && (
            <li data-state="doing" data-testid="fork-now">
              <span className="move-mark" aria-hidden><span className="move-spin" /></span><span>{now ? labelOf(now) : HERE}…</span>
            </li>
          )}
        </ol>
      )}
      {short && <div role="alert" data-testid="fork-ended">{stopped ? <Said line="Stopped" /> : <Said line="Setup stopped without saying why" raw={`exit ${code}`} />}</div>}
      {notes.length > 0 && (
        <button type="button" className="sec-fold host-fine" data-testid="fork-notes" aria-expanded={open.notes} onClick={() => setOpen({ ...open, notes: !open.notes })}>
          <Caret dir={open.notes ? 'down' : 'right'} />{plural(notes.length, 'note')}
        </button>
      )}
      {open.notes && <ol className="move-steps">{notes.map(step)}</ol>}
    </section>
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

// the column hangs at one height on every page, so a step's heading stays put, and scrolls once taller
const Page = ({ children }: { children: ReactNode }) => (
  <div className="setup" data-testid="setup"><div className="setup-body">{children}</div></div>
);
