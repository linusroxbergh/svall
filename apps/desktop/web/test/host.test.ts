import { describe, expect, it } from 'vitest';
import {
  applyStep, beginRun, connectionBanner, connectionText, endRun, groupSteps, machineName, readyForHandover,
  runActions, sshDestination, withoutTokens,
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
  const ended = (op: 'add' | 'doctor' | 'upgrade' | 'remove' | 'enable', code: number, steps: ReturnType<typeof step>[]) =>
    endRun(steps.reduce(applyStep, beginRun(op, { name: 'box' })), code);

  it('is ready for handover when an add finishes clean', () => {
    expect(readyForHandover(ended('add', 0, [step('ssh', 'ok'), step('tmux', 'warn'), step('probe', 'ok')]))).toBe(true);
    expect(readyForHandover(ended('add', 1, [step('ssh', 'ok'), step('claude', 'warn', { action: 'log in' })]))).toBe(false);
    expect(readyForHandover({ ...ended('add', 0, [step('ssh', 'ok')]), running: true, code: undefined })).toBe(false);
  });

  it('is ready for handover when a check finds nothing failing and nothing left to do', () => {
    expect(readyForHandover(ended('doctor', 0, [step('tmux', 'ok'), step('release', 'ok')]))).toBe(true);
    // a check that does not apply to this machine is no reason to wait
    expect(readyForHandover(ended('doctor', 0, [step('tmux', 'ok'), step('codex', 'skip', { detail: 'not installed' })]))).toBe(true);
    expect(readyForHandover(ended('doctor', 0, [step('tmux', 'ok'), step('linger', 'warn')]))).toBe(false);
    expect(readyForHandover(ended('doctor', 0, [step('release', 'fail')]))).toBe(false);
    expect(readyForHandover(ended('doctor', 1, [step('release', 'fail')]))).toBe(false);
    expect(readyForHandover(ended('doctor', 0, []))).toBe(false);
  });

  it('says nothing about handover after an upgrade, a removal or a new gateway', () => {
    for (const op of ['upgrade', 'remove', 'enable'] as const) {
      expect(readyForHandover(ended(op, 0, [step('machine', 'ok')]))).toBe(false);
    }
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

  it('never repeats a token the shell passed on', () => {
    expect(connectionText({ state: 'error', owner: 'local', kind: 'other', message: 'token=s3cr3t' }))
      .toBe('this machine is not reachable: token=…');
  });
});
