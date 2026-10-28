import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MachineId, PROTOCOL_VERSION, emptyState, type SetupRow } from '@svall/protocol';
import { addHost } from '../src/controller/host.js';
import { MachineRegistry } from '../src/controller/registry.js';
import {
  BASE, DOCTOR, ELSEWHERE, FLEET, HOME, REMOTE, THERE, TOKEN, UNIT_PATH, archive, daemon, deps, doctorJson, events, healthy, ssh, step, unticked, useHostWorld,
  varRow, work,
} from './controller/host-world.js';

useHostWorld();

describe('host add', () => {
  it('finds claude, codex and opencode on the PATH the companion\'s unit runs with, and holds each to its version floor and login', async () => {
    // over ssh the login shell finds none of the CLIs; their installers put them in ~/.local/bin
    healthy({ agents: false });
    ssh.reply([UNIT_PATH, 'claude', '--version'], { stdout: '2.1.278 (Claude Code)\n' });
    ssh.reply([UNIT_PATH, 'claude', 'auth', 'status', '--json'], { stdout: '{"loggedIn":false}\n', code: 1 });
    ssh.reply([UNIT_PATH, 'codex', '--version'], { stdout: 'codex-cli 0.154.2\n' });
    ssh.reply([UNIT_PATH, 'opencode', '--version'], { stdout: '2.0.21\n' });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('claude').at(-1)).toMatchObject({ status: 'warn', detail: '2.1.278 (Claude Code), not logged in', action: 'ssh trift.test, then claude auth login', run: 'claude auth login' });
    expect(step('codex').at(-1)).toMatchObject({ status: 'warn', detail: 'codex-cli 0.154.2: Svall needs 0.156.0 or newer', action: 'ssh trift.test, then codex update', run: 'codex update' });
    expect(step('opencode').at(-1)).toMatchObject({ status: 'warn', detail: '2.0.21: Svall needs 2.0.22 or newer', action: 'ssh trift.test, then opencode upgrade', run: 'opencode upgrade' });
    // one below the floor is compared no further, as its own row names the update
    expect(step('versions').at(-1)).toMatchObject({ status: 'ok', detail: 'claude 2.1.278, as on this Mac' });
    expect(out.actions).toEqual(['ssh trift.test, then claude auth login', 'ssh trift.test, then codex update', 'ssh trift.test, then opencode upgrade']);
    const agentCalls = ssh.remoteCalls().filter((w) => w.includes('claude') || w.includes('codex') || w.includes('opencode'));
    expect(agentCalls.length).toBe(4);
    expect(agentCalls.every((w) => w[0] === 'env' && w[1] === UNIT_PATH)).toBe(true);
  });

  it('asks each agent with the agent homes the companion\'s units carry, as its doctor names them, where a login in the login shell lands', async () => {
    const homes = { CLAUDE_CONFIG_DIR: `${HOME}/agents/claude`, CODEX_HOME: `${HOME}/agents/codex home` };
    // a name that is no plain variable never reaches env
    healthy({ agents: false, doctor: JSON.stringify({ ...JSON.parse(DOCTOR), daemonEnv: { ...homes, '-S': '/x' } }) });
    const env = [UNIT_PATH, `CLAUDE_CONFIG_DIR=${homes.CLAUDE_CONFIG_DIR}`, `CODEX_HOME=${homes.CODEX_HOME}`];
    ssh.reply([...env, 'claude', '--version'], { stdout: '2.1.278 (Claude Code)\n' });
    ssh.reply([...env, 'claude', 'auth', 'status', '--json'], { stdout: '{"loggedIn":true}\n' });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('claude').at(-1)).toMatchObject({ status: 'ok', detail: '2.1.278 (Claude Code), logged in' });
    const agentCalls = ssh.remoteCalls().filter((w) => w.includes('claude') || w.includes('codex') || w.includes('opencode'));
    expect(agentCalls.every((w) => w.slice(0, 4).join('\n') === ['env', ...env].join('\n') && !w.includes('-S=/x'))).toBe(true);
  });

  it('names an OpenCode whose auth list fails as not logged in', async () => {
    healthy({ agents: false });
    ssh.reply([UNIT_PATH, 'opencode', '--version'], { stdout: '2.0.22\n' });
    ssh.reply([UNIT_PATH, 'opencode', 'auth', 'list', '--standalone'], { stderr: 'Error: no credentials\n', code: 1 });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('opencode').at(-1)).toMatchObject({ status: 'warn', detail: '2.0.22, not logged in', action: 'ssh trift.test, then opencode auth login' });
  });

  it("names an OpenCode whose auth list names no model provider as not logged in, as doctor and a move's checks do", async () => {
    healthy({ agents: false });
    ssh.reply([UNIT_PATH, 'opencode', '--version'], { stdout: '2.0.22\n' });
    ssh.reply([UNIT_PATH, 'opencode', 'auth', 'list', '--standalone'], { stdout: '[]\n' });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('opencode').at(-1)).toMatchObject({ status: 'warn', detail: '2.0.22, not logged in', action: 'ssh trift.test, then opencode auth login' });
  });

  it('names an agent CLI the unit\'s PATH does not hold as one to install', async () => {
    healthy({ agents: false });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    // setup writes Svall's hooks only for the agents it finds, so one installed later needs it again
    expect(step('claude').at(-1)).toMatchObject({
      status: 'warn', detail: 'claude is not installed on this machine', action: 'ssh trift.test, then install Claude Code, then svall setup',
      run: 'curl -fsSL https://claude.ai/install.sh | bash',
    });
    expect(step('codex').at(-1)).toMatchObject({ status: 'warn', detail: 'codex is not installed on this machine', action: 'ssh trift.test, then install Codex, then svall setup', run: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' });
    expect(step('opencode').at(-1)).toMatchObject({ status: 'warn', detail: 'opencode is not installed on this machine', action: 'ssh trift.test, then install OpenCode, then svall setup', run: 'curl -fsSL https://opencode.ai/v2/install | bash' });
    expect(step('versions').at(-1)).toMatchObject({ status: 'skip', detail: 'no agent CLI to compare' });
  });

  it("names each agent whose release there is not this Mac's, which side is behind, and the vendor's update for it", async () => {
    healthy({ agents: false });
    ssh.reply([UNIT_PATH, 'claude', '--version'], { stdout: '2.1.280 (Claude Code)\n' });
    ssh.reply([UNIT_PATH, 'claude', 'auth', 'status', '--json'], { stdout: '{"loggedIn":true}\n' });
    ssh.reply([UNIT_PATH, 'codex', '--version'], { stdout: 'codex-cli 0.162.1-alpha.2\n' });
    ssh.reply([UNIT_PATH, 'codex', 'login', 'status'], { stdout: 'Logged in using ChatGPT\n' });
    ssh.reply([UNIT_PATH, 'opencode', '--version'], { stdout: '2.0.26\n' });
    ssh.reply([UNIT_PATH, 'opencode', 'auth', 'list', '--standalone'], { stdout: '[{"id":"openai"}]\n' });
    const mac = [{ kind: 'claude', version: '2.1.310' }, { kind: 'codex', version: '0.162.1' }, { kind: 'opencode', version: '2.0.22' }] as const;
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ localAgents: () => Promise.resolve([...mac]) }));
    await d.close();
    // each machine alone is fine; only a move between them stops
    expect(step('claude').at(-1)).toMatchObject({ status: 'ok', detail: '2.1.280 (Claude Code), logged in' });
    const action = 'ssh trift.test, then claude update, then codex update; on this Mac, run opencode upgrade';
    expect(step('versions').at(-1)).toEqual({
      step: 'versions', status: 'warn',
      detail: 'claude 2.1.280 there, behind 2.1.310 on this Mac; codex 0.162.1-alpha.2 there, behind 0.162.1 on this Mac; opencode 2.0.26 there, ahead of 2.0.22 on this Mac: a move there and back needs the same release on both',
      action, run: 'claude update && codex update',
    });
    expect(out).toEqual({ result: 'actions', actions: [action] });
  });

  it("names no update for an agent behind only on this Mac's side, as the terminal it would be typed in is the machine's", async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ localAgents: () => Promise.resolve([{ kind: 'claude', version: '2.1.270' }]) }));
    await d.close();
    expect(step('versions').at(-1)).toEqual({
      step: 'versions', status: 'warn',
      detail: 'claude 2.1.278 there, ahead of 2.1.270 on this Mac: a move there and back needs the same release on both', action: 'on this Mac, run claude update',
    });
  });

  it("adds the machine without comparing when this Mac's own daemon cannot be asked", async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ localAgents: () => Promise.reject(new Error('svalld is not running (no port file)')) }));
    await d.close();
    expect(step('versions').at(-1)).toMatchObject({ status: 'skip', detail: 'not compared: svalld is not running (no port file)' });
    expect(out.result).toBe('ready');
  });

  it('notes an agent CLI no fleet on this Mac runs, and asks for it once a fleet does or its state cannot be read', async () => {
    const fleet = (name: string, state?: object) => {
      const home = path.join(work, name);
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: crypto.randomUUID() }));
      if (state) fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ ...emptyState(), ...state }));
    };
    const add = async () => {
      events.length = 0;
      ssh.clearReplies();
      healthy({ agents: false });
      const d = await daemon();
      ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
      const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
      await d.close();
      return out;
    };
    fleet('.svall', { mainAgent: 'claude', scribeAgent: 'codex', scribeOff: true });
    const out = await add();
    expect(step('claude').at(-1)).toMatchObject({ status: 'warn', action: 'ssh trift.test, then install Claude Code, then svall setup' });
    for (const kind of ['codex', 'opencode']) {
      expect(step(kind).at(-1)).toEqual({ step: kind, status: 'skip', detail: `${kind} is not installed on this machine, and no fleet on this Mac runs it` });
    }
    expect(out.actions).toEqual(['ssh trift.test, then install Claude Code, then svall setup']);
    fleet('.svall-work');
    await add();
    expect(step('opencode').at(-1)).toMatchObject({ status: 'warn', action: 'ssh trift.test, then install OpenCode, then svall setup' });
  });

  it('names what Svall\'s hooks there still need, from the companion\'s own doctor, without stopping setup', async () => {
    const untrusted = 'not trusted yet: start codex and choose "Trust all and continue", or trust them in /hooks';
    const disabled = `${HOME}/.claude/settings.json sets disableAllHooks, so no robot gets a status; remove it`;
    const plugin = `not installed in ${HOME}/.config/opencode/plugins/svall.js: svall setup`;
    healthy({ doctor: JSON.stringify({ checks: [...JSON.parse(DOCTOR).checks, { name: 'hooks', status: 'fail', detail: disabled }, { name: 'codex hooks', status: 'warn', detail: untrusted, run: 'codex' }, { name: 'opencode plugin', status: 'fail', detail: plugin, run: 'svall setup' }] }) });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    await d.close();
    // a fix that is no one command to type leaves the step without one
    expect(step('claude').at(-1)).toMatchObject({ status: 'warn', detail: '2.1.278 (Claude Code), logged in; the hooks check there fails', action: `ssh trift.test, then ${disabled}` });
    expect(step('claude').at(-1)).not.toHaveProperty('run');
    expect(step('codex').at(-1)).toMatchObject({
      status: 'warn', detail: 'codex-cli 0.156.1, logged in; the codex hooks check there says not trusted yet',
      action: 'ssh trift.test, then start codex and choose "Trust all and continue", or trust them in /hooks', run: 'codex',
    });
    expect(step('opencode').at(-1)).toMatchObject({ status: 'warn', detail: `2.0.22, logged in; the opencode plugin check there says not installed in ${HOME}/.config/opencode/plugins/svall.js`, action: 'ssh trift.test, then svall setup', run: 'svall setup' });
    expect(out.result).toBe('actions');
    expect(registry.get('trift')?.id).toBe(REMOTE);
  });

  it('names the AppArmor profile Codex\'s sandbox needs there, from the companion\'s own doctor', async () => {
    const fix = 'sudo apt install bubblewrap apparmor-profiles, then sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict';
    const blocked = `AppArmor keeps bwrap from making the user namespace Codex runs commands in (bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted), so a Codex robot asks before each one: ${fix}`;
    const run = 'sudo apt install bubblewrap apparmor-profiles && sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict';
    healthy({ doctor: JSON.stringify({ checks: [...JSON.parse(DOCTOR).checks, { name: 'codex hooks', status: 'ok', detail: 'trusted' }, { name: 'codex sandbox', status: 'warn', detail: blocked, run }] }) });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    const codex = step('codex').at(-1)!;
    expect(codex).toMatchObject({
      status: 'warn', detail: `codex-cli 0.156.1, logged in; the codex sandbox check there says ${blocked.slice(0, blocked.lastIndexOf(': '))}`, action: `ssh trift.test, then ${fix}`, run,
    });
    // each fix once on the line: what is wrong in the detail, what to do in the action
    expect(`${codex.detail} -> ${codex.action}`.split(fix)).toHaveLength(2);
    expect(step('claude').at(-1)).toMatchObject({ status: 'ok' });
  });

  it('names both fixes a fresh Ubuntu leaves Codex, and the first one\'s command to type', async () => {
    const untrusted = 'not trusted yet: start codex and choose "Trust all and continue", or trust them in /hooks';
    const fix = 'sudo apt install bubblewrap apparmor-profiles, then sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict';
    const blocked = `AppArmor keeps bwrap from making the user namespace Codex runs commands in, so a Codex robot asks before each one: ${fix}`;
    healthy({ doctor: JSON.stringify({ checks: [...JSON.parse(DOCTOR).checks, { name: 'codex hooks', status: 'warn', detail: untrusted, run: 'codex' }, { name: 'codex sandbox', status: 'warn', detail: blocked, run: 'sudo apt install bubblewrap apparmor-profiles && sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict' }] }) });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    // the doctor shown once that terminal ends lists the sandbox on its own, with its own command
    expect(step('codex').at(-1)).toMatchObject({
      status: 'warn', action: `ssh trift.test, then start codex and choose "Trust all and continue", or trust them in /hooks; and ${fix}`, run: 'codex',
    });
  });

  it('names every Codex check that warns there, untrusted hooks and a blocked sandbox alike', async () => {
    const untrusted = 'not trusted yet: start codex and choose "Trust all and continue", or trust them in /hooks';
    const blocked = 'AppArmor keeps bwrap from making the user namespace Codex runs commands in (bwrap: denied), so a Codex robot asks before each one: sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict';
    healthy({ doctor: JSON.stringify({ checks: [...JSON.parse(DOCTOR).checks, { name: 'codex hooks', status: 'warn', detail: untrusted }, { name: 'codex sandbox', status: 'warn', detail: blocked }] }) });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('codex').at(-1)).toMatchObject({
      status: 'warn',
      detail: 'codex-cli 0.156.1, logged in; the codex hooks check there says not trusted yet; the codex sandbox check there says AppArmor keeps bwrap from making the user namespace Codex runs commands in (bwrap: denied), so a Codex robot asks before each one',
      action: 'ssh trift.test, then start codex and choose "Trust all and continue", or trust them in /hooks; and sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict',
    });
  });

  it('takes a far home other than this Mac\'s, and registers the machine at it', async () => {
    healthy({ home: ELSEWHERE });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    await d.close();
    expect(step('home').at(-1)).toEqual({ step: 'home', status: 'ok', detail: `${ELSEWHERE} for linus` });
    expect(out.result).toBe('ready');
    expect(registry.get('trift')?.record).toMatchObject({ home: ELSEWHERE, svallBase: `${ELSEWHERE}/.local/share/svall` });
  });

  it('add refuses a machine whose home makes the fleet socket too long, naming the listen EINVAL it would otherwise crash on', async () => {
    // 90 bytes: the fleet's hook socket, 18 bytes further on, is one past the 107 Linux holds
    const long = `/home/${'h'.repeat(84)}`;
    healthy({ home: long });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(out.result).toBe('actions');
    expect(step('home').at(-1)?.detail).toMatch(/^the socket \/home\/.+\/\.svall\/hooks\.sock is /);
    expect(step('home').at(-1)).toMatchObject({
      status: 'fail',
      detail: `the socket ${long}/.svall/hooks.sock is 108 bytes, past the 107 a Unix socket path holds, so its listen fails with EINVAL`,
      action: 'use an account on trift.test whose home path is at most 89 bytes',
    });
    expect(ssh.remoteCalls().some((w) => w.includes('setup') || w.includes('cat > "$1"'))).toBe(false);
  });

  it('takes a home just short enough for the fleet socket', async () => {
    const long = `/home/${'h'.repeat(83)}`;
    healthy({ home: long });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(step('home').at(-1)).toMatchObject({ status: 'ok' });
  });

  it.each(['/home/linus/', '/home//linus', '/home/./linus'])('stops at a far home written another way, %s, which a path under it would not come back from', async (spelled) => {
    healthy({ home: spelled });
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    expect(out.result).toBe('actions');
    expect(step('home').at(-1)).toEqual({
      step: 'home', status: 'fail',
      detail: `${spelled} is linus's home there, which names /home/linus another way`,
      action: 'make /home/linus the account\'s home on trift.test, then add the machine again',
    });
    expect(registry.get('trift')).toBeUndefined();
  });

  it('stops on a machine that is not Ubuntu', async () => {
    healthy({ osRelease: 'ID=debian\nVERSION_ID="12"\n' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(out.result).toBe('actions');
    expect(step('os').at(-1)).toMatchObject({ status: 'fail' });
    expect(step('os').at(-1)?.detail).toContain('Ubuntu');
    expect(ssh.remoteCalls().some((w) => w.includes('setup'))).toBe(false);
  });

  it('stops on an Ubuntu older than 22.04, whose glibc the companion\'s tmux does not run on', async () => {
    healthy({ osRelease: 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="20.04"\n' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(out).toMatchObject({ result: 'actions', stopped: 'os' });
    expect(step('os').at(-1)).toMatchObject({ status: 'fail', detail: 'Ubuntu 20.04 is older than 22.04, the oldest release the companion runs on' });
  });

  it('takes Ubuntu 22.04, the release the companion\'s tmux is built on', async () => {
    healthy({ osRelease: 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="22.04"\n', tools: ['tailscale', 'systemctl', 'loginctl'] });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(out).toMatchObject({ result: 'actions', stopped: 'tools' });
    expect(step('os').at(-1)).toMatchObject({ status: 'ok', detail: 'Ubuntu 22.04 arm64 (LTS)' });
  });

  it('names the apt command for the packages the machine is missing', async () => {
    healthy({ tools: ['tailscale', 'systemctl', 'loginctl'] });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(out.result).toBe('actions');
    expect(step('tools').at(-1)).toMatchObject({ status: 'fail', action: 'ssh trift.test, then sudo apt install git', run: 'sudo apt install git' });
    expect(ssh.remoteCalls().some((w) => w.includes('sudo'))).toBe(false);
  });

  it('adds a machine that has no rsync', async () => {
    healthy({ tools: ['tailscale', 'git', 'systemctl', 'loginctl'] });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(events.map((s) => s.step)).not.toContain('rsync');
    expect(ssh.remoteCalls().flat()).not.toContainEqual(expect.stringMatching(/\brsync\b/));
    expect(out.result).toBe('ready');
  });

  it('checks the tmux the units start once the release is installed, which is the release\'s own', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('tmux').at(-1)).toMatchObject({ status: 'ok', detail: "tmux 3.7c, Svall's own" });
    expect(ssh.remoteCalls().find((c) => c.includes('svall-tmux-version'))?.slice(0, 2)).toEqual(['env', UNIT_PATH]);
    expect(out.result).toBe('ready');
  });

  it('warns about a machine\'s tmux too old for Shift+Enter without blocking, for a release that carries none', async () => {
    healthy({ tmux: { stdout: '/usr/bin/tmux\ntmux 3.4\n' } });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('tmux').at(-1)).toMatchObject({ status: 'warn', detail: 'tmux 3.4 from /usr/bin/tmux: Shift+Enter needs tmux 3.5 or newer; Ubuntu 24.04 ships 3.4' });
    expect(out.result).toBe('ready');
  });

  it('stops with the apt command where neither the release nor the machine has a tmux', async () => {
    healthy({ tmux: { code: 3 } });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(out).toMatchObject({ result: 'actions', stopped: 'tmux', actions: ['ssh trift.test, then sudo apt install tmux'] });
    expect(step('tmux').at(-1)).toMatchObject({ status: 'fail', run: 'sudo apt install tmux' });
    expect(step('install').at(-1)).toMatchObject({ status: 'ok' });
  });

  it('stops on a release\'s tmux that cannot run there, naming its exit', async () => {
    healthy({ tmux: { stdout: `${BASE}/current/bin/tmux\n`, stderr: 'tmux: error while loading shared libraries: libtinfo.so.6\n', code: 127 } });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(out).toMatchObject({ result: 'actions', stopped: 'tmux' });
    expect(step('tmux').at(-1)).toMatchObject({ status: 'fail', detail: `${BASE}/current/bin/tmux -V exited 127: tmux: error while loading shared libraries: libtinfo.so.6` });
  });

  it('reports a link lost at the tmux step as such, not as a missing tmux', async () => {
    healthy({ tmux: { stderr: 'Connection to trift.test closed by remote host.\n', code: 255 } });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(out).toMatchObject({ result: 'actions', stopped: 'tmux' });
    expect(step('tmux').at(-1)).toEqual({ step: 'tmux', status: 'fail', detail: 'tmux -V exited 255: Connection to trift.test closed by remote host.' });
  });

  it('turns lingering on where it is off, and leaves nothing to do when the system lets it', async () => {
    healthy({ linger: 'Linger=no\nLinger=yes\n' });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(ssh.remoteCalls().find((c) => c.includes('svall-linger'))?.join(' ')).toContain('loginctl enable-linger "$USER"');
    expect(step('linger').at(-1)).toMatchObject({ status: 'ok', detail: 'turned on for linus: the fleet keeps running after you log out' });
    expect(step('service').at(-1)).toMatchObject({ status: 'ok' });
    expect(out).toEqual({ result: 'ready', actions: [] });
  });

  it('surfaces the sudo enable-linger command, and the machine to run it on, when the system refuses to turn lingering on', async () => {
    const off = { status: 'warn', detail: 'off for linus: the fleet stops when you log out; run sudo loginctl enable-linger linus' };
    healthy({ linger: 'Linger=no\nLinger=no\n', doctor: doctorJson(off) });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('linger').at(-1)).toMatchObject({
      status: 'warn', detail: 'off for linus, and the system refused to turn it on: the fleet stops when you log out',
      action: 'ssh trift.test, then sudo loginctl enable-linger linus', run: 'sudo loginctl enable-linger linus',
    });
    expect(step('service').at(-1)).toMatchObject({ status: 'warn', action: 'ssh trift.test, then sudo loginctl enable-linger linus', run: 'sudo loginctl enable-linger linus' });
    // both steps name the one command, which the user is left to run once
    expect(out).toEqual({ result: 'actions', actions: ['ssh trift.test, then sudo loginctl enable-linger linus'] });
  });

  it('takes the service from a companion doctor that exits 1 over a check the service does not need', async () => {
    healthy();
    const failing = JSON.stringify({ checks: [...JSON.parse(DOCTOR).checks, { name: 'hooks', status: 'fail', detail: 'not installed' }] });
    ssh.clearReplies();
    ssh.reply(['doctor', '--json'], { stdout: failing, code: 1 });
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('service').at(-1)).toMatchObject({ status: 'ok' });
    expect(step('registry').at(-1)).toMatchObject({ status: 'ok' });
  });

  it('names each step once, so the checklist never opens a phase twice', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    const names = events.filter((e) => e.status !== 'start').map((e) => e.step);
    expect(names).toEqual([
      'name', 'ssh', 'master', 'os', 'home', 'tools', 'space', 'linger',
      'release', 'upload', 'install', 'tmux', 'service', 'identity', 'enrol', 'claude', 'codex', 'opencode', 'gh', 'versions', 'probe', 'registry',
    ]);
  });

  it('host add ends with the mirror rows after the registry step, each with its tick, and is ready with them as what will not work there yet', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const asked: [MachineId, number][] = [];
    const rows = [unticked('claude:mcp:linear'), unticked('codex:mcp:github'), { ...varRow('GAMMA_TOKEN'), here: true as const }];
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ setupRows: (m, wait) => { asked.push([m, wait]); return Promise.resolve(rows); } }));
    await d.close();
    // a machine just linked has 30 s to come up
    expect(asked).toEqual([[REMOTE, 30_000]]);
    expect(events.filter((e) => e.status !== 'start').map((e) => e.step).slice(-4)).toEqual(['registry', 'mirror:claude:mcp:linear', 'mirror:codex:mcp:github', 'mirror:var:GAMMA_TOKEN']);
    expect(step('mirror:claude:mcp:linear').at(-1)).toMatchObject({ status: 'warn', action: "copy linear's keys to trift", tick: { item: 'claude:mcp:linear', on: false } });
    // a variable this Mac has says so on its step, for the row's Copy from this Mac
    expect(step('mirror:var:GAMMA_TOKEN').at(-1)).toMatchObject({ status: 'warn', action: 'set GAMMA_TOKEN on trift', run: 'svall worker env GAMMA_TOKEN', here: true });
    expect(out).toEqual({ result: 'ready', actions: [], setup: ['mirror:claude:mcp:linear', 'mirror:codex:mcp:github', 'mirror:var:GAMMA_TOKEN'].map((k) => step(k).at(-1)) });
  });

  it('host add keeps two servers whose rows read alike as two rows of what will not work there, and leaves out rows that only ask to check again', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const again = (key: string): SetupRow => ({ key, status: 'warn', action: 'check trift again', detail: 'sent; not on trift yet' });
    const rows = [unticked('claude:mcp:github'), unticked('codex:mcp:github'), again('var:X'), again('var:Y')];
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ setupRows: () => Promise.resolve(rows) }));
    await d.close();
    expect(out).toEqual({ result: 'ready', actions: [], setup: [step('mirror:claude:mcp:github').at(-1), step('mirror:codex:mcp:github').at(-1)] });
  });

  it('host add with only gh to log in to there is ready, and offers gh\'s login in the terminal', async () => {
    healthy({ doctor: JSON.stringify({ checks: [...JSON.parse(DOCTOR).checks, { name: 'gh', status: 'warn', detail: 'not logged in: gh auth login', run: 'gh auth login' }] }) });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(step('gh').at(-1)).toEqual({ step: 'gh', status: 'warn', detail: 'not logged in: gh auth login', run: 'gh auth login' });
    expect(out).toEqual({ result: 'ready', actions: [] });
  });

  it('host add whose daemon is not running ends in one not-checked row and the outcome line', async () => {
    const { outcomeText } = await import('../src/commands/host.js');
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ setupRows: () => Promise.reject(new Error('svalld is not running')) }));
    await d.close();
    expect(step('mirror:unchecked').at(-1)).toEqual({
      step: 'mirror:unchecked', status: 'warn', detail: 'not checked: svalld is not running', action: 'svall host doctor trift once Svall is open', gap: { name: 'agent setup', what: 'not checked' },
    });
    expect(outcomeText(out, 'add', 'trift', { there: THERE }))
      .toBe('trift is ready. 1 part of your agent setup will not work there yet:\n  agent setup  not checked  → svall host doctor trift once Svall is open');
  });

  it("the gh step reads the companion doctor's gh check: logged in, or gh auth login with the terminal and no thing to do", async () => {
    const said = (gh: Record<string, string>): string => JSON.stringify({ checks: [...JSON.parse(DOCTOR).checks, { name: 'gh', ...gh }] });
    const loggedOut = 'not logged in: gh auth login (pull request links stay unresolved)';
    for (const [gh, want] of [
      [{ status: 'ok', detail: 'logged in' }, { status: 'ok', detail: 'logged in' }],
      [{ status: 'warn', detail: loggedOut, run: 'gh auth login' }, { status: 'warn', detail: loggedOut, run: 'gh auth login' }],
    ] as const) {
      ssh.clearReplies();
      events.length = 0;
      healthy({ doctor: said(gh) });
      // stops at the probe, with no daemon to answer it, past the agents
      await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
      expect(step('gh')).toEqual([{ step: 'gh', ...want }]);
    }
    ssh.clearReplies();
    events.length = 0;
    healthy();
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(step('gh')).toEqual([{ step: 'gh', status: 'skip', detail: "the companion's doctor reported no gh check" }]);
  });

  it('stops at the service when the fleet\'s unit is not running', async () => {
    const stopped = JSON.stringify({ checks: JSON.parse(DOCTOR).checks.map((c: { name: string }) => (c.name === 'systemd'
      ? { name: 'systemd', status: 'fail', detail: 'svall-svalld@private.service: loaded, inactive (dead), disabled' } : c)) });
    ssh.reply(['doctor', '--json'], { stdout: stopped, code: 1 });
    healthy();
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(step('service').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining('svall-svalld@private.service') });
    expect(out.result).toBe('actions');
  });
});
