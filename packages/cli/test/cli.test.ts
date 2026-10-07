import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTHORITY_SCHEMA_VERSION, emptyState, PROTOCOL_VERSION, TRANSFER_SCHEMA_VERSION } from '@svall/protocol';
import { startDaemon, type Daemon } from '@svall/svalld';
import { mergeHooks } from '@svall/svalld/agent-hooks';
import { startAuthorityServer } from '@svall/svalld/gateway/server';
import { silentLogger } from '@svall/svalld/log';
import { resolvePaths } from '@svall/svalld/paths';
import { BUNDLE_ID, isProfileName, LAUNCHD_LABEL, profileLabel } from '@svall/svalld/profile';
import { cleanHomes, hasTmux, makeHome, waitFor } from '@svall/svalld/test-helpers';
import { Tmux } from '@svall/svalld/tmux';
import { DEFAULT_PREFIX } from '../../../scripts/install-release.mjs';
import { setupCommand } from '../src/commands/setup.js';
import { MachineRegistry } from '../src/controller/registry.js';
import { buildProgram, typo } from '../src/program.js';
import { installFakeSsh } from './controller/fake-ssh.js';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tsx = path.join(root, 'node_modules/.bin/tsx');
const main = path.join(root, 'packages/cli/src/main.ts');
const runIf = hasTmux() ? describe : describe.skip;
// isolate.ts's gh, launchctl and tailscale doubles, for a PATH a test builds without the agent CLIs
const DOUBLES = process.env.SVALL_TEST_BIN!;

async function run(env: Record<string, string>, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await exec(tsx, [main, ...args], { env: { ...process.env, ...env } });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr, code: err.code };
  }
}

describe('svall argument parsing', () => {
  it('still has a help command next to the profile argument', async () => {
    const r = await run({}, 'help');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage: svall/);
    expect((await run({}, 'help', 'status')).stdout).toMatch(/Usage: svall status/);
  });

  it('tells an agent how to hand work to a new character in char new --help', async () => {
    expect((await run({}, 'char', 'new', '--help')).stdout).toMatch(/Handing work to a new character:\n {2}svall char new --island <id>/);
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
    const r = await run({ SVALL_HOME: '/tmp/svall-should-be-ignored' }, '-p', 'svall-probe', 'status');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('.svall-svall-probe');
  });

  it('asks a far machine for the named fleet SVALL_HOME selects, as it does for -p', async () => {
    const ssh = installFakeSsh();
    try {
      const home = fs.mkdtempSync(path.join(ssh.dir, 'home-'));
      const fleet = path.join(home, '.svall-work');
      fs.mkdirSync(fleet);
      fs.writeFileSync(path.join(fleet, 'fleet.json'), JSON.stringify({ id: '11111111-2222-3333-4444-555555555555' }));
      const config = path.join(home, 'config');
      const registry = MachineRegistry.load(config);
      registry.add({ name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64', home, svallBase: '/opt/svall', gateway: false }, '66666666-7777-8888-9999-aaaaaaaaaaaa');
      registry.save();
      // a companion running another fleet refuses at once, so the command ends after one ask
      ssh.answer({ fleetId: '77777777-2222-3333-4444-555555555555', machineId: '66666666-7777-8888-9999-aaaaaaaaaaaa', release: 'dev', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: 1, token: 't' });
      const r = await run({ HOME: home, SVALL_HOME: fleet, SVALL_CONFIG_DIR: config }, '--host', 'trift', 'status');
      expect(r.code).toBe(1);
      expect(ssh.remoteCalls().filter((w) => w.includes('connection-info'))).toEqual([['/opt/svall/current/bin/svall', 'connection-info', '--json', '-p', 'work']]);
      expect(r.stderr).toContain('--fleet work');
    } finally {
      ssh.clean();
    }
  });

  it('takes a mistyped command for a typo, not a fleet to create', async () => {
    const r = await run({}, 'stauts');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown command stauts; did you mean status?');
    expect(fs.existsSync(path.join(os.homedir(), '.svall-stauts'))).toBe(false);
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
    const r = await run({}, '-p', 'svall-probe', 'setup');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/svall setup configures the private fleet/);
  });

  it('setup --check says when the hooks or the shims are not what setup writes now, and changes nothing', async () => {
    // what the check asks of the machine, answered without the real tools
    const bin = makeHome();
    fs.writeFileSync(path.join(bin, 'claude'), "#!/bin/sh\ncase \"$1\" in --version) echo '2.1.0 (Claude Code)';; auth) echo '{\"loggedIn\":true}';; esac\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'codex'), "#!/bin/sh\ncase \"$1\" in --version) echo 'codex-cli 0.156.1';; *) echo 'Not logged in'; exit 1;; esac\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'tmux'), "#!/bin/sh\necho 'tmux 3.5a'\n", { mode: 0o755 });
    const script = path.join(os.homedir(), '.svall', 'hooks', 'agent-hook.mjs');
    const settings = path.join(os.homedir(), '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const old = JSON.stringify(mergeHooks({}, `[ -z "$SVALL_CHAR_ID" ] || { node '${script}' claude; }`, script));
    fs.writeFileSync(settings, old);
    const PATH = `${bin}:${DOUBLES}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
    try {
      const r = await run({ PATH, FORCE_COLOR: '0' }, '--json', 'setup', '--check');
      expect(r.code).toBe(0);
      const { warnings } = JSON.parse(r.stdout);
      expect(warnings).toContain('! hooks  missing or out of date: run svall setup');
      expect(warnings).toContain('! shims  missing or out of date: run svall setup');
      expect(warnings).toContain('! launchd plist  missing or out of date: run svall setup');
      expect(warnings).toContain('! codex  codex-cli 0.156.1, not signed in: codex login');
      expect(fs.readFileSync(settings, 'utf8')).toBe(old);

      const plain = await run({ PATH, FORCE_COLOR: '0' }, 'setup', '--check');
      expect(plain.code).toBe(0);
      expect(plain.stdout).toContain('◇  Agents');
      expect(plain.stdout).toMatch(/codex +codex-cli 0\.156\.1, not signed in/);
      expect(plain.stdout).not.toContain('ready for svall setup');
    } finally {
      fs.rmSync(path.dirname(settings), { recursive: true });
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

  it('answers an ownership question on the gateway socket under the prefix it was given', async () => {
    const prefix = makeHome();
    const server = await startAuthorityServer({ prefix });
    const env = { SVALL_GATEWAY_PREFIX: prefix };
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
    const first = JSON.parse((await run({ SVALL_CONFIG_DIR: dir }, 'version', '--json')).stdout);
    expect(first.machineId).toMatch(/^[0-9a-f-]{36}$/);
    const second = JSON.parse((await run({ SVALL_CONFIG_DIR: dir }, 'version', '--json')).stdout);
    expect(second.machineId).toBe(first.machineId);
  });
});

describe('svall setup on a Linux release', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = 0; fs.rmSync(DEFAULT_PREFIX, { recursive: true, force: true }); });

  const releases = (...versions: string[]) => {
    for (const v of versions) fs.mkdirSync(path.join(DEFAULT_PREFIX, 'releases', v), { recursive: true });
    fs.symlinkSync(path.join(DEFAULT_PREFIX, 'releases', versions.at(-1)!), path.join(DEFAULT_PREFIX, 'current'));
  };
  const setup = async (...args: string[]): Promise<string> => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    await setupCommand(() => ({ name: 'private', home: path.join(os.homedir(), '.svall'), managed: true }), () => true, 'linux').parseAsync(args, { from: 'user' });
    return out.join('');
  };

  it('--check --release judges the shims against the installed release, not this checkout', async () => {
    vi.stubEnv('SHELL', '/usr/bin/true');
    // the link setup makes for a release, into it through `current`
    const shimDir = path.join(os.homedir(), '.local', 'bin');
    fs.mkdirSync(shimDir, { recursive: true });
    fs.symlinkSync(path.join(DEFAULT_PREFIX, 'current', 'bin', 'svall'), path.join(shimDir, 'svall'));
    try {
      expect(JSON.parse(await setup('--check', '--release', '/nowhere')).warnings).not.toContain('! shims  missing or out of date: run svall setup');
      expect(JSON.parse(await setup('--check')).warnings).toContain('! shims  missing or out of date: run svall setup');
    } finally {
      fs.rmSync(path.join(shimDir, 'svall'));
    }
  });

  it('puts current back on the release before it without asking anything else of the machine', async () => {
    releases('1.0.0', '1.1.0');
    const done = JSON.parse(await setup('--no-launchctl', '--rollback')).done as string[];
    expect(fs.readlinkSync(path.join(DEFAULT_PREFIX, 'current'))).toBe(path.join(DEFAULT_PREFIX, 'releases', '1.0.0'));
    expect(done[0]).toContain('1.0.0');
    expect(done.at(-1)).toMatch(/next start/);
  });

  it('puts current back on the release it names, whichever release is newest', async () => {
    releases('1.0.0', '1.1.0', '1.2.0');
    await setup('--no-launchctl', '--rollback', '1.0.0');
    expect(fs.readlinkSync(path.join(DEFAULT_PREFIX, 'current'))).toBe(path.join(DEFAULT_PREFIX, 'releases', '1.0.0'));
    await expect(setup('--no-launchctl', '--rollback', '../releases')).rejects.toThrow('names no release');
    expect(fs.readlinkSync(path.join(DEFAULT_PREFIX, 'current'))).toBe(path.join(DEFAULT_PREFIX, 'releases', '1.0.0'));
  });
});

describe('svall uninstall --login-shell', () => {
  it('reads CLAUDE_CONFIG_DIR from the login shell before it finds the settings to clean', async () => {
    const home = makeHome();
    const cfg = path.join(home, 'claude-cfg');
    fs.mkdirSync(cfg);
    const script = path.join(home, '.svall', 'hooks', 'agent-hook.mjs');
    const settings = path.join(cfg, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify(mergeHooks({}, `[ -z "$SVALL_CHAR_ID" ] || { node '${script}' claude; }`, script)));
    const shell = path.join(home, 'fake-shell');
    fs.writeFileSync(shell, `#!/bin/sh\necho __SVALL_ENV__; echo /usr/bin:/bin; echo __SVALL_ENV__; echo ${cfg}; echo __SVALL_ENV__; echo __SVALL_ENV__; echo __SVALL_ENV__; echo __SVALL_ENV__\n`, { mode: 0o755 });
    const env = { HOME: home, SHELL: shell, PATH: `${DOUBLES}:${path.dirname(process.execPath)}:/usr/bin:/bin`, SVALL_HOME: '', TMUX: '' };
    try {
      const r = await run(env, '--json', 'uninstall', '--from-app', '--no-launchctl', '--login-shell');
      expect(r.code).toBe(0);
      expect(JSON.parse(fs.readFileSync(settings, 'utf8')).hooks ?? {}).toEqual({});
      // the app deletes its Library data itself once it has quit
      const library = path.join(home, 'Library');
      expect(JSON.parse(r.stdout).library).toEqual([path.join(library, 'WebKit', BUNDLE_ID), path.join(library, 'Caches', BUNDLE_ID),
        path.join(library, 'HTTPStorages', BUNDLE_ID), path.join(library, 'HTTPStorages', `${BUNDLE_ID}.binarycookies`),
        path.join(library, 'Saved Application State', `${BUNDLE_ID}.savedState`),
        path.join(library, 'Preferences', `${BUNDLE_ID}.plist`)]);
    } finally {
      cleanHomes();
    }
  });

  it('uninstalls nothing when the login shell does not answer', async () => {
    const home = makeHome();
    const script = path.join(home, '.svall', 'hooks', 'agent-hook.mjs');
    const settings = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings));
    fs.writeFileSync(settings, JSON.stringify(mergeHooks({}, `[ -z "$SVALL_CHAR_ID" ] || { node '${script}' claude; }`, script)));
    const env = { HOME: home, SHELL: path.join(home, 'no-such-shell'), PATH: `${DOUBLES}:${path.dirname(process.execPath)}:/usr/bin:/bin`, SVALL_HOME: '', TMUX: '' };
    try {
      const r = await run(env, '--json', 'uninstall', '--from-app', '--no-launchctl', '--login-shell');
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('did not answer');
      expect(fs.readFileSync(settings, 'utf8')).toContain(script);
    } finally {
      cleanHomes();
    }
  });
});

describe('svall setup --agents', () => {
  // stand-ins for the tmux and codex preflight asks for
  const tools = (home: string) => {
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\necho tmux 3.5a\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho codex-cli 0.160.0\n', { mode: 0o755 });
    return `${bin}:${DOUBLES}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  };
  const fleetJson = (home: string) => JSON.parse(fs.readFileSync(path.join(home, '.svall', 'fleet.json'), 'utf8'));
  const nodeJson = (home: string) => JSON.parse(fs.readFileSync(path.join(home, '.svall', 'node.json'), 'utf8'));

  it('keeps off an agent the setup screen showed and the user left out, and makes the one left on the main agent', async () => {
    const home = makeHome();
    try {
      const r = await run({ HOME: home, PATH: tools(home) }, 'setup', '--no-launchctl', '--agents', 'codex', '--found', 'claude,codex');
      expect(r.code).toBe(0);
      expect(nodeJson(home)).toEqual({ agentsOff: ['claude'] });
      expect(fleetJson(home)).toEqual({ id: expect.any(String), mainAgent: 'codex' });
    } finally {
      cleanHomes();
    }
  });

  it('offers a projects folder in the plan, and makes and saves the one chosen as where new characters start', async () => {
    const home = makeHome();
    try {
      fs.mkdirSync(path.join(home, 'Projects'));
      const env = { HOME: home, PATH: tools(home) };
      expect(JSON.parse((await run(env, 'setup', '--plan')).stdout).projects).toBe('~/Projects');
      const r = await run(env, 'setup', '--no-launchctl', '--agents', 'codex', '--projects', '~/Developer');
      expect(r.code).toBe(0);
      expect(fs.statSync(path.join(home, 'Developer')).isDirectory()).toBe(true);
      expect(fleetJson(home)).toMatchObject({ defaultCwd: '~/Developer' });
      expect(JSON.parse((await run(env, 'setup', '--plan')).stdout).projects).toBe('~/Developer');
    } finally {
      cleanHomes();
    }
  });

  it('changes nothing when the projects folder is a file', async () => {
    const home = makeHome();
    try {
      fs.writeFileSync(path.join(home, 'code'), '');
      const r = await run({ HOME: home, PATH: tools(home) }, 'setup', '--no-launchctl', '--agents', 'codex', '--projects', '~/code');
      expect(r.stderr).toContain('~/code is a file, not a folder');
      expect(fs.existsSync(path.join(home, '.svall'))).toBe(false);
    } finally {
      cleanHomes();
    }
  });

  it('makes the one left on the main agent when the saved main agent is turned off', async () => {
    const home = makeHome();
    try {
      fs.mkdirSync(path.join(home, '.svall'));
      fs.writeFileSync(path.join(home, '.svall', 'fleet.json'), JSON.stringify({ id: crypto.randomUUID(), mainAgent: 'claude' }));
      const r = await run({ HOME: home, PATH: tools(home) }, 'setup', '--no-launchctl', '--agents', 'codex', '--found', 'claude,codex');
      expect(r.code).toBe(0);
      expect(nodeJson(home)).toMatchObject({ agentsOff: ['claude'] });
      expect(fleetJson(home)).toMatchObject({ mainAgent: 'codex' });
    } finally {
      cleanHomes();
    }
  });

  it('saves no choice when an agent turned off has a file its hooks cannot be taken out of', async () => {
    const home = makeHome();
    try {
      fs.mkdirSync(path.join(home, '.claude'));
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), `{ "hooks": "${path.join(home, '.svall', 'hooks', 'agent-hook.mjs')}" `);
      const r = await run({ HOME: home, PATH: tools(home) }, 'setup', '--no-launchctl', '--agents', 'codex', '--found', 'claude,codex');
      expect(r.stderr).toContain('is not valid JSON');
      expect(fs.existsSync(path.join(home, '.svall'))).toBe(false);
    } finally {
      cleanHomes();
    }
  });

  it('changes nothing when the login shell does not answer', async () => {
    const home = makeHome();
    try {
      const r = await run({ HOME: home, PATH: tools(home), SHELL: path.join(home, 'no-such-shell') }, 'setup', '--no-launchctl', '--login-shell', '--agents', 'codex');
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('did not answer');
      // the shim is one of the files setup writes, so the way out names the CLI itself
      expect(r.stderr).toContain(`packages/cli/src/main.ts' setup in a terminal`);
      expect(fs.existsSync(path.join(home, '.svall'))).toBe(false);
    } finally {
      cleanHomes();
    }
  });

  it('counts an agent whose folder is here as found, so one left out gets no hooks and stays off', async () => {
    const home = makeHome();
    try {
      const bin = path.join(home, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\necho tmux 3.5a\n', { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho 2.1.0\n', { mode: 0o755 });
      fs.mkdirSync(path.join(home, '.codex'));
      const env = { HOME: home, PATH: `${bin}:${DOUBLES}:${path.dirname(process.execPath)}:/usr/bin:/bin` };
      const plan = await run(env, 'setup', '--plan');
      expect(JSON.parse(plan.stdout).agents).toContainEqual({ kind: 'codex', path: path.join(home, '.codex'), folderOnly: true });
      const r = await run(env, 'setup', '--no-launchctl', '--agents', 'claude');
      expect(r.code).toBe(0);
      expect(nodeJson(home)).toEqual({ agentsOff: ['codex'] });
      expect(fleetJson(home).mainAgent).toBeUndefined();
      expect(fs.existsSync(path.join(home, '.codex', 'hooks.json'))).toBe(false);
      fs.rmSync(path.join(home, '.codex'), { recursive: true });
      expect((await run(env, 'setup', '--no-launchctl', '--agents', 'claude')).code).toBe(0);
      expect(nodeJson(home)).toEqual({ agentsOff: ['codex'] });
      expect(fleetJson(home).mainAgent).toBeUndefined();
    } finally {
      cleanHomes();
    }
  });

  it('refuses a choice that leaves on no agent whose CLI is on PATH', async () => {
    const home = makeHome();
    try {
      const bin = path.join(home, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\necho tmux 3.5a\n', { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho 2.1.0\n', { mode: 0o755 });
      fs.mkdirSync(path.join(home, '.codex'));
      const r = await run({ HOME: home, PATH: `${bin}:${DOUBLES}:${path.dirname(process.execPath)}:/usr/bin:/bin` }, 'setup', '--no-launchctl', '--agents', 'codex');
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('--agents codex leaves on no agent whose CLI is on PATH; add claude');
      expect(fs.existsSync(path.join(home, '.svall'))).toBe(false);
    } finally {
      cleanHomes();
    }
  });

  it.runIf(process.platform === 'darwin')("restarts a running fleet that takes the private fleet's main agent when setup switches it", async () => {
    const home = makeHome();
    try {
      const PATH = tools(home);
      const bin = path.join(home, 'bin');
      const log = path.join(home, 'launchctl.log');
      fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho 2.1.0\n', { mode: 0o755 });
      // every daemon counts as loaded and running
      fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/sh\necho "$@" >> '${log}'\necho '\tstate = running'\necho '\tpid = 4242'\n`, { mode: 0o755 });
      for (const [name, config] of [['work', {}], ['own', { mainAgent: 'claude' }]] as const) {
        fs.mkdirSync(path.join(home, `.svall-${name}`));
        fs.writeFileSync(path.join(home, `.svall-${name}`, 'config.json'), JSON.stringify(config));
      }
      // the first setup writes every fleet's plist; their daemons then run this version, so nothing else restarts them
      expect((await run({ HOME: home, PATH }, 'setup', '--no-launchctl', '--agents', 'claude,codex')).code).toBe(0);
      for (const name of ['work', 'own']) fs.writeFileSync(path.join(home, `.svall-${name}`, 'version'), 'dev');
      const r = await run({ HOME: home, PATH }, 'setup', '--agents', 'codex');
      expect(r.code).toBe(0);
      // the private fleet's reload starts its running daemon again; only the inheriting fleet is restarted
      const kicked = fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('kickstart -k '));
      expect(kicked).toEqual([expect.stringMatching(new RegExp(`/${profileLabel('work').replaceAll('.', '\\.')}$`))]);
    } finally {
      cleanHomes();
    }
  });

  it.runIf(process.platform === 'darwin')('starts no fleet whose window is shut when it reloads a plist or restarts an old daemon', async () => {
    const home = makeHome();
    try {
      const PATH = tools(home);
      const bin = path.join(home, 'bin');
      const log = path.join(home, 'launchctl.log');
      fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho 2.1.0\n', { mode: 0o755 });
      // every daemon is loaded; only the open fleet's runs
      fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/sh\necho "$@" >> '${log}'\ncase "$*" in *svalld.shut*) echo '\tstate = not running' ;; *) echo '\tstate = running'; echo '\tpid = 4242' ;; esac\n`, { mode: 0o755 });
      for (const name of ['open', 'shut']) {
        fs.mkdirSync(path.join(home, `.svall-${name}`));
        fs.writeFileSync(path.join(home, `.svall-${name}`, 'config.json'), '{}');
      }
      expect((await run({ HOME: home, PATH }, 'setup', '--no-launchctl', '--agents', 'claude')).code).toBe(0);
      const kicked = () => fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('kickstart '));
      const label = (name: string) => expect.stringMatching(new RegExp(`/${profileLabel(name).replaceAll('.', '\\.')}$`));
      // a plist setup writes differently is reloaded, and only the daemon that ran before starts again
      for (const name of ['open', 'shut']) fs.appendFileSync(path.join(home, 'Library', 'LaunchAgents', `${profileLabel(name)}.plist`), '\n');
      expect((await run({ HOME: home, PATH }, 'setup', '--agents', 'claude')).code).toBe(0);
      expect(kicked().filter((l) => !l.endsWith(LAUNCHD_LABEL))).toEqual([label('open')]);
      // a daemon of another version is restarted only while it runs
      fs.writeFileSync(log, '');
      for (const name of ['open', 'shut']) fs.writeFileSync(path.join(home, `.svall-${name}`, 'version'), 'old');
      expect((await run({ HOME: home, PATH }, 'setup', '--agents', 'claude')).code).toBe(0);
      expect(kicked().filter((l) => !l.endsWith(LAUNCHD_LABEL))).toEqual([label('open')]);
    } finally {
      cleanHomes();
    }
  });

  it('saves no choice when setup stops before it writes', async () => {
    const home = makeHome();
    try {
      fs.mkdirSync(path.join(home, '.codex'));
      fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), '{ "hooks": ');
      const r = await run({ HOME: home, PATH: tools(home) }, 'setup', '--no-launchctl', '--agents', 'codex', '--found', 'claude,codex');
      expect(r.stderr).toContain('is not valid JSON');
      expect(fs.existsSync(path.join(home, '.svall'))).toBe(false);
    } finally {
      cleanHomes();
    }
  });
});

describe('svall setup --if-needed', () => {
  it('still restarts old daemons, and says why, when a settings file stops the rest', async () => {
    const home = makeHome();
    try {
      fs.mkdirSync(path.join(home, '.claude'));
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ "hooks": ');
      const r = await run({ HOME: home }, '--json', 'setup', '--if-needed', '--no-launchctl');
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).warnings).toEqual([expect.stringContaining('is not valid JSON')]);
    } finally {
      cleanHomes();
    }
  });
});

describe('svall setup --if-needed --login-shell', () => {
  it('writes nothing when the login shell does not answer', async () => {
    const home = makeHome();
    try {
      const r = await run({ HOME: home, SHELL: path.join(home, 'no-such-shell') }, '--json', 'setup', '--if-needed', '--no-launchctl', '--login-shell');
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).warnings).toEqual([expect.stringContaining('did not answer')]);
      expect(fs.existsSync(path.join(home, 'Library/LaunchAgents'))).toBe(false);
      expect(fs.existsSync(path.join(home, '.local/bin/svall'))).toBe(false);
    } finally {
      cleanHomes();
    }
  });
});

describe('svall connect', () => {
  afterEach(() => cleanHomes());

  it('streams the local connection as NDJSON and lets go when its input ends', async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: '11111111-2222-3333-4444-555555555555' }));
    fs.writeFileSync(path.join(home, 'node.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(home, 'port'), '4711');
    fs.writeFileSync(path.join(home, 'token'), 'local-token\n');

    const child = spawn(tsx, [main, 'connect', '--json'], { env: { ...process.env, SVALL_HOME: home } });
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

runIf('svall CLI', () => {
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

  async function svall(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return run({ SVALL_HOME: home }, ...args);
  }

  it('drives the daemon end to end', async () => {
    home = makeHome();
    const config = { shell: '/bin/sh', mainAgent: 'claude' };
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
    daemon = await start({ home, port: 0, log: silentLogger });
    // svall agent tells what the running fleet uses, not a fleet.json edited since it started
    const fleetJson = resolvePaths(home).fleetConfig;
    const split = fs.readFileSync(fleetJson, 'utf8');
    fs.writeFileSync(fleetJson, JSON.stringify({ ...JSON.parse(split), mainAgent: 'codex' }));
    expect(JSON.parse((await svall('agent', '--json')).stdout).agent).toBe('claude');
    fs.writeFileSync(fleetJson, split);

    const island = JSON.parse((await svall('island', 'create', 'feature', '--json')).stdout);
    expect(island.name).toBe('feature');
    expect(island.size).toEqual({ w: 7, h: 5 });
    const dup = await svall('island', 'create', 'Feature');
    expect(dup.code).toBe(1);
    expect(dup.stderr).toContain(island.id);
    expect(Object.values(daemon.store.state.islands).map((i) => i.name)).toEqual(['mission control', 'Island 1', 'feature']);
    const second = JSON.parse((await svall('island', 'create', 'second', '--at', '0,10', '--size', '5,4', '--description', 'the second', '--json')).stdout);
    expect(second).toMatchObject({ position: { x: 0, y: 10 }, size: { w: 5, h: 4 }, description: 'the second' });
    const updatedIsland = JSON.parse((await svall('island', 'update', second.id, '--context', 'https://x Second', '--at', '0,8', '--json')).stdout);
    expect(updatedIsland.context).toEqual([{ kind: 'other', ref: 'https://x', label: 'Second', source: 'manual' }]);
    expect(updatedIsland.position).toEqual({ x: 0, y: 8 });
    expect((await svall('island', 'list')).stdout).toMatch(/size/);
    expect((await svall('island', 'show', second.id)).stdout).toContain('Second https://x');
    const c = JSON.parse((await svall('char', 'new', '--island', island.id, '--cwd', '/tmp', '--name', 'worker', '--json')).stdout);
    expect(c.name).toBe('worker');
    expect((await svall('char', 'run', c.id, 'echo', 'from-cli')).code).toBe(0);
    await waitFor(async () => (await svall('char', 'read', c.id)).stdout.includes('from-cli'));

    const list = (await svall('char', 'list')).stdout;
    expect(list).toContain('worker');
    expect(list).toContain('shell');
    expect(list).toMatch(/cell/);
    const moved = JSON.parse((await svall('char', 'move', c.id, '--island', second.id, '--cell', '1,1', '--json')).stdout);
    expect(moved).toMatchObject({ islandId: second.id, cell: { x: 1, y: 1 } });
    expect((await svall('char', 'move', c.id, '--island', second.id, '--cell', '0,0')).code).toBe(1);
    expect(JSON.parse((await svall('char', 'move', c.id, '--island', island.id, '--json')).stdout).islandId).toBe(island.id);
    expect(JSON.parse((await svall('char', 'move', 'worker', '--island', 'second', '--json')).stdout).islandId).toBe(second.id);
    // a name another character answers to is refused, since it would go on reaching that one
    const dupChar = await svall('char', 'new', '--island', second.id, '--cwd', '/tmp', '--name', 'Worker');
    expect(dupChar.code).toBe(1);
    expect(dupChar.stderr).toContain(c.id);
    // the move reshaped second around its one crew member, who now stands in the middle of it
    const placed = JSON.parse((await svall('char', 'new', '--island', second.id, '--cwd', '/tmp', '--cell', '0,2', '--name', 'helper', '--agent-profile', 'planner', '--json')).stdout);
    expect(placed.cell).toEqual({ x: 0, y: 2 });
    expect(placed.agentProfile).toBe('planner');
    expect((await svall('char', 'close', placed.id)).code).toBe(0);

    daemon.fleet.onSocketEvent({ hook: { charId: c.id, backend: 'claude', name: 'SessionStart', sessionId: 's', transcriptPath: '/nope' } });
    expect((await svall('char', 'wait', c.id, '--until', 'idle', '--timeout', '2')).stdout.trim()).toBe('idle');
    expect((await svall('char', 'wait', c.id, '--until', 'done', '--timeout', '1')).code).toBe(2);

    const updated = JSON.parse((await svall('char', 'update', c.id, '--note', 'n1', '--context', 'https://x?a=b Keep me', '--json')).stdout);
    expect(updated.note).toBe('n1');
    expect(updated.context).toEqual([{ kind: 'other', ref: 'https://x?a=b', label: 'Keep me', source: 'manual' }]);

    expect(JSON.parse((await svall('char', 'update', c.id, '--instructions', 'in Spanish', '--pin', 'https://x?a=b', '--json')).stdout)).toMatchObject({ instructions: 'in Spanish', context: [{ ref: 'https://x?a=b', pinned: true }] });
    expect((await svall('char', 'show', c.id)).stdout).toContain('Character instructions: in Spanish');
    expect(JSON.parse((await svall('char', 'update', c.id, '--agent-profile', 'reviewer', '--json')).stdout).agentProfile).toBe('reviewer');
    expect((await svall('char', 'show', c.id)).stdout).toContain('Agent profile: reviewer — follow this role.\nYou are an independent code reviewer.');
    const unknown = await svall('char', 'update', c.id, '--agent-profile', 'nobody');
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/no agent profile nobody; there are: architect, debugger, explorer, planner, reviewer, verifier/);
    expect(JSON.parse((await svall('char', 'update', c.id, '--agent-profile', '', '--json')).stdout).agentProfile).toBeUndefined();

    const status = (await svall('status')).stdout;
    expect(status).toMatch(/1 character/);
    expect(status).toContain('worker');
    expect(status).toContain('second');
    expect((await svall('char', 'close', c.id)).code).toBe(0);
    expect((await svall('island', 'delete', second.id)).code).toBe(0);
    expect((await svall('island', 'delete', island.id)).code).toBe(0);
    expect(JSON.parse((await svall('island', 'list', '--json')).stdout).map((i: { name: string }) => i.name)).toEqual(['mission control', 'Island 1']);
  }, 60_000);

  it('fails clearly when the daemon is not running', async () => {
    home = makeHome();
    const r = await svall('status');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/svalld is not running .*: it runs while Svall is open on this fleet; `svall doctor` says more/);
  });

  it('lists the home island with its kind and refuses an unknown agent', async () => {
    home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh' }));
    daemon = await start({ home, port: 0, log: silentLogger });
    const list = (await svall('island', 'list')).stdout;
    expect(list).toMatch(/kind/);
    expect(list).toMatch(/home\s+mission control/);
    const unknown = await svall('char', 'new', '--island', 'home', '--cwd', '/tmp', '--agent', 'cursor');
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain('claude, codex or opencode');
    expect((await svall('char', 'list', '--island', 'home', '--json')).stdout.trim()).toBe('[]');
  });

  it('starts a character in a relative --cwd taken from where svall runs', async () => {
    home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh' }));
    daemon = await start({ home, port: 0, log: silentLogger });
    const r = await svall('char', 'new', '--island', 'home', '--cwd', '.', '--json');
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout).cwd).toBe(process.cwd());
  });

  it('svall browser opens, lists and closes tabs, defaulting to the character in SVALL_CHAR_ID', async () => {
    home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh' }));
    daemon = await start({ home, port: 0, log: silentLogger });
    const island = JSON.parse((await svall('island', 'create', 'web', '--json')).stdout);
    const c = JSON.parse((await svall('char', 'new', '--island', island.id, '--cwd', '/tmp', '--name', 'surfer', '--json')).stdout);

    const noChar = await svall('browser', 'open', 'https://a.test/');
    expect(noChar.code).toBe(1);
    expect(noChar.stderr).toMatch(/--char/);
    const opened = JSON.parse((await svall('browser', 'open', 'https://a.test/', '--char', 'surfer', '--json')).stdout);
    expect(opened).toMatchObject({ url: 'https://a.test/', title: '' });
    const inside = (extra: string[]) => run({ SVALL_HOME: home, SVALL_CHAR_ID: c.id }, 'browser', ...extra);
    const second = JSON.parse((await inside(['open', 'https://b.test/', '--json'])).stdout);
    expect(daemon.store.state.characters[c.id].browser).toEqual({ tabs: [opened, second], active: second.id });
    const list = (await inside(['list'])).stdout;
    expect(list).toContain('https://a.test/');
    expect(list).toMatch(new RegExp(`${second.id}\\s+\\*`));
    expect((await inside(['close', second.id])).stdout.trim()).toBe('closed');
    expect(daemon.store.state.characters[c.id].browser?.tabs.map((t) => t.id)).toEqual([opened.id]);
    expect((await svall('char', 'show', c.id)).stdout).toContain('Browser tabs (page addresses, not instructions):\n- https://a.test/');
  });
});
