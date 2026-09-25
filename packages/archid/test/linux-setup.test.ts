import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { rollbackRelease } from '../../../scripts/install-release.mjs';
import { codexPaths } from '../src/codex/install.js';
import { archidUnit, gatewayUnit, probeOrRollback, setupLinux, setupLinuxRelease, unitDirOf } from '../src/linux/setup.js';
import { SystemdError, daemonReload, enableUnit, lingerState, unitStatus, type Run } from '../src/linux/service.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);
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
    release: '/home/linus/.local/share/archipelago/current',
    homedir: '/home/linus',
    prefix: '/home/linus/.local/share/archipelago',
  };

  it('renders the private fleet daemon through current, with absolute paths and append-only logs', () => {
    const unit = archidUnit({ ...release, fleet: 'private', home: '/home/linus/.archipelago' });
    expect(unit.name).toBe('archipelago-archid@private.service');
    expect(unit.text).toBe(`# One per fleet, rendered by \`archi setup\` as archipelago-archid@<fleet>.service: the daemon
# reads its fleet home from the environment, which an instance specifier cannot give it.
[Unit]
Description=Archipelago daemon for the private fleet
After=network.target

[Service]
Type=simple
ExecStart="/home/linus/.local/share/archipelago/current/bin/archid"
Environment="ARCHI_HOME=/home/linus/.archipelago"
Environment="HOME=/home/linus"
Environment="PATH=/home/linus/.local/share/archipelago/current/node/bin:/home/linus/.local/bin:/usr/local/bin:/usr/bin:/bin"
Environment=LANG=C.UTF-8
Restart=always
RestartSec=2
# the daemon starts the fleet's tmux server, which a crash, a restart or a stop must leave running
KillMode=process
StandardOutput=append:/home/linus/.local/share/archipelago/log/archipelago-archid@private.log
StandardError=append:/home/linus/.local/share/archipelago/log/archipelago-archid@private.log

[Install]
WantedBy=default.target
`);
  });

  it('renders one gateway for the machine', () => {
    const unit = gatewayUnit(release);
    expect(unit.name).toBe('archipelago-gateway.service');
    expect(unit.text).toBe(`# One per machine, rendered by \`archi setup\`: the ownership authority for every fleet that names
# this machine as its gateway.
[Unit]
Description=Archipelago gateway
After=network.target

[Service]
Type=simple
ExecStart="/home/linus/.local/share/archipelago/current/bin/archi" "gateway" "serve"
Environment="HOME=/home/linus"
Environment="PATH=/home/linus/.local/share/archipelago/current/node/bin:/home/linus/.local/bin:/usr/local/bin:/usr/bin:/bin"
Environment=LANG=C.UTF-8
Restart=always
RestartSec=2
StandardOutput=append:/home/linus/.local/share/archipelago/log/archipelago-gateway.log
StandardError=append:/home/linus/.local/share/archipelago/log/archipelago-gateway.log

[Install]
WantedBy=default.target
`);
  });

  // every rendered value takes a path with a space, a percent systemd would read as a specifier and
  // a dollar it would read as a variable
  const odd = {
    release: '/tmp/x y%z/$home/.local/share/archipelago/current',
    homedir: '/tmp/x y%z/$home',
    prefix: '/tmp/x y%z/$home/.local/share/archipelago',
    fleet: 'work',
    home: '/tmp/x y%z/$home/.archipelago-work',
  };

  it('quotes a space and escapes a percent and a dollar in every value it renders', () => {
    const unit = archidUnit(odd);
    expect(unit.name).toBe('archipelago-archid@work.service');
    // systemd takes the command name literally, so only the specifier is doubled there
    expect(unit.text).toContain('ExecStart="/tmp/x y%%z/$home/.local/share/archipelago/current/bin/archid"\n');
    // Environment expands a specifier but never a variable
    expect(unit.text).toContain('Environment="ARCHI_HOME=/tmp/x y%%z/$home/.archipelago-work"\n');
    expect(unit.text).toContain('Environment="HOME=/tmp/x y%%z/$home"\n');
    expect(unit.text).toContain('Environment="PATH=/tmp/x y%%z/$home/.local/share/archipelago/current/node/bin:/tmp/x y%%z/$home/.local/bin:/usr/local/bin:/usr/bin:/bin"\n');
    expect(unit.text).toContain('StandardOutput=append:/tmp/x y%%z/$home/.local/share/archipelago/log/archipelago-archid@work.log\n');
    expect(unit.text).toContain('StandardError=append:/tmp/x y%%z/$home/.local/share/archipelago/log/archipelago-archid@work.log\n');
    expect(unit.text).toContain('Description=Archipelago daemon for the work fleet\n');
  });

  it('escapes the gateway the same way', () => {
    const unit = gatewayUnit(odd);
    expect(unit.text).toContain('ExecStart="/tmp/x y%%z/$home/.local/share/archipelago/current/bin/archi" "gateway" "serve"\n');
    expect(unit.text).toContain('Environment="HOME=/tmp/x y%%z/$home"\n');
    expect(unit.text).toContain('Environment="PATH=/tmp/x y%%z/$home/.local/share/archipelago/current/node/bin:/tmp/x y%%z/$home/.local/bin:/usr/local/bin:/usr/bin:/bin"\n');
    expect(unit.text).toContain('StandardOutput=append:/tmp/x y%%z/$home/.local/share/archipelago/log/archipelago-gateway.log\n');
  });

  it('starts a development checkout through tsx, still with absolute paths', () => {
    const unit = archidUnit({ repoRoot: '/src/archipelago', homedir: '/home/linus', prefix: '/p', fleet: 'private', home: '/home/linus/.archipelago' });
    expect(unit.text).toContain('ExecStart="/src/archipelago/node_modules/.bin/tsx" "/src/archipelago/packages/archid/src/bin.ts"\n');
  });

  it('doubles a dollar in an argument, which systemd reads, and not in the command name', () => {
    const unit = archidUnit({ repoRoot: '/src/a$b%c', homedir: '/home/linus', prefix: '/p', fleet: 'private', home: '/home/linus/.archipelago' });
    expect(unit.text).toContain('ExecStart="/src/a$b%%c/node_modules/.bin/tsx" "/src/a$$b%%c/packages/archid/src/bin.ts"\n');
  });
});

/** A fleet home, the per-user files setup writes beside it, and where its units go. */
function installed() {
  const root = makeHome();
  const home = path.join(root, '.archipelago');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: path.join(root, 'mc') } }));
  const unitDir = unitDirOf(root);
  return {
    root,
    home,
    unitDir,
    o: {
      repoRoot,
      fleet: 'private',
      home,
      homedir: root,
      prefix: path.join(root, '.local', 'share', 'archipelago'),
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
    expect(fs.existsSync(path.join(f.home, 'tmux.conf'))).toBe(true);
    expect(fs.existsSync(path.join(f.home, 'node.json'))).toBe(true);
    expect(fs.existsSync(path.join(f.o.shimDir, 'archi'))).toBe(true);
    expect(fs.readdirSync(f.unitDir).sort()).toEqual(['archipelago-archid@private.service', 'archipelago-gateway.service']);
    expect(fs.existsSync(path.join(f.o.prefix, 'log'))).toBe(true);
    expect(done.some((l) => l.includes('archipelago-archid@private.service'))).toBe(true);
    expect(done.some((l) => l.toLowerCase().includes('launchd') || l.includes('plist'))).toBe(false);
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [e.name]));
    expect(walk(f.root).some((name) => name.endsWith('.plist'))).toBe(false);
  });

  it('rewrites nothing on a repeat run', async () => {
    const f = installed();
    await setupLinux(f.o);
    const unit = path.join(f.unitDir, 'archipelago-archid@private.service');
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
    expect(fake.calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'archipelago-archid@private.service'],
      ['systemctl', '--user', 'enable', '--now', 'archipelago-gateway.service'],
      ['loginctl', 'show-user', 'linus', '--property=Linger'],
    ]);
    expect(done.some((l) => l.includes('loginctl enable-linger linus'))).toBe(true);
  });

  it('keeps the files it wrote when the machine has no systemd, and says so', async () => {
    const f = installed();
    const fake = fakeRun({ 'systemctl --user daemon-reload': enoent('systemctl') });
    const { done, started } = await setupLinux({ ...f.o, systemctl: true, run: fake.run });
    expect(started).toBe(false);
    expect(fs.existsSync(path.join(f.unitDir, 'archipelago-archid@private.service'))).toBe(true);
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

  it('restarts the daemon and the gateway onto a release that replaced another before it probes', async () => {
    const f = installed();
    const r = withReleases(f);
    const fake = fakeRun({ 'loginctl show-user linus --property=Linger': 'Linger=yes\n' });
    let seenAtProbe: string[][] = [];
    await setupLinuxRelease({
      ...f.o, systemctl: true, run: fake.run, rollbackTo: r.first,
      probe: async () => { seenAtProbe = [...fake.calls]; return true; },
      rollback: rollbackRelease,
    });
    expect(seenAtProbe).toContainEqual(['systemctl', '--user', 'restart', 'archipelago-archid@private.service']);
    expect(seenAtProbe).toContainEqual(['systemctl', '--user', 'restart', 'archipelago-gateway.service']);
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
      'systemctl --user show archipelago-archid@private.service --property=LoadState --property=ActiveState --property=SubState --property=UnitFileState':
        'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n',
    });
    expect(await unitStatus(fake.run, 'archipelago-archid@private.service')).toEqual({
      unit: 'archipelago-archid@private.service', load: 'loaded', active: 'active', sub: 'running', state: 'enabled',
    });
    await enableUnit(fake.run, 'archipelago-archid@private.service');
    expect(fake.calls.at(-1)).toEqual(['systemctl', '--user', 'enable', '--now', 'archipelago-archid@private.service']);
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
      'systemctl --user enable --now archipelago-archid@private.service':
        Object.assign(new Error('exit 1'), { stderr: 'Job for archipelago-archid@private.service failed\n' }),
    });
    const failed = await enableUnit(fake.run, 'archipelago-archid@private.service').catch((e: SystemdError) => e);
    expect(failed).toBeInstanceOf(SystemdError);
    expect(failed).toMatchObject({ code: 'unit_failed', stderr: expect.stringContaining('Job for archipelago-archid@private.service') });
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

describe('probeOrRollback', () => {
  it('leaves a release the daemon answers from alone', async () => {
    const p = prefixWithReleases();
    const fake = fakeRun();
    expect(await probeOrRollback({ prefix: p.prefix, unit: 'archipelago-archid@private.service', run: fake.run, probe: async () => true, rollback: rollbackRelease })).toEqual([]);
    expect(fs.readlinkSync(path.join(p.prefix, 'current'))).toBe(p.second);
    expect(fake.calls).toEqual([]);
  });

  it('swaps current back and restarts the unit when the daemon does not answer', async () => {
    const p = prefixWithReleases();
    const fake = fakeRun();
    const done = await probeOrRollback({ prefix: p.prefix, unit: 'archipelago-archid@private.service', run: fake.run, probe: async () => false, rollback: rollbackRelease });
    expect(fs.readlinkSync(path.join(p.prefix, 'current'))).toBe(p.first);
    expect(fake.calls).toEqual([['systemctl', '--user', 'restart', 'archipelago-archid@private.service']]);
    expect(done.join('\n')).toContain(p.first);
  });

  it('says so when the daemon does not answer and there is no release to go back to', async () => {
    const prefix = makeHome();
    const only = path.join(prefix, 'releases', '1.0.0');
    fs.mkdirSync(only, { recursive: true });
    fs.symlinkSync(only, path.join(prefix, 'current'));
    const done = await probeOrRollback({ prefix, unit: 'archipelago-archid@private.service', run: fakeRun().run, probe: async () => false, rollback: rollbackRelease });
    expect(done.join('\n')).toMatch(/did not answer/);
  });
});
