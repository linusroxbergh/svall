import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { enter } from '@svall/svalld/fleet/home-move';
import { resolvePaths } from '@svall/svalld/paths';
import { noLoginFix } from '@svall/svalld/placement/workers';
import { releaseVersion } from '@svall/svalld/release';
import { hostCommands, recordJoined, setupList, type There } from '../src/commands/host.js';
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

  it('marks the home a join found on this release, with nothing to fix, as current, so its menu offers no upgrade there', async () => {
    ssh.reply(['host', 'list'], { stdout: `${JSON.stringify(rows)}\n` });
    recordJoined(path.join(work, 'config'), HOME as never, releaseVersion());
    const listed = JSON.parse(await cli(['list'], true)) as { id: string; current?: true }[];
    expect(listed.find((r) => r.id === HOME)).toMatchObject({ current: true });
  });

  it('in words: a machine with no route reads as one that dials in, and one owed an enrolment says why', async () => {
    ssh.reply(['host', 'list'], { stdout: `${JSON.stringify(rows)}\n` });
    const out = await cli(['list'], false);
    expect(out).toContain('(dials in) (from studio)');
    expect(out).not.toContain('undefined');
    expect(out).toContain('has not joined yet: No route to host');
  });

  it('a machine this home owes an enrolment says so on its own list, a refused login in what the run calls this home', async () => {
    const config = path.join(work, 'config');
    const r = MachineRegistry.load(config);
    r.put(W as never, { name: 'box', ssh: 'ada@box', platform: 'linux', arch: 'arm64', home: '/home/ada', svallBase: '/home/ada/.local/share/svall' });
    r.save();
    const p = resolvePaths(fleet);
    enter(p, 'hm_abcdefghij', 'adopted');
    const joining = async (owed: object) => {
      fs.writeFileSync(p.workersOwed, JSON.stringify({ id: 'hm_abcdefghij', workers: { [W]: owed } }));
      let out = '';
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out += String(c); return true; });
      try { await hostCommands(() => true, () => ({ name: 'private', home: fleet, managed: true }), () => config).parseAsync(['list'], { from: 'user' }); } finally { spy.mockRestore(); }
      return (JSON.parse(out) as { id: string; joining?: string }[]).find((m) => m.id === W)?.joining;
    };
    expect(await joining({ why: 'refused' })).toBe('refused');
    vi.stubEnv('SVALL_HOME_WORD', 'studio');
    onTestFinished(() => { vi.unstubAllEnvs(); });
    expect(await joining({ login: 'ada@box' })).toBe(`studio cannot log in to box; ${noLoginFix('studio', 'ada@box')}`);
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
    for (const op of ['add', 'upgrade']) ssh.reply(['host', op], { stdout: `${NONE}\n`, code: 1 });
    ssh.reply(['mkdir'], {});
    ssh.reply(['cat > "$1"'], {});
    ssh.reply(['mv'], {});
  };
  const copies = () => ssh.remoteCalls().filter((w) => w.includes('cat > "$1"'));

  it.each([
    ['add', ['add', 'box', '--ssh', 'ada@box']],
    ['upgrade', ['upgrade', 'box']],
  ])('a CLI on the home\'s release copies the archive it carries there, and runs %s again with it', async (op, args) => {
    carrying('1.2.3');
    await cli(args, true);
    expect(copies()).toHaveLength(1);
    expect(far(['host', op])).toHaveLength(2);
    expect(far(['host', op]).at(-1)!.some((w) => w.includes('--release'))).toBe(true);
  });

  it('a rollback installs no archive, so it copies none', async () => {
    carrying('1.2.3');
    await cli(['upgrade', 'box', '--rollback'], true);
    expect(copies()).toEqual([]);
    expect(far(['host', 'upgrade'])).toHaveLength(1);
  });

  it('a CLI on another release copies nothing, and names both releases on the relay step', async () => {
    carrying('1.2.4');
    const out = await cli(['add', 'box', '--ssh', 'ada@box'], true);
    expect(out).toContain('"detail":"studio runs 1.2.3, and this CLI 1.2.4: the archive it carries for linux-arm64 is of its own release"');
    expect(out).not.toContain('name one with --release');
    expect(copies()).toEqual([]);
    expect(far(['host', 'add'])).toHaveLength(1);
  });
});

describe('an archive a relay copied to this home', () => {
  // this fleet is the home: the run is the far one a relay started here, with the copy it was handed
  async function here(args: string[]): Promise<() => void> {
    let exit = () => {};
    const once = vi.spyOn(process, 'once').mockImplementation(((event: string, fn: () => void) => { if (event === 'exit') exit = fn; return process; }) as never);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = process.exitCode;
    try { await hostCommands(() => true, () => ({ name: 'private', home: fleet, managed: true }), () => path.join(work, 'config')).parseAsync(args, { from: 'user' }); } finally { spy.mockRestore(); once.mockRestore(); process.exitCode = code; }
    return exit;
  }
  const carried = () => {
    const dir = path.join(fleet, 'cache', 'carried');
    fs.mkdirSync(dir, { recursive: true });
    const left = path.join(dir, 'a-c.tar.gz');
    const copy = path.join(dir, 'b-c.tar.gz');
    for (const f of [left, copy]) fs.writeFileSync(f, 'x');
    const old = Date.now() / 1000 - 2 * 24 * 60 * 60;
    fs.utimesSync(left, old, old);
    return { left, copy };
  };

  it.each([
    ['add', (copy: string) => ['add', 'box', '--ssh', 'ada@box', '--release', copy]],
    ['upgrade', (copy: string) => ['upgrade', 'box', '--release', copy]],
  ])('a %s removes its copy as it ends, and one a stopped relay left over a day ago', async (_op, args) => {
    const { left, copy } = carried();
    const ended = await here(args(copy));
    expect(fs.existsSync(left)).toBe(false);
    expect(fs.existsSync(copy)).toBe(true);
    ended();
    expect(fs.existsSync(copy)).toBe(false);
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
