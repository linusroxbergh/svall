import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  applyStep, beginRun, endRun, groupSteps, loginForward, machineName, outcomeOf, overHome,
  plainStep, replaceRows, rowToStep, runActions, runningLine, splitRaw, sshDestination, stepLabel, stepSaid, withoutTokens,
} from '../src/host.js';
import { fleet } from './fixtures.js';
import type { HostStep } from '../src/bridge.js';

const step = (s: string, status: 'start' | 'ok' | 'warn' | 'fail' | 'skip', extra: Omit<HostStep, 'step' | 'status'> = {}) =>
  ({ step: s, status, ...extra });

describe('what a terminal on a far home types', () => {
  // the words the shell here hands ssh, the far command its last
  const farCommand = (line: string): string => execFileSync('sh', ['-c', `ssh() { for last; do :; done; printf %s "$last"; }; ${line}`], { encoding: 'utf8' });

  it.each([
    ['a single quote', "echo 'it''s'"],
    ['a dollar', 'echo $HOME "$(id)"'],
  ])('a run with %s reaches the far shell whole, and this one reads none of it', (_what, run) => {
    expect(farCommand(overHome('ada@box', run))).toBe(run);
  });
});

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

  it('keeps what a tool said with its step, word for word but for a token, its machine ids and all', () => {
    const id = '9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f';
    let run = applyStep(beginRun('doctor', { name: 'box' }), step('probe', 'fail', { detail: 'does not answer', raw: `machine ${id} refused token=s3cr3t-value` }));
    expect(run.steps[0].raw).toBe(`machine ${id} refused token=…`);
    run = replaceRows(run, [rowToStep({ key: 'var:X', status: 'warn', detail: 'not set', raw: 'svall worker env X exited 1: --token s3cr3t' })]);
    expect(run.steps.at(-1)?.raw).toBe('svall worker env X exited 1: --token …');
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

  it('reads ready when no row needs the person, and counts the rows that do otherwise, in one line', () => {
    expect(outcomeOf(ended('upgrade', 0, [step('probe', 'ok'), step('enrol', 'ok')]))).toEqual({ text: 'box is ready', done: true });
    // a check's warning that needs no one is a note, and leaves the machine ready
    expect(outcomeOf(ended('add', 0, [step('ssh', 'ok'), step('tmux', 'warn'), step('probe', 'ok'), step('registry', 'ok')]))).toEqual({ text: 'box is ready', done: true });
    expect(outcomeOf(ended('doctor', 0, [step('tmux', 'warn'), step('gh', 'warn'), step('codex', 'skip'), step('release', 'ok')]))).toEqual({ text: 'box is ready', done: true });
    // a failure and a warning that needs the person are each a thing to fix
    expect(outcomeOf(ended('add', 1, [step('linger', 'warn', { action: 'enable linger' }), step('registry', 'ok')]))).toEqual({ text: 'box has 1 thing to fix' });
    expect(outcomeOf(ended('doctor', 1, [step('tmux', 'warn'), step('release', 'fail'), step('systemd', 'fail')]))).toEqual({ text: 'box has 2 things to fix' });
    // in a step flow every warning is
    expect(outcomeOf(ended('upgrade', 1, [step('probe', 'warn'), step('tmux', 'warn')]))).toEqual({ text: 'box has 2 things to fix' });
    // the agent setup is never a thing to fix
    const gap = step('mirror:claude:mcp:linear', 'warn', { action: "copy linear's keys to box", gap: { name: 'linear', what: 'keys not copied (env.KEY)' } });
    expect(outcomeOf(ended('doctor', 0, [step('ssh', 'ok'), gap]))).toEqual({ text: 'box is ready', done: true });
  });

  it('counts an agent the fleet does not run as a note, and one it runs as a thing to fix', () => {
    const run = ended('doctor', 0, [step('opencode', 'warn', { detail: 'not installed' }), step('claude', 'warn', { detail: '2.1.3, not logged in' })]);
    expect(outcomeOf(run).text).toBe('box has 2 things to fix');
    expect(outcomeOf(run, { ...fleet(), mainAgent: 'claude', scribeAgent: 'claude' }).text).toBe('box has 1 thing to fix');
  });

  it('says an add that did not go through did not finish, or ended without saying why with its exit behind details', () => {
    expect(outcomeOf(ended('add', 1, [step('claude', 'warn', { action: 'log in' }), step('probe', 'fail', { detail: 'does not answer' })]))).toEqual({ text: 'Add machine did not finish', failed: true });
    expect(outcomeOf(ended('add', 143, [step('ssh', 'ok'), step('tmux', 'ok')]))).toEqual({ text: 'Add machine ended without saying why', raw: 'exit 143', failed: true });
    // listed, it is the machine's
    expect(outcomeOf(ended('add', 1, [step('registry', 'ok'), step('linger', 'warn')]))).toEqual({ text: 'box has 1 thing to fix' });
  });

  it('offers Roll back only when the rollback after a failed upgrade failed too', () => {
    expect(outcomeOf(ended('upgrade', 1, [step('probe', 'warn'), step('rollback', 'fail', { detail: 'setup --rollback exited 1' })])))
      .toEqual({ text: 'Upgrade did not finish', failed: true, next: 'rollback' });
    expect(outcomeOf(ended('upgrade', 1, [step('install', 'fail', { detail: 'no' })])).text).toBe('Upgrade did not finish');
    // one that put the release before back did not do what it was for, and counts nothing to fix
    expect(outcomeOf(ended('upgrade', 1, [step('probe', 'warn'), step('rollback', 'warn', { detail: 'back on 0.9.3' })]))).toEqual({ text: 'Upgrade did not finish', failed: true });
    // an upgrade stopped before it installed left the machine as it was, and one stopped in install has no release to go back from
    expect(outcomeOf(ended('upgrade', 1, [step('master', 'fail', { detail: 'no' })])).next).toBeUndefined();
    expect(outcomeOf(ended('upgrade', 1, [step('install', 'fail', { detail: 'no' })])).next).toBeUndefined();
    expect(outcomeOf(ended('upgrade', 1, [step('probe', 'warn'), step('rollback', 'warn', { action: 'read the log' })])).next).toBeUndefined();
  });

  it('says what a removal and a rollback did, or that it did not finish without repeating its row', () => {
    expect(outcomeOf(ended('remove', 0, [step('registry', 'ok')]))).toEqual({ text: 'box is removed', done: true });
    expect(outcomeOf(ended('remove', 0, [step('uninstall', 'skip')], { forget: true }))).toEqual({ text: 'box is forgotten', done: true });
    expect(outcomeOf(ended('rollback', 0, [step('probe', 'ok')]))).toEqual({ text: 'box is rolled back', done: true });
    expect(outcomeOf(ended('remove', 1, [step('uninstall', 'fail', { detail: 'stopped with an error' })]))).toEqual({ text: 'Remove did not finish', failed: true });
    expect(outcomeOf(ended('remove', 1, []))).toEqual({ text: 'Remove ended without saying why', raw: 'exit 1', failed: true });
  });

  it('says a run under way by what it does to the machine', () => {
    expect(['add', 'doctor', 'upgrade', 'rollback', 'remove'].map((op) => runningLine({ op: op as 'add', args: { name: 'box' } })))
      .toEqual(['Adding box…', 'Checking box…', 'Upgrading box…', 'Rolling back box…', 'Removing box…']);
    expect(runningLine({ op: 'remove', args: { name: 'box', forget: true } })).toBe('Forgetting box…');
  });
});

describe('a step by name', () => {
  it('reads as plain words, and a step it does not know as itself', () => {
    expect(['ssh', 'master', 'identity', 'enrol', 'registry', 'keys', 'mark'].map((s) => stepLabel(s)))
      .toEqual(['Login', 'Connection', 'Release there', 'Worker', 'Listed here', 'Keys', 'Hand over']);
    // the checks a machine's own doctor reports, its service by no unit or label, and the port it answers on apart from it
    expect(['systemd', 'launchd', 'svalld', 'daemon env', 'daemon path', 'daemon node', 'gh', 'path', 'codex sandbox', 'opencode plugin', 'linger', 'doctor'].map((s) => stepLabel(s)))
      .toEqual(['Background service', 'Background service', 'Service port', 'Service environment', 'Service path', "Service's Node", 'GitHub CLI', 'PATH', 'Codex sandbox',
        'OpenCode plugin', 'Keeps running', 'Checks there']);
    expect(stepLabel('weather')).toBe('weather');
  });

  it('names the steps of a join and a home move', () => {
    expect(['fleet', 'tailscale', 'snapshot', 'seed', 'join', 'adopt', 'pause', 'copy', 'mission', 'phone', 'workers', 'abort', 'check'].map((s) => stepLabel(s))).toEqual([
      'This fleet', 'Tailscale', 'First copy of the fleet', 'Your agent setup', 'This Mac joins', 'Takes over', 'Pause', 'Copy the fleet', 'Mission control',
      'Phone link', 'Other workers', 'Call off', 'Check',
    ]);
  });

  it('stepLabel names a mirror row by agent and server, a var row by its variable', () => {
    expect(stepLabel('mirror:claude:mcp:linear')).toBe('Claude MCP linear'); expect(stepLabel('mirror:var:GAMMA_TOKEN')).toBe('GAMMA_TOKEN');
    expect([
      'mirror:codex:mcp:github', 'mirror:opencode:mcp:sentry@/Users/ada/app', 'mirror:claude:plugin:acme@market:mcp:db', 'mirror:oauth:claude:mcp:notion',
      'mirror:oauth:claude:plugin:acme:mcp:db', 'mirror:runtime:npx', 'mirror:maconly:claude:chrome', 'mirror:claude:settings', 'mirror:codex:config',
      'mirror:opencode:config', 'mirror:claude:plugin:acme@market', 'mirror:unreadable:/Users/ada/.codex/config.toml', 'mirror:unchecked',
      'mirror:claude:agent:team/db.md', 'mirror:claude:marketplace:market',
    ].map((s) => stepLabel(s))).toEqual([
      'Codex MCP github', 'OpenCode MCP sentry', 'db (plugin acme)', 'notion', 'db', 'npx', 'chrome', 'settings.json', 'Codex config.toml',
      'OpenCode config', 'plugin acme@market', '/Users/ada/.codex/config.toml', 'Not checked', 'subagent team/db.md', 'marketplace market',
    ]);
    // the phone's row names the home by the window's name for it
    expect([stepLabel('mirror:phone'), stepLabel('mirror:phone', 'studio')]).toEqual(['Phone while this Mac is off', 'Phone while studio is off']);
  });

  it('leaves out the machine the sheet already names where a step starts with it', () => {
    expect(stepSaid({ step: 'identity', status: 'ok', detail: 'studio runs release 0.5.0' }, 'studio')).toEqual({ line: 'runs release 0.5.0' });
    expect(stepSaid({ step: 'enrol', status: 'ok', detail: "studio's fleet home serves this fleet" }, 'studio')).toEqual({ line: "studio's fleet home serves this fleet" });
    expect(stepSaid({ step: 'ssh', status: 'ok', detail: 'studios answered' }, 'studio')).toEqual({ line: 'studios answered' });
    expect(stepSaid({ step: 'ssh', status: 'ok' }, 'studio')).toEqual({});
  });

  it('says how a step stands, a tool\'s words cut off behind it', () => {
    expect(stepSaid({ step: 'relay', status: 'fail', detail: 'relay  svall host doctor there exited 1: ssh: connect to host' }, 'studio'))
      .toEqual({ line: 'relay  svall host doctor there', raw: 'exited 1: ssh: connect to host' });
  });
});

describe('the attended checklist', () => {
  it('names the section each step belongs to, in the order the steps arrived, the sections about the machine by its name', () => {
    const steps = [step('ssh', 'ok'), step('master', 'ok'), step('tools', 'ok'), step('release', 'ok'), step('tmux', 'ok'),
                   step('claude', 'warn'), step('codex', 'ok'), step('opencode', 'ok'), step('versions', 'warn'), step('probe', 'ok')];
    expect(groupSteps(steps, 'studio').map((g) => [g.label, g.rows.map((r) => r.step)])).toEqual([
      ['Connection', ['ssh', 'master']],
      ['System', ['tools']],
      ['Svall on studio', ['release', 'tmux']],
      ['Agents on studio', ['claude', 'codex', 'opencode', 'versions']],
      ['Final check', ['probe']],
    ]);
  });

  it('groups steps under the sections in the sheet\'s order, mirror rows by prefix, the registry under Final check and the unknown last', () => {
    const steps = ['ssh', 'master', 'release', 'claude', 'gh', 'probe', 'registry', 'mirror:claude:mcp:linear'].map((s) => step(s, 'ok'));
    expect(groupSteps(steps, 'box').map((g) => g.label)).toEqual(['Connection', 'Svall on box', 'Agents on box', 'Your agent setup', 'Final check']);
    // a machine's own doctor reports its service, and the checks Svall knows nothing of come last
    expect(groupSteps(['weather', 'systemd', 'launchd', 'git', 'mirror:unchecked'].map((s) => step(s, 'ok')), 'box').map((g) => [g.label, g.rows.map((r) => r.step)])).toEqual([
      ['System', ['git']], ['Svall on box', ['systemd', 'launchd']], ['Your agent setup', ['mirror:unchecked']], ['Other checks', ['weather']],
    ]);
  });

  it("a step that comes back to an earlier phase joins that phase's group", () => {
    expect(groupSteps([step('ssh', 'ok'), step('tools', 'ok'), step('master', 'ok')], 'box').map((g) => [g.label, g.rows.map((r) => r.step)]))
      .toEqual([['Connection', ['ssh', 'master']], ['System', ['tools']]]);
  });

  it('shows every phase of an add, and of a removal, as one run', () => {
    const add = ['name', 'ssh', 'master', 'os', 'home', 'tools', 'space', 'linger', 'release', 'upload',
      'install', 'tmux', 'service', 'identity', 'claude', 'codex', 'opencode', 'versions', 'probe', 'registry'];
    const remove = ['machine', 'uninstall', 'registry'];
    for (const steps of [add, remove]) {
      const labels = groupSteps(steps.map((s) => step(s, 'ok')), 'box').map((g) => g.label);
      expect(labels).not.toContain('Other checks');
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it('puts the rollback of an upgrade whose probe failed beside the probe, after it', () => {
    const steps = [step('machine', 'ok'), step('master', 'ok'), step('release', 'ok'), step('upload', 'ok'), step('install', 'ok'),
                   step('probe', 'warn'), step('rollback', 'warn')];
    expect(groupSteps(steps, 'box').map((g) => [g.label, g.rows.map((r) => r.step)])).toEqual([
      ['Connection', ['machine', 'master']],
      ['Svall on box', ['release', 'upload', 'install']],
      ['Final check', ['probe', 'rollback']],
    ]);
  });

  it("puts a far home's copy of the archive between the release and the upload, where it ran", () => {
    const relayed = [step('name', 'ok'), step('ssh', 'ok'), step('linger', 'warn'), step('release', 'start'), step('relay', 'start'), step('relay', 'ok'),
                     step('release', 'start'), step('release', 'ok'), step('upload', 'ok'), step('install', 'ok')];
    const run = relayed.reduce((r, e) => applyStep(r, e), beginRun('add', { name: 'box' }));
    expect(groupSteps(run.steps, 'box').map((g) => [g.label, g.rows.map((r) => r.step)])).toEqual([
      ['Connection', ['name', 'ssh']],
      ['System', ['linger']],
      ['Svall on box', ['release', 'relay', 'upload', 'install']],
    ]);
  });

  it('shows a step it does not know rather than dropping it', () => {
    expect(groupSteps([step('weather', 'ok')], 'box')).toEqual([{ phase: 'other', label: 'Other checks', rows: [step('weather', 'ok')] }]);
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

describe('a sentence and what a tool said after it', () => {
  it('cuts at each of the places a tool\'s words begin, the sentence before them without its colon', () => {
    expect(splitRaw('studio has no Tailscale: Command failed: tailscale status --json\ntailscale is stopped'))
      .toEqual({ line: 'studio has no Tailscale', raw: 'Command failed: tailscale status --json\ntailscale is stopped' });
    expect(splitRaw('the phone link could not start, Command failed: tailscale serve --bg 8443'))
      .toEqual({ line: 'the phone link could not start,', raw: 'Command failed: tailscale serve --bg 8443' });
    expect(splitRaw('svall setup exited 1: one line')).toEqual({ line: 'svall setup', raw: 'exited 1: one line' });
    expect(splitRaw('the home: ssh could not reach studio: Connection refused')).toEqual({ line: 'the home', raw: 'ssh could not reach studio: Connection refused' });
    expect(splitRaw('could not open a master to ada@studio: ssh: connect to host studio port 22: Connection refused'))
      .toEqual({ line: 'could not open a master to ada@studio', raw: 'ssh: connect to host studio port 22: Connection refused' });
    expect(splitRaw('studio did not answer within 20000ms: timed out')).toEqual({ line: 'studio did not answer', raw: 'within 20000ms: timed out' });
    // a list the CLI says in its own words stays in sight
    expect(splitRaw('svall: nothing was changed; fix these first:\n✗ tmux  not found -> brew install tmux'))
      .toEqual({ line: 'svall: nothing was changed; fix these first:\n✗ tmux  not found -> brew install tmux' });
    expect(splitRaw('svall: hooks could not be written\n  EACCES: permission denied, open /u/.claude/settings.json'))
      .toEqual({ line: 'svall: hooks could not be written', raw: 'EACCES: permission denied, open /u/.claude/settings.json' });
  });

  it('cuts at the first of them, and not inside a word', () => {
    expect(splitRaw('relay  svall host doctor there exited 1: ssh: connect to host')).toEqual({ line: 'relay  svall host doctor there', raw: 'exited 1: ssh: connect to host' });
    expect(splitRaw('openssh: 9.6 is installed')).toEqual({ line: 'openssh: 9.6 is installed' });
  });

  it('says something went wrong on the machine when nothing stands before the tool\'s words', () => {
    expect(splitRaw('Command failed: tailscale status --json')).toEqual({ line: 'Something went wrong on the machine', raw: 'Command failed: tailscale status --json' });
    expect(splitRaw(': ssh could not reach studio')).toEqual({ line: 'Something went wrong on the machine', raw: 'ssh could not reach studio' });
  });

  it('leaves a sentence with no tool\'s words whole', () => {
    expect(splitRaw('studio is not reachable')).toEqual({ line: 'studio is not reachable' });
  });

  it('keeps no token in either part', () => {
    expect(splitRaw('GET /?token=abc123 failed: Command failed: svall status --token def456'))
      .toEqual({ line: 'GET /?token=… failed', raw: 'Command failed: svall status --token …' });
    expect(splitRaw('SVALL_TOKEN=abc123 svall status')).toEqual({ line: 'SVALL_TOKEN=… svall status' });
  });
});
