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
async function site(o: { sha?: string; team?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-install-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'stage/Svall.app/Contents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'stage/Svall.app/Contents/Info.plist'), '<plist/>');
  execFileSync('hdiutil', ['create', '-quiet', '-volname', 'Svall', '-srcfolder', path.join(dir, 'stage'), '-format', 'UDZO', '-ov', path.join(dir, 'Svall.dmg')]);
  const dmg = fs.readFileSync(path.join(dir, 'Svall.dmg'));
  const sha = o.sha ?? crypto.createHash('sha256').update(dmg).digest('hex');
  const server = http.createServer((req, res) => {
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
  return { dir, opened, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SVALL_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, SVALL_INSTALL_DIR: path.join(dir, 'Apps') } };
}

// the script waits on the server this process runs, so it must not block the event loop
const run = (env: NodeJS.ProcessEnv) => new Promise<{ status: number | null; stderr: string }>((resolve) => {
  const p = spawn('sh', [SCRIPT], { env });
  let stderr = '';
  p.stderr.on('data', (d) => (stderr += d));
  p.on('close', (status) => resolve({ status, stderr }));
});

test('installs the app latest.json names, after checking its sha256, and opens it', async () => {
  const s = await site();
  const r = await run(s.env);
  expect(r.status).toBe(0);
  expect(fs.existsSync(path.join(s.dir, 'Apps/Svall.app/Contents/Info.plist'))).toBe(true);
  expect(fs.existsSync(path.join(s.dir, 'Apps/.Svall.app.new'))).toBe(false);
  expect(fs.readFileSync(s.opened, 'utf8').trim()).toBe(path.join(s.dir, 'Apps/Svall.app'));
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
