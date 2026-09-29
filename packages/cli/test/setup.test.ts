import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { userPaths } from '@archipelago/archid/paths';
import { LAUNCHD_LABEL, profileLabel } from '@archipelago/archid/profile';
import { shimsCurrent } from '@archipelago/archid/setup';
import { cleanHomes, makeHome } from '@archipelago/archid/test-helpers';
import { PROTOCOL_VERSION } from '@archipelago/protocol';
import { DEFAULT_PREFIX } from '../../../scripts/install-release.mjs';
import { daemonRuns, setupCommand } from '../src/commands/setup.js';

// an installed release has no checkout, so asking for one throws as it does there
const release = vi.hoisted(() => ({ installed: false }));
vi.mock('@archipelago/archid/release', async (actual) => {
  const real = await actual<typeof import('@archipelago/archid/release')>();
  return {
    ...real,
    isRelease: () => release.installed || real.isRelease(),
    repoRoot: () => { if (release.installed) throw new Error('this is an installed release, not a checkout'); return real.repoRoot(); },
  };
});

describe('archi setup on an installed release', () => {
  afterEach(() => { release.installed = false; vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = 0; cleanHomes(); });

  it('sets up from the release current names, with and without --check, as every hint to run archi setup expects', async () => {
    release.installed = true;
    const home = process.env.HOME!;
    // stand-ins for tmux and a signed-in claude, so neither the real ones nor anything else on this PATH runs
    const bin = makeHome();
    fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\necho "tmux 3.5a"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\ncase "$1" in --version) echo "2.1.300 (Claude Code)";; *) echo \'{"loggedIn":true}\';; esac\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    const setup = () => setupCommand(() => ({ name: 'private', home: path.join(home, '.archipelago'), managed: true }), () => true, 'darwin', () => Promise.reject(new Error('launchctl ran')));
    try {
      await setup().parseAsync(['--check'], { from: 'user' });
      expect(JSON.parse(out.splice(0).join('')).warnings).toContain('! shims  missing or out of date: run archi setup');
      await setup().parseAsync(['--no-launchctl'], { from: 'user' });
      expect(shimsCurrent(userPaths().shimDir, { release: path.join(DEFAULT_PREFIX, 'current') })).toBe(true);
    } finally {
      for (const d of [path.join(home, '.local'), path.join(home, 'Library'), path.join(home, '.claude'), path.join(home, '.archipelago')]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('the probe after a Linux upgrade', () => {
  const daemon = (release: string) => () => Promise.resolve({ call: () => Promise.resolve({ release }), close: () => undefined });

  it('passes only a daemon that reports the release just installed', async () => {
    expect(await daemonRuns('1.2.4', daemon('1.2.4'), 0)).toBe(true);
    // the old daemon still answering is the upgrade that never restarted
    expect(await daemonRuns('1.2.4', daemon('1.2.3'), 300)).toBe(false);
  });

  it('keeps asking a daemon that is not up yet', async () => {
    let tries = 0;
    const late = () => (++tries < 3 ? Promise.reject(new Error('ECONNREFUSED')) : daemon('1.2.4')());
    expect(await daemonRuns('1.2.4', late, 5000, 10)).toBe(true);
  });
});

describe('archi setup --rollback on a Mac', () => {
  afterEach(() => { vi.restoreAllMocks(); cleanHomes(); });

  const rollback = async (args: string[]) => {
    const home = process.env.HOME!;
    const prefix = path.join(home, '.local', 'share', 'archipelago');
    for (const v of ['1.0.0', '1.1.0']) fs.mkdirSync(path.join(prefix, 'releases', v), { recursive: true });
    fs.symlinkSync(path.join(prefix, 'releases', '1.1.0'), path.join(prefix, 'current'));
    const agents = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(agents, { recursive: true });
    for (const f of [`${LAUNCHD_LABEL}.plist`, `${profileLabel('work')}.plist`, 'com.example.other.plist']) fs.writeFileSync(path.join(agents, f), '');
    const calls: string[][] = [];
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    try {
      await setupCommand(() => ({ name: 'private', home: path.join(home, '.archipelago'), managed: true }), () => true, 'darwin', (a) => { calls.push(a); return Promise.resolve(); })
        .parseAsync(['--rollback', ...args], { from: 'user' });
      expect(fs.readlinkSync(path.join(prefix, 'current'))).toBe(path.join(prefix, 'releases', '1.0.0'));
    } finally {
      for (const d of [prefix, path.join(home, 'Library')]) fs.rmSync(d, { recursive: true, force: true });
    }
    return { calls, done: (JSON.parse(out.join('')) as { done: string[] }).done };
  };

  it('starts every fleet\'s launchd agent again, so none keeps running the release it went back from', async () => {
    const { calls } = await rollback([]);
    const uid = os.userInfo().uid;
    expect(calls).toEqual([
      ['kickstart', '-k', `gui/${uid}/${LAUNCHD_LABEL}`],
      ['kickstart', '-k', `gui/${uid}/${profileLabel('work')}`],
    ]);
  });

  it('with --no-launchctl starts nothing and says the daemons change release at their next start', async () => {
    const { calls, done } = await rollback(['--no-launchctl']);
    expect(calls).toEqual([]);
    expect(done.at(-1)).toMatch(/next start/);
  });
});

describe('archi setup on Linux', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = 0; cleanHomes(); });

  it('looks for claude on the PATH the units run with, which holds ~/.local/bin where an ssh login may not', async () => {
    const home = makeHome();
    vi.stubEnv('HOME', home);
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\necho "2.1.300 (Claude Code)"\n', { mode: 0o755 });
    vi.stubEnv('PATH', '/usr/bin:/bin');
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    await setupCommand(() => ({ name: 'private', home: path.join(home, '.archipelago'), managed: true }), () => true, 'linux')
      .parseAsync(['--check'], { from: 'user' });
    // with no ~/.claude yet, only a claude found makes setup write its hooks
    expect(JSON.parse(out.join('')).warnings).toContain('! hooks  missing or out of date: run archi setup');
  });

  it('restarts every fleet daemon and the gateway after a rollback, so none keeps running the release it left', async () => {
    const home = process.env.HOME!;
    const prefix = path.join(home, '.local', 'share', 'archipelago');
    for (const v of ['1.0.0', '1.1.0']) fs.mkdirSync(path.join(prefix, 'releases', v), { recursive: true });
    fs.symlinkSync(path.join(prefix, 'releases', '1.1.0'), path.join(prefix, 'current'));
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    for (const u of ['archipelago-archid@private.service', 'archipelago-archid@work.service', 'archipelago-gateway.service', 'other.service']) {
      fs.writeFileSync(path.join(unitDir, u), '');
    }
    const bin = makeHome();
    const log = path.join(bin, 'systemctl.log');
    fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> '${log}'\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const probed: string[] = [];
    try {
      await setupCommand(() => ({ name: 'private', home: path.join(home, '.archipelago'), managed: true }), () => true, 'linux', undefined, async (fleet, release) => { probed.push(`${fleet} ${release}`); return true; })
        .parseAsync(['--rollback'], { from: 'user' });
      expect(fs.readlinkSync(path.join(prefix, 'current'))).toBe(path.join(prefix, 'releases', '1.0.0'));
      expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([
        '--user restart archipelago-archid@private.service',
        '--user restart archipelago-archid@work.service',
        '--user restart archipelago-gateway.service',
      ]);
      expect(probed).toEqual(['private 1.0.0', 'work 1.0.0']);
    } finally {
      for (const d of [prefix, path.join(home, '.config')]) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('takes a daemon back on an older protocol as answering from the release it went back to', async () => {
    const home = process.env.HOME!;
    const prefix = path.join(home, '.local', 'share', 'archipelago');
    for (const v of ['1.0.0', '1.1.0']) fs.mkdirSync(path.join(prefix, 'releases', v), { recursive: true });
    fs.symlinkSync(path.join(prefix, 'releases', '1.1.0'), path.join(prefix, 'current'));
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, 'archipelago-archid@private.service'), '');
    const bin = makeHome();
    fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (ws) => {
      let authed = false;
      ws.on('message', (raw) => {
        if (!authed) { authed = true; ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION - 1 } })); return; }
        ws.send(JSON.stringify({ id: (JSON.parse(raw.toString()) as { id: number }).id, result: { release: '1.0.0' } }));
      });
    });
    const fleet = path.join(home, '.archipelago');
    fs.mkdirSync(fleet, { recursive: true });
    fs.writeFileSync(path.join(fleet, 'port'), String((wss.address() as { port: number }).port));
    fs.writeFileSync(path.join(fleet, 'token'), 't');
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    try {
      await setupCommand(() => ({ name: 'private', home: fleet, managed: true }), () => true, 'linux').parseAsync(['--rollback'], { from: 'user' });
      expect(JSON.parse(out.join('')).done).toContain('the private fleet\'s daemon answers from release 1.0.0');
    } finally {
      await new Promise((r) => wss.close(r));
      for (const d of [prefix, path.join(home, '.config'), fleet]) fs.rmSync(d, { recursive: true, force: true });
    }
  }, 30_000);

  it('fails a rollback, naming the fleet, when a restarted daemon does not answer from the release it went back to', async () => {
    const home = process.env.HOME!;
    const prefix = path.join(home, '.local', 'share', 'archipelago');
    for (const v of ['1.0.0', '1.1.0']) fs.mkdirSync(path.join(prefix, 'releases', v), { recursive: true });
    fs.symlinkSync(path.join(prefix, 'releases', '1.1.0'), path.join(prefix, 'current'));
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    for (const u of ['archipelago-archid@private.service', 'archipelago-archid@work.service']) fs.writeFileSync(path.join(unitDir, u), '');
    const bin = makeHome();
    fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(setupCommand(() => ({ name: 'private', home: path.join(home, '.archipelago'), managed: true }), () => true, 'linux', undefined, async (fleet) => fleet !== 'work')
        .parseAsync(['--rollback'], { from: 'user' })).rejects.toThrow(/the work fleet's daemon did not answer from release 1\.0\.0/);
    } finally {
      for (const d of [prefix, path.join(home, '.config')]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
