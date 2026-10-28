import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, emptyState } from '@svall/protocol';
import { resolvePaths } from '@svall/svalld/paths';
import { removeHost } from '../src/controller/host.js';
import { MachineRegistry } from '../src/controller/registry.js';
import { BASE, FLEET, HOME, MAC, OTHER_MAC, REMOTE, SVALL, deps, events, fleet, ssh, step, useHostWorld, work } from './controller/host-world.js';

useHostWorld();

describe('host remove', () => {
  const registered = (destination: string): MachineRegistry => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({
      name: 'trift', ssh: destination, platform: 'linux', arch: 'arm64',
      home: HOME, svallBase: BASE,
    }, REMOTE);
    return registry;
  };

  it('uninstalls nothing while a robot of a fleet here is on the machine or moving to it, and names them; --forget still drops the route', async () => {
    const ada = {
      id: 'c_ada', islandId: 'i_1', cell: { x: 0, y: 0 }, name: 'ada', portrait: 'fox', note: '', instructions: '', cwd: '/home/ada/app', context: [], shell: { lastOutputAt: 0 }, unread: false,
      machine: REMOTE, placement: { generation: 1 },
    };
    const bo = { ...ada, id: 'c_bo', name: 'bo', cell: { x: 1, y: 0 }, machine: undefined, placement: undefined, moving: { id: 'mv_0123456789', to: REMOTE, phase: 'bundle' } };
    const cy = { ...ada, id: 'c_cy', name: 'cy', cell: { x: 2, y: 0 }, machine: undefined, placement: undefined };
    const state = (robots: object) => fs.writeFileSync(path.join(fleet, 'state.json'), JSON.stringify({ ...emptyState(), robots }));
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');

    state({ c_ada: ada, c_bo: bo, c_cy: cy });
    const many = await removeHost('trift', {}, deps({ registry }));
    expect(many).toEqual({ result: 'actions', stopped: 'machine', actions: ['svall robot move <id> --machine local for each'] });
    expect(step('machine').at(-1)).toMatchObject({ status: 'fail', detail: '2 robots are on trift: ada, bo; move them back first' });
    state({ c_ada: ada, c_cy: cy });
    events.length = 0;
    expect(await removeHost('trift', {}, deps({ registry, fleet: { home: fleet, profile: 'work' } }))).toMatchObject({ actions: ['svall -p work robot move c_ada --machine local'] });
    expect(step('machine').at(-1)).toMatchObject({ status: 'fail', detail: '1 robot is on trift: ada; move it back first' });
    expect(ssh.remoteCalls()).toEqual([]);
    expect(registry.get('trift')).toBeDefined();

    expect((await removeHost('trift', { forget: true }, deps({ registry }))).result).toBe('ready');
    expect(registry.get('trift')).toBeUndefined();
  });

  it("clears the machine's consent in every fleet home here, on remove and on --forget", async () => {
    const second = path.join(work, '.svall-other');
    fs.mkdirSync(second, { recursive: true });
    fs.writeFileSync(resolvePaths(second).fleetConfig, JSON.stringify({ id: FLEET }));
    const files = [resolvePaths(fleet).mirrorConsent, resolvePaths(second).mirrorConsent];
    for (const forget of [false, true]) {
      for (const f of files) fs.writeFileSync(f, JSON.stringify({ [REMOTE]: ['claude:mcp:linear#env.K'], [OTHER_MAC]: ['codex:mcp:g#env.K'] }));
      ssh.reply(['uninstall'], { stdout: 'removed\n' });
      await removeHost('trift', { forget }, deps({ registry: registered('trift.test') }));
      for (const f of files) expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({ [OTHER_MAC]: ['codex:mcp:g#env.K'] });
    }
  });

  it('names the machine on the line the far uninstall ends with, whose rm -rf is for that machine', async () => {
    ssh.reply(['uninstall'], { stdout: `removed ${BASE}/current\nkept ${HOME}/.svall; rm -rf '${HOME}/.svall' deletes them\n` });
    await removeHost('trift', {}, deps({ registry: registered('trift.test') }));
    expect(step('uninstall').at(-1)).toMatchObject({ status: 'ok', detail: `on trift.test: kept ${HOME}/.svall; rm -rf '${HOME}/.svall' deletes them` });
  });

  it('shows what the far uninstall did with the keys the mirror copied there, and ends with what is left to do where it could not take one back or one changed there since', async () => {
    const claudeJson = `${HOME}/.claude.json`;
    const mcp = `${HOME}/.claude/plugins/cache/mp/acme/1.0.0/.mcp.json`;
    ssh.reply(['uninstall'], { stdout: [
      `took 1 key the mirror copied out of ${HOME}/.claude/settings.json`,
      `could not take the mirror's keys back from ${claudeJson}: ${claudeJson} cannot be parsed`,
      `left ${mcp}, which holds keys the mirror copied and changed there since`,
      `removed ${BASE}/current`,
    ].join('\n') });
    const registry = registered('trift.test');
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(events.filter((e) => e.status !== 'start').at(-1)).toMatchObject({
      step: 'keys', status: 'warn', action: 'ssh trift.test, then take the keys the mirror copied out of the files named here, or delete those files',
    });
    expect(step('keys').at(-1)!.detail!.split('; ')).toEqual([
      `took 1 key the mirror copied out of ${HOME}/.claude/settings.json`, `could not take the mirror's keys back from ${claudeJson}: ${claudeJson} cannot be parsed`,
      `left ${mcp}, which holds keys the mirror copied and changed there since`,
    ]);
    expect(out).toMatchObject({ result: 'actions', actions: ['ssh trift.test, then take the keys the mirror copied out of the files named here, or delete those files'] });
    expect(registry.get('trift')).toBeUndefined();
  });

  it('shows the keys the far uninstall took back as done', async () => {
    ssh.reply(['uninstall'], { stdout: `took 1 key the mirror copied out of ${HOME}/.claude.json\nremoved ${BASE}/current\n` });
    expect(await removeHost('trift', {}, deps({ registry: registered('trift.test') }))).toEqual({ result: 'ready', actions: [] });
    expect(step('keys').at(-1)).toMatchObject({ status: 'ok', detail: `took 1 key the mirror copied out of ${HOME}/.claude.json` });
  });

  it('uninstalls nothing on a machine that answers as another than the registry names, as an alias that now leads elsewhere', async () => {
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: OTHER_MAC }, null, 2) });
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(out.result).toBe('actions');
    expect(step('uninstall').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining(`trift.test now reaches machine ${OTHER_MAC}, not trift (${REMOTE})`) });
    expect(ssh.remoteCalls().some((w) => w.includes('uninstall'))).toBe(false);
    expect(registry.get('trift')).toBeDefined();
  });

  it('keeps the route for a machine it cannot reach', async () => {
    const registry = registered('refused.test');
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(out.result).toBe('actions');
    expect(registry.get('trift')).toBeDefined();
    expect(step('uninstall').at(-1)?.action).toContain('--forget');
  });

  it('forgets a machine it could reach without touching it', async () => {
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');
    const out = await removeHost('trift', { forget: true }, deps({ registry }));
    expect(registry.get('trift')).toBeUndefined();
    expect(ssh.calls()).toEqual([]);
    // a forget that went through leaves nothing to do, so it ends ready and exits 0
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(step('uninstall').at(-1)).toMatchObject({ status: 'skip', detail: expect.stringContaining('trift.test') });
  });

  it('reports a far uninstall that failed for itself with its exit and what it said, not as a machine out of reach', async () => {
    ssh.reply(['uninstall'], { stderr: 'svall: tmux refused to stop the fleet\n', code: 1 });
    const registry = registered('trift.test');
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(out.result).toBe('actions');
    const failed = step('uninstall').at(-1);
    expect(failed).toMatchObject({ status: 'fail', detail: 'svall uninstall exited 1 on trift.test: svall: tmux refused to stop the fleet' });
    expect(failed?.action).toContain('ssh trift.test, then svall uninstall');
    expect(registry.get('trift')).toBeDefined();
  });

  const fleetAt = (name: string, o: { gateway?: string; owner?: string } = {}): string => {
    const home = path.join(work, name);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: FLEET, ...(o.gateway ? { gatewayMachineId: o.gateway } : {}) }));
    if (o.owner) fs.writeFileSync(path.join(home, 'owner.json'), JSON.stringify({ fleetId: FLEET, generation: 2, ownerMachineId: o.owner }));
    return home;
  };
  const gatewayOf = (home: string): string | undefined =>
    (JSON.parse(fs.readFileSync(path.join(home, 'fleet.json'), 'utf8')) as { gatewayMachineId?: string }).gatewayMachineId;

  it('remove runs svall uninstall there with no flag before it drops the registry entry, and leaves this Mac\'s fleet.json as it is', async () => {
    ssh.reply(['uninstall'], { stdout: 'removed\n' });
    const registry = registered('trift.test');
    const mine = fleetAt('.svall', { gateway: REMOTE, owner: MAC });
    const out = await removeHost('trift', {}, deps({ registry }));
    expect(out.result).toBe('ready');
    expect(ssh.remoteCalls().find((a) => a.includes('uninstall'))).toEqual([SVALL, 'uninstall']);
    expect(events.filter((e) => e.status !== 'start').map((e) => e.step)).toEqual(['machine', 'uninstall', 'registry']);
    expect(registry.get('trift')).toBeUndefined();
    expect(gatewayOf(mine)).toBe(REMOTE);
  });

  it('forgets an unreachable machine and says the remote was left alone', async () => {
    const registry = registered('refused.test');
    const out = await removeHost('trift', { forget: true }, deps({ registry }));
    expect(registry.get('trift')).toBeUndefined();
    expect(out.result).toBe('ready');
    expect(step('uninstall').at(-1)).toMatchObject({ status: 'skip', detail: expect.stringContaining('refused.test') });
  });
});
