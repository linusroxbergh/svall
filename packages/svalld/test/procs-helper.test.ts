import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hookHelperSources } from '../src/runtime.js';

const helperDir = fs.mkdtempSync('/tmp/svall-procs-');
const helper = path.join(helperDir, 'svall-hook');
const children: ChildProcess[] = [];

beforeAll(() => { execFileSync('swiftc', ['-O', '-wmo', '-o', helper, ...hookHelperSources().filter((f) => f.endsWith('.swift'))]); }, 180_000);
afterAll(() => fs.rmSync(helperDir, { recursive: true, force: true }));
afterEach(() => { for (const c of children.splice(0)) c.kill('SIGKILL'); });

type Row = { pid: number; ppid: number; start: number; cpu: number; mem: number; resp?: number; path: string; args: string; char?: string; home?: string };
const procs = (): Row[] => JSON.parse(execFileSync(helper, ['procs'], { encoding: 'utf8' })).procs;
const child = (code: string): ChildProcess => {
  const c = spawn(process.execPath, ['-e', code], { stdio: 'ignore', env: { ...process.env, SVALL_CHAR_ID: 'c_probe', SVALL_HOME: '/tmp/svall-probe-home' } });
  children.push(c);
  return c;
};

describe('svall-hook procs', () => {
  it('lists a child with its env marks, its parent and its memory', async () => {
    const c = child('setInterval(()=>{},1000)');
    await new Promise((r) => setTimeout(r, 300));
    const row = procs().find((p) => p.pid === c.pid);
    expect(row).toBeDefined();
    expect(row!.char).toBe('c_probe');
    expect(row!.home).toBe('/tmp/svall-probe-home');
    expect(row!.ppid).toBe(process.pid);
    expect(row!.mem).toBeGreaterThan(0);
    expect(row!.cpu).toBeGreaterThanOrEqual(0);
    expect(row!.start).toBeGreaterThan(0);
    expect(row!.args).toContain('setInterval');
    expect(row!.path).toBe(fs.realpathSync(process.execPath));
  });

  it('reports CPU time in nanoseconds', async () => {
    const c = child('const t=Date.now();while(Date.now()-t<300);setInterval(()=>{},1000)');
    await new Promise((r) => setTimeout(r, 1000));
    const ps = execFileSync('ps', ['-o', 'time=', '-p', String(c.pid)], { encoding: 'utf8' }).trim();
    const [min, sec] = ps.split(':');
    const psNs = (Number(min) * 60 + Number(sec)) * 1e9;
    const row = procs().find((p) => p.pid === c.pid)!;
    expect(Math.abs(row.cpu - psNs)).toBeLessThan(50e6);
  });

  it('lists no process of another user', () => {
    expect(procs().some((p) => p.pid === 1)).toBe(false);
  });

  it('leaves the arguments and marks of apps out', (ctx) => {
    const app = procs().find((p) => p.path.includes('.app/'));
    if (!app) return ctx.skip('no app process of this user is running');
    expect(app.args).toBe('');
    expect(app.char).toBeUndefined();
    expect(app.home).toBeUndefined();
    expect(app.mem).toBeGreaterThan(0);
  });
});
