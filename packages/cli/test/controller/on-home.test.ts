import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { resolvePaths } from '@svall/svalld/paths';
import { endsWithConnection } from '../../src/commands/host.js';
import { farHomeOf, relay, relayFor } from '../../src/controller/on-home.js';
import { MachineRegistry } from '../../src/controller/registry.js';

const HOME = crypto.randomUUID();
const dial = { homeMachineId: HOME, fleetId: crypto.randomUUID(), token: 'a'.repeat(48), homeName: 'studio', homeSsh: 'ada@studio', homeSocket: '/home/ada/.svall/w/0123456789ab.sock', homeSvallBase: '/home/ada/.local/share/svall' };

function fleet(worker?: object): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-on-home-'));
  if (worker) fs.writeFileSync(resolvePaths(home).workerFile, JSON.stringify(worker));
  return home;
}

function registry(): MachineRegistry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-on-home-reg-'));
  const r = MachineRegistry.load(dir, { hostname: 'ada-mac' });
  r.put(HOME as never, { name: 'studio', ssh: 'ada@studio', platform: 'linux', arch: 'arm64', home: '/home/ada', svallBase: dial.homeSvallBase });
  return r;
}

const home = { name: 'studio', ssh: 'ada@studio', svallBase: dial.homeSvallBase, fleetHome: '/home/ada/.svall' };

// what ssh gives the relay: the far stdout it writes, and how the far command ended
function far(lines: string[], ended: { code: number | null; signal?: string; stderr?: string }) {
  const argv: string[][] = [];
  let closed = 0;
  const open = () => Promise.resolve({
    stream: (a: string[]) => {
      argv.push(a);
      const stream = new PassThrough();
      setImmediate(() => { stream.end(lines.map((l) => `${l}\n`).join('')); });
      return { stream, exited: Promise.resolve({ signal: null, stderr: '', ...ended }) };
    },
    close: () => { closed++; return Promise.resolve(); },
  });
  return { open: open as never, argv, closed: () => closed };
}

const run = async (f: ReturnType<typeof far>, args = ['host', 'add', 'box', '--ssh', 'ada@box']) => {
  const out: string[] = [];
  const code = await relay(home, args, { open: f.open, line: (l) => out.push(l) });
  return { code, out, parsed: out.flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } }) };
};

describe('a host command on a fleet whose home is far', () => {
  it('a fleet with no worker.json, or one its home dials, runs here', () => {
    expect(farHomeOf(fleet())).toBeUndefined();
    expect(farHomeOf(fleet({ homeMachineId: HOME, fleetId: dial.fleetId, token: dial.token, homeName: 'ada-mac' }))).toBeUndefined();
  });

  it('a machine of that home goes there, and the home itself and this machine stay here', () => {
    const f = fleet(dial);
    const r = registry();
    expect(relayFor(f, r, 'box')?.ssh).toBe('ada@studio');
    expect(relayFor(f, r, undefined)?.fleetHome).toBe('/home/ada/.svall');
    expect(relayFor(f, r, 'studio')).toBeUndefined();
    expect(relayFor(f, r, HOME)).toBeUndefined();
    expect(relayFor(f, r, 'local')).toBeUndefined();
    expect(relayFor(f, r, r.localMachine().name)).toBeUndefined();
  });

  it('runs the fleet there by its folder, with the run tied to this connection, and lets go of the master', async () => {
    const f = far([], { code: 0 });
    await run(f);
    expect(f.argv[0].join(' ')).toContain('SVALL_HOME=/home/ada/.svall');
    expect(f.argv[0].slice(-7)).toEqual(['--json', "'host'", "'add'", "'box'", "'--ssh'", "'ada@box'", "'--relayed'"]);
    expect(f.closed()).toBe(1);
  });

  it('passes each line on as it came, what is to do on the machine going by way of the home, and the far exit code', async () => {
    const f = far([
      JSON.stringify({ step: 'os', status: 'ok', detail: 'Ubuntu 24.04' }),
      JSON.stringify({ step: 'tools', status: 'fail', action: 'ssh ada@box, then sudo apt install git', run: 'sudo apt install git' }),
      JSON.stringify({ result: 'actions', actions: ['ssh ada@box, then sudo apt install git', 'update svall on studio'], stopped: 'tools' }),
    ], { code: 1 });
    const { code, parsed } = await run(f);
    expect(code).toBe(1);
    expect(parsed[0]).toEqual({ step: 'os', status: 'ok', detail: 'Ubuntu 24.04' });
    expect(parsed[1].action).toBe('ssh studio, then ssh ada@box, then sudo apt install git');
    expect(parsed[1].run).toBe('sudo apt install git');
    expect(parsed[2].actions).toEqual(['ssh studio, then ssh ada@box, then sudo apt install git', 'update svall on studio']);
  });

  it('a connection that goes away mid-run ends on a failed step, and says the run stopped', async () => {
    const { code, parsed } = await run(far([JSON.stringify({ step: 'os', status: 'ok' })], { code: 255 }));
    expect(code).toBe(1);
    expect(parsed.find((p) => p.status === 'fail')).toMatchObject({ step: 'home', detail: 'the connection to studio went away; what it was doing stopped' });
    expect(parsed.at(-1)).toMatchObject({ result: 'actions', stopped: 'home' });
  });

  it('a relayed run stops as the connection that follows it goes', async () => {
    const stdin = new PassThrough();
    let stopped = 0;
    endsWithConnection(stdin, () => { stopped++; });
    stdin.write('nothing a run reads');
    await new Promise((r) => { setImmediate(r); });
    expect(stopped).toBe(0);
    stdin.end();
    await new Promise((r) => { setTimeout(r, 5); });
    expect(stopped).toBeGreaterThan(0);
  });

  it('a home that cannot be reached is a failed step too, and no throw', async () => {
    const out: string[] = [];
    const code = await relay(home, ['host', 'doctor', 'box'], { open: () => Promise.reject(new Error('no route')), line: (l) => out.push(l) });
    expect(code).toBe(1);
    expect(JSON.parse(out[0])).toMatchObject({ step: 'home', status: 'fail', detail: 'studio did not answer: no route' });
  });

  it('a far command that says nothing of itself is failed with what it wrote to stderr, and a home with no svall says so', async () => {
    const said = await run(far([], { code: 1, stderr: "error: unknown option '--relayed'" }));
    expect(said.parsed[0]).toMatchObject({ step: 'home', status: 'fail', detail: "svall host add there exited 1: error: unknown option '--relayed'" });
    const none = await run(far([], { code: 127 }));
    expect(none.parsed[0]).toMatchObject({ step: 'home', status: 'fail', detail: 'studio has no Svall at /home/ada/.local/share/svall/current/bin/svall' });
  });
});
