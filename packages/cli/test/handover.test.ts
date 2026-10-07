import { execFile, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { emptyState, FleetId, MachineId, PROTOCOL_VERSION, type Blocker, type HandoverChoices, type HandoverEvent, type HandoverPhase, type Outcome, type OwnerRecord, type Verdict } from '@svall/protocol';
import { handoverCommand, launchHelper, parseDuration, runAttach, runForget, runHandover, runStatus, spawnHelper, type CliDeps, type Job, type Transaction } from '../src/commands/handover.js';
import { View } from '../src/commands/handover-view.js';
import { connectHelper, helperPaths, HelperServer, Live, probe, type Control } from '../src/controller/helper.js';
import type { ControllerJournal, Observation } from '../src/controller/recovery.js';
import { MachineRegistry } from '../src/controller/registry.js';
import { rememberOwner } from '../src/controller/route.js';
import { installFakeSsh } from './controller/fake-ssh.js';
import { cleanHomes, makeHome, waitFor } from '../../svalld/test/helpers.js';

const TOKEN = 'daemon-t0ken-never-written';
const changed = (phase: HandoverPhase): HandoverEvent => ({ event: 'handover.changed', data: { transactionId: 'tx-1', phase } });
const lines = (text: string): unknown[] => text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const mode = (p: string): number => fs.statSync(p).mode & 0o777;

/** A socket file nobody listens on, as a helper that was killed leaves behind. */
function staleSocket(at: string): void {
  const r = spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(at)}, () => process.kill(process.pid, 'SIGKILL'))`]);
  expect(r.signal).toBe('SIGKILL');
  expect(fs.lstatSync(at).isSocket()).toBe(true);
}

const servers: HelperServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
  cleanHomes();
});

async function open(home: string, tmp = makeHome()): Promise<HelperServer> {
  const s = await HelperServer.open(helperPaths(home, tmp), { scrub: (line) => line.split(TOKEN).join('[redacted]') });
  servers.push(s);
  return s;
}

/** A client of the helper, collecting what it is sent until the helper closes it. */
function client(home: string, tmp: string): { got: string[]; closed: Promise<void>; send(c: unknown): void; end(): void } {
  const got: string[] = [];
  let buf = '';
  const socket = net.connect(helperPaths(home, tmp).socket);
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    got.push(...parts);
  });
  const closed = new Promise<void>((r) => socket.on('close', () => r()));
  return { got, closed, send: (c) => socket.write(`${typeof c === 'string' ? c : JSON.stringify(c)}\n`), end: () => socket.end() };
}

describe('the helper', () => {
  it('keeps its socket beside the journal, or under a private temp folder when that path is too long for a socket', async () => {
    const home = makeHome();
    const tmp = makeHome();
    expect(helperPaths(home, tmp).socket).toBe(path.join(home, 'controller', 'handover.sock'));
    const s = await open(home, tmp);
    expect(mode(path.join(home, 'controller'))).toBe(0o700);
    expect(mode(helperPaths(home, tmp).socket)).toBe(0o600);
    await s.close();

    const long = path.join(makeHome(), 'x'.repeat(90));
    fs.mkdirSync(long);
    const far = helperPaths(long, tmp).socket;
    expect(path.dirname(path.dirname(far))).toBe(tmp);
    expect(Buffer.byteLength(far)).toBeLessThanOrEqual(103);
    expect(helperPaths(long, tmp).socket).toBe(far);
    await open(long, tmp);
    expect(mode(path.dirname(far))).toBe(0o700);
    expect(mode(far)).toBe(0o600);
    expect(await probe(far)).toBe('live');
  });

  it('is the one controller of its fleet: a live helper refuses another, and a socket nobody answers is taken over', async () => {
    const home = makeHome();
    const tmp = makeHome();
    const first = await open(home, tmp);
    const refused = await open(home, tmp).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Live);
    expect((refused as Live).pid).toBe(process.pid);
    expect((refused as Error).message).toContain('svall handover attach');
    await first.close();
    expect(fs.existsSync(helperPaths(home, tmp).socket)).toBe(false);
    expect(await probe(helperPaths(home, tmp).socket)).toBe('none');

    staleSocket(helperPaths(home, tmp).socket);
    expect(await probe(helperPaths(home, tmp).socket)).toBe('stale');
    await open(home, tmp);
    expect(await probe(helperPaths(home, tmp).socket)).toBe('live');
  });

  it('writes every event it records, scrubbed of the tokens it holds, to a 0600 events file each new run starts afresh', async () => {
    const home = makeHome();
    const tmp = makeHome();
    const paths = helperPaths(home, tmp);
    const first = await open(home, tmp);
    first.record(changed('begin'));
    first.record({ event: 'handover.retry', data: { phase: 'freeze', attempt: 1, error: `ws://x?token=${TOKEN} did not answer` } });
    expect(mode(paths.events)).toBe(0o600);
    const text = fs.readFileSync(paths.events, 'utf8');
    expect(text).not.toContain(TOKEN);
    expect(lines(text)).toEqual([changed('begin'), { event: 'handover.retry', data: { phase: 'freeze', attempt: 1, error: 'ws://x?token=[redacted] did not answer' } }]);
    expect(fs.readFileSync(paths.lock, 'utf8').trim()).toBe(String(process.pid));
    await first.close();
    expect(fs.existsSync(paths.lock)).toBe(false);
    expect(lines(fs.readFileSync(paths.events, 'utf8'))).toHaveLength(2);

    const second = await open(home, tmp);
    second.record(changed('freeze'));
    expect(lines(fs.readFileSync(paths.events, 'utf8'))).toEqual([changed('freeze')]);
  });

  it('replays the run so far to every client, streams the rest, and lets them go once the run is over', async () => {
    const home = makeHome();
    const tmp = makeHome();
    const s = await open(home, tmp);
    s.record(changed('begin'));
    const a = client(home, tmp);
    await waitFor(() => a.got.length === 1);
    s.record(changed('freeze'));
    const b = client(home, tmp);
    await waitFor(() => a.got.length === 2 && b.got.length === 2);
    const result: HandoverEvent = { event: 'handover.result', data: { status: 'aborted', transactionId: 'tx-1', phase: 'freeze' } };
    s.record(result);
    await s.close();
    await Promise.all([a.closed, b.closed]);
    for (const c of [a, b]) expect(c.got.map((l) => JSON.parse(l))).toEqual([changed('begin'), changed('freeze'), result]);
    expect(fs.existsSync(helperPaths(home, tmp).socket)).toBe(false);
  });

  it('hands on what a client chooses or cancels, ignores whatever else it sends, and can let one client go alone', async () => {
    const home = makeHome();
    const tmp = makeHome();
    const s = await open(home, tmp);
    const heard: Control[] = [];
    s.onControl((c, from) => {
      heard.push(c);
      if ('cancel' in c) s.release(from, { event: 'handover.result', data: { status: 'detached', transactionId: 'tx-1' } });
    });
    const a = client(home, tmp);
    const b = client(home, tmp);
    a.send('not json');
    a.send({ choose: { interruptAfterMs: 'soon' } });
    a.send({ hello: true });
    a.send({ choose: { interruptAfterMs: 0, terminateShells: ['c_ada'] } });
    await waitFor(() => heard.length === 1);
    b.send({ cancel: true });
    await b.closed;
    expect(heard).toEqual([{ choose: { interruptAfterMs: 0, terminateShells: ['c_ada'] } }, { cancel: true }]);
    expect(b.got.map((l) => JSON.parse(l))).toEqual([{ event: 'handover.result', data: { status: 'detached', transactionId: 'tx-1' } }]);
    s.record(changed('transfer'));
    await waitFor(() => a.got.length === 1);
    a.end();
  });

  it('reaches a live helper as a client that relays its lines, and ends when the helper lets go', async () => {
    const home = makeHome();
    const tmp = makeHome();
    const s = await open(home, tmp);
    s.record(changed('begin'));
    const heard: Control[] = [];
    s.onControl((c) => heard.push(c));
    const got: string[] = [];
    const c = await connectHelper(helperPaths(home, tmp).socket, (line) => got.push(line));
    await waitFor(() => got.length === 1);
    c.send('{"cancel":true}');
    await waitFor(() => heard.length === 1);
    s.record({ event: 'handover.result', data: { status: 'aborted', transactionId: 'tx-1', phase: 'begin' } });
    await s.close();
    await c.closed;
    expect(got.map((l) => JSON.parse(l).event)).toEqual(['handover.changed', 'handover.result']);
    await expect(connectHelper(helperPaths(home, tmp).socket, () => undefined)).rejects.toThrow();
  });
});

// ---- the commands, driven through a transaction that is scripted rather than run ----

const FLEET = FleetId.parse('11111111-2222-3333-4444-555555555555');
const TRIFT = MachineId.parse('66666666-7777-8888-9999-aaaaaaaaaaaa');
const NONE: Verdict = { standing: 'none', journals: {}, safe: [], action: 'none', reason: 'no handover of this fleet is open anywhere' };

type Kind = 'start' | 'resume' | 'abort';

/** A transaction whose steps a test writes: what it records, what it asks, and how it ends. */
class FakeTx {
  record!: (e: HandoverEvent) => void;
  decide!: (b: Blocker[], phase: HandoverPhase) => Promise<HandoverChoices | 'cancel'>;
  calls: { kind: Kind; to?: string; choices?: HandoverChoices }[] = [];
  chosen: HandoverChoices[] = [];
  cancelled = 0;
  closed = false;
  owned: OwnerRecord;
  verdict: Verdict = NONE;
  observation: Observation;
  finished?: Promise<Outcome>;
  onCancel?: () => void;
  /** what status() waits on first, and what it fails with */
  statusGate?: Promise<void>;
  statusError?: Error;
  script: (kind: Kind, n: number) => Promise<Outcome> = async () => ({ status: 'complete', transactionId: 'tx-1', generation: 5, characters: [] });

  constructor(local: MachineId) {
    this.owned = { fleetId: FLEET, generation: 4, ownerMachineId: local };
    this.observation = { gateway: { ok: true, value: this.owned } };
  }

  private run(kind: Kind, to?: string, choices?: HandoverChoices): Promise<Outcome> {
    this.calls.push({ kind, ...(to && { to }), ...(choices && { choices }) });
    const out = this.script(kind, this.calls.length);
    this.finished ??= out;
    return out;
  }

  get api(): Transaction {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const tx = this;
    return {
      handover: {
        start: (to, choices) => tx.run('start', to, choices),
        resume: () => tx.run('resume'),
        abort: () => tx.run('abort'),
        status: async () => {
          await tx.statusGate;
          if (tx.statusError) throw tx.statusError;
          return { observation: tx.observation, verdict: tx.verdict };
        },
        choose: (c) => { tx.chosen.push(c); },
        cancel: () => { tx.cancelled++; tx.onCancel?.(); },
        get finished() { return tx.finished; },
      },
      secrets: () => [TOKEN],
      close: async () => { tx.closed = true; },
    };
  }
}

type Harness = ReturnType<typeof harness>;

function harness(o: { json?: boolean; tty?: boolean; profile?: string; gateway?: boolean } = {}) {
  const home = makeHome();
  const tmp = makeHome();
  fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET, ...(o.gateway === false ? {} : { gatewayMachineId: TRIFT }) }));
  const registry = MachineRegistry.load(path.join(tmp, 'config'));
  registry.add({
    name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
    home: '/home/ada', svallBase: '/home/ada/.local/share/svall', gateway: true,
  }, TRIFT);
  const stdin = Object.assign(new PassThrough(), { isTTY: o.tty });
  const out: string[] = [];
  const err: string[] = [];
  const signals = new EventEmitter();
  const tx = new FakeTx(registry.localId);
  let connects = 0;
  const launched: { args: string[]; log: number }[] = [];
  const deps: CliDeps = {
    connect: (c) => { connects++; tx.record = c.record; tx.decide = c.decide; return tx.api; },
    registry: () => registry,
    stdin, stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, signals,
    launch: (args, log) => { launched.push({ args, log }); throw new Error('no launcher in this test'); },
    argv: () => ['handover', 'trift', '--json', '--detach'],
    tmpdir: tmp,
  };
  const ctx = { fleetHome: home, profile: o.profile, json: o.json ?? false, deps };
  return {
    home, tmp, registry, stdin, signals, tx, ctx, deps, launched,
    paths: helperPaths(home, tmp),
    out: () => out.join(''),
    err: () => err.join(''),
    events: () => lines(out.join('')) as HandoverEvent[],
    connects: () => connects,
    type: (line: string) => { stdin.write(`${line}\n`); },
  };
}

const start = (to = 'trift', choices: HandoverChoices = {}): Job => ({ kind: 'start', to, choices });
const pre = (blockers: Blocker[] = [], warnings: Blocker[] = []): HandoverEvent => ({
  event: 'handover.preflight',
  data: {
    summary: { digest: 'a'.repeat(64), roots: 2, files: 5, bytes: 2048, sessions: 1 }, blockers, warnings,
    names: { characters: { c_ada: 'ada', c_bo: 'bo' }, roots: { r_app: '/home/ada/app', r_git: '/home/ada/app.git' }, sessions: { s0: 'ada' } },
  },
});
const forever = <T>(): Promise<T> => new Promise<T>(() => undefined);

describe('svall handover', () => {
  it('hands the fleet over in the foreground: with --json, one event per line and nothing else, ending with its result', async () => {
    const h = harness({ json: true });
    h.tx.script = async () => {
      h.tx.record(pre());
      h.tx.record(changed('begin'));
      h.tx.record({ event: 'handover.entity', data: { transactionId: 'tx-1', kind: 'character', id: 'c_ada', phase: 'freeze' } });
      h.tx.record({ event: 'handover.retry', data: { phase: 'transfer', attempt: 1, error: `token ${TOKEN} refused` } });
      // the transaction's own result is the command's to write, once
      h.tx.record({ event: 'handover.result', data: { status: 'complete', transactionId: 'tx-1', generation: 5, characters: [] } });
      return { status: 'complete', transactionId: 'tx-1', generation: 5, characters: [{ id: 'c_ada', ok: true }] };
    };
    expect(await runHandover(start(), h.ctx)).toEqual({ code: 0 });
    const events = h.events();
    expect(events.map((e) => e.event)).toEqual(['handover.preflight', 'handover.changed', 'handover.entity', 'handover.retry', 'handover.result']);
    expect(events.at(-1)).toEqual({ event: 'handover.result', data: { status: 'complete', transactionId: 'tx-1', generation: 5, characters: [{ id: 'c_ada', ok: true }] } });
    expect(h.out()).not.toContain(TOKEN);
    expect(h.tx.calls).toEqual([{ kind: 'start', to: TRIFT, choices: {} }]);
    expect(fs.readFileSync(h.paths.events, 'utf8')).toBe(h.out());
    expect(h.tx.closed).toBe(true);
    expect(await probe(h.paths.socket)).toBe('none');
  });

  it('runs on through its journals, writing no more, once the reader of its --json lines has gone', async () => {
    const h = harness({ json: true });
    let writes = 0;
    const stdout = new Writable({
      write: (_chunk, _encoding, done) => { writes++; done(Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' })); },
    });
    const next = () => new Promise((r) => { setImmediate(r); });
    h.tx.script = async () => {
      h.tx.record(pre());
      await next();
      h.tx.record(changed('begin'));
      await next();
      h.tx.record(changed('freeze'));
      await next();
      return { status: 'complete', transactionId: 'tx-1', generation: 5, characters: [] };
    };

    expect(await runHandover(start(), { ...h.ctx, deps: { ...h.deps, stdout } })).toEqual({ code: 0 });
    expect(writes).toBe(1);
    expect((lines(fs.readFileSync(h.paths.events, 'utf8')) as HandoverEvent[]).map((e) => e.event))
      .toEqual(['handover.preflight', 'handover.changed', 'handover.changed', 'handover.result']);
    expect(h.tx.closed).toBe(true);
  });

  it('takes local as this machine, and leaves a machine that already owns the fleet to the controller\'s preflight', async () => {
    const h = harness({ json: true });
    expect(await runHandover(start('local'), h.ctx)).toEqual({ code: 0 });
    expect(h.tx.calls).toEqual([{ kind: 'start', to: h.registry.localId, choices: {} }]);

    const again = harness({ json: true });
    const refused: Outcome = { status: 'blocked', phase: 'begin', blockers: [{ code: 'identity_mismatch', message: 'trift already runs this fleet' }] };
    again.tx.script = async () => refused;
    expect(await runHandover(start('trift'), again.ctx)).toEqual({ code: 1 });
    expect(again.tx.calls).toEqual([{ kind: 'start', to: TRIFT, choices: {} }]);
    expect(again.events()).toEqual([{ event: 'handover.result', data: refused }]);
  });

  it('refuses a fleet with no gateway before anything else, naming the command that gives it one', async () => {
    const h = harness({ gateway: false, profile: 'lab' });
    expect(await runHandover(start(), h.ctx)).toEqual({ code: 1 });
    expect(h.out()).toContain('svall host enable <host> --fleet lab');
    expect(h.connects()).toBe(0);
    expect(fs.existsSync(h.paths.dir)).toBe(false);
    expect(await runHandover({ kind: 'resume' }, harness({ gateway: false, json: true }).ctx)).toEqual({ code: 1 });

    // a helper has no stdout: why it stopped before it listened is in its log, which the launcher names
    const helper = harness({ gateway: false });
    expect(await runHandover(start(), { ...helper.ctx, helper: true })).toEqual({ code: 1 });
    expect(helper.out()).toBe('');
    expect(helper.err()).toContain('svall host enable <host> --fleet');
  });

  it('prints each blocker before Begin with what it names, and the warnings, and exits 1 without asking when no one can answer', async () => {
    for (const o of [{ tty: false }, { tty: true, json: true }]) {
      const h = harness(o);
      const blockers: Blocker[] = [
        { code: 'transcript_missing', message: '/Users/ada/.claude/projects/-app/3f2b.jsonl is not there', entity: { kind: 'character', id: 'c_ada' } },
        { code: 'incompatible_adapter', message: "a handover carries claude sessions from 2.1.251 on; update the destination's claude 2.1.200", entity: { kind: 'character', id: 'c_bo' } },
        { code: 'destination_diverged', message: 'the destination changed while this machine did not own the fleet', entity: { kind: 'root', id: 'r_app' } },
        { code: 'shell_busy', message: "bo's terminal is running npm run dev", entity: { kind: 'character', id: 'c_bo' } },
      ];
      const warnings: Blocker[] = [
        { code: 'config_difference', message: 'claude 2.1.280 runs on mac and 2.1.290 on trift' },
        { code: 'codex_trust', message: 'Codex asks whether to trust its folder', entity: { kind: 'character', id: 'c_bo' } },
        { code: 'platform_heuristic', message: '/Users/ada/app holds an Xcode project, which does not build on linux', entity: { kind: 'root', id: 'r_app' } },
      ];
      h.tx.script = async () => { h.tx.record(pre(blockers, warnings)); return { status: 'blocked', phase: 'begin', blockers }; };
      expect(await runHandover(start(), h.ctx)).toEqual({ code: 1 });
      expect(h.tx.calls).toHaveLength(1);
      if (o.json) {
        expect(h.events().map((e) => e.event)).toEqual(['handover.preflight', 'handover.result']);
        continue;
      }
      const text = h.out();
      expect(text).toContain('ada: /Users/ada/.claude/projects/-app/3f2b.jsonl is not there');
      expect(text).toContain("bo: a handover carries claude sessions from 2.1.251 on; update the destination's claude 2.1.200");
      expect(text).toContain('/home/ada/app: the destination changed');
      expect(text).toContain("bo's terminal is running npm run dev");
      expect(text).not.toContain('bo: bo');
      for (const w of ['2.1.290 on trift', 'Codex asks whether to trust', 'an Xcode project']) expect(text).toContain(w);
      expect(text).toContain('--terminate-shells');
      expect(text).toContain('--archive /home/ada/app');
      expect(text).not.toMatch(/Choose/);
    }
  });

  it('never waits on a blocker after Begin without a person or a helper to answer it: the answer is cancel', async () => {
    for (const o of [{ tty: false }, { tty: true, json: true }]) {
      const h = harness(o);
      const working: Blocker[] = [{ code: 'agent_working', message: "bo's terminal is still working", entity: { kind: 'character', id: 'c_bo' } }];
      let answered: HandoverChoices | 'cancel' | undefined;
      h.tx.script = async () => {
        answered = await h.tx.decide(working, 'freeze');
        return { status: 'blocked', transactionId: 'tx-1', phase: 'freeze', blockers: working };
      };
      expect(await runHandover(start(), h.ctx)).toEqual({ code: 1 });
      expect(answered).toBe('cancel');
      expect(h.out()).not.toMatch(/Choose/);
    }
  });

  it('asks at each blocker in a terminal, naming the characters and paths each choice affects, and runs again with the answer', async () => {
    const h = harness({ tty: true });
    const busy: Blocker[] = [
      { code: 'shell_busy', message: "ada's terminal is running vim", entity: { kind: 'character', id: 'c_ada' } },
      { code: 'destination_occupied', message: '/home/ada/app already exists and no handover left it there', entity: { kind: 'root', id: 'r_app' } },
    ];
    const working: Blocker[] = [{ code: 'agent_working', message: "bo's terminal is still working", entity: { kind: 'character', id: 'c_bo' } }];
    let answered: HandoverChoices | 'cancel' | undefined;
    h.tx.script = async (_kind, n) => {
      h.tx.record(pre(n === 1 ? busy : []));
      if (n === 1) return { status: 'blocked', phase: 'begin', blockers: busy };
      h.tx.record(changed('begin'));
      h.tx.record(changed('freeze'));
      h.tx.record({ event: 'handover.blocked', data: { transactionId: 'tx-1', phase: 'freeze', blockers: working } });
      answered = await h.tx.decide(working, 'freeze');
      return { status: 'complete', transactionId: 'tx-1', generation: 5, characters: [] };
    };
    const run = runHandover(start(), h.ctx);
    await waitFor(() => /Choose/.test(h.out()));
    const first = h.out();
    expect(first).toMatch(/t\) Terminate and carry ada: .*the shell reopens in its directory/);
    expect(first).toMatch(/a\) Archive \/home\/ada\/app: .*timestamped sibling/);
    expect(first).toMatch(/c\) Cancel/);
    h.type('t');
    await waitFor(() => (h.out().match(/Choose/g) ?? []).length === 2);
    const second = h.out().slice(first.length);
    expect(second).toMatch(/w\) Continue waiting for bo/);
    expect(second).toMatch(/i\) Interrupt and carry bo: Escape .*hook or process tree/);
    h.type('i');
    expect(await run).toEqual({ code: 0 });
    expect(h.tx.calls.map((c) => c.choices)).toEqual([{}, { terminateShells: ['c_ada'] }]);
    expect(answered).toEqual({ terminateShells: ['c_ada'], interruptAfterMs: 0 });
  });

  it('takes Interrupt and carry typed while the rest still waits, through choose, and names who it interrupts', async () => {
    const h = harness({ tty: true });
    let release!: () => void;
    h.tx.script = async () => {
      h.tx.record(changed('freeze'));
      for (const id of ['c_ada', 'c_bo']) h.tx.record({ event: 'handover.entity', data: { transactionId: 'tx-1', kind: 'character', id, phase: 'freeze' } });
      h.tx.record({ event: 'handover.entity', data: { transactionId: 'tx-1', kind: 'character', id: 'c_ada', phase: 'freeze', done: 1, total: 1 } });
      await new Promise<void>((r) => { release = r; });
      return { status: 'complete', transactionId: 'tx-1', generation: 5, characters: [] };
    };
    const run = runHandover({ kind: 'resume' }, h.ctx);
    await waitFor(() => /interrupt and carry/i.test(h.out()));
    h.type('i');
    await waitFor(() => h.tx.chosen.length === 1);
    expect(h.tx.chosen).toEqual([{ interruptAfterMs: 0 }]);
    expect(h.out()).toMatch(/Interrupting c_bo|Interrupting bo/);
    release();
    expect(await run).toEqual({ code: 0 });
  });

  it('answers a blocker on --resume with the choices the run holds, so none its start was given is dropped', async () => {
    const h = harness({ tty: true });
    const working: Blocker[] = [{ code: 'agent_working', message: "bo's terminal is still working", entity: { kind: 'character', id: 'c_bo' } }];
    const held: HandoverChoices = { terminateShells: true, archiveRoots: ['r_app'] };
    let answered: HandoverChoices | 'cancel' | undefined;
    h.tx.script = async () => {
      h.tx.record(changed('freeze'));
      h.tx.record({ event: 'handover.blocked', data: { transactionId: 'tx-1', phase: 'freeze', blockers: working, choices: held } });
      answered = await h.tx.decide(working, 'freeze');
      return { status: 'complete', transactionId: 'tx-1', generation: 5, characters: [] };
    };
    const run = runHandover({ kind: 'resume' }, h.ctx);
    await waitFor(() => /Choose/.test(h.out()));
    h.type('i');
    expect(await run).toEqual({ code: 0 });
    expect(answered).toEqual({ ...held, interruptAfterMs: 0 });
  });

  it('keeps Interrupt and carry typed while the rest waits in the answer to a blocker after it', async () => {
    const h = harness({ tty: true });
    const busy: Blocker[] = [{ code: 'shell_busy', message: "ada's terminal is running vim", entity: { kind: 'character', id: 'c_ada' } }];
    let answered: HandoverChoices | 'cancel' | undefined;
    h.tx.script = async () => {
      h.tx.record(changed('freeze'));
      h.tx.record({ event: 'handover.entity', data: { transactionId: 'tx-1', kind: 'character', id: 'c_bo', phase: 'freeze' } });
      await waitFor(() => h.tx.chosen.length === 1);
      // the controller asks the freeze again with the interrupt merged into the choices it holds
      h.tx.record({ event: 'handover.blocked', data: { transactionId: 'tx-1', phase: 'freeze', blockers: busy, choices: { archiveRoots: ['r_app'], interruptAfterMs: 0 } } });
      answered = await h.tx.decide(busy, 'freeze');
      return { status: 'complete', transactionId: 'tx-1', generation: 5, characters: [] };
    };
    const run = runHandover(start('trift', { archiveRoots: ['r_app'] }), h.ctx);
    await waitFor(() => /interrupt and carry/i.test(h.out()));
    h.type('i');
    await waitFor(() => /Choose/.test(h.out()));
    h.type('t');
    expect(await run).toEqual({ code: 0 });
    expect(answered).toEqual({ archiveRoots: ['r_app'], interruptAfterMs: 0, terminateShells: ['c_ada'] });
  });

  it('on Ctrl-C before the commit aborts, says so and what comes next', async () => {
    const h = harness();
    h.tx.script = async () => {
      h.tx.record(changed('freeze'));
      await new Promise<void>((r) => { h.tx.onCancel = r; });
      h.tx.record({ event: 'handover.changed', data: { transactionId: 'tx-1', phase: 'aborted' } });
      return { status: 'aborted', transactionId: 'tx-1', phase: 'freeze' };
    };
    const run = runHandover(start(), h.ctx);
    await waitFor(() => /Resting/.test(h.out()));
    h.signals.emit('SIGINT');
    expect(await run).toEqual({ code: 1 });
    expect(h.tx.cancelled).toBe(1);
    expect(h.out()).toMatch(/Aborted/);
    expect(h.out()).toContain('svall handover trift');
  });

  it('on Ctrl-C after the commit lets the move go on, and a second Ctrl-C stops watching and names --resume', async () => {
    for (const second of [false, true]) {
      const h = harness({ profile: 'lab' });
      let finish!: (o: Outcome) => void;
      h.tx.finished = new Promise((r) => { finish = r; });
      h.tx.script = async () => {
        h.tx.record(changed('transfer'));
        return new Promise((resolve) => { h.tx.onCancel = () => resolve({ status: 'detached', transactionId: 'tx-1' }); });
      };
      const run = runHandover(start(), h.ctx);
      await waitFor(() => /Transferring/.test(h.out()));
      h.signals.emit('SIGINT');
      await waitFor(() => /Ctrl-C again/.test(h.out()));
      expect(h.out()).toMatch(/The fleet is committed to trift, so the move goes on/);
      if (second) {
        h.signals.emit('SIGINT');
        expect(await run).toEqual({ code: 1, hard: true });
        expect(h.out()).toContain('svall -p lab handover --resume');
        continue;
      }
      finish({ status: 'complete', transactionId: 'tx-1', generation: 5, characters: [] });
      expect(await run).toEqual({ code: 0 });
      expect(h.out()).toMatch(/runs on/);
    }
  });

  it('stops watching at once on a hangup or a Ctrl-\\, and the exit ends its masters', async () => {
    for (const s of ['SIGHUP', 'SIGQUIT']) {
      const h = harness();
      h.tx.script = async () => { h.tx.record(changed('transfer')); return forever(); };
      const run = runHandover(start(), h.ctx);
      await waitFor(() => /Transferring/.test(h.out()));
      expect(h.signals.emit(s), s).toBe(true);
      expect(await run).toEqual({ code: 1, hard: true });
    }
  });

  it('holds its signal listeners while it closes its masters, and a signal then leaves at once', async () => {
    const h = harness();
    let during = -1;
    const connect = h.deps.connect;
    h.deps.connect = (c) => ({ ...connect(c), close: async () => { during = h.signals.listenerCount('SIGINT'); await forever(); } });
    const run = runHandover(start(), h.ctx);
    await waitFor(() => during !== -1);
    expect(during).toBe(1);
    h.signals.emit('SIGINT');
    expect(await run).toEqual({ code: 0, hard: true });
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) expect(h.signals.listenerCount(s), s).toBe(0);
  });

  it('on a first Ctrl-C after a client already let the committed move go on, says so rather than leaving', async () => {
    const h = harness();
    let finish!: (o: Outcome) => void;
    h.tx.finished = new Promise((r) => { finish = r; });
    h.tx.script = async () => {
      h.tx.record(changed('activate'));
      return new Promise((resolve) => { h.tx.onCancel = () => resolve({ status: 'detached', transactionId: 'tx-1' }); });
    };
    const run = runHandover(start(), h.ctx);
    await waitFor(async () => (await probe(h.paths.socket)) === 'live');
    const app = harness({ json: true });
    Object.assign(app.ctx, { fleetHome: h.home, deps: { ...app.deps, tmpdir: h.tmp } });
    const attached = runAttach(app.ctx);
    await waitFor(() => app.events().length === 1);
    app.type('{"cancel":true}');
    expect(await attached).toBe(0);
    h.signals.emit('SIGINT');
    await waitFor(() => /Ctrl-C again/.test(h.out()));
    finish({ status: 'complete', transactionId: 'tx-1', generation: 5, characters: [] });
    expect(await run).toEqual({ code: 0 });
    expect(h.tx.cancelled).toBe(1);
  });

  it('refuses --resume and --abort on a journal the gateway has superseded, naming --forget', async () => {
    for (const kind of ['resume', 'abort'] as const) {
      const h = harness({ json: true });
      h.tx.verdict = { ...NONE, standing: 'superseded', transactionId: 'tx-1', phase: 'transfer', reason: 'the gateway holds this fleet for trift at generation 7, past tx-1' };
      expect(await runHandover({ kind }, h.ctx)).toEqual({ code: 1 });
      expect(h.tx.calls).toEqual([]);
      expect(h.events().at(-1)).toMatchObject({ event: 'handover.result', data: { status: 'interrupted', safe: [], error: expect.stringContaining('svall handover --forget') } });
    }
  });

  it('exits 0 only when the command did what it was asked', async () => {
    const cases: [Job, Outcome, number][] = [
      [start(), { status: 'complete', transactionId: 'tx-1', generation: 5, characters: [], pending: ['source'] }, 0],
      [start(), { status: 'aborted', transactionId: 'tx-1', phase: 'freeze' }, 1],
      [{ kind: 'resume' }, { status: 'none', reason: 'nothing is open' }, 1],
      [{ kind: 'resume' }, { status: 'interrupted', transactionId: 'tx-1', phase: 'transfer', error: 'rsync died', safe: ['resume', 'abort'] }, 1],
      [{ kind: 'abort' }, { status: 'aborted', transactionId: 'tx-1', phase: 'transfer' }, 0],
      [{ kind: 'abort' }, { status: 'interrupted', transactionId: 'tx-1', phase: 'commit', error: 'committed', safe: ['resume'] }, 1],
    ];
    for (const [job, outcome, code] of cases) {
      const h = harness({ json: true });
      h.tx.script = async () => outcome;
      expect(await runHandover(job, h.ctx)).toEqual({ code });
      expect(h.events().at(-1)).toEqual({ event: 'handover.result', data: outcome });
    }
  });

  it('refuses a second start, --resume, --abort and --forget while a helper answers, naming attach', async () => {
    const h = harness({ json: true });
    const live = await HelperServer.open(h.paths, { scrub: (l) => l });
    servers.push(live);
    for (const job of [start(), { kind: 'resume' } as const, { kind: 'abort' } as const]) {
      expect(await runHandover(job, h.ctx)).toEqual({ code: 1 });
    }
    expect(await runForget(h.ctx)).toBe(1);
    expect(h.connects()).toBe(0);
    for (const e of h.events()) expect(JSON.stringify(e)).toContain('svall handover attach');
  });

  it('forgets only a journal the gateway has superseded, and only this controller\'s files', async () => {
    const h = harness();
    const journal = path.join(h.paths.dir, 'handover.json');
    const txFiles = path.join(h.paths.dir, 'handover', 'tx-1');
    fs.mkdirSync(txFiles, { recursive: true });
    fs.writeFileSync(path.join(txFiles, 'manifest.json'), '{}');
    fs.writeFileSync(h.paths.events, '{"event":"handover.changed"}\n');
    fs.writeFileSync(journal, '{}');
    fs.writeFileSync(path.join(h.paths.dir, 'route.json'), '{}');
    const ctrl = { transactionId: 'tx-1' } as ControllerJournal;

    h.tx.observation = { controller: ctrl, gateway: { ok: true, value: { ...h.tx.owned, transaction: { id: 'tx-1', fromMachineId: h.registry.localId, toMachineId: TRIFT, phase: 'preparing', startedAt: 1 } } } };
    h.tx.verdict = { ...NONE, standing: 'open', transactionId: 'tx-1', safe: ['resume', 'abort'], action: 'continue', reason: 'tx-1 is preparing and has not committed' };
    expect(await runForget(h.ctx)).toBe(1);
    expect(fs.existsSync(journal)).toBe(true);
    expect(h.out()).toMatch(/--resume|--abort/);

    h.tx.verdict = { ...NONE, standing: 'superseded', transactionId: 'tx-1', reason: 'the gateway holds this fleet for trift at generation 7, past tx-1' };
    expect(await runForget(h.ctx)).toBe(0);
    expect(fs.existsSync(journal)).toBe(false);
    expect(fs.existsSync(txFiles)).toBe(false);
    // a later relaunch would otherwise replay the run the gateway moved past
    expect(fs.existsSync(h.paths.events)).toBe(false);
    expect(fs.existsSync(path.join(h.paths.dir, 'route.json'))).toBe(true);
    expect(fs.existsSync(path.join(h.home, 'fleet.json'))).toBe(true);
  });

  it('reads status without changing anything, naming the helper that runs it and --forget for a superseded journal', async () => {
    const h = harness({ json: true });
    h.tx.verdict = { ...NONE, standing: 'superseded', transactionId: 'tx-1', reason: 'the gateway holds this fleet for trift at generation 7, past tx-1' };
    expect(await runStatus(h.ctx)).toBe(0);
    expect(h.events()).toEqual([{ event: 'handover.status', data: h.tx.verdict }]);
    expect(h.tx.calls).toEqual([]);

    servers.push(await HelperServer.open(h.paths, { scrub: (l) => l }));
    // a live helper is named at once, without asking the gateway or either daemon anything
    const human = harness();
    Object.assign(human.ctx, { fleetHome: h.home, deps: { ...human.deps, tmpdir: h.tmp } });
    human.tx.statusError = new Error('the gateway did not answer');
    expect(await runStatus(human.ctx)).toBe(0);
    expect(human.out()).toContain(`pid ${process.pid}`);
    expect(human.out()).toContain('svall handover attach');
    expect(human.connects()).toBe(0);
    const app = harness({ json: true });
    Object.assign(app.ctx, { fleetHome: h.home, deps: { ...app.deps, tmpdir: h.tmp } });
    app.tx.statusError = new Error('the gateway did not answer');
    expect(await runStatus(app.ctx)).toBe(0);
    expect(app.events()).toEqual([{ event: 'handover.status', data: expect.objectContaining({ helper: { pid: process.pid }, safe: [] }) }]);
    expect(app.connects()).toBe(0);

    const ungated = harness({ gateway: false, json: true });
    expect(await runStatus(ungated.ctx)).toBe(0);
    expect(ungated.events()).toEqual([{ event: 'handover.status', data: expect.objectContaining({ standing: 'none', reason: expect.stringContaining('svall host enable') }) }]);
  });

  it('keeps a token out of what status and attach say when the journals cannot be read', async () => {
    for (const read of [runStatus, runAttach]) {
      for (const json of [true, false]) {
        const h = harness({ json });
        h.tx.statusError = new Error(`svalld on trift refused token ${TOKEN}`);
        expect(await read(h.ctx)).toBe(1);
        expect(h.out() + h.err()).not.toContain(TOKEN);
        expect(h.out() + h.err()).toContain('[redacted]');
      }
    }
  });

  it('attaches to a live helper: replays the run, answers its decision with choose, cancels like Ctrl-C, and ends on its result', async () => {
    const h = harness();
    const working: Blocker[] = [{ code: 'agent_working', message: "bo's terminal is still working", entity: { kind: 'character', id: 'c_bo' } }];
    let answered: HandoverChoices | 'cancel' | undefined;
    h.tx.script = async () => {
      h.tx.record(changed('freeze'));
      h.tx.record({ event: 'handover.blocked', data: { transactionId: 'tx-1', phase: 'freeze', blockers: working } });
      answered = await h.tx.decide(working, 'freeze');
      h.tx.record(changed('transfer'));
      await new Promise<void>((r) => { h.tx.onCancel = r; });
      return { status: 'aborted', transactionId: 'tx-1', phase: 'transfer' };
    };
    // the helper a launcher leaves: nobody at a terminal, so its decision waits for a client
    const helper = runHandover(start(), { ...h.ctx, helper: true });
    await waitFor(async () => (await probe(h.paths.socket)) === 'live' && fs.readFileSync(h.paths.events, 'utf8').includes('handover.blocked'));

    const app = harness({ json: true });
    Object.assign(app.ctx, { fleetHome: h.home, deps: { ...app.deps, tmpdir: h.tmp } });
    const attached = runAttach(app.ctx);
    await waitFor(() => app.events().some((e) => e.event === 'handover.blocked'));
    expect(app.events().map((e) => e.event)).toEqual(['handover.changed', 'handover.blocked']);
    app.type('{"choose":{"interruptAfterMs":0}}');
    await waitFor(() => app.events().length === 3);
    expect(answered).toEqual({ interruptAfterMs: 0 });
    app.type('{"cancel":true}');
    expect(await attached).toBe(0);
    expect(await helper).toEqual({ code: 1 });
    expect(h.tx.cancelled).toBe(1);
    expect(app.events().at(-1)).toEqual({ event: 'handover.result', data: { status: 'aborted', transactionId: 'tx-1', phase: 'transfer' } });
    expect(h.out()).toBe('');
  });

  it('takes an attached client\'s answer as the whole of the choices, so one it turned off is dropped', async () => {
    const h = harness();
    const working: Blocker[] = [{ code: 'agent_working', message: "bo's terminal is still working", entity: { kind: 'character', id: 'c_bo' } }];
    let answered: HandoverChoices | 'cancel' | undefined;
    h.tx.script = async () => {
      h.tx.record({ event: 'handover.blocked', data: { transactionId: 'tx-1', phase: 'freeze', blockers: working } });
      answered = await h.tx.decide(working, 'freeze');
      return { status: 'complete', transactionId: 'tx-1', generation: 5, characters: [] };
    };
    const helper = runHandover(start('trift', { terminateShells: true }), { ...h.ctx, helper: true });
    await waitFor(async () => (await probe(h.paths.socket)) === 'live' && fs.readFileSync(h.paths.events, 'utf8').includes('handover.blocked'));
    const app = harness({ json: true });
    Object.assign(app.ctx, { fleetHome: h.home, deps: { ...app.deps, tmpdir: h.tmp } });
    const attached = runAttach(app.ctx);
    await waitFor(() => app.events().some((e) => e.event === 'handover.blocked'));
    app.type('{"choose":{"interruptAfterMs":0}}');
    expect(await helper).toEqual({ code: 0 });
    expect(await attached).toBe(0);
    expect(answered).toEqual({ interruptAfterMs: 0 });
  });

  it('lets an attached client go on its own cancel once the move is committed, while the helper and the others follow it to the end', async () => {
    const h = harness();
    let finish!: (o: Outcome) => void;
    h.tx.finished = new Promise((r) => { finish = r; });
    h.tx.script = async () => {
      h.tx.record(changed('activate'));
      return new Promise((resolve) => { h.tx.onCancel = () => resolve({ status: 'detached', transactionId: 'tx-1' }); });
    };
    const helper = runHandover(start(), { ...h.ctx, helper: true });
    await waitFor(async () => (await probe(h.paths.socket)) === 'live');
    const clients = [harness({ json: true }), harness({ json: true })];
    for (const c of clients) Object.assign(c.ctx, { fleetHome: h.home, deps: { ...c.deps, tmpdir: h.tmp } });
    const [quitter, watcher] = clients.map((c) => runAttach(c.ctx));
    await waitFor(() => clients.every((c) => c.events().length === 1));
    clients[0].type('{"cancel":true}');
    expect(await quitter).toBe(0);
    expect(clients[0].events().at(-1)).toEqual({ event: 'handover.result', data: { status: 'detached', transactionId: 'tx-1' } });
    finish({ status: 'complete', transactionId: 'tx-1', generation: 5, characters: [] });
    expect(await watcher).toBe(0);
    expect(await helper).toEqual({ code: 0 });
    expect(clients[1].events().at(-1)).toMatchObject({ event: 'handover.result', data: { status: 'complete' } });
    expect(lines(fs.readFileSync(h.paths.events, 'utf8')).at(-1)).toMatchObject({ event: 'handover.result', data: { status: 'complete' } });
  });

  it('lets a person attached at a terminal answer the helper from a menu, and interrupt the rest with i', async () => {
    const h = harness();
    const working: Blocker[] = [{ code: 'agent_working', message: "bo's terminal is still working", entity: { kind: 'character', id: 'c_bo' } }];
    let answered: HandoverChoices | 'cancel' | undefined;
    h.tx.script = async () => {
      h.tx.record(pre());
      h.tx.record(changed('freeze'));
      h.tx.record({ event: 'handover.blocked', data: { transactionId: 'tx-1', phase: 'freeze', blockers: working } });
      answered = await h.tx.decide(working, 'freeze');
      await waitFor(() => h.tx.chosen.length === 1);
      return { status: 'complete', transactionId: 'tx-1', generation: 5, characters: [] };
    };
    const helper = runHandover(start(), { ...h.ctx, helper: true });
    await waitFor(async () => (await probe(h.paths.socket)) === 'live' && fs.readFileSync(h.paths.events, 'utf8').includes('handover.blocked'));
    const person = harness({ tty: true });
    Object.assign(person.ctx, { fleetHome: h.home, deps: { ...person.deps, tmpdir: h.tmp } });
    const attached = runAttach(person.ctx);
    await waitFor(() => /Choose/.test(person.out()));
    expect(person.out()).toMatch(/i\) Interrupt and carry bo/);
    person.type('i');
    await waitFor(() => answered !== undefined);
    expect(answered).toEqual({ interruptAfterMs: 0 });
    person.type('i');
    expect(await attached).toBe(0);
    expect(await helper).toEqual({ code: 0 });
    expect(h.tx.chosen).toEqual([{ interruptAfterMs: 0 }]);
    expect(person.out()).toMatch(/Handed over/);
  });

  it('answers from an attached terminal with the choices the run holds, so none it started with is dropped', async () => {
    const h = harness();
    const working: Blocker[] = [{ code: 'agent_working', message: "bo's terminal is still working", entity: { kind: 'character', id: 'c_bo' } }];
    const held: HandoverChoices = { terminateShells: true, archiveRoots: ['r_app'] };
    let answered: HandoverChoices | 'cancel' | undefined;
    h.tx.script = async () => {
      h.tx.record(pre());
      h.tx.record(changed('freeze'));
      h.tx.record({ event: 'handover.blocked', data: { transactionId: 'tx-1', phase: 'freeze', blockers: working, choices: held } });
      answered = await h.tx.decide(working, 'freeze');
      return { status: 'complete', transactionId: 'tx-1', generation: 5, characters: [] };
    };
    const helper = runHandover(start('trift', held), { ...h.ctx, helper: true });
    await waitFor(async () => (await probe(h.paths.socket)) === 'live' && fs.readFileSync(h.paths.events, 'utf8').includes('handover.blocked'));
    const person = harness({ tty: true });
    Object.assign(person.ctx, { fleetHome: h.home, deps: { ...person.deps, tmpdir: h.tmp } });
    const attached = runAttach(person.ctx);
    await waitFor(() => /Choose/.test(person.out()));
    person.type('i');
    await waitFor(() => answered !== undefined);
    expect(answered).toEqual({ ...held, interruptAfterMs: 0 });
    expect(await attached).toBe(0);
    expect(await helper).toEqual({ code: 0 });
  });

  it('ends a terminal attach when its input ends with a question pending, and neither answers nor cancels', async () => {
    const h = harness();
    const working: Blocker[] = [{ code: 'agent_working', message: "bo's terminal is still working", entity: { kind: 'character', id: 'c_bo' } }];
    let answered: HandoverChoices | 'cancel' | undefined;
    h.tx.script = async () => {
      h.tx.record(pre());
      h.tx.record({ event: 'handover.blocked', data: { transactionId: 'tx-1', phase: 'freeze', blockers: working } });
      answered = await h.tx.decide(working, 'freeze');
      return { status: 'complete', transactionId: 'tx-1', generation: 5, characters: [] };
    };
    const helper = runHandover(start(), { ...h.ctx, helper: true });
    await waitFor(async () => (await probe(h.paths.socket)) === 'live' && fs.readFileSync(h.paths.events, 'utf8').includes('handover.blocked'));
    const person = harness({ tty: true });
    Object.assign(person.ctx, { fleetHome: h.home, deps: { ...person.deps, tmpdir: h.tmp } });
    const attached = runAttach(person.ctx);
    await waitFor(() => /Choose/.test(person.out()));
    person.stdin.end();
    expect(await attached).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(h.tx.cancelled).toBe(0);
    expect(answered).toBeUndefined();
    expect(await probe(h.paths.socket)).toBe('live');

    const app = harness({ json: true });
    Object.assign(app.ctx, { fleetHome: h.home, deps: { ...app.deps, tmpdir: h.tmp } });
    const other = runAttach(app.ctx);
    await waitFor(() => app.events().length === 2);
    app.type('{"choose":{}}');
    expect(await helper).toEqual({ code: 0 });
    expect(await other).toBe(0);
  });

  it('takes an attached client\'s answer to the question the terminal is asking, and drops the question', async () => {
    const h = harness({ tty: true });
    const working: Blocker[] = [{ code: 'agent_blocked', message: 'bo is waiting on an answer', entity: { kind: 'character', id: 'c_bo' } }];
    let answered: HandoverChoices | 'cancel' | undefined;
    h.tx.script = async () => {
      h.tx.record({ event: 'handover.blocked', data: { transactionId: 'tx-1', phase: 'freeze', blockers: working } });
      answered = await h.tx.decide(working, 'freeze');
      return { status: 'complete', transactionId: 'tx-1', generation: 5, characters: [] };
    };
    const run = runHandover(start(), h.ctx);
    await waitFor(() => /Choose/.test(h.out()));
    const app = harness({ json: true });
    Object.assign(app.ctx, { fleetHome: h.home, deps: { ...app.deps, tmpdir: h.tmp } });
    const attached = runAttach(app.ctx);
    await waitFor(() => app.events().length === 1);
    app.type('{"choose":{"interruptAfterMs":0}}');
    expect(await run).toEqual({ code: 0 });
    expect(await attached).toBe(0);
    expect(answered).toEqual({ interruptAfterMs: 0 });
  });

  it('ends attach when its input ends, and never touches the helper', async () => {
    const h = harness();
    h.tx.script = async () => { h.tx.record(changed('freeze')); return forever(); };
    void runHandover(start(), { ...h.ctx, helper: true });
    await waitFor(async () => (await probe(h.paths.socket)) === 'live');
    const app = harness({ json: true });
    Object.assign(app.ctx, { fleetHome: h.home, deps: { ...app.deps, tmpdir: h.tmp } });
    const attached = runAttach(app.ctx);
    await waitFor(() => app.events().length === 1);
    app.stdin.end();
    expect(await attached).toBe(0);
    expect(await probe(h.paths.socket)).toBe('live');
    expect(h.tx.cancelled).toBe(0);
  });

  it('rebuilds a run with no live helper from the events file and where the journals stand now, leaving a stale socket alone', async () => {
    const h = harness({ json: true });
    fs.mkdirSync(h.paths.dir, { recursive: true });
    fs.writeFileSync(h.paths.events, `${JSON.stringify(changed('begin'))}\n${JSON.stringify(changed('freeze'))}\n`);
    staleSocket(h.paths.socket);
    h.tx.verdict = { ...NONE, standing: 'open', transactionId: 'tx-1', phase: 'freeze', safe: ['resume', 'abort'], action: 'continue', reason: 'tx-1 is preparing' };
    expect(await runAttach(h.ctx)).toBe(0);
    expect(h.events()).toEqual([changed('begin'), changed('freeze'), { event: 'handover.status', data: h.tx.verdict }]);
    expect(fs.lstatSync(h.paths.socket).isSocket()).toBe(true);
  });
});

describe('the single-controller lock', () => {
  it('is never taken apart by a reader: status, attach, a launcher and --forget leave a stale socket to the next helper', async () => {
    const h = harness({ json: true });
    fs.mkdirSync(h.paths.dir, { recursive: true, mode: 0o700 });
    staleSocket(h.paths.socket);
    const socket = () => fs.lstatSync(h.paths.socket).isSocket();
    expect(await runStatus(h.ctx)).toBe(0);
    expect(socket()).toBe(true);
    expect(await runAttach(h.ctx)).toBe(0);
    expect(socket()).toBe(true);
    expect(await launchHelper(start(), h.ctx)).toBe(1);
    expect(socket()).toBe(true);
    expect(await runForget(h.ctx)).toBe(1);
    expect(socket()).toBe(true);
    // the next helper is the one that takes it over
    const next = await HelperServer.open(h.paths, { scrub: (l) => l });
    servers.push(next);
    expect(await probe(h.paths.socket)).toBe('live');
  });

  it('lets exactly one of two starts that find the same stale socket take it', async () => {
    for (let round = 0; round < 5; round++) {
      const home = makeHome();
      const tmp = makeHome();
      fs.mkdirSync(path.join(home, 'controller'), { recursive: true, mode: 0o700 });
      staleSocket(helperPaths(home, tmp).socket);
      const both = await Promise.allSettled([HelperServer.open(helperPaths(home, tmp), { scrub: (l) => l }), HelperServer.open(helperPaths(home, tmp), { scrub: (l) => l })]);
      for (const r of both) if (r.status === 'fulfilled') servers.push(r.value);
      expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(both.find((r) => r.status === 'rejected')).toMatchObject({ reason: expect.any(Live) });
    }
  });

  it('takes over a lock whose holder is gone, and refuses one a running process still holds', async () => {
    const home = makeHome();
    const tmp = makeHome();
    const paths = helperPaths(home, tmp);
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const gone = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
    fs.writeFileSync(paths.lock, `${gone}\n`);
    staleSocket(paths.socket);
    const s = await HelperServer.open(paths, { scrub: (l) => l });
    expect(fs.readFileSync(paths.lock, 'utf8').trim()).toBe(String(process.pid));
    await s.close();
    expect(fs.existsSync(paths.lock)).toBe(false);

    const holder = spawn('sleep', ['30']);
    try {
      fs.writeFileSync(paths.lock, `${holder.pid}\n`);
      const refused = await HelperServer.open(paths, { scrub: (l) => l }).catch((e: unknown) => e);
      expect(refused).toMatchObject({ name: 'Live', pid: holder.pid });
      expect(fs.readFileSync(paths.lock, 'utf8').trim()).toBe(String(holder.pid));
    } finally {
      holder.kill();
    }
  });

  it('never lets a process that took a gone holder\'s pid, this one included, keep the lock', async () => {
    const home = makeHome();
    const tmp = makeHome();
    const paths = helperPaths(home, tmp);
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    // a lock written an hour ago, before a reboot or a SIGKILL; the pid it names runs again, started since
    const written = new Date(Date.now() - 3600_000);
    const stranger = spawn('sleep', ['30']);
    try {
      for (const pid of [stranger.pid!, process.pid]) {
        fs.writeFileSync(paths.lock, `${pid}\n`);
        fs.utimesSync(paths.lock, written, written);
        const s = await HelperServer.open(paths, { scrub: (l) => l });
        expect(fs.readFileSync(paths.lock, 'utf8').trim()).toBe(String(process.pid));
        await s.close();
      }
    } finally {
      stranger.kill();
    }
  });

  it('is held by --forget from its first look to the clear, so no start runs in between', async () => {
    const h = harness();
    let release!: () => void;
    h.tx.statusGate = new Promise((r) => { release = r; });
    h.tx.observation = { controller: { transactionId: 'tx-1' } as ControllerJournal, gateway: { ok: true, value: h.tx.owned } };
    h.tx.verdict = { ...NONE, standing: 'superseded', transactionId: 'tx-1', reason: 'the gateway holds this fleet for trift at generation 7, past tx-1' };
    const forgetting = runForget(h.ctx);
    await waitFor(() => fs.existsSync(h.paths.lock));
    const other = harness({ json: true });
    Object.assign(other.ctx, { fleetHome: h.home, deps: { ...other.deps, tmpdir: h.tmp } });
    expect(await runHandover(start(), other.ctx)).toEqual({ code: 1 });
    expect(other.connects()).toBe(0);
    release();
    expect(await forgetting).toBe(0);
    expect(fs.existsSync(h.paths.lock)).toBe(false);
  });
});

describe('the human reading', () => {
  it('heads a step once though it is said again after a decision, and again when the handover goes back to copy', () => {
    const printed: string[] = [];
    const view = new View((l) => printed.push(l), { svall: (a) => `svall ${a}`, machine: (id) => id ?? '?' });
    const blocked: HandoverEvent = { event: 'handover.blocked', data: { transactionId: 'tx-1', phase: 'freeze', blockers: [] } };
    for (const e of [changed('begin'), changed('freeze'), blocked, changed('freeze'), changed('transfer'), changed('verify'), changed('prepare'), changed('transfer')]) view.show(e);
    expect(printed.filter((l) => l === 'Resting characters')).toHaveLength(1);
    expect(printed.filter((l) => l === 'Transferring files and sessions')).toHaveLength(2);
    expect(view.phase).toBe('transfer');
  });
});

describe('the human reading of what a row names', () => {
  it('names a session row and its blocker by the character whose session it is', () => {
    const printed: string[] = [];
    const view = new View((l) => printed.push(l), { svall: (a) => `svall ${a}`, machine: (id) => id ?? '?' });
    view.show(pre());
    view.show({ event: 'handover.entity', data: { transactionId: 'tx-1', kind: 'session', id: 's0', phase: 'transfer', error: 'rsync exited 23' } });
    view.show({ event: 'handover.blocked', data: { transactionId: 'tx-1', phase: 'transfer', blockers: [{ code: 'external_writer', message: 'the source kept changing', entity: { kind: 'session', id: 's0' } }] } });
    expect(printed).toContain("  ! ada's session: rsync exited 23");
    expect(printed).toContain("  ✗ ada's session: the source kept changing (external_writer)");
  });
});

describe('the human reading of a session the destination went on with', () => {
  it('names the destination and the way out under the blocker, with OpenCode\'s commands, and leaves a folder to --archive', () => {
    const printed: string[] = [];
    const view = new View((l) => printed.push(l), { svall: (a) => `svall ${a}`, machine: (id) => id ?? '?' });
    view.show(pre());
    view.about.destination = 'trift';
    const id = 'ses_0123456789abABCDEFGHIJKLMN';
    const blockers: Blocker[] = [
      { code: 'destination_diverged', message: `the destination's OpenCode went on with session ${id} past the copy coming in`, entity: { kind: 'character', id: 'c_ada' } },
      { code: 'destination_diverged', message: "the destination's Claude Code went on with session 3f2b past the copy coming in: /home/ada/.claude/projects/-app/3f2b.jsonl", entity: { kind: 'character', id: 'c_bo' } },
      { code: 'destination_diverged', message: `the destination's OpenCode went on with session ${id} past the copy coming in: /home/ada/.svall/transcripts/opencode/${id}.jsonl`, entity: { kind: 'character', id: 'c_ada' } },
      { code: 'destination_diverged', message: '/home/ada/app changed', entity: { kind: 'root', id: 'r_app' } },
    ];
    view.show({ event: 'handover.blocked', data: { transactionId: 'tx-1', phase: 'prepare', blockers } });
    const opencode = `    The copy of this session on trift went on there. To keep it, run \`opencode session export --standalone ${id} > keep.json\` on trift, then \`opencode session delete --standalone ${id}\`, then try again.`;
    const claude = '    The copy of this session on trift went on there. Move the file named above aside on trift, then try again.';
    expect(printed.slice(-7)).toEqual([
      `  ✗ ada: the destination's OpenCode went on with session ${id} past the copy coming in (destination_diverged)`, opencode,
      "  ✗ bo: the destination's Claude Code went on with session 3f2b past the copy coming in: /home/ada/.claude/projects/-app/3f2b.jsonl (destination_diverged)", claude,
      `  ✗ ada: the destination's OpenCode went on with session ${id} past the copy coming in: /home/ada/.svall/transcripts/opencode/${id}.jsonl (destination_diverged)`, claude,
      '  ✗ /home/ada/app changed (destination_diverged)',
    ]);
    const outcome = view.outcome({ status: 'blocked', transactionId: 'tx-1', phase: 'prepare', blockers });
    expect(outcome).toContain(opencode);
    expect(outcome).toContain(claude);
  });
});

describe('the human reading of sizes', () => {
  it('counts bytes in thousands, as the sheet does', () => {
    const printed: string[] = [];
    const view = new View((l) => printed.push(l), { svall: (a) => `svall ${a}`, machine: (id) => id ?? '?' });
    const checks = pre();
    view.show({ ...checks, data: { ...(checks.data as object), summary: { digest: 'a'.repeat(64), roots: 2, files: 5, bytes: 1_500_000, sessions: 1 } } } as HandoverEvent);
    expect(printed[0]).toBe('Checks: 2 roots, 5 files (1.5 MB), 1 agent sessions');
  });
});

describe('the human reading of an archived root', () => {
  it('says once where what the root held before was kept, and still says it was copied', () => {
    const printed: string[] = [];
    const view = new View((l) => printed.push(l), { svall: (a) => `svall ${a}`, machine: (id) => id ?? '?' });
    view.show(pre());
    const row = { transactionId: 'tx-1', kind: 'root' as const, id: 'r_app', archivedTo: '/home/ada/app.archived-1' };
    view.show({ event: 'handover.entity', data: { ...row, phase: 'transfer' } });
    view.show({ event: 'handover.entity', data: { ...row, phase: 'transfer', done: 2, total: 2 } });
    view.show({ event: 'handover.entity', data: { ...row, phase: 'verify', done: 2, total: 2 } });
    expect(printed.filter((l) => l.includes('/home/ada/app'))).toEqual([
      '  ! /home/ada/app: what was there is kept at /home/ada/app.archived-1', '  ✓ /home/ada/app copied', '  ✓ /home/ada/app verified',
    ]);
  });
});

describe('the human reading of what a resumed character waits on', () => {
  it('says so on its row as it resumes and again when the handover completes', () => {
    const printed: string[] = [];
    const view = new View((l) => printed.push(l), { svall: (a) => `svall ${a}`, machine: (id) => id ?? '?' });
    view.show(pre());
    const notice = 'codex waits at its "Trust this folder?" prompt in bo\'s terminal; answer it there';
    view.show({ event: 'handover.entity', data: { transactionId: 'tx-1', kind: 'character', id: 'c_bo', phase: 'activate', notice } });
    view.show({ event: 'handover.result', data: { status: 'complete', transactionId: 'tx-1', generation: 5, characters: [{ id: 'c_ada', ok: true }, { id: 'c_bo', ok: true, notice }] } });
    expect(printed).toContain(`  ✓ bo resumed; ${notice}`);
    expect(printed).toContain(`  ! bo: ${notice}`);
    expect(printed.filter((l) => l.startsWith('  ! ada') || l.startsWith('  ✗'))).toEqual([]);
  });
});

describe('the human reading of a start stopped before its checks', () => {
  it('names each blocker a start stopped at when no checks were printed before it', () => {
    const printed: string[] = [];
    const view = new View((l) => printed.push(l), { svall: (a) => `svall ${a}`, machine: (id) => id ?? '?' });
    view.show({ event: 'handover.result', data: { status: 'blocked', phase: 'begin', blockers: [{ code: 'ssh_interactive', message: 'ssh would have to ask before it could go on' }] } });
    expect(printed).toContain('  ✗ ssh would have to ask before it could go on (ssh_interactive)');
  });
});

describe('svall handover --detach', () => {
  const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'helper.mjs');

  const launcher = (h: Harness, env: Record<string, string>): CliDeps['launch'] => (args, log) => {
    Object.assign(process.env, { HELPER_SOCKET: h.paths.socket, HELPER_LOCK: h.paths.lock, ...env });
    try {
      return spawnHelper(process.execPath, [FIXTURE], args, log);
    } finally {
      for (const k of ['HELPER_SOCKET', 'HELPER_LOCK', ...Object.keys(env)]) delete process.env[k];
    }
  };

  it('starts the helper in a session of its own, waits for its socket, prints only handover.detached and exits 0', async () => {
    const h = harness({ json: true });
    h.deps.launch = launcher(h, {});
    expect(await launchHelper(start(), h.ctx)).toBe(0);
    const [only, ...rest] = h.events();
    expect(rest).toEqual([]);
    expect(only).toEqual({ event: 'handover.detached', data: { pid: expect.any(Number) } });
    const pid = (only as Extract<HandoverEvent, { event: 'handover.detached' }>).data.pid;
    try {
      expect(await probe(h.paths.socket)).toBe('live');
      await waitFor(() => fs.readFileSync(h.paths.log, 'utf8').includes('helper up'));
      const said = JSON.parse(fs.readFileSync(h.paths.log, 'utf8').split('\n').find((l) => l.startsWith('{'))!);
      expect(said.args).toEqual(['handover', 'trift', '--json', '--helper']);
      // a process group, and so a session, of its own: a terminal's Ctrl-C never reaches it
      expect(said.pgid).toBe(pid);
      expect(said.stdin).toBe('closed');
      expect(mode(h.paths.log)).toBe(0o600);
    } finally {
      process.kill(pid, 'SIGTERM');
    }
  });

  it('reports a lock a running process holds without answering as its result, and launches nothing', async () => {
    const h = harness({ json: true });
    fs.mkdirSync(h.paths.dir, { recursive: true, mode: 0o700 });
    const holder = spawn('sleep', ['30']);
    try {
      fs.writeFileSync(h.paths.lock, `${holder.pid}\n`);
      expect(await launchHelper(start(), h.ctx)).toBe(1);
      expect(h.launched).toEqual([]);
      expect(h.events()).toEqual([{ event: 'handover.result', data: expect.objectContaining({ status: 'interrupted', error: expect.stringContaining(h.paths.lock) }) }]);
    } finally {
      holder.kill();
    }
  });

  it('never takes another helper that comes up meanwhile for the one it started', async () => {
    const h = harness({ json: true });
    const launch = launcher(h, { HELPER_IDLE: '1' });
    h.deps.launch = (args, log) => {
      const child = launch(args, log);
      // another launch's helper takes the socket while this one's child is still starting
      void HelperServer.open(h.paths, { scrub: (l) => l }).then((s) => servers.push(s));
      return child;
    };
    expect(await launchHelper(start(), h.ctx)).toBe(1);
    expect(h.events()).toEqual([{ event: 'handover.result', data: expect.objectContaining({ status: 'interrupted', error: expect.stringContaining(h.paths.log) }) }]);
  });

  it('prints the result of a helper that listened and ended before it was seen to, and exits as that run went', async () => {
    const ended: Outcome = { status: 'interrupted', phase: 'begin', error: 'the gateway on refused.test did not answer', safe: [] };
    const h = harness({ json: true });
    h.deps.launch = launcher(h, { HELPER_EVENTS: h.paths.events, HELPER_RESULT: JSON.stringify(ended) });
    expect(await launchHelper(start(), h.ctx)).toBe(1);
    expect(h.events()).toEqual([{ event: 'handover.result', data: ended }]);

    const complete: Outcome = { status: 'complete', transactionId: 'tx-1', generation: 5, characters: [{ id: 'c_ada', ok: true }] };
    const done = harness({ json: true });
    done.deps.launch = launcher(done, { HELPER_EVENTS: done.paths.events, HELPER_RESULT: JSON.stringify(complete) });
    expect(await launchHelper(start(), done.ctx)).toBe(0);
    expect(done.events()).toEqual([{ event: 'handover.result', data: complete }]);
  });

  it('never takes the result an earlier run left in the events file for that of a helper that could not start', async () => {
    const h = harness({ json: true });
    fs.mkdirSync(h.paths.dir, { recursive: true, mode: 0o700 });
    const earlier: Outcome = { status: 'complete', transactionId: 'tx-0', generation: 4, characters: [] };
    fs.writeFileSync(h.paths.events, `${JSON.stringify({ event: 'handover.result', data: earlier })}\n`, { mode: 0o600 });
    h.deps.launch = launcher(h, { HELPER_FAIL: '1' });
    expect(await launchHelper(start(), h.ctx)).toBe(1);
    expect(h.events()).toEqual([{ event: 'handover.result', data: expect.objectContaining({ status: 'interrupted', error: expect.stringContaining(h.paths.log) }) }]);
  });

  it('prints a handover.result naming why when the helper cannot start, and exits 1', async () => {
    const h = harness({ json: true });
    h.deps.launch = launcher(h, { HELPER_FAIL: '1' });
    expect(await launchHelper(start(), h.ctx)).toBe(1);
    expect(h.events()).toEqual([{ event: 'handover.result', data: expect.objectContaining({ status: 'interrupted', error: expect.stringContaining(h.paths.log) }) }]);

    const live = harness({ json: true });
    servers.push(await HelperServer.open(live.paths, { scrub: (l) => l }));
    expect(await launchHelper(start(), live.ctx)).toBe(1);
    expect(live.launched).toEqual([]);
    expect(live.events()).toEqual([{ event: 'handover.result', data: expect.objectContaining({ error: expect.stringContaining('svall handover attach') }) }]);

    const ungated = harness({ json: true, gateway: false });
    expect(await launchHelper(start(), ungated.ctx)).toBe(1);
    expect(ungated.launched).toEqual([]);
  });
});

describe('svall handover arguments', () => {
  const parse = async (h: Harness, ...argv: string[]): Promise<{ job?: Job; code?: number }> => {
    let job: Job | undefined;
    let code: number | undefined;
    const cmd = handoverCommand({
      target: () => ({ name: 'private', home: h.home, managed: true }), profile: () => undefined, json: () => false, deps: () => h.deps,
      run: async (j) => { job = j; return { code: 0 }; }, exit: (c) => { code = c; },
    });
    cmd.exitOverride();
    await cmd.parseAsync(argv, { from: 'user' });
    return { job, code };
  };

  it('reads the rest choices a start is given', async () => {
    const h = harness();
    expect((await parse(h, 'trift', '--interrupt-after', '30s', '--terminate-shells', '--archive', '/home/ada/app', '--archive', '/home/ada/app.git')).job).toEqual({
      kind: 'start', to: 'trift', choices: { interruptAfterMs: 30_000, terminateShells: true, archiveRoots: ['/home/ada/app', '/home/ada/app.git'] },
    });
    expect((await parse(h, 'local', '--interrupt-after', '0')).job).toEqual({ kind: 'start', to: 'local', choices: { interruptAfterMs: 0 } });
    // what the app sends: Interrupt and carry, and the root ids its blockers name
    expect((await parse(h, 'trift', '--interrupt-after', '0s', '--archive', 'r_1f2e')).job).toEqual({
      kind: 'start', to: 'trift', choices: { interruptAfterMs: 0, archiveRoots: ['r_1f2e'] },
    });
    expect((await parse(h, '--resume')).job).toEqual({ kind: 'resume' });
    expect((await parse(h, '--abort')).job).toEqual({ kind: 'abort' });
    expect(parseDuration('1m')).toBe(60_000);
    expect(parseDuration('250ms')).toBe(250);
    expect(() => parseDuration('soon')).toThrow(/duration/);
    await expect(parse(h, 'trift', '--resume')).rejects.toThrow();
    await expect(parse(h)).rejects.toThrow();
    await expect(parse(h, '--resume', '--terminate-shells')).rejects.toThrow();
  });

  it('answers bad arguments with a handover.result under --json or --detach, and starts nothing', async () => {
    const cases: [boolean, string[], RegExp][] = [
      [true, ['trift', '--interrupt-after', 'soon', '--detach'], /bad duration "soon"/],
      [true, ['--detach'], /name one machine/],
      [true, ['trift', '--interrupt-after', 'soon'], /bad duration "soon"/],
      [false, ['trift', '--resume', '--detach'], /name one machine/],
    ];
    for (const [json, argv, why] of cases) {
      const h = harness();
      let code: number | undefined;
      const cmd = handoverCommand({
        target: () => ({ name: 'private', home: h.home, managed: true }), profile: () => undefined, json: () => json, deps: () => h.deps,
        run: async () => { throw new Error('nothing runs on bad arguments'); }, exit: (c) => { code = c; },
      });
      await cmd.parseAsync(argv, { from: 'user' });
      expect(code).toBe(1);
      expect(h.launched).toEqual([]);
      if (json) expect(h.events()).toEqual([{ event: 'handover.result', data: { status: 'interrupted', phase: 'begin', safe: [], error: expect.stringMatching(why) } }]);
      else expect(h.out()).toMatch(why);
    }
  });

  it('says what --terminate-shells also ends', () => {
    const h = harness();
    const help = handoverCommand({ target: () => ({ name: 'private', home: h.home, managed: true }), profile: () => undefined, json: () => false, deps: () => h.deps }).helpInformation();
    expect(help).toMatch(/--terminate-shells/);
    const text = help.replace(/\s+/g, ' ');
    expect(text).toMatch(/interrupted agent that will not settle/);
    expect(text).toMatch(/background command still running counts as not settled/);
  });
});

describe('a fleet handed to another machine, from this one', () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  const tsx = path.join(root, 'node_modules/.bin/tsx');
  const main = path.join(root, 'packages/cli/src/main.ts');
  const GATE = MachineId.parse('cccccccc-dddd-eeee-ffff-000000000000');

  it('reaches the new owner with status, char list and connect: through the gateway, and through the route the handover cached', { timeout: 120_000 }, async () => {
    const ssh = installFakeSsh();
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    try {
      // the daemon that runs the fleet on trift now, behind the forward the fake ssh proxies
      const state = emptyState();
      state.characters.c_ada = {
        id: 'c_ada', islandId: 'home', cell: { x: 0, y: 1 }, name: 'ada', portrait: 'fox', note: '', instructions: '', cwd: '/home/ada/app', context: [],
        shell: { lastOutputAt: 0 }, unread: false, revive: { command: '' },
      };
      wss.on('connection', (ws) => {
        let authed = false;
        ws.on('message', (raw) => {
          if (!authed) { authed = true; ws.send(JSON.stringify({ id: 0, result: { ok: true } })); return; }
          const req = JSON.parse(raw.toString()) as { id: number; method: string };
          ws.send(JSON.stringify({ id: req.id, result: req.method === 'state.get' ? state : {} }));
        });
      });
      const port = (wss.address() as { port: number }).port;
      ssh.answer({ fleetId: FLEET, machineId: TRIFT, release: 'dev', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port, token: 'trift-token', generation: 5 });

      const home = makeHome();
      const config = makeHome();
      fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET, gatewayMachineId: GATE }));
      const registry = MachineRegistry.load(config);
      const machine = (name: string, ssh: string, gateway: boolean) => ({
        name, ssh, platform: 'linux' as const, arch: 'arm64', home: '/home/ada', svallBase: '/home/ada/.local/share/svall', gateway,
      });
      registry.add(machine('trift', 'trift.test', false), TRIFT);
      registry.add(machine('gate', 'gate.test', true), GATE);
      registry.save();
      const holds = (owner: MachineId, generation: number) => {
        ssh.clearReplies();
        ssh.reply(['gateway', 'owner', 'get'], { stdout: `${JSON.stringify({ result: { record: { fleetId: FLEET, generation, ownerMachineId: owner } } })}\n` });
      };
      holds(registry.localId, 4);

      // the handover: what the transaction leaves behind once it completes is the gateway's record and the cached route
      const tx = new FakeTx(registry.localId);
      tx.script = async () => {
        tx.record(changed('complete'));
        holds(TRIFT, 5);
        rememberOwner(home, { ownerMachineId: TRIFT, generation: 5 });
        return { status: 'complete', transactionId: 'tx-1', generation: 5, characters: [{ id: 'c_ada', ok: true }] };
      };
      const out: string[] = [];
      const deps: CliDeps = {
        connect: (c) => { tx.record = c.record; tx.decide = c.decide; return tx.api; },
        registry: () => registry, stdin: new PassThrough(), stdout: { write: (x: string) => out.push(x) }, stderr: { write: () => true },
        signals: new EventEmitter(), launch: () => { throw new Error('not launched'); }, argv: () => [], tmpdir: makeHome(),
      };
      expect(await runHandover(start('trift'), { fleetHome: home, json: true, deps })).toEqual({ code: 0 });

      const env = { ...process.env, SVALL_HOME: home, SVALL_CONFIG_DIR: config };
      const svall = async (...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
        try {
          const r = await promisify(execFile)(tsx, [main, ...args], { env });
          return { stdout: r.stdout, stderr: r.stderr, code: 0 };
        } catch (e) {
          const err = e as { stdout: string; stderr: string; code: number };
          return { stdout: err.stdout, stderr: err.stderr, code: err.code };
        }
      };
      const reachesTrift = async (): Promise<void> => {
        const status = await svall('status', '--json');
        expect(status, status.stderr).toMatchObject({ code: 0 });
        expect(JSON.parse(status.stdout).characters.c_ada.name).toBe('ada');
      };

      // first with the gateway out of reach: only the route the handover cached leads to trift, which holds generation 5
      expect(JSON.parse(fs.readFileSync(path.join(home, 'controller', 'route.json'), 'utf8'))).toMatchObject({ ownerMachineId: TRIFT, generation: 5 });
      const gateAt = (destination: string) => {
        registry.remove(GATE);
        registry.add(machine('gate', destination, true), GATE);
        registry.save();
      };
      gateAt('refused.test');
      await reachesTrift();

      // then through the gateway's record
      gateAt('gate.test');
      await reachesTrift();
      const list = await svall('char', 'list', '--json');
      expect(list.code).toBe(0);
      expect(JSON.parse(list.stdout).map((c: { name: string }) => c.name)).toEqual(['ada']);
      // no daemon runs the fleet here any more, and the reading says where it went
      const human = await svall('status');
      expect(human, human.stderr).toMatchObject({ code: 0 });
      expect(human.stdout).toContain('trift');

      const connect = spawn(tsx, [main, 'connect', '--json'], { env });
      let said = '';
      connect.stdout.on('data', (chunk: Buffer) => { said += chunk.toString(); });
      await waitFor(() => said.includes('"online"'), 60_000);
      connect.stdin.end();
      expect(await new Promise((r) => connect.on('close', r))).toBe(0);
      expect(lines(said).find((e) => (e as { type: string }).type === 'online')).toMatchObject({ remote: { name: 'trift' }, token: 'trift-token' });
    } finally {
      await new Promise((r) => wss.close(r));
      ssh.clean();
    }
  });
});

describe('svall handover through the real CLI', () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  const tsx = path.join(root, 'node_modules/.bin/tsx');
  const main = path.join(root, 'packages/cli/src/main.ts');
  const GATE = MachineId.parse('cccccccc-dddd-eeee-ffff-000000000000');

  it('leaves the run to a helper it starts as itself, which records how it ended for attach to show', { timeout: 120_000 }, async () => {
    const ssh = installFakeSsh();
    try {
      const home = makeHome();
      const config = makeHome();
      fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET, gatewayMachineId: GATE }));
      const registry = MachineRegistry.load(config);
      const machine = (name: string, destination: string) => ({
        name, ssh: destination, platform: 'linux' as const, arch: 'arm64', home: '/home/ada', svallBase: '/home/ada/.local/share/svall', gateway: false,
      });
      registry.add(machine('trift', 'trift.test'), TRIFT);
      // a gateway ssh cannot reach, so the helper's first question fails and the run ends there
      registry.add(machine('gate', 'refused.test'), GATE);
      registry.save();
      const env = { ...process.env, SVALL_HOME: home, SVALL_CONFIG_DIR: config };
      const run = promisify(execFile);

      const launched = await run(tsx, [main, 'handover', 'trift', '--json', '--detach'], { env })
        .then((r) => ({ stdout: r.stdout, code: 0 }), (e: { stdout: string; code: number }) => ({ stdout: e.stdout, code: e.code }));
      const [only, ...rest] = lines(launched.stdout) as HandoverEvent[];
      expect(rest).toEqual([]);
      // a helper whose run ends between two looks at its socket is reported by its own result
      if (only.event === 'handover.result') {
        expect(launched.code).toBe(1);
        expect(only).toMatchObject({ data: { status: 'interrupted', error: expect.stringContaining('refused.test') } });
      } else {
        expect(launched.code).toBe(0);
        expect(only).toEqual({ event: 'handover.detached', data: { pid: expect.any(Number) } });
      }

      const paths = helperPaths(home);
      await waitFor(async () => (await probe(paths.socket)) === 'none' && fs.readFileSync(paths.events, 'utf8').includes('handover.result'), 60_000);
      expect(mode(paths.log)).toBe(0o600);
      expect(mode(paths.events)).toBe(0o600);

      const attached = await run(tsx, [main, 'handover', 'attach', '--json'], { env });
      const seen = lines(attached.stdout) as HandoverEvent[];
      expect(seen.at(-2)).toMatchObject({ event: 'handover.result', data: { status: 'interrupted', error: expect.stringContaining('refused.test') } });
      expect(seen.at(-1)).toMatchObject({ event: 'handover.status', data: { standing: 'none' } });
    } finally {
      ssh.clean();
    }
  });
});
