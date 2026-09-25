import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/paths.js';
import { Tmux } from '../src/tmux/tmux.js';
import { cleanHomes, hasTmux, makeHome } from './helpers.js';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../../..');
const tsx = path.join(root, 'node_modules/.bin/tsx');
const bin = path.join(root, 'packages/archid/src/bin.ts');
const runIf = hasTmux() ? describe : describe.skip;

async function runBin(home: string): Promise<{ code: number; stderr: string }> {
  try {
    const { stderr } = await exec(tsx, [bin], { env: { ...process.env, ARCHI_HOME: home }, timeout: 30_000 });
    return { code: 0, stderr };
  } catch (e) {
    const err = e as { code: number; stderr: string };
    return { code: err.code, stderr: err.stderr };
  }
}

runIf('archid bin', () => {
  const homes: string[] = [];
  afterEach(async () => {
    for (const h of homes.splice(0)) { const p = resolvePaths(h); await new Tmux(p.tmuxSock, p.tmuxConf).killServer(); }
    cleanHomes();
  });

  it('exits non-zero and logs why when startup fails', async () => {
    const home = makeHome();
    homes.push(home);
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as net.AddressInfo).port;
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh', host: '127.0.0.1', port }));
    try {
      const r = await runBin(home);
      expect(r.code).toBe(1);
      expect(fs.readFileSync(resolvePaths(home).log, 'utf8')).toMatch(/archid failed to start: .*EADDRINUSE/);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  }, 40_000);
});
