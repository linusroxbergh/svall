import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { codexHookCommand, mergeCodexHooks } from '@archipelago/archid/codex/install';
import { archidUnit } from '@archipelago/archid/linux/setup';
import { LAUNCHD_LABEL } from '@archipelago/archid/profile';
import { repoRoot } from '@archipelago/archid/release';
import { HOOK_EVENTS, hookCommand, mergeHooks, mergeStatusLine, nodeRun, statusWrapper } from '@archipelago/archid/setup';
import type { AgentKind } from '@archipelago/protocol';
import { DEFAULT_PREFIX } from '../../../scripts/install-release.mjs';
import type { HookTrust } from '../src/codex-trust.js';
import { codexCheck, doctor, preflight, realPreflightDeps, reportLines, requireReady, type DoctorDeps } from '../src/commands/doctor.js';

const priv = { name: 'private', home: '/u/.archipelago', managed: true };
const adhoc = { name: 'archi-dev', home: '/tmp/archi-dev', managed: false };

const PLIST = '/u/Library/LaunchAgents/io.github.linusroxbergh.archipelago.archid.plist';
const plist = (nodeDir: string) => `<dict>\n    <key>PATH</key><string>${nodeDir}:/u/.local/bin:/usr/bin</string>\n</dict>`;

const SCRIPT = '/u/.archipelago/hooks/agent-hook.mjs';
const STATUS = '/u/.archipelago/hooks/claude-status.mjs';
const claudeSettings = (hook: string, status: string) => JSON.stringify(mergeStatusLine(mergeHooks({}, hook, HOOK_EVENTS, SCRIPT), status, STATUS));
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
  platform?: NodeJS.Platform;
  agentPath?: string;
} = {}) {
  const calls: string[] = [];
  const envs: Record<string, Record<string, string> | undefined> = {};
  const commands: Record<string, string | Error> = {
    'tmux -V': 'tmux 3.5a\n',
    'claude --version': '2.1.0 (Claude Code)\n',
    'claude auth status --json': '{"loggedIn":true}\n',
    'gh auth status': '',
    'launchctl print gui/501/io.github.linusroxbergh.archipelago.archid': '\tstate = running\n\tlast exit code = (never exited)\n',
    [`${RSYNC} --version`]: 'rsync  version 3.4.4  protocol version 32\n',
    ...o.commands,
  };
  const mergedFiles: Record<string, string | undefined> = {
    '/u/.archipelago/port': '47800',
    '/u/.claude': '',
    '/u/.claude/settings.json': installed,
    [PLIST]: plist('/opt/homebrew/opt/node/bin'),
    '/opt/homebrew/opt/node/bin/node': '',
    '/u/.archipelago/archid.log': Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
    ...o.files,
  };
  const files: Record<string, string> = Object.fromEntries(Object.entries(mergedFiles).filter(([, v]) => v !== undefined) as [string, string][]);
  const deps: DoctorDeps = {
    run: async (cmd, args, how) => {
      const key = [...(how?.path ? [`PATH=${how.path}`] : []), cmd, ...args].join(' ');
      calls.push(key);
      envs[key] = how?.env;
      const out = commands[key];
      if (out === undefined) throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
      if (out instanceof Error) throw out;
      return out;
    },
    read: (p) => files[p],
    connect: async () => { if (o.up === false) throw new Error('connect ECONNREFUSED 127.0.0.1:47800'); return { close() {} }; },
    connectHook: async () => { if (o.hookUp === false) throw Object.assign(new Error('connect ENOENT /u/.archipelago/hooks.sock - Local (undefined:undefined)'), { code: 'ENOENT' }); },
    uid: 501,
    settingsPath: '/u/.claude/settings.json',
    hooksHome: '/u/.archipelago',
    launchAgentsDir: '/u/Library/LaunchAgents',
    daemonEnv: o.daemonEnv ?? {},
    codex: CODEX,
    exists: (p) => p in files,
    node: o.node ?? 'v24.13.0',
    pathEnv: o.pathEnv ?? '/opt/homebrew/bin:/u/.local/bin:/usr/bin',
    ...(o.agentPath && { agentPath: o.agentPath }),
    shimDir: '/u/.local/bin',
    keys: o.keys ?? {},
    mainAgent: o.mainAgent,
    found: o.found ?? ['claude'],
    codexTrust: async () => o.trust,
    platform: o.platform ?? 'darwin',
    user: 'linus',
    rsync: { bundled: RSYNC, fix: 'build it with node scripts/build-controller.mjs' },
  };
  return { deps, calls, envs };
}

const CODEX = { dir: '/u/.codex', config: '/u/.codex/config.toml', hooks: '/u/.codex/hooks.json' };
const RSYNC = '/u/archipelago/vendor/rsync/3.4.4-arm64/rsync';
const codexHooks = JSON.stringify(mergeCodexHooks({}, codexHookCommand(SCRIPT), SCRIPT));

const byName = (r: Awaited<ReturnType<typeof doctor>>) => Object.fromEntries(r.checks.map((c) => [c.name, c]));

describe('doctor', () => {
  it('reports a healthy fleet and the last 20 log lines', async () => {
    const r = await doctor(priv, fake().deps);
    const c = byName(r);
    expect(r.checks.every((x) => x.status === 'ok' || x === c.codex || x === c['codex hooks'])).toBe(true);
    expect(c.codex).toMatchObject({ status: 'skip', detail: 'not installed' });
    expect(c['codex hooks']).toMatchObject({ status: 'skip', detail: 'not installed' });
    expect(c.tmux.detail).toBe('tmux 3.5a');
    expect(c.node.detail).toBe('v24.13.0');
    expect(c.claude.detail).toBe('2.1.0 (Claude Code), signed in');
    expect(c.archid.detail).toBe('running on port 47800');
    expect(c['hook receiver']).toMatchObject({ status: 'ok', detail: 'answering at /u/.archipelago/hooks.sock' });
    expect(c.launchd.detail).toMatch(/state = running/);
    expect(c.rsync.detail).toBe(`3.4.4 at ${RSYNC}`);
    expect(r.log.path).toBe('/u/.archipelago/archid.log');
    expect(r.log.lines).toEqual(Array.from({ length: 20 }, (_, i) => `line ${i + 11}`));
    expect(r.config).toEqual({ fleet: '/u/.archipelago/fleet.json', node: '/u/.archipelago/node.json' });
    expect(reportLines(r)).toContain('config /u/.archipelago/fleet.json and /u/.archipelago/node.json');
  });

  it('names what is broken and how to fix it', async () => {
    const f = fake({
      commands: {
        'tmux -V': undefined as never,
        'claude --version': undefined as never,
        'gh auth status': new Error('You are not logged into any GitHub hosts'),
        'launchctl print gui/501/io.github.linusroxbergh.archipelago.archid': new Error('Could not find service'),
      },
      files: { '/u/.archipelago/port': undefined as never, '/u/.claude/settings.json': '{}', '/u/.archipelago/archid.log': undefined as never },
    });
    const r = await doctor(priv, f.deps);
    const c = byName(r);
    expect(c.tmux).toMatchObject({ status: 'fail', detail: expect.stringMatching(/brew install tmux/) });
    expect(c.agents).toMatchObject({ status: 'fail', detail: expect.stringContaining('neither claude nor codex is on PATH') });
    expect(c.gh).toMatchObject({ status: 'warn', detail: expect.stringMatching(/gh auth login/) });
    expect(c.archid).toMatchObject({ status: 'fail', detail: expect.stringMatching(/not running .*: the log below says why$/) });
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
    expect(c['hook receiver']).toMatchObject({ status: 'fail', detail: expect.stringMatching(/does not answer \(ENOENT\); restart it with `launchctl kickstart -k gui\/\$\(id -u\)\/io\.github\.linusroxbergh\.archipelago\.archid`$/) });
    const work = byName(await doctor({ name: 'work', home: '/u/.archipelago-work', managed: true }, fake({ hookUp: false }).deps));
    expect(work['hook receiver'].detail).toMatch(/io\.github\.linusroxbergh\.archipelago\.archid\.work`$/);
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
    expect(c['codex hooks']).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^out of date in \/u\/\.codex\/hooks\.json: run archi setup, then trust them in Codex/) });
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
    const work = fake({ files: { '/u/Library/LaunchAgents/io.github.linusroxbergh.archipelago.archid.work.plist': plist('/gone') } });
    expect(byName(await doctor({ name: 'work', home: '/u/.archipelago-work', managed: true }, work.deps))['daemon node'].detail).toMatch(/archi work$/);
    expect(byName(await doctor(adhoc, fake().deps))['daemon node'].status).toBe('skip');
  });

  it('fails a plist whose checkout or release is gone, and warns when its PATH lacks a claude or codex this shell finds', async () => {
    const TSX = '/old/R&amp;D/archipelago/node_modules/.bin/tsx';
    const runs = (program: string[], pathEnv: string) =>
      `<dict>\n  <key>ProgramArguments</key>\n  <array>\n${program.map((a) => `    <string>${a}</string>\n`).join('')}  </array>\n  <key>PATH</key><string>${pathEnv}</string>\n</dict>`;
    const running = (pathEnv: string) => runs([TSX, '/old/R&amp;D/archipelago/packages/archid/src/bin.ts'], pathEnv);
    const there = { '/old/R&D/archipelago/node_modules/.bin/tsx': '', '/opt/homebrew/opt/node/bin/node': '' };
    expect(byName(await doctor(priv, fake({ files: { [PLIST]: running('/opt/homebrew/opt/node/bin:/usr/bin'), ...there } }).deps))['daemon path'])
      .toMatchObject({ status: 'ok', detail: 'its program is there, and it finds claude and codex as this shell does' });
    const gone = byName(await doctor(priv, fake({ files: { [PLIST]: running('/opt/homebrew/opt/node/bin:/usr/bin') } }).deps));
    expect(gone['daemon path']).toMatchObject({ status: 'fail', detail: '/old/R&D/archipelago/node_modules/.bin/tsx is gone, so launchd cannot start archid: archi setup' });
    const ARCHID = '/u/.local/share/archipelago/current/bin/archid';
    const release = runs([ARCHID], '/u/.local/share/archipelago/current/node/bin:/usr/bin');
    expect(byName(await doctor(priv, fake({ files: { [PLIST]: release, [ARCHID]: '' } }).deps))['daemon path'].status).toBe('ok');
    expect(byName(await doctor(priv, fake({ files: { [PLIST]: release } }).deps))['daemon path'])
      .toMatchObject({ status: 'fail', detail: `${ARCHID} is gone, so launchd cannot start archid: archi setup` });
    const pnpm = { '/u/Library/pnpm/claude': '', '/u/Library/pnpm/codex': '' };
    const lacking = fake({ files: { [PLIST]: running('/opt/homebrew/opt/node/bin:/usr/bin'), ...there, ...pnpm }, pathEnv: '/u/Library/pnpm:/usr/bin' });
    expect(byName(await doctor(priv, lacking.deps))['daemon path'])
      .toMatchObject({ status: 'warn', detail: `the PATH in ${PLIST} has no claude or codex, which this shell finds: archi setup` });
    const carried = fake({ files: { [PLIST]: running('/opt/homebrew/opt/node/bin:/usr/bin:/u/Library/pnpm'), ...there, ...pnpm }, pathEnv: '/u/Library/pnpm:/usr/bin' });
    expect(byName(await doctor(priv, carried.deps))['daemon path'].status).toBe('ok');
    expect(byName(await doctor(adhoc, fake().deps))['daemon path'].status).toBe('skip');
  });

  it('warns when the plist lacks where this shell keeps Claude and Codex files', async () => {
    const env = { CLAUDE_CONFIG_DIR: '/x/claude', CODEX_HOME: '/x/codex' };
    const lacking = byName(await doctor(priv, fake({ daemonEnv: env }).deps));
    expect(lacking['daemon env']).toMatchObject({ status: 'warn', detail: expect.stringMatching(/lacks CLAUDE_CONFIG_DIR and CODEX_HOME.*: archi setup$/) });
    const carried = `<dict>\n    <key>PATH</key><string>/opt/homebrew/opt/node/bin</string>\n    <key>CLAUDE_CONFIG_DIR</key><string>/x/claude</string>\n    <key>CODEX_HOME</key><string>/x/codex</string>\n</dict>`;
    expect(byName(await doctor(priv, fake({ daemonEnv: env, files: { [PLIST]: carried } }).deps))['daemon env'].status).toBe('ok');
    const work = fake({ daemonEnv: env, files: { '/u/Library/LaunchAgents/io.github.linusroxbergh.archipelago.archid.work.plist': plist('/opt/homebrew/opt/node/bin') } });
    expect(byName(await doctor({ name: 'work', home: '/u/.archipelago-work', managed: true }, work.deps))['daemon env'].detail).toMatch(/archi work$/);
    expect(byName(await doctor(priv, fake().deps))['daemon env'].status).toBe('ok');
    expect(byName(await doctor(adhoc, fake({ daemonEnv: env }).deps))['daemon env'].status).toBe('skip');
  });

  it('fails a fleet.json, node.json or unsplit config.json that does not parse, saying where and what is wrong on one line', async () => {
    expect(byName(await doctor(priv, fake().deps)).config).toMatchObject({ status: 'ok' });
    const cases = [
      ['fleet.json', '{}{}', /after JSON/],
      ['node.json', '{ "port": "x", "mobile": { "httpsPort": 1 } }', /port: .*expected number.*; mobile\.httpsPort: /],
      ['config.json', '{ "port": "x" }', /port: .*expected number/],
    ] as const;
    for (const [file, text, why] of cases) {
      const c = byName(await doctor(priv, fake({ files: { [`/u/.archipelago/${file}`]: text } }).deps)).config;
      expect(c).toMatchObject({ status: 'fail', detail: expect.stringMatching(new RegExp(`^invalid config /u/\\.archipelago/${file.replace('.', '\\.')}: .*; a stopped archid waits for it to be fixed$`)) });
      expect(c.detail).toMatch(why);
      expect(c.detail).not.toContain('\n');
    }
  });

  it('fails the two layouts archid refuses to start on: a config.json beside fleet.json, and one whose backup is in the way', async () => {
    const at = (file: string) => `/u/.archipelago/${file}`;
    const fleet = '{ "id": "11111111-2222-3333-4444-555555555555" }';
    const beside = byName(await doctor(priv, fake({ files: { [at('fleet.json')]: fleet, [at('node.json')]: '{}', [at('config.json')]: '{}' } }).deps)).config;
    expect(beside).toMatchObject({ status: 'fail', detail: expect.stringMatching(/^\/u\/\.archipelago\/config\.json is not read any more: .* and delete it; a stopped archid waits for it to be fixed$/) });
    const blocked = byName(await doctor(priv, fake({ files: { [at('config.json')]: '{}', [at('config.json.bak')]: '{}' } }).deps)).config;
    expect(blocked).toMatchObject({ status: 'fail', detail: expect.stringMatching(/^\/u\/\.archipelago\/config\.json\.bak is in the way .* and start again; a stopped archid waits for it to be fixed$/) });
  });

  it('skips the Claude hooks check when Claude Code is not installed', async () => {
    const f = fake({ found: ['codex'], files: { '/u/.claude': undefined as unknown as string, '/u/.claude/settings.json': undefined as unknown as string } });
    const report = await doctor(priv, f.deps);
    expect(report.checks.find((c) => c.name === 'hooks')).toEqual({ name: 'hooks', status: 'skip', detail: 'Claude Code is not installed' });
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

  it('flags a Mac left with only the system openrsync, or an rsync too old, and names the fix', async () => {
    const openrsync = 'openrsync: protocol version 29\nrsync version 2.6.9 compatible\n';
    const gone = byName(await doctor(priv, fake({ commands: { [`${RSYNC} --version`]: undefined as never, 'rsync --version': openrsync } }).deps));
    expect(gone.rsync).toEqual({
      name: 'rsync', status: 'warn',
      detail: `${RSYNC} is not there, and the rsync on PATH is openrsync, which cannot protect remote arguments or report byte progress; handover needs the bundled rsync: build it with node scripts/build-controller.mjs`,
    });
    const old = byName(await doctor(priv, fake({ commands: { [`${RSYNC} --version`]: 'rsync  version 3.1.3  protocol version 31\n' } }).deps));
    expect(old.rsync).toMatchObject({ status: 'warn', detail: expect.stringMatching(/is rsync 3\.1\.3; a handover needs 3\.2\.3 or newer.*build-controller/) });
  });

  it('asks launchd about the profile it was pointed at, and not at all for an ad-hoc home', async () => {
    const work = fake({ commands: { 'launchctl print gui/501/io.github.linusroxbergh.archipelago.archid.work': '\tstate = running\n' } });
    expect(byName(await doctor({ name: 'work', home: '/u/.archipelago-work', managed: true }, work.deps)).launchd.status).toBe('ok');
    expect(byName(await doctor({ name: 'work', home: '/u/.archipelago-work', managed: true }, fake().deps)).launchd.detail).toMatch(/not loaded: archi work$/);
    // an older install's agent, which setup moves
    const old = fake({ files: { '/u/Library/LaunchAgents/com.archipelago.archid.work.plist': '<plist/>' } });
    expect(byName(await doctor({ name: 'work', home: '/u/.archipelago-work', managed: true }, old.deps)).launchd.detail)
      .toBe("io.github.linusroxbergh.archipelago.archid.work is not loaded, as the fleet's agent is still com.archipelago.archid.work: pnpm desktop:install");
    const dev = fake();
    expect(byName(await doctor(adhoc, dev.deps)).launchd).toMatchObject({ status: 'ok', detail: expect.stringMatching(/not managed/) });
    expect(dev.calls.some((c) => c.startsWith('launchctl'))).toBe(false);
  });
});

describe('doctor on Linux', () => {
  const unit = 'archipelago-archid@private.service';
  const showOf = (u: string) => `systemctl --user show ${u} --property=LoadState --property=ActiveState --property=SubState --property=UnitFileState`;
  const show = showOf(unit);
  const gateway = showOf('archipelago-gateway.service');
  const running = 'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n';
  const linux = (commands: Record<string, string | Error> = {}) => fake({
    platform: 'linux',
    commands: {
      [show]: running,
      [gateway]: running,
      'loginctl show-user linus --property=Linger': 'Linger=yes\n',
      ...commands,
    },
  });

  it('checks the machine\'s gateway unit beside the fleet\'s', async () => {
    expect(byName(await doctor(priv, linux().deps)).gateway)
      .toMatchObject({ status: 'ok', detail: expect.stringContaining('archipelago-gateway.service: loaded, active (running), enabled') });
    const stopped = byName(await doctor(priv, linux({ [gateway]: 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=disabled\n' }).deps));
    expect(stopped.gateway).toMatchObject({ status: 'fail', detail: expect.stringContaining('inactive') });
  });

  it('asks systemd and loginctl instead of launchd', async () => {
    const f = linux();
    const c = byName(await doctor(priv, f.deps));
    expect(c.launchd).toBeUndefined();
    // a companion sends with the system rsync, which the host doctor checks from the Mac
    expect(c.rsync).toBeUndefined();
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
    expect(c.linger).toMatchObject({ status: 'warn', detail: expect.stringContaining('loginctl enable-linger linus') });

    const absent = byName(await doctor(priv, linux({ [show]: undefined as never }).deps));
    expect(absent.systemd).toMatchObject({ status: 'fail', detail: expect.stringMatching(/no systemd user services/) });
  });

  it('names the apt package when tmux is missing', async () => {
    const c = byName(await doctor(priv, linux({ 'tmux -V': undefined as never }).deps));
    expect(c.tmux).toMatchObject({ status: 'fail', detail: 'not found on PATH: sudo apt install tmux' });
  });

  it('asks for the agents on the PATH the fleet\'s unit runs with, where the daemon finds them', async () => {
    const agentPath = '/u/.local/share/archipelago/current/node/bin:/u/.local/bin:/usr/local/bin:/usr/bin:/bin';
    const f = fake({
      platform: 'linux', agentPath,
      files: { '/u/.codex': '', '/u/.codex/hooks.json': codexHooks },
      commands: {
        [show]: running, [gateway]: running, 'loginctl show-user linus --property=Linger': 'Linger=yes\n',
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
    const unitPath = /^Environment="PATH=(.*)"$/m.exec(archidUnit({ repoRoot: repoRoot(), homedir: os.homedir(), prefix: DEFAULT_PREFIX, fleet: 'private', home: '/u/.archipelago' }).text)![1];
    expect(realPreflightDeps('/u/.archipelago', 'linux').agentPath).toBe(unitPath);
    expect(realPreflightDeps('/u/.archipelago', 'darwin').agentPath).toBeUndefined();
  });

  it('warns rather than fails when no agent CLI is installed, so setup runs on a fresh box', async () => {
    const f = linux({ 'claude --version': undefined as never });
    expect(byName(await doctor(priv, f.deps)).agents).toMatchObject({ status: 'warn', detail: expect.stringMatching(/neither claude nor codex/) });
    expect(requireReady(await preflight(f.deps))).toEqual(expect.arrayContaining([expect.stringMatching(/^! agents/)]));
  });
});

describe('preflight', () => {
  it('checks what setup needs without asking the daemon, launchd or gh', async () => {
    const f = fake({ up: false, files: { '/u/.claude/settings.json': undefined as never } });
    const checks = await preflight(f.deps);
    expect(checks.map((c) => c.name)).toEqual(['tmux', 'node', 'claude', 'codex', 'path']);
    expect(checks.every((c) => c.status === 'ok' || c.status === 'skip')).toBe(true);
    expect(f.calls).toEqual(['tmux -V', 'claude --version', 'codex --version', 'claude auth status --json']);
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
    expect(got).toEqual([{ name: 'agents', status: 'fail', detail: expect.stringContaining('neither claude nor codex is on PATH') }]);
    expect(() => requireReady(got)).toThrow(/nothing was changed/);
  });

  it('asks each CLI for its version once', async () => {
    const f = fake({ commands: codexOk });
    await preflight(f.deps);
    expect(f.calls.filter((c) => c.endsWith('--version'))).toEqual(['claude --version', 'codex --version']);
  });

  it('warns about an old codex and a missing login, never failing', async () => {
    const old = await agents({ commands: { 'codex --version': 'codex-cli 0.142.0-alpha.6\n', 'codex login status': loggedOut() } });
    expect(old.find((c) => c.name === 'codex')).toEqual({ name: 'codex', status: 'warn', detail: 'codex-cli 0.142.0-alpha.6: Archipelago needs 0.155 or newer; update Codex' });
    const out = await agents({ commands: { 'codex --version': 'codex-cli 0.156.1\n', 'codex login status': loggedOut() } });
    expect(out.find((c) => c.name === 'codex')?.detail).toBe('codex-cli 0.156.1, not signed in: codex login');
    const claude = await agents({ commands: { 'claude auth status --json': Object.assign(new Error('x'), { code: 1, stdout: '{"loggedIn":false}' }) } });
    expect(claude.find((c) => c.name === 'claude')?.detail).toBe('2.1.0 (Claude Code), not signed in: claude auth login');
  });

  it('hands the fleet .env API keys to the login probe, which Codex does not count', async () => {
    const f = fake({ keys: { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o' }, commands: { 'codex --version': 'codex-cli 0.156.1\n', 'codex login status': loggedOut() } });
    const got = await preflight(f.deps);
    expect(f.envs['claude auth status --json']).toEqual({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o' });
    expect(got.find((c) => c.name === 'codex')?.detail).toBe('codex-cli 0.156.1, not signed in: codex login');
  });

  it('says so when a login probe hangs or is unknown', async () => {
    const got = await agents({ commands: { 'claude auth status --json': Object.assign(new Error('timed out'), { killed: true, code: null }) } });
    expect(got.find((c) => c.name === 'claude')).toEqual({ name: 'claude', status: 'warn', detail: "2.1.0 (Claude Code); couldn't tell whether it is signed in" });
  });

  it('warns when the configured main agent is gone', async () => {
    const got = await agents({ commands: { 'claude --version': undefined as never, ...codexOk }, mainAgent: 'claude' });
    expect(got.find((c) => c.name === 'claude')).toEqual({ name: 'claude', status: 'warn', detail: 'not installed, but it is the main agent: archi agent codex' });
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

  it('checks Codex hooks when codex is on PATH, even with no ~/.codex yet', async () => {
    const check = await codexCheck({ ...fake().deps, exists: () => false, found: ['claude', 'codex'] });
    expect(check).toEqual({ name: 'codex hooks', status: 'warn', detail: `not installed in ${CODEX.hooks}: archi setup` });
  });

  it('warns when the hooks hold a command setup no longer writes', async () => {
    const old = JSON.stringify(mergeCodexHooks({}, codexHookCommand(SCRIPT).replace(' "$PPID"', ''), SCRIPT));
    const c = await codexCheck(fake({ files: { '/u/.codex': '', '/u/.codex/hooks.json': old } }).deps);
    expect(c).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^out of date in \/u\/\.codex\/hooks\.json: run archi setup, then trust them in Codex$/) });
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
    expect(await check({ trusted: 0, untrusted: 5 })).toEqual({ name: 'codex hooks', status: 'warn', detail: 'not trusted yet: start codex and choose "Trust all and continue", or trust them in /hooks' });
    expect(await check(undefined)).toEqual({ name: 'codex hooks', status: 'ok', detail: `installed in ${CODEX.hooks}; couldn't ask Codex about trust, check /hooks in Codex` });
  });
});
