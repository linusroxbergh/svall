import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { enter } from '@svall/svalld/fleet/home-move';
import { resolvePaths } from '@svall/svalld/paths';
import { hostCommands, setupList, type There } from '../src/commands/host.js';
import { MachineRegistry } from '../src/controller/registry.js';
import { FLEET, fleet, ssh, useHostWorld, work } from './controller/host-world.js';

useHostWorld();

const HOME = crypto.randomUUID();
const W = crypto.randomUUID();
const MAC2 = crypto.randomUUID();
const rows = [
  { name: 'box', id: W, ssh: 'ada@box', platform: 'linux-arm64', worker: true, joining: 'No route to host' },
  { name: 'other-mac', id: MAC2, platform: 'darwin-arm64', worker: true },
  { name: 'stranger', id: crypto.randomUUID(), ssh: 'ada@stranger', platform: 'linux-arm64' },
];

async function cli(args: string[], json: boolean): Promise<string> {
  const config = path.join(work, 'config');
  const r = MachineRegistry.load(config);
  r.put(HOME as never, { name: 'studio', ssh: 'ada@studio', platform: 'linux', arch: 'arm64', home: '/home/ada', svallBase: '/home/ada/.local/share/svall' });
  r.save();
  fs.writeFileSync(resolvePaths(fleet).workerFile, JSON.stringify({ homeMachineId: HOME, fleetId: FLEET, token: 'a'.repeat(48), homeName: 'studio', homeSsh: 'ada@studio', homeSocket: '/home/ada/.svall/w/0123456789ab.sock', homeSvallBase: '/home/ada/.local/share/svall' }));
  ssh.reply(['version', '--json'], { stdout: JSON.stringify({ machineId: HOME, release: '1.2.3', role: 'home', fleetId: FLEET }) });
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out += String(c); return true; });
  const code = process.exitCode;
  try { await hostCommands(() => json, () => ({ name: 'private', home: fleet, managed: true }), () => config).parseAsync(args, { from: 'user' }); } finally { spy.mockRestore(); process.exitCode = code; }
  return out;
}

const far = (args: string[]) => ssh.remoteCalls().filter((c) => args.every((a) => c.some((w) => w.includes(a))));

describe('host list with a far home', () => {
  it('lists what that home holds of this fleet, past a login shell\'s noise', async () => {
    ssh.reply(['host', 'list'], { stdout: `Welcome to studio\nlast login: today\n${JSON.stringify(rows, null, 2)}\n` });
    const listed = JSON.parse(await cli(['list'], true)) as { id: string; name: string; far?: boolean; ssh?: string }[];
    expect(listed.find((r) => r.id === W)).toMatchObject({ far: true, ssh: 'ada@box' });
    expect(listed.some((r) => r.name === 'stranger')).toBe(false);
  });

  it('shows neither the home nor this machine from that home\'s rows, and no row a mark of a worker', async () => {
    const me = MachineRegistry.load(path.join(work, 'config')).localId;
    const mine = [{ name: 'studio', id: HOME, ssh: 'ada@studio', platform: 'linux-arm64', worker: true }, { name: 'me', id: me, ssh: 'ada@me', platform: 'darwin-arm64', worker: true }];
    ssh.reply(['host', 'list'], { stdout: `${JSON.stringify([...rows, ...mine])}\n` });
    const listed = JSON.parse(await cli(['list'], true)) as { name: string; far?: boolean; worker?: boolean }[];
    expect(listed.filter((r) => r.far).map((r) => r.name)).toEqual(['box', 'other-mac']);
    expect(listed.some((r) => r.worker)).toBe(false);
  });

  it('in words: a machine with no route reads as one that dials in, and one owed an enrolment says why', async () => {
    ssh.reply(['host', 'list'], { stdout: `${JSON.stringify(rows)}\n` });
    const out = await cli(['list'], false);
    expect(out).toContain('(dials in) (from studio)');
    expect(out).not.toContain('undefined');
    expect(out).toContain('has not joined yet: No route to host');
  });

  it('a machine this home owes an enrolment says so on its own list', async () => {
    const config = path.join(work, 'config');
    const r = MachineRegistry.load(config);
    r.put(W as never, { name: 'box', ssh: 'ada@box', platform: 'linux', arch: 'arm64', home: '/home/ada', svallBase: '/home/ada/.local/share/svall' });
    r.save();
    const p = resolvePaths(fleet);
    enter(p, 'hm_abcdefghij', 'adopted');
    fs.writeFileSync(p.workersOwed, JSON.stringify({ id: 'hm_abcdefghij', workers: { [W]: { why: 'refused' } } }));
    let out = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out += String(c); return true; });
    try { await hostCommands(() => true, () => ({ name: 'private', home: fleet, managed: true }), () => config).parseAsync(['list'], { from: 'user' }); } finally { spy.mockRestore(); }
    expect((JSON.parse(out) as { id: string; joining?: string }[]).find((m) => m.id === W)?.joining).toBe('refused');
  });
});

describe('an add the far home has no companion for', () => {
  const NONE = JSON.stringify({ step: 'release', status: 'fail', detail: 'this build publishes no companion for linux-arm64; name one with --release <archive>' });
  const carrying = (version: string) => {
    const root = path.join(work, 'release-here');
    fs.mkdirSync(path.join(root, 'companions'), { recursive: true });
    fs.writeFileSync(path.join(root, 'companions', 'c.tar.gz'), 'held');
    fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify({ version, companions: { 'linux-arm64': { url: 'companions/c.tar.gz', sha256: 'aa' } } }));
    process.env.SVALL_RELEASE_ROOT = root;
    onTestFinished(() => { delete process.env.SVALL_RELEASE_ROOT; });
    ssh.reply(['host', 'add'], { stdout: `${NONE}\n`, code: 1 });
    ssh.reply(['mkdir'], {});
    ssh.reply(['cat > "$1"'], {});
  };

  it('a CLI on the home\'s release copies the archive it carries there, and runs again with it', async () => {
    carrying('1.2.3');
    await cli(['add', 'box', '--ssh', 'ada@box'], true);
    expect(far(['host', 'add'])).toHaveLength(2);
    expect(far(['host', 'add']).at(-1)!.some((w) => w.includes('--release'))).toBe(true);
  });

  it('a CLI on another release copies nothing, as a home takes only its own', async () => {
    carrying('1.2.4');
    expect(await cli(['add', 'box', '--ssh', 'ada@box'], true)).toContain('name one with --release');
    expect(far(['host', 'add'])).toHaveLength(1);
  });
});

describe('a doctor of a far worker', () => {
  const REPORT = { machine: 'box', checks: [{ name: 'tools', status: 'fail', detail: 'no git', action: 'ssh ada@box, then sudo apt install git' }] };

  it('--json with no --steps is one document, as it is here', async () => {
    ssh.reply(['host', 'doctor'], { stdout: `${JSON.stringify(REPORT, null, 2)}\n` });
    const out = await cli(['doctor', 'box'], true);
    expect(JSON.parse(out)).toEqual(REPORT);
    expect(far(['host', 'doctor']).at(-1)!.some((w) => w.includes('--steps'))).toBe(false);
  });

  it('--steps asks for them there', async () => {
    ssh.reply(['host', 'doctor'], { stdout: `${JSON.stringify(REPORT, null, 2)}\n` });
    await cli(['doctor', 'box', '--steps'], true);
    expect(far(['host', 'doctor']).at(-1)!.some((w) => w.includes('--steps'))).toBe(true);
  });

  it('in a terminal, what is to do on the machine goes by way of the home, by its route', async () => {
    ssh.reply(['host', 'doctor'], { stdout: `${JSON.stringify(REPORT, null, 2)}\n` });
    const out = await cli(['doctor', 'box'], false);
    expect(out).toContain('ssh ada@studio, then ssh ada@box, then sudo apt install git');
  });

  it.each([
    ['doctor', ['doctor', 'box']],
    ['consent', ['consent', 'box', 'claude:mcp:linear', 'on']],
  ])('a %s the home did not take says what is left in words', async (_what, args) => {
    ssh.reply(['host', args[0]], { code: 1, stderr: 'svall: no such machine\n' });
    const out = await cli(args, false);
    expect(out).toContain('no such machine');
    expect(out).not.toContain('{"result"');
    expect(out).not.toContain('"stopped"');
  });
});

describe('a terminal\'s line for a far worker', () => {
  const there: There = { ssh: 'ada@box', by: 'ada@studio', svall: 'svall' };
  const row = (o: object) => ({ key: 'oauth:codex:x', gap: { name: 'codex', what: 'not logged in' }, ...o });

  it('forwards a login\'s port over every hop', () => {
    expect(setupList([row({ run: 'codex login', forward: 1455 })] as never, 'box', there)[0]).toContain('ssh -L 1455:localhost:1455 ada@studio, then ssh -L 1455:localhost:1455 ada@box, then codex login');
  });

  it('goes over the home with no port too, and over one hop for a machine this Mac reaches', () => {
    expect(setupList([row({ run: 'x' })] as never, 'box', there)[0]).toContain('ssh ada@studio, then ssh ada@box, then x');
    expect(setupList([row({ run: 'x', forward: 80 })] as never, 'box', { ssh: 'ada@box', svall: 'svall' })[0]).toContain('ssh -L 80:localhost:80 ada@box, then x');
  });
});
