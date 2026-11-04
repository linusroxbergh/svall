import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProcess } from '../../src/link/process.js';
import { cleanHomes, makeHome } from '../helpers.js';

// a shell that leaves a sleep holding its stdout and stderr, as a far command does under a killed ssh
const leaves = (after: string) => {
  const pidFile = path.join(makeHome(), 'pid');
  return { argv: ['-c', `sleep 20 & echo $! > '${pidFile}'; ${after}`], pidFile };
};

describe('runProcess', () => {
  const left: string[] = [];
  afterEach(() => {
    for (const file of left.splice(0)) try { process.kill(Number(fs.readFileSync(file, 'utf8'))); } catch { /* already gone */ }
    cleanHomes();
  });

  it('answers once an aborted child is gone, though what it left holds its pipes', async () => {
    const { argv, pidFile } = leaves('wait');
    left.push(pidFile);
    const abort = new AbortController();
    const at = Date.now();
    const run = runProcess('sh', argv, { timeoutMs: 18_000, signal: abort.signal });
    await vi.waitFor(() => expect(fs.readFileSync(pidFile, 'utf8').trim()).toMatch(/^\d+$/), { timeout: 8000, interval: 25 });
    abort.abort();
    expect(await run).toMatchObject({ signal: 'SIGTERM' });
    expect(Date.now() - at).toBeLessThan(15_000);
  }, 25_000);

  it('answers at its timeout when the child has exited and what it left still holds its pipes', async () => {
    const { argv, pidFile } = leaves('exit 3');
    left.push(pidFile);
    const at = Date.now();
    expect(await runProcess('sh', argv, { timeoutMs: 1000 })).toMatchObject({ code: 3 });
    expect(Date.now() - at).toBeLessThan(15_000);
  }, 25_000);

  it('waits for its output as ever when nothing stopped it', async () => {
    expect(await runProcess('sh', ['-c', '(sleep 1; echo late) & exit 0'], { timeoutMs: 15_000 })).toMatchObject({ code: 0, stdout: 'late\n' });
  }, 25_000);
});
