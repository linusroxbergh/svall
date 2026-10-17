import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDES, excludeMatcher, GIT_DIR_KEEP_RULES, GIT_KEEP_RULES } from '@svall/svalld/handover/inventory';
import { scanPath } from '../../../svalld/src/handover/manifest.js';
import {
  bundledRsync, exitKind, filterRules, parseLine, probeRsync, remoteShell, remoteSpec, resolveRsync, rsyncArgv, runRsync,
} from '../../src/controller/rsync.js';
import { SshMaster } from '../../src/controller/ssh.js';
import { installFakeSsh, type FakeSsh } from './fake-ssh.js';

const RSYNC = process.env.SVALL_TEST_RSYNC ?? bundledRsync();
const probe = await probeRsync(RSYNC);
const noRsync = probe.ok ? undefined : `no rsync 3 at ${RSYNC} (${probe.reason}): build it with scripts/build-controller.mjs or set SVALL_TEST_RSYNC`;
// CI sets SVALL_REQUIRE_RSYNC, and there a missing rsync fails the file instead of skipping what needs it
if (noRsync && process.env.SVALL_REQUIRE_RSYNC) throw new Error(noRsync);

const temps: string[] = [];
const tmp = (prefix = 'svall-rsync-'): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterEach(() => { for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const script = (dir: string, name: string, body: string): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
};

describe('probeRsync', () => {
  it.skipIf(noRsync)('accepts the pinned rsync 3', () => {
    expect(probe).toEqual({ ok: true, exe: RSYNC, version: expect.stringMatching(/^3\.\d+\.\d+$/) });
  });

  it('refuses openrsync, an rsync too old for protected arguments and --mkpath, and what is not there', async () => {
    const dir = tmp();
    const open = script(dir, 'openrsync', 'echo "openrsync: protocol version 29"; echo "rsync version 2.6.9 compatible"');
    const old = script(dir, 'old', 'echo "rsync  version 3.1.3  protocol version 31"');
    expect(await probeRsync(open)).toEqual({ ok: false, exe: open, reason: expect.stringMatching(/openrsync.*cannot protect remote arguments/) });
    expect(await probeRsync(old)).toEqual({ ok: false, exe: old, reason: expect.stringMatching(/3\.1\.3.*3\.2\.3 or newer/) });
    expect(await probeRsync(path.join(dir, 'absent'))).toMatchObject({ ok: false, reason: expect.stringMatching(/absent/) });
  });

  it('drives a Linux machine\'s own rsync where no bundled one is there, when it is new enough, and nowhere else', async () => {
    const dir = tmp();
    const system = script(dir, 'rsync', 'echo "rsync  version 3.2.7  protocol version 31"');
    const old = script(dir, 'old', 'echo "rsync  version 3.1.3  protocol version 31"');
    const absent = path.join(dir, 'bundled', 'rsync');
    expect(await resolveRsync(absent, 'linux', system)).toBe(system);
    await expect(resolveRsync(absent, 'darwin', system)).rejects.toThrow(/bundled/);
    await expect(resolveRsync(absent, 'linux', old)).rejects.toThrow(/3\.1\.3/);
  });

  it('finds the bundled rsync in a release, and the pinned build under vendor/ in a checkout', () => {
    const pins = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../../../scripts/release/pins.json'), 'utf8')) as { rsync: { version: string } };
    expect(bundledRsync()).toBe(path.resolve(import.meta.dirname, `../../../../vendor/rsync/${pins.rsync.version}-${process.arch}/rsync`));
    process.env.SVALL_RELEASE_ROOT = '/opt/svall release/1.2.3';
    try {
      expect(bundledRsync()).toBe('/opt/svall release/1.2.3/bin/rsync');
    } finally {
      delete process.env.SVALL_RELEASE_ROOT;
    }
  });
});

describe('remoteSpec', () => {
  it('escapes the names rsync\'s server would expand as a wildcard, and nothing else', () => {
    expect(remoteSpec('/home/li nus/it\'s $(x)/')).toBe("svall-remote.invalid:/home/li nus/it's $(x)/");
    expect(remoteSpec('/w/proj[1]*?/a\\b/c\\[d]/')).toBe('svall-remote.invalid:/w/proj\\[1]\\*\\?/a\\b/c\\\\\\[d]/');
  });
});

describe('filterRules', () => {
  it('keeps Git\'s records ahead of every exclude, each written as an explicit exclude', () => {
    expect(filterRules(['node_modules/', '+ looks like a rule', '*.tsbuildinfo'])).toBe(
      [...GIT_KEEP_RULES, '- node_modules/', '- + looks like a rule', '- *.tsbuildinfo'].map((l) => `${l}\n`).join(''),
    );
  });

  it('keeps Git\'s own entries ahead of the excludes in a Git directory carried on its own', () => {
    expect(filterRules(['logs/', 'build/'], 'gitdir')).toBe(
      [...GIT_KEEP_RULES, ...GIT_DIR_KEEP_RULES, '- logs/', '- build/'].map((l) => `${l}\n`).join(''),
    );
    expect(filterRules(['logs/'], 'repo')).toBe(filterRules(['logs/']));
  });

  it('refuses a pattern that would end its line early or say nothing', () => {
    expect(() => filterRules(['dist/\n+ secret'])).toThrow(/cannot be written as an rsync rule/);
    expect(() => filterRules(['a\rb'])).toThrow(/cannot be written as an rsync rule/);
    expect(() => filterRules([''])).toThrow(/cannot be written as an rsync rule/);
  });
});

describe('rsyncArgv', () => {
  const job = { rsh: remoteShell('/tmp/s'), source: '/src/', target: remoteSpec('/dst/'), delete: false, mkpath: false, dryRun: false };

  it('protects remote arguments, skips sockets and devices, and never deletes excluded files', () => {
    for (const j of [job, { ...job, delete: true }, { ...job, delete: true, dryRun: true, filterFile: '/state/a b/filters/r.rules' }]) {
      const argv = rsyncArgv(j);
      expect(argv).toEqual(expect.arrayContaining(['-s', '--no-specials', '--no-devices', '-8', '--itemize-changes']));
      expect(argv).not.toContain('--delete-excluded');
      expect(argv.filter((a) => a.startsWith('--delete'))).toEqual(j.delete ? ['--delete'] : []);
      // the paths come after the one end of options, and each is one argument
      expect(argv.slice(-3)).toEqual(['--', j.source, j.target]);
    }
  });

  it('compares by checksum without writing on a dry run, and reports progress only on a real one', () => {
    const real = rsyncArgv(job);
    const dry = rsyncArgv({ ...job, dryRun: true, mkpath: true, filterFile: '/state/a b/filters/r.rules' });
    expect(real).toContain('--info=progress2');
    expect(real).not.toContain('--dry-run');
    expect(dry).toEqual(expect.arrayContaining(['--dry-run', '--checksum', '--mkpath', '--exclude-from=/state/a b/filters/r.rules']));
    expect(dry).not.toContain('--info=progress2');
    expect(rsyncArgv({ ...job, checksum: true })).toEqual(expect.arrayContaining(['--checksum', '--info=progress2']));
    expect(real).not.toContain('--checksum');
  });
});

describe('parseLine', () => {
  it('reads itemized changes, deletions and links, whatever their names hold', () => {
    expect(parseLine('<f+++++++++ sub dir/ö/smörgås 🍞.txt')).toEqual({ kind: 'item', change: '<f+++++++++', name: 'sub dir/ö/smörgås 🍞.txt' });
    expect(parseLine('cL+++++++++ link -> ../-rf')).toEqual({ kind: 'item', change: 'cL+++++++++', name: 'link -> ../-rf' });
    expect(parseLine('*deleting   stale file')).toEqual({ kind: 'item', change: '*deleting', name: 'stale file' });
    expect(parseLine('.d..t...... ./')).toEqual({ kind: 'item', change: '.d..t......', name: './' });
    expect(parseLine('>fcs....... -rf')).toEqual({ kind: 'item', change: '>fcs.......', name: '-rf' });
  });

  it('reads byte and file progress', () => {
    expect(parseLine('       15000000  12%   25.86MB/s    0:00:00 (xfr#5, to-chk=35/41)')).toEqual({ kind: 'progress', bytes: 15_000_000, done: 6, total: 41 });
    expect(parseLine('  1,234,567  45%   12.34MB/s    0:00:01 (xfr#3, ir-chk=10/20)')).toEqual({ kind: 'progress', bytes: 1_234_567, done: 10, total: 20 });
    expect(parseLine('              2  15%    0.00kB/s    0:00:00')).toEqual({ kind: 'progress', bytes: 2 });
  });

  it('leaves anything else as text', () => {
    expect(parseLine('skipping non-regular file "sock"')).toEqual({ kind: 'other', text: 'skipping non-regular file "sock"' });
  });
});

describe('exitKind', () => {
  it('reads a lost link, a source that changed under the copy, and every other failure apart', () => {
    const r = (code: number | null, signal: NodeJS.Signals | null = null) => ({ code, signal, stderr: '' });
    expect(exitKind(r(0))).toBe('ok');
    expect(exitKind(r(24))).toBe('vanished');
    for (const code of [10, 12, 30, 35, 255]) expect(exitKind(r(code))).toBe('disconnected');
    for (const code of [1, 11, 23]) expect(exitKind(r(code))).toBe('failed');
    expect(exitKind(r(null, 'SIGKILL'))).toBe('failed');
  });
});

describe('runRsync', () => {
  it('hands on each line as it ends, whole characters and all, and keeps the exit and stderr', async () => {
    const dir = tmp();
    // a character split across two writes, and progress that rewrites its own line
    const exe = script(dir, 'fake', `printf '<f+++++++++ sm\\303'; sleep 0.1; printf '\\266rgas\\n  10  50%%  1kB/s  0:00:00\\r  20 100%%  1kB/s  0:00:00\\n'; echo warn >&2; exit 23`);
    const lines: string[] = [];
    const r = await runRsync(exe, [], { onLine: (l) => lines.push(l) });
    expect(lines).toEqual(['<f+++++++++ smörgas', '  10  50%  1kB/s  0:00:00', '  20 100%  1kB/s  0:00:00']);
    expect(r).toEqual({ code: 23, signal: null, stderr: 'warn\n' });
  });

  it('never lets the environment turn argument protection or character conversion back on', async () => {
    const dir = tmp();
    const exe = script(dir, 'env', 'env');
    process.env.RSYNC_ICONV = 'utf-8,latin1';
    process.env.RSYNC_OLD_ARGS = '1';
    try {
      const lines: string[] = [];
      await runRsync(exe, [], { onLine: (l) => lines.push(l) });
      expect(lines.filter((l) => l.startsWith('RSYNC_'))).toEqual([]);
    } finally {
      delete process.env.RSYNC_ICONV;
      delete process.env.RSYNC_OLD_ARGS;
    }
  });

  it('stops the command when its caller cancels', async () => {
    const dir = tmp();
    const exe = script(dir, 'slow', 'echo started; exec sleep 30');
    const abort = new AbortController();
    const r = await runRsync(exe, [], { signal: abort.signal, onLine: () => abort.abort() });
    expect(r.signal).toBe('SIGTERM');
  });

  it('runs rsync in a process group of its own, which a terminal\'s Ctrl-C to this one never reaches', async () => {
    const exe = script(tmp(), 'group', 'ps -o pgid= -p $$');
    const lines: string[] = [];
    await runRsync(exe, [], { onLine: (l) => lines.push(l.trim()) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toBe(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
  });
});

describe.skipIf(noRsync)('rsync 3 through the ssh master', { timeout: 60_000 }, () => {
  let ssh: FakeSsh;
  beforeEach(() => { ssh = installFakeSsh(); ssh.execute({ rsync: RSYNC }); });
  afterEach(() => ssh.clean());

  it('rides the master\'s socket with one `--` before the host, and sends no path through the far shell', async () => {
    const socketDir = path.join(ssh.dir, "sock dir 'q'");
    const master = await SshMaster.open({ destination: 'trift', socketDir });
    const src = tmp();
    const dst = path.join(tmp(), "to $(touch x) 'q' [1]");
    fs.mkdirSync(dst);
    fs.writeFileSync(path.join(src, '-rf'), 'x');
    try {
      const r = await runRsync(RSYNC, rsyncArgv({ rsh: remoteShell(master.socket), source: `${src}/`, target: remoteSpec(`${dst}/`), delete: true, mkpath: false, dryRun: false }), { onLine: () => {} });
      expect(r).toMatchObject({ code: 0 });
      expect(fs.readFileSync(path.join(dst, '-rf'), 'utf8')).toBe('x');
      const call = ssh.calls().find((c) => c.includes('--server')) as string[];
      // a name that can never resolve: with no master, ssh has nowhere else to go
      expect(call.slice(0, 6)).toEqual(['-S', master.socket, '-o', 'BatchMode=yes', '--', 'svall-remote.invalid']);
      expect(call.filter((a) => a === '--')).toHaveLength(1);
      const far = ssh.remoteCalls().find((w) => w.includes('--server')) as string[];
      expect(far.join(' ')).not.toContain(dst);
      expect(far.join(' ')).not.toContain(src);
    } finally {
      await master.close();
    }
  });

  it('writes a wildcard name where it names, not into a sibling the wildcard would match', async () => {
    const master = await SshMaster.open({ destination: 'trift', socketDir: ssh.socketDir });
    const src = tmp();
    const base = tmp();
    fs.writeFileSync(path.join(src, 'a.txt'), 'a');
    for (const name of ['proj[1]', 'proj1']) fs.mkdirSync(path.join(base, name));
    try {
      const r = await runRsync(RSYNC, rsyncArgv({ rsh: remoteShell(master.socket), source: `${src}/`, target: remoteSpec(`${base}/proj[1]/`), delete: false, mkpath: false, dryRun: false }), { onLine: () => {} });
      expect(r.code).toBe(0);
      expect(fs.readdirSync(path.join(base, 'proj[1]'))).toEqual(['a.txt']);
      expect(fs.readdirSync(path.join(base, 'proj1'))).toEqual([]);
    } finally {
      await master.close();
    }
  });
});

describe.skipIf(noRsync)('exclude parity with rsync 3', () => {
  const tree = (root: string): Promise<net.Server> => {
    const files = [
      'a.txt', 'sp ace/ö 🍞.md', '-rf', '$(touch pwned)', "it's", 'glob[1]*?.txt', 'back\\slash',
      'node_modules/x/index.js', 'pkg/node_modules/y.js', 'dist/out.js', 'src/dist', 'build.txt', 'app/build/o.js',
      '.venv/bin/python', 'py/__pycache__/m.pyc', 'target/debug/bin', '.next/cache', 'tsconfig.tsbuildinfo', 'deep/a.tsbuildinfo',
      '.git/HEAD', '.git/refs/heads/build/x', '.git/worktrees/dist/HEAD', '.git/node_modules/x', 'sub/.git',
      'logs/a.log', 'logs/deep/b.log', 'root-only.txt', 'nested/root-only.txt', 'x.swp', 'cache1/c', 'cache12/c',
    ];
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), f);
    }
    fs.symlinkSync('a.txt', path.join(root, 'link'));
    fs.mkdirSync(path.join(root, 'empty'));
    // a socket, as git's fsmonitor leaves in .git: the manifest skips it and so must rsync
    const server = net.createServer();
    return new Promise((resolve) => server.listen(path.join(root, '.git', 'fsmonitor--daemon.ipc'), () => resolve(server)));
  };

  it('carries exactly the files the manifest scan reads', async () => {
    const root = tmp('svall-parity-');
    const socket = await tree(root);
    const excludes = [...DEFAULT_EXCLUDES, '/root-only.txt', 'logs/**/*.log', '*.swp', 'cache?/'];
    const rules = path.join(tmp(), 'rules');
    fs.writeFileSync(rules, filterRules(excludes));
    try {
      // a local dry run: rsync evaluates the same filter file it sends a far rsync
      const argv = rsyncArgv({ rsh: 'ssh', source: `${root}/`, target: `${tmp()}/`, delete: false, mkpath: false, dryRun: true, filterFile: rules });
      const out = execFileSync(RSYNC, argv, { encoding: 'utf8' });
      const carried = out.split('\n').map(parseLine).flatMap((l) => (l.kind === 'item' && l.change[1] !== 'd' ? [l.name.replace(/ -> .*$/, '')] : [])).sort();
      const scanned = (await scanPath(root, excludeMatcher(excludes)))?.files.map((f) => f.path).sort();
      expect(carried).toEqual(scanned);
      expect(carried).toEqual(expect.arrayContaining(['.git/refs/heads/build/x', '.git/worktrees/dist/HEAD', '.git/node_modules/x', 'sub/.git', 'nested/root-only.txt', 'cache12/c']));
      expect(carried).toContain('logs/a.log');
      for (const gone of ['.git/fsmonitor--daemon.ipc', 'logs/deep/b.log', 'root-only.txt', 'cache1/c', 'app/build/o.js', 'pkg/node_modules/y.js', 'deep/a.tsbuildinfo']) {
        expect(carried).not.toContain(gone);
      }
    } finally {
      socket.close();
    }
  });
});
