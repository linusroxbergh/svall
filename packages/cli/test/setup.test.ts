import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAUNCHD_LABEL, profileLabel } from '@archipelago/archid/profile';
import { cleanHomes, makeHome } from '@archipelago/archid/test-helpers';
import { daemonRuns, setupCommand } from '../src/commands/setup.js';

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
    try {
      await setupCommand(() => ({ name: 'private', home: path.join(home, '.archipelago'), managed: true }), () => true, 'linux')
        .parseAsync(['--rollback'], { from: 'user' });
      expect(fs.readlinkSync(path.join(prefix, 'current'))).toBe(path.join(prefix, 'releases', '1.0.0'));
      expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([
        '--user restart archipelago-archid@private.service',
        '--user restart archipelago-archid@work.service',
        '--user restart archipelago-gateway.service',
      ]);
    } finally {
      for (const d of [prefix, path.join(home, '.config')]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
