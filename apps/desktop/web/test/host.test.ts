import { describe, expect, it } from 'vitest';
import {
  applyStep, beginRun, endRun, groupSteps, loginForward, machineName, outcomeOf,
  plainStep, replaceRows, rowToStep, runActions, sshDestination, stepLabel, stepSaid, withoutTokens,
} from '../src/host.js';
import type { HostStep } from '../src/bridge.js';

const step = (s: string, status: 'start' | 'ok' | 'warn' | 'fail' | 'skip', extra: Omit<HostStep, 'step' | 'status'> = {}) =>
  ({ step: s, status, ...extra });

describe('host run', () => {
  it('folds each step event onto the row it belongs to, in the order they arrive', () => {
    let run = beginRun('add', { name: 'box' });
    run = applyStep(run, step('ssh', 'start'));
    run = applyStep(run, step('ssh', 'ok', { detail: 'u@h accepted an interactive login' }));
    run = applyStep(run, step('tmux', 'warn', { detail: 'tmux 3.4: Shift+Enter needs tmux 3.5' }));
    expect(run.steps).toEqual([
      { step: 'ssh', status: 'ok', detail: 'u@h accepted an interactive login' },
      { step: 'tmux', status: 'warn', detail: 'tmux 3.4: Shift+Enter needs tmux 3.5' },
    ]);
    expect(run.running).toBe(true);
    expect(run.code).toBeUndefined();
  });

  it('keeps what the user can do about a step, and ends with the exit code', () => {
    let run = beginRun('add', { name: 'box', ssh: 'u@h' });
    run = applyStep(run, step('claude', 'warn', { detail: '1.2.3, not logged in', action: 'ssh u@h, then claude auth status and log in' }));
    run = applyStep(run, step('probe', 'fail', { detail: 'the daemon did not answer', action: 'ssh u@h and see what svall doctor says' }));
    expect(runActions(run)).toEqual(['ssh u@h, then claude auth status and log in', 'ssh u@h and see what svall doctor says']);
    run = applyStep(run, step('codex', 'warn', { detail: 'not logged in', action: 'ssh u@h, then codex login', run: 'codex login' }));
    expect(run.steps.at(-1)?.run).toBe('codex login');
    const tick = { item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: false, preview: ['env.LINEAR_API_KEY lin…90'] };
    run = applyStep(run, step('mirror:claude:mcp:linear', 'warn', { action: "copy linear's keys to box", run: 'claude', forward: 3334, tick }));
    expect(run.steps.at(-1)).toEqual(step('mirror:claude:mcp:linear', 'warn', { action: "copy linear's keys to box", run: 'claude', forward: 3334, tick }));
    run = endRun(run, 1);
    expect(run.running).toBe(false);
    expect(run.code).toBe(1);
  });

  it('never keeps a token a step carried', () => {
    let run = beginRun('doctor', { name: 'box' });
    run = applyStep(run, step('probe', 'fail', { detail: 'ws://127.0.0.1:47800 refused token=s3cr3t-value', action: 'retry with --token s3cr3t-value' }));
    expect(run.steps[0].detail).toBe('ws://127.0.0.1:47800 refused token=…');
    expect(run.steps[0].action).toBe('retry with --token …');
    expect(JSON.stringify(run)).not.toContain('s3cr3t');
  });

  it('names no machine by its id, and keeps an id that names a file', () => {
    const [other, far] = ['9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f', '66666666-7777-8888-9999-aaaaaaaaaaaa'];
    let run = beginRun('add', { name: 'trift', ssh: 'trift.test' });
    run = applyStep(run, step('master', 'fail', { detail: `trift.test now reaches machine ${other}, not trift (${far})`, action: `point trift.test back at trift (${far})` }));
    run = applyStep(run, step('claude', 'warn', { detail: `/Users/ada/.claude/projects/-app/${other}.jsonl is not there` }));
    expect(run.steps.map((s) => s.detail)).toEqual([
      'trift.test now reaches another machine, not trift',
      `/Users/ada/.claude/projects/-app/${other}.jsonl is not there`,
    ]);
    expect(run.steps[0].action).toBe('point trift.test back at trift');
  });

  it('names a machine this Mac knows by its name, and leaves out the ids of fleets', () => {
    const [studio, other, fleet, theirs] = ['5d4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f', '9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f', '7f7f0b1c-2d3e-4f50-8617-9a0b1c2d3e4f', '8e8e0b1c-2d3e-4f50-8617-9a0b1c2d3e4f'];
    const names = { [studio]: 'studio' };
    const said = (detail: string) => applyStep(beginRun('upgrade', { name: 'trift' }), step('identity', 'fail', { detail }), names).steps[0].detail;
    expect(said(`trift.test now reaches machine ${studio}, not trift (${other})`)).toBe('trift.test now reaches studio, not trift');
    expect(said(`trift answered with machineId ${other}, not ${studio}`)).toBe('trift answered as another machine');
    expect(said(`trift answered with fleetId ${theirs}, not ${fleet}: it runs another fleet there`)).toBe('trift answered for another fleet: it runs another fleet there');
  });

  it('drops an id it does not know from a step line', () => {
    expect(plainStep('stuck in move 3f1a0b1c-2d3e-4f50-8617-9a0b1c2d3e4f', {})).toBe('stuck in move');
  });

  it('masks a token wherever it is labelled, and leaves the rest of the line alone', () => {
    expect(withoutTokens('machine 3f2a-9c: {"token":"abc123"} ok')).toBe('machine 3f2a-9c: {"token":"…"} ok');
    expect(withoutTokens('no secret here')).toBe('no secret here');
  });

  it('masks a token in a query string and in an environment variable', () => {
    expect(withoutTokens('GET /?token=abc123 failed')).toBe('GET /?token=… failed');
    expect(withoutTokens('opened /?port=47800&token=abc123&view=board')).toBe('opened /?port=47800&token=…&view=board');
    expect(withoutTokens('SVALL_TOKEN=abc123 svall status')).toBe('SVALL_TOKEN=… svall status');
    expect(withoutTokens('?token=abc123 &token=def456 SVALL_TOKEN=ghi789')).not.toMatch(/abc123|def456|ghi789/);
  });
});

describe('the end of a run', () => {
  const ended = (op: 'add' | 'doctor' | 'upgrade' | 'rollback' | 'remove', code: number, steps: ReturnType<typeof step>[], args = {}) =>
    endRun(steps.reduce((run, s) => applyStep(run, s), beginRun(op, { name: 'box', ...args })), code);
  const ready = 'box is ready. Robots you move there keep working while this Mac sleeps.';

  it('the outcome line reads ready when nothing is left to fix, counts the things to fix otherwise, then the parts of the agent setup that will not work there', () => {
    expect(outcomeOf(ended('add', 0, [step('ssh', 'ok'), step('tmux', 'warn'), step('probe', 'ok'), step('registry', 'ok')]))).toEqual({ text: ready, done: true });
    expect(outcomeOf(ended('upgrade', 0, [step('probe', 'ok'), step('enrol', 'ok')]))).toEqual({ text: ready, done: true });
    expect(outcomeOf(ended('doctor', 0, [step('tmux', 'warn', { detail: '3.4' }), step('codex', 'skip'), step('release', 'ok')]))).toEqual({ text: ready, done: true });
    // each step's action is one thing, and so is each failed step that names none
    expect(outcomeOf(ended('add', 1, [step('claude', 'warn', { action: 'log in' }), step('registry', 'ok')]))).toEqual({ text: 'box has 1 thing to fix.' });
    expect(outcomeOf(ended('add', 1, [step('claude', 'warn', { action: 'log in' }), step('install', 'fail', { detail: 'svall setup exited 1' })])))
      .toEqual({ text: 'box has 2 things to fix.' });
    const blocked = ended('doctor', 1, [step('tmux', 'warn'), step('release', 'fail', { detail: '0.4.0, protocol 3' }), step('systemd', 'fail', { detail: 'inactive' })]);
    expect(outcomeOf(blocked)).toEqual({ text: 'box has 2 things to fix.' });
    // the agent setup is nothing to fix: a row naming a gap is a part that will not work there, though two read alike, and one that only asks to check again is none
    const again = (key: string) => step(`mirror:${key}`, 'warn', { action: 'check box again', detail: 'not checked: box is not reachable' });
    const gap = (key: string, name: string) => step(`mirror:${key}`, 'warn', { action: `copy ${name}'s keys to box`, gap: { name, what: 'keys not copied (env.KEY)' } });
    const mirrored = ended('doctor', 0, [step('ssh', 'ok'), again('claude:mcp:linear'), again('var:X'), gap('claude:mcp:github', 'github'), gap('codex:mcp:github', 'github')]);
    const parts = 'box is ready. 2 parts of your agent setup will not work there yet.';
    expect(outcomeOf(mirrored)).toEqual({ text: parts, done: true, setup: 2 });
    expect(outcomeOf(ended('upgrade', 0, [step('probe', 'ok'), gap('claude:mcp:linear', 'linear')])))
      .toEqual({ text: 'box is ready. 1 part of your agent setup will not work there yet.', done: true, setup: 1 });
    expect(outcomeOf(ended('add', 1, [step('claude', 'warn', { action: 'log in' }), step('registry', 'ok'), gap('claude:mcp:linear', 'linear')])))
      .toEqual({ text: 'box has 1 thing to fix, and 1 part of your agent setup will not work there yet.', setup: 1 });
    // a part with nothing to do about it, as a server that only runs on a Mac, will not work there, not yet
    const macOnly = step('mirror:maconly:claude:chrome', 'skip', { gap: { name: 'chrome', what: 'runs only on a Mac' } });
    expect(outcomeOf(ended('doctor', 0, [step('ssh', 'ok'), macOnly]))).toEqual({ text: 'box is ready. 1 part of your agent setup will not work there.', done: true, setup: 1 });
    expect(outcomeOf(ended('doctor', 0, [macOnly, gap('claude:mcp:linear', 'linear')])).text).toBe('box is ready. 2 parts of your agent setup will not work there yet.');
    // one stopped part way said nothing it left to do
    expect(outcomeOf(ended('add', 143, [step('ssh', 'ok'), step('tmux', 'ok')]))).toEqual({ text: 'Add machine ended with exit 143' });
    expect(outcomeOf(ended('add', 1, [step('registry', 'ok'), step('probe', 'fail')]))).toEqual({ text: 'box has 1 thing to fix.' });
  });

  it('offers Roll back only when the rollback after a failed upgrade failed too', () => {
    expect(outcomeOf(ended('upgrade', 1, [step('probe', 'warn'), step('rollback', 'fail', { detail: 'setup --rollback exited 1' })])).next).toBe('rollback');
    // an upgrade stopped before it installed left the machine as it was, and one stopped in install has no release to go back from
    expect(outcomeOf(ended('upgrade', 1, [step('master', 'fail', { detail: 'no' })])).next).toBeUndefined();
    expect(outcomeOf(ended('upgrade', 1, [step('install', 'fail', { detail: 'no' })])).next).toBeUndefined();
    expect(outcomeOf(ended('upgrade', 1, [step('probe', 'warn'), step('rollback', 'warn', { action: 'read the log' })])).next).toBeUndefined();
  });

  it('says what a removal and a rollback did, or where it stopped', () => {
    expect(outcomeOf(ended('remove', 0, [step('registry', 'ok')]))).toEqual({ text: 'box is removed', done: true });
    expect(outcomeOf(ended('remove', 0, [step('uninstall', 'skip')], { forget: true }))).toEqual({ text: 'box is forgotten', done: true });
    expect(outcomeOf(ended('rollback', 0, [step('probe', 'ok')]))).toEqual({ text: 'box is rolled back', done: true });
    expect(outcomeOf(ended('remove', 1, [step('uninstall', 'fail', { detail: 'svall uninstall exited 1' })]))).toEqual({ text: 'Remove stopped at Uninstall: svall uninstall exited 1' });
    expect(outcomeOf(ended('remove', 1, []))).toEqual({ text: 'Remove ended with exit 1' });
  });
});

describe('a step by name', () => {
  it('reads as plain words, and a step it does not know as itself', () => {
    expect(['master', 'identity', 'enrol', 'registry', 'keys'].map(stepLabel))
      .toEqual(['Connection', 'Installed release', 'Worker', 'Machine list', 'Copied keys']);
    // the checks a machine's own doctor reports
    expect(['systemd', 'daemon env', 'gh', 'path', 'codex sandbox', 'opencode plugin', 'linger', 'doctor'].map(stepLabel))
      .toEqual(['Fleet service', 'Service environment', 'GitHub CLI', 'PATH', 'Codex sandbox', 'OpenCode plugin', 'Runs after logout', "Machine's own checks"]);
    expect(stepLabel('weather')).toBe('weather');
  });

  it('stepLabel names a mirror row by agent and server, a var row by its variable', () => {
    expect(stepLabel('mirror:claude:mcp:linear')).toBe('Claude MCP linear'); expect(stepLabel('mirror:var:GAMMA_TOKEN')).toBe('GAMMA_TOKEN');
    expect([
      'mirror:codex:mcp:github', 'mirror:opencode:mcp:sentry@/Users/ada/app', 'mirror:claude:plugin:acme@market:mcp:db', 'mirror:oauth:claude:mcp:notion',
      'mirror:oauth:claude:plugin:acme:mcp:db', 'mirror:runtime:npx', 'mirror:maconly:claude:chrome', 'mirror:claude:settings', 'mirror:codex:config',
      'mirror:opencode:config', 'mirror:claude:plugin:acme@market', 'mirror:unreadable:/Users/ada/.codex/config.toml', 'mirror:unchecked',
      'mirror:claude:agent:team/db.md', 'mirror:claude:marketplace:market',
    ].map(stepLabel)).toEqual([
      'Codex MCP github', 'OpenCode MCP sentry', 'plugin acme@market MCP db', 'notion login', 'db login', 'npx', 'chrome', 'settings.json', 'Codex config.toml',
      'OpenCode opencode.json', 'plugin acme@market', '/Users/ada/.codex/config.toml', 'Not checked', 'subagent team/db.md', 'marketplace market',
    ]);
  });

  it('leaves out the machine the panel already names where a step starts with it', () => {
    expect(stepSaid({ step: 'identity', status: 'ok', detail: 'studio runs release 0.5.0' }, 'studio')).toBe('runs release 0.5.0');
    expect(stepSaid({ step: 'enrol', status: 'ok', detail: "studio's fleet home serves this fleet" }, 'studio')).toBe("studio's fleet home serves this fleet");
    expect(stepSaid({ step: 'ssh', status: 'ok', detail: 'studios answered' }, 'studio')).toBe('studios answered');
    expect(stepSaid({ step: 'ssh', status: 'ok' }, 'studio')).toBeUndefined();
  });
});

describe('the attended checklist', () => {
  it('names the phase each step belongs to, in the order the steps arrived', () => {
    const steps = [step('ssh', 'ok'), step('master', 'ok'), step('tools', 'ok'), step('release', 'ok'), step('tmux', 'ok'),
                   step('claude', 'warn'), step('codex', 'ok'), step('opencode', 'ok'), step('versions', 'warn'), step('probe', 'ok')];
    expect(groupSteps(steps).map((g) => [g.label, g.rows.map((r) => r.step)])).toEqual([
      ['Reaching it', ['ssh', 'master']],
      ['What it needs', ['tools']],
      ['Svall there', ['release', 'tmux']],
      ['Agents there', ['claude', 'codex', 'opencode', 'versions']],
      ['Trying it out', ['probe']],
    ]);
  });

  it('groups steps under the six labels in the spec\'s order, mirror rows by prefix, and registry under Trying it out', () => {
    const steps = ['ssh', 'master', 'release', 'claude', 'gh', 'probe', 'registry', 'mirror:claude:mcp:linear'].map((s) => step(s, 'ok'));
    expect(groupSteps(steps).map((g) => g.label)).toEqual(['Reaching it', 'Svall there', 'Agents there', 'Your agent setup', 'Trying it out']);
    // a machine's own doctor reports its service, and the checks Svall knows nothing of come last
    expect(groupSteps(['weather', 'systemd', 'git', 'mirror:unchecked'].map((s) => step(s, 'ok'))).map((g) => [g.label, g.rows.map((r) => r.step)])).toEqual([
      ['What it needs', ['git']], ['Svall there', ['systemd']], ['Your agent setup', ['mirror:unchecked']], ['Checks', ['weather']],
    ]);
  });

  it("a step that comes back to an earlier phase joins that phase's group", () => {
    expect(groupSteps([step('ssh', 'ok'), step('tools', 'ok'), step('master', 'ok')]).map((g) => [g.label, g.rows.map((r) => r.step)]))
      .toEqual([['Reaching it', ['ssh', 'master']], ['What it needs', ['tools']]]);
  });

  it('calls no phase by the name of a step in it', () => {
    const steps = ['name', 'machine', 'ssh', 'master', 'os', 'home', 'tools', 'space', 'linger', 'release', 'upload', 'install',
      'tmux', 'uninstall', 'keys', 'service', 'identity', 'claude', 'codex', 'opencode', 'versions', 'probe', 'rollback', 'registry'];
    for (const g of groupSteps(steps.map((s) => step(s, 'ok')))) expect(g.rows.map((r) => stepLabel(r.step))).not.toContain(g.label);
  });

  it('shows every phase of an add, and of a removal, as one run', () => {
    const add = ['name', 'ssh', 'master', 'os', 'home', 'tools', 'space', 'linger', 'release', 'upload',
      'install', 'tmux', 'service', 'identity', 'claude', 'codex', 'opencode', 'versions', 'probe', 'registry'];
    const remove = ['machine', 'uninstall', 'registry'];
    for (const steps of [add, remove]) {
      const labels = groupSteps(steps.map((s) => step(s, 'ok'))).map((g) => g.label);
      expect(labels).not.toContain('Checks');
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it('puts the rollback of an upgrade whose probe failed beside the probe, after it', () => {
    const steps = [step('machine', 'ok'), step('master', 'ok'), step('release', 'ok'), step('upload', 'ok'), step('install', 'ok'),
                   step('probe', 'warn'), step('rollback', 'warn')];
    expect(groupSteps(steps).map((g) => [g.label, g.rows.map((r) => r.step)])).toEqual([
      ['Reaching it', ['machine', 'master']],
      ['Svall there', ['release', 'upload', 'install']],
      ['Trying it out', ['probe', 'rollback']],
    ]);
  });

  it('shows a step it does not know rather than dropping it', () => {
    expect(groupSteps([step('weather', 'ok')])).toEqual([{ phase: 'other', label: 'Checks', rows: [step('weather', 'ok')] }]);
  });

  it('replaceRows swaps the mirror rows in place and keeps every other step', () => {
    const run = { ...beginRun('doctor', { name: 'box' }), steps: [step('ssh', 'ok'), step('mirror:claude:mcp:linear', 'warn'), step('mirror:var:X', 'warn'), step('probe', 'ok')] };
    expect(replaceRows(run, [step('mirror:claude:mcp:linear', 'ok')]).steps).toEqual([step('ssh', 'ok'), step('mirror:claude:mcp:linear', 'ok'), step('probe', 'ok')]);
    expect(replaceRows({ ...run, steps: [step('ssh', 'ok')] }, [step('mirror:var:X', 'warn')]).steps).toEqual([step('ssh', 'ok'), step('mirror:var:X', 'warn')]);
  });

  it('replaceRows words the rows as a step from the shell is worded: no token, and a machine by its name', () => {
    const studio = '5d4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f';
    const rows = [step('mirror:var:X', 'warn', { action: `check machine ${studio} again`, detail: 'pushed with token=s3cr3t; not yet there' })];
    const run = replaceRows(beginRun('doctor', { name: 'studio' }), rows, { [studio]: 'studio' });
    expect(run.steps).toEqual([step('mirror:var:X', 'warn', { action: 'check studio again', detail: 'pushed with token=…; not yet there' })]);
  });

  it('rowToStep names a row of the report as svall host does, keeping what it carries', () => {
    const tick = { item: 'claude:mcp:linear', fields: ['env.LINEAR_API_KEY'], on: true, preview: ['env.LINEAR_API_KEY lin…90'] };
    expect(rowToStep({ key: 'claude:mcp:linear', status: 'ok', detail: 'keys copied to box: env.LINEAR_API_KEY lin…90', tick }))
      .toEqual({ step: 'mirror:claude:mcp:linear', status: 'ok', detail: 'keys copied to box: env.LINEAR_API_KEY lin…90', tick });
    expect(rowToStep({ key: 'oauth:codex:mcp:figma', status: 'skip', detail: 'log in once', run: 'codex mcp login figma', forward: 1455 }))
      .toEqual({ step: 'mirror:oauth:codex:mcp:figma', status: 'skip', detail: 'log in once', run: 'codex mcp login figma', forward: 1455 });
  });
});

describe('what the page may ask for', () => {
  it('holds a machine name and an ssh destination to what the registry takes', () => {
    expect(machineName('box-1')).toBe(true);
    expect(machineName('Box')).toBe(false);
    expect(machineName('-box')).toBe(false);
    expect(machineName('')).toBe(false);
    expect(sshDestination('linus@studio')).toBe(true);
    expect(sshDestination('--oProxyCommand=x')).toBe(false);
    expect(sshDestination('a b')).toBe(false);
  });

  it("forwards Codex's login port only to a login that waits for the browser on it", () => {
    expect(loginForward('codex login')).toBe(1455);
    expect(loginForward('codex login --device-auth')).toBeUndefined();
    expect(loginForward('codex')).toBeUndefined();
    expect(loginForward('claude auth login')).toBeUndefined();
  });

  it("loginForward prefers the row's forward, then codex login's 1455", () => {
    expect(loginForward('claude', 3334)).toBe(3334); expect(loginForward('codex login')).toBe(1455);
    // the Claude login's row names the port its run fixes; a run alone names none
    expect(loginForward('MCP_OAUTH_CALLBACK_PORT=3118 claude', 3118)).toBe(3118);
    expect(loginForward('MCP_OAUTH_CALLBACK_PORT=3118 claude')).toBeUndefined();
    expect(loginForward('claude')).toBeUndefined();
  });
});
