import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MachineId, PROTOCOL_VERSION, type SetupRow } from '@svall/protocol';
import { machineId } from '@svall/svalld/machine';
import { consentHost, doctorHost, rowStep, type HostReport, type StepEvent } from '../src/controller/host.js';
import { MachineRegistry } from '../src/controller/registry.js';
import {
  BASE, DF, DOCTOR, ELSEWHERE, HOME, OTHER_FLEET, OTHER_MAC, REMOTE, SERVES, SVALL, THERE, UNIT_PATH, deps, doctorJson, events, fleet, okRow, ssh, ticked, unticked,
  useHostWorld, work,
} from './controller/host-world.js';

useHostWorld();

describe('host doctor', () => {
  const registered = (home = HOME): MachineRegistry => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({
      name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
      home, svallBase: BASE,
    }, REMOTE);
    return registry;
  };

  it('consentHost asks the daemon with the registry\'s id and the row\'s fields, the rows asked without waiting, and the command prints the rows with [x]', async () => {
    const asked: unknown[] = [];
    const waits: number[] = [];
    const rows = await consentHost('trift', { item: 'claude:mcp:linear', on: true }, deps({
      registry: registered(),
      setupRows: (_m, wait) => { waits.push(wait); return Promise.resolve([unticked('claude:mcp:linear')]); },
      consent: (...a) => { asked.push(a); return Promise.resolve([ticked('claude:mcp:linear')]); },
    }));
    expect([asked, waits]).toEqual([[[REMOTE, 'claude:mcp:linear', ['env.LINEAR_API_KEY'], true]], [0]]);
    const { stepLine } = await import('../src/commands/host.js');
    expect(stepLine(rowStep(rows[0]))).toContain('[x]');
  });

  it('consentHost refuses an item no row names, a field its row does not list, and --field with off, which unticks every field; it takes listed fields as given', async () => {
    const consent = vi.fn(() => Promise.resolve([]));
    const d = deps({ registry: registered(), setupRows: () => Promise.resolve([unticked('claude:mcp:linear')]), consent });
    await expect(consentHost('trift', { item: 'codex:mcp:nope', on: true }, d)).rejects.toThrow('no setting codex:mcp:nope on trift; svall host doctor trift lists them');
    await expect(consentHost('trift', { item: 'claude:mcp:linear', on: true, fields: ['env.X'] }, d))
      .rejects.toThrow('claude:mcp:linear on trift has no field env.X; svall host doctor trift lists its fields');
    await expect(consentHost('trift', { item: 'claude:mcp:linear', on: false, fields: ['env.LINEAR_API_KEY'] }, d)).rejects.toThrow('off unticks every field of the item; leave out --field');
    expect(consent).not.toHaveBeenCalled();
    await consentHost('trift', { item: 'claude:mcp:linear', on: true, fields: ['env.LINEAR_API_KEY'] }, d);
    expect(consent).toHaveBeenCalledWith(REMOTE, 'claude:mcp:linear', ['env.LINEAR_API_KEY'], true);
    await consentHost('trift', { item: 'claude:mcp:linear', on: false }, d);
    expect(consent).toHaveBeenLastCalledWith(REMOTE, 'claude:mcp:linear', ['env.LINEAR_API_KEY'], false);
  });

  it('reads the companion\'s own doctor, version, linger and free space', async () => {
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-linger'], { stdout: 'Linger=yes\n' });
    const report = await doctorHost('trift', deps({ registry: registered() }));
    expect(report.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['systemd', 'linger', 'release', 'space']));
    expect(report.checks.find((c) => c.name === 'release')).toMatchObject({ status: 'ok', detail: expect.stringContaining('1.2.3') });
  });

  it('emits a start before each probe and every check as a step once found, in the report\'s order, the connection and the companion\'s doctor steps of their own', async () => {
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-linger'], { stdout: 'Linger=yes\n' });
    const report = await doctorHost('trift', deps({ registry: registered(), setupRows: () => Promise.resolve([okRow('var:X')]) }));
    const ended = events.filter((e) => e.status !== 'start');
    expect(ended.slice(0, 2)).toEqual([{ step: 'master', status: 'ok', detail: 'connected to trift.test' }, { step: 'doctor', status: 'ok', detail: 'answered' }]);
    expect(ended.slice(2).map((e) => e.step)).toEqual(report.checks.map((c) => c.name));
    // each probe's start comes before what it found
    const at = (step: string, status?: string) => events.findIndex((e) => e.step === step && (status ? e.status === status : e.status !== 'start'));
    for (const step of ['master', 'doctor', 'release', 'versions', 'space', 'home']) expect(at(step, 'start')).toBeLessThan(at(step));
    expect(at('mirror:var:X')).toBe(events.length - 1);
  });

  it('a doctor that cannot reach the machine says so as the connection step', async () => {
    await expect(doctorHost('trift', deps({ registry: registered(), openMaster: () => Promise.reject(new Error('Permission denied (publickey)')) })))
      .rejects.toThrow('Permission denied (publickey)');
    expect(events).toEqual([{ step: 'master', status: 'start' }, { step: 'master', status: 'fail', detail: 'Permission denied (publickey)' }]);
  });

  it('fails a machine whose fleet there does not run as a worker, so the check ends ready only once robots can move there', async () => {
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-linger'], { stdout: 'Linger=yes\n' });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }) });
    expect((await doctorHost('trift', deps({ registry: registered() }))).checks.find((c) => c.name === 'worker')).toEqual({
      name: 'worker', status: 'fail', detail: "does not run this fleet's robots yet: svall host upgrade trift sets it up",
    });
    ssh.clearReplies();
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-linger'], { stdout: 'Linger=yes\n' });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, worker: SERVES }) });
    const named = await doctorHost('trift', deps({ registry: registered(), fleet: { home: fleet, profile: 'work' } }));
    expect(named.checks.find((c) => c.name === 'worker')).toEqual({ name: 'worker', status: 'ok', detail: "runs this fleet's robots" });
    expect(ssh.remoteCalls().filter((w) => w.includes('version')).at(-1)).toEqual([SVALL, '-p', 'work', 'version', '--json']);
  });

  it("fails a machine whose fleet home serves another Mac as a worker, with that row's action", async () => {
    for (const [far, detail] of [
      [{ worker: { homeMachineId: OTHER_MAC, homeName: 'bea-mbp', fleetId: OTHER_FLEET } }, 'trift already serves bea-mbp as a worker; remove it from that Mac first; on bea-mbp, run svall host remove trift'],
      [{ worker: { ...SERVES, fleetId: OTHER_FLEET } }, "does not run this fleet's robots yet: svall host upgrade trift sets it up"],
    ] as const) {
      ssh.clearReplies();
      ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
      ssh.reply(['svall-space'], { stdout: DF });
      ssh.reply(['svall-linger'], { stdout: 'Linger=yes\n' });
      ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, ...far }) });
      expect((await doctorHost('trift', deps({ registry: registered() }))).checks.find((c) => c.name === 'worker')).toEqual({ name: 'worker', status: 'fail', detail });
    }
  });

  it("compares each agent's release, as the companion's units run it, with this Mac's, and names the update there", async () => {
    const homes = { CLAUDE_CONFIG_DIR: `${HOME}/agents/claude` };
    ssh.reply(['doctor', '--json'], { stdout: JSON.stringify({ ...JSON.parse(DOCTOR), daemonEnv: homes }) });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }) });
    ssh.reply(['svall-space'], { stdout: DF });
    const env = [UNIT_PATH, `CLAUDE_CONFIG_DIR=${homes.CLAUDE_CONFIG_DIR}`];
    // the machine's own claude check names no command for one below Svall's floor
    ssh.reply([...env, 'claude', '--version'], { stdout: '2.1.250 (Claude Code)\n' });
    ssh.reply([...env, 'codex', '--version'], { stdout: 'codex-cli 0.156.1\n' });
    const report = await doctorHost('trift', deps({ registry: registered() }));
    expect(report.checks.find((c) => c.name === 'versions')).toEqual({
      name: 'versions', status: 'warn',
      detail: 'claude 2.1.250 there, behind 2.1.278 on this Mac: a move there and back needs the same release on both; ssh trift.test, then claude update',
      run: 'claude update',
    });
    // a check only reads
    expect(ssh.remoteCalls().filter((w) => w.includes('claude')).map((w) => w.slice(-1))).toEqual([['--version']]);
  });

  it('the release row says the release there as on this Mac, older than it, newer than it, or one that cannot talk to it', async () => {
    const release = async (version: Record<string, unknown>) => {
      ssh.clearReplies();
      ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
      ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, ...version }) });
      ssh.reply(['svall-space'], { stdout: DF });
      const report = await doctorHost('trift', deps({ registry: registered(), controller: { release: '1.2.3', protocol: PROTOCOL_VERSION, releaseRoot: work, signed: true } }));
      const { name: _, ...row } = report.checks.find((c) => c.name === 'release')!;
      return row;
    };
    expect(await release({})).toEqual({ status: 'ok', detail: '1.2.3, as on this Mac' });
    expect(await release({ release: '1.2.2' })).toEqual({ status: 'fail', detail: '1.2.2 there; this Mac runs 1.2.3' });
    expect(await release({ release: '1.2.4' })).toEqual({ status: 'fail', detail: "1.2.4 there, newer than this Mac's 1.2.3", action: 'update svall on this Mac' });
    expect(await release({ protocol: PROTOCOL_VERSION - 1 })).toEqual({ status: 'fail', detail: "1.2.3 there, a build that cannot talk to this Mac's" });
  });

  it('host doctor lists the rows as checks with action, tick and forward; the verdict counts each warn row with an action', async () => {
    const { doctorVerdict } = await import('../src/commands/host.js');
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, worker: SERVES }) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-home'], { stdout: `${HOME}\nlinus\n` });
    const login: SetupRow = {
      key: 'oauth:codex:mcp:figma', status: 'skip', run: 'codex mcp login figma', forward: 1455, detail: 'log in once on trift; the row stays either way: codex mcp login figma',
      gap: { name: 'figma', what: 'log in once there; the row stays' },
    };
    const asked: [MachineId, number][] = [];
    const report = await doctorHost('trift', deps({
      registry: registered(),
      setupRows: (m, wait) => { asked.push([m, wait]); return Promise.resolve([unticked('claude:mcp:linear'), unticked('codex:mcp:github'), okRow('var:X'), login]); },
    }));
    expect(asked).toEqual([[REMOTE, 0]]);
    expect(report.checks.filter((c) => c.name.startsWith('mirror:'))).toMatchObject([
      { name: 'mirror:claude:mcp:linear', status: 'warn', action: "copy linear's keys to trift", tick: { on: false } },
      { name: 'mirror:codex:mcp:github', status: 'warn', action: "copy github's keys to trift", tick: { on: false } }, { name: 'mirror:var:X', status: 'ok' },
      { name: 'mirror:oauth:codex:mcp:figma', status: 'skip', run: 'codex mcp login figma', forward: 1455 },
    ]);
    // after the checks the machine answers
    expect(report.checks.findIndex((c) => c.name.startsWith('mirror:'))).toBe(report.checks.length - 4);
    expect(doctorVerdict(report.checks, 'trift', THERE)).toBe([
      'trift is ready. 3 parts of your agent setup will not work there yet:',
      '  linear  keys not copied (env.LINEAR_API_KEY)  → svall host consent trift claude:mcp:linear on',
      '  github  keys not copied (env.GITHUB_API_KEY)  → svall host consent trift codex:mcp:github on',
      '  figma   log in once there; the row stays      → ssh -L 1455:localhost:1455 trift.test, then codex mcp login figma',
    ].join('\n'));
  });

  it('a not-checked row names the doctor of the fleet the rows were asked of', async () => {
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, worker: SERVES }) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-home'], { stdout: `${HOME}\nlinus\n` });
    const report = await doctorHost('trift', deps({ registry: registered(), fleet: { home: fleet, profile: 'work' }, setupRows: () => Promise.reject(new Error('svalld is not running')) }));
    expect(report.checks.at(-1)).toEqual({
      name: 'mirror:unchecked', status: 'warn', detail: 'not checked: svalld is not running', action: 'svall -p work host doctor trift once Svall is open', gap: { name: 'agent setup', what: 'not checked' },
    });
  });

  it('keeps what a check found and the release the machine runs, by machine id, for host list', async () => {
    const config = path.join(work, 'config');
    ssh.reply(['doctor', '--json'], { stdout: doctorJson({ status: 'warn', detail: 'off for linus' }) });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, worker: { ...SERVES, homeMachineId: machineId(config) } }) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-home'], { stdout: `${HOME}\nlinus\n` });
    registered().save();
    const { hostCommands, lastChecks } = await import('../src/commands/host.js');
    const said: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { said.push(String(chunk)); return true; });
    try {
      await hostCommands(() => true, () => ({ name: 'private', home: fleet, managed: true }), () => config).parseAsync(['doctor', 'trift'], { from: 'user' });
    } finally {
      out.mockRestore();
    }
    // linger; the mirror's not-checked row, as this fleet's daemon is not running, is agent setup and no warning
    expect(lastChecks(config)).toEqual({ [REMOTE]: { at: expect.any(Number), failed: 0, warned: 1, release: '1.2.3' } });
    expect((JSON.parse(said.join('')) as HostReport).checks.at(-1)).toEqual({
      name: 'mirror:unchecked', status: 'warn', detail: expect.stringMatching(/^not checked: svalld is not running/), action: 'svall host doctor trift once Svall is open',
      gap: { name: 'agent setup', what: 'not checked' },
    });
    expect(Date.now() - lastChecks(config)[REMOTE]!.at).toBeLessThan(60_000);
  });

  it('with --steps prints each step as an NDJSON line as it goes, then the same report', async () => {
    const config = path.join(work, 'config');
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-home'], { stdout: `${HOME}\nlinus\n` });
    registered().save();
    const { hostCommands } = await import('../src/commands/host.js');
    const said: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { said.push(String(chunk)); return true; });
    try {
      await hostCommands(() => true, () => ({ name: 'private', home: fleet, managed: true }), () => config).parseAsync(['doctor', 'trift', '--steps'], { from: 'user' });
    } finally {
      out.mockRestore();
    }
    const steps = said.slice(0, -1).map((l) => JSON.parse(l) as StepEvent);
    expect(steps[0]).toEqual({ step: 'master', status: 'start' });
    const report = JSON.parse(said.at(-1)!) as HostReport;
    expect(steps.filter((e) => e.status !== 'start' && e.step !== 'master' && e.step !== 'doctor').map((e) => e.step)).toEqual(report.checks.map((c) => c.name));
  });

  it("drops a removed machine's check, and the file with the last one", async () => {
    const config = path.join(work, 'config');
    fs.mkdirSync(config, { recursive: true });
    const check = { at: 1, failed: 0, warned: 0 };
    fs.writeFileSync(path.join(config, 'checks.json'), JSON.stringify({ [REMOTE]: check, [OTHER_MAC]: check }));
    const { forgetCheck, lastChecks } = await import('../src/commands/host.js');
    forgetCheck(config, REMOTE);
    expect(lastChecks(config)).toEqual({ [OTHER_MAC]: check });
    forgetCheck(config, REMOTE);
    expect(lastChecks(config)).toEqual({ [OTHER_MAC]: check });
    forgetCheck(config, OTHER_MAC);
    expect(fs.existsSync(path.join(config, 'checks.json'))).toBe(false);
  });

  it("keeps a machine's check while host remove leaves it in the registry, and drops it with --forget", async () => {
    const config = path.join(work, 'config');
    const registry = MachineRegistry.load(config);
    registry.add({ name: 'trift', ssh: 'refused.test', platform: 'linux', arch: 'arm64', home: HOME, svallBase: BASE }, REMOTE);
    registry.save();
    const check = { at: 1, failed: 0, warned: 0 };
    fs.writeFileSync(path.join(config, 'checks.json'), JSON.stringify({ [REMOTE]: check, [OTHER_MAC]: check }));
    const { hostCommands, lastChecks } = await import('../src/commands/host.js');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await hostCommands(() => true, () => ({ name: 'private', home: fleet, managed: true }), () => config).parseAsync(['remove', 'trift'], { from: 'user' }).catch(() => undefined);
      expect(lastChecks(config)).toEqual({ [REMOTE]: check, [OTHER_MAC]: check });
      await hostCommands(() => true, () => ({ name: 'private', home: fleet, managed: true }), () => config).parseAsync(['remove', 'trift', '--forget'], { from: 'user' });
      expect(lastChecks(config)).toEqual({ [OTHER_MAC]: check });
    } finally { out.mockRestore(); process.exitCode = 0; }
  });

  it('keeps a check that could not reach the machine as failed, so host list never shows an older ready', async () => {
    const config = path.join(work, 'config');
    const registry = MachineRegistry.load(config);
    registry.add({ name: 'trift', ssh: 'refused.test', platform: 'linux', arch: 'arm64', home: HOME, svallBase: BASE }, REMOTE);
    registry.save();
    const { hostCommands, lastChecks } = await import('../src/commands/host.js');
    await expect(hostCommands(() => true, () => ({ name: 'private', home: fleet, managed: true }), () => config).parseAsync(['doctor', 'trift'], { from: 'user' })).rejects.toThrow();
    expect(lastChecks(config)).toEqual({ [REMOTE]: { at: expect.any(Number), failed: 1, warned: 0 } });
  });

  it('names the remote user, not the machine, when the companion reports no linger of its own', async () => {
    ssh.reply(['doctor', '--json'], { stdout: doctorJson() });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-home'], { stdout: `${HOME}\nlinus\n` });
    ssh.reply(['svall-linger'], { stdout: 'Linger=no\n' });
    const report = await doctorHost('trift', deps({ registry: registered() }));
    const linger = report.checks.find((c) => c.name === 'linger');
    expect(linger).toMatchObject({ status: 'warn', detail: 'off for linus: the fleet stops when you log out; ssh trift.test, then sudo loginctl enable-linger linus', run: 'sudo loginctl enable-linger linus' });
    // a check only reads
    expect(ssh.remoteCalls().some((c) => c.join(' ').includes('enable-linger'))).toBe(false);
  });

  it('reads the report a companion doctor prints before it exits 1 for a failing check', async () => {
    const failing = JSON.stringify({ checks: [...JSON.parse(DOCTOR).checks, { name: 'hooks', status: 'fail', detail: 'not installed in ~/.claude/settings.json: svall setup' }] });
    ssh.reply(['doctor', '--json'], { stdout: failing, code: 1 });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    ssh.reply(['svall-space'], { stdout: DF });
    const report = await doctorHost('trift', deps({ registry: registered() }));
    expect(report.checks.find((c) => c.name === 'hooks')).toMatchObject({ status: 'fail' });
    expect(report.checks.find((c) => c.name === 'systemd')).toMatchObject({ status: 'ok' });
    expect(report.checks.find((c) => c.name === 'doctor')).toBeUndefined();
  });

  it('still reports a companion doctor that exits without a report', async () => {
    ssh.reply(['doctor', '--json'], { stderr: 'node: bad option\n', code: 9 });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-home'], { stdout: `${HOME}\nlinus\n` });
    ssh.reply(['svall-linger'], { stdout: 'Linger=yes\n' });
    const report = await doctorHost('trift', deps({ registry: registered() }));
    expect(report.checks.find((c) => c.name === 'doctor')).toMatchObject({ status: 'fail', detail: expect.stringContaining('exited 9') });
  });

  it('checks the far account still has the home the registry records for it', async () => {
    const answer = (home: string): void => {
      ssh.clearReplies();
      ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
      ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
      ssh.reply(['svall-space'], { stdout: DF });
      ssh.reply(['svall-home'], { stdout: `${home}\nlinus\n` });
    };
    const home = async () => (await doctorHost('trift', deps({ registry: registered() }))).checks.find((c) => c.name === 'home');
    answer(HOME);
    expect(await home()).toEqual({ name: 'home', status: 'ok', detail: `${HOME} for linus` });
    answer(ELSEWHERE);
    expect(await home()).toEqual({
      name: 'home', status: 'fail',
      detail: `${ELSEWHERE} is linus's home on trift, and the registry records ${HOME}; svall host remove trift, then svall host add again`,
    });
  });

  it('passes the home of a machine registered at a home other than this Mac\'s', async () => {
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-home'], { stdout: `${ELSEWHERE}\nlinus\n` });
    const report = await doctorHost('trift', deps({ registry: registered(ELSEWHERE) }));
    expect(report.checks.find((c) => c.name === 'home')).toEqual({ name: 'home', status: 'ok', detail: `${ELSEWHERE} for linus` });
  });

  it('reports a release other than the controller\'s as a failure', async () => {
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '0.9.0', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-linger'], { stdout: 'Linger=yes\n' });
    const report = await doctorHost('trift', deps({ registry: registered() }));
    expect(report.checks.find((c) => c.name === 'release')).toMatchObject({ status: 'fail' });
    expect(report.checks.find((c) => c.name === 'release')?.action).toBeUndefined();
  });

  it('says to update svall on this Mac when the machine runs a newer release', async () => {
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '9.0.0', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    ssh.reply(['svall-space'], { stdout: DF });
    ssh.reply(['svall-linger'], { stdout: 'Linger=yes\n' });
    const report = await doctorHost('trift', deps({ registry: registered() }));
    expect(report.checks.find((c) => c.name === 'release')).toMatchObject({ status: 'fail', action: 'update svall on this Mac' });
  });
});

describe('host list', () => {
  it('names each machine with its ssh and its last check, this Mac without an ssh', async () => {
    const config = path.join(work, 'config');
    const registry = MachineRegistry.load(config);
    registry.add({ name: 'trift', ssh: 'ada@trift', platform: 'linux', arch: 'arm64', home: HOME, svallBase: BASE }, REMOTE);
    const { machineRows } = await import('../src/commands/host.js');
    const check = { at: 1, failed: 0, warned: 2, release: '1.2.3' };
    const rows = machineRows(registry, { [REMOTE]: check });
    expect(rows).toEqual([
      { name: registry.localMachine().name, id: registry.localId, platform: `${process.platform === 'linux' ? 'linux' : 'darwin'}-${process.arch}` },
      { name: 'trift', id: REMOTE, ssh: 'ada@trift', platform: 'linux-arm64', check },
    ]);
  });
});
