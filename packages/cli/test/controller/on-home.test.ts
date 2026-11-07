import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { resolvePaths } from '@svall/svalld/paths';
import { asksNoOne, endsWithConnection } from '../../src/commands/host.js';
import { byHome, farDocument, farHomeOf, relay, relayFor } from '../../src/controller/on-home.js';
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

const home = { name: 'studio', ssh: 'ada@studio', svallBase: dial.homeSvallBase, fleetHome: '/home/ada/.svall', machine: HOME, fleetId: dial.fleetId };

const AS_HOME = { machineId: HOME, release: '1.2.3', role: 'home', fleetId: dial.fleetId };

// what ssh gives the relay: who answers on the master first, the far stdout it writes, and how the far command ended
function far(lines: string[], ended: { code: number | null; signal?: string; stderr?: string }, o: { version?: object | string; exit?: { code: number | null; signal?: string | null; stderr?: string } } = {}) {
  const argv: string[][] = [];
  const asked: string[][] = [];
  let closed = 0;
  const open = () => Promise.resolve({
    run: (a: string[]) => {
      asked.push(a);
      return Promise.resolve({ code: 0, signal: null, stderr: '', stdout: typeof o.version === 'string' ? o.version : JSON.stringify(o.version ?? AS_HOME), ...o.exit });
    },
    stream: (a: string[]) => {
      argv.push(a);
      const stream = new PassThrough();
      setImmediate(() => { stream.end(lines.map((l) => `${l}\n`).join('')); });
      return { stream, exited: Promise.resolve({ signal: null, stderr: '', ...ended }) };
    },
    close: () => { closed++; return Promise.resolve(); },
  });
  return { open: open as never, argv, asked, closed: () => closed };
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
    expect(parsed[1].action).toBe('ssh ada@studio, then ssh ada@box, then sudo apt install git');
    expect(parsed[1].run).toBe('sudo apt install git');
    expect(parsed[2].actions).toEqual(['ssh ada@studio, then ssh ada@box, then sudo apt install git', 'update svall on studio']);
  });

  it('a connection that goes away mid-run ends on a failed step, and says the run stopped', async () => {
    const { code, parsed } = await run(far([JSON.stringify({ step: 'os', status: 'ok' })], { code: 255 }));
    expect(code).toBe(1);
    expect(parsed.find((p) => p.status === 'fail')).toMatchObject({ step: 'relay', detail: 'the connection to studio went away; what it was doing may still finish there' });
    expect(parsed.at(-1)).toMatchObject({ result: 'actions', stopped: 'relay' });
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

  it('a stream that closes early, as ssh\'s stdin does once the far command has ended, leaves the far exit code to say', async () => {
    const open = () => Promise.resolve({
      run: () => Promise.resolve({ code: 0, signal: null, stderr: '', stdout: JSON.stringify(AS_HOME) }),
      stream: () => {
        const stream = new PassThrough();
        setImmediate(() => { stream.write('{"step":"os","status":"ok"}\n'); setImmediate(() => stream.destroy(new Error('Premature close'))); });
        return { stream, exited: Promise.resolve({ code: 0, signal: null, stderr: '' }) };
      },
      close: () => Promise.resolve(),
    });
    const out: string[] = [];
    expect(await relay(home, ['host', 'list'], { open: open as never, line: (l) => out.push(l) })).toBe(0);
    expect(out).toEqual(['{"step":"os","status":"ok"}']);
  });

  it('watching the connection does not keep a finished run alive', () => {
    const stdin = Object.assign(new PassThrough(), { unref: vi.fn() });
    endsWithConnection(stdin, () => {});
    expect(stdin.unref).toHaveBeenCalled();
  });

  it('a home that cannot be reached is a failed step too, and no throw', async () => {
    const out: string[] = [];
    const code = await relay(home, ['host', 'doctor', 'box'], { open: () => Promise.reject(new Error('no route')), line: (l) => out.push(l) });
    expect(code).toBe(1);
    expect(JSON.parse(out[0])).toMatchObject({ step: 'relay', status: 'fail', detail: 'studio did not answer: no route' });
  });

  it('a far command that says nothing of itself is failed with what it wrote to stderr, and a home with no svall says so', async () => {
    const said = await run(far([], { code: 1, stderr: "error: unknown option '--relayed'" }));
    expect(said.parsed[0]).toMatchObject({ step: 'relay', status: 'fail', detail: "svall host add there exited 1: error: unknown option '--relayed'" });
    const none = await run(far([], { code: 127 }));
    expect(none.parsed[0]).toMatchObject({ step: 'relay', status: 'fail', detail: 'studio has no Svall at /home/ada/.local/share/svall/current/bin/svall' });
  });

  it('a relayed run asks no one at this machine\'s screen, as a server\'s run with no terminal has no one to ask', () => {
    expect(asksNoOne({ relayed: true, platform: 'darwin', tty: false })).toBe(true);
    expect(asksNoOne({ relayed: false, platform: 'linux', tty: false })).toBe(true);
    expect(asksNoOne({ relayed: false, platform: 'darwin', tty: false })).toBe(false);
    expect(asksNoOne({ relayed: false, platform: 'linux', tty: true })).toBe(false);
  });

  describe('who answers on the master', () => {
    it('asks before any command, of the fleet there by its folder', async () => {
      const f = far([], { code: 0 });
      await run(f);
      expect(f.asked[0]).toEqual(['env', `'SVALL_HOME=/home/ada/.svall'`, `'${dial.homeSvallBase}/current/bin/svall'`, 'version', '--json']);
      expect(f.argv).toHaveLength(1);
    });

    it.each([
      ['another machine', { ...AS_HOME, machineId: crypto.randomUUID() }, 'ada@studio reaches another machine than studio'],
      ['another fleet in that folder', { ...AS_HOME, fleetId: crypto.randomUUID() }, "studio is not this fleet's home"],
      ['a worker of this fleet, which a machine a move left is', { machineId: HOME, release: '1.2.3', role: 'worker', worker: { fleetId: dial.fleetId } }, "studio is not this fleet's home"],
    ])('%s runs nothing, and ends on the relay step', async (_what, version, detail) => {
      const f = far(['{"step":"ssh","status":"ok"}'], { code: 0 }, { version });
      const r = await run(f);
      expect(f.argv).toEqual([]);
      expect(r.code).toBe(1);
      expect(r.parsed[0]).toMatchObject({ step: 'relay', status: 'fail', detail });
      expect(f.closed()).toBe(1);
    });

    it('one that does not answer is a failed step, and runs nothing', async () => {
      const f = far([], { code: 0 }, { exit: { code: 255, stderr: 'Connection closed', stdout: '' } as never });
      const r = await run(f);
      expect(f.argv).toEqual([]);
      expect(r.parsed[0]).toMatchObject({ step: 'relay', status: 'fail', detail: expect.stringContaining('studio did not answer') });
    });

    it('reads it past what a login shell says first', async () => {
      const f = far([], { code: 0 }, { version: `motd\n${JSON.stringify(AS_HOME, null, 2)}` });
      expect((await run(f)).code).toBe(0);
      expect(f.argv).toHaveLength(1);
    });
  });

  it('a login shell\'s lines ahead of the command\'s go nowhere, and a document past them reads whole', async () => {
    const f = far(['welcome to studio', 'last login: today', '[', '  {"name": "box"}', ']'], { code: 0 });
    const r = await run(f, ['host', 'list']);
    expect(r.out).toEqual(['[', '  {"name": "box"}', ']']);
    expect(farDocument(`noise\n${r.out.join('\n')}\n`)).toEqual([{ name: 'box' }]);
  });

  it('a far death past a step that went well says why, by stderr\'s end', async () => {
    const r = await run(far(['{"step":"ssh","status":"ok"}'], { code: 1, stderr: 'svall: unknown option --relayed\n' }));
    expect(r.code).toBe(1);
    expect(r.parsed.at(-2)).toMatchObject({ step: 'relay', status: 'fail', detail: expect.stringContaining('unknown option --relayed') });
  });

  it.each([
    ['a failed step', ['{"step":"ssh","status":"fail","detail":"no"}', '{"result":"actions","actions":["x"]}']],
    ['a report', ['{', '  "checks": []', '}']],
  ])('a far run that ended on %s adds nothing, and keeps its exit', async (_what, lines) => {
    const r = await run(far(lines, { code: 1, stderr: 'ignored' }));
    expect(r.code).toBe(1);
    expect(r.out.some((l) => l.includes('"relay"'))).toBe(false);
    expect(r.out).toHaveLength(lines.length);
  });

  it('a signal, or a far exit of its own, is read as such', async () => {
    expect((await run(far([], { code: null, signal: 'SIGTERM' }))).parsed[0]).toMatchObject({ detail: expect.stringContaining('went away; what it was doing may still finish there') });
    expect((await run(far([], { code: 126 }))).parsed[0]).toMatchObject({ detail: expect.stringContaining('has no Svall at') });
    expect((await run(far(['{"step":"x","status":"fail"}'], { code: 7 }))).code).toBe(7);
  });

  it('what is to do on the machine goes through the home by its route, not its name', () => {
    expect(byHome(home, 'ssh ada@box, then codex login')).toBe('ssh ada@studio, then ssh ada@box, then codex login');
    expect(byHome(home, 'upgrade it under Machines')).toBe('upgrade it under Machines');
  });

  it('a fleet whose worker.json cannot be read relays nothing, and leaves the words to what says them', () => {
    const f = fleet();
    fs.writeFileSync(resolvePaths(f).workerFile, '{ not json');
    expect(farHomeOf(f)).toBeUndefined();
    expect(relayFor(f, registry(), 'box')).toBeUndefined();
  });

  it('a machine named by its id goes to the home, whatever this registry calls another', () => {
    const f = fleet(dial);
    const far_ = crypto.randomUUID();
    expect(relayFor(f, registry(), far_)?.name).toBe('studio');
    expect(relayFor(f, registry(), HOME)).toBeUndefined();
  });

  describe('a companion of another architecture', () => {
    const NONE = '{"step":"release","status":"fail","detail":"this build publishes no companion for linux-arm64; name one with --release <archive>"}';
    const LEFT = '{"result":"actions","actions":["x"],"stopped":"release"}';
    const archive = () => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'svall-carried-')), 'svall-1.2.3-linux-arm64.tar.gz');
      fs.writeFileSync(file, 'the archive');
      return file;
    };
    // a home that lacks it on the first run, and runs on with it on the next
    function asking() {
      const argv: string[][] = [];
      const wrote: { argv: string[]; input?: unknown }[] = [];
      const open = () => Promise.resolve({
        run: (a: string[], o: { input?: unknown } = {}) => {
          if (a.includes('version')) return Promise.resolve({ code: 0, signal: null, stderr: '', stdout: JSON.stringify(AS_HOME) });
          wrote.push({ argv: a, input: o.input });
          return Promise.resolve({ code: 0, signal: null, stderr: '', stdout: '' });
        },
        stream: (a: string[]) => {
          argv.push(a);
          const stream = new PassThrough();
          const second = argv.length > 1;
          setImmediate(() => { stream.end(`${(second ? ['{"step":"release","status":"ok"}', '{"result":"ready"}'] : [NONE, LEFT]).join('\n')}\n`); });
          return { stream, exited: Promise.resolve({ signal: null, stderr: '', code: second ? 0 : 1 }) };
        },
        close: () => Promise.resolve(),
      });
      return { open: open as never, argv, wrote };
    }

    it('copies the archive this CLI carries of the home\'s release, and runs again with it, hiding the first try', async () => {
      const f = asking();
      const file = archive();
      const out: string[] = [];
      const seen: string[][] = [];
      const code = await relay(home, ['host', 'add', 'box', '--ssh', 'ada@box'], { open: f.open, line: (l) => out.push(l), carried: (platform, release) => { seen.push([platform, release]); return file; } });
      const remote = `/home/ada/.svall/cache/carried/${path.basename(file)}`;
      expect(code).toBe(0);
      expect(seen).toEqual([['linux-arm64', '1.2.3']]);
      expect(out).toEqual(['{"step":"release","status":"ok"}', '{"result":"ready"}']);
      expect(f.wrote.at(-1)).toMatchObject({ argv: ['sh', '-c', expect.any(String), '--', `'${remote}'`] });
      expect(String(f.wrote.at(-1)?.input)).toBe('the archive');
      expect(f.argv[1].slice(-4)).toEqual(["'ada@box'", "'--release'", `'${remote}'`, "'--relayed'"]);
    });

    it('a CLI that carries none leaves the home\'s refusal, naming --release', async () => {
      const f = asking();
      const out: string[] = [];
      const code = await relay(home, ['host', 'add', 'box', '--ssh', 'ada@box'], { open: f.open, line: (l) => out.push(l), carried: () => undefined });
      expect(code).toBe(1);
      expect(f.argv).toHaveLength(1);
      expect(out.join('\n')).toContain('name one with --release <archive>');
    });
  });
});
