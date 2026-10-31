import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import setup, { LOCK_FLAGS, refusal, takeTmuxLock } from './tmux-lock.js';

const MODULE = path.join(import.meta.dirname, 'tmux-lock.ts');
const dirs: string[] = [];
const kids: ChildProcess[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const k of kids.splice(0)) k.kill('SIGKILL');
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function lockFile(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-tmux-lock-'));
  dirs.push(d);
  return path.join(d, 'lock');
}

async function waitFor(check: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error('waitFor: timed out');
    await sleep(20);
  }
}

/** A test run in a process of its own: it takes the lock, says `took`, and holds it until its stdin closes. */
function run(file: string) {
  const p = spawn(process.execPath, ['--input-type=module', '-e', `
    const { takeTmuxLock } = await import(${JSON.stringify(MODULE)});
    const release = await takeTmuxLock({ file: ${JSON.stringify(file)}, load: () => 0, pollMs: 20, log: (l) => console.log(l) });
    console.log('took');
    process.stdin.resume().on('end', release);
  `], { stdio: ['pipe', 'pipe', 'inherit'] });
  kids.push(p);
  let out = '';
  p.stdout!.on('data', (d) => (out += d));
  return { p, out: () => out, until: (s: string) => waitFor(() => out.includes(s)) };
}

test('lets one run hold it at a time, and names the holder to the run that waits', async () => {
  const file = lockFile();
  const a = run(file);
  await a.until('took');
  const b = run(file);
  await b.until(`held by pid ${a.p.pid} in ${process.cwd()} since `);
  await sleep(300);
  expect(b.out()).not.toContain('took');

  a.p.stdin!.end();
  await b.until('took');
});

test('passes to a waiting run once its holder is killed, though the file still names the dead holder', async () => {
  const file = lockFile();
  const a = run(file);
  await a.until('took');
  const b = run(file);
  await b.until('waiting for the tmux test lock');

  a.p.kill('SIGKILL');
  await b.until('took');
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).toBe(b.p.pid);
});

test('is taken once per process, as each vitest project takes it, and held until the last taker releases it', async () => {
  const file = lockFile();
  const first = await takeTmuxLock({ file, load: () => 0 });
  // a second open of its own would wait on the first forever
  const second = await takeTmuxLock({ file, load: () => 0 });

  first();
  expect(() => fs.openSync(file, LOCK_FLAGS)).toThrow(/EAGAIN/);
  second();
  fs.closeSync(fs.openSync(file, LOCK_FLAGS));
});

test('then waits while the 1-minute load is above the core count, saying why', async () => {
  const file = lockFile();
  const lines: string[] = [];
  const loads = [25.04, 19, 18];
  const release = await takeTmuxLock({ file, cores: 18, pollMs: 10, log: (l) => lines.push(l), load: () => loads.shift()! });

  expect(loads).toEqual([]);
  expect(lines).toEqual(['svall tests: waiting while the 1-minute load average, 25.0, is above the 18 cores']);
  release();
});

test('names the holder it waits on at most every 30 seconds', async () => {
  vi.useFakeTimers();
  const file = lockFile();
  const other = fs.openSync(file, LOCK_FLAGS);
  fs.writeSync(other, JSON.stringify({ pid: 4242, cwd: '/src/other-worktree', since: '15:00:00' }));
  const lines: string[] = [];
  const taking = takeTmuxLock({ file, load: () => 0, log: (l) => lines.push(l) });

  await vi.advanceTimersByTimeAsync(95_000);
  expect(lines).toEqual(Array(4).fill(
    'svall tests: waiting for the tmux test lock, held by pid 4242 in /src/other-worktree since 15:00:00 (SVALL_NO_TEST_LOCK=1 runs without it)',
  ));

  fs.closeSync(other);
  await vi.advanceTimersByTimeAsync(1000);
  (await taking)();
});

test('is skipped for a run started with SVALL_NO_TEST_LOCK=1', async () => {
  vi.stubEnv('SVALL_TMUX_ON_MAC', '1');
  vi.stubEnv('SVALL_NO_TEST_LOCK', '1');
  expect(await setup()).toBeUndefined();
});

test('refuses tmux-driven tests on a Mac unless SVALL_TMUX_ON_MAC=1 asks for them or the run is CI', () => {
  vi.stubEnv('CI', undefined);
  vi.stubEnv('SVALL_TMUX_ON_MAC', undefined);
  expect(refusal()).toMatch(/^svall tests: .*SVALL_TMUX_ON_MAC=1 runs them, and pnpm test --project '!\*-tmux' runs the rest$/);
  vi.stubEnv('SVALL_TMUX_ON_MAC', '1');
  expect(refusal()).toBeUndefined();
  vi.stubEnv('SVALL_TMUX_ON_MAC', undefined);
  vi.stubEnv('CI', 'true');
  expect(refusal()).toBeUndefined();
});

test('a refused run ends at once, saying why in one line', async () => {
  const env = { ...process.env };
  delete env.CI;
  delete env.SVALL_TMUX_ON_MAC;
  const p = spawn(process.execPath, ['--input-type=module', '-e', `await (await import(${JSON.stringify(MODULE)})).default();`], { env });
  kids.push(p);
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  const code = await new Promise((r) => p.on('exit', r));

  expect(code).toBe(1);
  expect(err.trim().split('\n')).toEqual([expect.stringMatching(/^svall tests: tmux-driven tests can hang/)]);
});
