import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@svall/protocol';
import { createMarker } from '@svall/svalld/fleet/home-move';
import { resolvePaths } from '@svall/svalld/paths';
import { issueToken, tokenFor } from '@svall/svalld/placement/workers';
import { addHost, doctorHost, removeHost, upgradeHost } from '../src/controller/host.js';
import { MachineRegistry } from '../src/controller/registry.js';
import { FLEET, MAC, OTHER_MAC, REMOTE, TOKEN, archive, daemon, deps, fleet, healthy, ssh, step, useHostWorld, work } from './controller/host-world.js';

useHostWorld();

const NEW_HOME = { homeMachineId: OTHER_MAC, homeName: 'real-home', fleetId: FLEET };

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

describe.each([['a worker of this fleet now', joined], ['marked for a move', marked]])('a machine that is %s', (_what, leave) => {
  it('takes no worker of the fleet that still names the home it left', async () => {
    leave();
    serving(NEW_HOME);
    healthy();
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry: MachineRegistry.load(path.join(work, 'config')) }));
    expect(out.result).toBe('actions');
    expect(step('release').at(-1)).toMatchObject({ status: 'fail', detail: 'trift is a worker of this fleet, whose home is real-home: only that machine takes or removes it' });
    expect(enrols()).toEqual([]);
    expect(tokenFor(resolvePaths(fleet), REMOTE as never)).toBeUndefined();
  });

  it('takes none on an upgrade either', async () => {
    leave();
    serving(NEW_HOME);
    healthy();
    const out = await upgradeHost('trift', { release: archive() }, deps({ registry: listed() }));
    expect(out.result).toBe('actions');
    expect(enrols()).toEqual([]);
  });

  it('uninstalls none, whichever home it names', async () => {
    for (const worker of [NEW_HOME, { homeMachineId: MAC, homeName: 'studio', fleetId: FLEET }]) {
      leave();
      const registry = farMachine(worker);
      const out = await removeHost('trift', {}, deps({ registry }));
      expect(out.stopped).toBe('uninstall');
      expect(step('uninstall').at(-1)?.detail).toContain('only that machine takes or removes it');
      expect(ssh.remoteCalls().filter((w) => w.includes('uninstall'))).toEqual([]);
      expect(registry.get('trift')).toBeDefined();
      fs.rmSync(resolvePaths(fleet).workerFile, { force: true });
      fs.rmSync(resolvePaths(fleet).homeMoving, { force: true });
      registry.remove(REMOTE as never);
      registry.save();
    }
  });

  it('enrols nothing it finds no worker on', async () => {
    leave();
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE }) });
    healthy();
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    await addHost({ name: 'trift', ssh: 'trift.test', release: archive() }, deps({ registry: MachineRegistry.load(path.join(work, 'config')) }));
    await d.close();
    expect(step('enrol').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining('only that machine takes or removes it') });
    expect(enrols()).toEqual([]);
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

  it('a forget waits for no one once it holds the lock, and refuses while a move\'s enrol holds it', async () => {
    const { enrolLock } = await import('@svall/svalld/kernel-lock');
    const paths = resolvePaths(fleet);
    const registry = listed();
    issueToken(paths, REMOTE as never);
    const held = await enrolLock(paths.home);
    const busy = await removeHost('trift', { forget: true }, deps({ registry }));
    expect(busy.stopped).toBe('registry');
    expect(step('registry').at(-1)).toMatchObject({ status: 'fail', detail: 'this home is enrolling a worker already' });
    expect(tokenFor(paths, REMOTE as never)).toBeDefined();
    expect(registry.get('trift')).toBeDefined();
    held?.();
    expect((await removeHost('trift', { forget: true }, deps({ registry }))).result).toBe('ready');
    expect(tokenFor(paths, REMOTE as never)).toBeUndefined();
  });
});
