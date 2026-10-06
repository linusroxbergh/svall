import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';

const SCRIPT = path.join(import.meta.dirname, '../scripts/install.sh');
const dirs: string[] = [];
const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// a DMG holding a stand-in Svall.app, served with a latest.json that names it; codesign and spctl are stubs that
// report the stand-in as signed by `team`
async function site(o: { sha?: string; team?: string; retry?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-install-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'stage/Svall.app/Contents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'stage/Svall.app/Contents/Info.plist'), '<plist/>');
  // not named Svall: a release can't build its own DMG while a volume of that name is mounted
  execFileSync('hdiutil', ['create', '-quiet', '-volname', 'svall-install-test', '-srcfolder', path.join(dir, 'stage'), '-format', 'UDZO', '-ov', path.join(dir, 'Svall.dmg')]);
  const dmg = fs.readFileSync(path.join(dir, 'Svall.dmg'));
  const sha = o.sha ?? crypto.createHash('sha256').update(dmg).digest('hex');
  const hits = { metadata: 0, download: 0 };
  const server = http.createServer((req, res) => {
    if (req.url === '/latest.json') hits.metadata++;
    if (req.url === '/Svall.dmg') hits.download++;
    if (o.retry && (req.url === '/latest.json' && hits.metadata === 1 || req.url === '/Svall.dmg' && hits.download === 1)) { res.statusCode = 503; res.end(); return; }
    if (req.url === '/latest.json') res.end(JSON.stringify({ version: '0.1.0', build: 1, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/Svall.dmg`, sha256: sha }));
    else if (req.url === '/Svall.dmg') res.end(dmg);
    else { res.statusCode = 404; res.end(); }
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const opened = path.join(dir, 'opened');
  fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\necho "$1" > ${opened}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codesign'), `#!/bin/sh\n[ "$1" = -dv ] && echo TeamIdentifier=${o.team ?? 'W76DRQ3JZN'} >&2\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'spctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { dir, bin, hits, opened, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SVALL_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, SVALL_INSTALL_DIR: path.join(dir, 'Apps') } };
}

// the script waits on the server this process runs, so it must not block the event loop
const run = (env: NodeJS.ProcessEnv, tty = false) => new Promise<{ status: number | null; stderr: string; stdout: string }>((resolve) => {
  const p = tty ? spawn('script', ['-q', '/dev/null', 'sh', SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'] }) : spawn('sh', [SCRIPT], { env });
  let stderr = '', stdout = '';
  p.stdin?.end();
  p.stderr.on('data', (d) => (stderr += d));
  p.stdout.on('data', (d) => (stdout += d));
  p.on('close', (status) => resolve({ status, stderr, stdout }));
});

test('installs the app latest.json names, after checking its sha256, and opens it', async () => {
  const s = await site();
  const r = await run(s.env);
  expect(r.status).toBe(0);
  expect(fs.existsSync(path.join(s.dir, 'Apps/Svall.app/Contents/Info.plist'))).toBe(true);
  expect(fs.existsSync(path.join(s.dir, 'Apps/.Svall.app.new'))).toBe(false);
  expect(fs.readFileSync(s.opened, 'utf8').trim()).toBe(path.join(s.dir, 'Apps/Svall.app'));
  expect(r.stderr).toContain('┌  Svall');
  expect(r.stderr).toContain("Verifying Apple's notarization and developer signature");
  expect(r.stderr).toContain('Installed Svall 0.1.0. Opening the app.');
  expect(r.stderr).not.toMatch(/[\x1b\r]/);
  expect(fs.existsSync(path.join(s.dir, 'Apps/.Svall.install-lock'))).toBe(false);
}, 30_000);

test('starts the new copy afresh, so one a stopped install left behind is not merged into it', async () => {
  const s = await site();
  fs.mkdirSync(path.join(s.dir, 'Apps/.Svall.app.new/Contents'), { recursive: true });
  fs.writeFileSync(path.join(s.dir, 'Apps/.Svall.app.new/Contents/stale'), '');
  expect((await run(s.env)).status).toBe(0);
  expect(fs.readdirSync(path.join(s.dir, 'Apps/Svall.app/Contents'))).toEqual(['Info.plist']);
}, 30_000);

test('refuses a download whose sha256 does not match, and installs nothing', async () => {
  const s = await site({ sha: '0'.repeat(64) });
  const r = await run(s.env);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/sha256/);
  expect(fs.existsSync(path.join(s.dir, 'Apps/Svall.app'))).toBe(false);
}, 30_000);

test('refuses an app signed by another team, and installs nothing', async () => {
  const s = await site({ team: 'AAAAAAAAAA' });
  const r = await run(s.env);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/signed by its developer/);
  expect(fs.existsSync(path.join(s.dir, 'Apps/Svall.app'))).toBe(false);
  expect(fs.existsSync(s.opened)).toBe(false);
}, 30_000);

test('retries transient failures in release metadata and the download', async () => {
  const s = await site({ retry: true });
  const r = await run(s.env);
  expect(r.status).toBe(0);
  expect(s.hits).toEqual({ metadata: 2, download: 2 });
}, 30_000);

test('keeps the previous app after a failed copy, failed replacement or interrupted replacement', async () => {
  const s = await site();
  const dest = path.join(s.dir, 'Apps');
  fs.mkdirSync(path.join(dest, 'Svall.app'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'Svall.app/previous'), 'old app');
  fs.writeFileSync(path.join(s.bin, 'ditto'), '#!/bin/sh\necho "not enough space" >&2\nexit 1\n', { mode: 0o755 });
  const copy = await run(s.env);
  expect(copy.status).toBe(1);
  expect(copy.stderr).toContain('not enough space');
  expect(fs.readFileSync(path.join(dest, 'Svall.app/previous'), 'utf8')).toBe('old app');
  fs.unlinkSync(path.join(s.bin, 'ditto'));

  for (const interrupted of [false, true]) {
    fs.writeFileSync(path.join(s.bin, 'mv'), `#!/bin/sh
case "$1" in */.Svall.app.new) ${interrupted ? 'kill -TERM "$PPID"' : 'echo "replacement refused" >&2'}; exit 1 ;; esac
exec /bin/mv "$@"
`, { mode: 0o755 });
    const r = await run(s.env);
    expect(r.status).toBe(interrupted ? 143 : 1);
    expect(fs.readFileSync(path.join(dest, 'Svall.app/previous'), 'utf8')).toBe('old app');
    expect(fs.existsSync(path.join(dest, '.Svall.app.new'))).toBe(false);
    expect(fs.existsSync(path.join(dest, '.Svall.app.old'))).toBe(false);
    expect(fs.existsSync(path.join(dest, '.Svall.install-lock'))).toBe(false);
    expect(fs.existsSync(s.opened)).toBe(false);
  }
}, 60_000);

test('replaces an existing app and removes its backup only after the new one is in place', async () => {
  const s = await site();
  const dest = path.join(s.dir, 'Apps');
  fs.mkdirSync(path.join(dest, 'Svall.app'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'Svall.app/previous'), 'old app');
  expect((await run(s.env)).status).toBe(0);
  expect(fs.existsSync(path.join(dest, 'Svall.app/Contents/Info.plist'))).toBe(true);
  expect(fs.existsSync(path.join(dest, 'Svall.app/previous'))).toBe(false);
  expect(fs.existsSync(path.join(dest, '.Svall.app.old'))).toBe(false);
}, 30_000);

test('a backup it cannot delete leaves the new app installed, and the next run says what to remove', async () => {
  const s = await site();
  const dest = path.join(s.dir, 'Apps');
  fs.mkdirSync(path.join(dest, 'Svall.app'), { recursive: true });
  fs.writeFileSync(path.join(s.bin, 'rm'), `#!/bin/sh
case "$2" in */.Svall.app.old) [ -e "$2" ] && { echo "Operation not permitted" >&2; exit 1; } ;; esac
exec /bin/rm "$@"
`, { mode: 0o755 });
  expect((await run(s.env)).status).toBe(0);
  expect(fs.existsSync(path.join(dest, 'Svall.app/Contents/Info.plist'))).toBe(true);
  expect(fs.existsSync(s.opened)).toBe(true);
  const again = await run(s.env);
  expect(again.status).toBe(1);
  expect(again.stderr).toContain(`Remove ${dest}/.Svall.app.old`);
  expect(fs.existsSync(path.join(dest, 'Svall.app/Contents/Info.plist'))).toBe(true);
  expect(fs.existsSync(path.join(dest, '.Svall.install-lock'))).toBe(false);
}, 60_000);

test('refuses concurrent installs without disturbing another run’s staged app or lock', async () => {
  const s = await site();
  const dest = path.join(s.dir, 'Apps');
  fs.mkdirSync(path.join(dest, '.Svall.install-lock'), { recursive: true });
  fs.mkdirSync(path.join(dest, '.Svall.app.new'));
  fs.writeFileSync(path.join(dest, '.Svall.app.new/other-install'), 'keep');
  const r = await run(s.env);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('another install');
  expect(fs.readFileSync(path.join(dest, '.Svall.app.new/other-install'), 'utf8')).toBe('keep');
  expect(fs.existsSync(path.join(dest, '.Svall.install-lock'))).toBe(true);
}, 30_000);

test('says a folder it cannot write to is not writable, rather than held by another install', async () => {
  const s = await site();
  const dest = path.join(s.dir, 'Apps');
  fs.mkdirSync(dest, { mode: 0o555 });
  const r = await run(s.env);
  fs.chmodSync(dest, 0o755);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain(`could not write to ${dest}`);
}, 30_000);

test('a failure to open the installed app is not reported as an installation failure', async () => {
  const s = await site();
  fs.writeFileSync(path.join(s.bin, 'open'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const r = await run(s.env);
  expect(r.status).toBe(0);
  expect(r.stderr).toContain(`Installed Svall 0.1.0. Open it from ${s.env.SVALL_INSTALL_DIR}.`);
  expect(fs.existsSync(path.join(s.dir, 'Apps/Svall.app/Contents/Info.plist'))).toBe(true);
}, 30_000);

test('terminal progress uses restrained colour, respects NO_COLOR and avoids animation on dumb terminals', async () => {
  const s = await site();
  const tty = await run({ ...s.env, TERM: 'xterm-256color', NO_COLOR: '' }, true);
  expect(tty.status, tty.stdout + tty.stderr).toBe(0);
  expect(tty.stdout).toContain('\x1b[36m');
  expect(tty.stdout).toContain('\x1b[2K');
  expect(tty.stdout).toContain('100.0%');
  const noColor = await run({ ...s.env, TERM: 'xterm-256color', NO_COLOR: '1' }, true);
  expect(noColor.status).toBe(0);
  expect(noColor.stdout).not.toContain('\x1b[36m');
  expect(noColor.stdout).toContain('Installed Svall 0.1.0');
  const dumb = await run({ ...s.env, TERM: 'dumb', NO_COLOR: '' }, true);
  expect(dumb.status).toBe(0);
  expect(dumb.stdout).not.toContain('\x1b');
  expect(dumb.stdout).not.toContain('100.0%');
}, 60_000);
