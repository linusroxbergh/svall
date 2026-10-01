import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexHookCommand, codexPaths, mergeCodexHooks } from '../src/codex/install.js';
import { isOurs, resolvePaths } from '../src/paths.js';
import { BUNDLE_ID, LAUNCHD_LABEL, PRIVATE, profileHome, profileLabel } from '../src/profile.js';
import { bundleRuntime, checkoutRuntime, type Runtime } from '../src/runtime.js';
import {
  HOOK_EVENTS, claudeHooksCurrent, codexHooksCurrent, hookCommand, hooksInstalled, installHomeTemplate, installHookScripts, launchdPlist, mergeHooks, mergeStatusLine, nodeRun, plistCurrent, plistRun, readJsonSettings, refreshFleetPlists, runSetup, setupHome,
  shimText, shimsCurrent, statusWrapper, takenOverBy, unmergeHooks, unmergeStatusLine, writeJsonSettings,
} from '../src/setup.js';
import { shq } from '../src/text.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(() => { cleanHomes(); vi.unstubAllEnvs(); });
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const runtime = checkoutRuntime(repoRoot);
const script = '/h/.svall/hooks/agent-hook.mjs';
const status = '/h/.svall/hooks/claude-status.mjs';

describe('isOurs', () => {
  const quoted = "/Users/o'brien/.svall/hooks/agent-hook.mjs";
  it('matches the installed script anywhere in a command, bare or quoted, and its older name beside it', () => {
    expect(isOurs(`SVALL_PID=$PPID ${hookCommand('/n/node', quoted, 'claude')} --from-hook`, quoted)).toBe(true);
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
  it('runs the hook that only tells which subagent stopped without holding the agent up', () => {
    const out = mergeHooks({}, cmd, HOOK_EVENTS, script) as { hooks: Record<string, { hooks: { async?: boolean }[] }[]> };
    expect(out.hooks.SubagentStop[0].hooks[0].async).toBe(true);
    // a question must be on record before the tool call that follows its answer
    expect(out.hooks.PermissionRequest[0].hooks[0].async).toBeUndefined();
    expect(out.hooks.PreToolUse[0].hooks[0].async).toBeUndefined();
  });
  it('makes a hook an earlier setup ran in the background wait again', () => {
    const stale = mergeHooks({}, cmd, HOOK_EVENTS, script) as { hooks: Record<string, { hooks: { async?: boolean }[] }[]> };
    stale.hooks.PermissionRequest[0].hooks[0].async = true;
    const out = mergeHooks(stale, cmd, HOOK_EVENTS, script) as typeof stale;
    expect(out.hooks.PermissionRequest[0].hooks[0].async).toBeUndefined();
    expect(out.hooks.SubagentStop[0].hooks[0].async).toBe(true);
  });
  it('is idempotent', () => {
    const once = mergeHooks({}, cmd, HOOK_EVENTS, script);
    expect(mergeHooks(once, cmd, HOOK_EVENTS, script)).toEqual(once);
  });
  it('rewrites the command an earlier setup wrote, keeping the hooks beside it', () => {
    const stale = { hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: `'/old/node' '/h/.svall/hooks/claude-hook.mjs'`, timeout: 10 }, { type: 'command', command: 'mine.sh' }] }] } };
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
    expect(hooksInstalled({ hooks: foreign, statusLine }, HOOK_EVENTS, '/h/.svall')).toBe(false);
    expect(hooksInstalled({ ...mergeHooks({}, hookCommand('/n/node', script, 'claude'), HOOK_EVENTS, script), statusLine }, HOOK_EVENTS, '/h/.svall')).toBe(true);
  });
});

describe('claudeHooksCurrent', () => {
  const written = (node: string) => mergeStatusLine(mergeHooks({}, hookCommand(node, script, 'claude'), HOOK_EVENTS, script), statusWrapper(node, status), status);
  it('reads hooks another node wrote as current while that node is there, and not once it is gone', () => {
    expect(claudeHooksCurrent(written(process.execPath), '/h/.svall')).toBe(true);
    const other = path.join(makeHome(), "o'brien-node");
    fs.writeFileSync(other, '#!/bin/sh\n', { mode: 0o755 });
    expect(claudeHooksCurrent(written(other), '/h/.svall')).toBe(true);
    fs.rmSync(other);
    expect(claudeHooksCurrent(written(other), '/h/.svall')).toBe(false);
  });
  it('reads hooks that miss an event setup now subscribes as out of date, so an install sets them up again', () => {
    const settings = written(process.execPath) as { hooks: Record<string, unknown> };
    delete settings.hooks.StopFailure;
    expect(claudeHooksCurrent(settings, '/h/.svall')).toBe(false);
    const codex = mergeCodexHooks({}, codexHookCommand(script), script) as { hooks: Record<string, unknown> };
    delete codex.hooks.Interrupt;
    expect(codexHooksCurrent(codex, script)).toBe(false);
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
    const stale = { statusLine: { type: 'command', command: `'/old/node' '/h/.svall/hooks/claude-status.mjs' ${quoted}` } };
    expect(line(stale)).toEqual({ type: 'command', command: `${wrapper} ${quoted}` });
  });
  it('rebuilds a wrapper that had no inner command', () => {
    const stale = { statusLine: { type: 'command', command: "'/old/node' '/h/.svall/hooks/claude-status.mjs'" } };
    expect(line(stale)).toEqual({ type: 'command', command: wrapper });
  });
  it('wraps a statusline of the user own that shares the script name, and leaves it on the way out', () => {
    const mine = { statusLine: { type: 'command', command: 'node ~/.claude/claude-status.mjs' } };
    expect(line(mine)).toEqual({ type: 'command', command: `${wrapper} 'node ~/.claude/claude-status.mjs'` });
    expect(unmergeStatusLine(mine, status)).toEqual(mine);
    expect(hooksInstalled({ ...mergeHooks({}, `node ${shq(script)}`, HOOK_EVENTS, script), ...mine }, HOOK_EVENTS, '/h/.svall')).toBe(false);
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
    expect(sh(hookCommand(pinned, script, 'claude'), { SVALL_CHAR_ID: 'c1' })).toBe('pinned\n');
    expect(sh(nodeRun(pinned, script))).toBe('pinned\n');
  });

  it('falls back to node on PATH once that node is gone', () => {
    const { dir, script } = scripts();
    const gone = path.join(dir, 'gone', 'node');
    expect(sh(hookCommand(gone, script, 'codex'), { SVALL_CHAR_ID: 'c1' })).toBe('ran codex');
    const wrapped = mergeStatusLine({ statusLine: { type: 'command', command: 'echo mine' } }, statusWrapper(gone, script), script);
    expect(sh((wrapped as { statusLine: { command: string } }).statusLine.command, { SVALL_CHAR_ID: 'c1' })).toBe('ran echo mine');
  });

  it('skips node outside a character', () => {
    const { script, pinned } = scripts();
    expect(sh(hookCommand(pinned, script, 'claude'), { SVALL_CHAR_ID: '' })).toBe('');
    expect(sh(statusWrapper(pinned, script), { SVALL_CHAR_ID: '' })).toBe('');
    const wrapped = mergeStatusLine({ statusLine: { type: 'command', command: 'echo "args:$#"' } }, statusWrapper(pinned, script), script);
    expect(sh((wrapped as { statusLine: { command: string } }).statusLine.command, { SVALL_CHAR_ID: '' })).toBe('args:0\n');
  });

  it('runs the helper beside the script while it is there and executable, with the arguments the script would get', () => {
    const { dir, script, pinned } = scripts();
    const helper = path.join(dir, 'svall-hook');
    fs.writeFileSync(helper, '#!/bin/sh\necho "helper $*"\n', { mode: 0o755 });
    const wrapped = (inner: string) => (mergeStatusLine({ statusLine: { type: 'command', command: inner } }, statusWrapper(pinned, script), script) as { statusLine: { command: string } }).statusLine.command;
    expect(sh(hookCommand(pinned, script, 'claude'), { SVALL_CHAR_ID: 'c1' })).toMatch(/^helper claude \d+\n$/);
    expect(sh(codexHookCommand(script), { SVALL_CHAR_ID: 'c1' })).toMatch(/^helper codex \d+\n$/);
    expect(sh(wrapped("echo it's mine"), { SVALL_CHAR_ID: 'c1' })).toBe("helper status echo it's mine\n");
    expect(sh(statusWrapper(pinned, script), { SVALL_CHAR_ID: 'c1' })).toBe('helper status\n');
    expect(sh(wrapped('echo mine'), { SVALL_CHAR_ID: '' })).toBe('mine\n');
    fs.chmodSync(helper, 0o644);
    expect(sh(hookCommand(pinned, script, 'claude'), { SVALL_CHAR_ID: 'c1' })).toBe('pinned\n');
    expect(sh(wrapped('echo mine'), { SVALL_CHAR_ID: 'c1' })).toBe('pinned\n');
  });

  it('keeps the inner statusline when an earlier wrapper is rebuilt', () => {
    const once = mergeStatusLine({ statusLine: { type: 'command', command: "ccstatusline --it's" } }, nodeRun('/n/node', status), status);
    const moved = statusWrapper('/other/node', status);
    expect((mergeStatusLine(once, moved, status) as { statusLine: { command: string } }).statusLine.command)
      .toBe(`${moved} 'ccstatusline --it'\\''s'`);
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

  it('leaves the scripts to run when the helper cannot be copied, and no half copy behind', () => {
    const paths = resolvePaths(makeHome());
    const helper = built();
    fs.chmodSync(helper, 0o111);
    expect(() => installHookScripts(paths, helper)).not.toThrow();
    expect(fs.readdirSync(path.dirname(paths.hookHelper)).sort()).toEqual(['agent-hook.mjs', 'claude-status.mjs']);
  });
});

describe('commands Svall 0.1 wrote', () => {
  // what setup wrote before the helper, word for word
  const v01 = {
    hook: (node: string, script: string) => `[ -z "$SVALL_CHAR_ID" ] || { n=${shq(node)}; [ -x "$n" ] || n=node; "$n" ${shq(script)} claude "$PPID"; }`,
    codex: (script: string, node: string) => `[ -z "$SVALL_CHAR_ID" ] || { n=${shq(node)}; [ -x "$n" ] || n=node; "$n" ${shq(script)} codex "$PPID"; }`,
    status: (node: string, script: string) =>
      `svall_status() { if [ -n "$SVALL_CHAR_ID" ] && [ -f "$1" ]; then n=${shq(node)}; [ -x "$n" ] || n=node; "$n" "$@"; elif [ -n "$2" ]; then c=$2; shift 2; eval "$c"; fi; }; svall_status ${shq(script)}`,
  };
  const R = { hook: '/u/.svall/hooks/agent-hook.mjs', status: '/u/.svall/hooks/claude-status.mjs' };
  const D = { hook: '/u/.svall-dev/hooks/agent-hook.mjs', status: '/u/.svall-dev/hooks/claude-status.mjs' };
  const command = (s: Record<string, unknown>) => (s.statusLine as { command: string }).command;
  const old = (v: typeof R, inner?: string) => ({
    hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: v01.hook('/n/node', v.hook), timeout: 10 }, { type: 'command', command: 'mine.sh' }] }] },
    statusLine: { type: 'command', command: inner ? `${v01.status('/n/node', v.status)} ${shq(inner)}` : v01.status('/n/node', v.status) },
  });
  const now = (s: Record<string, unknown>, v: typeof R) =>
    mergeStatusLine(mergeHooks(s, hookCommand('/n/node', v.hook, 'claude'), ['Stop'], v.hook), statusWrapper('/n/node', v.status), v.status);

  it('rewrites them for the helper, keeping the hooks and the statusline beside them', () => {
    const out = now(old(R, "ccstatusline --it's"), R) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(out.hooks.Stop[0].hooks.map((h) => h.command)).toEqual([hookCommand('/n/node', R.hook, 'claude'), 'mine.sh']);
    expect(command(out)).toBe(`${statusWrapper('/n/node', R.status)} ${shq("ccstatusline --it's")}`);
    expect(hooksInstalled(old(R), ['Stop'], '/u/.svall')).toBe(true);
    expect(claudeHooksCurrent(old(R), '/u/.svall')).toBe(false);
    const codex = { hooks: { Stop: [{ hooks: [{ type: 'command', command: v01.codex(R.hook, '/A/node') }] }] } };
    expect((mergeCodexHooks(codex, codexHookCommand(R.hook), R.hook) as { hooks: { Stop: { hooks: { command: string }[] }[] } }).hooks.Stop[0].hooks)
      .toEqual([expect.objectContaining({ command: codexHookCommand(R.hook) })]);
  });

  it('takes them out on the way out', () => {
    expect(unmergeStatusLine(unmergeHooks(old(R, 'my-status'), R.hook), R.status))
      .toEqual({ hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'mine.sh' }] }] }, statusLine: { type: 'command', command: 'my-status' } });
  });

  // each variant updates on its own, so a 0.1 wrapper sits outside or inside the other variant's newer one
  const wrap = (s: Record<string, unknown>, v: typeof R) => mergeStatusLine(s, statusWrapper('/n/node', v.status), v.status);
  for (const [first, second] of [[R, D], [D, R]]) {
    const start = { statusLine: { type: 'command', command: 'my-status' } };
    const current = wrap(wrap(start, first), second);

    it(`nests a 0.1 wrapper outside a newer one (${first === R ? 'release' : 'dev'} outside)`, () => {
      const both = wrap({ statusLine: old(first, 'my-status').statusLine }, second);
      expect(command(both).startsWith(v01.status('/n/node', first.status))).toBe(true);
      expect(wrap(both, second)).toEqual(both);
      expect(wrap(both, first)).toEqual(current);
      expect(unmergeStatusLine(both, first.status)).toEqual(wrap(start, second));
      expect(command(unmergeStatusLine(both, second.status))).toBe(`${v01.status('/n/node', first.status)} 'my-status'`);
    });

    it(`nests a 0.1 wrapper inside a newer one (${first === R ? 'release' : 'dev'} outside)`, () => {
      const both = { statusLine: { type: 'command', command: `${statusWrapper('/n/node', first.status)} ${shq(`${v01.status('/n/node', second.status)} 'my-status'`)}` } };
      expect(wrap(both, first)).toEqual(both);
      expect(wrap(both, second)).toEqual(current);
      expect(unmergeStatusLine(both, second.status)).toEqual(wrap(start, first));
      expect(command(unmergeStatusLine(both, first.status))).toBe(`${v01.status('/n/node', second.status)} 'my-status'`);
    });
  }
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
  });
});

describe('runSetup', () => {
  it('writes no Claude settings for a Codex-only machine, and makes CODEX_HOME for its hooks', async () => {
    const home = makeHome();
    const settingsPath = path.join(home, 'claude', 'settings.json'); // its folder does not exist
    const codex = codexPaths({ CODEX_HOME: path.join(home, 'codex') }); // nor does this one
    const lines = await runSetup({ home, settingsPath, launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex, agents: ['codex'] });
    expect(fs.existsSync(settingsPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(codex.hooks, 'utf8')).hooks.SessionStart).toBeDefined();
    expect(lines.join('\n')).toContain('Trust all and continue');
  });

  it('keeps writing Claude settings when its folder exists without the CLI', async () => {
    const home = makeHome();
    const settingsPath = path.join(home, 'claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    await runSetup({ home, settingsPath, launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), agents: ['codex'] });
    expect(fs.existsSync(settingsPath)).toBe(true);
  });

  it('writes hooks, conf, settings backup, plist and shim', async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: path.join(home, 'mc') } }));
    const settingsPath = path.join(home, 'claude-settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'keep.sh' }] }] } }));
    const launchAgentsDir = path.join(home, 'LaunchAgents');
    const shimDir = path.join(home, 'bin');
    const lines = await runSetup({ home, settingsPath, launchAgentsDir, shimDir, runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }) });
    expect(lines.length).toBeGreaterThan(3);
    expect(fs.existsSync(path.join(home, 'hooks/agent-hook.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'hooks/claude-status.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'tmux.conf'))).toBe(true);
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
    await runSetup({ home, settingsPath: path.join(home, 'claude-settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir, runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }) });
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
    await runSetup({ home, settingsPath: path.join(home, 'claude-settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir, runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }) });
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

  it('runs the statusline you had without node outside a character, and once the script is gone', async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: path.join(home, 'mc') } }));
    const settingsPath = path.join(home, 'claude-settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'echo mine' } }));
    await runSetup({ home, settingsPath, launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }) });
    const line = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine.command;
    // a preload that leaves a mark shows whether node started at all
    const mark = path.join(home, 'node-ran');
    const preload = path.join(home, 'mark.cjs');
    fs.writeFileSync(preload, `require('fs').writeFileSync(${JSON.stringify(mark)}, '')\n`);
    const run = (charId: string) => {
      fs.rmSync(mark, { force: true });
      return execFileSync('sh', ['-c', line], { env: { ...process.env, SVALL_CHAR_ID: charId, SVALL_HOME: home, NODE_OPTIONS: `--require ${preload}` }, encoding: 'utf8', input: '{}' });
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
    const o = { home, settingsPath, launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }) };
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
    const o = { home, settingsPath: path.join(home, 'claude', 'settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex };
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
    const o = { home, settingsPath: path.join(home, 'claude', 'settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex };
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
    await runSetup({ home, settingsPath, launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex });
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
    const o = { home, settingsPath, launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }) };
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
    const o = { home, settingsPath: path.join(home, 'claude-settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }) };
    const lines = await runSetup(o);
    expect(lines.some((l) => l.startsWith('home folder skipped:'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'bin/svall'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'LaunchAgents/io.github.linusroxbergh.svall.svalld.plist'))).toBe(true);
  });

  it('installs no hooks for an agent the user turned off, and takes back ones already there', async () => {
    const home = makeHome();
    const settingsPath = path.join(home, 'claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const paths = { home, settingsPath, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), launchAgentsDir: path.join(home, 'la'), shimDir: path.join(home, 'bin'), runtime: checkoutRuntime(repoRoot), launchctl: false };
    await runSetup({ ...paths, agents: ['claude', 'codex'] });
    expect(fs.readFileSync(settingsPath, 'utf8')).toContain('agent-hook.mjs');
    await runSetup({ ...paths, agents: ['claude', 'codex'], integrations: ['codex'] });
    expect(fs.readFileSync(settingsPath, 'utf8')).not.toContain('agent-hook.mjs');
  });

  it('writes no Codex hooks while Codex is turned off, even with its folder there, and takes back ones already there', async () => {
    const home = makeHome();
    const codex = codexPaths({ CODEX_HOME: path.join(home, 'codex') });
    fs.mkdirSync(codex.dir);
    const paths = { home, settingsPath: path.join(home, 'claude-settings.json'), codex, launchAgentsDir: path.join(home, 'la'), shimDir: path.join(home, 'bin'), runtime, launchctl: false };
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
    await runSetup({ home, settingsPath: path.join(home, 'claude-settings.json'), codex, launchAgentsDir: path.join(home, 'la'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, agents: ['claude'], integrations: ['claude', 'codex'] });
    expect(fs.existsSync(codex.hooks)).toBe(false);
  });

  it("leaves mission control's edited settings alone on a silent refresh", async () => {
    const home = makeHome();
    const mc = path.join(home, 'mc');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: mc } }));
    const paths = { home, settingsPath: path.join(home, 'claude-settings.json'), codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }), launchAgentsDir: path.join(home, 'la'), shimDir: path.join(home, 'bin'), runtime: checkoutRuntime(repoRoot), launchctl: false };
    await runSetup(paths);
    const edited = path.join(mc, '.claude', 'settings.json');
    fs.writeFileSync(edited, '{"mine":true}\n');
    await runSetup({ ...paths, replaceSettings: false });
    expect(fs.readFileSync(edited, 'utf8')).toBe('{"mine":true}\n');
  });

  it('writes the home CLAUDE.md once and leaves an edited one alone', async () => {
    const home = makeHome();
    const mc = path.join(home, 'mc');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: mc } }));
    const o = { home, settingsPath: path.join(home, 'claude-settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }) };
    const first = await runSetup(o);
    const md = path.join(mc, 'CLAUDE.md');
    expect(first.some((l) => l.startsWith('home CLAUDE.md ->'))).toBe(true);
    expect(fs.readFileSync(md, 'utf8')).toContain('# Mission control');
    expect(fs.readFileSync(md, 'utf8')).toContain('.claude/rules/svall.md');
    fs.writeFileSync(md, 'mine');
    const second = await runSetup(o);
    expect(second.some((l) => l.startsWith('home CLAUDE.md ->'))).toBe(false);
    expect(fs.readFileSync(md, 'utf8')).toBe('mine');
  });

  it('rewrites the home skills and settings on every run', async () => {
    const home = makeHome();
    const mc = path.join(home, 'mc');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: mc } }));
    const o = { home, settingsPath: path.join(home, 'claude-settings.json'), launchAgentsDir: path.join(home, 'LaunchAgents'), shimDir: path.join(home, 'bin'), runtime, launchctl: false, codex: codexPaths({ CODEX_HOME: path.join(home, 'codex') }) };
    const first = await runSetup(o);
    expect(first.some((l) => l.startsWith('home skills ->'))).toBe(true);
    const settings = path.join(mc, '.claude/settings.json');
    const allow = JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow;
    expect(allow).toContain('Bash(svall char update:*)');
    expect(allow).not.toContain('Bash(svall:*)');
    expect(allow.some((a: string) => a.startsWith('Bash(svall char new') || a.startsWith('Bash(svall char run'))).toBe(false);
    for (const skill of ['svall-organise', 'svall-rename', 'svall-update-info', 'svall-status']) {
      expect(fs.readFileSync(path.join(mc, '.claude/skills', skill, 'SKILL.md'), 'utf8')).toContain(`name: ${skill}`);
    }
    const agentsMd = () => fs.readFileSync(path.join(mc, 'AGENTS.md'), 'utf8');
    // the crew rules, then the user's CLAUDE.md
    expect(agentsMd()).toContain('You are a crew member on the mission control island');
    expect(agentsMd()).toContain('Add your own rules for mission control here.');
    for (const skill of ['svall-organise', 'svall-rename', 'svall-update-info', 'svall-status']) {
      expect(fs.readFileSync(path.join(mc, '.agents/skills', skill, 'SKILL.md'), 'utf8')).toContain(`name: ${skill}`);
    }
    expect(fs.readFileSync(path.join(mc, '.codex/rules/svall.rules'), 'utf8')).toContain('prefix_rule(pattern = ["svall", "status"], decision = "allow")');
    // an edit to CLAUDE.md reaches codex with the next start
    fs.appendFileSync(path.join(mc, 'CLAUDE.md'), '- Launch every task in a fresh worktree.\n');
    fs.writeFileSync(settings, 'mine');
    const second = await runSetup(o);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow).toContain('Bash(svall char update:*)');
    const backup = second.find((l) => l.startsWith('backup ->') && l.includes('.claude/settings.json'));
    expect(backup).toBeDefined();
    expect(fs.readFileSync(backup!.split(' -> ')[1], 'utf8')).toBe('mine');
    expect(agentsMd()).toContain('Launch every task in a fresh worktree.');
  });

  it('backs up a hand-written AGENTS.md instead of overwriting it', () => {
    const mc = path.join(makeHome(), 'mc');
    fs.mkdirSync(mc, { recursive: true });
    const agentsMd = path.join(mc, 'AGENTS.md');
    fs.writeFileSync(agentsMd, 'my own codex crew rules');
    const done = installHomeTemplate(mc, { replaceSettings: false });
    const backup = done.find((l) => l.startsWith('backup ->') && l.includes('AGENTS.md.bak-'));
    expect(backup).toBeDefined();
    expect(fs.readFileSync(backup!.split(' -> ')[1], 'utf8')).toBe('my own codex crew rules');
    expect(fs.readFileSync(agentsMd, 'utf8')).toContain('svalld rewrites this file');
  });

  it('leaves AGENTS.md alone across runs when CLAUDE.md is a symlink to it, instead of growing it', () => {
    const mc = path.join(makeHome(), 'mc');
    fs.mkdirSync(mc, { recursive: true });
    const agentsMd = path.join(mc, 'AGENTS.md');
    const claudeMd = path.join(mc, 'CLAUDE.md');
    fs.writeFileSync(agentsMd, 'shared crew rules');
    fs.symlinkSync(agentsMd, claudeMd);
    installHomeTemplate(mc, { replaceSettings: false });
    const size1 = fs.statSync(agentsMd).size;
    installHomeTemplate(mc, { replaceSettings: false });
    const size2 = fs.statSync(agentsMd).size;
    expect(size2).toBe(size1);
    expect(fs.readFileSync(agentsMd, 'utf8')).toBe('shared crew rules');
  });

  it('a daemon start refreshes the skills but leaves edited settings alone', () => {
    const home = makeHome();
    const mc = path.join(home, 'mc');
    installHomeTemplate(mc, { replaceSettings: false });
    const settings = path.join(mc, '.claude/settings.json');
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow).toContain('Bash(svall char update:*)');

    const skill = path.join(mc, '.claude/skills/svall-rename/SKILL.md');
    const rules = path.join(mc, '.claude/rules/svall.md');
    const mine = path.join(mc, '.claude/rules/mine.md');
    fs.writeFileSync(skill, 'stale');
    fs.writeFileSync(rules, 'stale');
    fs.writeFileSync(mine, 'mine');
    fs.writeFileSync(settings, 'mine');
    const done = installHomeTemplate(mc, { replaceSettings: false });
    expect(fs.readFileSync(skill, 'utf8')).toContain('name: svall-rename');
    expect(fs.readFileSync(rules, 'utf8')).toContain('svall status');
    expect(fs.readFileSync(mine, 'utf8')).toBe('mine');
    expect(fs.readFileSync(settings, 'utf8')).toBe('mine');
    expect(done.some((l) => l.startsWith('backup ->'))).toBe(false);
  });

  // Claude Code asks before a command holding a shell variable even when a rule allows it
  it('lets the buttons run every svall command their skills name without asking, deleting an island aside', () => {
    const template = path.join(repoRoot, 'packages/svalld/home/.claude');
    const allow: string[] = JSON.parse(fs.readFileSync(path.join(template, 'settings.json'), 'utf8')).permissions.allow;
    const prefixes = allow.map((a) => /^Bash\((.+):\*\)$/.exec(a)![1]);
    for (const skill of fs.readdirSync(path.join(template, 'skills'))) {
      const text = fs.readFileSync(path.join(template, 'skills', skill, 'SKILL.md'), 'utf8');
      const commands = [...text.matchAll(/(?:`|^ {4,})(svall [^`\n]+)/gm)].map((m) => m[1].trim());
      expect(commands.length, skill).toBeGreaterThan(0);
      for (const c of commands.filter((c) => !c.startsWith('svall island delete'))) {
        expect(c, `${skill}: ${c}`).not.toContain('$');
        expect(prefixes.some((p) => c.startsWith(p)), `${skill}: ${c}`).toBe(true);
      }
    }
  });

  it('allows a Codex crew exactly the svall commands a Claude crew is allowed', () => {
    const template = path.join(repoRoot, 'packages/svalld/home');
    const allow: string[] = JSON.parse(fs.readFileSync(path.join(template, '.claude/settings.json'), 'utf8')).permissions.allow;
    // ["svall", "char", ["list", "read"]] allows svall char list and svall char read
    const expand = (pattern: (string | string[])[]): string[] =>
      pattern.reduce<string[]>((heads, word) => heads.flatMap((h) => [word].flat().map((w) => `${h} ${w}`.trim())), ['']);
    const rules = fs.readFileSync(path.join(template, '.codex/rules/svall.rules'), 'utf8');
    const codex = [...rules.matchAll(/^prefix_rule\(pattern = (\[.*\]), decision = "allow"\)$/gm)].flatMap((m) => expand(JSON.parse(m[1])));
    expect(codex.sort()).toEqual(allow.map((a) => /^Bash\((.+):\*\)$/.exec(a)![1]).sort());
  });
});

describe('refreshFleetPlists', () => {
  it('points every other fleet at this runtime, and leaves the private one to runSetup', async () => {
    const u = makeHome();
    const la = path.join(u, 'la');
    const work = path.join(u, '.svall-work');
    fs.mkdirSync(work);
    const now = bundleRuntime('/Applications/Svall.app');
    await setupHome({ home: work, label: profileLabel('work'), runtime: bundleRuntime('/Old/Svall.app'), launchAgentsDir: la, launchctl: false });
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
    await setupHome({ home: work, label: profileLabel('work'), runtime: other, launchAgentsDir: la, launchctl: false });
    await refreshFleetPlists({ homes: [work], runtime: now, launchAgentsDir: la, launchctl: false, takeOver: false });
    expect(plistCurrent({ home: work, label: profileLabel('work'), launchAgentsDir: la, runtime: other })).toBe(true);
    await refreshFleetPlists({ homes: [work], runtime: now, launchAgentsDir: la, launchctl: false, takeOver: true });
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
    const lines = await setupHome({ home, label: 'io.github.linusroxbergh.svall.svalld.work', runtime, launchAgentsDir, launchctl: false, port: 0 });
    expect(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))).toEqual({ port: 0 });
    expect(fs.existsSync(path.join(home, 'hooks/agent-hook.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'tmux.conf'))).toBe(true);
    const plist = fs.readFileSync(path.join(launchAgentsDir, 'io.github.linusroxbergh.svall.svalld.work.plist'), 'utf8');
    expect(plist).toContain('<string>io.github.linusroxbergh.svall.svalld.work</string>');
    expect(plist).toContain(`<string>${home}</string>`);
    expect(lines.some((l) => l.startsWith('launchd plist ->'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'bin'))).toBe(false);
  });

  it('leaves an existing config alone', async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), '{"port":47900}\n');
    await setupHome({ home, label: 'io.github.linusroxbergh.svall.svalld.x', runtime, launchAgentsDir: path.join(home, 'LaunchAgents'), launchctl: false, port: 0 });
    expect(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).toBe('{"port":47900}\n');
  });

  it('starts the daemon PATH at a Homebrew node folder that an upgrade keeps', async () => {
    const home = makeHome();
    const o = { home, label: 'io.github.linusroxbergh.svall.svalld.x', runtime, launchAgentsDir: path.join(home, 'LaunchAgents'), launchctl: false, port: 0 };
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
    const o = { home, label: LAUNCHD_LABEL, runtime, launchAgentsDir: path.join(home, 'LaunchAgents'), launchctl: false };
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
    const o = { home, label: LAUNCHD_LABEL, runtime, launchAgentsDir: path.join(home, 'LaunchAgents'), launchctl: false };
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

  it('passes the Claude and Codex homes on to the daemon when they are set', async () => {
    const home = makeHome();
    const o = { home, label: 'io.github.linusroxbergh.svall.svalld.x', runtime, launchAgentsDir: path.join(home, 'LaunchAgents'), launchctl: false, port: 0 };
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
    await setupHome({ home, label: LAUNCHD_LABEL, runtime: bundle, launchAgentsDir: agents, launchctl: false });
    const text = fs.readFileSync(path.join(agents, `${LAUNCHD_LABEL}.plist`), 'utf8');
    expect(plistRun(text).program).toEqual(bundle.daemon);
    expect(plistRun(text).path.some((d) => d.includes('/Contents/Helpers'))).toBe(false);
    expect(plistCurrent({ home, label: LAUNCHD_LABEL, launchAgentsDir: agents, runtime: bundle })).toBe(true);
    expect(plistCurrent({ home, label: LAUNCHD_LABEL, launchAgentsDir: agents, runtime: bundleRuntime('/Users/x/Applications/Svall.app') })).toBe(false);
    expect(text).toContain(`<key>AssociatedBundleIdentifiers</key><array><string>${BUNDLE_ID}</string></array>`);
  });

  it("names the app's node in Codex's hook for when the helper is missing, falling back to the one on PATH", () => {
    expect(codexHookCommand('/h/.svall/hooks/agent-hook.mjs', '/A/node'))
      .toBe(`[ -z "$SVALL_CHAR_ID" ] || { if [ -x '/h/.svall/hooks/svall-hook' ]; then '/h/.svall/hooks/svall-hook' codex "$PPID"; else n='/A/node'; [ -x "$n" ] || n=node; "$n" '/h/.svall/hooks/agent-hook.mjs' codex "$PPID"; fi; }`);
  });
});

describe('both variants in one statusLine', () => {
  const R = '/u/.svall/hooks/claude-status.mjs';
  const D = '/u/.svall-dev/hooks/claude-status.mjs';
  const merge = (s: Record<string, unknown>, script: string) => mergeStatusLine(s, statusWrapper('/n/node', script), script);
  const command = (s: Record<string, unknown>) => (s.statusLine as { command: string }).command;
  const start = { statusLine: { type: 'command', command: 'my-status' } };

  for (const [first, second] of [[R, D], [D, R]]) {
    it(`keeps both wrappers and the user's command when ${first === R ? 'the release' : 'Svall Dev'} set up first`, () => {
      const both = merge(merge(start, first), second);
      expect(merge(both, first)).toEqual(both);
      expect(merge(both, second)).toEqual(both);
    });

    it(`takes either variant out and leaves the other wrapping the user's command (${first === R ? 'release' : 'dev'} first)`, () => {
      const both = merge(merge(start, first), second);
      expect(command(unmergeStatusLine(both, first))).toBe(command(merge(start, second)));
      expect(command(unmergeStatusLine(both, second))).toBe(command(merge(start, first)));
      expect(command(unmergeStatusLine(unmergeStatusLine(both, second), first))).toBe('my-status');
      expect(unmergeStatusLine(unmergeStatusLine(merge(merge({}, first), second), first), second)).toEqual({});
    });
  }
});
