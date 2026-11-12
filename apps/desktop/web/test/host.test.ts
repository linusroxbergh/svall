import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  applyStep, beginRun, endRun, groupSteps, loginForward, machineName, outcomeOf, overHome,
  plainStep, replaceRows, rowToStep, runActions, splitRaw, sshDestination, stepLabel, stepSaid, withoutTokens,
} from '../src/host.js';
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
  const ready = 'box is ready. Robots you move there keep working while this Mac sleeps.';

  it('the outcome line reads ready when nothing is left to fix and counts the things to fix otherwise, with the agent setup in an optional note', () => {
    expect(outcomeOf(ended('upgrade', 0, [step('probe', 'ok'), step('enrol', 'ok')]))).toEqual({ text: ready, done: true });
    // a warning that names nothing to do here leaves the machine ready, and says so
    expect(outcomeOf(ended('add', 0, [step('ssh', 'ok'), step('tmux', 'warn'), step('probe', 'ok'), step('registry', 'ok')])))
      .toEqual({ text: 'box is ready, with 1 warning. Robots you move there keep working while this Mac sleeps.', done: true });
    expect(outcomeOf(ended('doctor', 0, [step('tmux', 'warn', { detail: '3.4' }), step('opencode', 'warn', { detail: 'not signed in: opencode auth login', run: 'opencode auth login' }), step('codex', 'skip'), step('release', 'ok')])))
      .toEqual({ text: 'box is ready, with 2 warnings. Robots you move there keep working while this Mac sleeps.', done: true });
    // each step's action is one thing, and so is each failed step that names none
    expect(outcomeOf(ended('add', 1, [step('claude', 'warn', { action: 'log in' }), step('registry', 'ok')]))).toEqual({ text: 'box has 1 thing to fix.' });
    expect(outcomeOf(ended('add', 1, [step('claude', 'warn', { action: 'log in' }), step('install', 'fail', { detail: 'svall setup exited 1' })])))
      .toEqual({ text: 'box has 2 things to fix.' });
    const blocked = ended('doctor', 1, [step('tmux', 'warn'), step('release', 'fail', { detail: '0.4.0, protocol 3' }), step('systemd', 'fail', { detail: 'inactive' })]);
    expect(outcomeOf(blocked)).toEqual({ text: 'box has 2 things to fix.' });
    // the agent setup is nothing to fix: a row naming a gap is a part that will not work there, though two read alike, and one that only asks to check again is none
    const still = ' None of it stops a move there; set it up under Your agent setup when you need it.';
    const again = (key: string) => step(`mirror:${key}`, 'warn', { action: 'check box again', detail: 'not checked: box is not reachable' });
    const gap = (key: string, name: string) => step(`mirror:${key}`, 'warn', { action: `copy ${name}'s keys to box`, gap: { name, what: 'keys not copied (env.KEY)' } });
    const mirrored = ended('doctor', 0, [step('ssh', 'ok'), again('claude:mcp:linear'), again('var:X'), gap('claude:mcp:github', 'github'), gap('codex:mcp:github', 'github')]);
    expect(outcomeOf(ended('doctor', 0, [step('tmux', 'warn'), gap('claude:mcp:linear', 'linear')])))
      .toMatchObject({ text: 'box is ready, with 1 warning. Robots you move there keep working while this Mac sleeps.', note: `Optional: 1 part of your agent setup will not work there yet.${still}` });
    expect(outcomeOf(mirrored)).toEqual({ text: ready, note: `Optional: 2 parts of your agent setup will not work there yet.${still}`, done: true, setup: 2 });
    expect(outcomeOf(ended('upgrade', 0, [step('probe', 'ok'), gap('claude:mcp:linear', 'linear')])))
      .toEqual({ text: ready, note: `Optional: 1 part of your agent setup will not work there yet.${still}`, done: true, setup: 1 });
    expect(outcomeOf(ended('add', 1, [step('claude', 'warn', { action: 'log in' }), step('registry', 'ok'), gap('claude:mcp:linear', 'linear')])))
      .toEqual({ text: 'box has 1 thing to fix.', note: `Optional: 1 part of your agent setup will not work there yet.${still}`, setup: 1 });
    // a part with nothing to do about it, as a file this Mac cannot read, will not work there, not yet
    const unread = step('mirror:unreadable:/Users/ada/.claude.json', 'warn', { gap: { name: '.claude.json', what: 'not copied: this Mac cannot read it' } });
    expect(outcomeOf(ended('doctor', 0, [step('ssh', 'ok'), unread])))
      .toEqual({ text: ready, note: `Optional: 1 part of your agent setup will not work there.${still}`, done: true, setup: 1 });
    // a server that runs only on a Mac, or a program ticked as not needed there, stands aside: counted after the parts, named when alone
    const macOnly = step('mirror:maconly:claude:chrome', 'skip', { gap: { name: 'chrome', what: 'runs only on a Mac' } });
    const skipped = step('mirror:runtime:adlc', 'skip', { tick: { item: 'runtime:adlc', fields: ['skip'], on: true, preview: [] }, gap: { name: 'adlc', what: 'not needed there, you ticked' } });
    expect(outcomeOf(ended('doctor', 0, [step('ssh', 'ok'), macOnly, skipped]))).toEqual({ text: ready, note: 'chrome runs only on a Mac, and adlc is not needed there.', done: true });
    expect(outcomeOf(ended('doctor', 0, [macOnly, gap('claude:mcp:linear', 'linear')])).note)
      .toBe(`Optional: 1 part of your agent setup will not work there yet, and 1 runs only on a Mac.${still}`);
    expect(outcomeOf(ended('doctor', 1, [step('systemd', 'fail'), macOnly]))).toEqual({ text: 'box has 1 thing to fix.', note: 'chrome runs only on a Mac.' });
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

  it('names the steps of a join and a home move', () => {
    expect(['fleet', 'tailscale', 'snapshot', 'seed', 'join', 'adopt', 'pause', 'copy', 'mission', 'phone', 'workers', 'abort', 'check'].map(stepLabel)).toEqual([
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
    ].map(stepLabel)).toEqual([
      'Codex MCP github', 'OpenCode MCP sentry', 'db (plugin acme)', 'notion login', 'db login', 'npx', 'chrome', 'settings.json', 'Codex config.toml',
      'OpenCode config', 'plugin acme@market', '/Users/ada/.codex/config.toml', 'Not checked', 'subagent team/db.md', 'marketplace market',
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

  it("puts a far home's copy of the archive between the release and the upload, where it ran", () => {
    const relayed = [step('name', 'ok'), step('ssh', 'ok'), step('linger', 'warn'), step('release', 'start'), step('relay', 'start'), step('relay', 'ok'),
                     step('release', 'start'), step('release', 'ok'), step('upload', 'ok'), step('install', 'ok')];
    const run = relayed.reduce((r, e) => applyStep(r, e), beginRun('add', { name: 'box' }));
    expect(groupSteps(run.steps).map((g) => [g.label, g.rows.map((r) => r.step)])).toEqual([
      ['Reaching it', ['name', 'ssh']],
      ['What it needs', ['linger']],
      ['Svall there', ['release', 'relay', 'upload', 'install']],
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
