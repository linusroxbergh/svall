import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Response } from '@svall/protocol';
import { InvalidConfig } from '../../src/config.js';
import { silentLogger } from '../../src/log.js';
import { startDaemon } from '../../src/main.js';
import { resolvePaths } from '../../src/paths.js';
import { Store } from '../../src/store.js';
import { Tmux } from '../../src/tmux/tmux.js';
import { isWorker, readWorkerFile, workerOptions } from '../../src/worker/mode.js';
import { cleanHomes, hasTmux, makeHome } from '../helpers.js';

const runIf = hasTmux() ? describe : describe.skip;

const workerFile = { homeMachineId: crypto.randomUUID(), fleetId: crypto.randomUUID(), token: 'a'.repeat(48), homeName: 'mac' };

// one call over the API, answered by its id
async function client(port: number, token: string): Promise<{ call(method: string, params?: unknown): Promise<Response>; close(): void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ token }));
  let next = 1;
  return {
    call: (method, params) => new Promise((resolve) => {
      const id = next++;
      ws.on('message', (raw) => { const m = JSON.parse(raw.toString()) as Response; if (m.id === id) resolve(m); });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => ws.close(),
  };
}

describe('worker.json', () => {
  afterEach(cleanHomes);

  it('makes a fleet home a worker\'s, and one missing or invalid is an InvalidConfig naming the file', () => {
    const paths = resolvePaths(makeHome());
    expect(isWorker(paths)).toBe(false);
    expect(() => readWorkerFile(paths)).toThrow(InvalidConfig);
    fs.writeFileSync(paths.workerFile, JSON.stringify({ ...workerFile, token: 'short' }));
    expect(isWorker(paths)).toBe(true);
    expect(() => readWorkerFile(paths)).toThrow(new RegExp(`${paths.workerFile}.*token`));
    fs.writeFileSync(paths.workerFile, JSON.stringify(workerFile));
    expect(workerOptions(paths)).toEqual({ worker: workerFile, off: ['mobile', 'push', 'usage', 'scribe', 'gateway', 'fleets'] });
  });
});

runIf('svalld --worker', () => {
  const homes: string[] = [];
  afterEach(async () => {
    for (const h of homes.splice(0)) { const p = resolvePaths(h); await new Tmux(p.tmuxSock, p.tmuxConf).killServer(); }
    cleanHomes();
  });

  it('a home with worker.json starts with scribe off, no mobile and no gateway, and still answers state.get', async () => {
    const home = makeHome();
    homes.push(home);
    const paths = resolvePaths(home);
    fs.writeFileSync(paths.workerFile, JSON.stringify(workerFile));
    // a gateway named in fleet.json is not asked, and leaves the fleet this daemon's to write
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh', gatewayMachineId: crypto.randomUUID() }));
    let asked = 0;
    const d = await startDaemon({ home, port: 0, worker: true, log: silentLogger, authority: { get: async () => { asked++; throw new Error('no gateway'); } } });
    const api = await client(d.port, d.token);
    try {
      expect(d.store.state.scribeOff).toBe(true);
      expect(Store.load(paths.state, () => {}).state.scribeOff).toBe(true);
      expect(await api.call('state.get')).toMatchObject({ result: { version: 11 } });
      expect(await api.call('mobile.get')).toMatchObject({ error: { code: 'not_on_worker', message: 'not on a worker' } });
      expect(await api.call('usage.get')).toMatchObject({ result: { available: false, windows: [] } });
      expect(await api.call('fleets.list')).toMatchObject({ error: { code: process.platform === 'darwin' ? 'not_on_worker' : 'forbidden' } });
      expect(await api.call('island.create', { name: 'x' })).toMatchObject({ result: { name: 'x' } });
      expect(asked).toBe(0);
    } finally {
      api.close();
      await d.stop();
    }
  });
});
