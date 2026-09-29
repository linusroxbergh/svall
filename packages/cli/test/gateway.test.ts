import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetId, MachineId, type OwnerRecord } from '@svall/protocol';
import { gatewayPaths } from '@svall/svalld/gateway/authority';
import { startAuthorityServer, type AuthorityServer } from '@svall/svalld/gateway/server';
import { gatewayCommands } from '../src/commands/gateway.js';
import { waitFor } from '../../svalld/test/helpers.js';

const FLEET = FleetId.parse('3f1a0b1c-2d3e-4f50-8617-9a0b1c2d3e4f');
const OTHER_FLEET = FleetId.parse('7c2b0b1c-2d3e-4f50-8617-9a0b1c2d3e4f');
const MAC = MachineId.parse('42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f');
const TRIFT = MachineId.parse('9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f');

type Frame = { result: { record: OwnerRecord } } | { error: { code: string; message: string; data?: Record<string, unknown> } };

let prefix: string;
let held: string | undefined;
let server: AuthorityServer | undefined;

beforeEach(() => {
  prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-gateway-cli-'));
  held = process.env.SVALL_GATEWAY_PREFIX;
  process.env.SVALL_GATEWAY_PREFIX = prefix;
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (held === undefined) delete process.env.SVALL_GATEWAY_PREFIX;
  else process.env.SVALL_GATEWAY_PREFIX = held;
  fs.rmSync(prefix, { recursive: true, force: true });
});

const serve = async (): Promise<AuthorityServer> => {
  server = await startAuthorityServer({ prefix });
  return server;
};

/** One `svall gateway ...`, with the line it printed and the exit code it left behind. */
async function svall(...argv: string[]): Promise<{ frame: Frame; code: number }> {
  const out: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
  process.exitCode = 0;
  try {
    await gatewayCommands().parseAsync(argv, { from: 'user' });
  } finally {
    write.mockRestore();
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  const lines = out.join('').split('\n').filter(Boolean);
  expect(lines).toHaveLength(1);
  return { frame: JSON.parse(lines[0]) as Frame, code };
}

const created = (fleet: string = FLEET, owner: string = MAC): Promise<{ frame: Frame; code: number }> =>
  svall('owner', 'create', '--fleet', fleet, '--params', JSON.stringify({ initialOwnerMachineId: owner }));

describe('gateway owner', () => {
  it('creates the generation-zero record and prints it as one line', async () => {
    await serve();
    const { frame, code } = await created();
    expect(code).toBe(0);
    expect(frame).toEqual({ result: { record: { fleetId: FLEET, generation: 0, ownerMachineId: MAC } } });
    const file = path.join(gatewayPaths(prefix).fleets, `${FLEET}.json`);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ fleetId: FLEET, generation: 0, ownerMachineId: MAC });
  });

  it('answers get with the record the authority holds', async () => {
    await serve();
    await created();
    const { frame, code } = await svall('owner', 'get', '--fleet', FLEET);
    expect(code).toBe(0);
    expect(frame).toEqual({ result: { record: { fleetId: FLEET, generation: 0, ownerMachineId: MAC } } });
  });

  it('answers not_found for a fleet the authority holds no record for, and exits non-zero', async () => {
    await serve();
    const { frame, code } = await svall('owner', 'get', '--fleet', OTHER_FLEET);
    expect(code).not.toBe(0);
    expect(frame).toMatchObject({ error: { code: 'not_found' } });
  });

  it('forwards a transaction op so a handover can be driven over the same wrapper', async () => {
    await serve();
    await created();
    const { frame, code } = await svall('owner', 'begin', '--fleet', FLEET,
      '--params', JSON.stringify({ expectedGeneration: 0, fromMachineId: MAC, toMachineId: TRIFT }));
    expect(code).toBe(0);
    expect(frame).toMatchObject({ result: { record: { transaction: { fromMachineId: MAC, toMachineId: TRIFT, phase: 'preparing' } } } });
  });

  it('forwards a forced record, swapped against the record read, and audited on this machine', async () => {
    await serve();
    await created();
    const force = (expected: OwnerRecord | null) => svall('owner', 'force', '--fleet', FLEET, '--params', JSON.stringify({
      expected, ownerMachineId: TRIFT, generation: 3, requestingMachineId: MAC, reason: 'the Mac is gone', shown: [{ source: 'gateway record', generation: 0 }],
    }));
    const changed = await force(null);
    expect(changed.code).not.toBe(0);
    expect(changed.frame).toMatchObject({ error: { code: 'record_changed', data: { actual: { generation: 0, ownerMachineId: MAC } } } });

    const { frame, code } = await force({ fleetId: FLEET, generation: 0, ownerMachineId: MAC });
    expect(code).toBe(0);
    expect(frame).toEqual({ result: { record: { fleetId: FLEET, generation: 3, ownerMachineId: TRIFT } } });
    expect(fs.readFileSync(gatewayPaths(prefix).recoveries, 'utf8')).toContain('the Mac is gone');
  });

  it('passes the authority its own refusal of parameters it cannot act on', async () => {
    await serve();
    const { frame, code } = await svall('owner', 'create', '--fleet', FLEET, '--params', JSON.stringify({ initialOwnerMachineId: 'not-a-uuid' }));
    expect(code).not.toBe(0);
    expect(frame).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('refuses an operation the authority has no name for without reaching it', async () => {
    const { frame, code } = await svall('owner', 'seize', '--fleet', FLEET);
    expect(code).not.toBe(0);
    expect(frame).toMatchObject({ error: { code: 'invalid_request', message: expect.stringContaining('seize') } });
  });

  it('refuses --params that is not one JSON object', async () => {
    const { frame, code } = await svall('owner', 'get', '--fleet', FLEET, '--params', '[1]');
    expect(code).not.toBe(0);
    expect(frame).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('names the socket it could not reach when no gateway is listening', async () => {
    const { frame, code } = await svall('owner', 'get', '--fleet', FLEET);
    expect(code).not.toBe(0);
    expect(frame).toMatchObject({ error: { message: expect.stringContaining(gatewayPaths(prefix).socket) } });
  });
});

describe('gateway serve', () => {
  it('serves the authority and closes the socket when it is stopped', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const before = new Set(process.listeners('SIGTERM'));
    const exited: number[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { exited.push(code ?? 0); }) as never);
    try {
      await gatewayCommands().parseAsync(['serve'], { from: 'user' });
      const stop = process.listeners('SIGTERM').find((l) => !before.has(l));
      expect(stop).toBeDefined();
      const socket = gatewayPaths(prefix).socket;
      expect(fs.existsSync(socket)).toBe(true);

      const { frame } = await created();
      expect(frame).toMatchObject({ result: { record: { generation: 0 } } });

      (stop as () => void)();
      await waitFor(() => exited.length === 1);
      expect(exited).toEqual([0]);
      expect(fs.existsSync(socket)).toBe(false);
      process.off('SIGTERM', stop as () => void);
      process.off('SIGINT', stop as () => void);
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
    }
  });
});
