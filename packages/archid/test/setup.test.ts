import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexPaths } from '../src/codex/install.js';
import { isOurs } from '../src/paths.js';
import {
  HOOK_EVENTS, claudeHooksCurrent, codexHooksCurrent, hookCommand, hooksInstalled, installHomeTemplate, launchdPlist, mergeHooks, mergeStatusLine, nodeRun, readJsonSettings, runSetup, setupHome,
  shimsCurrent, statusWrapper, unmergeHooks, unmergeStatusLine, writeJsonSettings,
} from '../src/setup.js';
import { shq } from '../src/text.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(() => { cleanHomes(); vi.unstubAllEnvs(); });
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const script = '/h/.archipelago/hooks/agent-hook.mjs';
const status = '/h/.archipelago/hooks/claude-status.mjs';

describe('isOurs', () => {
  const quoted = "/Users/o'brien/.archipelago/hooks/agent-hook.mjs";
  it('matches the installed script anywhere in a command, bare or quoted, and its older name beside it', () => {
    expect(isOurs(`ARCHI_PID=$PPID ${hookCommand('/n/node', quoted, 'claude')} --from-hook`, quoted)).toBe(true);
    expect(isOurs(`FOO=1 node "${quoted}" claude; true`, quoted)).toBe(true);
    expect(isOurs(`/n/node ${script}`, script)).toBe(true);
    expect(isOurs(`'/old/node' ${shq(quoted.replace('agent-hook', 'claude-hook'))}`, quoted)).toBe(true);
  });
  it('leaves a script of the user own that shares the name', () => {
    for (const cmd of ['node ~/bin/claude-hook.mjs --notify', `node ${shq(quoted.replace('agent-hook', 'notify-claude-hook'))}`, 'node /elsewhere/hooks/agent-hook.mjs', undefined]) {
      expect(isOurs(cmd, quoted)).toBe(false);
    }
  });
});

describe('mergeHooks', () => {
  const cmd = `node ${shq(script)}`;
  it('adds one entry per event and keeps existing hooks', () => {
    const existing = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'other.sh' }] }] }, model: 'x' };
    const out = mergeHooks(existing, cmd, HOOK_EVENTS, script) as { hooks: Record<string, { matcher?: string; hooks: { command: string; timeout?: number }[] }[]>; model: string };
    expect(out.model).toBe('x');
    expect(out.hooks.Stop).toHaveLength(2);
    expect(out.hooks.Stop[0].hooks[0].command).toBe('other.sh');
    for (const ev of HOOK_EVENTS) expect(out.hooks[ev].some((g) => g.matcher === '*' && g.hooks.some((h) => h.command === cmd && h.timeout === 10))).toBe(true);
    expect(existing.hooks.Stop).toHaveLength(1);
  });
  it('is idempotent', () => {
    const once = mergeHooks({}, cmd, HOOK_EVENTS, script);
    expect(mergeHooks(once, cmd, HOOK_EVENTS, script)).toEqual(once);
  });
  it('rewrites the command an earlier setup wrote, keeping the hooks beside it', () => {
    const stale = { hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: `'/old/node' '/h/.archipelago/hooks/claude-hook.mjs'`, timeout: 10 }, { type: 'command', command: 'mine.sh' }] }] } };
    const out = mergeHooks(stale, cmd, HOOK_EVENTS, script) as { hooks: Record<string, { hooks: { command: string; timeout?: number }[] }[]> };
    expect(out.hooks.Stop).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 10 }, { type: 'command', command: 'mine.sh' }] }]);
  });
  it('leaves a hook of the user own that shares the script name, on the way in and out', () => {
    const mine = { hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'node ~/bin/claude-hook.mjs --notify' }] }] } };
    const out = mergeHooks(mine, cmd, ['Stop'], script) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(out.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command))).toEqual(['node ~/bin/claude-hook.mjs --notify', cmd]);
    expect(unmergeHooks(mine, script)).toEqual(mine);
  });
});

describe('hooksInstalled', () => {
  const statusLine = { type: 'command', command: statusWrapper('/n/node', status) };
  it('counts only hooks that run this fleet script, whatever they are named', () => {
    const foreign = Object.fromEntries(HOOK_EVENTS.map((ev) => [ev, [{ matcher: '*', hooks: [{ type: 'command', command: 'node /x/agent-hook.mjs claude' }] }]]));
    expect(hooksInstalled({ hooks: foreign, statusLine }, HOOK_EVENTS, '/h/.archipelago')).toBe(false);
    expect(hooksInstalled({ ...mergeHooks({}, hookCommand('/n/node', script, 'claude'), HOOK_EVENTS, script), statusLine }, HOOK_EVENTS, '/h/.archipelago')).toBe(true);
  });
});

describe('claudeHooksCurrent', () => {
  const written = (node: string) => mergeStatusLine(mergeHooks({}, hookCommand(node, script, 'claude'), HOOK_EVENTS, script), statusWrapper(node, status), status);
  it('reads hooks another node wrote as current while that node is there, and not once it is gone', () => {
    expect(claudeHooksCurrent(written(process.execPath), '/h/.archipelago')).toBe(true);
    const other = path.join(makeHome(), "o'brien-node");
    fs.writeFileSync(other, '#!/bin/sh\n', { mode: 0o755 });
    expect(claudeHooksCurrent(written(other), '/h/.archipelago')).toBe(true);
    fs.rmSync(other);
    expect(claudeHooksCurrent(written(other), '/h/.archipelago')).toBe(false);
  });
});

describe('mergeStatusLine', () => {
  const wrapper = `node ${shq(status)}`;
  const line = (o: Record<string, unknown>) => (mergeStatusLine(o, wrapper, status) as { statusLine: { type: string; command: string; padding?: number } }).statusLine;
  it('wraps the statusline the user already had and keeps its other keys', () => {
    const out = line({ statusLine: { type: 'command', command: 'ccstatusline', padding: 1 } });
    expect(out).toEqual({ type: 'command', command: `${wrapper} 'ccstatusline'`, padding: 1 });
  });
  it('stands alone when there is none', () => {
    expect(line({})).toEqual({ type: 'command', command: wrapper });
  });
  it('is idempotent', () => {
    const once = mergeStatusLine({ statusLine: { type: 'command', command: 'ccstatusline' } }, wrapper, status);
    expect(mergeStatusLine(once, wrapper, status)).toEqual(once);
  });
  it('rebuilds a wrapper whose node has moved, keeping the inner command', () => {
    // the inner command is `ccstatusline --it's`, shell-quoted the way setup writes it
    const quoted = String.raw`'ccstatusline --it'\''s'`;
    const stale = { statusLine: { type: 'command', command: `'/old/node' '/h/.archipelago/hooks/claude-status.mjs' ${quoted}` } };
    expect(line(stale)).toEqual({ type: 'command', command: `${wrapper} ${quoted}` });
  });
  it('rebuilds a wrapper that had no inner command', () => {
    const stale = { statusLine: { type: 'command', command: "'/old/node' '/h/.archipelago/hooks/claude-status.mjs'" } };
    expect(line(stale)).toEqual({ type: 'command', command: wrapper });
  });
  it('wraps a statusline of the user own that shares the script name, and leaves it on the way out', () => {
    const mine = { statusLine: { type: 'command', command: 'node ~/.claude/claude-status.mjs' } };
    expect(line(mine)).toEqual({ type: 'command', command: `${wrapper} 'node ~/.claude/claude-status.mjs'` });
    expect(unmergeStatusLine(mine, status)).toEqual(mine);
    expect(hooksInstalled({ ...mergeHooks({}, `node ${shq(script)}`, HOOK_EVENTS, script), ...mine }, HOOK_EVENTS, '/h/.archipelago')).toBe(false);
  });
});

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
});

describe('hookCommand and nodeRun', () => {
  const sh = (cmd: string, env: Record<string, string> = {}) =>
    execFileSync('sh', ['-c', cmd], { env: { ...process.env, ...env }, encoding: 'utf8', input: '' });
  const scripts = () => {
    const dir = makeHome();
    const script = path.join(dir, 'agent-hook.mjs');
    fs.writeFileSync(script, "process.stdout.write('ran ' + (process.argv[2] ?? ''))\n");
    const pinned = path.join(dir, 'node');
    fs.writeFileSync(pinned, '#!/bin/sh\necho pinned\n', { mode: 0o755 });
    return { dir, script, pinned };
  };

  it('runs the node setup ran with while it exists', () => {
    const { script, pinned } = scripts();
    expect(sh(hookCommand(pinned, script, 'claude'), { ARCHI_CHAR_ID: 'c1' })).toBe('pinned\n');
    expect(sh(nodeRun(pinned, script))).toBe('pinned\n');
  });

  it('falls back to node on PATH once that node is gone', () => {
    const { dir, script } = scripts();
    const gone = path.join(dir, 'gone', 'node');
    expect(sh(hookCommand(gone, script, 'codex'), { ARCHI_CHAR_ID: 'c1' })).toBe('ran codex');
    const wrapped = mergeStatusLine({ statusLine: { type: 'command', command: 'echo mine' } }, statusWrapper(gone, script), script);
    expect(sh((wrapped as { statusLine: { command: string } }).statusLine.command, { ARCHI_CHAR_ID: 'c1' })).toBe('ran echo mine');
  });

  it('skips node outside a character', () => {
    const { script, pinned } = scripts();
    expect(sh(hookCommand(pinned, script, 'claude'), { ARCHI_CHAR_ID: '' })).toBe('');
    expect(sh(statusWrapper(pinned, script), { ARCHI_CHAR_ID: '' })).toBe('');
    const wrapped = mergeStatusLine({ statusLine: { type: 'command', command: 'echo "args:$#"' } }, statusWrapper(pinned, script), script);
    expect(sh((wrapped as { statusLine: { command: string } }).statusLine.command, { ARCHI_CHAR_ID: '' })).toBe('args:0\n');
  });

  it('keeps the inner statusline when an earlier wrapper is rebuilt', () => {
    const once = mergeStatusLine({ statusLine: { type: 'command', command: "ccstatusline --it's" } }, nodeRun('/n/node', status), status);
    const moved = statusWrapper('/other/node', status);
    expect((mergeStatusLine(once, moved, status) as { statusLine: { command: string } }).statusLine.command)
      .toBe(`${moved} 'ccstatusline --it'\\''s'`);
  });
});

describe('launchdPlist', () => {
  it('renders label, program and environment', () => {
    const p = launchdPlist({ label: 'com.archipelago.archid', tsx: '/r/node_modules/.bin/tsx', bin: '/r/packages/archid/src/bin.ts', home: '/h/.archipelago', log: '/h/.archipelago/archid.log', pathEnv: '/opt/homebrew/bin:/usr/bin:/bin' });
    expect(p).toContain('<string>com.archipelago.archid</string>');
    expect(p).toContain('<string>/r/node_modules/.bin/tsx</string>');
    expect(p).toContain('<key>ARCHI_HOME</key>');
    expect(p).toContain('<key>KeepAlive</key>');
    expect(p).toContain('<key>LANG</key>');
  });
});

describe('runSetup', () => {
  it('writes hooks, conf, settings backup, plist and shim', async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: path.join(home, 'mc') } }));
    const settingsPath = path.join(home, 'claude-settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'keep.sh' }] }] } }));
    const launchAgentsDir = path.join(home, 'LaunchAgents');
    const shimDir = path.join(home, 'bin');
    const lines = await runSetup({ home, settingsPath, launchAgentsDir, shimDir, repoRoot, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }) });
    expect(lines.length).toBeGreaterThan(3);
    expect(fs.existsSync(path.join(home, 'hooks/agent-hook.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'hooks/claude-status.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'tmux.conf'))).toBe(true);
    expect(fs.readdirSync(home).some((f) => f.startsWith('claude-settings.json.bak-'))).toBe(true);
    const plist = fs.readFileSync(path.join(launchAgentsDir, 'com.archipelago.archid.plist'), 'utf8');
    expect(plist).toContain(path.join(os.homedir(), '.local', 'bin'));
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('agent-hook.mjs');
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(hookCommand(process.execPath, path.join(home, 'hooks/agent-hook.mjs'), 'claude'));
    expect(settings.statusLine.command).toContain('claude-status.mjs');
    expect(fs.existsSync(path.join(launchAgentsDir, 'com.archipelago.archid.plist'))).toBe(true);
    const shim = fs.readFileSync(path.join(shimDir, 'archi'), 'utf8');
    expect(shim).toContain('packages/cli/src/main.ts');
    expect(fs.statSync(path.join(shimDir, 'archi')).mode & 0o111).not.toBe(0);
  });

  it('runs the cli against its own checkout from inside another one', async () => {
    const home = makeHome();
    const shimDir = path.join(home, 'bin');
    await runSetup({ home, settingsPath: path.join(home, 'claude-settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir, repoRoot, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }) });
    const other = path.join(home, 'other-checkout');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'protocol.ts'), "throw new Error('the other checkout');\n");
    fs.writeFileSync(path.join(other, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@archipelago/protocol': ['./protocol.ts'] } } }));
    expect(execFileSync(path.join(shimDir, 'archi'), ['--help'], { cwd: other, encoding: 'utf8' })).toContain('Usage: archi');
  });

  it('calls the shims current only when they are what setup writes now, for whichever checkout they run', async () => {
    const home = makeHome();
    const shimDir = path.join(home, 'bin');
    expect(shimsCurrent(shimDir)).toBe(false);
    await runSetup({ home, settingsPath: path.join(home, 'claude-settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir, repoRoot, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }) });
    expect(shimsCurrent(shimDir)).toBe(true);
    const shim = path.join(shimDir, 'archipelago');
    fs.writeFileSync(shim, fs.readFileSync(shim, 'utf8').replaceAll(repoRoot, "/Users/o'\\''brien/archipelago"));
    expect(shimsCurrent(shimDir)).toBe(true);
    // one without --tsconfig runs whatever the caller's cwd maps @archipelago/* to
    fs.writeFileSync(shim, `#!/bin/sh\nexec ${shq(path.join(repoRoot, 'node_modules/.bin/tsx'))} ${shq(path.join(repoRoot, 'packages/cli/src/main.ts'))} "$@"\n`);
    expect(shimsCurrent(shimDir)).toBe(false);
  });

  it('runs the statusline you had without node outside a character, and once the script is gone', async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: path.join(home, 'mc') } }));
    const settingsPath = path.join(home, 'claude-settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'echo mine' } }));
    await runSetup({ home, settingsPath, launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), repoRoot, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }) });
    const line = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine.command;
    // a preload that leaves a mark shows whether node started at all
    const mark = path.join(home, 'node-ran');
    const preload = path.join(home, 'mark.cjs');
    fs.writeFileSync(preload, `require('fs').writeFileSync(${JSON.stringify(mark)}, '')\n`);
    const run = (charId: string) => {
      fs.rmSync(mark, { force: true });
      return execFileSync('sh', ['-c', line], { env: { ...process.env, ARCHI_CHAR_ID: charId, ARCHI_HOME: home, NODE_OPTIONS: `--require ${preload}` }, encoding: 'utf8', input: '{}' });
    };
    expect(run('')).toBe('mine\n');
    expect(fs.existsSync(mark)).toBe(false);
    expect(run('c1')).toBe('mine\n');
    expect(fs.existsSync(mark)).toBe(true);
    fs.rmSync(path.join(home, 'hooks'), { recursive: true });
    expect(run('c1')).toBe('mine\n');
  });

  it('writes nothing when the Claude settings are not valid JSON', async () => {
    const home = makeHome();
    const settingsPath = path.join(home, 'claude-settings.json');
    fs.writeFileSync(settingsPath, '{ "hooks": ');
    const o = { home, settingsPath, launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), repoRoot, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }) };
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
    const o = { home, settingsPath: path.join(home, 'claude', 'settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), repoRoot, launchctl: false, codex };
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
    const o = { home, settingsPath: path.join(home, 'claude', 'settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), repoRoot, launchctl: false, codex };
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
    await runSetup({ home, settingsPath, launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), repoRoot, launchctl: false, codex });
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
    const o = { home, settingsPath, launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), repoRoot, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }) };
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
    const o = { home, settingsPath: path.join(home, 'claude-settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), repoRoot, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }) };
    const lines = await runSetup(o);
    expect(lines.some((l) => l.startsWith('home folder skipped:'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'bin/archi'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'LaunchAgents/com.archipelago.archid.plist'))).toBe(true);
  });

  it('writes the home CLAUDE.md once and leaves an edited one alone', async () => {
    const home = makeHome();
    const mc = path.join(home, 'mc');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: mc } }));
    const o = { home, settingsPath: path.join(home, 'claude-settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), repoRoot, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }) };
    const first = await runSetup(o);
    const md = path.join(mc, 'CLAUDE.md');
    expect(first.some((l) => l.startsWith('home CLAUDE.md ->'))).toBe(true);
    expect(fs.readFileSync(md, 'utf8')).toContain('# Mission control');
    expect(fs.readFileSync(md, 'utf8')).toContain('.claude/rules/archipelago.md');
    fs.writeFileSync(md, 'mine');
    const second = await runSetup(o);
    expect(second.some((l) => l.startsWith('home CLAUDE.md ->'))).toBe(false);
    expect(fs.readFileSync(md, 'utf8')).toBe('mine');
  });

  it('replaces a CLAUDE.md an earlier version seeded and nobody edited', () => {
    const mc = path.join(makeHome(), 'mc');
    const md = path.join(mc, 'CLAUDE.md');
    const old = fs.readFileSync(path.join(repoRoot, 'packages/archid/test/fixtures/seeded-claude.md'), 'utf8');
    fs.mkdirSync(mc, { recursive: true });
    fs.writeFileSync(md, old);
    expect(installHomeTemplate(mc, { replaceSettings: false })).toContain(`home CLAUDE.md -> ${md}`);
    expect(fs.readFileSync(md, 'utf8')).toBe(fs.readFileSync(path.join(repoRoot, 'packages/archid/home/CLAUDE.md'), 'utf8'));
    fs.writeFileSync(md, `${old}- Launch every task in a fresh worktree.\n`);
    installHomeTemplate(mc, { replaceSettings: false });
    expect(fs.readFileSync(md, 'utf8')).toContain('fresh worktree');
  });

  it('rewrites the home skills and settings on every run', async () => {
    const home = makeHome();
    const mc = path.join(home, 'mc');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: mc } }));
    const o = { home, settingsPath: path.join(home, 'claude-settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), repoRoot, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }) };
    const first = await runSetup(o);
    expect(first.some((l) => l.startsWith('home skills ->'))).toBe(true);
    const settings = path.join(mc, '.claude/settings.json');
    const allow = JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow;
    expect(allow).toContain('Bash(archi char update:*)');
    expect(allow).not.toContain('Bash(archi:*)');
    expect(allow.some((a: string) => a.startsWith('Bash(archi char new') || a.startsWith('Bash(archi char run'))).toBe(false);
    for (const skill of ['archi-organise', 'archi-rename', 'archi-update-info', 'archi-status']) {
      expect(fs.readFileSync(path.join(mc, '.claude/skills', skill, 'SKILL.md'), 'utf8')).toContain(`name: ${skill}`);
    }
    fs.writeFileSync(settings, 'mine');
    const second = await runSetup(o);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow).toContain('Bash(archi char update:*)');
    const backup = second.find((l) => l.startsWith('backup ->') && l.includes('.claude/settings.json'));
    expect(backup).toBeDefined();
    expect(fs.readFileSync(backup!.split(' -> ')[1], 'utf8')).toBe('mine');
  });

  it('a daemon start refreshes the skills but leaves edited settings alone', () => {
    const home = makeHome();
    const mc = path.join(home, 'mc');
    installHomeTemplate(mc, { replaceSettings: false });
    const settings = path.join(mc, '.claude/settings.json');
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow).toContain('Bash(archi char update:*)');

    const skill = path.join(mc, '.claude/skills/archi-rename/SKILL.md');
    const rules = path.join(mc, '.claude/rules/archipelago.md');
    const mine = path.join(mc, '.claude/rules/mine.md');
    fs.writeFileSync(skill, 'stale');
    fs.writeFileSync(rules, 'stale');
    fs.writeFileSync(mine, 'mine');
    fs.writeFileSync(settings, 'mine');
    const done = installHomeTemplate(mc, { replaceSettings: false });
    expect(fs.readFileSync(skill, 'utf8')).toContain('name: archi-rename');
    expect(fs.readFileSync(rules, 'utf8')).toContain('archi status');
    expect(fs.readFileSync(mine, 'utf8')).toBe('mine');
    expect(fs.readFileSync(settings, 'utf8')).toBe('mine');
    expect(done.some((l) => l.startsWith('backup ->'))).toBe(false);
  });

  // Claude Code asks before a command holding a shell variable even when a rule allows it
  it('lets the buttons run every archi command their skills name without asking, deleting an island aside', () => {
    const template = path.join(repoRoot, 'packages/archid/home/.claude');
    const allow: string[] = JSON.parse(fs.readFileSync(path.join(template, 'settings.json'), 'utf8')).permissions.allow;
    const prefixes = allow.map((a) => /^Bash\((.+):\*\)$/.exec(a)![1]);
    for (const skill of fs.readdirSync(path.join(template, 'skills'))) {
      const text = fs.readFileSync(path.join(template, 'skills', skill, 'SKILL.md'), 'utf8');
      const commands = [...text.matchAll(/(?:`|^ {4,})(archi [^`\n]+)/gm)].map((m) => m[1].trim());
      expect(commands.length, skill).toBeGreaterThan(0);
      for (const c of commands.filter((c) => !c.startsWith('archi island delete'))) {
        expect(c, `${skill}: ${c}`).not.toContain('$');
        expect(prefixes.some((p) => c.startsWith(p)), `${skill}: ${c}`).toBe(true);
      }
    }
  });

  it('writes an archipelago shim next to archi', async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: path.join(home, 'mc') } }));
    const shimDir = path.join(home, 'bin');
    await runSetup({ home, settingsPath: path.join(home, 'claude-settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir, repoRoot, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }) });
    expect(fs.readFileSync(path.join(shimDir, 'archipelago'), 'utf8')).toBe(fs.readFileSync(path.join(shimDir, 'archi'), 'utf8'));
    expect(fs.statSync(path.join(shimDir, 'archipelago')).mode & 0o111).not.toBe(0);
  });
});

describe('setupHome', () => {
  it('sets up a named profile with a free port and its own label, touching nothing per-user', async () => {
    const root = makeHome();
    const home = path.join(root, '.archipelago-work');
    const launchAgentsDir = path.join(root, 'LaunchAgents');
    const lines = await setupHome({ home, label: 'com.archipelago.archid.work', repoRoot, launchAgentsDir, launchctl: false, port: 0 });
    expect(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))).toEqual({ port: 0 });
    expect(fs.existsSync(path.join(home, 'hooks/agent-hook.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'tmux.conf'))).toBe(true);
    const plist = fs.readFileSync(path.join(launchAgentsDir, 'com.archipelago.archid.work.plist'), 'utf8');
    expect(plist).toContain('<string>com.archipelago.archid.work</string>');
    expect(plist).toContain(`<string>${home}</string>`);
    expect(lines.some((l) => l.startsWith('launchd plist ->'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'bin'))).toBe(false);
  });

  it('leaves an existing config alone', async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), '{"port":47900}\n');
    await setupHome({ home, label: 'com.archipelago.archid.x', repoRoot, launchAgentsDir: path.join(home, 'LaunchAgents'), launchctl: false, port: 0 });
    expect(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).toBe('{"port":47900}\n');
  });

  it('starts the daemon PATH at a Homebrew node folder that an upgrade keeps', async () => {
    const home = makeHome();
    const o = { home, label: 'com.archipelago.archid.x', repoRoot, launchAgentsDir: path.join(home, 'LaunchAgents'), launchctl: false, port: 0 };
    const pathEnv = () => /<key>PATH<\/key><string>([^<]*)/.exec(fs.readFileSync(path.join(o.launchAgentsDir, 'com.archipelago.archid.x.plist'), 'utf8'))?.[1];
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

  it('passes the Claude and Codex homes on to the daemon when they are set', async () => {
    const home = makeHome();
    const o = { home, label: 'com.archipelago.archid.x', repoRoot, launchAgentsDir: path.join(home, 'LaunchAgents'), launchctl: false, port: 0 };
    const plist = () => fs.readFileSync(path.join(o.launchAgentsDir, 'com.archipelago.archid.x.plist'), 'utf8');
    await setupHome(o);
    expect(plist()).not.toMatch(/CLAUDE_CONFIG_DIR|CODEX_HOME/);
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/x/claude');
    vi.stubEnv('CODEX_HOME', '/x/codex');
    await setupHome(o);
    expect(plist()).toContain('<key>CLAUDE_CONFIG_DIR</key><string>/x/claude</string>');
    expect(plist()).toContain('<key>CODEX_HOME</key><string>/x/codex</string>');
  });
});
