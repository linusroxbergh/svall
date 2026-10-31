import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@svall/protocol';
import { resolvePaths } from '@svall/svalld/paths';
import { tokenFor } from '@svall/svalld/placement/workers';
import { addHost } from '../src/controller/host.js';
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
      'svall version', 'mkdir -p', 'cat > "$1"', 'mkdir -p', 'PATH=/usr/bin:/bin:/', 'svall setup', 'rm -rf',
      'sh -c', 'svall doctor', 'svall version', '[ -f "$1/$2" ] && ec', 'svall version', 'svall worker',
      'claude --version', 'claude auth', 'codex --version', 'codex login', 'opencode --version', 'opencode auth',
      'svall connection-info', 'svall version', 'sh -c',
    ]);
    expect(step('versions').at(-1)).toMatchObject({ status: 'ok', detail: 'claude 2.1.278, codex 0.156.1, opencode 2.0.22, as on this Mac' });
    expect(step('probe').at(-1)).toMatchObject({ status: 'ok', detail: 'trift answers on its own private fleet, serves this fleet as a worker, and tmux opens and closes a window there' });
    expect(step('release').at(-1)?.detail).toMatch(/^1\.2\.3 for linux-arm64 from the archive you named \(signed\)$/);
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
    expect(ssh.remoteCalls().find((w) => w.includes('enroll'))).toEqual([SVALL, 'worker', 'enroll', '--home-machine', MAC, '--home-name', mac, '--fleet-id', FLEET]);
    // worker.json there takes, on its stdin, the token this fleet's daemon opens the link with
    expect(fs.readFileSync(input, 'utf8')).toBe(tokenFor(resolvePaths(fleet), REMOTE));
    expect(step('enrol').at(-1)).toEqual({ step: 'enrol', status: 'ok', detail: `trift serves this fleet as a worker of ${mac}; systemctl --user restart svall-svalld@private.service` });
    expect(ssh.remoteCalls().some((w) => w.includes('gateway'))).toBe(false);
    // this fleet's daemon links it without waiting for its next start
    expect(refreshed).toBe(1);
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
      [['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }) }, 'trift does not serve this fleet as a worker'],
      [['svall-tmux'], { stderr: 'error connecting to /tmp/svall-probe (No such file or directory)\n', code: 1 }, 'tmux could not open a window'],
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
      expect(step('probe').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining(said) });
      expect(registry.get('trift')).toBeUndefined();
    }
  });

  it('uploads and enrols nothing over a fleet home there that serves another Mac as a worker, and registers nothing', async () => {
    const action = 'on bea-mbp, run svall host remove trift';
    const worker = { homeMachineId: OTHER_MAC, homeName: 'bea-mbp', fleetId: OTHER_FLEET };
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, worker }) });
    healthy();
    const registry = MachineRegistry.load(path.join(work, 'config'));
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry }));
    expect(out).toEqual({ result: 'actions', stopped: 'release', actions: [action] });
    expect(step('release').at(-1)).toEqual({ step: 'release', status: 'fail', detail: 'trift already serves bea-mbp as a worker; remove it from that Mac first', action });
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
    expect(step('enrol').at(-1)).toMatchObject({ status: 'ok', detail: expect.stringMatching(/; svall-gateway\.service is stopped and removed$/) });
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
    expect(step('probe').at(-1)).toMatchObject({ status: 'fail', detail: 'trift answers from release 1.2.2, not 1.2.3' });
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
      step: 'ssh', status: 'fail', detail: 'ssh trift.test exited 255: Host key verification failed.',
      action: 'run ssh trift.test once in Terminal and answer its host key and login there, then add the machine again',
    });
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
    expect(step('release').at(-1)).toMatchObject({ status: 'ok', detail: expect.stringContaining('(unsigned)') });
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
    expect(step('master').at(-1)).toMatchObject({ status: 'fail' });
    expect(step('master').at(-1)?.detail).toContain('refused.test');
    expect(step('master').at(-1)?.action).toBe('ssh refused.test and see what it answers');
    expect(out.result).toBe('actions');
  });

  it('says ssh refused a login without a prompt, and names how to give it a key, when the control master is refused', async () => {
    const out = await addHost({ name: 'trift', ssh: 'denied.test', release: archive() }, deps());
    const action = 'install a key there with ssh-copy-id denied.test, keep its passphrase in the keychain with ssh-add --apple-use-keychain and add UseKeychain yes and AddKeysToAgent yes to ~/.ssh/config so ssh still finds it after a restart, then add the machine again';
    expect(step('master').at(-1)).toEqual({
      step: 'master', status: 'fail',
      detail: 'ssh refused the login to denied.test: every step from here logs in without a password or passphrase prompt', action,
    });
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
        status: 'fail', detail: `trift.test now reaches machine ${OTHER_MAC}, not trift (${REMOTE})`,
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
        step: 'identity', status: 'fail', detail: `trift.test now reaches machine ${OTHER_MAC}, not trift (${REMOTE})`,
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
