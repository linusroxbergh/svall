import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '@svall/svalld/paths';
import { cleanHomes, makeHome } from '@svall/svalld/test-helpers';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tsx = path.join(root, 'node_modules/.bin/tsx');
const main = path.join(root, 'packages/cli/src/main.ts');

afterEach(cleanHomes);

function svall(home: string, ...args: string[]) {
  const child = spawn(tsx, [main, ...args], { env: { ...process.env, SVALL_HOME: home } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
  return { child, done };
}

describe('svall worker', () => {
  it('link carries its stdin to link.sock and the socket back on its stdout, and ends with its input', async () => {
    const home = makeHome();
    const heard: string[] = [];
    const server = net.createServer((s) => {
      s.on('data', (c: Buffer) => { heard.push(c.toString()); s.write('{"t":"hello"}\n'); });
    });
    await new Promise<void>((r) => server.listen(resolvePaths(home).linkSock, r));
    try {
      const { child, done } = svall(home, 'worker', 'link');
      child.stdin.write('{"t":"ping"}\n');
      await new Promise<void>((r) => child.stdout.once('data', () => r()));
      child.stdin.end();
      const r = await done;
      expect(r).toEqual({ code: 0, stdout: '{"t":"hello"}\n', stderr: '' });
      expect(heard.join('')).toBe('{"t":"ping"}\n');
    } finally {
      server.close();
    }
  });

  it('link ends with an error when no worker daemon listens', async () => {
    const r = await svall(makeHome(), 'worker', 'link').done;
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/link\.sock/);
  });

  it('enroll writes worker.json, readable by its owner alone, with the token read from stdin', async () => {
    const home = makeHome();
    const ids = { home: crypto.randomUUID(), fleet: crypto.randomUUID() };
    const enroll = (token: string) => {
      const run = svall(home, 'worker', 'enroll', '--home-machine', ids.home, '--home-name', 'linus-mbp', '--fleet-id', ids.fleet);
      run.child.stdin.end(token);
      return run.done;
    };
    expect(await enroll('short\n')).toMatchObject({ code: 1, stderr: expect.stringMatching(/token/) });
    expect(fs.existsSync(resolvePaths(home).workerFile)).toBe(false);
    const token = 'a'.repeat(48);
    expect(await enroll(`${token}\n`)).toEqual({ code: 0, stdout: '', stderr: '' });
    const file = resolvePaths(home).workerFile;
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ homeMachineId: ids.home, fleetId: ids.fleet, token, homeName: 'linus-mbp' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('env writes VAR=value into the fleet .env, mode 600, replacing an earlier line and keeping the others', async () => {
    const home = makeHome();
    fs.writeFileSync(resolvePaths(home).env, 'A=1\nGAMMA_TOKEN=old\n');
    const r = svall(home, 'worker', 'env', 'GAMMA_TOKEN'); r.child.stdin.end('xyz\n');
    expect(await r.done).toMatchObject({ code: 0, stdout: "GAMMA_TOKEN is set for this fleet's robots on this machine\n" });
    expect(fs.readFileSync(resolvePaths(home).env, 'utf8')).toBe('A=1\nGAMMA_TOKEN=xyz\n');
    expect(fs.statSync(resolvePaths(home).env).mode & 0o777).toBe(0o600);
  });

  it('env refuses a name that is not a variable, and an empty value', async () => {
    const bad = svall(makeHome(), 'worker', 'env', 'lower'); bad.child.stdin.end('x');
    expect(await bad.done).toMatchObject({ code: 1, stderr: expect.stringContaining('lower is not a variable name') });
    const empty = svall(makeHome(), 'worker', 'env', 'GAMMA_TOKEN'); empty.child.stdin.end('\n');
    expect(await empty.done).toMatchObject({ code: 1, stderr: expect.stringContaining('no value given') });
  });

  it('env refuses a value .env cannot hold unchanged, without echoing it, and keeps the file', async () => {
    for (const v of ['SECRETVAL\nb', ' SECRETVAL', 'SECRETVAL ', '"SECRETVAL"', "'SECRETVAL'"]) {
      const home = makeHome();
      fs.writeFileSync(resolvePaths(home).env, 'A=1\n');
      const r = svall(home, 'worker', 'env', 'GAMMA_TOKEN'); r.child.stdin.end(`${v}\n`);
      const out = await r.done;
      expect(out.code).toBe(1);
      expect(out.stderr).toContain('cannot be stored');
      expect(out.stderr + out.stdout).not.toContain('SECRETVAL');
      expect(fs.readFileSync(resolvePaths(home).env, 'utf8')).toBe('A=1\n');
    }
  });

  it('env leaves one line for the variable when the .env held two', async () => {
    const home = makeHome();
    fs.writeFileSync(resolvePaths(home).env, 'GAMMA_TOKEN=a\nB=2\nexport GAMMA_TOKEN=b\n');
    const r = svall(home, 'worker', 'env', 'GAMMA_TOKEN'); r.child.stdin.end('xyz\r\n');
    expect((await r.done).code).toBe(0);
    expect(fs.readFileSync(resolvePaths(home).env, 'utf8')).toBe('GAMMA_TOKEN=xyz\nB=2\n');
  });
});
