import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTHORITY_SCHEMA_VERSION, emptyState, PROTOCOL_VERSION, TRANSFER_SCHEMA_VERSION } from '@archipelago/protocol';
import { startDaemon, type Daemon } from '@archipelago/archid';
import { startAuthorityServer } from '@archipelago/archid/gateway/server';
import { silentLogger } from '@archipelago/archid/log';
import { resolvePaths } from '@archipelago/archid/paths';
import { isProfileName } from '@archipelago/archid/profile';
import { HOOK_EVENTS, mergeHooks } from '@archipelago/archid/setup';
import { cleanHomes, hasTmux, makeHome, waitFor } from '@archipelago/archid/test-helpers';
import { Tmux } from '@archipelago/archid/tmux';
import { buildProgram, typo } from '../src/program.js';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tsx = path.join(root, 'node_modules/.bin/tsx');
const main = path.join(root, 'packages/cli/src/main.ts');
const runIf = hasTmux() ? describe : describe.skip;

async function run(env: Record<string, string>, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await exec(tsx, [main, ...args], { env: { ...process.env, ...env } });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr, code: err.code };
  }
}

describe('archi argument parsing', () => {
  it('still has a help command next to the profile argument', async () => {
    const r = await run({}, 'help');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage: archi/);
    expect((await run({}, 'help', 'status')).stdout).toMatch(/Usage: archi status/);
  });

  it('prints the commit it runs from for --version', async () => {
    const r = await run({}, '--version');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^[0-9a-f]{7,} \d{4}-\d{2}-\d{2}\n$/);
  });

  it('refuses a stray argument instead of dropping it', async () => {
    const r = await run({}, 'islands', 'create', 'x');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/too many arguments/);
  });

  it('sends every subcommand to the profile -p names', async () => {
    // no such fleet, so the failure names the home it looked in
    const r = await run({ ARCHI_HOME: '/tmp/archi-should-be-ignored' }, '-p', 'archi-probe', 'status');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('.archipelago-archi-probe');
  });

  it('takes a mistyped command for a typo, not a fleet to create', async () => {
    const r = await run({}, 'stauts');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown command stauts; did you mean status?');
    expect(fs.existsSync(path.join(os.homedir(), '.archipelago-stauts'))).toBe(false);
    expect(['setp', 'stats', 'hlep', 'doctr', 'islands'].map((w) => buildProgram().commands.map((c) => c.name()).concat('help').find((c) => typo(w, c))))
      .toEqual(['setup', 'status', 'help', 'doctor', 'island']);
    expect(['work', 'dev', 'client'].some((w) => buildProgram().commands.some((c) => typo(w, c.name())))).toBe(false);
  });

  it('keeps every command name out of the profile names', () => {
    for (const name of [...buildProgram().commands.map((c) => c.name()), 'help']) {
      expect(isProfileName(name)).toBe(false);
    }
  });

  it('refuses to set up anything but the private fleet', async () => {
    const r = await run({}, '-p', 'archi-probe', 'setup');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/archi setup configures the private fleet/);
  });

  it('setup --check says when the hooks or the shims are not what setup writes now, and changes nothing', async () => {
    // what the check asks of the machine, answered without the real tools
    const bin = makeHome();
    fs.writeFileSync(path.join(bin, 'claude'), "#!/bin/sh\ncase \"$1\" in --version) echo '2.1.0 (Claude Code)';; auth) echo '{\"loggedIn\":true}';; esac\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'codex'), "#!/bin/sh\ncase \"$1\" in --version) echo 'codex-cli 0.156.1';; *) echo 'Not logged in'; exit 1;; esac\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'tmux'), "#!/bin/sh\necho 'tmux 3.5a'\n", { mode: 0o755 });
    const script = path.join(os.homedir(), '.archipelago', 'hooks', 'agent-hook.mjs');
    const settings = path.join(os.homedir(), '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const old = JSON.stringify(mergeHooks({}, `[ -z "$ARCHI_CHAR_ID" ] || { node '${script}' claude; }`, HOOK_EVENTS, script));
    fs.writeFileSync(settings, old);
    // an agent from an install under the old ids, which desktop:install must run setup to move; only ever in isolate.ts's home
    expect(os.homedir().startsWith('/tmp/archi-home-')).toBe(true);
    const agent = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.archipelago.archid.plist');
    fs.mkdirSync(path.dirname(agent), { recursive: true });
    fs.writeFileSync(agent, '<plist/>');
    // sign-ins under both ids, which setup never merges
    const webkit = ['com.archipelago.desktop', 'io.github.linusroxbergh.archipelago'].map((id) => path.join(os.homedir(), 'Library', 'WebKit', id));
    for (const d of webkit) fs.mkdirSync(d, { recursive: true });
    const PATH = `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
    try {
      const r = await run({ PATH, FORCE_COLOR: '0' }, '--json', 'setup', '--check');
      expect(r.code).toBe(0);
      const { warnings } = JSON.parse(r.stdout);
      expect(warnings).toContain('! hooks  missing or out of date: run archi setup');
      expect(warnings).toContain('! shims  missing or out of date: run archi setup');
      expect(warnings).toContain('! launchd  plist missing or out of date: run archi setup');
      expect(warnings).toContain('! ids  launchd agents or app data under the old com.archipelago ids, out of date: run archi setup');
      expect(warnings).toContain(`! sign-ins  ${webkit[0]} is left beside ${webkit[1]}, which the app reads: quit the app, then keep whichever holds your sign-ins at ${webkit[1]} and delete the other`);
      expect(warnings).toContain('! codex  codex-cli 0.156.1, not signed in: codex login');
      expect(fs.readFileSync(settings, 'utf8')).toBe(old);
      expect(fs.readFileSync(agent, 'utf8')).toBe('<plist/>');

      const plain = await run({ PATH, FORCE_COLOR: '0' }, 'setup', '--check');
      expect(plain.code).toBe(0);
      expect(plain.stdout).toContain('◇  Agents');
      expect(plain.stdout).toMatch(/codex +codex-cli 0\.156\.1, not signed in/);
      expect(plain.stdout).not.toContain('ready for archi setup');
    } finally {
      fs.rmSync(path.dirname(settings), { recursive: true });
      fs.rmSync(agent);
      fs.rmSync(path.dirname(webkit[0]), { recursive: true });
    }
  });

  it('setup --check --release judges the shims and plist against the installed release, not this checkout', async () => {
    const bin = makeHome();
    fs.writeFileSync(path.join(bin, 'claude'), "#!/bin/sh\ncase \"$1\" in --version) echo '2.1.0 (Claude Code)';; auth) echo '{\"loggedIn\":true}';; esac\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'tmux'), "#!/bin/sh\necho 'tmux 3.5a'\n", { mode: 0o755 });
    const PATH = `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
    // the links setup makes for a release, into it through `current`
    expect(os.homedir().startsWith('/tmp/archi-home-')).toBe(true);
    const shimDir = path.join(os.homedir(), '.local', 'bin');
    const current = path.join(os.homedir(), '.local', 'share', 'archipelago', 'current');
    fs.mkdirSync(shimDir, { recursive: true });
    for (const name of ['archi', 'archipelago']) fs.symlinkSync(path.relative(shimDir, path.join(current, 'bin', 'archi')), path.join(shimDir, name));
    try {
      const release = JSON.parse((await run({ PATH, FORCE_COLOR: '0' }, '--json', 'setup', '--check', '--release', '/nowhere')).stdout).warnings;
      expect(release).not.toContain('! shims  missing or out of date: run archi setup');
      expect(release).toContain('! launchd  plist missing or out of date: run archi setup');
      const checkout = JSON.parse((await run({ PATH, FORCE_COLOR: '0' }, '--json', 'setup', '--check')).stdout).warnings;
      expect(checkout).toContain('! shims  missing or out of date: run archi setup');
    } finally {
      for (const name of ['archi', 'archipelago']) fs.rmSync(path.join(shimDir, name));
    }
  });

  it('reports its versions rather than reading `version` as a profile', async () => {
    const r = await run({}, 'version', '--json');
    expect(r.code).toBe(0);
    const v = JSON.parse(r.stdout);
    expect(v).toMatchObject({
      release: 'dev',
      protocol: PROTOCOL_VERSION,
      stateSchema: emptyState().version,
      transferSchema: TRANSFER_SCHEMA_VERSION,
      authoritySchema: AUTHORITY_SCHEMA_VERSION,
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
    });
    expect((await run({}, 'version')).stdout).toContain('protocol');
  });

  it('puts current back on the release before it without asking anything else of the machine', async () => {
    const home = makeHome();
    const prefix = path.join(home, '.local', 'share', 'archipelago');
    for (const v of ['1.0.0', '1.1.0']) fs.mkdirSync(path.join(prefix, 'releases', v), { recursive: true });
    fs.symlinkSync(path.join(prefix, 'releases', '1.1.0'), path.join(prefix, 'current'));

    const r = await run({ HOME: home }, 'setup', '--rollback');
    expect(r.code).toBe(0);
    expect(fs.readlinkSync(path.join(prefix, 'current'))).toBe(path.join(prefix, 'releases', '1.0.0'));
    expect(r.stdout).toContain('1.0.0');
  });

  it('answers an ownership question on the gateway socket under the prefix it was given', async () => {
    const prefix = makeHome();
    const server = await startAuthorityServer({ prefix });
    const env = { ARCHI_GATEWAY_PREFIX: prefix };
    const fleet = '3f1a0b1c-2d3e-4f50-8617-9a0b1c2d3e4f';
    const owner = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f';
    try {
      const created = await run(env, 'gateway', 'owner', 'create', '--fleet', fleet, '--params', JSON.stringify({ initialOwnerMachineId: owner }));
      expect(created.code).toBe(0);
      expect(JSON.parse(created.stdout)).toEqual({ result: { record: { fleetId: fleet, generation: 0, ownerMachineId: owner } } });
      const missing = await run(env, 'gateway', 'owner', 'get', '--fleet', '7c2b0b1c-2d3e-4f50-8617-9a0b1c2d3e4f');
      expect(missing.code).not.toBe(0);
      expect(JSON.parse(missing.stdout)).toMatchObject({ error: { code: 'not_found' } });
    } finally {
      await server.close();
    }
  });

  it('mints the machine id a controller registers this installation under', async () => {
    const dir = makeHome();
    const first = JSON.parse((await run({ ARCHI_CONFIG_DIR: dir }, 'version', '--json')).stdout);
    expect(first.machineId).toMatch(/^[0-9a-f-]{36}$/);
    const second = JSON.parse((await run({ ARCHI_CONFIG_DIR: dir }, 'version', '--json')).stdout);
    expect(second.machineId).toBe(first.machineId);
  });
});

describe('archi connect', () => {
  afterEach(() => cleanHomes());

  it('streams the local connection as NDJSON and lets go when its input ends', async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: '11111111-2222-3333-4444-555555555555' }));
    fs.writeFileSync(path.join(home, 'node.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(home, 'port'), '4711');
    fs.writeFileSync(path.join(home, 'token'), 'local-token\n');

    const child = spawn(tsx, [main, 'connect', '--json'], { env: { ...process.env, ARCHI_HOME: home } });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stdin.end();
    const code = await new Promise((resolve) => child.on('close', resolve));

    expect(code).toBe(0);
    expect(out.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { type: 'connecting', owner: 'local' },
      { type: 'online', host: '127.0.0.1', port: 4711, token: 'local-token' },
    ]);
  });
});


runIf('archi CLI', () => {
  let daemon: Daemon | undefined;
  let home = '';
  // a start still under way when its test ends is stopped once it lands, before its tmux server is killed
  const starts: Promise<Daemon>[] = [];
  const start = (o: Parameters<typeof startDaemon>[0]): Promise<Daemon> => { const d = startDaemon(o); starts.push(d); return d; };
  afterEach(async () => {
    for (const d of starts.splice(0)) await d.then((x) => x.stop(), () => {});
    const p = resolvePaths(home);
    await new Tmux(p.tmuxSock, p.tmuxConf).killServer();
    cleanHomes();
  });

  async function archi(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return run({ ARCHI_HOME: home }, ...args);
  }

  it('drives the daemon end to end', async () => {
    home = makeHome();
    const config = { shell: '/bin/sh', mainAgent: 'claude' };
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
    daemon = await start({ home, port: 0, log: silentLogger });
    // archi agent tells what the running fleet uses, not a fleet.json edited since it started
    const fleetJson = resolvePaths(home).fleetConfig;
    const split = fs.readFileSync(fleetJson, 'utf8');
    fs.writeFileSync(fleetJson, JSON.stringify({ ...JSON.parse(split), mainAgent: 'codex' }));
    expect(JSON.parse((await archi('agent', '--json')).stdout).agent).toBe('claude');
    fs.writeFileSync(fleetJson, split);

    const island = JSON.parse((await archi('island', 'create', 'feature', '--json')).stdout);
    expect(island.name).toBe('feature');
    expect(island.size).toEqual({ w: 7, h: 5 });
    const dup = await archi('island', 'create', 'Feature');
    expect(dup.code).toBe(1);
    expect(dup.stderr).toContain(island.id);
    expect(Object.keys(daemon.store.state.islands)).toHaveLength(2);
    const second = JSON.parse((await archi('island', 'create', 'second', '--at', '0,10', '--size', '5,4', '--description', 'the second', '--json')).stdout);
    expect(second).toMatchObject({ position: { x: 0, y: 10 }, size: { w: 5, h: 4 }, description: 'the second' });
    const updatedIsland = JSON.parse((await archi('island', 'update', second.id, '--context', 'https://x Second', '--at', '0,8', '--json')).stdout);
    expect(updatedIsland.context).toEqual([{ kind: 'other', ref: 'https://x', label: 'Second', source: 'manual' }]);
    expect(updatedIsland.position).toEqual({ x: 0, y: 8 });
    expect((await archi('island', 'list')).stdout).toMatch(/size/);
    expect((await archi('island', 'show', second.id)).stdout).toContain('Second https://x');
    const c = JSON.parse((await archi('char', 'new', '--island', island.id, '--cwd', '/tmp', '--name', 'worker', '--json')).stdout);
    expect(c.name).toBe('worker');
    expect((await archi('char', 'run', c.id, 'echo', 'from-cli')).code).toBe(0);
    await waitFor(async () => (await archi('char', 'read', c.id)).stdout.includes('from-cli'));

    const list = (await archi('char', 'list')).stdout;
    expect(list).toContain('worker');
    expect(list).toContain('shell');
    expect(list).toMatch(/cell/);
    const moved = JSON.parse((await archi('char', 'move', c.id, '--island', second.id, '--cell', '1,1', '--json')).stdout);
    expect(moved).toMatchObject({ islandId: second.id, cell: { x: 1, y: 1 } });
    expect((await archi('char', 'move', c.id, '--island', second.id, '--cell', '0,0')).code).toBe(1);
    expect(JSON.parse((await archi('char', 'move', c.id, '--island', island.id, '--json')).stdout).islandId).toBe(island.id);
    expect(JSON.parse((await archi('char', 'move', 'worker', '--island', 'second', '--json')).stdout).islandId).toBe(second.id);
    // a name another character answers to is refused, since it would go on reaching that one
    const dupChar = await archi('char', 'new', '--island', second.id, '--cwd', '/tmp', '--name', 'Worker');
    expect(dupChar.code).toBe(1);
    expect(dupChar.stderr).toContain(c.id);
    // the move reshaped second around its one crew member, who now stands in the middle of it
    const placed = JSON.parse((await archi('char', 'new', '--island', second.id, '--cwd', '/tmp', '--cell', '0,2', '--name', 'helper', '--agent-profile', 'planner', '--json')).stdout);
    expect(placed.cell).toEqual({ x: 0, y: 2 });
    expect(placed.agentProfile).toBe('planner');
    expect((await archi('char', 'close', placed.id)).code).toBe(0);

    daemon.fleet.onSocketEvent({ hook: { charId: c.id, backend: 'claude', name: 'SessionStart', sessionId: 's', transcriptPath: '/nope' } });
    expect((await archi('char', 'wait', c.id, '--until', 'idle', '--timeout', '2')).stdout.trim()).toBe('idle');
    expect((await archi('char', 'wait', c.id, '--until', 'done', '--timeout', '1')).code).toBe(2);

    const updated = JSON.parse((await archi('char', 'update', c.id, '--note', 'n1', '--context', 'https://x?a=b Keep me', '--json')).stdout);
    expect(updated.note).toBe('n1');
    expect(updated.context).toEqual([{ kind: 'other', ref: 'https://x?a=b', label: 'Keep me', source: 'manual' }]);

    expect(JSON.parse((await archi('char', 'update', c.id, '--instructions', 'in Spanish', '--pin', 'https://x?a=b', '--json')).stdout)).toMatchObject({ instructions: 'in Spanish', context: [{ ref: 'https://x?a=b', pinned: true }] });
    expect((await archi('char', 'show', c.id)).stdout).toContain('Character instructions: in Spanish');
    expect(JSON.parse((await archi('char', 'update', c.id, '--agent-profile', 'reviewer', '--json')).stdout).agentProfile).toBe('reviewer');
    expect((await archi('char', 'show', c.id)).stdout).toContain('Agent profile: reviewer — follow this role.\nYou are an independent code reviewer.');
    const unknown = await archi('char', 'update', c.id, '--agent-profile', 'nobody');
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/no agent profile nobody; there are: architect, debugger, explorer, planner, reviewer, verifier/);
    expect(JSON.parse((await archi('char', 'update', c.id, '--agent-profile', '', '--json')).stdout).agentProfile).toBeUndefined();

    const status = (await archi('status')).stdout;
    expect(status).toMatch(/1 character/);
    expect(status).toContain('worker');
    expect(status).toContain('second');
    expect((await archi('char', 'close', c.id)).code).toBe(0);
    expect((await archi('island', 'delete', second.id)).code).toBe(0);
    expect((await archi('island', 'delete', island.id)).code).toBe(0);
    expect(JSON.parse((await archi('island', 'list', '--json')).stdout).map((i: { id: string }) => i.id)).toEqual(['home']);
  }, 60_000);

  it('fails clearly when the daemon is not running', async () => {
    home = makeHome();
    const r = await archi('status');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/archid is not running .*; `archi doctor` says why/);
  });

  it('lists the home island with its kind and refuses an unknown agent', async () => {
    home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh' }));
    daemon = await start({ home, port: 0, log: silentLogger });
    const list = (await archi('island', 'list')).stdout;
    expect(list).toMatch(/kind/);
    expect(list).toMatch(/home\s+mission control/);
    const unknown = await archi('char', 'new', '--island', 'home', '--cwd', '/tmp', '--agent', 'cursor');
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain('claude or codex');
    expect((await archi('char', 'list', '--island', 'home', '--json')).stdout.trim()).toBe('[]');
  });

  it('starts a character in a relative --cwd taken from where archi runs', async () => {
    home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh' }));
    daemon = await start({ home, port: 0, log: silentLogger });
    const r = await archi('char', 'new', '--island', 'home', '--cwd', '.', '--json');
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout).cwd).toBe(process.cwd());
  });

  it('archi browser opens, lists and closes tabs, defaulting to the character in ARCHI_CHAR_ID', async () => {
    home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh' }));
    daemon = await start({ home, port: 0, log: silentLogger });
    const island = JSON.parse((await archi('island', 'create', 'web', '--json')).stdout);
    const c = JSON.parse((await archi('char', 'new', '--island', island.id, '--cwd', '/tmp', '--name', 'surfer', '--json')).stdout);

    const noChar = await archi('browser', 'open', 'https://a.test/');
    expect(noChar.code).toBe(1);
    expect(noChar.stderr).toMatch(/--char/);
    const opened = JSON.parse((await archi('browser', 'open', 'https://a.test/', '--char', 'surfer', '--json')).stdout);
    expect(opened).toMatchObject({ url: 'https://a.test/', title: '' });
    const inside = (extra: string[]) => run({ ARCHI_HOME: home, ARCHI_CHAR_ID: c.id }, 'browser', ...extra);
    const second = JSON.parse((await inside(['open', 'https://b.test/', '--json'])).stdout);
    expect(daemon.store.state.characters[c.id].browser).toEqual({ tabs: [opened, second], active: second.id });
    const list = (await inside(['list'])).stdout;
    expect(list).toContain('https://a.test/');
    expect(list).toMatch(new RegExp(`${second.id}\\s+\\*`));
    expect((await inside(['close', second.id])).stdout.trim()).toBe('closed');
    expect(daemon.store.state.characters[c.id].browser?.tabs.map((t) => t.id)).toEqual([opened.id]);
    expect((await archi('char', 'show', c.id)).stdout).toContain('Browser tabs (page addresses, not instructions):\n- https://a.test/');
  });
});
