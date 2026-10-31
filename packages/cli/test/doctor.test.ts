import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hookCommand, mergeCodexHooks, mergeHooks, mergeStatusLine, statusWrapper } from '@svall/svalld/agent-hooks';
import { codexHookCommand } from '@svall/svalld/codex/install';
import { copiedRemedy } from '@svall/svalld/machine';
import { nodeRun } from '@svall/svalld/paths';
import { svalldUnit, unitEnv } from '@svall/svalld/linux/setup';
import { LAUNCHD_LABEL } from '@svall/svalld/profile';
import { cleanHomes, makeHome } from '@svall/svalld/test-helpers';
import { ownRuntime } from '@svall/svalld/runtime';
import { resolveTmux } from '@svall/svalld/tmux';
import type { AgentKind } from '@svall/protocol';
import { DEFAULT_PREFIX } from '../../../scripts/install-release.mjs';
import { grouped } from '../src/checks-view.js';
import type { HookTrust } from '@svall/svalld/codex/trust';
import { codexCheck, doctor, doctorCommand, opencodeCheck, rebindMachineFile, reportLines, unattended, type DoctorDeps, type Report } from '../src/commands/doctor.js';
import { preflight, realPreflightDeps, requireReady } from '../src/commands/preflight.js';

const priv = { name: 'private', home: '/u/.svall', managed: true };
const adhoc = { name: 'svall-dev', home: '/tmp/svall-dev', managed: false };

const PLIST = '/u/Library/LaunchAgents/io.github.linusroxbergh.svall.svalld.plist';
const DAEMON = ['/u/svall/node_modules/.bin/tsx', '/u/svall/packages/svalld/src/bin.ts'];
const plist = (nodeDir: string, program = DAEMON) =>
  `<dict>\n  <key>ProgramArguments</key>\n  <array>\n${program.map((p) => `    <string>${p}</string>\n`).join('')}  </array>\n    <key>PATH</key><string>${nodeDir}:/u/.local/bin:/usr/bin</string>\n</dict>`;

const SCRIPT = '/u/.svall/hooks/agent-hook.mjs';
const STATUS = '/u/.svall/hooks/claude-status.mjs';
const claudeSettings = (hook: string, status: string) => JSON.stringify(mergeStatusLine(mergeHooks({}, hook, SCRIPT), status, STATUS));
const installed = claudeSettings(hookCommand(process.execPath, SCRIPT, 'claude'), statusWrapper(process.execPath, STATUS));

function fake(o: {
  commands?: Record<string, string | Error>;
  files?: Record<string, string | undefined>;
  up?: boolean;
  hookUp?: boolean;
  node?: string;
  pathEnv?: string;
  daemonEnv?: Record<string, string>;
  keys?: Record<string, string>;
  mainAgent?: AgentKind;
  found?: AgentKind[];
  trust?: HookTrust;
  shimsCurrent?: boolean;
  platform?: NodeJS.Platform;
  agentPath?: string;
  moves?: boolean;
  hardwareId?: string;
} = {}) {
  const calls: string[] = [];
  const envs: Record<string, Record<string, string> | undefined> = {};
  const commands: Record<string, string | Error> = {
    'tmux -V': 'tmux 3.5a\n',
    'claude --version': '2.1.251 (Claude Code)\n',
    'claude auth status --json': '{"loggedIn":true}\n',
    'gh auth status': '',
    'launchctl print gui/501/io.github.linusroxbergh.svall.svalld': '\tstate = running\n\tlast exit code = (never exited)\n',
    ...o.commands,
  };
  const mergedFiles: Record<string, string | undefined> = {
    '/u/.svall/port': '47800',
    '/u/.claude': '',
    '/u/.claude/settings.json': installed,
    [PLIST]: plist('/opt/homebrew/opt/node/bin'),
    '/opt/homebrew/opt/node/bin/node': '',
    ...Object.fromEntries(DAEMON.map((p) => [p, ''])),
    '/u/.svall/svalld.log': Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
    [MACHINE]: JSON.stringify({ id: '9b4d0c1e-2f3a-4b5c-8d6e-7f8091a2b3c4', hardwareId: 'HW-1' }),
    ...o.files,
  };
  const files: Record<string, string> = Object.fromEntries(Object.entries(mergedFiles).filter(([, v]) => v !== undefined) as [string, string][]);
  const deps: DoctorDeps = {
    run: async (cmd, args, how) => {
      const key = [...(how?.path ? [`PATH=${how.path}`] : []), cmd === resolveTmux() ? 'tmux' : cmd, ...args].join(' ');
      calls.push(key);
      envs[key] = how?.env;
      const out = commands[key];
      if (out === undefined) throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
      if (out instanceof Error) throw out;
      return out;
    },
    read: (p) => files[p],
    connect: async () => { if (o.up === false) throw new Error('connect ECONNREFUSED 127.0.0.1:47800'); return { close() {} }; },
    connectHook: async () => { if (o.hookUp === false) throw Object.assign(new Error('connect ENOENT /u/.svall/hooks.sock - Local (undefined:undefined)'), { code: 'ENOENT' }); },
    uid: 501,
    settingsPath: '/u/.claude/settings.json',
    hooksHome: '/u/.svall',
    launchAgentsDir: '/u/Library/LaunchAgents',
    unitDir: '/u/.config/systemd/user',
    daemonEnv: o.daemonEnv ?? {},
    codex: CODEX,
    opencode: OPENCODE,
    exists: (p) => p in files,
    node: o.node ?? 'v24.13.0',
    pathEnv: o.pathEnv ?? '/opt/homebrew/bin:/u/.local/bin:/usr/bin',
    ...(o.agentPath && { agentPath: o.agentPath }),
    shimDir: '/u/.local/bin',
    keys: o.keys ?? {},
    mainAgent: o.mainAgent,
    found: o.found ?? ['claude'],
    codexTrust: async () => o.trust,
    shimsCurrent: o.shimsCurrent ?? true,
    daemon: DAEMON,
    platform: o.platform ?? 'darwin',
    moves: o.moves ?? true,
    user: 'linus',
    machine: { file: MACHINE, hardwareId: o.hardwareId ?? 'HW-1' },
  };
  return { deps, calls, envs };
}

const CODEX = { dir: '/u/.codex', config: '/u/.codex/config.toml', hooks: '/u/.codex/hooks.json' };
const MACHINE = '/u/.config/svall/machine.json';
const OPENCODE = { dir: '/u/.config/opencode', plugin: '/u/.config/opencode/plugins/svall.js', data: '/u/.local/share/opencode' };
const PLUGIN_SOURCE = path.resolve(import.meta.dirname, '../../svalld/hooks/opencode-plugin.js');
const codexHooks = JSON.stringify(mergeCodexHooks({}, codexHookCommand(SCRIPT), SCRIPT));

const byName = (r: Awaited<ReturnType<typeof doctor>>) => Object.fromEntries(r.checks.map((c) => [c.name, c]));

describe('doctor', () => {
  it('reports a healthy fleet and the last 20 log lines', async () => {
    const r = await doctor(priv, fake().deps);
    const c = byName(r);
    expect(r.checks.every((x) => x.status === 'ok' || x === c.codex || x === c.opencode || x === c['codex hooks'] || x === c['opencode plugin'])).toBe(true);
    expect(c.codex).toMatchObject({ status: 'skip', detail: 'not installed' });
    expect(c['codex hooks']).toMatchObject({ status: 'skip', detail: 'not installed' });
    expect(c.tmux.detail).toBe('tmux 3.5a');
    expect(c.node.detail).toBe('v24.13.0');
    expect(c.claude.detail).toBe('2.1.251 (Claude Code), signed in');
    expect(c.svalld.detail).toBe('running on port 47800');
    expect(c['hook receiver']).toMatchObject({ status: 'ok', detail: 'answering at /u/.svall/hooks.sock' });
    expect(c.launchd.detail).toMatch(/state = running/);
    expect(c.rsync).toBeUndefined();
    expect(r.log.path).toBe('/u/.svall/svalld.log');
    expect(r.log.lines).toEqual(Array.from({ length: 20 }, (_, i) => `line ${i + 11}`));
    // the plain report shows every check under a title
    expect(grouped(r.checks).flatMap((g) => g.checks)).toHaveLength(r.checks.length);
    expect(r.config).toEqual({ fleet: '/u/.svall/fleet.json', node: '/u/.svall/node.json' });
    expect(reportLines(r)).toContain('config /u/.svall/fleet.json and /u/.svall/node.json');
  });

  it('warns of a machine.json made on other hardware, with how this machine gets an id of its own', async () => {
    expect(byName(await doctor(priv, fake().deps))['machine id']).toEqual({ name: 'machine id', status: 'ok', detail: `${MACHINE} was made on this machine` });
    expect(byName(await doctor(priv, fake({ hardwareId: 'HW-2' }).deps))['machine id']).toEqual({
      name: 'machine id', status: 'warn', detail: `${MACHINE} was made on hardware HW-1, and this machine is HW-2: ${copiedRemedy(MACHINE)}`,
    });
    // a file svalld has not bound to its hardware yet, or not made yet, has nothing to compare
    for (const text of ['{"id":"9b4d0c1e-2f3a-4b5c-8d6e-7f8091a2b3c4"}', undefined]) {
      expect(byName(await doctor(priv, fake({ files: { [MACHINE]: text } }).deps))['machine id']).toMatchObject({ status: 'skip' });
    }
  });

  it('binds machine.json to this machine\'s hardware with --rebind, for a person at a terminal, and only when it was made on other hardware', () => {
    const bound: string[] = [];
    const run = (o: { stored?: string; actual?: string; unattended?: string }) => rebindMachineFile({
      file: MACHINE, hardwareId: o.actual, unattended: o.unattended,
      read: () => JSON.stringify({ id: '9b4d0c1e-2f3a-4b5c-8d6e-7f8091a2b3c4', ...(o.stored && { hardwareId: o.stored }) }),
      rebind: (hw) => { bound.push(hw); },
    });
    expect(run({ stored: 'HW-1', actual: 'HW-2', unattended: 'has no terminal' })).toEqual({ ok: false, message: expect.stringMatching(/^nothing was changed: .*a person at a terminal.*has no terminal$/) });
    expect(run({ stored: 'HW-1', actual: 'HW-1' })).toEqual({ ok: true, message: `${MACHINE} was made on this machine: there is nothing to rebind` });
    expect(run({ stored: 'HW-1' })).toEqual({ ok: false, message: expect.stringContaining('cannot be read') });
    expect(bound).toEqual([]);
    expect(run({ stored: 'HW-1', actual: 'HW-2' })).toEqual({ ok: true, message: expect.stringContaining(`${MACHINE} is bound to this machine's hardware`) });
    expect(bound).toEqual(['HW-2']);
  });

  it('refuses to rebind machine.json from a robot pane or with no terminal', () => {
    expect(unattended({ SVALL_ROBOT_ID: 'c_1' }, true)).toBe("is a robot's");
    expect(unattended({}, false)).toBe('has no terminal');
  });

  it("takes a run at a terminal, in a tmux of its own too, for a person's, and not one in a fleet's tmux pane", () => {
    const fleet = makeHome();
    expect(unattended({}, true)).toBeUndefined();
    expect(unattended({ TMUX: '/private/tmp/tmux-501/default,4242,0' }, true)).toBeUndefined();
    // a tmux.sock beside no fleet.json is no fleet's
    expect(unattended({ TMUX: `${path.join(fleet, 'tmux.sock')},4242,0` }, true)).toBeUndefined();
    fs.writeFileSync(path.join(fleet, 'fleet.json'), JSON.stringify({ id: '11111111-2222-3333-4444-555555555555' }));
    expect(unattended({ TMUX: `${path.join(fleet, 'tmux.sock')},4242,0` }, true)).toBe("is in a fleet's tmux pane");
  });

  it('warns about shims setup would write differently now, and a plist that is missing or runs another build', async () => {
    const c = byName(await doctor(priv, fake({ shimsCurrent: false }).deps));
    expect(c.shims).toEqual({ name: 'shims', status: 'warn', detail: 'missing or not what this build writes: run svall setup from the build you use' });
    // the PATH setup took from its own shell is the daemon path check's to judge
    expect(c['launchd plist']).toEqual({ name: 'launchd plist', status: 'ok', detail: `${PLIST} runs this build` });
    const other = fake({ files: { [PLIST]: plist('/opt/homebrew/opt/node/bin', ['/old/svall/node_modules/.bin/tsx', '/old/svall/packages/svalld/src/bin.ts']) } });
    expect(byName(await doctor(priv, other.deps))['launchd plist']).toEqual({ name: 'launchd plist', status: 'warn', detail: 'runs another build: svall setup, from the build you use' });
    expect(byName(await doctor(priv, fake({ files: { [PLIST]: undefined } }).deps))['launchd plist']).toMatchObject({ status: 'warn', detail: 'missing: svall setup' });
    expect(byName(await doctor(adhoc, fake().deps))['launchd plist'].status).toBe('skip');
  });

  it('names what is broken and how to fix it', async () => {
    const f = fake({
      commands: {
        'tmux -V': undefined as never,
        'claude --version': undefined as never,
        'gh auth status': new Error('You are not logged into any GitHub hosts'),
        'launchctl print gui/501/io.github.linusroxbergh.svall.svalld': new Error('Could not find service'),
      },
      files: { '/u/.svall/port': undefined as never, '/u/.claude/settings.json': '{}', '/u/.svall/svalld.log': undefined as never },
    });
    const r = await doctor(priv, f.deps);
    const c = byName(r);
    expect(c.tmux).toMatchObject({ status: 'fail', detail: expect.stringMatching(/brew install tmux/) });
    expect(c.agents).toMatchObject({ status: 'fail', detail: expect.stringContaining('no agent CLI (claude, codex or opencode) is on PATH') });
    expect(c.gh).toMatchObject({ status: 'warn', detail: expect.stringMatching(/gh auth login/) });
    expect(c.svalld).toMatchObject({ status: 'warn', detail: expect.stringMatching(/not running .*: it starts when Svall opens on this fleet$/) });
    expect(c['hook receiver']).toMatchObject({ status: 'skip', detail: 'svalld is not running' });
    expect(c.launchd).toMatchObject({ status: 'fail', detail: expect.stringMatching(/not loaded/) });
    expect(c.hooks).toMatchObject({ status: 'fail', detail: expect.stringMatching(/svall setup/) });
    expect(r.log.lines).toEqual([]);
  });

  it('warns about an old tmux, and fails an old node and a port nothing answers on', async () => {
    const r = await doctor(priv, fake({ commands: { 'tmux -V': 'tmux 3.4\n' }, up: false, node: 'v22.23.0' }).deps);
    const c = byName(r);
    expect(c.node).toMatchObject({ status: 'fail', detail: expect.stringMatching(/node 24/) });
    expect(c.tmux).toMatchObject({ status: 'warn', detail: expect.stringMatching(/3\.5/) });
    expect(c.svalld).toMatchObject({ status: 'fail', detail: expect.stringMatching(/47800.*ECONNREFUSED/) });
  });

  it('names the process holding a port svalld does not answer on, or one config.json sets while svalld is down', async () => {
    const holder = 'p4242\ncnc\nf3\n';
    const stale = byName(await doctor(priv, fake({ up: false, commands: { 'lsof -nP -iTCP:47800 -sTCP:LISTEN -Fpc': holder } }).deps));
    expect(stale.svalld).toMatchObject({ status: 'fail', detail: expect.stringMatching(/^port 47800 does not answer: .*; nc \(pid 4242\) holds it$/) });
    const files = { '/u/.svall/port': undefined, '/u/.svall/config.json': '{"port":47801}' };
    const set = fake({ commands: { 'lsof -nP -iTCP@127.0.0.1:47801 -sTCP:LISTEN -Fpc': holder }, files });
    expect(byName(await doctor(priv, set.deps)).svalld).toEqual({ name: 'svalld', status: 'fail', detail: 'not running: nc (pid 4242) holds port 47801, which /u/.svall/config.json sets; stop it, or take port out of config.json' });
    // a listener on another address, as on *:47801, leaves svalld's bind on 127.0.0.1 free
    const elsewhere = fake({ commands: { 'lsof -nP -iTCP:47801 -sTCP:LISTEN -Fpc': holder }, files });
    expect(byName(await doctor(priv, elsewhere.deps)).svalld.status).toBe('warn');
  });

  it('reports a missing hook receiver even when the API is answering, and how to restart that fleet', async () => {
    const c = byName(await doctor(priv, fake({ hookUp: false }).deps));
    expect(c.svalld.status).toBe('ok');
    expect(c['hook receiver']).toMatchObject({ status: 'fail', detail: expect.stringMatching(/does not answer \(ENOENT\); restart it with `launchctl kickstart -k gui\/\$\(id -u\)\/io\.github\.linusroxbergh\.svall\.svalld`$/) });
    const work = byName(await doctor({ name: 'work', home: '/u/.svall-work', managed: true }, fake({ hookUp: false, files: { '/u/.svall-work/port': '51000' } }).deps));
    expect(work['hook receiver'].detail).toMatch(/io\.github\.linusroxbergh\.svall\.svalld\.work`$/);
    expect(byName(await doctor(adhoc, fake({ hookUp: false, files: { '/tmp/svall-dev/port': '47900' } }).deps))['hook receiver'].detail).toMatch(/restart the svalld serving \/tmp\/svall-dev$/);
  });

  it('reads a fleet whose window is shut as at rest, not broken', async () => {
    const f = fake({
      hookUp: false,
      commands: { 'launchctl print gui/501/io.github.linusroxbergh.svall.svalld': '\tstate = not running\n\tlast exit code = 0\n' },
      files: { '/u/.svall/port': undefined as never },
    });
    const r = await doctor(priv, f.deps);
    const c = byName(r);
    expect(c.svalld.status).toBe('warn');
    expect(c['hook receiver']).toMatchObject({ status: 'skip', detail: 'svalld is not running' });
    expect(c.launchd.status).toBe('ok');
    expect(r.checks.filter((x) => x.status === 'fail')).toEqual([]);
  });

  it('says the hooks are out of date when they hold a command or statusline setup no longer writes', async () => {
    const hook = hookCommand(process.execPath, SCRIPT, 'claude');
    const current = statusWrapper(process.execPath, STATUS);
    for (const settings of [claudeSettings(hook.replace(' "$PPID"', ''), current), claudeSettings(hook, nodeRun(process.execPath, STATUS))]) {
      expect(byName(await doctor(priv, fake({ files: { '/u/.claude/settings.json': settings } }).deps)).hooks)
        .toMatchObject({ status: 'warn', detail: 'out of date in /u/.claude/settings.json: run svall setup' });
    }
  });

  it('says the hooks of an install from before an event was added are out of date, not missing', async () => {
    const before = JSON.parse(installed) as { hooks: Record<string, unknown> };
    delete before.hooks.StopFailure;
    const oldCodex = JSON.parse(codexHooks) as { hooks: Record<string, unknown> };
    delete oldCodex.hooks.Interrupt;
    const f = fake({ files: { '/u/.claude/settings.json': JSON.stringify(before), '/u/.codex': '', '/u/.codex/hooks.json': JSON.stringify(oldCodex) } });
    const c = byName(await doctor(priv, f.deps));
    expect(c.hooks).toMatchObject({ status: 'warn', detail: 'out of date in /u/.claude/settings.json: run svall setup' });
    expect(c['codex hooks']).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^out of date in \/u\/\.codex\/hooks\.json: run svall setup, then trust them in Codex/) });
  });

  it('warns when the node the daemon starts with is one version, or gone', async () => {
    const nvm = '/u/.nvm/versions/node/v22.12.0/bin';
    const pinned = byName(await doctor(priv, fake({ files: { [PLIST]: plist(nvm), [`${nvm}/node`]: '' } }).deps));
    expect(pinned['daemon node']).toMatchObject({ status: 'warn', detail: expect.stringMatching(/one node version.*svall setup/) });
    for (const dir of ['/opt/homebrew/Cellar/node/22.1.0_1/bin', '/nix/store/0lj7x-nodejs-22.12.0/bin']) {
      expect(byName(await doctor(priv, fake({ files: { [PLIST]: plist(dir), [`${dir}/node`]: '' } }).deps))['daemon node'].status).toBe('warn');
    }
    const gone = byName(await doctor(priv, fake({ files: { [PLIST]: plist('/opt/homebrew/opt/node@22/bin') } }).deps));
    expect(gone['daemon node']).toMatchObject({ status: 'warn', detail: expect.stringMatching(/node@22\/bin\/node is gone.*svall setup/) });
    const work = fake({ files: { '/u/Library/LaunchAgents/io.github.linusroxbergh.svall.svalld.work.plist': plist('/gone') } });
    expect(byName(await doctor({ name: 'work', home: '/u/.svall-work', managed: true }, work.deps))['daemon node'].detail).toMatch(/svall work$/);
    expect(byName(await doctor(adhoc, fake().deps))['daemon node'].status).toBe('skip');
  });

  it("takes the app's own node as the daemon's node", async () => {
    const node = '/Applications/Svall.app/Contents/Helpers/node';
    const text = `<key>ProgramArguments</key><array><string>${node}</string><string>/Applications/Svall.app/Contents/Resources/runtime/svalld.mjs</string></array>`;
    expect(byName(await doctor(priv, fake({ files: { [PLIST]: text } }).deps))['daemon node'])
      .toEqual({ name: 'daemon node', status: 'ok', detail: `${node} (the app's own)` });
  });

  it('fails a plist whose program is gone, and warns when its PATH lacks a claude or codex this shell finds', async () => {
    const TSX = '/old/R&amp;D/svall/node_modules/.bin/tsx';
    const runs = (program: string[], pathEnv: string) =>
      `<dict>\n  <key>ProgramArguments</key>\n  <array>\n${program.map((a) => `    <string>${a}</string>\n`).join('')}  </array>\n  <key>PATH</key><string>${pathEnv}</string>\n</dict>`;
    const running = (pathEnv: string) => runs([TSX, '/old/R&amp;D/svall/packages/svalld/src/bin.ts'], pathEnv);
    const there = { '/old/R&D/svall/node_modules/.bin/tsx': '', '/old/R&D/svall/packages/svalld/src/bin.ts': '', '/opt/homebrew/opt/node/bin/node': '' };
    expect(byName(await doctor(priv, fake({ files: { [PLIST]: running('/opt/homebrew/opt/node/bin:/usr/bin'), ...there } }).deps))['daemon path'])
      .toMatchObject({ status: 'ok', detail: 'its program is there, and it finds the agent CLIs as this shell does' });
    const gone = byName(await doctor(priv, fake({ files: { [PLIST]: running('/opt/homebrew/opt/node/bin:/usr/bin') } }).deps));
    expect(gone['daemon path']).toMatchObject({ status: 'fail', detail: '/old/R&D/svall/node_modules/.bin/tsx is gone, so launchd cannot start svalld: svall setup' });
    const SVALLD = '/u/.local/share/svall/current/bin/svalld';
    const release = runs([SVALLD], '/u/.local/share/svall/current/node/bin:/usr/bin');
    expect(byName(await doctor(priv, fake({ files: { [PLIST]: release, [SVALLD]: '' } }).deps))['daemon path'].status).toBe('ok');
    expect(byName(await doctor(priv, fake({ files: { [PLIST]: release } }).deps))['daemon path'])
      .toMatchObject({ status: 'fail', detail: `${SVALLD} is gone, so launchd cannot start svalld: svall setup` });
    const pnpm = { '/u/Library/pnpm/claude': '', '/u/Library/pnpm/codex': '' };
    const lacking = fake({ files: { [PLIST]: running('/opt/homebrew/opt/node/bin:/usr/bin'), ...there, ...pnpm }, pathEnv: '/u/Library/pnpm:/usr/bin' });
    expect(byName(await doctor(priv, lacking.deps))['daemon path'])
      .toMatchObject({ status: 'warn', detail: `the PATH in ${PLIST} has no claude or codex, which this shell finds: svall setup` });
    const carried = fake({ files: { [PLIST]: running('/opt/homebrew/opt/node/bin:/usr/bin:/u/Library/pnpm'), ...there, ...pnpm }, pathEnv: '/u/Library/pnpm:/usr/bin' });
    expect(byName(await doctor(priv, carried.deps))['daemon path'].status).toBe('ok');
    expect(byName(await doctor(adhoc, fake().deps))['daemon path'].status).toBe('skip');
  });

  it('warns when the plist lacks where this shell keeps Claude and Codex files', async () => {
    const env = { CLAUDE_CONFIG_DIR: '/x/claude', CODEX_HOME: '/x/codex' };
    const lacking = byName(await doctor(priv, fake({ daemonEnv: env }).deps));
    expect(lacking['daemon env']).toMatchObject({ status: 'warn', detail: expect.stringMatching(/lacks CLAUDE_CONFIG_DIR and CODEX_HOME.*: svall setup$/) });
    const carried = `<dict>\n    <key>PATH</key><string>/opt/homebrew/opt/node/bin</string>\n    <key>CLAUDE_CONFIG_DIR</key><string>/x/claude</string>\n    <key>CODEX_HOME</key><string>/x/codex</string>\n</dict>`;
    expect(byName(await doctor(priv, fake({ daemonEnv: env, files: { [PLIST]: carried } }).deps))['daemon env'].status).toBe('ok');
    const work = fake({ daemonEnv: env, files: { '/u/Library/LaunchAgents/io.github.linusroxbergh.svall.svalld.work.plist': plist('/opt/homebrew/opt/node/bin') } });
    expect(byName(await doctor({ name: 'work', home: '/u/.svall-work', managed: true }, work.deps))['daemon env'].detail).toMatch(/svall work$/);
    expect(byName(await doctor(priv, fake().deps))['daemon env'].status).toBe('ok');
    expect(byName(await doctor(adhoc, fake({ daemonEnv: env }).deps))['daemon env'].status).toBe('skip');
  });

  it('fails a fleet.json, node.json or unsplit config.json that does not parse, saying where and what is wrong on one line', async () => {
    expect(byName(await doctor(priv, fake().deps)).config).toMatchObject({ status: 'ok' });
    const cases = [
      ['fleet.json', '{}{}', /after JSON/],
      ['node.json', '{ "port": "x", "mobile": { "httpsPort": 0 } }', /port: .*expected number.*; mobile\.httpsPort: /],
      ['config.json', '{ "port": "x" }', /port: .*expected number/],
    ] as const;
    for (const [file, text, why] of cases) {
      const c = byName(await doctor(priv, fake({ files: { [`/u/.svall/${file}`]: text } }).deps)).config;
      expect(c).toMatchObject({ status: 'fail', detail: expect.stringMatching(new RegExp(`^invalid config /u/\\.svall/${file.replace('.', '\\.')}: .*; a stopped svalld waits for it to be fixed$`)) });
      expect(c.detail).toMatch(why);
      expect(c.detail).not.toContain('\n');
    }
  });

  it('warns of a config.json beside fleet.json, which svalld moves aside, and fails one whose backup is in the way', async () => {
    const at = (file: string) => `/u/.svall/${file}`;
    const fleet = '{ "id": "11111111-2222-3333-4444-555555555555" }';
    const beside = byName(await doctor(priv, fake({ files: { [at('fleet.json')]: fleet, [at('node.json')]: '{}', [at('config.json')]: '{}' } }).deps)).config;
    expect(beside).toMatchObject({ status: 'warn', detail: '/u/.svall/config.json is not read: svalld moves it aside unread as it starts; copy anything you still want from it into /u/.svall/fleet.json or /u/.svall/node.json' });
    const blocked = byName(await doctor(priv, fake({ files: { [at('config.json')]: '{}', [at('config.json.bak')]: '{}' } }).deps)).config;
    expect(blocked).toMatchObject({ status: 'fail', detail: expect.stringMatching(/^\/u\/\.svall\/config\.json\.bak is in the way .* and start again; a stopped svalld waits for it to be fixed$/) });
  });

  it('skips the Claude hooks check when Claude Code is not installed', async () => {
    const f = fake({ found: ['codex'], files: { '/u/.claude': undefined as unknown as string, '/u/.claude/settings.json': undefined as unknown as string } });
    const report = await doctor(priv, f.deps);
    expect(report.checks.find((c) => c.name === 'hooks')).toEqual({ name: 'hooks', status: 'skip', detail: 'Claude Code is not installed' });
  });

  it('skips the hooks of an agent turned off in setup rather than failing them', async () => {
    const f = fake({ found: ['claude', 'codex'], files: { '/u/.claude/settings.json': '{}', '/u/.codex': '' } });
    expect(byName(await doctor(priv, { ...f.deps, integrations: ['codex'] })).hooks).toEqual({ name: 'hooks', status: 'skip', detail: 'turned off in setup' });
    expect(await codexCheck({ ...f.deps, integrations: ['claude'] })).toEqual({ name: 'codex hooks', status: 'skip', detail: 'turned off in setup' });
  });

  it('fails hooks that Claude Code settings turn off', async () => {
    const off = JSON.stringify({ ...JSON.parse(installed), disableAllHooks: true });
    expect(byName(await doctor(priv, fake({ files: { '/u/.claude/settings.json': off } }).deps)).hooks)
      .toMatchObject({ status: 'fail', detail: expect.stringMatching(/sets disableAllHooks/) });
  });

  it('reads only the service\'s own state from launchd, not its triggers\'', async () => {
    const out = '\tstate = running\n\truns = 4\n\tlast exit code = 0\n\tevent triggers = {\n\t\tstate = active\n\t}\n\t\tstate = active\n';
    const c = byName(await doctor(priv, fake({ commands: { [`launchctl print gui/501/${LAUNCHD_LABEL}`]: out } }).deps));
    expect(c.launchd.detail).toBe(`${LAUNCHD_LABEL}: state = running, runs = 4, last exit code = 0`);
  });

  it('checks Claude Code against the plain floor where no robot moves', async () => {
    const c = byName(await doctor(priv, fake({ moves: false, commands: { 'claude --version': '2.1.250 (Claude Code)\n' } }).deps));
    expect(c.claude).toEqual({ name: 'claude', status: 'ok', detail: '2.1.250 (Claude Code), signed in' });
  });

  it('asks launchd about the profile it was pointed at, and not at all for an ad-hoc home', async () => {
    const work = fake({ commands: { 'launchctl print gui/501/io.github.linusroxbergh.svall.svalld.work': '\tstate = running\n' } });
    expect(byName(await doctor({ name: 'work', home: '/u/.svall-work', managed: true }, work.deps)).launchd.status).toBe('ok');
    expect(byName(await doctor({ name: 'work', home: '/u/.svall-work', managed: true }, fake().deps)).launchd.detail).toMatch(/not loaded: svall work$/);
    const dev = fake();
    expect(byName(await doctor(adhoc, dev.deps)).launchd).toMatchObject({ status: 'ok', detail: expect.stringMatching(/not managed/) });
    expect(dev.calls.some((c) => c.startsWith('launchctl'))).toBe(false);
  });
});

describe('doctor on Linux', () => {
  const unit = 'svall-svalld@private.service';
  const showOf = (u: string) => `systemctl --user show ${u} --property=LoadState --property=ActiveState --property=SubState --property=UnitFileState`;
  const show = showOf(unit);
  const running = 'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n';
  const linux = (commands: Record<string, string | Error> = {}, o: { daemonEnv?: Record<string, string>; files?: Record<string, string>; found?: AgentKind[]; agentPath?: string } = {}) => fake({
    platform: 'linux',
    commands: {
      [show]: running,
      'loginctl show-user linus --property=Linger': 'Linger=yes\n',
      ...commands,
    },
    ...o,
  });

  it('warns when the daemon\'s unit lacks where this account keeps Claude and Codex files', async () => {
    const env = { CLAUDE_CONFIG_DIR: '/x/claude home', CODEX_HOME: '/x/codex' };
    const file = `/u/.config/systemd/user/${unit}`;
    const lacking = byName(await doctor(priv, linux({}, { daemonEnv: env, files: { [file]: '[Service]\n' } }).deps));
    expect(lacking['daemon env']).toMatchObject({ status: 'warn', detail: `${file} lacks CLAUDE_CONFIG_DIR and CODEX_HOME, which this account sets: svall setup`, run: 'svall setup' });
    const carried = `[Service]\n${unitEnv('CLAUDE_CONFIG_DIR', '/x/claude home')}\n${unitEnv('CODEX_HOME', '/x/codex')}\n`;
    expect(byName(await doctor(priv, linux({}, { daemonEnv: env, files: { [file]: carried } }).deps))['daemon env']).toMatchObject({ status: 'ok' });
    expect(byName(await doctor(priv, linux({}, { files: { [file]: '[Service]\n' } }).deps))['daemon env']).toMatchObject({ status: 'ok' });
    expect(byName(await doctor(adhoc, linux({}, { daemonEnv: env }).deps))['daemon env'].status).toBe('skip');
    // a named fleet's unit is the controller's to rewrite, so there is nothing to type on this machine
    const named = byName(await doctor({ name: 'work', home: '/u/.svall-work', managed: true }, linux({}, { daemonEnv: env, files: { '/u/.config/systemd/user/svall-svalld@work.service': '[Service]\n' } }).deps));
    expect(named['daemon env']).toMatchObject({ status: 'warn', detail: expect.stringMatching(/svall host upgrade <this machine> from the controller$/) });
    expect(named['daemon env']).not.toHaveProperty('run');
  });

  it("warns when the unit's PATH is not where the login shell now finds the agents, as after nvm moves to another node", async () => {
    const file = `/u/.config/systemd/user/${unit}`;
    const agentPath = '/u/.local/share/svall/current/node/bin:/u/.local/share/svall/current/bin:/u/.nvm/versions/node/v24.1.0/bin:/u/.local/bin';
    const was = `[Service]\n${unitEnv('PATH', agentPath.replace('v24.1.0', 'v22.11.0'))}\n`;
    expect(byName(await doctor(priv, linux({}, { agentPath, files: { [file]: was } }).deps))['daemon path'])
      .toMatchObject({ status: 'warn', detail: `the PATH in ${file} is not where this account's login shell finds the agent CLIs: svall setup`, run: 'svall setup' });
    expect(byName(await doctor(priv, linux({}, { agentPath, files: { [file]: `[Service]\n${unitEnv('PATH', agentPath)}\n` } }).deps))['daemon path'].status).toBe('ok');
    const named = byName(await doctor({ name: 'work', home: '/u/.svall-work', managed: true }, linux({}, { agentPath, files: { '/u/.config/systemd/user/svall-svalld@work.service': was } }).deps));
    expect(named['daemon path']).toMatchObject({ status: 'warn', detail: expect.stringMatching(/svall host upgrade <this machine> from the controller$/) });
    expect(named['daemon path']).not.toHaveProperty('run');
    expect(byName(await doctor(adhoc, linux({}, { agentPath }).deps))['daemon path'].status).toBe('skip');
  });

  it('names OpenCode\'s config and data homes beside Claude\'s and Codex\'s', async () => {
    const file = `/u/.config/systemd/user/${unit}`;
    expect(byName(await doctor(priv, linux({}, { files: { [file]: '[Service]\n' } }).deps))['daemon env'])
      .toMatchObject({ status: 'ok', detail: 'this account sets none of CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME or XDG_DATA_HOME' });
    const env = { XDG_CONFIG_HOME: '/x/config', XDG_DATA_HOME: '/x/data' };
    expect(byName(await doctor(priv, linux({}, { daemonEnv: env, files: { [file]: '[Service]\n' } }).deps))['daemon env'])
      .toMatchObject({ status: 'warn', detail: `${file} lacks XDG_CONFIG_HOME and XDG_DATA_HOME, which this account sets: svall setup` });
  });

  it('checks the fleet\'s unit alone, as a companion runs no gateway', async () => {
    const c = byName(await doctor(priv, linux().deps));
    expect(c.gateway).toBeUndefined();
    const stopped = byName(await doctor(priv, linux({ [show]: 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=disabled\n' }).deps));
    expect(stopped.systemd).toMatchObject({ status: 'fail', detail: expect.stringContaining('inactive') });
  });

  it('asks systemd and loginctl instead of launchd', async () => {
    const f = linux();
    const c = byName(await doctor(priv, f.deps));
    expect(c.launchd).toBeUndefined();
    expect(c.systemd).toMatchObject({ status: 'ok', detail: expect.stringContaining(`${unit}: loaded, active (running), enabled`) });
    expect(c.linger).toMatchObject({ status: 'ok', detail: expect.stringContaining('on for linus') });
    expect(f.calls.some((call) => call.startsWith('launchctl'))).toBe(false);
  });

  it('fails a unit that is not installed or not running, and warns when lingering is off', async () => {
    const stopped = linux({
      [show]: 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=enabled\n',
      'loginctl show-user linus --property=Linger': 'Linger=no\n',
    });
    const c = byName(await doctor(priv, stopped.deps));
    expect(c.systemd.status).toBe('fail');
    expect(c.linger).toMatchObject({ status: 'warn', detail: expect.stringContaining('run sudo loginctl enable-linger linus'), run: 'sudo loginctl enable-linger linus' });

    const absent = byName(await doctor(priv, linux({ [show]: undefined as never }).deps));
    expect(absent.systemd).toMatchObject({ status: 'fail', detail: expect.stringMatching(/no systemd user services/) });

    const missing = byName(await doctor(priv, linux({ [show]: 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=\n' }).deps));
    expect(missing.systemd).toEqual({ name: 'systemd', status: 'fail', detail: `${unit} is not installed: svall setup`, run: 'svall setup' });
    // setup here rewrites only the units there are, so a named fleet's comes from the controller
    const work = 'svall-svalld@work.service';
    const unenrolled = byName(await doctor({ name: 'work', home: '/u/.svall-work', managed: true }, linux({ [showOf(work)]: 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=\n' }).deps));
    expect(unenrolled.systemd).toEqual({ name: 'systemd', status: 'fail', detail: `${work} is not installed: svall host upgrade <this machine> from the controller` });
  });

  it('warns when AppArmor keeps Codex\'s sandbox from starting, naming the bwrap profile that lets it', async () => {
    const restrict = { '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n' };
    const sandbox = 'codex sandbox -- true';
    const denied = Object.assign(new Error(`Command failed: ${sandbox}\nbwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n`), { code: 1 });
    const blocked = byName(await doctor(priv, linux({ [sandbox]: denied }, { files: restrict, found: ['codex'] }).deps));
    expect(blocked['codex sandbox']).toMatchObject({
      status: 'warn',
      detail: 'AppArmor keeps bwrap from making the user namespace Codex runs commands in (bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted), so a Codex robot asks before each one: '
        + 'sudo apt install bubblewrap apparmor-profiles, sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/, then sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict',
      run: 'sudo apt install bubblewrap apparmor-profiles && sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/ && sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict',
    });
    expect(byName(await doctor(priv, linux({ [sandbox]: '' }, { files: restrict, found: ['codex'] }).deps))['codex sandbox'].status).toBe('ok');

    const open = linux({}, { files: { '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '0\n' }, found: ['codex'] });
    expect(byName(await doctor(priv, open.deps))['codex sandbox']).toMatchObject({ status: 'skip', detail: 'AppArmor does not restrict user namespaces here' });
    expect(open.calls).not.toContain(sandbox);
    expect(byName(await doctor(priv, linux({}, { files: restrict }).deps))['codex sandbox']).toMatchObject({ status: 'skip', detail: 'not installed' });
    expect(byName(await doctor(priv, fake({ found: ['codex'], files: restrict }).deps))['codex sandbox']).toBeUndefined();
  });

  it('blames AppArmor only for bwrap\'s namespace denial, and says what else stopped the sandbox as it is', async () => {
    const restrict = { '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n' };
    const sandbox = 'codex sandbox -- true';
    const config = Object.assign(new Error(`Command failed: ${sandbox}\nError: unknown variant \`fast\` in config.toml\n`), { code: 1 });
    const slow = Object.assign(new Error(`Command failed: ${sandbox}`), { killed: true, signal: 'SIGTERM' });
    const quiet = Object.assign(new Error(`Command failed: ${sandbox}`), { code: 1 });
    const check = async (e: Error) => byName(await doctor(priv, linux({ [sandbox]: e }, { files: restrict, found: ['codex'] }).deps))['codex sandbox'];
    expect(await check(config)).toEqual({ name: 'codex sandbox', status: 'warn', detail: `${sandbox} failed (Error: unknown variant \`fast\` in config.toml): run codex sandbox -- true there to see why` });
    expect(await check(slow)).toEqual({ name: 'codex sandbox', status: 'warn', detail: `${sandbox} failed (it did not finish in time): run codex sandbox -- true there to see why` });
    expect(await check(quiet)).toEqual({ name: 'codex sandbox', status: 'warn', detail: `${sandbox} failed (exit 1, nothing said): run codex sandbox -- true there to see why` });
    for (const c of [config, slow, quiet]) expect((await check(c)).detail).not.toContain('AppArmor');
  });

  it('names the apt package when tmux or gh is missing', async () => {
    const c = byName(await doctor(priv, linux({ 'tmux -V': undefined as never, 'gh auth status': undefined as never }).deps));
    expect(c.tmux).toMatchObject({ status: 'fail', detail: 'not found on PATH: sudo apt install tmux', run: 'sudo apt install tmux' });
    expect(c.gh).toMatchObject({ status: 'warn', detail: 'not found on PATH: sudo apt install gh (pull request links stay unresolved)', run: 'sudo apt install gh' });
    const out = byName(await doctor(priv, linux({ 'gh auth status': Object.assign(new Error('not logged in'), { code: 1 }) }).deps));
    expect(out.gh).toMatchObject({ status: 'warn', run: 'gh auth login' });
  });

  it('asks for the agents on the PATH the fleet\'s unit runs with, where the daemon finds them', async () => {
    const agentPath = '/u/.local/share/svall/current/node/bin:/u/.local/bin:/usr/local/bin:/usr/bin:/bin';
    const f = fake({
      platform: 'linux', agentPath,
      files: { '/u/.codex': '', '/u/.codex/hooks.json': codexHooks },
      commands: {
        [show]: running, 'loginctl show-user linus --property=Linger': 'Linger=yes\n',
        // the login shell ssh hands a command to finds neither
        'claude --version': undefined as never,
        [`PATH=${agentPath} claude --version`]: '2.1.260 (Claude Code)\n',
        [`PATH=${agentPath} claude auth status --json`]: '{"loggedIn":true}\n',
        [`PATH=${agentPath} codex --version`]: 'codex-cli 0.156.1\n',
        [`PATH=${agentPath} codex login status`]: 'Logged in using ChatGPT\n',
      },
    });
    const c = byName(await doctor(priv, f.deps));
    expect(c.claude).toMatchObject({ status: 'ok', detail: '2.1.260 (Claude Code), signed in' });
    expect(c.codex).toMatchObject({ status: 'ok', detail: 'codex-cli 0.156.1, signed in' });
  });

  it('looks for the agents on Linux where the unit it would install runs them', () => {
    const unitPath = /^Environment="PATH=(.*)"$/m.exec(svalldUnit({ runtime: ownRuntime(), homedir: os.homedir(), prefix: DEFAULT_PREFIX, fleet: 'private', home: '/u/.svall' }).text)![1];
    expect(realPreflightDeps('/u/.svall', 'linux').agentPath).toBe(unitPath);
    expect(realPreflightDeps('/u/.svall', 'darwin').agentPath).toBeUndefined();
  });

  it('warns rather than fails when no agent CLI is installed, so setup runs on a fresh box', async () => {
    const f = linux({ 'claude --version': undefined as never });
    expect(byName(await doctor(priv, f.deps)).agents).toMatchObject({ status: 'warn', detail: expect.stringMatching(/no agent CLI \(claude, codex or opencode\)/) });
    expect(requireReady(await preflight(f.deps))).toEqual(expect.arrayContaining([expect.stringMatching(/^! agents/)]));
  });
});

describe('svall doctor on Linux', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = 0; cleanHomes(); });

  it('checks the hooks where the unit\'s CLAUDE_CONFIG_DIR and CODEX_HOME point, which only the login shell names', async () => {
    const home = makeHome();
    vi.stubEnv('HOME', home);
    const local = path.join(home, '.local', 'bin');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'claude'), '#!/bin/sh\necho "2.1.300 (Claude Code)"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(local, 'codex'), '#!/bin/sh\necho "codex-cli 0.156.1"\n', { mode: 0o755 });
    const claudeDir = path.join(home, '.config', 'claude');
    const codexDir = path.join(home, '.config', 'codex');
    const bin = makeHome();
    // the account's profile sets both, and the ssh command doctor runs in reads no profile
    fs.writeFileSync(path.join(bin, 'login-shell'), `#!/bin/sh\nexport CLAUDE_CONFIG_DIR='${claudeDir}' CODEX_HOME='${codexDir}'\nexec /bin/sh -c "$2"\n`, { mode: 0o755 });
    vi.stubEnv('SHELL', path.join(bin, 'login-shell'));
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    await doctorCommand(() => ({ name: 'private', home: path.join(home, '.svall'), managed: true }), () => true, 'linux').parseAsync([], { from: 'user' });
    const c = byName(JSON.parse(out.join('')));
    expect(c.hooks).toMatchObject({ status: 'fail', detail: `not installed in ${claudeDir}/settings.json: svall setup`, run: 'svall setup' });
    expect(c['codex hooks']).toMatchObject({ status: 'fail', detail: `not installed in ${codexDir}/hooks.json: svall setup`, run: 'svall setup' });
  });

  it('asks each agent and gh for its login with the agent homes the unit carries, and names them in the report', async () => {
    const home = makeHome();
    vi.stubEnv('HOME', home);
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    vi.stubEnv('XDG_CONFIG_HOME', '');
    const claudeDir = path.join(home, '.config', 'claude');
    const configDir = path.join(home, 'config');
    const local = path.join(home, '.local', 'bin');
    fs.mkdirSync(local, { recursive: true });
    // each answers only where the login shell keeps its files, which the ssh command doctor runs in does not name
    fs.writeFileSync(path.join(local, 'claude'), `#!/bin/sh\n[ "$CLAUDE_CONFIG_DIR" = '${claudeDir}' ] || { echo '{"loggedIn":false}'; exit 1; }\n[ "$1" = auth ] && echo '{"loggedIn":true}' || echo "2.1.300 (Claude Code)"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(local, 'gh'), `#!/bin/sh\n[ "$XDG_CONFIG_HOME" = '${configDir}' ]\n`, { mode: 0o755 });
    const bin = makeHome();
    fs.writeFileSync(path.join(bin, 'login-shell'), `#!/bin/sh\nexport CLAUDE_CONFIG_DIR='${claudeDir}' XDG_CONFIG_HOME='${configDir}'\nexec /bin/sh -c "$2"\n`, { mode: 0o755 });
    vi.stubEnv('SHELL', path.join(bin, 'login-shell'));
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    await doctorCommand(() => ({ name: 'private', home: path.join(home, '.svall'), managed: true }), () => true, 'linux').parseAsync([], { from: 'user' });
    const report = JSON.parse(out.join('')) as Report;
    expect(byName(report).claude).toMatchObject({ status: 'ok', detail: '2.1.300 (Claude Code), signed in' });
    expect(byName(report).gh).toMatchObject({ status: 'ok', detail: 'logged in' });
    expect(report.daemonEnv).toEqual({ CLAUDE_CONFIG_DIR: claudeDir, XDG_CONFIG_HOME: configDir });
  });

  it("finds an agent in the folder only the login shell's PATH holds, as nvm puts it, and reports the PATH it asked on", async () => {
    const home = makeHome();
    vi.stubEnv('HOME', home);
    const nvm = path.join(home, '.nvm', 'versions', 'node', 'v22.11.0', 'bin');
    fs.mkdirSync(nvm, { recursive: true });
    fs.writeFileSync(path.join(nvm, 'claude'), '#!/bin/sh\n[ "$1" = auth ] && echo \'{"loggedIn":true}\' || echo "2.1.300 (Claude Code)"\n', { mode: 0o755 });
    const bin = makeHome();
    fs.writeFileSync(path.join(bin, 'login-shell'), `#!/bin/sh\nexport PATH='${nvm}':"$PATH"\nexec /bin/sh -c "$2"\n`, { mode: 0o755 });
    vi.stubEnv('SHELL', path.join(bin, 'login-shell'));
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    await doctorCommand(() => ({ name: 'private', home: path.join(home, '.svall'), managed: true }), () => true, 'linux').parseAsync([], { from: 'user' });
    const report = JSON.parse(out.join('')) as Report;
    expect(byName(report).claude).toMatchObject({ status: 'ok', detail: '2.1.300 (Claude Code), signed in' });
    const unit = svalldUnit({ runtime: ownRuntime(), homedir: home, prefix: DEFAULT_PREFIX, fleet: 'private', home: path.join(home, '.svall'), agentDirs: [nvm] });
    expect(report.daemonPath).toBe(/^Environment="PATH=(.*)"$/m.exec(unit.text)![1]);
  });

  it('checks the OpenCode plugin where the unit\'s XDG_CONFIG_HOME points, which only the login shell names', async () => {
    const home = makeHome();
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', '');
    const local = path.join(home, '.local', 'bin');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'opencode'), '#!/bin/sh\necho "2.0.22"\n', { mode: 0o755 });
    const config = path.join(home, 'dotfiles');
    const bin = makeHome();
    fs.writeFileSync(path.join(bin, 'login-shell'), `#!/bin/sh\nexport XDG_CONFIG_HOME='${config}'\nexec /bin/sh -c "$2"\n`, { mode: 0o755 });
    vi.stubEnv('SHELL', path.join(bin, 'login-shell'));
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    await doctorCommand(() => ({ name: 'private', home: path.join(home, '.svall'), managed: true }), () => true, 'linux').parseAsync([], { from: 'user' });
    expect(byName(JSON.parse(out.join('')))['opencode plugin']).toMatchObject({ status: 'fail', detail: `not installed in ${config}/opencode/plugins/svall.js: svall setup` });
  });
});

describe('preflight', () => {
  it('checks what setup needs without asking the daemon, launchd or gh', async () => {
    const f = fake({ up: false, files: { '/u/.claude/settings.json': undefined as never } });
    const checks = await preflight(f.deps);
    expect(checks.map((c) => c.name)).toEqual(['tmux', 'node', 'claude', 'codex', 'opencode', 'path']);
    expect(checks.every((c) => c.status === 'ok' || c.status === 'skip')).toBe(true);
    expect(f.calls).toEqual(['tmux -V', 'claude --version', 'codex --version', 'opencode --version', 'claude auth status --json']);
  });

  it('warns when the shim directory is not on PATH', async () => {
    const shims = (await preflight(fake({ pathEnv: '/usr/bin:/bin' }).deps)).find((c) => c.name === 'path');
    expect(shims).toMatchObject({ status: 'warn', detail: expect.stringMatching(/\/u\/\.local\/bin is not on PATH/) });
    expect(byName(await doctor(priv, fake({ pathEnv: '/usr/bin' }).deps)).path.status).toBe('warn');
  });
});

describe('requireReady', () => {
  it('passes warnings through and refuses on any failure, naming each', async () => {
    const warned = await preflight(fake({ commands: { 'tmux -V': 'tmux 3.4\n' } }).deps);
    expect(requireReady(warned)).toEqual([expect.stringMatching(/^! tmux/)]);
    const failed = await preflight(fake({ commands: { 'claude --version': undefined as never }, node: 'v20.1.0' }).deps);
    expect(() => requireReady(failed)).toThrow(/nothing was changed[\s\S]*✗ node[\s\S]*✗ agents/);
  });
});

describe('agent checks', () => {
  const agents = async (o: Parameters<typeof fake>[0]) => (await preflight(fake(o).deps)).filter((c) => ['claude', 'codex', 'agents'].includes(c.name));
  const codexOk = { 'codex --version': 'codex-cli 0.156.1\n', 'codex login status': 'Logged in using ChatGPT\n' };
  const loggedOut = () => Object.assign(new Error('Not logged in'), { code: 1 });

  it('needs one CLI, not claude', async () => {
    const onlyCodex = await agents({ commands: { 'claude --version': undefined as never, ...codexOk } });
    expect(onlyCodex).toEqual([
      { name: 'claude', status: 'skip', detail: 'not installed' },
      { name: 'codex', status: 'ok', detail: 'codex-cli 0.156.1, signed in' },
    ]);
    expect(requireReady(onlyCodex)).toEqual([]);
    // a --version that fails other than ENOENT is there but broken
    const broken = await agents({ commands: { 'claude --version': new Error('x'), ...codexOk } });
    expect(broken.find((c) => c.name === 'claude')).toEqual({ name: 'claude', status: 'warn', detail: 'x' });
  });

  it('fails when neither is installed', async () => {
    const got = await agents({ commands: { 'claude --version': undefined as never } });
    expect(got).toEqual([{ name: 'agents', status: 'fail', detail: expect.stringContaining('no agent CLI (claude, codex or opencode) is on PATH') }]);
    expect(got[0]!.detail).toContain('run curl -fsSL https://claude.ai/install.sh | bash (Claude Code) or curl -fsSL https://chatgpt.com/codex/install.sh | sh (Codex)');
    expect(() => requireReady(got)).toThrow(/nothing was changed/);
  });

  it('asks each CLI for its version once', async () => {
    const f = fake({ commands: codexOk });
    await preflight(f.deps);
    expect(f.calls.filter((c) => c.endsWith('--version'))).toEqual(['claude --version', 'codex --version', 'opencode --version']);
  });

  it('warns about an old codex and a missing login, never failing', async () => {
    const old = await agents({ commands: { 'codex --version': 'codex-cli 0.142.0-alpha.6\n', 'codex login status': loggedOut() } });
    expect(old.find((c) => c.name === 'codex')).toEqual({ name: 'codex', status: 'warn', detail: 'codex-cli 0.142.0-alpha.6: Svall needs 0.156.0 or newer; update Codex; not signed in: codex login', run: 'codex login' });
    const olderClaude = await agents({ commands: { 'claude --version': '2.1.250 (Claude Code)\n' } });
    expect(olderClaude.find((c) => c.name === 'claude')?.detail).toBe('2.1.250 (Claude Code): Svall needs 2.1.251 or newer; update Claude Code');
    const out = await agents({ commands: { 'codex --version': 'codex-cli 0.156.1\n', 'codex login status': loggedOut() } });
    expect(out.find((c) => c.name === 'codex')?.detail).toBe('codex-cli 0.156.1, not signed in: codex login');
    const claude = await agents({ commands: { 'claude auth status --json': Object.assign(new Error('x'), { code: 1, stdout: '{"loggedIn":false}' }) } });
    expect(claude.find((c) => c.name === 'claude')?.detail).toBe('2.1.251 (Claude Code), not signed in: claude auth login');
  });

  it('hands the fleet .env API keys to the login probe, which Codex does not count', async () => {
    const f = fake({ keys: { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o' }, commands: { 'codex --version': 'codex-cli 0.156.1\n', 'codex login status': loggedOut() } });
    const got = await preflight(f.deps);
    expect(f.envs['claude auth status --json']).toEqual({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o' });
    expect(got.find((c) => c.name === 'codex')?.detail).toBe('codex-cli 0.156.1, not signed in: codex login');
  });

  it('says so when a login probe hangs or is unknown', async () => {
    const got = await agents({ commands: { 'claude auth status --json': Object.assign(new Error('timed out'), { killed: true, code: null }) } });
    expect(got.find((c) => c.name === 'claude')).toEqual({ name: 'claude', status: 'warn', detail: "2.1.251 (Claude Code); couldn't tell whether it is signed in" });
  });

  it('warns when the configured main agent is gone', async () => {
    const got = await agents({ commands: { 'claude --version': undefined as never, ...codexOk }, mainAgent: 'claude' });
    expect(got.find((c) => c.name === 'claude')).toEqual({ name: 'claude', status: 'warn', detail: 'not installed, but it is the main agent: svall agent codex' });
  });
});

describe('opencodeCheck', () => {
  const d = (o: { found?: AgentKind[]; files?: Record<string, string>; integrations?: AgentKind[] }) => ({
    opencode: OPENCODE, found: o.found ?? ['opencode'], integrations: o.integrations,
    exists: (p: string) => p in (o.files ?? {}) || Object.keys(o.files ?? {}).some((f) => f.startsWith(`${p}/`)),
    read: (p: string) => o.files?.[p],
  });
  it('skips an OpenCode not installed or turned off, fails without the plugin, warns on an old one', () => {
    expect(opencodeCheck(d({ found: [] })).status).toBe('skip');
    expect(opencodeCheck(d({ integrations: ['claude'] })).status).toBe('skip');
    expect(opencodeCheck(d({})).status).toBe('fail');
    expect(opencodeCheck(d({ files: { [OPENCODE.plugin]: '// old' } })).status).toBe('warn');
    expect(opencodeCheck(d({ files: { [OPENCODE.plugin]: fs.readFileSync(PLUGIN_SOURCE, 'utf8') } })).status).toBe('ok');
  });
});

describe('codexCheck', () => {
  it('fails when codex is there but the hooks are not written, or will not parse, as the Claude check does', async () => {
    for (const text of ['', '{ "hooks": ']) {
      const c = await codexCheck(fake({ files: { '/u/.codex': '', '/u/.codex/hooks.json': text } }).deps);
      expect(c.status).toBe('fail');
      expect(c.detail).toContain('svall setup');
    }
  });

  it('checks Codex hooks when codex is on PATH, even with no ~/.codex yet', async () => {
    const check = await codexCheck({ ...fake().deps, exists: () => false, found: ['claude', 'codex'] });
    expect(check).toEqual({ name: 'codex hooks', status: 'fail', detail: `not installed in ${CODEX.hooks}: svall setup`, run: 'svall setup' });
  });

  it('warns when the hooks hold a command setup no longer writes', async () => {
    const old = JSON.stringify(mergeCodexHooks({}, codexHookCommand(SCRIPT).replace(' "$PPID"', ''), SCRIPT));
    const c = await codexCheck(fake({ files: { '/u/.codex': '', '/u/.codex/hooks.json': old } }).deps);
    expect(c).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^out of date in \/u\/\.codex\/hooks\.json: run svall setup, then trust them in Codex$/) });
  });

  it('says the hooks are installed once they are current', async () => {
    const c = await codexCheck(fake({ files: { '/u/.codex': '', '/u/.codex/hooks.json': codexHooks }, trust: { trusted: 1, untrusted: 0 } }).deps);
    expect(c).toEqual({ name: 'codex hooks', status: 'ok', detail: `installed in ${CODEX.hooks}; trusted` });
  });

  it('reports hook trust when Codex can say, and never fails on it', async () => {
    const hooks = JSON.stringify(mergeCodexHooks({}, codexHookCommand(SCRIPT), SCRIPT));
    const base = { files: { [CODEX.dir]: '', [CODEX.hooks]: hooks }, found: ['claude', 'codex'] as AgentKind[] };
    const check = async (trust?: { trusted: number; untrusted: number }) => codexCheck(fake({ ...base, trust }).deps);
    expect((await check({ trusted: 5, untrusted: 0 })).detail).toBe(`installed in ${CODEX.hooks}; trusted`);
    expect(await check({ trusted: 0, untrusted: 5 })).toEqual({ name: 'codex hooks', status: 'warn', detail: 'not trusted yet: start codex and choose "Trust all and continue", or trust them in /hooks', run: 'codex' });
    expect(await check(undefined)).toEqual({ name: 'codex hooks', status: 'ok', detail: `installed in ${CODEX.hooks}; couldn't ask Codex about trust, check /hooks in Codex` });
  });
});
