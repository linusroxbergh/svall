import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { machineId, readRegistry } from '@svall/svalld/machine';
import { dialSocket, resolvePaths } from '@svall/svalld/paths';
import { issueToken, tokenFor } from '@svall/svalld/placement/workers';
import { LAUNCHD_LABEL } from '@svall/svalld/profile';
import { cleanHomes, makeHome } from '@svall/svalld/test-helpers';
import { enrollHere } from '../src/commands/worker.js';
import { MachineRegistry } from '../src/controller/registry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tsx = path.join(root, 'node_modules/.bin/tsx');
const main = path.join(root, 'packages/cli/src/main.ts');

afterEach(cleanHomes);

function svall(home: string, ...args: string[]) {
  return svallIn({ SVALL_HOME: home }, ...args);
}

function svallIn(env: Record<string, string>, ...args: string[]) {
  const child = spawn(tsx, [main, ...args], { env: { ...process.env, ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
  return { child, done };
}

describe('svall worker', () => {
  it('link carries its stdin to link.sock and the socket back on its stdout, and ends with its input', async () => {
    const home = makeHome();
    const heard: string[] = [];
    const server = net.createServer((s) => {
      s.on('data', (c: Buffer) => { heard.push(c.toString()); s.write('{"t":"hello"}\n'); });
    });
    await new Promise<void>((r) => server.listen(resolvePaths(home).linkSock, r));
    try {
      const { child, done } = svall(home, 'worker', 'link');
      child.stdin.write('{"t":"ping"}\n');
      await new Promise<void>((r) => child.stdout.once('data', () => r()));
      child.stdin.end();
      const r = await done;
      expect(r).toEqual({ code: 0, stdout: '{"t":"hello"}\n', stderr: '' });
      expect(heard.join('')).toBe('{"t":"ping"}\n');
    } finally {
      server.close();
    }
  });

  it('link ends with an error when no worker daemon listens', async () => {
    const r = await svall(makeHome(), 'worker', 'link').done;
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/link\.sock/);
  });

  it('enroll writes worker.json, readable by its owner alone, with the token read from stdin', async () => {
    const home = makeHome();
    const ids = { home: crypto.randomUUID(), fleet: crypto.randomUUID() };
    const enroll = (token: string) => {
      const run = svall(home, 'worker', 'enroll', '--home-machine', ids.home, '--home-name', 'linus-mbp', '--fleet-id', ids.fleet);
      run.child.stdin.end(token);
      return run.done;
    };
    expect(await enroll('short\n')).toMatchObject({ code: 1, stderr: expect.stringMatching(/token/) });
    expect(fs.existsSync(resolvePaths(home).workerFile)).toBe(false);
    const token = 'a'.repeat(48);
    expect(await enroll(`${token}\n`)).toEqual({ code: 0, stdout: '', stderr: '' });
    const file = resolvePaths(home).workerFile;
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ homeMachineId: ids.home, fleetId: ids.fleet, token, homeName: 'linus-mbp' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('enroll with --home-ssh writes the destination and socket the worker dials, refusing one ssh would read as an option or either alone', async () => {
    const home = makeHome();
    const base = ['worker', 'enroll', '--home-machine', crypto.randomUUID(), '--home-name', 'studio', '--fleet-id', crypto.randomUUID()];
    const enroll = async (...extra: string[]) => { const run = svall(home, ...base, ...extra); run.child.stdin.end('a'.repeat(48)); return run.done; };
    const socket = dialSocket({ dialSockets: '/home/ada/.svall/w' }, machineId());
    const others = dialSocket({ dialSockets: '/home/ada/.svall/w' }, crypto.randomUUID());
    for (const extra of [['--home-ssh', '-oProxyCommand=touch /tmp/x', '--home-socket', socket], ['--home-ssh', 'ada@studio'], ['--home-ssh', 'ada@studio', '--home-socket', '/home/a:b/x.sock'],
      ['--home-ssh', 'ada@studio', '--home-socket', '/home/ada/.ssh/authorized_keys'], ['--home-ssh', 'ada@studio', '--home-socket', others]]) {
      expect(await enroll(...extra)).toMatchObject({ code: 1, stderr: expect.stringContaining('worker.json not written') });
      expect(fs.existsSync(resolvePaths(home).workerFile)).toBe(false);
    }
    expect(await enroll('--home-ssh', 'ada@studio', '--home-socket', socket)).toMatchObject({ code: 0 });
    expect(JSON.parse(fs.readFileSync(resolvePaths(home).workerFile, 'utf8'))).toMatchObject({ homeSsh: 'ada@studio', homeSocket: socket });
  });

  it('enroll on a Mac restarts the fleet\'s launchd agent and waits for its daemon, as systemd does on Linux', async () => {
    const bin = makeHome();
    const calls = path.join(bin, 'calls');
    fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n`, { mode: 0o755 });
    const PATH = process.env.PATH;
    process.env.PATH = `${bin}:${PATH}`;
    try {
      const t = { name: 'private', home: makeHome(), managed: true };
      const me = crypto.randomUUID();
      const o = { homeMachine: crypto.randomUUID(), homeName: 'studio', fleetId: crypto.randomUUID(), homeSsh: 'ada@studio', homeSocket: dialSocket({ dialSockets: '/home/ada/.svall/w' }, me) };
      const out: string[] = [];
      const waited: string[] = [];
      const d = { platform: 'darwin' as const, token: async () => 'a'.repeat(48), daemonUp: async (x: { home: string }) => { waited.push(x.home); return true; }, out: (l: string) => out.push(l), me: () => me, loaded: async () => true };
      // a job launchd has not loaded could not be restarted, so nothing is written
      await expect(enrollHere(t, o, { ...d, loaded: async () => false })).rejects.toThrow(`worker.json not written: launchd has not loaded ${LAUNCHD_LABEL}, so nothing would start this fleet as a worker; open it once with svall setup, then enrol it`);
      expect(fs.existsSync(resolvePaths(t.home).workerFile)).toBe(false);
      expect(fs.existsSync(calls)).toBe(false);
      await enrollHere(t, o, d);
      expect(fs.readFileSync(calls, 'utf8')).toBe(`kickstart -k gui/${os.userInfo().uid}/${LAUNCHD_LABEL}\n`);
      expect(waited).toEqual([t.home]);
      expect(out).toEqual([`restarted ${LAUNCHD_LABEL}`]);
      expect(fs.existsSync(resolvePaths(t.home).workerFile)).toBe(true);
      await expect(enrollHere(t, o, { ...d, daemonUp: async () => false })).rejects.toThrow(`${LAUNCHD_LABEL} did not answer after its restart; svall doctor says why`);
      // a fleet home that is no profile's own has no launchd agent to restart
      fs.rmSync(calls);
      await enrollHere({ ...t, managed: false }, o, d);
      expect(fs.existsSync(calls)).toBe(false);
    } finally {
      process.env.PATH = PATH;
    }
  });

  it("enroll refuses a fleet's home that holds robots or workers of its own, which the first snapshot would erase, and takes one that holds neither", async () => {
    const me = crypto.randomUUID();
    const t = { name: 'work', home: makeHome(), managed: false };
    const paths = resolvePaths(t.home);
    const o = { homeMachine: crypto.randomUUID(), homeName: 'studio', fleetId: crypto.randomUUID() };
    const d = { platform: 'darwin' as const, token: async () => 'a'.repeat(48), daemonUp: async () => true, out: () => {}, me: () => me, loaded: async () => true };
    const state = (s: object) => fs.writeFileSync(paths.state, JSON.stringify(s));
    state({ robots: { c_a: { name: 'a' }, c_b: { machine: crypto.randomUUID() } } });
    await expect(enrollHere(t, o, d)).rejects.toThrow(`worker.json not written: ${t.home} is a fleet's home and holds 2 robots, which the first snapshot from studio would erase; enrol an empty fleet with svall -p <empty fleet> worker enroll`);
    state({ robots: {} });
    issueToken(paths, crypto.randomUUID() as never);
    await expect(enrollHere(t, o, d)).rejects.toThrow('holds 1 worker, which');
    expect(fs.existsSync(paths.workerFile)).toBe(false);
    fs.rmSync(paths.workersFile);
    // robots placed on this machine stay through a snapshot, and one that has taken a snapshot holds a worker's copy
    state({ robots: { c_a: { machine: me } } });
    await enrollHere(t, o, d);
    fs.rmSync(paths.workerFile);
    state({ robots: { c_a: { name: 'a' } }, machines: { [o.homeMachine]: { snapshot: { version: 1, at: 1 } } } });
    await enrollHere(t, o, d);
    // and a worker's fleet home enrols again, whatever it holds
    state({ robots: { c_a: { name: 'a' } } });
    await enrollHere(t, o, d);
    expect(fs.existsSync(paths.workerFile)).toBe(true);
  });

  it('enroll refuses a fleet with anything on an island beyond mission control, robots or none, and takes the empty island a new fleet opens with', async () => {
    const t = { name: 'work', home: makeHome(), managed: false };
    const paths = resolvePaths(t.home);
    const o = { homeMachine: crypto.randomUUID(), homeName: 'studio', fleetId: crypto.randomUUID() };
    const d = { platform: 'darwin' as const, token: async () => 'a'.repeat(48), daemonUp: async () => true, out: () => {}, me: () => crypto.randomUUID(), loaded: async () => true };
    const empty = { name: 'Island 1', description: '', instructions: '', context: [] };
    const islands = (i_a: object) => fs.writeFileSync(paths.state, JSON.stringify({ robots: {}, islands: { home: { ...empty, instructions: 'the crew' }, i_a } }));
    for (const holding of [{ description: 'the plan' }, { instructions: 'be brief' }, { context: [{ kind: 'url' }] }]) {
      islands({ ...empty, ...holding });
      await expect(enrollHere(t, o, d)).rejects.toThrow(`worker.json not written: ${t.home} is a fleet's home and holds 1 island, which the first snapshot from studio would erase; enrol an empty fleet with svall -p <empty fleet> worker enroll`);
    }
    islands(empty);
    const docs = path.join(paths.docs, 'islands', 'i_a');
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'plan.md'), '---\ndescription: the plan\n---\n');
    await expect(enrollHere(t, o, d)).rejects.toThrow('holds 1 island, which');
    expect(fs.existsSync(paths.workerFile)).toBe(false);
    fs.rmSync(docs, { recursive: true });
    await enrollHere(t, o, d);
    expect(fs.existsSync(paths.workerFile)).toBe(true);
  });

  it("version --json names a home with its fleet's id, and a worker with the home it serves", async () => {
    const home = makeHome();
    const fleetId = crypto.randomUUID();
    fs.writeFileSync(resolvePaths(home).fleetConfig, JSON.stringify({ id: fleetId }));
    expect(JSON.parse((await svall(home, '--json', 'version').done).stdout)).toMatchObject({ role: 'home', fleetId });
    const worker = { homeMachineId: crypto.randomUUID(), homeName: 'studio', fleetId };
    fs.writeFileSync(resolvePaths(home).workerFile, JSON.stringify({ ...worker, token: 'a'.repeat(48) }));
    const said = JSON.parse((await svall(home, '--json', 'version').done).stdout);
    expect(said).toMatchObject({ role: 'worker', worker });
    expect(JSON.stringify(said)).not.toContain('a'.repeat(48));
  });

  it("fleet enroll-worker records a worker that dials in, issues it a token printed once in JSON, and a run again issues a newer one", async () => {
    const home = makeHome();
    fs.writeFileSync(resolvePaths(home).fleetConfig, JSON.stringify({ id: crypto.randomUUID() }));
    const env = { SVALL_HOME: home, SVALL_CONFIG_DIR: makeHome() };
    const id = crypto.randomUUID();
    const facts = ['--name', 'ada-mac', '--platform', 'darwin', '--arch', 'arm64', '--home', '/Users/ada', '--svall-base', '/Users/ada/.svall'];
    const enroll = () => svallIn(env, '--json', 'fleet', 'enroll-worker', id, ...facts).done;
    const first = await enroll();
    expect(first).toMatchObject({ code: 0, stderr: '' });
    const answer = JSON.parse(first.stdout);
    expect(answer).toEqual({
      homeMachineId: expect.any(String), homeName: expect.any(String), fleetId: JSON.parse(fs.readFileSync(resolvePaths(home).fleetConfig, 'utf8')).id,
      socket: dialSocket(resolvePaths(home), id), token: tokenFor(resolvePaths(home), id as never),
    });
    expect(readRegistry(env.SVALL_CONFIG_DIR).find((m) => m.id === id)?.record).toEqual({ name: 'ada-mac', platform: 'darwin', arch: 'arm64', home: '/Users/ada', svallBase: '/Users/ada/.svall', dial: 'worker' });
    const again = JSON.parse((await enroll()).stdout);
    expect(again.token).not.toBe(answer.token);
    expect(tokenFor(resolvePaths(home), id as never)).toBe(again.token);
    // a run that would show the token to a person issues none
    const plain = await svallIn(env, 'fleet', 'enroll-worker', id, ...facts).done;
    expect(plain).toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('run it with --json') });
    expect(tokenFor(resolvePaths(home), id as never)).toBe(again.token);
    // host list tells it from this machine
    const list = (await svallIn(env, 'host', 'list').done).stdout;
    expect(list).toMatch(/ada-mac\s+\(dials in\)/);
    expect(list).toContain('(this machine)');
  });

  it('fleet enroll-worker says in a sentence what is wrong with its input, issuing no token', async () => {
    const home = makeHome();
    fs.writeFileSync(resolvePaths(home).fleetConfig, JSON.stringify({ id: crypto.randomUUID() }));
    const env = { SVALL_HOME: home, SVALL_CONFIG_DIR: makeHome() };
    const facts = (name: string) => ['--name', name, '--platform', 'darwin', '--arch', 'arm64', '--home', '/Users/ada', '--svall-base', '/Users/ada/.svall'];
    const badId = await svallIn(env, '--json', 'fleet', 'enroll-worker', 'not-a-uuid', ...facts('ada-mac')).done;
    expect(badId).toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('not-a-uuid is not a machine id:') });
    const id = crypto.randomUUID();
    const badName = await svallIn(env, '--json', 'fleet', 'enroll-worker', id, ...facts('Not A Name')).done;
    expect(badName).toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining(`${id} is not enrolled:`) });
    for (const r of [badId, badName]) expect(r.stderr).not.toContain('[{');
    expect(fs.existsSync(resolvePaths(home).workersFile)).toBe(false);
  });

  it('fleet enroll-worker leaves a machine another fleet here reaches over ssh on that route', async () => {
    const account = makeHome();
    const config = makeHome();
    const here = path.join(account, '.svall');
    const other = path.join(account, '.svall-work');
    const id = crypto.randomUUID();
    for (const h of [here, other]) {
      fs.mkdirSync(h);
      fs.writeFileSync(resolvePaths(h).fleetConfig, JSON.stringify({ id: crypto.randomUUID() }));
    }
    const registry = MachineRegistry.load(config);
    registry.put(id as never, { name: 'ada-mac', ssh: 'ada@mac', platform: 'linux', arch: 'arm64', home: '/home/ada', svallBase: '/home/ada/.svall' });
    registry.save();
    const env = { SVALL_HOME: here, SVALL_CONFIG_DIR: config, HOME: account };
    const facts = ['--name', 'ada-mac', '--platform', 'darwin', '--arch', 'arm64', '--home', '/Users/ada', '--svall-base', '/Users/ada/.svall'];
    issueToken(resolvePaths(other), id as never);
    const r = await svallIn(env, '--json', 'fleet', 'enroll-worker', id, ...facts).done;
    expect(r).toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining(`the fleet in ${other} reaches ada-mac over ssh at ada@mac, which this would end; remove it from that fleet first`) });
    expect(tokenFor(resolvePaths(here), id as never)).toBeUndefined();
    expect(readRegistry(config).find((m) => m.id === id)?.record.ssh).toBe('ada@mac');
    // with no other fleet on that route, this one's record is its own to change
    fs.rmSync(resolvePaths(other).workersFile);
    expect(await svallIn(env, '--json', 'fleet', 'enroll-worker', id, ...facts).done).toMatchObject({ code: 0 });
    expect(readRegistry(config).find((m) => m.id === id)?.record).toMatchObject({ dial: 'worker' });
  });

  it("fleet enroll-worker holds the socket to what a Mac worker's ssh takes, shorter than Linux allows", async () => {
    const base = makeHome();
    const socketEnd = `/w/${'0'.repeat(12)}.sock`.length;
    // 104 bytes: past a Mac's 103, within Linux's 107
    const long = path.join(base, 'x'.repeat(104 - socketEnd - base.length - 1));
    fs.mkdirSync(long);
    fs.writeFileSync(resolvePaths(long).fleetConfig, JSON.stringify({ id: crypto.randomUUID() }));
    const env = { SVALL_HOME: long, SVALL_CONFIG_DIR: makeHome() };
    const facts = (platform: string) => ['--name', 'ada-mac', '--platform', platform, '--arch', 'arm64', '--home', '/h/ada', '--svall-base', '/h/ada/.svall'];
    const mac = await svallIn(env, '--json', 'fleet', 'enroll-worker', crypto.randomUUID(), ...facts('darwin')).done;
    expect(mac).toMatchObject({ code: 1, stderr: expect.stringContaining('is 104 bytes, past the 103 a Unix socket path holds') });
    const linux = await svallIn(env, '--json', 'fleet', 'enroll-worker', crypto.randomUUID(), ...facts('linux')).done;
    expect(linux.code).toBe(process.platform === 'linux' ? 0 : 1);
  });

  it('fleet enroll-worker refuses a fleet home whose socket would be past what a Unix socket path holds, and a worker\'s fleet home, issuing no token', async () => {
    const long = path.join(makeHome(), 'x'.repeat(120 - makeHome().length));
    fs.mkdirSync(long, { recursive: true });
    const config = makeHome();
    const id = crypto.randomUUID();
    const facts = ['--name', 'ada-mac', '--platform', 'darwin', '--arch', 'arm64', '--home', '/Users/ada', '--svall-base', '/Users/ada/.svall'];
    fs.writeFileSync(resolvePaths(long).fleetConfig, JSON.stringify({ id: crypto.randomUUID() }));
    const r = await svallIn({ SVALL_HOME: long, SVALL_CONFIG_DIR: config }, '--json', 'fleet', 'enroll-worker', id, ...facts).done;
    expect(r).toMatchObject({ code: 1, stdout: '' });
    expect(r.stderr).toMatch(/past the 10[37] a Unix socket path holds, so its listen fails with EINVAL, so no worker can dial into .*; use an account whose home is \d+ bytes shorter/);
    expect(tokenFor(resolvePaths(long), id as never)).toBeUndefined();
    expect(readRegistry(config).some((m) => m.id === id)).toBe(false);
    const worker = makeHome();
    fs.writeFileSync(resolvePaths(worker).workerFile, '{}');
    const w = await svallIn({ SVALL_HOME: worker, SVALL_CONFIG_DIR: config }, '--json', 'fleet', 'enroll-worker', id, ...facts).done;
    expect(w).toMatchObject({ code: 1, stderr: expect.stringContaining("is a worker's fleet home; run this on the fleet's home") });
  });

  it('env writes VAR=value into the fleet .env, mode 600, replacing an earlier line and keeping the others', async () => {
    const home = makeHome();
    fs.writeFileSync(resolvePaths(home).env, 'A=1\nGAMMA_TOKEN=old\n');
    const r = svall(home, 'worker', 'env', 'GAMMA_TOKEN'); r.child.stdin.end('xyz\n');
    expect(await r.done).toMatchObject({ code: 0, stdout: "GAMMA_TOKEN is set in this fleet's .env on this machine\n" });
    expect(fs.readFileSync(resolvePaths(home).env, 'utf8')).toBe('A=1\nGAMMA_TOKEN=xyz\n');
    expect(fs.statSync(resolvePaths(home).env).mode & 0o777).toBe(0o600);
  });

  it('env refuses a name that is not a variable, and an empty value; a lowercase name is one', async () => {
    const bad = svall(makeHome(), 'worker', 'env', '1st-key'); bad.child.stdin.end('x');
    expect(await bad.done).toMatchObject({ code: 1, stderr: expect.stringContaining('1st-key is not a variable name') });
    const home = makeHome();
    const lower = svall(home, 'worker', 'env', 'api_key'); lower.child.stdin.end('k1\n');
    expect(await lower.done).toMatchObject({ code: 0, stdout: "api_key is set in this fleet's .env on this machine\n" });
    expect(fs.readFileSync(resolvePaths(home).env, 'utf8')).toBe('api_key=k1\n');
    const empty = svall(makeHome(), 'worker', 'env', 'GAMMA_TOKEN'); empty.child.stdin.end('\n');
    expect(await empty.done).toMatchObject({ code: 1, stderr: expect.stringContaining('no value given') });
  });

  it('env refuses a value .env cannot hold unchanged, without echoing it, and keeps the file', async () => {
    for (const v of ['SECRETVAL\nb', ' SECRETVAL', 'SECRETVAL ', '"SECRETVAL"', "'SECRETVAL'"]) {
      const home = makeHome();
      fs.writeFileSync(resolvePaths(home).env, 'A=1\n');
      const r = svall(home, 'worker', 'env', 'GAMMA_TOKEN'); r.child.stdin.end(`${v}\n`);
      const out = await r.done;
      expect(out.code).toBe(1);
      expect(out.stderr).toContain('cannot be stored');
      expect(out.stderr + out.stdout).not.toContain('SECRETVAL');
      expect(fs.readFileSync(resolvePaths(home).env, 'utf8')).toBe('A=1\n');
    }
  });

  it('env leaves one line for the variable when the .env held two', async () => {
    const home = makeHome();
    fs.writeFileSync(resolvePaths(home).env, 'GAMMA_TOKEN=a\nB=2\nexport GAMMA_TOKEN=b\n');
    const r = svall(home, 'worker', 'env', 'GAMMA_TOKEN'); r.child.stdin.end('xyz\r\n');
    expect((await r.done).code).toBe(0);
    expect(fs.readFileSync(resolvePaths(home).env, 'utf8')).toBe('GAMMA_TOKEN=xyz\nB=2\n');
  });
});
