import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@svall/protocol';
import { resolvePaths } from '@svall/svalld/paths';
import { issueToken, tokenFor } from '@svall/svalld/placement/workers';
import { hostLock } from '@svall/svalld/kernel-lock';
import { addHost, removeHost, rollbackHost, StepError, tailnetHere, upgradeHost } from '../src/controller/host.js';
import { TailscaleDown } from '@svall/svalld/mobile';
import { wantedCompanion } from '../src/controller/install.js';
import { MachineRegistry } from '../src/controller/registry.js';
import { companionArchive, ephemeralSigner } from './controller/archive.js';
import {
  BASE, DF, DOCTOR, FLEET, HOME, MAC, OS_RELEASE, OTHER_FLEET, OTHER_MAC, OWN_TMUX, REMOTE, SERVES, SVALL, TOKEN, archive, daemon, deps, events, fleet, healthy,
  refreshed, signer, ssh, step, useHostWorld, work,
} from './controller/host-world.js';

useHostWorld();

describe('host add', () => {
  it('probes, installs, checks and registers the machine', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });

    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry: MachineRegistry.load(path.join(work, 'config')) }));
    await d.close();

    expect(out.result).toBe('ready');
    // each step names the machine, never its id
    expect(JSON.stringify(events)).not.toContain(REMOTE);
    const order = ssh.remoteCalls().map((w) => (w[0] === 'sh' ? w[2].slice(0, 20) : w[0] === 'env' ? `${w[2]} ${w[3]}` : path.basename(w[0]) + (w[1] ? ` ${w[1]}` : '')));
    expect(order.slice(0, 6)).toEqual([
      'uname -sm', 'cat /etc/os-release',
      'printf "%s\\n%s\\n" "$', 'for c in "$@"; do if',
      'df -Pk "$HOME"', 'l=$(loginctl show-us',
    ]);
    expect(order.slice(6)).toEqual([
      'svall version', '[ -d "$1" ] || exit ', 'mkdir -p', 'cat > "$1"', 'mkdir -p', 'PATH=/usr/bin:/bin:/', 'svall setup', 'rm -rf',
      'sh -c', 'svall doctor', 'svall version', '[ -f "$1/$2" ] && ec', 'svall version', 'svall worker', 'svall --json',
      'claude --version', 'claude auth', 'codex --version', 'codex login', 'opencode --version', 'opencode auth',
      'svall connection-info', 'svall version', 'sh -c',
    ]);
    expect(step('versions').at(-1)).toMatchObject({ status: 'ok', detail: 'Claude Code 2.1.278, Codex 0.156.1, OpenCode 2.0.22, same as this Mac' });
    expect(step('probe').at(-1)).toMatchObject({ status: 'ok', detail: 'answers', raw: 'trift answers on its own private fleet, serves this fleet as a worker, and tmux opens and closes a window there' });
    expect(step('release').at(-1)).toMatchObject({ detail: '1.2.3', raw: '1.2.3 for linux-arm64 from the archive you named (signed)' });
    // a row says how a thing stands, its name what the thing is
    expect(events.filter((e) => e.status === 'ok' && !e.step.startsWith('mirror:')).map((e) => [e.step, e.detail])).toEqual(expect.arrayContaining([
      ['ssh', 'logs in'], ['master', 'connected'], ['tools', 'all there'], ['upload', 'done'], ['install', '1.2.3 installed'], ['identity', '1.2.3'], ['registry', 'listed'],
    ]));
  });

  it('host add enrols the machine as a worker: worker.json written there, the fleet unit restarted with --worker, no gateway unit', async () => {
    const input = path.join(work, 'enroll-stdin');
    ssh.reply(['worker', 'enroll'], { stdout: `systemd unit -> ${HOME}/.config/systemd/user/svall-svalld@private.service\nsystemctl --user restart svall-svalld@private.service\n`, input });
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    await d.close();

    expect(out).toEqual({ result: 'ready', actions: [] });
    const mac = registry.localMachine().name;
    expect(ssh.remoteCalls().find((w) => w.includes('enroll'))).toEqual([SVALL, 'worker', 'enroll', '--home-machine', MAC, '--home-name', mac, '--fleet-id', FLEET, '--home-platform', registry.localMachine().platform]);
    // worker.json there takes, on its stdin, the token this fleet's daemon opens the link with
    expect(fs.readFileSync(input, 'utf8')).toBe(tokenFor(resolvePaths(fleet), REMOTE));
    expect(step('enrol').at(-1)).toEqual({ step: 'enrol', status: 'ok', detail: 'joined this fleet', raw: 'trift serves this fleet as a worker of this Mac; systemctl --user restart svall-svalld@private.service' });
    expect(ssh.remoteCalls().some((w) => w.includes('gateway'))).toBe(false);
    // this fleet's daemon links it without waiting for its next start
    expect(refreshed).toBe(1);
  });


  it('enrols a machine this fleet holds a profile for, as a move named it apart, under that profile, which its link dials', async () => {
    fs.writeFileSync(resolvePaths(fleet).workersFile, JSON.stringify({ [REMOTE]: { token: 'a'.repeat(48), addedAt: 1, profile: 'private' } }));
    ssh.reply(['worker', 'enroll'], { stdout: '' });
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry: MachineRegistry.load(path.join(work, 'config')), fleet: { home: fleet, profile: 'work' } }));
    await d.close();
    expect(ssh.remoteCalls().find((w) => w.includes('enroll'))?.slice(1, 3)).toEqual(['worker', 'enroll']);
    expect(JSON.parse(fs.readFileSync(resolvePaths(fleet).workersFile, 'utf8'))[REMOTE]).toMatchObject({ profile: 'private' });
  });

  it('--as-home leaves the machine a fleet of its own, enrols nothing there and offers no setup, for a join to follow', async () => {
    // as the machine answers once nothing enrolled it: a home of its own, naming no one
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, role: 'home', fleetId: '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70' }) });
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive(), asHome: true }, deps({ registry: MachineRegistry.load(path.join(work, 'config')) }));
    await d.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(step('probe').at(-1)).toMatchObject({ status: 'ok', detail: 'answers', raw: expect.stringContaining('as its home') });
    const said = events.filter((e) => e.status !== 'start').map((e) => e.step);
    expect(said).not.toContain('enrol');
    expect(said.some((step) => step.startsWith('mirror:'))).toBe(false);
    expect(said).toContain('registry');
    expect(ssh.remoteCalls().some((w) => w.includes('enroll'))).toBe(false);
  });

  it('tells the release the machine runs once it answers on it, for host list', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const runs = vi.fn();
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry: MachineRegistry.load(path.join(work, 'config')), runs }));
    await d.close();
    expect([out.result, runs.mock.calls]).toEqual(['ready', [['1.2.3']]]);
  });

  it('enrols a named fleet under the profile it runs there', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ fleet: { home: fleet, profile: 'work' } }));
    await d.close();
    expect(ssh.remoteCalls().find((w) => w.includes('enroll'))?.slice(0, 4)).toEqual([SVALL, '-p', 'work', 'worker']);
    expect(ssh.remoteCalls().filter((w) => w.includes('version')).at(-1)).toEqual([SVALL, '-p', 'work', 'version', '--json']);
  });

  it('fails the probe on a fleet there that does not run as a worker, or a tmux that cannot open a window, and registers nothing', async () => {
    for (const [match, reply, said] of [
      [['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }) }, 'answers, but not as a worker of this fleet'],
      [['svall-tmux'], { stderr: 'error connecting to /tmp/svall-probe (No such file or directory)\n', code: 1 }, 'tmux could not open a window there'],
    ] as const) {
      ssh.clearReplies();
      ssh.reply([...match], reply);
      healthy();
      const d = await daemon();
      ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
      events.length = 0;
      const registry = MachineRegistry.load(path.join(work, 'config'));
      const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
      await d.close();
      expect(out.result).toBe('actions');
      expect(step('probe').at(-1)).toMatchObject({ status: 'fail', detail: said, raw: expect.any(String) });
      if (said.startsWith('answers')) expect(step('probe').at(-1)?.action).toBe('Add the machine again, which enrols it anew');
      expect(registry.get('trift')).toBeUndefined();
    }
  });

  it('adds nothing over the fleet\'s own home, which would make it a worker of its worker', async () => {
    fs.writeFileSync(resolvePaths(fleet).workerFile, JSON.stringify({ homeMachineId: REMOTE, fleetId: FLEET, token: 't'.repeat(48), homeName: 'trift' }));
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, role: 'home', fleetId: FLEET }, null, 2) });
    healthy();
    // listed, as the home it serves is past what a worker refuses
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({ name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64', home: HOME, svallBase: BASE }, REMOTE);
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    expect(out.stopped).toBe('release');
    expect(step('release').at(-1)?.detail).toBe("trift is this fleet's home, so it cannot be added as its worker");
    expect(step('release').at(-1)?.action).toBe("svall host upgrade trift takes it to this Mac's release");
    expect(ssh.remoteCalls().some((w) => w.includes('enroll'))).toBe(false);
  });

  it('a named fleet\'s refusal names its profile in the command it gives, as a copied one would act on the private fleet', async () => {
    fs.writeFileSync(resolvePaths(fleet).workerFile, JSON.stringify({ homeMachineId: REMOTE, fleetId: FLEET, token: 't'.repeat(48), homeName: 'trift' }));
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, role: 'home', fleetId: FLEET }, null, 2) });
    healthy();
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({ name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64', home: HOME, svallBase: BASE }, REMOTE);
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry, fleet: { home: fleet, profile: 'fartest' } }));
    expect(out.stopped).toBe('release');
    expect(step('release').at(-1)?.action).toBe("svall -p fartest host upgrade trift takes it to this Mac's release");
  });

  it('--as-home goes on over the fleet\'s own home, as a first run\'s join that stopped short leaves it, so Try again reaches the join', async () => {
    fs.writeFileSync(resolvePaths(fleet).workerFile, JSON.stringify({ homeMachineId: REMOTE, fleetId: FLEET, token: 't'.repeat(48), homeName: 'trift' }));
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, role: 'home', fleetId: FLEET }) });
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive(), asHome: true }, deps({ registry: MachineRegistry.load(path.join(work, 'config')) }));
    await d.close();
    expect(step('release').at(-1)?.status).toBe('ok');
    expect(out).toEqual({ result: 'ready', actions: [] });
  });

  it('--as-home refuses a fleet there that is a worker before anything is uploaded, naming the move that makes it the home', async () => {
    const worker = { homeMachineId: MAC, homeName: 'mac', fleetId: FLEET };
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, role: 'worker', worker }) });
    healthy();
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive(), asHome: true }, deps({ registry }));
    expect(out.stopped).toBe('release');
    expect(step('release').at(-1)).toMatchObject({ detail: 'trift serves mac as a worker, so it cannot be a home', action: "svall host add trift --ssh trift.test lists it again, then svall fleet home set trift makes it this fleet's home" });
    expect(ssh.remoteCalls().some((w) => w[0] === 'sh' && w[2].includes('cat > "$1"'))).toBe(false);
    expect(registry.get('trift')).toBeUndefined();
  });

  it('--as-home asks the private fleet there, the one it makes a home, whatever this fleet\'s profile; one serving another fleet here is removed from it first', async () => {
    const worker = { homeMachineId: MAC, homeName: 'mac', fleetId: OTHER_FLEET };
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, role: 'worker', worker }) });
    healthy();
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive(), asHome: true }, deps({ registry: MachineRegistry.load(path.join(work, 'config')), fleet: { home: fleet, profile: 'mac2' } }));
    expect(out.stopped).toBe('release');
    expect(step('release').at(-1)).toMatchObject({ action: 'remove trift from the fleet it serves on mac first' });
    expect(ssh.remoteCalls().filter((w) => w.includes('version')).every((w) => !w.includes('mac2') && !w.includes("'mac2'"))).toBe(true);
  });

  it('--as-home asks for Tailscale on this Mac before any ssh; a worker\'s add does not', async () => {
    const asked: string[] = [];
    const off = deps({ tailnet: () => Promise.reject(new Error('tailscale not found: install it from https://tailscale.com/download and sign in')), interactiveSsh: (to) => { asked.push(to); return Promise.resolve({ code: 0, stderr: '' }); } });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive(), asHome: true }, off);
    expect(out.stopped).toBe('tailscale');
    expect(step('tailscale').at(-1)).toMatchObject({
      status: 'fail', detail: 'this Mac has no Tailscale', action: 'Install it from https://tailscale.com/download and sign in', raw: expect.stringContaining('tailscale not found'),
    });
    expect(asked).toEqual([]);
    // one stopped or signed out says so, with what starts or signs it in on the machine's platform
    const said = async (e: Error, platform: NodeJS.Platform) => tailnetHere({ tailnet: () => Promise.reject(e) }, platform).catch((err: StepError) => ({ detail: err.detail, action: err.action, run: err.run }));
    expect(await said(new TailscaleDown('stopped', 'Command failed: tailscale status --json'), 'darwin')).toEqual({ detail: 'Tailscale is not running on this Mac', action: 'Open the Tailscale app', run: undefined });
    expect(await said(new TailscaleDown('stopped', 'Command failed'), 'linux')).toMatchObject({ action: 'Start it: sudo systemctl start tailscaled', run: 'sudo systemctl start tailscaled' });
    expect(await said(new TailscaleDown('signedOut', 'BackendState NeedsLogin'), 'darwin')).toEqual({ detail: 'Tailscale on this Mac is signed out', action: 'Sign in from the Tailscale app', run: undefined });
    expect(await said(new TailscaleDown('signedOut', 'BackendState NeedsLogin'), 'linux')).toMatchObject({ action: 'Sign in: sudo tailscale up', run: 'sudo tailscale up' });
    events.length = 0;
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, { ...off, interactiveSsh: () => Promise.resolve({ code: 255, stderr: 'no route' }) });
    expect(step('tailscale')).toEqual([]);
  });

  it('a home with no terminal asks nothing, and says its own key is what is missing, with the line that fixes it', async () => {
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ interactiveSsh: () => Promise.resolve({ code: 255, stderr: 'Permission denied (publickey).', batch: true }) }));
    expect(out.stopped).toBe('ssh');
    expect(step('ssh').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringMatching(/cannot log in to trift\.test$/), raw: 'Permission denied (publickey).', run: expect.stringContaining("ssh-copy-id 'trift.test'") });
    events.length = 0;
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ interactiveSsh: () => Promise.resolve({ code: 255, stderr: 'ssh: connect to host trift.test port 22: No route to host', batch: true }) }));
    expect(step('ssh').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringMatching(/cannot reach trift\.test/) });
    expect(step('ssh').at(-1)!.run).toBeUndefined();
  });

  it('a run on a Mac home names it by its word, not by its registry name', async () => {
    const d = deps({ interactiveSsh: () => Promise.resolve({ code: 255, stderr: 'Permission denied (publickey).', batch: true }) });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, d);
    expect(step('ssh').at(-1)).toMatchObject({ detail: 'this Mac cannot log in to trift.test', action: expect.stringMatching(/^on this Mac, run /) });
    expect(JSON.stringify(step('ssh'))).not.toContain(d.registry.localMachine().name);
  });

  it('a relayed run names the home by the word its relay passes, as the window\'s machine calls it', async () => {
    vi.stubEnv('SVALL_HOME_WORD', 'studio');
    try {
      await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ interactiveSsh: () => Promise.resolve({ code: 255, stderr: 'Permission denied (publickey).', batch: true }) }));
      expect(step('ssh').at(-1)).toMatchObject({ detail: 'studio cannot log in to trift.test', action: expect.stringMatching(/^on studio, run /) });
    } finally { vi.unstubAllEnvs(); }
  });

  it('has nothing for a machine of another architecture but what the relay names, and fetches nothing', async () => {
    healthy();
    const fetch = vi.fn();
    const out = await addHost({ name: 'trift', ssh: 'trift.test' }, deps({ fetch: fetch as never }));
    expect(out.stopped).toBe('release');
    expect(step('release').at(-1)).toMatchObject({ detail: 'this build publishes no companion for linux-arm64; name one with --release <archive>' });
    expect(wantedCompanion(step('release').at(-1)!)).toBe('linux-arm64');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uploads and enrols nothing over a fleet home there that serves another Mac as a worker, and registers nothing', async () => {
    const action = 'on bea-mbp, run svall host remove trift';
    const worker = { homeMachineId: OTHER_MAC, homeName: 'bea-mbp', fleetId: OTHER_FLEET };
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, worker }) });
    healthy();
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    expect(out).toEqual({ result: 'actions', stopped: 'release', actions: [action] });
    expect(step('release').at(-1)).toEqual({ step: 'release', status: 'fail', detail: 'trift already serves bea-mbp as a worker; remove it from bea-mbp first', action });
    expect(ssh.remoteCalls().some((w) => w.includes('cat > "$1"') || w.includes('setup') || w.includes('enroll'))).toBe(false);
    expect(tokenFor(resolvePaths(fleet), REMOTE)).toBeUndefined();
    expect(registry.get('trift')).toBeUndefined();
  });

  it('uploads nothing to a machine that runs a newer release than this Mac, which installing would take back, and takes a development build past the release it runs', async () => {
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.10.0', protocol: PROTOCOL_VERSION, machineId: REMOTE, worker: SERVES }) });
    healthy();
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(out).toEqual({ result: 'actions', stopped: 'release', actions: ['update svall on this Mac'] });
    expect(step('release').at(-1)).toMatchObject({ status: 'fail', detail: 'trift runs release 1.10.0, newer than 1.2.3, the one this Mac would install' });
    expect(ssh.remoteCalls().some((w) => w.includes('cat > "$1"') || w.includes('setup'))).toBe(false);

    ssh.clearReplies();
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, worker: SERVES }) });
    healthy();
    events.length = 0;
    const controller = { release: 'dev', protocol: PROTOCOL_VERSION, releaseRoot: path.join(work, 'release'), signed: true };
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive({ version: '1.2.3-4-gabcdef0' }) }, deps({ controller }));
    expect(step('release').at(-1)).toMatchObject({ status: 'ok' });
    expect(ssh.remoteCalls().some((w) => w.includes('cat > "$1"'))).toBe(true);
  });

  it('uploads and enrols nothing on a machine this Mac already lists under another name, and keeps its one record', async () => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({ name: 'vault', ssh: 'vault.test', platform: 'linux', arch: 'arm64', home: HOME, svallBase: BASE }, REMOTE);
    healthy();
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    const action = 'svall host upgrade vault sets it up again, or svall host remove vault --forget and add it as trift';
    expect(out).toEqual({ result: 'actions', stopped: 'release', actions: [action] });
    expect(step('release').at(-1)).toEqual({ step: 'release', status: 'fail', detail: "trift.test reaches vault, a machine already in this Mac's list", action });
    expect(ssh.remoteCalls().some((w) => w.includes('cat > "$1"') || w.includes('setup') || w.includes('enroll'))).toBe(false);
    expect(tokenFor(resolvePaths(fleet), REMOTE)).toBeUndefined();
    expect(registry.list().filter((m) => m.id === REMOTE).map((m) => m.record.name)).toEqual(['vault']);
  });

  it('stops at identity on a machine with no svall to ask that this Mac lists under another name, and enrols nothing', async () => {
    const far = path.join(work, 'far');
    const base = `${far}/.local/share/svall`;
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({ name: 'vault', ssh: 'vault.test', platform: 'linux', arch: 'arm64', home: far, svallBase: base }, REMOTE);
    for (const [match, stdout] of [
      [['uname', '-sm'], 'Linux aarch64\n'], [['cat', '/etc/os-release'], OS_RELEASE], [['svall-home'], `${far}\nlinus\n`],
      [['svall-tools'], ['tailscale', 'git', 'systemctl', 'loginctl'].map((t) => `${t} yes\n`).join('')],
      [['svall-tmux-version'], OWN_TMUX], [['svall-space'], DF], [['svall-linger'], 'Linger=yes\n'],
    ] as [string[], string][]) ssh.reply(match, { stdout });
    ssh.execute({});
    const svall = `#!/bin/sh
case "$1" in
  version) printf '%s\\n' '${JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE })}' ;;
  doctor) printf '%s\\n' '${DOCTOR}' ;;
  setup) mkdir -p '${base}' && tar -xzf "$3" -C '${base}' && ln -sfn '${base}/releases/1.2.3' '${base}/current' ;;
esac
`;
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: companionArchive(work, { signedBy: signer.key, svall }) }, deps({ registry }));
    expect(step('release').at(-1)).toMatchObject({ status: 'ok' });
    expect(out).toMatchObject({ result: 'actions', stopped: 'identity' });
    expect(step('identity').at(-1)).toMatchObject({ status: 'fail', detail: "trift.test reaches vault, a machine already in this Mac's list" });
    expect(ssh.remoteCalls().some((w) => w.includes('enroll'))).toBe(false);
    expect(registry.list().filter((m) => m.id === REMOTE).map((m) => m.record.name)).toEqual(['vault']);
  });

  it('add stops and removes a gateway unit it finds there, and enrols the fleet\'s unit as the worker', async () => {
    ssh.reply(['svall-units'], { stdout: 'gateway\nplain\n' });
    ssh.reply(['svall-gateway-off'], {});
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    const calls = ssh.remoteCalls();
    expect(calls).toContainEqual(expect.arrayContaining(['systemctl --user disable --now "$(basename "$1")" && rm -f "$1" && systemctl --user daemon-reload']));
    expect(calls.findIndex((w) => w.includes('svall-gateway-off'))).toBeLessThan(calls.findIndex((w) => w.includes('enroll')));
    expect(step('enrol').at(-1)).toMatchObject({ status: 'ok', detail: 'joined this fleet', raw: expect.stringMatching(/; svall-gateway\.service is stopped and removed$/) });
    expect(events.map((e) => e.step)).not.toContain('fleet');
  });

  it('enrols a fleet home there that already serves this Mac as a worker again, with a new token', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(ssh.remoteCalls().filter((w) => w.includes('enroll'))).toHaveLength(1);
    expect(tokenFor(resolvePaths(fleet), REMOTE)).toBeDefined();
  });

  it('fails the probe on a daemon that answers from another release than the one installed, and registers nothing', async () => {
    healthy();
    const d = await daemon({ release: () => '1.2.2' });
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    await d.close();
    expect(out.result).toBe('actions');
    // the row says which release answered, which is all there is to say
    expect(step('probe').at(-1)).toEqual({ step: 'probe', status: 'fail', detail: 'answers from 1.2.2, not 1.2.3' });
    expect(step('registry')).toEqual([]);
    expect(registry.get('trift')).toBeUndefined();
  });

  /** A far setup of 1.2.3 whose new daemon did not answer: it goes back to 1.2.2, and still exits 0. */
  async function wentBack(registry: MachineRegistry, runs?: (release: string) => void) {
    ssh.reply(['setup'], {
      stdout: [
        'release 1.2.3 installed', 'systemctl --user restart svall-svalld@private.service',
        `the private fleet's daemon did not answer: current -> ${BASE}/releases/1.2.2`,
        'systemctl --user restart svall-svalld@private.service',
      ].join('\n') + '\n',
    });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.2', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    healthy();
    const d = await daemon({ release: () => '1.2.2' });
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.2', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry, ...(runs && { runs }) }));
    await d.close();
    return out;
  }

  it('stops at identity over an install whose setup went back to the release it ran, naming that release, and registers nothing', async () => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const runs = vi.fn();
    const out = await wentBack(registry, runs);
    // the release it went back to is the one it runs, for a name already in the registry to keep
    expect(runs.mock.calls).toEqual([['1.2.2']]);
    const action = 'ssh trift.test and read the daemon log; trift runs release 1.2.2, the one its setup went back to; then add the machine again';
    expect(out).toEqual({ result: 'actions', actions: [action], stopped: 'identity' });
    expect(step('identity').at(-1)).toEqual({
      step: 'identity', status: 'fail',
      detail: 'trift runs release 1.2.2, not 1.2.3: its setup went back, as the daemon of 1.2.3 did not answer', action,
    });
    expect(step('registry')).toEqual([]);
    expect(registry.get('trift')).toBeUndefined();
  });

  it('writes the registry record under the machine id the companion reports', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const registry = MachineRegistry.load(path.join(work, 'config'));
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    await d.close();

    const entry = registry.get('trift');
    expect(entry?.id).toBe(REMOTE);
    expect(entry?.record).toEqual({
      name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
      home: HOME, svallBase: BASE,
    });
  });

  it('never lets the companion token out in an event', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    await d.close();
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it('runs one interactive ssh before any batch command', async () => {
    const seen: string[] = [];
    healthy();
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({
      interactiveSsh: (destination) => { seen.push(destination); return Promise.resolve({ code: 0, stderr: '' }); },
    }));
    expect(seen).toEqual(['trift.test']);
  });

  it('names what ssh said when the interactive login fails, and the Terminal run that settles it', async () => {
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({
      interactiveSsh: () => Promise.resolve({ code: 255, stderr: 'Host key verification failed.' }),
    }));
    expect(out.result).toBe('actions');
    expect(step('ssh').at(-1)).toEqual({
      step: 'ssh', status: 'fail', detail: 'this Mac cannot log in to trift.test', raw: 'ssh trift.test exited 255: Host key verification failed.',
      action: 'run ssh trift.test once in Terminal and answer its host key and login there, then add the machine again',
    });
    events.length = 0;
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ interactiveSsh: () => Promise.resolve({ code: 255, stderr: 'ssh: connect to host trift.test port 22: Connection refused' }) }));
    expect(step('ssh').at(-1)).toMatchObject({ detail: 'trift.test is not reachable from this Mac' });
  });

  it('refuses an unsigned archive unless the user asked for one', async () => {
    healthy();
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive({ signed: false }) }, deps());
    expect(step('release').at(-1)).toMatchObject({ status: 'fail' });
    expect(step('release').at(-1)?.detail).toContain('--allow-unsigned');
    expect(out.result).toBe('actions');
  });

  it('refuses an archive this controller\'s signers do not vouch for before anything is uploaded', async () => {
    healthy();
    const intruder = ephemeralSigner(work);
    const release = companionArchive(work, { signedBy: intruder.key, signersInside: intruder.signers });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release }, deps());
    expect(step('release').at(-1)).toMatchObject({ status: 'fail' });
    expect(ssh.remoteCalls().some((w) => w.includes('cat > "$1"') || w.includes('setup'))).toBe(false);
    expect(out.result).toBe('actions');
  });

  it('refuses an archive that speaks another protocol', async () => {
    healthy();
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive({ protocol: PROTOCOL_VERSION + 1 }) }, deps());
    expect(step('release').at(-1)?.detail).toContain('protocol');
    expect(out.result).toBe('actions');
  });

  it('installs the workspace companion an unsigned development build pins, with no flag from the app', async () => {
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const companion = archive({ signed: false });
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(companion)).digest('hex');
    fs.mkdirSync(path.join(work, 'release'), { recursive: true });
    fs.writeFileSync(path.join(work, 'release', 'release.json'), JSON.stringify({
      version: '1.2.3', unsigned: true, companions: { 'linux-arm64': { url: pathToFileURL(companion).href, sha256 } },
    }));
    const out = await addHost({ name: 'trift', ssh: 'trift.test' }, deps());
    await d.close();
    expect(step('release').at(-1)).toMatchObject({ status: 'ok', detail: '1.2.3', raw: expect.stringContaining('(unsigned)') });
    expect(ssh.remoteCalls().find((w) => w.includes('setup'))).toContain('--allow-unsigned');
    expect(out.result).toBe('ready');
  });

  it('holds a signed build\'s pinned companion to a signature', async () => {
    healthy();
    const companion = archive({ signed: false });
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(companion)).digest('hex');
    fs.mkdirSync(path.join(work, 'release'), { recursive: true });
    fs.writeFileSync(path.join(work, 'release', 'release.json'), JSON.stringify({
      version: '1.2.3', companions: { 'linux-arm64': { url: pathToFileURL(companion).href, sha256 } },
    }));
    const out = await addHost({ name: 'trift', ssh: 'trift.test' }, deps());
    expect(step('release').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining('--allow-unsigned') });
    expect(out.result).toBe('actions');
  });

  it('refuses to guess a companion when the release manifest names none', async () => {
    healthy();
    fs.mkdirSync(path.join(work, 'release'), { recursive: true });
    fs.writeFileSync(path.join(work, 'release', 'release.json'), JSON.stringify({ version: '1.2.3' }));
    const out = await addHost({ name: 'trift', ssh: 'trift.test' }, deps());
    expect(step('release').at(-1)?.detail).toContain('--release');
    expect(out.result).toBe('actions');
  });

  it('reports a machine it cannot reach as unreachable', async () => {
    const out = await addHost({ name: 'trift', ssh: 'refused.test', release: archive() }, deps());
    expect(step('master').at(-1)).toMatchObject({ status: 'fail', detail: 'trift is not reachable from this Mac', action: 'check that it is on and on Tailscale', raw: expect.stringContaining('refused.test') });
    expect(out.result).toBe('actions');
  });

  it('says ssh refused a login without a prompt, and names how to give it a key, when the control master is refused', async () => {
    const out = await addHost({ name: 'trift', ssh: 'denied.test', release: archive() }, deps());
    // the keychain holds a passphrase only on a Mac
    const keychain = process.platform === 'darwin' ? ', keep its passphrase in the keychain with ssh-add --apple-use-keychain and add UseKeychain yes and AddKeysToAgent yes to ~/.ssh/config so ssh still finds it after a restart' : '';
    const action = `install a key there with ssh-copy-id denied.test${keychain}, then add the machine again`;
    expect(step('master').at(-1)).toEqual({ step: 'master', status: 'fail', detail: 'this Mac cannot log in to trift', action, raw: expect.stringContaining('denied.test') });
    expect(out.actions).toEqual([action]);
  });

  it('re-runs the probes for a machine already in the registry and keeps one record', async () => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const run = async () => {
      events.length = 0;
      healthy();
      const d = await daemon();
      ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
      const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
      await d.close();
      return out;
    };
    expect((await run()).result).toBe('ready');
    expect((await run()).result).toBe('ready');
    expect(registry.list().filter((m) => m.record.name === 'trift')).toHaveLength(1);
    expect(registry.get('trift')?.id).toBe(REMOTE);
  });

  it('refuses a second ssh destination for a name already in the registry', async () => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({
      name: 'trift', ssh: 'other.test', platform: 'linux', arch: 'arm64',
      home: HOME, svallBase: BASE,
    }, REMOTE);
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    expect(step('name').at(-1)).toMatchObject({ status: 'fail' });
    expect(step('name').at(-1)?.detail).toContain('other.test');
    expect(out.result).toBe('actions');
    expect(ssh.calls()).toEqual([]);
  });

  it('refuses the name of a worker that dials in, which has no ssh destination either, before any ssh', async () => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.put(REMOTE, { name: 'ada-mac', platform: 'darwin', arch: 'arm64', home: HOME, svallBase: BASE, dial: 'worker' });
    await addHost({ name: 'ada-mac', ssh: 'ada.test', release: archive() }, deps({ registry }));
    expect(step('name').at(-1)).toMatchObject({ status: 'fail', detail: 'ada-mac is a worker that dials in; remove it first or add this one under another name' });
    expect(ssh.calls()).toEqual([]);
  });

  it("refuses this Mac's own name, which has no ssh destination, before any ssh", async () => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({ name: 'studio', platform: 'darwin', arch: 'arm64', home: '/Users/linus', svallBase: '/Users/linus/.svall' }, MAC);
    const out = await addHost({ name: 'studio', ssh: 'trift.test', release: archive() }, deps({ registry }));
    expect(step('name').at(-1)).toMatchObject({ status: 'fail', detail: "studio is this Mac's name; add the machine under another name" });
    expect(out.result).toBe('actions');
    expect(ssh.calls()).toEqual([]);
  });

  describe('again for a name in the registry', () => {
    const listed = (registry: MachineRegistry, home = HOME): void => {
      registry.add({ name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64', home, svallBase: `${home}/.local/share/svall` }, REMOTE);
    };

    it('installs nothing on a machine that answers as another than the registry names, and keeps its record', async () => {
      const registry = MachineRegistry.load(path.join(work, 'config'));
      listed(registry);
      ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: OTHER_MAC }, null, 2) });
      healthy();
      const d = await daemon();
      ssh.answer({ fleetId: FLEET, machineId: OTHER_MAC, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
      const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
      await d.close();
      expect(out.result).toBe('actions');
      expect(step('master').at(-1)).toMatchObject({
        status: 'fail', detail: 'trift.test now reaches another machine than trift', raw: `trift.test now reaches machine ${OTHER_MAC}, not trift (${REMOTE})`,
        action: 'point trift.test back at trift, or svall host remove trift --forget',
      });
      expect(ssh.remoteCalls().some((w) => w.includes('cat > "$1"') || w.includes('setup'))).toBe(false);
      expect(registry.list().filter((m) => m.record.name === 'trift').map((m) => m.id)).toEqual([REMOTE]);
    });

    it('stops at identity on a machine with no svall to ask that installs as another, and keeps its record', async () => {
      const far = path.join(work, 'far');
      const base = `${far}/.local/share/svall`;
      // this Mac's home is the far one, so the paths host add builds from it land in the far machine's
      const config = path.join(work, 'config');
      const file = path.join(config, 'machines.json');
      const { localId } = MachineRegistry.load(config);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { machines: Record<string, { home: string }> };
      saved.machines[localId].home = far;
      fs.writeFileSync(file, JSON.stringify(saved));
      const registry = MachineRegistry.load(config);
      listed(registry, far);
      for (const [match, stdout] of [
        [['uname', '-sm'], 'Linux aarch64\n'], [['cat', '/etc/os-release'], OS_RELEASE], [['svall-home'], `${far}\nlinus\n`],
        [['svall-tools'], ['tailscale', 'git', 'systemctl', 'loginctl'].map((t) => `${t} yes\n`).join('')],
        [['svall-tmux-version'], OWN_TMUX], [['svall-space'], DF], [['svall-linger'], 'Linger=yes\n'],
      ] as [string[], string][]) ssh.reply(match, { stdout });
      for (const bin of ['claude', 'codex', 'opencode']) ssh.reply([bin], { code: 127 });
      ssh.execute({});
      const svall = `#!/bin/sh
case "$1" in
  version) printf '%s\\n' '${JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: OTHER_MAC })}' ;;
  doctor) printf '%s\\n' '${DOCTOR}' ;;
  setup) mkdir -p '${base}' && tar -xzf "$3" -C '${base}' && ln -sfn '${base}/releases/1.2.3' '${base}/current' ;;
esac
`;
      const out = await addHost({ name: 'trift', ssh: 'trift.test', release: companionArchive(work, { signedBy: signer.key, svall }) }, deps({ registry }));
      expect(out.result).toBe('actions');
      expect(step('master').at(-1)).toMatchObject({ status: 'ok' });
      expect(step('identity').at(-1)).toEqual({
        step: 'identity', status: 'fail', detail: 'trift.test now reaches another machine than trift', raw: `machine ${OTHER_MAC}, not ${REMOTE}`,
        action: 'point trift.test back at trift, or svall host remove trift --forget and add it again',
      });
      expect(registry.list().filter((m) => m.record.name === 'trift').map((m) => m.id)).toEqual([REMOTE]);
    });

    it('stops at identity when its setup went back to the release the machine ran, naming that release, and keeps its record', async () => {
      const registry = MachineRegistry.load(path.join(work, 'config'));
      listed(registry);
      const out = await wentBack(registry);
      const action = 'ssh trift.test and read the daemon log; trift runs release 1.2.2, the one its setup went back to; then svall host upgrade trift, or add the machine again';
      expect(out).toEqual({ result: 'actions', actions: [action], stopped: 'identity' });
      expect(step('identity').at(-1)).toMatchObject({ status: 'fail', action });
      expect(step('registry')).toEqual([]);
      expect(registry.list().filter((m) => m.record.name === 'trift').map((m) => m.id)).toEqual([REMOTE]);
    });
  });
});

describe('one add or upgrade of a machine at a time', () => {
  const BUSY = { status: 'fail', detail: 'trift is being added or upgraded by another run', action: 'try again once it ends' };
  const unreachable = { interactiveSsh: () => Promise.resolve({ code: 255, stderr: 'no route' }) };

  it('refuses a second run while another holds the machine, before it reaches it, and lets the next one through once it ends', async () => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const unlock = (await hostLock(registry.dir, 'trift'))!;
    const added = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry, ...unreachable }));
    expect(added.stopped).toBe('name');
    expect(step('name').at(-1)).toMatchObject(BUSY);
    registry.add({ name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64', home: HOME, svallBase: BASE }, REMOTE);
    const upgraded = await upgradeHost('trift', { release: archive() }, deps({ registry }));
    expect(upgraded.stopped).toBe('machine');
    expect(step('machine').at(-1)).toMatchObject(BUSY);
    expect(ssh.calls()).toEqual([]);
    unlock();
    events.length = 0;
    // a run that ended, however far it got, holds the machine no longer
    expect((await upgradeHost('trift', { release: archive() }, deps({ registry }))).stopped).not.toBe('machine');
    const free = await hostLock(registry.dir, 'trift');
    expect(free).toBeDefined();
    free?.();
  });

  it('refuses a rollback or a remove of a machine another run holds, before it reaches or changes anything', async () => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({ name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64', home: HOME, svallBase: BASE }, REMOTE);
    registry.save();
    issueToken(resolvePaths(fleet), REMOTE);
    const unlock = (await hostLock(registry.dir, 'trift'))!;
    try {
      expect((await rollbackHost('trift', {}, deps({ registry }))).stopped).toBe('machine');
      expect(step('machine').at(-1)).toMatchObject(BUSY);
      events.length = 0;
      expect((await removeHost('trift', {}, deps({ registry }))).stopped).toBe('machine');
      expect(step('machine').at(-1)).toMatchObject(BUSY);
      expect(ssh.calls()).toEqual([]);
      expect(registry.get('trift')).toBeDefined();
      expect(tokenFor(resolvePaths(fleet), REMOTE)).toBeDefined();
    } finally { unlock(); }
    // and each lets it go as it ends
    await rollbackHost('trift', {}, deps({ registry }));
    await removeHost('trift', { forget: true }, deps({ registry }));
    const free = await hostLock(registry.dir, 'trift');
    expect(free).toBeDefined();
    free?.();
  });

  it('holds one machine by its name, and leaves another free', async () => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const unlock = (await hostLock(registry.dir, 'trift'))!;
    try {
      const other = await hostLock(registry.dir, 'box');
      expect(other).toBeDefined();
      other?.();
      expect((await addHost({ name: 'box', ssh: 'box.test', release: archive() }, deps({ registry, ...unreachable }))).stopped).toBe('ssh');
    } finally { unlock(); }
  });

  it('lets the machine go when the run holding it dies', async () => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const script = path.join(work, 'hold-machine.mts');
    fs.writeFileSync(script, [
      `import { hostLock } from ${JSON.stringify(path.join(import.meta.dirname, '../../svalld/src/kernel-lock.ts'))};`,
      `process.stdout.write((await hostLock(${JSON.stringify(registry.dir)}, 'trift')) ? 'held\\n' : 'busy\\n');`,
      'setInterval(() => undefined, 1000);',
    ].join('\n'));
    const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: path.resolve(import.meta.dirname, '../../..'), stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise((resolve) => { child.on('close', resolve); });
    try {
      const said = await new Promise<string>((resolve, reject) => {
        child.stdout.on('data', (b: Buffer) => resolve(b.toString()));
        setTimeout(() => reject(new Error('the holder said nothing')), 15_000);
      });
      expect(said).toBe('held\n');
      expect((await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry, ...unreachable }))).stopped).toBe('name');
    } finally { child.kill('SIGKILL'); }
    await exited;
    events.length = 0;
    expect((await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry, ...unreachable }))).stopped).toBe('ssh');
    expect(step('name').at(-1)?.status).toBe('ok');
    // and that run, ended, holds it no longer
    const free = await hostLock(registry.dir, 'trift');
    expect(free).toBeDefined();
    free?.();
  }, 30_000);
});
