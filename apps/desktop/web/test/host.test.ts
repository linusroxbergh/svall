import { describe, expect, it } from 'vitest';
import {
  applyStep, beginRun, connectionBanner, connectionText, endRun, groupSteps, machineName, outcomeOf,
  runActions, sshDestination, stepLabel, upgradeFor, withoutTokens,
} from '../src/host.js';

const step = (s: string, status: 'start' | 'ok' | 'warn' | 'fail' | 'skip', extra: { detail?: string; action?: string } = {}) =>
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
  const ended = (op: 'add' | 'doctor' | 'upgrade' | 'remove' | 'enable', code: number, steps: ReturnType<typeof step>[], args = {}) =>
    endRun(steps.reduce(applyStep, beginRun(op, { name: 'box', ...args })), code);

  it('says an add that finished clean added the machine, and offers to make it the gateway until it is one', () => {
    const add = ended('add', 0, [step('ssh', 'ok'), step('tmux', 'warn'), step('probe', 'ok'), step('registry', 'ok')]);
    expect(outcomeOf(add, undefined)).toEqual({ text: 'box is added', next: 'gateway' });
    expect(outcomeOf(add, 'studio')).toEqual({ text: 'box is added', next: 'gateway' });
    expect(outcomeOf(add, 'box')).toEqual({ text: 'box is added: ready for handover', next: 'handover' });
  });

  it('lists what an add left to do, and still offers the gateway', () => {
    const add = ended('add', 1, [step('ssh', 'ok'), step('claude', 'warn', { action: 'log in' }), step('registry', 'ok')]);
    expect(outcomeOf(add, undefined)).toEqual({ text: 'box is added; still to do:', list: ['log in'], next: 'gateway' });
    // one stopped part way never reached the registry
    expect(outcomeOf(ended('add', 143, [step('ssh', 'ok'), step('tmux', 'ok')]), undefined)).toEqual({ text: 'Add machine ended with exit 143' });
  });

  it('names the step a run stopped at and what it said, with what is left to do', () => {
    const add = ended('add', 1, [step('ssh', 'ok'), step('claude', 'warn', { action: 'log in' }), step('install', 'fail', { detail: 'svall setup exited 1' })]);
    expect(outcomeOf(add, undefined)).toEqual({ text: 'Add machine stopped at Install: svall setup exited 1', list: ['log in'] });
    expect(outcomeOf(ended('remove', 1, []), undefined)).toEqual({ text: 'Remove ended with exit 1' });
  });

  it('says a check is ready and how many warnings it found, or lists the checks that block', () => {
    const fine = ended('doctor', 0, [step('tmux', 'warn', { detail: '3.4' }), step('gh', 'warn'), step('codex', 'skip'), step('release', 'ok')]);
    expect(outcomeOf(fine, 'box')).toEqual({ text: 'ready for handover; 2 warnings', next: 'handover' });
    expect(outcomeOf(fine, undefined)).toEqual({ text: "ready to be this fleet's gateway; 2 warnings", next: 'gateway' });
    expect(outcomeOf(ended('doctor', 0, [step('release', 'ok')]), 'box').text).toBe('ready for handover');
    const blocked = ended('doctor', 1, [step('tmux', 'warn'), step('release', 'fail', { detail: '0.4.0, protocol 3' }), step('systemd', 'fail', { detail: 'inactive' })]);
    expect(outcomeOf(blocked, 'box')).toEqual({ text: '2 checks block a handover:', list: ['Release: 0.4.0, protocol 3', 'systemd: inactive'] });
  });

  it('says what an upgrade, a new gateway and a removal did, and offers the handover once there is a gateway', () => {
    expect(outcomeOf(ended('upgrade', 0, [step('probe', 'ok')]), undefined)).toEqual({ text: 'box is upgraded' });
    expect(outcomeOf(ended('enable', 0, [step('fleet', 'ok')]), 'box')).toEqual({ text: "box is this fleet's gateway: ready for handover", next: 'handover' });
    expect(outcomeOf(ended('remove', 0, [step('registry', 'ok')]), undefined)).toEqual({ text: 'box is removed' });
    expect(outcomeOf(ended('remove', 0, [step('uninstall', 'skip')], { forget: true }), undefined)).toEqual({ text: 'box is forgotten' });
  });
});

describe('a step by name', () => {
  it('reads as plain words, and a step it does not know as itself', () => {
    expect(['master', 'identity', 'authority', 'fleet', 'registry'].map(stepLabel))
      .toEqual(['Connection', 'Installed release', 'Ownership record', 'Fleets', 'Machine list']);
    expect(stepLabel('weather')).toBe('weather');
  });
});

describe('the attended checklist', () => {
  it('names the phase each step belongs to, in the order the steps arrived', () => {
    const steps = [step('ssh', 'ok'), step('master', 'ok'), step('tmux', 'ok'), step('release', 'ok'),
                   step('claude', 'warn'), step('codex', 'ok'), step('opencode', 'ok'), step('probe', 'ok')];
    expect(groupSteps(steps).map((g) => [g.label, g.rows.map((r) => r.step)])).toEqual([
      ['Connect', ['ssh', 'master']],
      ['Prerequisites', ['tmux']],
      ['Companion', ['release']],
      ['Agent logins', ['claude', 'codex', 'opencode']],
      ['Final probe', ['probe']],
    ]);
  });

  it('opens a phase again when a later step comes back to it', () => {
    expect(groupSteps([step('ssh', 'ok'), step('tmux', 'ok'), step('master', 'ok')]).map((g) => g.label))
      .toEqual(['Connect', 'Prerequisites', 'Connect']);
  });

  it('shows every phase of an add, and of a removal, as one run', () => {
    const add = ['name', 'ssh', 'master', 'os', 'home', 'tools', 'tmux', 'rsync', 'space', 'linger', 'release', 'upload',
      'install', 'service', 'identity', 'claude', 'codex', 'opencode', 'probe', 'registry'];
    const remove = ['machine', 'fleet', 'uninstall', 'registry'];
    for (const steps of [add, remove]) {
      const labels = groupSteps(steps.map((s) => step(s, 'ok'))).map((g) => g.label);
      expect(labels).not.toContain('Setup');
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it('puts the rollback of an upgrade whose probe failed under Final probe, after the probe', () => {
    const steps = [step('machine', 'ok'), step('master', 'ok'), step('release', 'ok'), step('upload', 'ok'), step('install', 'ok'),
                   step('probe', 'warn'), step('rollback', 'warn')];
    expect(groupSteps(steps).map((g) => [g.label, g.rows.map((r) => r.step)])).toEqual([
      ['Connect', ['machine', 'master']],
      ['Companion', ['release', 'upload', 'install']],
      ['Final probe', ['probe', 'rollback']],
    ]);
  });

  it('shows a step it does not know rather than dropping it', () => {
    expect(groupSteps([step('weather', 'ok')])).toEqual([{ phase: 'other', label: 'Setup', rows: [step('weather', 'ok')] }]);
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
});

describe('the connection state the shell reports', () => {
  it('says where the fleet is and what is in the way', () => {
    expect(connectionText({ state: 'connecting', owner: 'studio' })).toBe('connecting to studio…');
    expect(connectionText({ state: 'owner-changed', owner: 'studio' })).toBe('the fleet moved to studio; reconnecting…');
    expect(connectionText({ state: 'error', owner: 'studio', kind: 'unreachable', message: 'ssh closed' }))
      .toBe('studio is not reachable: ssh closed');
    expect(connectionText({ state: 'error', owner: 'local', kind: 'version', message: 'companion 3, controller 4' }))
      .toBe('this machine is on another version: companion 3, controller 4');
    expect(connectionText({ state: 'online', owner: 'studio' })).toBeUndefined();
  });

  it('reaches a fleet on this Mac only once it asks for handover', () => {
    const down = { state: 'error', owner: 'local', kind: 'daemon_down', message: 'svalld is not running' } as const;
    expect(connectionBanner(undefined, true)).toBeUndefined();
    expect(connectionBanner(down, false)).toBeUndefined();
    expect(connectionBanner({ state: 'connecting', owner: 'local' }, false)).toBeUndefined();
    expect(connectionBanner(down, true)).toBe('this machine is not reachable: svalld is not running');
    expect(connectionBanner({ state: 'connecting', owner: 'studio' }, false)).toBe('connecting to studio…');
  });

  it('offers an upgrade only for a machine whose release the connection refused', () => {
    expect(upgradeFor({ state: 'error', owner: 'studio', kind: 'version', message: 'studio answered with protocol 3, not 4' })).toBe('studio');
    expect(upgradeFor({ state: 'error', owner: 'local', kind: 'version', message: 'companion 3, controller 4' })).toBeUndefined();
    expect(upgradeFor({ state: 'error', owner: 'studio', kind: 'unreachable', message: 'ssh closed' })).toBeUndefined();
    expect(upgradeFor({ state: 'connecting', owner: 'studio' })).toBeUndefined();
    expect(upgradeFor(undefined)).toBeUndefined();
  });

  it('never repeats a token the shell passed on', () => {
    expect(connectionText({ state: 'error', owner: 'local', kind: 'other', message: 'token=s3cr3t' }))
      .toBe('this machine is not reachable: token=…');
  });
});
