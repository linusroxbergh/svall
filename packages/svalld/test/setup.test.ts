import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeHooksCurrent, codexHooksCurrent, hookCommand, statusWrapper } from '../src/agent-hooks.js';
import { codexHookCommand, codexPaths } from '../src/codex/install.js';
import { opencodePaths } from '../src/opencode/install.js';
import { launchdPlist, plistCurrent, plistRun, takenOverBy } from '../src/launchd.js';
import { resolvePaths } from '../src/paths.js';
import { BUNDLE_ID, LAUNCHD_LABEL, PRIVATE, profileHome, profileLabel, profileOf } from '../src/profile.js';
import { bundleRuntime, checkoutRuntime, releaseRuntime, type Runtime } from '../src/runtime.js';
import { readJsonSettings, writeJsonSettings } from '../src/settings-file.js';
import { installHookScripts, refreshFleetPlists, runSetup, setupHome, setupState, shimText, shimsCurrent } from '../src/setup.js';
import { shq } from '../src/text.js';
import { cleanHomes, makeHome } from './helpers.js';

const opencodeIn = (home: string) => opencodePaths({ XDG_CONFIG_HOME: path.join(home, 'xdg'), XDG_DATA_HOME: path.join(home, 'xdg-data') });

afterEach(() => { cleanHomes(); vi.unstubAllEnvs(); });
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const runtime = checkoutRuntime(repoRoot);

describe('writeJsonSettings', () => {
  it('writes through a linked settings file and keeps its mode', () => {
    const dir = makeHome();
    const real = path.join(dir, 'dotfiles-settings.json');
    fs.writeFileSync(real, JSON.stringify({ env: { SECRET: 'x' } }));
    fs.chmodSync(real, 0o600);
    const link = path.join(dir, 'settings.json');
    fs.symlinkSync(real, link);
    const current = readJsonSettings(link);
    writeJsonSettings(current, { ...current.settings, model: 'x' }, 'settings');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, 'utf8'))).toEqual({ env: { SECRET: 'x' }, model: 'x' });
    expect(fs.statSync(real).mode & 0o777).toBe(0o600);
  });

  it('keeps a mode the umask would narrow, on the file and its backup', () => {
    const file = path.join(makeHome(), 'settings.json');
    fs.writeFileSync(file, '{}');
    fs.chmodSync(file, 0o664);
    const umask = process.umask(0o022);
    try {
      const [backup] = writeJsonSettings(readJsonSettings(file), { model: 'x' }, 'settings');
      expect(fs.statSync(file).mode & 0o777).toBe(0o664);
      expect(fs.statSync(backup.replace('backup -> ', '')).mode & 0o777).toBe(0o664);
    } finally {
      process.umask(umask);
    }
  });

  it('keeps only the newest three backups, and backups of the user own', () => {
    const file = path.join(makeHome(), 'settings.json');
    fs.writeFileSync(file, '{}');
    fs.writeFileSync(`${file}.bak-mine`, '{}');
    for (const [i, stamp] of ['1700000000001', '1700000000002', '1700000000003', '1700000000004'].entries()) {
      fs.writeFileSync(`${file}.bak-${stamp}`, '{}');
      writeJsonSettings(readJsonSettings(file), { n: i }, 'settings');
    }
    const left = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.bak-')).sort();
    expect(left).toHaveLength(4);
    expect(left).toContain('settings.json.bak-mine');
    expect(left.some((f) => f.endsWith('1700000000004'))).toBe(false);
  });

  it('refuses a read-only file, writing nothing', () => {
    const file = path.join(makeHome(), 'settings.json');
    fs.writeFileSync(file, '{}', { mode: 0o444 });
    expect(() => writeJsonSettings(readJsonSettings(file), { model: 'x' }, 'settings')).toThrow(/read-only/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{}');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['settings.json']);
  });
});

describe('installHookScripts', () => {
  const built = () => {
    const helper = path.join(makeHome(), 'svall-hook');
    fs.writeFileSync(helper, '#!/bin/sh\necho one\n', { mode: 0o755 });
    return helper;
  };

  it('puts the built helper beside the scripts, and leaves an unchanged one in place', () => {
    const paths = resolvePaths(makeHome());
    const helper = built();
    installHookScripts(paths, helper);
    expect(fs.readFileSync(paths.hookHelper, 'utf8')).toBe('#!/bin/sh\necho one\n');
    expect(fs.statSync(paths.hookHelper).mode & 0o777).toBe(0o755);
    const ino = fs.statSync(paths.hookHelper).ino;
    installHookScripts(paths, helper);
    expect(fs.statSync(paths.hookHelper).ino).toBe(ino);
    expect(fs.readdirSync(path.dirname(paths.hookHelper)).sort()).toEqual(['agent-hook.mjs', 'claude-status.mjs', 'svall-hook']);
  });

  it('renames a changed helper into place, so a hook running the old one keeps its file', () => {
    const paths = resolvePaths(makeHome());
    const helper = built();
    installHookScripts(paths, helper);
    const running = fs.openSync(paths.hookHelper, 'r');
    fs.writeFileSync(helper, '#!/bin/sh\necho two\n');
    installHookScripts(paths, helper);
    expect(fs.readFileSync(paths.hookHelper, 'utf8')).toBe('#!/bin/sh\necho two\n');
    expect(fs.readFileSync(running, 'utf8')).toBe('#!/bin/sh\necho one\n');
    fs.closeSync(running);
  });

  it('takes away a helper an earlier start put there once this build has none, so the scripts run', () => {
    const paths = resolvePaths(makeHome());
    installHookScripts(paths, built());
    installHookScripts(paths, path.join(makeHome(), 'svall-hook'));
    expect(fs.existsSync(paths.hookHelper)).toBe(false);
    expect(fs.existsSync(paths.hookScript)).toBe(true);
  });

  it("leaves the scripts to run while a checkout's helper is older than its sources", () => {
    const paths = resolvePaths(makeHome());
    const helper = built();
    installHookScripts(paths, helper);
    fs.utimesSync(helper, new Date(0), new Date(0));
    installHookScripts(paths, helper);
    expect(fs.existsSync(paths.hookHelper)).toBe(false);
    expect(fs.existsSync(paths.hookScript)).toBe(true);
  });

  it('rewrites a script only when it changed, renaming it into place, so a hook reading the old one keeps its file', () => {
    const paths = resolvePaths(makeHome());
    installHookScripts(paths, undefined);
    fs.utimesSync(paths.hookScript, new Date(0), new Date(0));
    installHookScripts(paths, undefined);
    expect(fs.statSync(paths.hookScript).mtimeMs).toBe(0);
    fs.writeFileSync(paths.hookScript, 'old');
    const reading = fs.openSync(paths.hookScript, 'r');
    installHookScripts(paths, undefined);
    expect(fs.readFileSync(paths.hookScript, 'utf8')).toContain('svalld');
    expect(fs.readFileSync(reading, 'utf8')).toBe('old');
    fs.closeSync(reading);
  });

  it('leaves the scripts to run when the helper cannot be copied, and no half copy behind', () => {
    const paths = resolvePaths(makeHome());
    const helper = built();
    fs.chmodSync(helper, 0o111);
    expect(() => installHookScripts(paths, helper)).not.toThrow();
    expect(fs.readdirSync(path.dirname(paths.hookHelper)).sort()).toEqual(['agent-hook.mjs', 'claude-status.mjs']);
  });
});

describe('launchdPlist', () => {
  it('renders label, program and environment', () => {
    const p = launchdPlist({ label: 'io.github.linusroxbergh.svall.svalld', program: ['/r/node_modules/.bin/tsx', '/r/packages/svalld/src/bin.ts'], home: '/h/.svall', log: '/h/.svall/svalld.log', pathEnv: '/opt/homebrew/bin:/usr/bin:/bin' });
    expect(p).toContain('<string>io.github.linusroxbergh.svall.svalld</string>');
    expect(p).toContain('<string>/r/node_modules/.bin/tsx</string>');
    expect(p).toContain('<key>SVALL_HOME</key>');
    // the app starts the daemon and stops it as it quits: nothing starts it at login or keeps it up after
    expect(p).toContain('<key>RunAtLoad</key><false/>');
    expect(p).not.toContain('KeepAlive');
    expect(p).toContain('<key>LANG</key>');
    expect(plistRun(p)).toEqual({ program: ['/r/node_modules/.bin/tsx', '/r/packages/svalld/src/bin.ts'], path: ['/opt/homebrew/bin', '/usr/bin', '/bin'] });
  });
});

describe('runSetup', () => {
  it('writes no Claude settings for a Codex-only machine, and makes CODEX_HOME for its hooks', async () => {
    const home = makeHome();
    const settingsPath = path.join(home, 'claude', 'settings.json'); // its folder does not exist
    const codex = codexPaths({ CODEX_HOME: path.join(home, 'codex') }); // nor does this one
    const lines = await runSetup({ home, settingsPath, launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex, opencode: opencodeIn(home), agents: ['codex'] });
    expect(fs.existsSync(settingsPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(codex.hooks, 'utf8')).hooks.SessionStart).toBeDefined();
    expect(lines.join('\n')).toContain('Trust all and continue');
  });

  it('says how to move a fleet whose profile name svall now keeps for a command, where no -p reaches it', async () => {
    const root = makeHome();
    const home = path.join(root, '.svall');
    fs.mkdirSync(path.join(root, '.svall-host'), { recursive: true });
    fs.writeFileSync(path.join(root, '.svall-host', 'fleet.json'), '{}');
    const lines = await runSetup({ home, settingsPath: path.join(root, 'claude', 'settings.json'), launchAgentsDir: path.join(root, 'LaunchAgents'), shimDir: path.join(root, 'bin'), runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(root, 'codex') }), opencode: opencodeIn(root), agents: ['codex'] });
    const host = path.join(root, '.svall-host');
    expect(lines).toContain(`${host} holds a fleet named host, a name svall now keeps for its own command, so no -p reaches it: mv ${host} ${host}-fleet, then svall host-fleet`);

    // mission control's folder inside the home moves with it
    fs.writeFileSync(path.join(host, 'fleet.json'), JSON.stringify({ id: '0b6f2c4e-5a1d-4c3b-9e8f-7a6d5c4b3a21', home: { cwd: '~/.svall-host/home' } }));
    const again = await runSetup({ home, settingsPath: path.join(root, 'claude', 'settings.json'), launchAgentsDir: path.join(root, 'LaunchAgents'), shimDir: path.join(root, 'bin'), runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(root, 'codex') }), opencode: opencodeIn(root), agents: ['codex'] });
    expect(again).toContain(`${host} holds a fleet named host, a name svall now keeps for its own command, so no -p reaches it: mv ${host} ${host}-fleet, set home.cwd in ${host}-fleet/fleet.json to ${host}-fleet/home, then svall host-fleet`);
  });

  it('sets up a fleet whose config.json names it with a word svall now keeps for a command, and says it dropped the name', async () => {
    const root = makeHome();
    const [home, work] = [path.join(root, '.svall'), path.join(root, '.svall-work')];
    for (const [dir, name] of [[home, 'host'], [work, 'version']]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ name }));
    }
    const lines = await runSetup({ home, settingsPath: path.join(root, 'claude', 'settings.json'), launchAgentsDir: path.join(root, 'LaunchAgents'), shimDir: path.join(root, 'bin'), runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(root, 'codex') }), opencode: opencodeIn(root), agents: ['codex'] });
    expect(JSON.parse(fs.readFileSync(path.join(home, 'fleet.json'), 'utf8'))).not.toHaveProperty('name');
    expect(lines).toContain(`${home} holds a fleet named host, a name svall now keeps for its own command, so the fleet goes without it; give it another in Settings`);
    expect(lines).toContain(`${work} holds a fleet named version, a name svall now keeps for its own command, so the fleet goes without it; give it another in Settings`);
  });

  it("writes the OpenCode plugin when OpenCode is here, and takes it back once it is turned off", async () => {
    const home = makeHome();
    const opencode = opencodeIn(home);
    const o = { home, settingsPath: path.join(home, 'claude-settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), opencode };
    expect(await runSetup({ ...o, agents: ['opencode'] })).toContain(`opencode plugin -> ${opencode.plugin}`);
    expect(setupState({ ...o, agents: ['opencode'] }).hooksStale).toBe(false);
    expect(setupState({ ...o, agents: ['opencode'], integrations: ['claude'] }).hooksStale).toBe(true);
    await runSetup({ ...o, agents: ['opencode'], integrations: ['claude'] });
    expect(fs.existsSync(opencode.plugin)).toBe(false);
  });

  it('keeps writing Claude settings when its folder exists without the CLI', async () => {
    const home = makeHome();
    const settingsPath = path.join(home, 'claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    await runSetup({ home, settingsPath, launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), opencode: opencodeIn(home), agents: ['codex'] });
    expect(fs.existsSync(settingsPath)).toBe(true);
  });

  it('writes hooks, settings backup, plist and shim', async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: path.join(home, 'mc') } }));
    const settingsPath = path.join(home, 'claude-settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'keep.sh' }] }] } }));
    const launchAgentsDir = path.join(home, 'LaunchAgents');
    const shimDir = path.join(home, 'bin');
    const lines = await runSetup({ home, settingsPath, launchAgentsDir, shimDir, runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), opencode: opencodeIn(home) });
    expect(lines.length).toBeGreaterThan(3);
    expect(fs.existsSync(path.join(home, 'hooks/agent-hook.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'hooks/claude-status.mjs'))).toBe(true);
    expect(fs.readdirSync(home).some((f) => f.startsWith('claude-settings.json.bak-'))).toBe(true);
    const plist = fs.readFileSync(path.join(launchAgentsDir, 'io.github.linusroxbergh.svall.svalld.plist'), 'utf8');
    expect(plist).toContain(path.join(os.homedir(), '.local', 'bin'));
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('agent-hook.mjs');
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(hookCommand(process.execPath, path.join(home, 'hooks/agent-hook.mjs'), 'claude'));
    expect(settings.statusLine.command).toContain('claude-status.mjs');
    expect(fs.existsSync(path.join(launchAgentsDir, 'io.github.linusroxbergh.svall.svalld.plist'))).toBe(true);
    const shim = fs.readFileSync(path.join(shimDir, 'svall'), 'utf8');
    expect(shim).toContain('packages/cli/src/main.ts');
    expect(fs.statSync(path.join(shimDir, 'svall')).mode & 0o111).not.toBe(0);
  });

  it('runs the cli against its own checkout from inside another one', async () => {
    const home = makeHome();
    const shimDir = path.join(home, 'bin');
    await runSetup({ home, settingsPath: path.join(home, 'claude-settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir, runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), opencode: opencodeIn(home) });
    const other = path.join(home, 'other-checkout');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'protocol.ts'), "throw new Error('the other checkout');\n");
    fs.writeFileSync(path.join(other, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@svall/protocol': ['./protocol.ts'] } } }));
    expect(execFileSync(path.join(shimDir, 'svall'), ['--help'], { cwd: other, encoding: 'utf8' })).toContain('Usage: svall');
  });

  it('calls the shims current while they are what setup writes now for this checkout', async () => {
    const home = makeHome();
    const shimDir = path.join(home, 'bin');
    expect(shimsCurrent(shimDir, runtime)).toBe(false);
    await runSetup({ home, settingsPath: path.join(home, 'claude-settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir, runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), opencode: opencodeIn(home) });
    expect(shimsCurrent(shimDir, runtime)).toBe(true);
    // the app desktop:install puts in place is this checkout's, so shims that run another one, moved or not, are out of date
    const shim = path.join(shimDir, 'svall');
    const written = fs.readFileSync(shim, 'utf8');
    fs.writeFileSync(shim, written.replaceAll(repoRoot, path.join(home, 'other-clone')));
    expect(shimsCurrent(shimDir, runtime)).toBe(false);
    fs.writeFileSync(shim, written);
    // one without --tsconfig runs whatever the caller's cwd maps @svall/* to
    fs.writeFileSync(path.join(shimDir, 'svall'), `#!/bin/sh\nexec ${shq(path.join(repoRoot, 'node_modules/.bin/tsx'))} ${shq(path.join(repoRoot, 'packages/cli/src/main.ts'))} "$@"\n`);
    expect(shimsCurrent(shimDir, runtime)).toBe(false);
  });

  it('runs the statusline you had without node outside a robot, and once the script is gone', async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: path.join(home, 'mc') } }));
    const settingsPath = path.join(home, 'claude-settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'echo mine' } }));
    await runSetup({ home, settingsPath, launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), opencode: opencodeIn(home) });
    const line = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine.command;
    // a preload that leaves a mark shows whether node started at all
    const mark = path.join(home, 'node-ran');
    const preload = path.join(home, 'mark.cjs');
    fs.writeFileSync(preload, `require('fs').writeFileSync(${JSON.stringify(mark)}, '')\n`);
    const run = (robotId: string) => {
      fs.rmSync(mark, { force: true });
      return execFileSync('sh', ['-c', line], { env: { ...process.env, SVALL_ROBOT_ID: robotId, SVALL_HOME: home, NODE_OPTIONS: `--require ${preload}` }, encoding: 'utf8', input: '{}' });
    };
    expect(run('')).toBe('mine\n');
    expect(fs.existsSync(mark)).toBe(false);
    expect(run('c1')).toBe('mine\n');
    expect(fs.existsSync(mark)).toBe(true);
    fs.rmSync(path.join(home, 'hooks'), { recursive: true });
    expect(run('c1')).toBe('mine\n');
  });

  describe('loading the service', () => {
    // a launchctl that refuses the first `refused` bootstraps and has the job loaded only once one went through
    const launchctl = (refused: number) => {
      const bin = makeHome();
      const log = path.join(bin, 'calls');
      fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/sh
echo "$1" >> '${log}'
case "$1" in
  bootstrap) [ "$(grep -c bootstrap '${log}')" -gt ${refused} ] || { echo 'Bootstrap failed: 5: Input/output error' >&2; exit 5; }; touch '${bin}/loaded' ;;
  print) [ -f '${bin}/loaded' ] ;;
esac
`, { mode: 0o755 });
      vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
      return () => fs.readFileSync(log, 'utf8').trim().split('\n');
    };
    const setup = () => {
      const home = makeHome();
      return runSetup({ home, settingsPath: path.join(home, 'claude-settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: true, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), opencode: opencodeIn(home) });
    };

    it('tries a bootstrap launchd refuses once more, as the job it booted out may still be going away', async () => {
      const calls = launchctl(1);
      expect((await setup()).at(-1)).toMatch(/^launchctl bootstrap gui\/\d+ /);
      expect(calls()).toEqual(['print', 'bootout', 'bootstrap', 'bootstrap']);
    });

    it('says launchd did not load the service once it refuses twice', async () => {
      launchctl(2);
      await expect(setup()).rejects.toThrow(`launchd did not load ${LAUNCHD_LABEL} (Bootstrap failed: 5: Input/output error); run setup again`);
    });
  });

  it('points the hooks and statusline at the installed release\'s node when a staging copy runs setup', async () => {
    const home = makeHome();
    const settingsPath = path.join(home, 'claude-settings.json');
    // this process's node stands in for the staging copy's, which is deleted once setup has run
    const release = path.join(makeHome(), 'current');
    await runSetup({ home, settingsPath, launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime: releaseRuntime(release), launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), opencode: opencodeIn(home) });
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const node = path.join(release, 'node', 'bin', 'node');
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(hookCommand(node, path.join(home, 'hooks/agent-hook.mjs'), 'claude'));
    expect(settings.statusLine.command).toBe(statusWrapper(node, path.join(home, 'hooks/claude-status.mjs')));
    expect(JSON.stringify(settings)).not.toContain(process.execPath);
    // the shims link into the release through current, which is what setup writes for one
    expect(fs.readlinkSync(path.join(home, 'bin', 'svall'))).toBe(path.join(release, 'bin', 'svall'));
    expect(shimsCurrent(path.join(home, 'bin'), releaseRuntime(release))).toBe(true);
    expect(shimsCurrent(path.join(home, 'bin'), runtime)).toBe(false);
    // a shim that links into another release is out of date for this one
    const shim = path.join(home, 'bin', 'svall');
    fs.rmSync(shim);
    fs.symlinkSync(path.join(makeHome(), 'current', 'bin', 'svall'), shim);
    expect(shimsCurrent(path.join(home, 'bin'), releaseRuntime(release))).toBe(false);
  });

  it('keeps the shim running the release when ~/.local/bin is itself a link, as GNU stow makes it', async () => {
    const root = makeHome();
    const prefix = path.join(root, '.local', 'share', 'svall');
    fs.mkdirSync(path.join(prefix, 'releases', '1.0.0', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(prefix, 'releases', '1.0.0', 'bin', 'svall'), '#!/bin/sh\necho release svall\n', { mode: 0o755 });
    const release = path.join(prefix, 'current');
    fs.symlinkSync(path.join(prefix, 'releases', '1.0.0'), release);
    fs.mkdirSync(path.join(root, 'dotfiles', 'bin'), { recursive: true });
    const shimDir = path.join(root, '.local', 'bin');
    fs.symlinkSync(path.join(root, 'dotfiles', 'bin'), shimDir);
    // a relative link resolves from the folder ~/.local/bin links to, where no release is
    const shim = path.join(shimDir, 'svall');
    fs.symlinkSync(path.relative(shimDir, path.join(release, 'bin', 'svall')), shim);
    expect(shimsCurrent(shimDir, releaseRuntime(release))).toBe(false);
    const home = makeHome();
    await runSetup({ home, settingsPath: path.join(home, 'claude-settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir, runtime: releaseRuntime(release), launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), opencode: opencodeIn(home) });
    expect(shimsCurrent(shimDir, releaseRuntime(release))).toBe(true);
    expect(execFileSync(shim, { encoding: 'utf8' })).toBe('release svall\n');
  });

  it('writes nothing when the Claude settings are not valid JSON', async () => {
    const home = makeHome();
    const settingsPath = path.join(home, 'claude-settings.json');
    fs.writeFileSync(settingsPath, '{ "hooks": ');
    const o = { home, settingsPath, launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), opencode: opencodeIn(home) };
    await expect(runSetup(o)).rejects.toThrow(`${settingsPath} is not valid JSON`);
    expect(fs.readdirSync(home)).toEqual(['claude-settings.json']);
  });

  it('writes nothing when the Claude or Codex settings link into a folder it cannot write', async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: path.join(home, 'mc') } }));
    // a store like home-manager's: read-only files in a read-only folder
    const store = path.join(home, 'store');
    fs.mkdirSync(store);
    for (const f of ['settings.json', 'hooks.json']) fs.writeFileSync(path.join(store, f), '{}', { mode: 0o444 });
    fs.chmodSync(store, 0o555);
    const codex = codexPaths({ CODEX_HOME: path.join(home, 'codex') });
    fs.mkdirSync(path.join(home, 'claude'));
    fs.mkdirSync(codex.dir);
    const o = { home, settingsPath: path.join(home, 'claude', 'settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex, opencode: opencodeIn(home) };
    try {
      for (const [link, name] of [[o.settingsPath, 'settings.json'], [codex.hooks, 'hooks.json']]) {
        fs.symlinkSync(path.join(store, name), link);
        await expect(runSetup(o)).rejects.toThrow(`${link} links to ${fs.realpathSync(path.join(store, name))}, whose folder is not writable`);
        for (const p of [o.launchAgentsDir, o.shimDir, path.join(home, 'hooks')]) expect(fs.existsSync(p)).toBe(false);
        expect(fs.readdirSync(path.dirname(link))).toEqual([name]);
        fs.rmSync(link);
      }
    } finally {
      fs.chmodSync(store, 0o755);
    }
  });

  it('runs on when a settings file linked into a folder it cannot write needs no change', async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: path.join(home, 'mc') } }));
    const codex = codexPaths({ CODEX_HOME: path.join(home, 'codex') });
    fs.mkdirSync(codex.dir);
    fs.mkdirSync(path.join(home, 'claude'));
    const o = { home, settingsPath: path.join(home, 'claude', 'settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex, opencode: opencodeIn(home) };
    await runSetup(o);
    // what setup wrote, moved into a read-only store and linked back, as a user of home-manager would declare it
    const store = path.join(home, 'store');
    fs.mkdirSync(store);
    for (const [file, name] of [[o.settingsPath, 'settings.json'], [codex.hooks, 'hooks.json']]) {
      fs.renameSync(file, path.join(store, name));
      fs.symlinkSync(path.join(store, name), file);
    }
    fs.chmodSync(store, 0o555);
    try {
      await runSetup(o);
      expect(fs.readdirSync(store).sort()).toEqual(['hooks.json', 'settings.json']);
    } finally {
      fs.chmodSync(store, 0o755);
    }
  });

  it('leaves hooks that read as current, and ones from an earlier setup that do not', async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: path.join(home, 'mc') } }));
    const codex = codexPaths({ CODEX_HOME: path.join(home, 'codex') });
    fs.mkdirSync(codex.dir);
    const settingsPath = path.join(home, 'claude-settings.json');
    await runSetup({ home, settingsPath, launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex, opencode: opencodeIn(home) });
    const hookScript = path.join(home, 'hooks/agent-hook.mjs');
    const claude = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const codexHooks = JSON.parse(fs.readFileSync(codex.hooks, 'utf8'));
    expect(claudeHooksCurrent(claude, home)).toBe(true);
    expect(codexHooksCurrent(codexHooks, hookScript)).toBe(true);
    const drop = (o: unknown) => JSON.parse(JSON.stringify(o).replaceAll(' \\"$PPID\\"', ''));
    expect(claudeHooksCurrent(drop(claude), home)).toBe(false);
    expect(codexHooksCurrent(drop(codexHooks), hookScript)).toBe(false);
  });

  it('backs up the Claude settings only when it changes them', async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: path.join(home, 'mc') } }));
    const settingsPath = path.join(home, 'claude-settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'x' }));
    const o = { home, settingsPath, launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), opencode: opencodeIn(home) };
    await runSetup(o);
    const second = await runSetup(o);
    expect(fs.readdirSync(home).filter((f) => f.startsWith('claude-settings.json.bak-'))).toHaveLength(1);
    expect(second.some((l) => l.includes('claude-settings.json'))).toBe(false);
  });

  it('finishes the run when the home folder cannot be seeded', async () => {
    const home = makeHome();
    // home.cwd sits under a regular file, so the folder can never be made
    fs.writeFileSync(path.join(home, 'blocker'), 'x');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: path.join(home, 'blocker', 'mc') } }));
    const o = { home, settingsPath: path.join(home, 'claude-settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), opencode: opencodeIn(home) };
    const lines = await runSetup(o);
    expect(lines.some((l) => l.startsWith('home folder skipped:'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'bin/svall'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'LaunchAgents/io.github.linusroxbergh.svall.svalld.plist'))).toBe(true);
  });

  it('seeds the home folder whatever fleet.json, ~/.config/svall and owner.json name', async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: path.join(home, 'mc') }, gatewayMachineId: '99999999-2222-3333-4444-555555555555' }));
    // an owner.json an older release left
    fs.writeFileSync(path.join(home, 'owner.json'), JSON.stringify({ fleetId: '11111111-2222-3333-4444-555555555555', generation: 0, ownerMachineId: '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' }));
    const config = path.join(makeHome(), '.config');
    fs.mkdirSync(config, { mode: 0o555 });
    vi.stubEnv('SVALL_CONFIG_DIR', path.join(config, 'svall'));
    try {
      const o = { home, settingsPath: path.join(home, 'claude-settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), opencode: opencodeIn(home) };
      const lines = await runSetup(o);
      expect(lines.filter((l) => l.startsWith('home folder'))).toEqual([]);
      expect(fs.existsSync(path.join(home, 'mc', 'CLAUDE.md'))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('installs no hooks for an agent the user turned off, and takes back ones already there', async () => {
    const home = makeHome();
    const settingsPath = path.join(home, 'claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const paths = { home, settingsPath, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), opencode: opencodeIn(home), launchAgentsDir: path.join(home, 'la'), shimDir: path.join(home, 'bin'), runtime: checkoutRuntime(repoRoot), launchctl: false };
    await runSetup({ ...paths, agents: ['claude', 'codex'] });
    expect(fs.readFileSync(settingsPath, 'utf8')).toContain('agent-hook.mjs');
    await runSetup({ ...paths, agents: ['claude', 'codex'], integrations: ['codex'] });
    expect(fs.readFileSync(settingsPath, 'utf8')).not.toContain('agent-hook.mjs');
  });

  it('takes back hooks from a file of plain ASCII that holds their non-ASCII path escaped', async () => {
    const home = path.join(makeHome(), 'jöran');
    fs.mkdirSync(home);
    const settingsPath = path.join(home, 'claude-settings.json');
    fs.writeFileSync(settingsPath, '{"model":"opus"}\n');
    const paths = { home, settingsPath, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), opencode: opencodeIn(home), launchAgentsDir: path.join(home, 'la'), shimDir: path.join(home, 'bin'), runtime, launchctl: false };
    await runSetup({ ...paths, agents: ['claude'] });
    expect(fs.readFileSync(settingsPath, 'utf8')).toContain('j\\u00f6ran');
    await runSetup({ ...paths, agents: ['claude'], integrations: ['codex'] });
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{"model":"opus"}\n');
  });

  it('writes no Codex hooks while Codex is turned off, even with its folder there, and takes back ones already there', async () => {
    const home = makeHome();
    const codex = codexPaths({ CODEX_HOME: path.join(home, 'codex') });
    fs.mkdirSync(codex.dir);
    const paths = { home, settingsPath: path.join(home, 'claude-settings.json'), codex, opencode: opencodeIn(home), launchAgentsDir: path.join(home, 'la'), shimDir: path.join(home, 'bin'), runtime, launchctl: false };
    await runSetup({ ...paths, agents: ['claude', 'codex'], integrations: ['claude'] });
    expect(fs.existsSync(codex.hooks)).toBe(false);
    await runSetup({ ...paths, agents: ['claude', 'codex'] });
    expect(fs.readFileSync(codex.hooks, 'utf8')).toContain('agent-hook.mjs');
    await runSetup({ ...paths, agents: ['claude', 'codex'], integrations: ['claude'] });
    expect(fs.readFileSync(codex.hooks, 'utf8')).not.toContain('agent-hook.mjs');
  });

  it('creates no hooks file for an agent the integrations name but that is not installed', async () => {
    const home = makeHome();
    const codex = codexPaths({ CODEX_HOME: path.join(home, 'codex') });
    await runSetup({ home, settingsPath: path.join(home, 'claude-settings.json'), codex, opencode: opencodeIn(home), launchAgentsDir: path.join(home, 'la'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, agents: ['claude'], integrations: ['claude', 'codex'] });
    expect(fs.existsSync(codex.hooks)).toBe(false);
  });
});

describe('refreshFleetPlists', () => {
  it('points every other fleet at this runtime, and leaves the private one to runSetup', async () => {
    const u = makeHome();
    const la = path.join(u, 'la');
    const work = path.join(u, '.svall-work');
    fs.mkdirSync(work);
    const now = bundleRuntime('/Applications/Svall.app');
    await setupHome({ home: work, label: profileLabel('work'), runtime: bundleRuntime('/Old/Svall.app'), launchAgentsDir: la });
    await refreshFleetPlists({ homes: [profileHome(PRIVATE), work], runtime: now, launchAgentsDir: la, launchctl: false, takeOver: false });
    expect(plistCurrent({ home: work, label: profileLabel('work'), launchAgentsDir: la, runtime: now })).toBe(true);
    expect(fs.existsSync(path.join(la, `${LAUNCHD_LABEL}.plist`))).toBe(false);
    expect((await refreshFleetPlists({ homes: [work], runtime: now, launchAgentsDir: la, launchctl: false, takeOver: false })).done).toEqual([]);
  });

  it('leaves a fleet that another copy on disk runs, unless told to take it over', async () => {
    const u = makeHome();
    const la = path.join(u, 'la');
    const work = path.join(u, '.svall-work');
    fs.mkdirSync(work);
    const other = bundleRuntime(path.join(u, 'Other', 'Svall.app'));
    fs.mkdirSync(path.dirname(other.daemon[0]), { recursive: true });
    fs.writeFileSync(other.daemon[0], '');
    const now = bundleRuntime('/Applications/Svall.app');
    await setupHome({ home: work, label: profileLabel('work'), runtime: other, launchAgentsDir: la });
    await refreshFleetPlists({ homes: [work], runtime: now, launchAgentsDir: la, launchctl: false, takeOver: false });
    expect(plistCurrent({ home: work, label: profileLabel('work'), launchAgentsDir: la, runtime: other })).toBe(true);
    await refreshFleetPlists({ homes: [work], runtime: now, launchAgentsDir: la, launchctl: false, takeOver: true });
    expect(plistCurrent({ home: work, label: profileLabel('work'), launchAgentsDir: la, runtime: now })).toBe(true);
  });

  it('reports a fleet whose config svalld would refuse, and still refreshes the ones after it', async () => {
    const u = makeHome();
    const la = path.join(u, 'la');
    const [bad, work] = [path.join(u, '.svall-bad'), path.join(u, '.svall-work')];
    for (const home of [bad, work]) {
      fs.mkdirSync(home);
      await setupHome({ home, label: profileLabel(profileOf(home)), runtime: bundleRuntime('/Old/Svall.app'), launchAgentsDir: la });
    }
    fs.rmSync(path.join(bad, 'fleet.json'));
    for (const f of ['config.json', 'config.json.bak']) fs.writeFileSync(path.join(bad, f), '{}');
    const now = bundleRuntime('/Applications/Svall.app');
    const { done } = await refreshFleetPlists({ homes: [bad, work], runtime: now, launchAgentsDir: la, launchctl: false, takeOver: false });
    expect(done).toContainEqual(`left ${bad}: ${path.join(bad, 'config.json.bak')} is in the way of putting ${path.join(bad, 'config.json')} beside the new files. Keep whichever of the two you want, delete the other, and start again.`);
    expect(plistCurrent({ home: work, label: profileLabel('work'), launchAgentsDir: la, runtime: now })).toBe(true);
  });
});

describe('takenOverBy', () => {
  it('names another copy of Svall that runs the fleets while it is still on disk', () => {
    const plist = (r: Runtime) => launchdPlist({ label: 'L', program: r.daemon, home: '/h', log: '/l', pathEnv: '/usr/bin' });
    const here = bundleRuntime('/Applications/Svall.app');
    const other = bundleRuntime('/Users/x/Downloads/Svall.app');
    expect(takenOverBy(plist(other), here, () => true)).toBe(other.daemon[0]);
    expect(takenOverBy(plist(other), here, () => false)).toBeUndefined();
    expect(takenOverBy(plist(here), here, () => true)).toBeUndefined();
    expect(takenOverBy(undefined, here, () => true)).toBeUndefined();
  });
});

describe('setupHome', () => {
  it('sets up a named profile with a free port and its own label, touching nothing per-user', async () => {
    const root = makeHome();
    const home = path.join(root, '.svall-work');
    const launchAgentsDir = path.join(root, 'LaunchAgents');
    const lines = await setupHome({ home, label: 'io.github.linusroxbergh.svall.svalld.work', runtime, launchAgentsDir, port: 0 });
    expect(JSON.parse(fs.readFileSync(path.join(home, 'node.json'), 'utf8'))).toMatchObject({ port: 0 });
    expect(fs.existsSync(path.join(home, 'hooks/agent-hook.mjs'))).toBe(true);
    const plist = fs.readFileSync(path.join(launchAgentsDir, 'io.github.linusroxbergh.svall.svalld.work.plist'), 'utf8');
    expect(plist).toContain('<string>io.github.linusroxbergh.svall.svalld.work</string>');
    expect(plist).toContain(`<string>${home}</string>`);
    expect(lines.some((l) => l.startsWith('launchd plist ->'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'bin'))).toBe(false);
  });

  it('keeps the settings an existing config already holds', async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), '{"port":47900}\n');
    await setupHome({ home, label: 'io.github.linusroxbergh.svall.svalld.x', runtime, launchAgentsDir: path.join(home, 'LaunchAgents'), port: 0 });
    expect(JSON.parse(fs.readFileSync(path.join(home, 'node.json'), 'utf8')).port).toBe(47900);
    expect(fs.readFileSync(path.join(home, 'config.json.bak'), 'utf8')).toBe('{"port":47900}\n');
  });

  it('says where it moved a config.json an older release wrote beside fleet.json', async () => {
    const home = makeHome();
    const o = { home, label: 'io.github.linusroxbergh.svall.svalld.x', runtime, launchAgentsDir: path.join(home, 'LaunchAgents') };
    await setupHome(o);
    fs.writeFileSync(path.join(home, 'config.json'), '{}\n');
    const lines = await setupHome(o);
    const aside = fs.readdirSync(home).find((f) => f.startsWith('config.json.unread-'))!;
    expect(lines).toContain(`${path.join(home, 'config.json')} moved to ${path.join(home, aside)} unread: this fleet's settings are in ${path.join(home, 'fleet.json')} and ${path.join(home, 'node.json')}; copy anything you still want from it into them`);
  });

  it('starts the daemon PATH at a Homebrew node folder that an upgrade keeps', async () => {
    const home = makeHome();
    const o = { home, label: 'io.github.linusroxbergh.svall.svalld.x', runtime, launchAgentsDir: path.join(home, 'LaunchAgents'), port: 0 };
    const pathEnv = () => /<key>PATH<\/key><string>([^<]*)/.exec(fs.readFileSync(path.join(o.launchAgentsDir, 'io.github.linusroxbergh.svall.svalld.x.plist'), 'utf8'))?.[1];
    const execPath = process.execPath;
    try {
      process.execPath = '/opt/homebrew/Cellar/node@22/22.12.0/bin/node';
      await setupHome(o);
      expect(pathEnv()).toMatch(/^\/opt\/homebrew\/opt\/node@22\/bin:/);
      process.execPath = '/usr/local/Cellar/node/23.1.0/bin/node';
      await setupHome(o);
      expect(pathEnv()).toMatch(/^\/usr\/local\/opt\/node\/bin:/);
      process.execPath = '/u/.nvm/versions/node/v22.12.0/bin/node';
      await setupHome(o);
      expect(pathEnv()).toMatch(/^\/u\/\.nvm\/versions\/node\/v22\.12\.0\/bin:/);
    } finally {
      process.execPath = execPath;
    }
  });

  it('adds the folder this shell finds claude in to the daemon PATH when it is not a usual one', async () => {
    const home = makeHome();
    const o = { home, label: LAUNCHD_LABEL, runtime, launchAgentsDir: path.join(home, 'LaunchAgents') };
    const pathEnv = () => /<key>PATH<\/key><string>([^<]*)/.exec(fs.readFileSync(path.join(o.launchAgentsDir, `${LAUNCHD_LABEL}.plist`), 'utf8'))?.[1];
    const pnpmHome = path.join(home, 'Library', 'pnpm');
    fs.mkdirSync(pnpmHome, { recursive: true });
    fs.writeFileSync(path.join(pnpmHome, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    const usual = ['/n/bin', path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');
    const execPath = process.execPath;
    try {
      process.execPath = '/n/bin/node';
      vi.stubEnv('PATH', `/usr/bin:${pnpmHome}`);
      await setupHome(o);
      expect(pathEnv()).toBe(`${usual}:${fs.realpathSync(pnpmHome)}`);
      vi.stubEnv('PATH', '/usr/bin:/bin');
      await setupHome(o);
      expect(pathEnv()).toBe(usual);

      // a node manager's per-shell link to the node folder, as fnm's, is that folder in every shell
      const nodeDir = path.join(home, 'node-24', 'bin');
      fs.mkdirSync(nodeDir, { recursive: true });
      for (const bin of ['node', 'claude']) fs.writeFileSync(path.join(nodeDir, bin), '#!/bin/sh\n', { mode: 0o755 });
      process.execPath = path.join(nodeDir, 'node');
      const shells = ['1', '2'].map((n) => path.join(home, 'multishells', n));
      fs.mkdirSync(path.dirname(shells[0]));
      for (const shell of shells) fs.symlinkSync(path.dirname(nodeDir), shell);
      vi.stubEnv('PATH', `${path.join(shells[0], 'bin')}:/usr/bin`);
      await setupHome(o);
      expect(pathEnv()).toBe([nodeDir, ...usual.split(':').slice(1)].join(':'));
      vi.stubEnv('PATH', `${path.join(shells[1], 'bin')}:/usr/bin`);
      expect(plistCurrent(o)).toBe(true);
    } finally {
      process.execPath = execPath;
    }
  });

  it('calls a plist current while it is what setup writes now for this checkout, and the node it names is still there', async () => {
    const home = makeHome();
    const o = { home, label: LAUNCHD_LABEL, runtime, launchAgentsDir: path.join(home, 'LaunchAgents') };
    const plist = path.join(o.launchAgentsDir, `${LAUNCHD_LABEL}.plist`);
    expect(plistCurrent(o)).toBe(false);
    await setupHome(o);
    expect(plistCurrent(o)).toBe(true);
    const written = fs.readFileSync(plist, 'utf8');
    // a plist that runs another checkout, moved or not, is out of date for this one
    fs.writeFileSync(plist, written.replaceAll(repoRoot, path.join(home, 'other-clone')));
    expect(plistCurrent(o)).toBe(false);
    fs.writeFileSync(plist, written.replace('<key>RunAtLoad</key>', '<key>ThrottleInterval</key><integer>5</integer>\n  <key>RunAtLoad</key>'));
    expect(plistCurrent(o)).toBe(false);

    // written under another node, which svall running under this one is no reason to replace, until it is gone;
    // the plist holds the node's folder as XML, & and all
    const node = path.join(home, 'R&D', 'node-22', 'bin');
    fs.mkdirSync(node, { recursive: true });
    fs.writeFileSync(path.join(node, 'node'), '#!/bin/sh\n', { mode: 0o755 });
    const execPath = process.execPath;
    try {
      process.execPath = path.join(node, 'node');
      await setupHome(o);
    } finally {
      process.execPath = execPath;
    }
    expect(fs.readFileSync(plist, 'utf8')).toContain('R&amp;D');
    expect(plistCurrent(o)).toBe(true);
    fs.rmSync(path.join(node, 'node'));
    expect(plistCurrent(o)).toBe(false);
    // and so does the checkout's
    const amp = { ...o, runtime: checkoutRuntime(path.join(home, 'R&D', 'svall')) };
    await setupHome(amp);
    expect(plistCurrent(amp)).toBe(true);
  });

  it('calls a release plist current while it runs that release, and not once it runs another one or the checkout', async () => {
    const home = makeHome();
    const release = path.join(makeHome(), 'current');
    const o = { home, label: LAUNCHD_LABEL, runtime: releaseRuntime(release), launchAgentsDir: path.join(home, 'LaunchAgents') };
    expect(plistCurrent(o)).toBe(false);
    await setupHome(o);
    expect(plistCurrent(o)).toBe(true);
    expect(plistCurrent({ ...o, runtime: releaseRuntime(path.join(makeHome(), 'current')) })).toBe(false);
    expect(plistCurrent({ ...o, runtime })).toBe(false);
  });

  it('passes the Claude and Codex homes on to the daemon when they are set', async () => {
    const home = makeHome();
    const o = { home, label: 'io.github.linusroxbergh.svall.svalld.x', runtime, launchAgentsDir: path.join(home, 'LaunchAgents'), port: 0 };
    const plist = () => fs.readFileSync(path.join(o.launchAgentsDir, 'io.github.linusroxbergh.svall.svalld.x.plist'), 'utf8');
    await setupHome(o);
    expect(plist()).not.toMatch(/CLAUDE_CONFIG_DIR|CODEX_HOME/);
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/x/claude');
    vi.stubEnv('CODEX_HOME', '/x/codex');
    await setupHome(o);
    expect(plist()).toContain('<key>CLAUDE_CONFIG_DIR</key><string>/x/claude</string>');
    expect(plist()).toContain('<key>CODEX_HOME</key><string>/x/codex</string>');
  });
});

describe('a bundled runtime', () => {
  const app = '/Applications/Svall.app';
  const bundle = bundleRuntime(app);

  it('runs the daemon and the CLI on the app\'s own node', () => {
    expect(bundle.daemon).toEqual([`${app}/Contents/Helpers/node`, `${app}/Contents/Resources/runtime/svalld.mjs`]);
    expect(bundle.cli).toEqual([`${app}/Contents/Helpers/node`, `${app}/Contents/Resources/runtime/svall.mjs`]);
    expect(bundle.bundle).toBe(app);
  });

  it('writes a shim that execs the app\'s CLI', () => {
    expect(shimText(bundle)).toBe(`#!/bin/sh\nexec '${app}/Contents/Helpers/node' '${app}/Contents/Resources/runtime/svall.mjs' "$@"\n`);
  });

  it('writes a plist whose program is the app\'s node and whose PATH leaves Helpers out', async () => {
    const home = makeHome();
    const agents = path.join(home, 'agents');
    await setupHome({ home, label: LAUNCHD_LABEL, runtime: bundle, launchAgentsDir: agents });
    const text = fs.readFileSync(path.join(agents, `${LAUNCHD_LABEL}.plist`), 'utf8');
    expect(plistRun(text).program).toEqual(bundle.daemon);
    expect(plistRun(text).path.some((d) => d.includes('/Contents/Helpers'))).toBe(false);
    expect(plistCurrent({ home, label: LAUNCHD_LABEL, launchAgentsDir: agents, runtime: bundle })).toBe(true);
    expect(plistCurrent({ home, label: LAUNCHD_LABEL, launchAgentsDir: agents, runtime: bundleRuntime('/Users/x/Applications/Svall.app') })).toBe(false);
    expect(text).toContain(`<key>AssociatedBundleIdentifiers</key><array><string>${BUNDLE_ID}</string></array>`);
  });

  it("names the app's node in Codex's hook for when the helper is missing, falling back to the one on PATH", () => {
    expect(codexHookCommand('/h/.svall/hooks/agent-hook.mjs', '/A/node'))
      .toBe(`[ -z "$SVALL_ROBOT_ID$SVALL_CHAR_ID" ] || { if [ -x '/h/.svall/hooks/svall-hook' ]; then '/h/.svall/hooks/svall-hook' codex "$PPID"; else n='/A/node'; [ -x "$n" ] || n=node; "$n" '/h/.svall/hooks/agent-hook.mjs' codex "$PPID"; fi; }`);
  });
});
