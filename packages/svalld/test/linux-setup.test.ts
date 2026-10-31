import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rollbackRelease } from '../../../scripts/install-release.mjs';
import { codexPaths } from '../src/codex/install.js';
import { agentHomesEnv, svalldUnit, probeOrRollback, restartUnits, serveAsWorker, setupLinux, setupLinuxRelease, unitDirOf, writeUnits } from '../src/linux/setup.js';
import { SystemdError, daemonReload, enableUnit, lingerState, unitStatus, type Run } from '../src/linux/service.js';
import { opencodePaths } from '../src/opencode/install.js';
import { resolvePaths } from '../src/paths.js';
import { profileHome } from '../src/profile.js';
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
Environment="PATH=/home/linus/.local/share/svall/current/node/bin:/home/linus/.local/share/svall/current/bin:/home/linus/.local/bin:/home/linus/.opencode/bin:/usr/local/bin:/usr/bin:/bin"
Environment=LANG=C.UTF-8
Restart=always
RestartSec=2
# the daemon starts the fleet's tmux server, which a crash, a restart or a stop must leave running
KillMode=process
# an agent the kernel kills for memory is in this unit's cgroup, which systemd would otherwise stop
OOMPolicy=continue
StandardOutput=append:/home/linus/.local/share/svall/log/svall-svalld@private.log
StandardError=append:/home/linus/.local/share/svall/log/svall-svalld@private.log

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
    expect(unit.text).toContain('Environment="PATH=/tmp/x y%%z/$home/.local/share/svall/current/node/bin:/tmp/x y%%z/$home/.local/share/svall/current/bin:/tmp/x y%%z/$home/.local/bin:/tmp/x y%%z/$home/.opencode/bin:/usr/local/bin:/usr/bin:/bin"\n');
    expect(unit.text).toContain('StandardOutput=append:/tmp/x y%%z/$home/.local/share/svall/log/svall-svalld@work.log\n');
    expect(unit.text).toContain('StandardError=append:/tmp/x y%%z/$home/.local/share/svall/log/svall-svalld@work.log\n');
    expect(unit.text).toContain('Description=Svall daemon for the work fleet\n');
  });

  it('starts a development checkout through tsx, still with absolute paths', () => {
    const unit = svalldUnit({ runtime: checkoutRuntime('/src/svall'), homedir: '/home/linus', prefix: '/p', fleet: 'private', home: '/home/linus/.svall' });
    expect(unit.text).toContain('ExecStart="/src/svall/node_modules/.bin/tsx" "/src/svall/packages/svalld/src/bin.ts"\n');
  });

  it('doubles a dollar in an argument, which systemd reads, and not in the command name', () => {
    const unit = svalldUnit({ runtime: checkoutRuntime('/src/a$b%c'), homedir: '/home/linus', prefix: '/p', fleet: 'private', home: '/home/linus/.svall' });
    expect(unit.text).toContain('ExecStart="/src/a$b%%c/node_modules/.bin/tsx" "/src/a$$b%%c/packages/svalld/src/bin.ts"\n');
  });

  it('runs the fleet daemon with --worker once its home holds worker.json', () => {
    const home = makeHome();
    expect(svalldUnit({ ...release, fleet: 'private', home }).text).toContain('ExecStart="/home/linus/.local/share/svall/current/bin/svalld"\n');
    fs.writeFileSync(resolvePaths(home).workerFile, '{}');
    expect(svalldUnit({ ...release, fleet: 'private', home }).text).toContain('ExecStart="/home/linus/.local/share/svall/current/bin/svalld" "--worker"\n');
  });

  it('writes the fleet\'s unit alone', () => {
    const unitDir = makeHome();
    const o = { ...release, prefix: path.join(makeHome(), 'svall'), fleet: 'private', home: makeHome(), unitDir };
    writeUnits(o);
    expect(fs.readdirSync(unitDir)).toEqual(['svall-svalld@private.service']);
  });
});

describe('the agent homes a daemon is given', () => {
  // what the account's login shell prints past its own noise, as setup over ssh asks it
  const shell = (out: string | Error): Run => async (cmd, args) => {
    if (cmd !== '/bin/bash' || args[0] !== '-lic') throw new Error(`asked ${cmd} ${args.join(' ')}`);
    if (out instanceof Error) throw out;
    return { stdout: out, stderr: 'bash: no job control in this shell\n' };
  };

  const unset = () => { for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'OPENCODE_DB']) vi.stubEnv(k, undefined); };

  it("reads CLAUDE_CONFIG_DIR and CODEX_HOME from the account's login shell, which a setup over ssh does not run in", async () => {
    vi.stubEnv('SHELL', '/bin/bash');
    unset();
    expect(await agentHomesEnv(shell('Welcome\nsvall-agent-homes\n/home/linus/.config/claude\n/home/linus/codex home\n')))
      .toEqual({ CLAUDE_CONFIG_DIR: '/home/linus/.config/claude', CODEX_HOME: '/home/linus/codex home' });
    expect(await agentHomesEnv(shell('svall-agent-homes\n\n\n'))).toEqual({});
    expect(await agentHomesEnv(shell(new Error('timed out')))).toEqual({});
    // a value this process was started with is the one it is asked for
    vi.stubEnv('CODEX_HOME', '/srv/codex');
    expect(await agentHomesEnv(shell('svall-agent-homes\n/home/linus/.config/claude\n/home/linus/codex\n')))
      .toEqual({ CLAUDE_CONFIG_DIR: '/home/linus/.config/claude', CODEX_HOME: '/srv/codex' });
  });

  it("reads where OpenCode keeps its config, data and database the same way, and puts Svall's plugin in that config", async () => {
    vi.stubEnv('SHELL', '/bin/bash');
    unset();
    const said = 'svall-agent-homes\n\n\n/home/linus/xdg/config\n/home/linus/xdg/data\n';
    expect(await agentHomesEnv(shell(said))).toEqual({ XDG_CONFIG_HOME: '/home/linus/xdg/config', XDG_DATA_HOME: '/home/linus/xdg/data' });
    vi.stubEnv('XDG_DATA_HOME', '/srv/data');
    expect(await agentHomesEnv(shell(said))).toEqual({ XDG_CONFIG_HOME: '/home/linus/xdg/config', XDG_DATA_HOME: '/srv/data' });
    // OpenCode reads a relative OPENCODE_DB against its data folder, so it goes as the shell said it
    unset();
    expect(await agentHomesEnv(shell('svall-agent-homes\n\n\n\n\nwork.db\n'))).toEqual({ OPENCODE_DB: 'work.db' });
    vi.stubEnv('OPENCODE_DB', '/srv/oc.db');
    expect(await agentHomesEnv(shell('svall-agent-homes\n\n\n\n\nwork.db\n'))).toEqual({ OPENCODE_DB: '/srv/oc.db' });
    unset();
    const f = installed();
    const config = path.join(f.root, 'xdg config');
    await setupLinux({ ...f.o, agents: ['opencode'], run: shell(`svall-agent-homes\n\n\n${config}\n\n`) });
    expect(fs.readFileSync(path.join(f.unitDir, 'svall-svalld@private.service'), 'utf8')).toContain(`Environment="XDG_CONFIG_HOME=${config}"\n`);
    expect(fs.existsSync(opencodePaths({ XDG_CONFIG_HOME: config }).plugin)).toBe(true);
    expect(fs.existsSync(opencodePaths({}, f.root).plugin)).toBe(false);
  });

  it("puts them in the fleet daemon's unit, as the Mac's plist carries them", async () => {
    const unit = svalldUnit({
      runtime: releaseRuntime('/r'), homedir: '/home/linus', prefix: '/p', fleet: 'private', home: '/home/linus/.svall',
      env: { CLAUDE_CONFIG_DIR: '/home/linus/.config/claude', CODEX_HOME: '/home/linus/codex %home' },
    });
    expect(unit.text).toContain('Environment=LANG=C.UTF-8\nEnvironment="CLAUDE_CONFIG_DIR=/home/linus/.config/claude"\nEnvironment="CODEX_HOME=/home/linus/codex %%home"\nRestart=always\n');
    vi.stubEnv('SHELL', '/bin/bash');
    unset();
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
    expect(fs.readdirSync(f.unitDir)).toEqual(['svall-svalld@private.service']);
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

  it('installs the OpenCode plugin where OpenCode is found or keeps its folder, and takes it back once the fleet turns OpenCode off', async () => {
    const f = installed();
    const { plugin, dir } = opencodePaths({}, f.root);
    expect((await setupLinux({ ...f.o, agents: ['opencode'] })).done).toContain(`opencode plugin -> ${plugin}`);
    expect(fs.readFileSync(plugin, 'utf8')).toContain('export default');

    const node = path.join(f.home, 'node.json');
    fs.writeFileSync(node, JSON.stringify({ ...JSON.parse(fs.readFileSync(node, 'utf8')), agentsOff: ['opencode'] }));
    expect((await setupLinux({ ...f.o, agents: ['opencode'] })).done).toContain(`removed ${plugin}`);
    expect(fs.existsSync(plugin)).toBe(false);

    const bare = installed();
    await setupLinux({ ...bare.o, agents: ['claude'] });
    expect(fs.existsSync(opencodePaths({}, bare.root).dir)).toBe(false);
    fs.mkdirSync(opencodePaths({}, bare.root).dir, { recursive: true });
    await setupLinux({ ...bare.o, agents: ['claude'] });
    expect(fs.existsSync(opencodePaths({}, bare.root).plugin)).toBe(true);
    expect(dir).toBe(path.join(f.root, '.config', 'opencode'));
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

  it('reloads and enables this fleet, and turns lingering on', async () => {
    const f = installed();
    const answers: Record<string, string> = { 'loginctl show-user linus --property=Linger': 'Linger=no\n' };
    const fake = fakeRun(answers);
    const run: Run = async (cmd, args) => {
      if (args[0] === 'enable-linger') answers['loginctl show-user linus --property=Linger'] = 'Linger=yes\n';
      return fake.run(cmd, args);
    };
    const { done, started } = await setupLinux({ ...f.o, systemctl: true, run });
    expect(started).toBe(true);
    expect(fake.calls.filter(([, first]) => first !== '-lic')).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'svall-svalld@private.service'],
      ['loginctl', 'show-user', 'linus', '--property=Linger'],
      ['loginctl', 'enable-linger', 'linus'],
      ['loginctl', 'show-user', 'linus', '--property=Linger'],
    ]);
    expect(done).toContain('loginctl enable-linger linus');
    expect(done.some((l) => l.includes('stops when you log out'))).toBe(false);
  });

  it('names the sudo command when the system refuses to let the account linger, and tries nothing where loginctl cannot be read', async () => {
    const f = installed();
    const refused = fakeRun({
      'loginctl show-user linus --property=Linger': 'Linger=no\n',
      'loginctl enable-linger linus': Object.assign(new Error('exit 1'), { stderr: 'Could not enable linger: Access denied\n' }),
    });
    const { done, started } = await setupLinux({ ...f.o, systemctl: true, run: refused.run });
    expect(started).toBe(true);
    expect(refused.calls.filter(([cmd]) => cmd === 'loginctl').map(([, verb]) => verb)).toEqual(['show-user', 'enable-linger', 'show-user']);
    expect(done).toContain('the fleet stops when you log out until you run: sudo loginctl enable-linger linus');

    const unread = fakeRun({ 'loginctl show-user linus --property=Linger': Object.assign(new Error('exit 1'), { stderr: 'Failed to connect to bus: No medium found\n' }) });
    const again = await setupLinux({ ...f.o, systemctl: true, run: unread.run });
    expect(unread.calls.some(([cmd, verb]) => cmd === 'loginctl' && verb === 'enable-linger')).toBe(false);
    expect(again.done.some((l) => l.startsWith('lingering could not be read:'))).toBe(true);
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
    ]);
    expect(done).toContain('systemctl --user restart svall-svalld@private.service');

    const again = fakeRun({ 'loginctl show-user linus --property=Linger': 'Linger=yes\n' });
    await setupLinux({ ...f.o, systemctl: true, run: again.run, env: { CLAUDE_CONFIG_DIR: '/home/linus/.config/claude' } });
    expect(systemctl(again.calls).some(([, , verb]) => verb === 'restart')).toBe(false);
  });

  it('renders every named fleet\'s unit afresh too, and restarts each it rewrote', async () => {
    const f = installed();
    fs.mkdirSync(f.unitDir, { recursive: true });
    const env = { XDG_DATA_HOME: '/home/linus/.data', OPENCODE_DB: 'oc.db' };
    const work = path.join(f.unitDir, 'svall-svalld@work.service');
    // an earlier template's unit, whose PATH has no ~/.opencode/bin and which sets none of the agent homes
    const old = svalldUnit({ ...f.o, fleet: 'work', home: profileHome('work', f.root) }).text.replace(`:${path.join(f.root, '.opencode', 'bin')}`, '');
    fs.writeFileSync(work, old);
    const fake = fakeRun({ 'loginctl show-user linus --property=Linger': 'Linger=yes\n' });
    const { done } = await setupLinux({ ...f.o, systemctl: true, run: fake.run, env });
    expect(fs.readFileSync(work, 'utf8')).toBe(svalldUnit({ ...f.o, env, fleet: 'work', home: profileHome('work', f.root) }).text);
    expect(done).toContain(`systemd unit -> ${work}`);
    expect(fake.calls.filter(([cmd]) => cmd === 'systemctl')).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'restart', 'svall-svalld@work.service'],
      ['systemctl', '--user', 'enable', '--now', 'svall-svalld@private.service'],
    ]);

    const again = fakeRun({ 'loginctl show-user linus --property=Linger': 'Linger=yes\n' });
    await setupLinux({ ...f.o, systemctl: true, run: again.run, env });
    expect(again.calls.some(([cmd, , verb]) => cmd === 'systemctl' && verb === 'restart')).toBe(false);
  });

  it('serves the fleet as a worker: its unit written again with --worker, and its daemon restarted onto it', async () => {
    const f = installed();
    await setupLinux(f.o);
    const unit = path.join(f.unitDir, 'svall-svalld@private.service');
    expect(fs.readFileSync(unit, 'utf8')).not.toContain('--worker');
    fs.writeFileSync(resolvePaths(f.home).workerFile, '{}');
    const fake = fakeRun();
    const done = await serveAsWorker({ ...f.o, run: fake.run });
    expect(fs.readFileSync(unit, 'utf8')).toContain('"--worker"\n');
    expect(fake.calls.filter(([cmd]) => cmd === 'systemctl')).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'restart', 'svall-svalld@private.service'],
      ['systemctl', '--user', 'enable', '--now', 'svall-svalld@private.service'],
    ]);
    expect(done).toEqual([`systemd unit -> ${unit}`, 'systemctl --user restart svall-svalld@private.service']);
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

  it('restarts every fleet daemon onto a release that replaced another before it probes', async () => {
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
    // the work unit setup rewrote was restarted once already
    expect(seenAtProbe.filter((c) => c[2] === 'restart').slice(-2)).toEqual([
      ['systemctl', '--user', 'restart', 'svall-svalld@private.service'],
      ['systemctl', '--user', 'restart', 'svall-svalld@work.service'],
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

  it('restarts and probes a release reinstalled under the name it replaced, though no other release is kept', async () => {
    const f = installed();
    const release = path.join(f.o.prefix, 'releases', '1.0.1');
    fs.mkdirSync(release, { recursive: true });
    fs.symlinkSync(release, path.join(f.o.prefix, 'current'));
    const fake = fakeRun({ 'loginctl show-user linus --property=Linger': 'Linger=yes\n' });
    let seenAtProbe: string[][] = [];
    await setupLinuxRelease({
      ...f.o, systemctl: true, run: fake.run, replaced: true,
      probe: async () => { seenAtProbe = [...fake.calls]; return true; },
      rollback: rollbackRelease,
    });
    // the daemon still runs the tree the reinstall removed, under the same release name
    expect(seenAtProbe.filter((c) => c[2] === 'restart')).toEqual([
      ['systemctl', '--user', 'restart', 'svall-svalld@private.service'],
    ]);
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
    expect(await lingerState(off.run, 'linus')).toEqual({ user: 'linus', linger: false, action: 'sudo loginctl enable-linger linus' });
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
  const unitDir = (): string => {
    const dir = makeHome();
    for (const u of ['svall-gateway.service', 'svall-svalld@work.service', 'svall-svalld@private.service', 'other.service']) fs.writeFileSync(path.join(dir, u), '');
    return dir;
  };

  it('restarts every fleet daemon and never the gateway unit', async () => {
    const fake = fakeRun();
    expect(await restartUnits(fake.run, unitDir())).toEqual(['systemctl --user restart svall-svalld@private.service', 'systemctl --user restart svall-svalld@work.service']);
    expect(fake.calls.flat()).not.toContain('svall-gateway.service');
  });

  it('says which fleet daemon did not restart', async () => {
    const fake = fakeRun({ 'systemctl --user restart svall-svalld@work.service': new Error('unit_failed') });
    expect(await restartUnits(fake.run, unitDir())).toEqual([
      'systemctl --user restart svall-svalld@private.service',
      expect.stringMatching(/^svall-svalld@work\.service did not restart: /),
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

  it('swaps current back and restarts every fleet daemon when the daemon does not answer', async () => {
    const p = prefixWithReleases();
    const fake = fakeRun();
    const done = await probeOrRollback({ prefix: p.prefix, unitDir: unitDir(), run: fake.run, probe: async () => false, rollback: rollbackRelease });
    expect(fs.readlinkSync(path.join(p.prefix, 'current'))).toBe(p.first);
    // each was restarted onto the release that failed, and goes back with the daemon
    expect(fake.calls).toEqual([
      ['systemctl', '--user', 'restart', 'svall-svalld@private.service'],
      ['systemctl', '--user', 'restart', 'svall-svalld@work.service'],
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
