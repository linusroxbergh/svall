import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { cleanHomes, makeHome } from '@svall/svalld/test-helpers';
import { PROTOCOL_VERSION } from '@svall/protocol';
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

describe('svall setup on Linux', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = 0; cleanHomes(); });

  it('looks for claude on the PATH the units run with, which holds ~/.local/bin where an ssh login may not', async () => {
    const home = makeHome();
    vi.stubEnv('HOME', home);
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\necho "2.1.300 (Claude Code)"\n', { mode: 0o755 });
    vi.stubEnv('PATH', '/usr/bin:/bin');
    vi.stubEnv('SHELL', '/usr/bin/true');
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    await setupCommand(() => ({ name: 'private', home: path.join(home, '.svall'), managed: true }), () => true, 'linux')
      .parseAsync(['--check'], { from: 'user' });
    // with no ~/.claude yet, only a claude found makes setup write its hooks
    expect(JSON.parse(out.join('')).warnings).toContain('! hooks  missing or out of date: run svall setup');
  });

  it('writes the hooks where the unit\'s CLAUDE_CONFIG_DIR and CODEX_HOME point, which only the login shell names', async () => {
    const home = makeHome();
    vi.stubEnv('HOME', home);
    const local = path.join(home, '.local', 'bin');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'claude'), '#!/bin/sh\necho "2.1.300 (Claude Code)"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(local, 'codex'), '#!/bin/sh\necho "codex-cli 0.156.1"\n', { mode: 0o755 });
    const claudeDir = path.join(home, '.config', 'claude');
    const codexDir = path.join(home, '.config', 'codex');
    const bin = makeHome();
    fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\necho "tmux 3.5a"\n', { mode: 0o755 });
    // the account's profile sets both, and the ssh command setup runs in reads no profile
    fs.writeFileSync(path.join(bin, 'login-shell'), `#!/bin/sh\nexport CLAUDE_CONFIG_DIR='${claudeDir}' CODEX_HOME='${codexDir}'\nexec /bin/sh -c "$2"\n`, { mode: 0o755 });
    vi.stubEnv('SHELL', path.join(bin, 'login-shell'));
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await setupCommand(() => ({ name: 'private', home: path.join(home, '.svall'), managed: true }), () => true, 'linux')
      .parseAsync(['--no-launchctl'], { from: 'user' });
    expect(JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).hooks).toBeDefined();
    expect(JSON.parse(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf8')).hooks).toBeDefined();
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
    expect(fs.readFileSync(path.join(home, '.config', 'systemd', 'user', 'svall-svalld@private.service'), 'utf8'))
      .toContain(`Environment="CLAUDE_CONFIG_DIR=${claudeDir}"\nEnvironment="CODEX_HOME=${codexDir}"\n`);
  });

  it('restarts every fleet daemon and the gateway after a rollback, so none keeps running the release it left', async () => {
    const home = process.env.HOME!;
    const prefix = path.join(home, '.local', 'share', 'svall');
    for (const v of ['1.0.0', '1.1.0']) fs.mkdirSync(path.join(prefix, 'releases', v), { recursive: true });
    fs.symlinkSync(path.join(prefix, 'releases', '1.1.0'), path.join(prefix, 'current'));
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    for (const u of ['svall-svalld@private.service', 'svall-svalld@work.service', 'svall-gateway.service', 'other.service']) {
      fs.writeFileSync(path.join(unitDir, u), '');
    }
    const bin = makeHome();
    const log = path.join(bin, 'systemctl.log');
    fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> '${log}'\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const probed: string[] = [];
    try {
      await setupCommand(() => ({ name: 'private', home: path.join(home, '.svall'), managed: true }), () => true, 'linux', async (fleet, release) => { probed.push(`${fleet} ${release}`); return true; })
        .parseAsync(['--rollback'], { from: 'user' });
      expect(fs.readlinkSync(path.join(prefix, 'current'))).toBe(path.join(prefix, 'releases', '1.0.0'));
      expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([
        '--user restart svall-svalld@private.service',
        '--user restart svall-svalld@work.service',
        '--user restart svall-gateway.service',
      ]);
      expect(probed).toEqual(['private 1.0.0', 'work 1.0.0']);
    } finally {
      for (const d of [prefix, path.join(home, '.config')]) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('takes a daemon back on an older protocol as answering from the release it went back to', async () => {
    const home = process.env.HOME!;
    const prefix = path.join(home, '.local', 'share', 'svall');
    for (const v of ['1.0.0', '1.1.0']) fs.mkdirSync(path.join(prefix, 'releases', v), { recursive: true });
    fs.symlinkSync(path.join(prefix, 'releases', '1.1.0'), path.join(prefix, 'current'));
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, 'svall-svalld@private.service'), '');
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
    const fleet = path.join(home, '.svall');
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

  it('refuses a rollback asked with --check or --release, or for a fleet other than the private one, and goes back on nothing', async () => {
    const home = process.env.HOME!;
    const prefix = path.join(home, '.local', 'share', 'svall');
    for (const v of ['1.0.0', '1.1.0']) fs.mkdirSync(path.join(prefix, 'releases', v), { recursive: true });
    fs.symlinkSync(path.join(prefix, 'releases', '1.1.0'), path.join(prefix, 'current'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const setup = (name: string, argv: string[]) => setupCommand(() => ({ name, home: path.join(home, name === 'private' ? '.svall' : `.svall-${name}`), managed: true }), () => true, 'linux')
      .parseAsync(['--no-launchctl', '--rollback', ...argv], { from: 'user' });
    try {
      await expect(setup('private', ['--check'])).rejects.toThrow('--rollback takes neither --check nor --release');
      await expect(setup('private', ['--release', path.join(prefix, 'releases', '1.0.0')])).rejects.toThrow('--rollback takes neither --check nor --release');
      await expect(setup('work', [])).rejects.toThrow('svall setup configures the private fleet; run svall work to open that one');
      expect(fs.readlinkSync(path.join(prefix, 'current'))).toBe(path.join(prefix, 'releases', '1.1.0'));
    } finally {
      fs.rmSync(prefix, { recursive: true, force: true });
    }
  });

  it('fails a rollback, naming the fleet, when a restarted daemon does not answer from the release it went back to', async () => {
    const home = process.env.HOME!;
    const prefix = path.join(home, '.local', 'share', 'svall');
    for (const v of ['1.0.0', '1.1.0']) fs.mkdirSync(path.join(prefix, 'releases', v), { recursive: true });
    fs.symlinkSync(path.join(prefix, 'releases', '1.1.0'), path.join(prefix, 'current'));
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    for (const u of ['svall-svalld@private.service', 'svall-svalld@work.service']) fs.writeFileSync(path.join(unitDir, u), '');
    const bin = makeHome();
    fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(setupCommand(() => ({ name: 'private', home: path.join(home, '.svall'), managed: true }), () => true, 'linux', async (fleet) => fleet !== 'work')
        .parseAsync(['--rollback'], { from: 'user' })).rejects.toThrow(/the work fleet's daemon did not answer from release 1\.0\.0/);
    } finally {
      for (const d of [prefix, path.join(home, '.config')]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
