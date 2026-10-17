import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gatewayPaths } from '../../src/gateway/authority.js';
import { main, shutdown } from '../../src/gateway/bin.js';
import { silentLogger, type Logger } from '../../src/log.js';
import { waitFor } from '../helpers.js';

const dirs: string[] = [];
const held = process.env.SVALL_GATEWAY_PREFIX;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  if (held === undefined) delete process.env.SVALL_GATEWAY_PREFIX;
  else process.env.SVALL_GATEWAY_PREFIX = held;
});

const prefix = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-gateway-bin-'));
  dirs.push(dir);
  process.env.SVALL_GATEWAY_PREFIX = dir;
  return dir;
};

const collector = (): { codes: number[]; said: string[]; log: Logger } => {
  const codes: number[] = [];
  const said: string[] = [];
  return { codes, said, log: { info() {}, error: (m) => said.push(m) } };
};

describe('gateway main', () => {
  it('serves the socket under the prefix the environment names', async () => {
    const dir = prefix();
    const before = new Set(process.listeners('SIGTERM'));
    const server = await main(silentLogger);
    const stop = process.listeners('SIGTERM').find((l) => !before.has(l));
    try {
      expect(server.socketPath).toBe(gatewayPaths(dir).socket);
      expect(fs.existsSync(server.socketPath)).toBe(true);
      // a Unix socket and nothing else: the tailnet never reaches the authority
      expect(typeof server.address).toBe('string');
      expect(stop).toBeDefined();
    } finally {
      await server.close();
      if (stop) { process.off('SIGTERM', stop); process.off('SIGINT', stop); }
    }
  });
});

describe('gateway shutdown', () => {
  it('exits zero once the socket is closed', async () => {
    const { codes, log } = collector();
    shutdown({ close: () => Promise.resolve() }, (code) => codes.push(code), log)();
    await waitFor(() => codes.length === 1);
    expect(codes).toEqual([0]);
  });

  it('exits non-zero when the close fails rather than hanging', async () => {
    const { codes, said, log } = collector();
    shutdown({ close: () => Promise.reject(new Error('the socket would not close')) }, (code) => codes.push(code), log)();
    await waitFor(() => codes.length === 1);
    expect(codes).toEqual([1]);
    expect(said.join(' ')).toContain('the socket would not close');
  });
});
