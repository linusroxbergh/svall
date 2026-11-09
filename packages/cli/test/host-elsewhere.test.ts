import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@svall/protocol';
import { createMarker } from '@svall/svalld/fleet/home-move';
import { resolvePaths } from '@svall/svalld/paths';
import { issueToken, tokenFor } from '@svall/svalld/placement/workers';
import { addHost, doctorHost, removeHost, upgradeHost } from '../src/controller/host.js';
import { MachineRegistry } from '../src/controller/registry.js';
import { SshMaster } from '../src/controller/ssh.js';
import { FLEET, MAC, OTHER_FLEET, OTHER_MAC, REMOTE, TOKEN, archive, daemon, deps, fleet, healthy, ssh, step, useHostWorld, work } from './controller/host-world.js';

useHostWorld();

const NEW_HOME = { homeMachineId: OTHER_MAC, homeName: 'real-home', fleetId: FLEET };
const SERVES_US = { homeMachineId: MAC, homeName: 'studio', fleetId: FLEET };

// a machine that joined as a worker once the fleet moved, with no route of its own to the new home
const joined = () => fs.writeFileSync(resolvePaths(fleet).workerFile, JSON.stringify({ ...NEW_HOME, token: 'b'.repeat(48) }));
const marked = () => createMarker(resolvePaths(fleet), { id: 'hm_abcdefghij' as never, fleetId: FLEET as never, from: MAC as never, fromName: 'studio', fromHome: '/home/ada' as never, to: OTHER_MAC as never, toName: 'real-home', toHome: '/home/ada' as never, at: 1, keySha256: 'a'.repeat(64) });

const serving = (worker: object) => ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, worker }) });
const enrols = () => ssh.remoteCalls().filter((w) => w.includes('enroll'));

function listed(): MachineRegistry {
  const registry = MachineRegistry.load(path.join(work, 'config'));
  registry.add({ name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64', home: '/home/linus', svallBase: '/home/linus/.local/share/svall' }, REMOTE);
  return registry;
}

// a far machine whose own svall and worker.json answer, for what the uninstall reads there
function farMachine(worker: object): MachineRegistry {
  ssh.clearReplies();
  const far = path.join(work, 'far');
  const base = `${far}/.local/share/svall`;
  fs.mkdirSync(`${base}/current/bin`, { recursive: true });
  fs.writeFileSync(`${base}/current/bin/svall`, `#!/bin/sh\ncase "$1" in version) printf '%s\\n' '${JSON.stringify({ machineId: REMOTE }, null, 2)}' ;; uninstall) echo removed ;; esac\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(far, '.svall'), { recursive: true });
  fs.writeFileSync(path.join(far, '.svall', 'worker.json'), JSON.stringify({ ...worker, token: TOKEN }));
  const registry = MachineRegistry.load(path.join(work, 'config'));
  registry.add({ name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64', home: far, svallBase: base }, REMOTE);
  ssh.execute({});
  return registry;
}

const JOINED = { detail: "this fleet's home is real-home, and only it takes or removes a worker", action: 'run it on real-home' };
const MARKED = { detail: 'this home is leaving for real-home, and takes or removes no worker until the move ends', action: 'finish the move with svall fleet home retry, or call it off with svall fleet home abort' };

describe.each([['a worker of this fleet now', joined, JOINED], ['marked for a move', marked, MARKED]])('a machine that is %s', (_what, leave, words) => {
  it('takes no worker, and says so of this machine before it reaches any', async () => {
    leave();
    for (const worker of [NEW_HOME, undefined]) {
      ssh.clearReplies();
      if (worker) serving(worker);
      healthy();
      const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry: MachineRegistry.load(path.join(work, 'config')) }));
      expect(out.stopped).toBe('name');
      expect(step('name').at(-1)).toMatchObject({ status: 'fail', ...words });
      expect(ssh.calls()).toEqual([]);
      expect(tokenFor(resolvePaths(fleet), REMOTE as never)).toBeUndefined();
    }
  });

  it('upgrades none of the machines it lists, before it reaches one', async () => {
    leave();
    serving(NEW_HOME);
    healthy();
    const out = await upgradeHost('trift', { release: archive() }, deps({ registry: listed() }));
    expect(out.stopped).toBe('machine');
    expect(step('machine').at(-1)).toMatchObject({ status: 'fail', ...words });
    expect(ssh.calls()).toEqual([]);
  });

  it('uninstalls none, whichever home it names', async () => {
    for (const worker of [NEW_HOME, { homeMachineId: MAC, homeName: 'studio', fleetId: FLEET }]) {
      leave();
      const registry = farMachine(worker);
      const out = await removeHost('trift', {}, deps({ registry }));
      expect(out.stopped).toBe('uninstall');
      expect(step('uninstall').at(-1)).toMatchObject(words);
      expect(ssh.remoteCalls().filter((w) => w.includes('uninstall'))).toEqual([]);
      expect(registry.get('trift')).toBeDefined();
      fs.rmSync(resolvePaths(fleet).workerFile, { force: true });
      fs.rmSync(resolvePaths(fleet).homeMoving, { force: true });
      registry.remove(REMOTE as never);
      registry.save();
    }
  });
});

describe('a worker of this fleet now', () => {
  it('upgrades the home it serves all the same, as that is this fleet\'s home', async () => {
    joined();
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({ name: 'real-home', ssh: 'real-home.test', platform: 'linux', arch: 'arm64', home: '/home/linus', svallBase: '/home/linus/.local/share/svall' }, OTHER_MAC);
    await upgradeHost('real-home', { release: archive() }, deps({ registry }));
    expect(step('machine').at(-1)?.status).toBe('ok');
    expect(step('master')).not.toEqual([]);
  });

  it('whose worker.json cannot be read takes no worker either', async () => {
    fs.writeFileSync(resolvePaths(fleet).workerFile, '{ not json');
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps());
    expect(out.stopped).toBe('name');
    expect(step('name').at(-1)).toMatchObject({ detail: expect.stringContaining('this machine cannot tell whether it holds this fleet'), action: `fix ${resolvePaths(fleet).workerFile}` });
  });

  it('knows a worker of its fleet by the id its worker.json names, whatever its own fleet.json says', async () => {
    joined();
    fs.writeFileSync(path.join(fleet, 'fleet.json'), JSON.stringify({ id: OTHER_FLEET }));
    const registry = farMachine(NEW_HOME);
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(out.stopped).toBe('uninstall');
    expect(step('uninstall').at(-1)).toMatchObject(JOINED);
  });
});

describe('the fleet\'s home', () => {
  it('takes a worker of the fleet that still names the home the fleet left', async () => {
    serving(NEW_HOME);
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry: MachineRegistry.load(path.join(work, 'config')) }));
    await d.close();
    expect(step('enrol').at(-1)?.status).toBe('ok');
    expect(enrols()).toHaveLength(1);
    expect(enrols()[0]).toContain(MAC);
  });

  it('does not take one of another fleet, and its doctor says so on the worker row', async () => {
    serving({ homeMachineId: OTHER_MAC, homeName: 'bea', fleetId: 'f5a7a7a7-0000-4000-8000-000000000000' });
    healthy();
    const report = await doctorHost('trift', deps({ registry: listed() }));
    expect(report.checks.find((c) => c.name === 'worker')).toMatchObject({ status: 'fail', detail: expect.stringContaining('already serves bea') });
  });

  it('a doctor of one that names the home the fleet left has nothing to say of it', async () => {
    serving(NEW_HOME);
    healthy();
    const report = await doctorHost('trift', deps({ registry: listed() }));
    expect(report.checks.find((c) => c.name === 'worker')?.detail ?? '').not.toContain('already serves');
  });

  it('a person\'s add takes no worker while a move\'s enrol holds the lock: no token issued, none sent', async () => {
    const { enrolLock } = await import('@svall/svalld/kernel-lock');
    const paths = resolvePaths(fleet);
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const held = await enrolLock(paths.home);
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry: MachineRegistry.load(path.join(work, 'config')) }));
    held?.();
    await d.close();
    expect(step('enrol').at(-1)).toMatchObject({ status: 'fail', detail: 'this home is enrolling a worker, or moving the fleet', action: 'try again in a moment' });
    expect(enrols()).toEqual([]);
    expect(tokenFor(paths, REMOTE as never)).toBeUndefined();
  });

  it('a forget waits for no one once it holds the lock, and refuses while a move\'s enrol holds it', async () => {
    const { enrolLock } = await import('@svall/svalld/kernel-lock');
    const paths = resolvePaths(fleet);
    const registry = listed();
    issueToken(paths, REMOTE as never);
    const held = await enrolLock(paths.home);
    const busy = await removeHost('trift', { forget: true }, deps({ registry }));
    expect(busy.stopped).toBe('machine');
    expect(step('machine').at(-1)).toMatchObject({ status: 'fail', detail: 'this home is enrolling a worker, or moving the fleet', action: 'try again in a moment' });
    expect(tokenFor(paths, REMOTE as never)).toBeDefined();
    expect(registry.get('trift')).toBeDefined();
    held?.();
    expect((await removeHost('trift', { forget: true }, deps({ registry }))).result).toBe('ready');
    expect(tokenFor(paths, REMOTE as never)).toBeUndefined();
  });

  it('a remove while an enrol holds the lock changes nothing there or here: no uninstall, the route and the token kept', async () => {
    const { enrolLock } = await import('@svall/svalld/kernel-lock');
    const paths = resolvePaths(fleet);
    const registry = farMachine(SERVES_US);
    issueToken(paths, REMOTE as never);
    const held = await enrolLock(paths.home);
    const busy = await removeHost('trift', {}, deps({ registry }));
    held?.();
    expect(busy.stopped).toBe('machine');
    expect(step('machine').at(-1)).toMatchObject({ status: 'fail', detail: 'this home is enrolling a worker, or moving the fleet' });
    expect(ssh.calls()).toEqual([]);
    expect(tokenFor(paths, REMOTE as never)).toBeDefined();
    expect(registry.get('trift')).toBeDefined();
  });

  it('a remove holds the lock from before its uninstall until the token is gone, and lets go as it ends', async () => {
    const { enrolLock } = await import('@svall/svalld/kernel-lock');
    const paths = resolvePaths(fleet);
    const registry = farMachine(SERVES_US);
    issueToken(paths, REMOTE as never);
    let free: boolean | undefined;
    const openMaster = async (destination: string) => {
      const master = await SshMaster.open({ destination, socketDir: ssh.socketDir });
      const run = master.run.bind(master);
      master.run = async (argv, o) => {
        if (argv.includes('uninstall')) { const got = await enrolLock(paths.home); got?.(); free = got !== undefined; }
        return run(argv, o);
      };
      return master;
    };
    const out = await removeHost('trift', {}, deps({ registry, openMaster }));
    expect(out.result).toBe('ready');
    expect(free).toBe(false);
    expect(tokenFor(paths, REMOTE as never)).toBeUndefined();
    const after = await enrolLock(paths.home);
    expect(after).toBeDefined();
    after?.();
  });
});
