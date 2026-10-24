import { describe, expect, it } from 'vitest';
import {
  applyStep, beginRun, connectionBanner, endRun, FAR_ANSWER_MS, groupSteps, loginForward, machineName, outcomeOf,
  runActions, sshDestination, stepLabel, stepSaid, withoutTokens,
} from '../src/host.js';

const step = (s: string, status: 'start' | 'ok' | 'warn' | 'fail' | 'skip', extra: { detail?: string; action?: string; run?: string } = {}) =>
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
    const [other, mine, far] = ['9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f', '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f', '66666666-7777-8888-9999-aaaaaaaaaaaa'];
    let run = beginRun('add', { name: 'trift', ssh: 'trift.test' });
    run = applyStep(run, step('master', 'fail', { detail: `trift.test now reaches machine ${other}, not trift (${far})`, action: `point trift.test back at trift (${far})` }));
    run = applyStep(run, step('machine', 'fail', { detail: `/Users/ada/.svall/owner.json names ${other}, not this machine (${mine}): its daemon runs as that machine` }));
    run = applyStep(run, step('claude', 'warn', { detail: `/Users/ada/.claude/projects/-app/${other}.jsonl is not there` }));
    expect(run.steps.map((s) => s.detail)).toEqual([
      'trift.test now reaches another machine, not trift',
      '/Users/ada/.svall/owner.json names another machine, not this machine: its daemon runs as that machine',
      `/Users/ada/.claude/projects/-app/${other}.jsonl is not there`,
    ]);
    expect(run.steps[0].action).toBe('point trift.test back at trift');
  });

  it('names a machine this Mac knows by its name, and leaves out the ids of fleets and handovers and the generations', () => {
    const [studio, other, fleet, theirs, tx] = ['5d4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f', '9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f', '7f7f0b1c-2d3e-4f50-8617-9a0b1c2d3e4f', '8e8e0b1c-2d3e-4f50-8617-9a0b1c2d3e4f', '1a1a0b1c-2d3e-4f50-8617-9a0b1c2d3e4f'];
    const names = { [studio]: 'studio' };
    const said = (detail: string) => applyStep(beginRun('enable', { name: 'trift' }), step('fleet', 'fail', { detail }), names).steps[0].detail;
    expect(said(`trift.test now reaches machine ${studio}, not trift (${other})`)).toBe('trift.test now reaches studio, not trift');
    expect(said(`trift answered with machineId ${other}, not ${studio}`)).toBe('trift answered as another machine');
    expect(said(`trift answered with fleetId ${theirs}, not ${fleet}: it runs another fleet there`)).toBe('trift answered for another fleet: it runs another fleet there');
    expect(said(`trift cannot take a copy of this fleet: the record for fleet ${fleet} is unreadable (bad json); it was left where it is and this fleet is refused until /srv/gateway/${fleet}.json holds a readable record`))
      .toBe(`trift cannot take a copy of this fleet: the record for the fleet is unreadable (bad json); it was left where it is and this fleet is refused until /srv/gateway/${fleet}.json holds a readable record`);
    expect(said(`trift did not finish making its copy of this fleet: this fleet's record changed since it was read: ${studio} holds it at generation 4 in handover ${tx}`))
      .toBe("trift did not finish making its copy of this fleet: this fleet's record changed since it was read: studio holds it in another handover");
    expect(said(`trift cannot take a copy of this fleet: ${tx} is committed; this fleet belongs to ${other} at generation 5`))
      .toBe('trift cannot take a copy of this fleet: the handover is committed; this fleet belongs to another machine');
    expect(said('trift cannot take a copy of this fleet: this fleet is at generation 5, not 4')).toBe('trift cannot take a copy of this fleet: this fleet has moved on');
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
  const ended = (op: 'add' | 'doctor' | 'upgrade' | 'rollback' | 'remove' | 'enable', code: number, steps: ReturnType<typeof step>[], args = {}) =>
    endRun(steps.reduce((run, s) => applyStep(run, s), beginRun(op, { name: 'box', ...args })), code);

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

  it('offers Roll back only when the rollback after a failed upgrade failed too', () => {
    expect(outcomeOf(ended('upgrade', 1, [step('probe', 'warn'), step('rollback', 'fail', { detail: 'setup --rollback exited 1' })]), undefined).next).toBe('rollback');
    // an upgrade stopped before it installed left the machine as it was, and one stopped in install has no release to go back from
    expect(outcomeOf(ended('upgrade', 1, [step('master', 'fail', { detail: 'no' })]), undefined).next).toBeUndefined();
    expect(outcomeOf(ended('upgrade', 1, [step('install', 'fail', { detail: 'no' })]), undefined).next).toBeUndefined();
    expect(outcomeOf(ended('upgrade', 1, [step('probe', 'warn'), step('rollback', 'warn', { action: 'read the log' })]), undefined).next).toBeUndefined();
    expect(outcomeOf(ended('upgrade', 0, [step('probe', 'ok')]), undefined)).toEqual({ text: 'box is upgraded' });
  });

  it('says a check is ready and how many warnings it found, or lists the checks that block', () => {
    const fine = ended('doctor', 0, [step('tmux', 'warn', { detail: '3.4' }), step('gh', 'warn'), step('codex', 'skip'), step('release', 'ok')]);
    expect(outcomeOf(fine, 'box')).toEqual({ text: 'ready for handover; 2 warnings', next: 'handover' });
    expect(outcomeOf(fine, undefined)).toEqual({ text: "ready to be this fleet's gateway; 2 warnings", next: 'gateway' });
    expect(outcomeOf(ended('doctor', 0, [step('release', 'ok')]), 'box').text).toBe('ready for handover');
    const blocked = ended('doctor', 1, [step('tmux', 'warn'), step('release', 'fail', { detail: '0.4.0, protocol 3' }), step('systemd', 'fail', { detail: 'inactive' })]);
    expect(outcomeOf(blocked, 'box')).toEqual({ text: '2 checks block a handover:', list: ['Release: 0.4.0, protocol 3', 'Fleet service: inactive'] });
  });

  it('says what a new gateway, a removal and a rollback did, and offers the handover once there is a gateway', () => {
    expect(outcomeOf(ended('enable', 0, [step('fleet', 'ok')]), 'box')).toEqual({ text: "box is this fleet's gateway: ready for handover", next: 'handover' });
    expect(outcomeOf(ended('remove', 0, [step('registry', 'ok')]), undefined)).toEqual({ text: 'box is removed' });
    expect(outcomeOf(ended('remove', 0, [step('uninstall', 'skip')], { forget: true }), undefined)).toEqual({ text: 'box is forgotten' });
    expect(outcomeOf(ended('rollback', 0, [step('probe', 'ok')]), undefined)).toEqual({ text: 'box is rolled back' });
  });
});

describe('a step by name', () => {
  it('reads as plain words, and a step it does not know as itself', () => {
    expect(['master', 'identity', 'authority', 'fleet', 'registry'].map(stepLabel))
      .toEqual(['Connection', 'Installed release', 'Ownership record', 'Fleets', 'Machine list']);
    // the checks a machine's own doctor reports
    expect(['systemd', 'gateway', 'daemon env', 'gh', 'path', 'codex sandbox', 'opencode plugin', 'linger', 'doctor'].map(stepLabel))
      .toEqual(['Fleet service', 'Gateway service', 'Service environment', 'GitHub CLI', 'PATH', 'Codex sandbox', 'OpenCode plugin', 'Runs after logout', "Machine's own checks"]);
    expect(stepLabel('weather')).toBe('weather');
  });

  it('leaves out the machine the panel already names where a step starts with it', () => {
    expect(stepSaid({ step: 'identity', status: 'ok', detail: 'studio runs release 0.5.0' }, 'studio')).toBe('runs release 0.5.0');
    expect(stepSaid({ step: 'fleet', status: 'ok', detail: "studio's unused fleet is now this fleet" }, 'studio')).toBe("studio's unused fleet is now this fleet");
    expect(stepSaid({ step: 'ssh', status: 'ok', detail: 'studios answered' }, 'studio')).toBe('studios answered');
    expect(stepSaid({ step: 'ssh', status: 'ok' }, 'studio')).toBeUndefined();
  });
});

describe('the attended checklist', () => {
  it('names the phase each step belongs to, in the order the steps arrived', () => {
    const steps = [step('ssh', 'ok'), step('master', 'ok'), step('tmux', 'ok'), step('release', 'ok'),
                   step('claude', 'warn'), step('codex', 'ok'), step('opencode', 'ok'), step('probe', 'ok')];
    expect(groupSteps(steps).map((g) => [g.label, g.rows.map((r) => r.step)])).toEqual([
      ['Reaching the machine', ['ssh', 'master']],
      ['What the machine needs', ['tmux']],
      ['Svall on the machine', ['release']],
      ['Agent logins', ['claude', 'codex', 'opencode']],
      ['Trying it out', ['probe']],
    ]);
  });

  it('opens a phase again when a later step comes back to it', () => {
    expect(groupSteps([step('ssh', 'ok'), step('tmux', 'ok'), step('master', 'ok')]).map((g) => g.label))
      .toEqual(['Reaching the machine', 'What the machine needs', 'Reaching the machine']);
  });

  it('calls no phase by the name of a step in it', () => {
    const steps = ['name', 'machine', 'ssh', 'master', 'os', 'home', 'tools', 'tmux', 'rsync', 'space', 'linger', 'release', 'upload', 'install',
      'uninstall', 'service', 'identity', 'authority', 'fleet', 'claude', 'codex', 'opencode', 'probe', 'rollback', 'registry'];
    for (const g of groupSteps(steps.map((s) => step(s, 'ok')))) expect(g.rows.map((r) => stepLabel(r.step))).not.toContain(g.label);
  });

  it('shows every phase of an add, and of a removal, as one run', () => {
    const add = ['name', 'ssh', 'master', 'os', 'home', 'tools', 'tmux', 'rsync', 'space', 'linger', 'release', 'upload',
      'install', 'service', 'identity', 'claude', 'codex', 'opencode', 'probe', 'registry'];
    const remove = ['machine', 'fleet', 'uninstall', 'registry'];
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
      ['Reaching the machine', ['machine', 'master']],
      ['Svall on the machine', ['release', 'upload', 'install']],
      ['Trying it out', ['probe', 'rollback']],
    ]);
  });

  it('shows a step it does not know rather than dropping it', () => {
    expect(groupSteps([step('weather', 'ok')])).toEqual([{ phase: 'other', label: 'Checks', rows: [step('weather', 'ok')] }]);
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
});

describe('the connection state the shell reports', () => {
  const on = { handoverEnabled: true };
  const err = (o: { owner: string; kind: string; message?: string; machine?: string; destination?: string }) => ({ state: 'error' as const, message: 'what it said', ...o });

  it('says where the fleet is going, with nothing to do about it', () => {
    expect(connectionBanner({ state: 'connecting', owner: 'studio' }, on)).toEqual({ text: 'connecting to studio…', actions: [] });
    expect(connectionBanner({ state: 'owner-changed', owner: 'studio' }, on)).toEqual({ text: 'the fleet moved to studio; reconnecting…', actions: [] });
    expect(connectionBanner({ state: 'online', owner: 'studio' }, on)).toBeUndefined();
  });

  it('names the machine once in one plain sentence, folds what it said away, and offers Reconnect on every error', () => {
    expect(connectionBanner(err({ owner: 'studio', kind: 'unreachable', message: 'ssh: connect to host studio port 22: Operation timed out' }), on)).toEqual({
      text: 'studio is not reachable; trying again.', detail: 'ssh: connect to host studio port 22: Operation timed out', machine: 'studio', actions: ['reconnect'],
    });
    expect(connectionBanner(err({ owner: 'studio', kind: 'daemon_down', machine: 'studio' }), on))
      .toMatchObject({ text: "studio's svalld is not running; trying again.", actions: ['check', 'reconnect'] });
    expect(connectionBanner(err({ owner: 'studio', kind: 'version', machine: 'studio' }), on))
      .toMatchObject({ text: 'studio is on another version of Svall.', machine: 'studio', actions: ['upgrade', 'reconnect'] });
    expect(connectionBanner(err({ owner: 'studio', kind: 'other' }), on)).toMatchObject({ text: 'studio could not be reached.', actions: ['check', 'reconnect'] });
    expect(connectionBanner(err({ owner: 'local', kind: 'daemon_down', machine: 'local' }), on))
      .toMatchObject({ text: 'svalld is not running on this Mac; trying again.', actions: ['reconnect'] });
  });

  it('sends a refused login or host key to one ssh in Terminal, then Reconnect', () => {
    expect(connectionBanner(err({ owner: 'studio', kind: 'auth', machine: 'studio', destination: 'linus@studio' }), on))
      .toMatchObject({ text: 'studio did not let ssh log in.', ssh: 'linus@studio', actions: ['reconnect'] });
    expect(connectionBanner(err({ owner: 'local', kind: 'host_key', machine: 'gate', destination: 'linus@gate' }), on))
      .toMatchObject({ text: "ssh does not trust gate's host key.", ssh: 'linus@gate', machine: 'gate' });
    // a helper that names no destination is reached by the machine's name
    expect(connectionBanner(err({ owner: 'studio', kind: 'auth' }), on)).toMatchObject({ ssh: 'studio' });
  });

  it('says a gateway that did not answer leaves where the fleet runs unknown, and offers this Mac\'s copy only when the shell has one', () => {
    const gate = err({ owner: 'local', kind: 'unreachable', machine: 'gate', destination: 'linus@gate' });
    expect(connectionBanner(gate, on)).toMatchObject({
      text: 'The gateway gate did not answer, so where the fleet runs is not known; trying again.', actions: ['reconnect'],
    });
    expect(connectionBanner(gate, { ...on, copyHere: true })).toMatchObject({ actions: ['here', 'reconnect'] });
    expect(connectionBanner(err({ owner: 'studio', kind: 'other', machine: 'gate' }), on))
      .toMatchObject({ text: 'The gateway gate did not answer, so where the fleet runs is not known.', actions: ['check', 'reconnect'] });
  });

  it('says a connection helper that stopped or has not answered has not said where the fleet runs, never that this Mac is out of reach', () => {
    const helper = err({ owner: 'local', kind: 'helper', message: 'the connection helper has not answered in 10 s' });
    expect(connectionBanner(helper, on)).toEqual({
      text: 'The connection helper has not said where the fleet runs.', detail: 'the connection helper has not answered in 10 s', actions: ['reconnect'],
    });
    expect(connectionBanner(helper, { ...on, copyHere: true })?.actions).toEqual(['here', 'reconnect']);
    expect(connectionBanner(err({ owner: 'studio', kind: 'helper' }), { ...on, copyHere: true })?.actions).toEqual(['reconnect']);
  });

  it('says a far daemon that has not answered since the route opened has not, and offers a check', () => {
    expect(FAR_ANSWER_MS).toBe(60_000);
    expect(connectionBanner({ state: 'online', owner: 'studio' }, { ...on, silent: true }))
      .toEqual({ text: "studio's svalld has not answered.", machine: 'studio', actions: ['check', 'reconnect'] });
    expect(connectionBanner({ state: 'online', owner: 'local' }, { ...on, silent: true })).toBeUndefined();
  });

  it('reaches a fleet on this Mac only once it asks for handover, and offers the Machines panel only then', () => {
    const off = { handoverEnabled: false };
    expect(connectionBanner(undefined, on)).toBeUndefined();
    expect(connectionBanner(err({ owner: 'local', kind: 'daemon_down', machine: 'local' }), off)).toBeUndefined();
    expect(connectionBanner({ state: 'connecting', owner: 'local' }, off)).toBeUndefined();
    expect(connectionBanner({ state: 'connecting', owner: 'studio' }, off)).toEqual({ text: 'connecting to studio…', actions: [] });
    expect(connectionBanner(err({ owner: 'studio', kind: 'version', machine: 'studio' }), off)).toMatchObject({ actions: ['reconnect'] });
    expect(connectionBanner(err({ owner: 'local', kind: 'unreachable', machine: 'gate' }), { ...off, copyHere: true })).toBeUndefined();
  });

  it('never repeats a token the shell passed on', () => {
    expect(connectionBanner(err({ owner: 'studio', kind: 'other', message: 'token=s3cr3t' }), on)?.detail).toBe('token=…');
  });
});
