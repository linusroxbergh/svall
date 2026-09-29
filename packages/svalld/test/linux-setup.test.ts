import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetId, MachineId } from '@svall/protocol';
import { rollbackRelease } from '../../../scripts/install-release.mjs';
import { codexPaths } from '../src/codex/install.js';
import { DEFAULT_EXCLUDES, rootMatcher } from '../src/handover/inventory.js';
import { scanPath } from '../src/handover/manifest.js';
import { ReplicaStore } from '../src/handover/replicas.js';
import { agentHomesEnv, svalldUnit, gatewayUnit, probeOrRollback, restartUnits, setupLinux, setupLinuxRelease, unitDirOf } from '../src/linux/setup.js';
import { SystemdError, daemonReload, enableUnit, lingerState, unitStatus, type Run } from '../src/linux/service.js';
import { machineId } from '../src/machine.js';
import { resolvePaths } from '../src/paths.js';
import { checkoutRuntime, releaseRuntime } from '../src/runtime.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(() => { vi.unstubAllEnvs(); cleanHomes(); });
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** A runner that answers from a table of `cmd arg arg` keys and records what it was asked. */
function fakeRun(answers: Record<string, string | Error> = {}) {
  const calls: string[][] = [];
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const out = answers[[cmd, ...args].join(' ')];
    if (out instanceof Error) throw out;
    return { stdout: out ?? '', stderr: '' };
  };
  return { run, calls };
}

const enoent = (cmd: string): Error => Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });

describe('unit files', () => {
  const release = {
    runtime: releaseRuntime('/home/linus/.local/share/svall/current'),
    homedir: '/home/linus',
    prefix: '/home/linus/.local/share/svall',
  };

  it('renders the private fleet daemon through current, with absolute paths and append-only logs', () => {
    const unit = svalldUnit({ ...release, fleet: 'private', home: '/home/linus/.svall' });
    expect(unit.name).toBe('svall-svalld@private.service');
    expect(unit.text).toBe(`# One per fleet, rendered by \`svall setup\` as svall-svalld@<fleet>.service: the daemon
# reads its fleet home from the environment, which an instance specifier cannot give it.
[Unit]
Description=Svall daemon for the private fleet
After=network.target

[Service]
Type=simple
ExecStart="/home/linus/.local/share/svall/current/bin/svalld"
Environment="SVALL_HOME=/home/linus/.svall"
Environment="HOME=/home/linus"
Environment="PATH=/home/linus/.local/share/svall/current/node/bin:/home/linus/.local/bin:/usr/local/bin:/usr/bin:/bin"
Environment=LANG=C.UTF-8
Restart=always
RestartSec=2
# the daemon starts the fleet's tmux server, which a crash, a restart or a stop must leave running
KillMode=process
StandardOutput=append:/home/linus/.local/share/svall/log/svall-svalld@private.log
StandardError=append:/home/linus/.local/share/svall/log/svall-svalld@private.log

[Install]
WantedBy=default.target
`);
  });

  it('renders one gateway for the machine', () => {
    const unit = gatewayUnit(release);
    expect(unit.name).toBe('svall-gateway.service');
    expect(unit.text).toBe(`# One per machine, rendered by \`svall setup\`: the ownership authority for every fleet that names
# this machine as its gateway.
[Unit]
Description=Svall gateway
After=network.target

[Service]
Type=simple
ExecStart="/home/linus/.local/share/svall/current/bin/svall" "gateway" "serve"
Environment="HOME=/home/linus"
Environment="PATH=/home/linus/.local/share/svall/current/node/bin:/home/linus/.local/bin:/usr/local/bin:/usr/bin:/bin"
Environment=LANG=C.UTF-8
Restart=always
RestartSec=2
StandardOutput=append:/home/linus/.local/share/svall/log/svall-gateway.log
StandardError=append:/home/linus/.local/share/svall/log/svall-gateway.log

[Install]
WantedBy=default.target
`);
  });

  // every rendered value takes a path with a space, a percent systemd would read as a specifier and
  // a dollar it would read as a variable
  const odd = {
    runtime: releaseRuntime('/tmp/x y%z/$home/.local/share/svall/current'),
    homedir: '/tmp/x y%z/$home',
    prefix: '/tmp/x y%z/$home/.local/share/svall',
    fleet: 'work',
    home: '/tmp/x y%z/$home/.svall-work',
  };

  it('quotes a space and escapes a percent and a dollar in every value it renders', () => {
    const unit = svalldUnit(odd);
    expect(unit.name).toBe('svall-svalld@work.service');
    // systemd takes the command name literally, so only the specifier is doubled there
    expect(unit.text).toContain('ExecStart="/tmp/x y%%z/$home/.local/share/svall/current/bin/svalld"\n');
    // Environment expands a specifier but never a variable
    expect(unit.text).toContain('Environment="SVALL_HOME=/tmp/x y%%z/$home/.svall-work"\n');
    expect(unit.text).toContain('Environment="HOME=/tmp/x y%%z/$home"\n');
    expect(unit.text).toContain('Environment="PATH=/tmp/x y%%z/$home/.local/share/svall/current/node/bin:/tmp/x y%%z/$home/.local/bin:/usr/local/bin:/usr/bin:/bin"\n');
    expect(unit.text).toContain('StandardOutput=append:/tmp/x y%%z/$home/.local/share/svall/log/svall-svalld@work.log\n');
    expect(unit.text).toContain('StandardError=append:/tmp/x y%%z/$home/.local/share/svall/log/svall-svalld@work.log\n');
    expect(unit.text).toContain('Description=Svall daemon for the work fleet\n');
  });

  it('escapes the gateway the same way', () => {
    const unit = gatewayUnit(odd);
    expect(unit.text).toContain('ExecStart="/tmp/x y%%z/$home/.local/share/svall/current/bin/svall" "gateway" "serve"\n');
    expect(unit.text).toContain('Environment="HOME=/tmp/x y%%z/$home"\n');
    expect(unit.text).toContain('Environment="PATH=/tmp/x y%%z/$home/.local/share/svall/current/node/bin:/tmp/x y%%z/$home/.local/bin:/usr/local/bin:/usr/bin:/bin"\n');
    expect(unit.text).toContain('StandardOutput=append:/tmp/x y%%z/$home/.local/share/svall/log/svall-gateway.log\n');
  });

  it('starts a development checkout through tsx, still with absolute paths', () => {
    const unit = svalldUnit({ runtime: checkoutRuntime('/src/svall'), homedir: '/home/linus', prefix: '/p', fleet: 'private', home: '/home/linus/.svall' });
    expect(unit.text).toContain('ExecStart="/src/svall/node_modules/.bin/tsx" "/src/svall/packages/svalld/src/bin.ts"\n');
  });

  it('doubles a dollar in an argument, which systemd reads, and not in the command name', () => {
    const unit = svalldUnit({ runtime: checkoutRuntime('/src/a$b%c'), homedir: '/home/linus', prefix: '/p', fleet: 'private', home: '/home/linus/.svall' });
    expect(unit.text).toContain('ExecStart="/src/a$b%%c/node_modules/.bin/tsx" "/src/a$$b%%c/packages/svalld/src/bin.ts"\n');
  });
});

describe('the agent homes a daemon is given', () => {
  // what the account's login shell prints past its own noise, as setup over ssh asks it
  const shell = (out: string | Error): Run => async (cmd, args) => {
    if (cmd !== '/bin/bash' || args[0] !== '-lic') throw new Error(`asked ${cmd} ${args.join(' ')}`);
    if (out instanceof Error) throw out;
    return { stdout: out, stderr: 'bash: no job control in this shell\n' };
  };

  it("reads CLAUDE_CONFIG_DIR and CODEX_HOME from the account's login shell, which a setup over ssh does not run in", async () => {
    vi.stubEnv('SHELL', '/bin/bash');
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    vi.stubEnv('CODEX_HOME', undefined);
    expect(await agentHomesEnv(shell('Welcome\nsvall-agent-homes\n/home/linus/.config/claude\n/home/linus/codex home\n')))
      .toEqual({ CLAUDE_CONFIG_DIR: '/home/linus/.config/claude', CODEX_HOME: '/home/linus/codex home' });
    expect(await agentHomesEnv(shell('svall-agent-homes\n\n\n'))).toEqual({});
    expect(await agentHomesEnv(shell(new Error('timed out')))).toEqual({});
    // a value this process was started with is the one it is asked for
    vi.stubEnv('CODEX_HOME', '/srv/codex');
    expect(await agentHomesEnv(shell('svall-agent-homes\n/home/linus/.config/claude\n/home/linus/codex\n')))
      .toEqual({ CLAUDE_CONFIG_DIR: '/home/linus/.config/claude', CODEX_HOME: '/srv/codex' });
  });

  it("puts them in the fleet daemon's unit, as the Mac's plist carries them", async () => {
    const unit = svalldUnit({
      runtime: releaseRuntime('/r'), homedir: '/home/linus', prefix: '/p', fleet: 'private', home: '/home/linus/.svall',
      env: { CLAUDE_CONFIG_DIR: '/home/linus/.config/claude', CODEX_HOME: '/home/linus/codex %home' },
    });
    expect(unit.text).toContain('Environment=LANG=C.UTF-8\nEnvironment="CLAUDE_CONFIG_DIR=/home/linus/.config/claude"\nEnvironment="CODEX_HOME=/home/linus/codex %%home"\nRestart=always\n');
    vi.stubEnv('SHELL', '/bin/bash');
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    vi.stubEnv('CODEX_HOME', undefined);
    const f = installed();
    await setupLinux({ ...f.o, run: shell('svall-agent-homes\n/home/linus/.config/claude\n\n') });
    expect(fs.readFileSync(path.join(f.unitDir, 'svall-svalld@private.service'), 'utf8')).toContain('Environment="CLAUDE_CONFIG_DIR=/home/linus/.config/claude"\n');
  });
});

/** A fleet home, the per-user files setup writes beside it, and where its units go. */
function installed() {
  const root = makeHome();
  const home = path.join(root, '.svall');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: path.join(root, 'mc') } }));
  const unitDir = unitDirOf(root);
  return {
    root,
    home,
    unitDir,
    o: {
      runtime: checkoutRuntime(repoRoot),
      fleet: 'private',
      home,
      homedir: root,
      prefix: path.join(root, '.local', 'share', 'svall'),
      unitDir,
      settingsPath: path.join(root, '.claude', 'settings.json'),
      codex: codexPaths({ CODEX_HOME: path.join(root, '.codex') }),
      shimDir: path.join(root, '.local', 'bin'),
      user: 'linus',
      systemctl: false,
      run: fakeRun().run,
    },
  };
}

describe('setupLinux', () => {
  it('installs the fleet home and the units, and writes no launchd file', async () => {
    const f = installed();
    const { done, started } = await setupLinux(f.o);
    expect(started).toBe(false);
    expect(fs.existsSync(path.join(f.home, 'hooks/agent-hook.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(f.home, 'node.json'))).toBe(true);
    expect(fs.existsSync(path.join(f.o.shimDir, 'svall'))).toBe(true);
    expect(fs.readdirSync(f.unitDir).sort()).toEqual(['svall-gateway.service', 'svall-svalld@private.service']);
    expect(fs.existsSync(path.join(f.o.prefix, 'log'))).toBe(true);
    expect(done.some((l) => l.includes('svall-svalld@private.service'))).toBe(true);
    expect(done.some((l) => l.toLowerCase().includes('launchd') || l.includes('plist'))).toBe(false);
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [e.name]));
    expect(walk(f.root).some((name) => name.endsWith('.plist'))).toBe(false);
  });

  it('keeps the units\' logs in a folder only this account opens, one an earlier setup left open included', async () => {
    const f = installed();
    fs.mkdirSync(path.join(f.o.prefix, 'log'), { recursive: true, mode: 0o755 });
    await setupLinux(f.o);
    expect(fs.statSync(path.join(f.o.prefix, 'log')).mode & 0o777).toBe(0o700);
  });

  it('writes no Claude settings for a Codex-only machine, and makes CODEX_HOME for its hooks', async () => {
    const f = installed();
    await setupLinux({ ...f.o, agents: ['codex'] });
    expect(fs.existsSync(f.o.settingsPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(f.o.codex.hooks, 'utf8')).hooks.SessionStart).toBeDefined();
  });

  it('rewrites nothing on a repeat run', async () => {
    const f = installed();
    await setupLinux(f.o);
    const unit = path.join(f.unitDir, 'svall-svalld@private.service');
    const before = fs.statSync(unit).mtimeMs;
    const text = fs.readFileSync(unit, 'utf8');
    await new Promise((r) => setTimeout(r, 15));
    const again = await setupLinux(f.o);
    expect(fs.statSync(unit).mtimeMs).toBe(before);
    expect(fs.readFileSync(unit, 'utf8')).toBe(text);
    expect(again.done.some((l) => l.startsWith('systemd unit ->'))).toBe(false);
  });

  it('reloads and enables this fleet and the machine\'s gateway, and reports the linger action without running it', async () => {
    const f = installed();
    const fake = fakeRun({ 'loginctl show-user linus --property=Linger': 'Linger=no\n' });
    const { done, started } = await setupLinux({ ...f.o, systemctl: true, run: fake.run });
    expect(started).toBe(true);
    expect(fake.calls.filter(([, first]) => first !== '-lic')).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'svall-svalld@private.service'],
      ['systemctl', '--user', 'enable', '--now', 'svall-gateway.service'],
      ['loginctl', 'show-user', 'linus', '--property=Linger'],
    ]);
    expect(done.some((l) => l.includes('loginctl enable-linger linus'))).toBe(true);
  });

  it('restarts a unit it rewrote, which enable --now would leave running on the file it started from', async () => {
    const f = installed();
    fs.mkdirSync(f.unitDir, { recursive: true });
    // an earlier setup's unit, without the agent homes this one gives the daemon
    fs.writeFileSync(path.join(f.unitDir, 'svall-svalld@private.service'), '[Service]\n');
    const systemctl = (calls: string[][]) => calls.filter(([cmd]) => cmd === 'systemctl');
    const fake = fakeRun({ 'loginctl show-user linus --property=Linger': 'Linger=yes\n' });
    const { done } = await setupLinux({ ...f.o, systemctl: true, run: fake.run, env: { CLAUDE_CONFIG_DIR: '/home/linus/.config/claude' } });
    expect(systemctl(fake.calls)).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'restart', 'svall-svalld@private.service'],
      ['systemctl', '--user', 'enable', '--now', 'svall-svalld@private.service'],
      ['systemctl', '--user', 'enable', '--now', 'svall-gateway.service'],
    ]);
    expect(done).toContain('systemctl --user restart svall-svalld@private.service');

    const again = fakeRun({ 'loginctl show-user linus --property=Linger': 'Linger=yes\n' });
    await setupLinux({ ...f.o, systemctl: true, run: again.run, env: { CLAUDE_CONFIG_DIR: '/home/linus/.config/claude' } });
    expect(systemctl(again.calls).some(([, , verb]) => verb === 'restart')).toBe(false);
  });

  it('leaves mission control\'s folder as it is where the fleet is owned elsewhere, so the next handover takes it as it stands', async () => {
    const f = installed();
    const mc = path.join(f.root, 'mc');
    // an older release's folder, the same as the owner's
    for (const [file, text] of [['CLAUDE.md', 'mission control\n'], ['.claude/rules/svall.md', 'older rules\n']]) {
      fs.mkdirSync(path.dirname(path.join(mc, file)), { recursive: true });
      fs.writeFileSync(path.join(mc, file), text);
    }
    const snapshot = (): Record<string, string> => Object.fromEntries((fs.readdirSync(mc, { recursive: true }) as string[]).sort().map((file) => {
      const at = path.join(mc, file);
      const st = fs.statSync(at);
      return [file, st.isDirectory() ? 'dir' : `${crypto.createHash('sha256').update(fs.readFileSync(at)).digest('hex').slice(0, 16)}:${st.mtimeMs}`];
    }));
    const before = snapshot();
    const incoming = (await scanPath(mc, rootMatcher('home', [...DEFAULT_EXCLUDES])))!.files;
    const paths = resolvePaths(f.home);
    const fleetId = FleetId.parse('11111111-2222-3333-4444-555555555555');
    fs.writeFileSync(paths.owner, JSON.stringify({ fleetId, generation: 2, ownerMachineId: MachineId.parse('42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f') }));

    const { done } = await setupLinux(f.o);
    expect(snapshot()).toEqual(before);
    expect(done).toContain('home folder left as it is, as 42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f owns this fleet');
    const root = { id: 'r_home', kind: 'home' as const, entry: 'dir' as const, path: mc };
    expect(await new ReplicaStore({ fleetId, paths }).claim(root, { transactionId: 'tx-3', excludes: [...DEFAULT_EXCLUDES], incoming }))
      .toMatchObject({ ok: true, kind: 'replica' });

    // the owner's own setup brings the folder up to date
    fs.writeFileSync(paths.owner, JSON.stringify({ fleetId, generation: 3, ownerMachineId: machineId() }));
    await setupLinux(f.o);
    expect(fs.readFileSync(path.join(mc, '.claude/rules/svall.md'), 'utf8')).not.toBe('older rules\n');
    expect(fs.existsSync(path.join(mc, 'AGENTS.md'))).toBe(true);
  });

  it('keeps the files it wrote when the machine has no systemd, and says so', async () => {
    const f = installed();
    const fake = fakeRun({ 'systemctl --user daemon-reload': enoent('systemctl') });
    const { done, started } = await setupLinux({ ...f.o, systemctl: true, run: fake.run });
    expect(started).toBe(false);
    expect(fs.existsSync(path.join(f.unitDir, 'svall-svalld@private.service'))).toBe(true);
    expect(done.some((l) => l.includes('systemctl'))).toBe(true);
  });
});

describe('setupLinuxRelease', () => {
  /** A prefix the fleet's setup installed a second release into. */
  const withReleases = (f: ReturnType<typeof installed>) => {
    const releases = path.join(f.o.prefix, 'releases');
    fs.mkdirSync(path.join(releases, '1.0.0'), { recursive: true });
    fs.mkdirSync(path.join(releases, '1.0.1'), { recursive: true });
    fs.symlinkSync(path.join(releases, '1.0.1'), path.join(f.o.prefix, 'current'));
    return { first: path.join(releases, '1.0.0'), second: path.join(releases, '1.0.1') };
  };

  it('keeps the release that installed when the machine has no systemd to start it with', async () => {
    const f = installed();
    const r = withReleases(f);
    const fake = fakeRun({ 'systemctl --user daemon-reload': enoent('systemctl') });
    let probed = false;
    const done = await setupLinuxRelease({
      ...f.o, systemctl: true, run: fake.run, rollbackTo: r.first,
      probe: async () => { probed = true; return false; },
      rollback: rollbackRelease,
    });
    expect(probed).toBe(false);
    expect(fs.readlinkSync(path.join(f.o.prefix, 'current'))).toBe(r.second);
    expect(done.some((l) => l.includes('no systemd user services'))).toBe(true);
  });

  it('restarts every fleet daemon and the gateway onto a release that replaced another before it probes', async () => {
    const f = installed();
    const r = withReleases(f);
    fs.mkdirSync(f.o.unitDir, { recursive: true });
    fs.writeFileSync(path.join(f.o.unitDir, 'svall-svalld@work.service'), '');
    const fake = fakeRun({ 'loginctl show-user linus --property=Linger': 'Linger=yes\n' });
    let seenAtProbe: string[][] = [];
    await setupLinuxRelease({
      ...f.o, systemctl: true, run: fake.run, rollbackTo: r.first,
      probe: async () => { seenAtProbe = [...fake.calls]; return true; },
      rollback: rollbackRelease,
    });
    expect(seenAtProbe.filter((c) => c[2] === 'restart')).toEqual([
      ['systemctl', '--user', 'restart', 'svall-svalld@private.service'],
      ['systemctl', '--user', 'restart', 'svall-svalld@work.service'],
      ['systemctl', '--user', 'restart', 'svall-gateway.service'],
    ]);
  });

  it('puts a started release that does not answer back, and leaves a first install alone', async () => {
    const f = installed();
    const r = withReleases(f);
    const fake = fakeRun({ 'loginctl show-user linus --property=Linger': 'Linger=yes\n' });
    const done = await setupLinuxRelease({
      ...f.o, systemctl: true, run: fake.run, rollbackTo: r.first, probe: async () => false, rollback: rollbackRelease,
    });
    expect(fs.readlinkSync(path.join(f.o.prefix, 'current'))).toBe(r.first);
    expect(done.some((l) => l.includes('did not answer'))).toBe(true);

    // nothing was replaced, so there is nothing to go back to and nothing to probe
    const first = installed();
    const only = withReleases(first);
    let probed = false;
    await setupLinuxRelease({
      ...first.o, systemctl: true, run: fakeRun().run,
      probe: async () => { probed = true; return false; },
      rollback: rollbackRelease,
    });
    expect(probed).toBe(false);
    expect(fs.readlinkSync(path.join(first.o.prefix, 'current'))).toBe(only.second);
  });
});

describe('systemctl and loginctl wrappers', () => {
  it('spawns argv only, and reads a unit through show', async () => {
    const fake = fakeRun({
      'systemctl --user show svall-svalld@private.service --property=LoadState --property=ActiveState --property=SubState --property=UnitFileState':
        'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n',
    });
    expect(await unitStatus(fake.run, 'svall-svalld@private.service')).toEqual({
      unit: 'svall-svalld@private.service', load: 'loaded', active: 'active', sub: 'running', state: 'enabled',
    });
    await enableUnit(fake.run, 'svall-svalld@private.service');
    expect(fake.calls.at(-1)).toEqual(['systemctl', '--user', 'enable', '--now', 'svall-svalld@private.service']);
  });

  it('reports a missing systemctl and a session without a bus as no_systemd', async () => {
    const absent = fakeRun({ 'systemctl --user daemon-reload': enoent('systemctl') });
    await expect(daemonReload(absent.run)).rejects.toMatchObject({ code: 'no_systemd' });
    const noBus = fakeRun({
      'systemctl --user daemon-reload': Object.assign(new Error('exit 1'), { stderr: 'Failed to connect to bus: No medium found\n' }),
    });
    await expect(daemonReload(noBus.run)).rejects.toMatchObject({ code: 'no_systemd', stderr: expect.stringContaining('Failed to connect to bus') });
  });

  it('reports a unit that will not start, with its stderr', async () => {
    const fake = fakeRun({
      'systemctl --user enable --now svall-svalld@private.service':
        Object.assign(new Error('exit 1'), { stderr: 'Job for svall-svalld@private.service failed\n' }),
    });
    const failed = await enableUnit(fake.run, 'svall-svalld@private.service').catch((e: SystemdError) => e);
    expect(failed).toBeInstanceOf(SystemdError);
    expect(failed).toMatchObject({ code: 'unit_failed', stderr: expect.stringContaining('Job for svall-svalld@private.service') });
  });

  it('reads linger and names the exact action, never running it', async () => {
    const off = fakeRun({ 'loginctl show-user linus --property=Linger': 'Linger=no\n' });
    expect(await lingerState(off.run, 'linus')).toEqual({ user: 'linus', linger: false, action: 'loginctl enable-linger linus' });
    expect(off.calls).toEqual([['loginctl', 'show-user', 'linus', '--property=Linger']]);

    const on = fakeRun({ 'loginctl show-user linus --property=Linger': 'Linger=yes\n' });
    expect((await lingerState(on.run, 'linus')).linger).toBe(true);

    const unknown = fakeRun({ 'loginctl show-user linus --property=Linger': Object.assign(new Error('exit 1'), { stderr: 'Failed to get user: No such process\n' }) });
    expect((await lingerState(unknown.run, 'linus')).linger).toBe(false);
  });
});

/** A prefix holding two releases, with `current` on the newer one. */
function prefixWithReleases(): { prefix: string; first: string; second: string } {
  const prefix = makeHome();
  const first = path.join(prefix, 'releases', '1.0.0');
  const second = path.join(prefix, 'releases', '1.0.1');
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  fs.symlinkSync(second, path.join(prefix, 'current'));
  return { prefix, first, second };
}

describe('rollbackRelease', () => {
  it('puts current back on the release it names', () => {
    const p = prefixWithReleases();
    const back = rollbackRelease(p.prefix, p.first);
    expect(back.release).toBe(p.first);
    expect(fs.readlinkSync(path.join(p.prefix, 'current'))).toBe(p.first);
    expect(fs.readdirSync(p.prefix).filter((f) => f.includes('.tmp-'))).toEqual([]);
    expect(fs.existsSync(p.second)).toBe(true);
  });

  it('takes the one release left when it is not told which', () => {
    const p = prefixWithReleases();
    expect(rollbackRelease(p.prefix).release).toBe(p.first);
    expect(fs.readlinkSync(path.join(p.prefix, 'current'))).toBe(p.first);
  });

  it('refuses when there is nothing to go back to', () => {
    const prefix = makeHome();
    const only = path.join(prefix, 'releases', '1.0.0');
    fs.mkdirSync(only, { recursive: true });
    fs.symlinkSync(only, path.join(prefix, 'current'));
    expect(() => rollbackRelease(prefix)).toThrow(/no release/);
  });
});

describe('restartUnits', () => {
  it('starts every fleet daemon and the gateway again from where current points, and says which did not start', async () => {
    const unitDir = makeHome();
    for (const u of ['svall-gateway.service', 'svall-svalld@work.service', 'svall-svalld@private.service', 'other.service']) {
      fs.writeFileSync(path.join(unitDir, u), '');
    }
    const fake = fakeRun({ 'systemctl --user restart svall-gateway.service': new Error('unit_failed') });
    expect(await restartUnits(fake.run, unitDir)).toEqual([
      'systemctl --user restart svall-svalld@private.service',
      'systemctl --user restart svall-svalld@work.service',
      expect.stringMatching(/^svall-gateway\.service did not restart: /),
    ]);
    expect(fake.calls).toEqual([
      ['systemctl', '--user', 'restart', 'svall-svalld@private.service'],
      ['systemctl', '--user', 'restart', 'svall-svalld@work.service'],
      ['systemctl', '--user', 'restart', 'svall-gateway.service'],
    ]);
  });
});

describe('probeOrRollback', () => {
  const unitDir = (): string => {
    const dir = makeHome();
    for (const u of ['svall-svalld@private.service', 'svall-svalld@work.service', 'svall-gateway.service']) fs.writeFileSync(path.join(dir, u), '');
    return dir;
  };

  it('leaves a release the daemon answers from alone', async () => {
    const p = prefixWithReleases();
    const fake = fakeRun();
    expect(await probeOrRollback({ prefix: p.prefix, unitDir: unitDir(), run: fake.run, probe: async () => true, rollback: rollbackRelease })).toEqual([]);
    expect(fs.readlinkSync(path.join(p.prefix, 'current'))).toBe(p.second);
    expect(fake.calls).toEqual([]);
  });

  it('swaps current back and restarts every daemon and the gateway when the daemon does not answer', async () => {
    const p = prefixWithReleases();
    const fake = fakeRun();
    const done = await probeOrRollback({ prefix: p.prefix, unitDir: unitDir(), run: fake.run, probe: async () => false, rollback: rollbackRelease });
    expect(fs.readlinkSync(path.join(p.prefix, 'current'))).toBe(p.first);
    // each was restarted onto the release that failed, and goes back with the daemon
    expect(fake.calls).toEqual([
      ['systemctl', '--user', 'restart', 'svall-svalld@private.service'],
      ['systemctl', '--user', 'restart', 'svall-svalld@work.service'],
      ['systemctl', '--user', 'restart', 'svall-gateway.service'],
    ]);
    expect(done.join('\n')).toContain(p.first);
  });

  it('asks every fleet whose daemon was restarted, and goes back when any one of them does not answer, naming it', async () => {
    const p = prefixWithReleases();
    const asked: string[] = [];
    const done = await probeOrRollback({
      prefix: p.prefix, unitDir: unitDir(), run: fakeRun().run,
      probe: async (fleet) => { asked.push(fleet); return fleet !== 'work'; }, rollback: rollbackRelease,
    });
    expect(asked).toEqual(['private', 'work']);
    expect(fs.readlinkSync(path.join(p.prefix, 'current'))).toBe(p.first);
    expect(done[0]).toBe(`the work fleet's daemon did not answer: current -> ${p.first}`);
  });

  it('says so when the daemon does not answer and there is no release to go back to', async () => {
    const prefix = makeHome();
    const only = path.join(prefix, 'releases', '1.0.0');
    fs.mkdirSync(only, { recursive: true });
    fs.symlinkSync(only, path.join(prefix, 'current'));
    const done = await probeOrRollback({ prefix, unitDir: unitDir(), run: fakeRun().run, probe: async () => false, rollback: rollbackRelease });
    expect(done.join('\n')).toMatch(/did not answer/);
  });
});
