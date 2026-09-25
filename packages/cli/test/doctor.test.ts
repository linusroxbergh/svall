import { describe, expect, it } from 'vitest';
import { codexHookCommand, mergeCodexHooks } from '@archipelago/archid/codex/install';
import { HOOK_EVENTS, hookCommand, mergeHooks, mergeStatusLine, nodeRun, statusWrapper } from '@archipelago/archid/setup';
import { codexCheck, doctor, preflight, requireReady, type DoctorDeps } from '../src/commands/doctor.js';

const priv = { name: 'private', home: '/u/.archipelago', managed: true };
const adhoc = { name: 'archi-dev', home: '/tmp/archi-dev', managed: false };

const PLIST = '/u/Library/LaunchAgents/com.archipelago.archid.plist';
const plist = (nodeDir: string) => `<dict>\n    <key>PATH</key><string>${nodeDir}:/u/.local/bin:/usr/bin</string>\n</dict>`;

const SCRIPT = '/u/.archipelago/hooks/agent-hook.mjs';
const STATUS = '/u/.archipelago/hooks/claude-status.mjs';
const claudeSettings = (hook: string, status: string) => JSON.stringify(mergeStatusLine(mergeHooks({}, hook, HOOK_EVENTS, SCRIPT), status, STATUS));
const installed = claudeSettings(hookCommand(process.execPath, SCRIPT, 'claude'), statusWrapper(process.execPath, STATUS));

function fake(o: { commands?: Record<string, string | Error>; files?: Record<string, string>; up?: boolean; hookUp?: boolean; node?: string; pathEnv?: string; daemonEnv?: Record<string, string> } = {}) {
  const calls: string[] = [];
  const commands: Record<string, string | Error> = {
    'tmux -V': 'tmux 3.5a\n',
    'claude --version': '2.1.0 (Claude Code)\n',
    'gh auth status': '',
    'launchctl print gui/501/com.archipelago.archid': '\tstate = running\n\tlast exit code = (never exited)\n',
    ...o.commands,
  };
  const files: Record<string, string> = {
    '/u/.archipelago/port': '47800',
    '/u/.claude/settings.json': installed,
    [PLIST]: plist('/opt/homebrew/opt/node/bin'),
    '/opt/homebrew/opt/node/bin/node': '',
    '/u/.archipelago/archid.log': Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
    ...o.files,
  };
  const deps: DoctorDeps = {
    run: async (cmd, args) => {
      const key = [cmd, ...args].join(' ');
      calls.push(key);
      const out = commands[key];
      if (out === undefined) throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
      if (out instanceof Error) throw out;
      return out;
    },
    read: (p) => files[p],
    connect: async () => { if (o.up === false) throw new Error('connect ECONNREFUSED 127.0.0.1:47800'); return { close() {} }; },
    connectHook: async () => { if (o.hookUp === false) throw new Error('connect ENOENT /u/.archipelago/hooks.sock'); },
    uid: 501,
    settingsPath: '/u/.claude/settings.json',
    hooksHome: '/u/.archipelago',
    launchAgentsDir: '/u/Library/LaunchAgents',
    daemonEnv: o.daemonEnv ?? {},
    codex: CODEX,
    exists: (p) => p in files,
    node: o.node ?? 'v24.13.0',
    pathEnv: o.pathEnv ?? '/opt/homebrew/bin:/u/.local/bin:/usr/bin',
    shimDir: '/u/.local/bin',
  };
  return { deps, calls };
}

const CODEX = { dir: '/u/.codex', config: '/u/.codex/config.toml', hooks: '/u/.codex/hooks.json' };
const codexHooks = JSON.stringify(mergeCodexHooks({}, codexHookCommand(SCRIPT), SCRIPT));

const byName = (r: Awaited<ReturnType<typeof doctor>>) => Object.fromEntries(r.checks.map((c) => [c.name, c]));

describe('doctor', () => {
  it('reports a healthy fleet and the last 20 log lines', async () => {
    const r = await doctor(priv, fake().deps);
    const c = byName(r);
    expect(r.checks.every((x) => x.status === 'ok' || x === c.codex)).toBe(true);
    expect(c.codex).toMatchObject({ status: 'skip', detail: 'not installed' });
    expect(c.tmux.detail).toBe('tmux 3.5a');
    expect(c.node.detail).toBe('v24.13.0');
    expect(c.claude.detail).toBe('2.1.0 (Claude Code)');
    expect(c.archid.detail).toBe('running on port 47800');
    expect(c['hook receiver']).toMatchObject({ status: 'ok', detail: 'answering at /u/.archipelago/hooks.sock' });
    expect(c.launchd.detail).toMatch(/state = running/);
    expect(r.log.path).toBe('/u/.archipelago/archid.log');
    expect(r.log.lines).toEqual(Array.from({ length: 20 }, (_, i) => `line ${i + 11}`));
  });

  it('names what is broken and how to fix it', async () => {
    const f = fake({
      commands: {
        'tmux -V': undefined as never,
        'claude --version': undefined as never,
        'gh auth status': new Error('You are not logged into any GitHub hosts'),
        'launchctl print gui/501/com.archipelago.archid': new Error('Could not find service'),
      },
      files: { '/u/.archipelago/port': undefined as never, '/u/.claude/settings.json': '{}', '/u/.archipelago/archid.log': undefined as never },
    });
    const r = await doctor(priv, f.deps);
    const c = byName(r);
    expect(c.tmux).toMatchObject({ status: 'fail', detail: expect.stringMatching(/brew install tmux/) });
    expect(c.claude).toMatchObject({ status: 'fail', detail: expect.stringMatching(/not found/) });
    expect(c.gh).toMatchObject({ status: 'warn', detail: expect.stringMatching(/gh auth login/) });
    expect(c.archid).toMatchObject({ status: 'fail', detail: expect.stringMatching(/not running/) });
    expect(c.launchd).toMatchObject({ status: 'fail', detail: expect.stringMatching(/not loaded/) });
    expect(c.hooks).toMatchObject({ status: 'fail', detail: expect.stringMatching(/archi setup/) });
    expect(r.log.lines).toEqual([]);
  });

  it('warns about an old tmux, and fails an old node and a port nothing answers on', async () => {
    const r = await doctor(priv, fake({ commands: { 'tmux -V': 'tmux 3.4\n' }, up: false, node: 'v22.23.0' }).deps);
    const c = byName(r);
    expect(c.node).toMatchObject({ status: 'fail', detail: expect.stringMatching(/node 24/) });
    expect(c.tmux).toMatchObject({ status: 'warn', detail: expect.stringMatching(/3\.5/) });
    expect(c.archid).toMatchObject({ status: 'fail', detail: expect.stringMatching(/47800.*ECONNREFUSED/) });
  });

  it('reports a missing hook receiver even when the API is answering, and how to restart that fleet', async () => {
    const c = byName(await doctor(priv, fake({ hookUp: false }).deps));
    expect(c.archid.status).toBe('ok');
    expect(c['hook receiver']).toMatchObject({ status: 'fail', detail: expect.stringMatching(/ENOENT.*launchctl kickstart -k gui\/\$\(id -u\)\/com\.archipelago\.archid`$/) });
    const work = byName(await doctor({ name: 'work', home: '/u/.archipelago-work', managed: true }, fake({ hookUp: false }).deps));
    expect(work['hook receiver'].detail).toMatch(/com\.archipelago\.archid\.work`$/);
    expect(byName(await doctor(adhoc, fake({ hookUp: false }).deps))['hook receiver'].detail).toMatch(/restart the archid serving \/tmp\/archi-dev$/);
  });

  it('says the hooks are out of date when they hold a command or statusline setup no longer writes', async () => {
    const hook = hookCommand(process.execPath, SCRIPT, 'claude');
    const current = statusWrapper(process.execPath, STATUS);
    for (const settings of [claudeSettings(hook.replace(' "$PPID"', ''), current), claudeSettings(hook, nodeRun(process.execPath, STATUS))]) {
      expect(byName(await doctor(priv, fake({ files: { '/u/.claude/settings.json': settings } }).deps)).hooks)
        .toMatchObject({ status: 'warn', detail: 'out of date in /u/.claude/settings.json: run archi setup' });
    }
  });

  it('says the hooks of an install from before an event was added are out of date, not missing', async () => {
    const before = JSON.parse(installed) as { hooks: Record<string, unknown> };
    delete before.hooks.StopFailure;
    const oldCodex = JSON.parse(codexHooks) as { hooks: Record<string, unknown> };
    delete oldCodex.hooks.Interrupt;
    const f = fake({ files: { '/u/.claude/settings.json': JSON.stringify(before), '/u/.codex': '', '/u/.codex/hooks.json': JSON.stringify(oldCodex) } });
    const c = byName(await doctor(priv, f.deps));
    expect(c.hooks).toMatchObject({ status: 'warn', detail: 'out of date in /u/.claude/settings.json: run archi setup' });
    expect(c.codex).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^hooks out of date in \/u\/\.codex\/hooks\.json: run archi setup, then trust them with \/hooks in Codex/) });
  });

  it('warns when the node the daemon starts with is one version, or gone', async () => {
    const nvm = '/u/.nvm/versions/node/v22.12.0/bin';
    const pinned = byName(await doctor(priv, fake({ files: { [PLIST]: plist(nvm), [`${nvm}/node`]: '' } }).deps));
    expect(pinned['daemon node']).toMatchObject({ status: 'warn', detail: expect.stringMatching(/one node version.*archi setup/) });
    for (const dir of ['/opt/homebrew/Cellar/node/22.1.0_1/bin', '/nix/store/0lj7x-nodejs-22.12.0/bin']) {
      expect(byName(await doctor(priv, fake({ files: { [PLIST]: plist(dir), [`${dir}/node`]: '' } }).deps))['daemon node'].status).toBe('warn');
    }
    const gone = byName(await doctor(priv, fake({ files: { [PLIST]: plist('/opt/homebrew/opt/node@22/bin') } }).deps));
    expect(gone['daemon node']).toMatchObject({ status: 'warn', detail: expect.stringMatching(/node@22\/bin\/node is gone.*archi setup/) });
    const work = fake({ files: { '/u/Library/LaunchAgents/com.archipelago.archid.work.plist': plist('/gone') } });
    expect(byName(await doctor({ name: 'work', home: '/u/.archipelago-work', managed: true }, work.deps))['daemon node'].detail).toMatch(/archi work$/);
    expect(byName(await doctor(adhoc, fake().deps))['daemon node'].status).toBe('skip');
  });

  it('warns when the plist lacks where this shell keeps Claude and Codex files', async () => {
    const env = { CLAUDE_CONFIG_DIR: '/x/claude', CODEX_HOME: '/x/codex' };
    const lacking = byName(await doctor(priv, fake({ daemonEnv: env }).deps));
    expect(lacking['daemon env']).toMatchObject({ status: 'warn', detail: expect.stringMatching(/lacks CLAUDE_CONFIG_DIR and CODEX_HOME.*: archi setup$/) });
    const carried = `<dict>\n    <key>PATH</key><string>/opt/homebrew/opt/node/bin</string>\n    <key>CLAUDE_CONFIG_DIR</key><string>/x/claude</string>\n    <key>CODEX_HOME</key><string>/x/codex</string>\n</dict>`;
    expect(byName(await doctor(priv, fake({ daemonEnv: env, files: { [PLIST]: carried } }).deps))['daemon env'].status).toBe('ok');
    const work = fake({ daemonEnv: env, files: { '/u/Library/LaunchAgents/com.archipelago.archid.work.plist': plist('/opt/homebrew/opt/node/bin') } });
    expect(byName(await doctor({ name: 'work', home: '/u/.archipelago-work', managed: true }, work.deps))['daemon env'].detail).toMatch(/archi work$/);
    expect(byName(await doctor(priv, fake().deps))['daemon env'].status).toBe('ok');
    expect(byName(await doctor(adhoc, fake({ daemonEnv: env }).deps))['daemon env'].status).toBe('skip');
  });

  it('asks launchd about the profile it was pointed at, and not at all for an ad-hoc home', async () => {
    const work = fake({ commands: { 'launchctl print gui/501/com.archipelago.archid.work': '\tstate = running\n' } });
    expect(byName(await doctor({ name: 'work', home: '/u/.archipelago-work', managed: true }, work.deps)).launchd.status).toBe('ok');
    expect(byName(await doctor({ name: 'work', home: '/u/.archipelago-work', managed: true }, fake().deps)).launchd.detail).toMatch(/not loaded: archi work$/);
    const dev = fake();
    expect(byName(await doctor(adhoc, dev.deps)).launchd).toMatchObject({ status: 'ok', detail: expect.stringMatching(/not managed/) });
    expect(dev.calls.some((c) => c.startsWith('launchctl'))).toBe(false);
  });
});

describe('preflight', () => {
  it('checks what setup needs without asking the daemon, launchd or gh', async () => {
    const f = fake({ up: false, files: { '/u/.claude/settings.json': undefined as never } });
    const checks = await preflight(f.deps);
    expect(checks.map((c) => c.name)).toEqual(['tmux', 'node', 'claude', 'shims']);
    expect(checks.every((c) => c.status === 'ok')).toBe(true);
    expect(f.calls).toEqual(['tmux -V', 'claude --version']);
  });

  it('warns when the shim directory is not on PATH', async () => {
    const shims = (await preflight(fake({ pathEnv: '/usr/bin:/bin' }).deps)).find((c) => c.name === 'shims');
    expect(shims).toMatchObject({ status: 'warn', detail: expect.stringMatching(/\/u\/\.local\/bin is not on PATH/) });
    expect(byName(await doctor(priv, fake({ pathEnv: '/usr/bin' }).deps)).shims.status).toBe('warn');
  });
});

describe('requireReady', () => {
  it('passes warnings through and refuses on any failure, naming each', async () => {
    const warned = await preflight(fake({ commands: { 'tmux -V': 'tmux 3.4\n' } }).deps);
    expect(requireReady(warned)).toEqual([expect.stringMatching(/^! tmux/)]);
    const failed = await preflight(fake({ commands: { 'claude --version': undefined as never }, node: 'v20.1.0' }).deps);
    expect(() => requireReady(failed)).toThrow(/nothing was changed[\s\S]*✗ node[\s\S]*✗ claude/);
  });
});

describe('codexCheck', () => {
  it('warns when codex is there but the hooks are not written, or will not parse', async () => {
    for (const text of ['', '{ "hooks": ']) {
      const c = await codexCheck(fake({ files: { '/u/.codex': '', '/u/.codex/hooks.json': text } }).deps);
      expect(c.status).toBe('warn');
      expect(c.detail).toContain('archi setup');
    }
  });

  it('warns when the hooks are written but codex is not on PATH', async () => {
    const c = await codexCheck(fake({ files: { '/u/.codex': '', '/u/.codex/hooks.json': codexHooks } }).deps);
    expect(c).toMatchObject({ status: 'warn', detail: 'hooks installed, but codex is not found on PATH' });
  });

  it('warns when the hooks hold a command setup no longer writes', async () => {
    const old = JSON.stringify(mergeCodexHooks({}, codexHookCommand(SCRIPT).replace(' "$PPID"', ''), SCRIPT));
    const c = await codexCheck(fake({ files: { '/u/.codex': '', '/u/.codex/hooks.json': old }, commands: { 'codex --version': 'codex-cli 0.142.0\n' } }).deps);
    expect(c).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^hooks out of date in \/u\/\.codex\/hooks\.json: run archi setup/) });
  });

  it('names /hooks when all is in place', async () => {
    const f = fake({ files: { '/u/.codex': '', '/u/.codex/hooks.json': codexHooks }, commands: { 'codex --version': 'codex-cli 0.142.0\n' } });
    const c = await codexCheck(f.deps);
    expect(c.status).toBe('ok');
    expect(c.detail).toBe('codex-cli 0.142.0; hooks installed (review trust with /hooks in Codex)');
  });
});
