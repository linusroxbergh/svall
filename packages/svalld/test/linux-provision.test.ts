import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetId, MachineId } from '@svall/protocol';
import { seedAgentProfiles } from '../src/agent-profiles.js';
import { provisionFleet, ProvisionRefused } from '../src/linux/provision.js';
import { unitDirOf } from '../src/linux/setup.js';
import type { Run } from '../src/linux/service.js';
import { resolvePaths } from '../src/paths.js';
import { checkoutRuntime } from '../src/runtime.js';
import { installHomeTemplate } from '../src/setup.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(() => { vi.unstubAllEnvs(); cleanHomes(); });
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const FLEET = FleetId.parse(crypto.randomUUID());
const OTHER = FleetId.parse(crypto.randomUUID());
const GATEWAY = MachineId.parse(crypto.randomUUID());
const HERE = MachineId.parse(crypto.randomUUID());

/** A systemd that answers every call and remembers each, with the fleet id fleet.json held at that moment. */
function systemd(file: string) {
  const calls: string[][] = [];
  const held: (string | undefined)[] = [];
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    try { held.push((JSON.parse(fs.readFileSync(file, 'utf8')) as { id: string }).id); } catch { held.push(undefined); }
    return { stdout: '', stderr: '' };
  };
  return { run, calls, held };
}

/** The far machine as `svall fleet provision -p <profile>` finds it. */
function far(profile = 'private') {
  const root = makeHome();
  const home = path.join(root, profile === 'private' ? '.svall' : `.svall-${profile}`);
  const paths = resolvePaths(home);
  const sd = systemd(paths.fleetConfig);
  const unit = `svall-svalld@${profile}.service`;
  return {
    root, home, paths, sd, unit, unitFile: path.join(unitDirOf(root), unit),
    o: {
      runtime: checkoutRuntime(repoRoot), homedir: root, prefix: path.join(root, '.local/share/svall'), unitDir: unitDirOf(root),
      profile, home, fleetId: FLEET, gatewayMachineId: GATEWAY, run: sd.run, env: {},
    },
  };
}
type Far = ReturnType<typeof far>;

/** A fleet home as `host add` leaves it: its own id and no gateway, owned by this machine at generation 0, with nothing in it. */
function hostAdded(f: Far, o: { characters?: Record<string, unknown>; owner?: Record<string, unknown>; journal?: boolean } = {}): void {
  fs.mkdirSync(f.home, { recursive: true });
  fs.writeFileSync(f.paths.fleetConfig, JSON.stringify({ id: OTHER, home: { cwd: '~/.svall/home' } }));
  fs.writeFileSync(f.paths.nodeConfig, JSON.stringify({ host: '127.0.0.1', port: 47800 }));
  fs.writeFileSync(f.paths.owner, JSON.stringify({ fleetId: OTHER, generation: 0, ownerMachineId: HERE, ...o.owner }));
  fs.writeFileSync(f.paths.state, JSON.stringify({ version: 8, islands: {}, characters: o.characters ?? {} }));
  if (o.journal) {
    fs.mkdirSync(f.paths.handoverDir, { recursive: true });
    fs.writeFileSync(f.paths.journal, JSON.stringify({ role: 'destination', transactionId: 'tx-1' }));
  }
}

/** As `hostAdded`, with what the fleet's standalone start then wrote: mission control's folder at home.cwd under the account's home, and its agent profiles. */
function seeded(f: Far): string {
  hostAdded(f);
  const mc = path.join(f.root, '.svall/home');
  installHomeTemplate(mc, { replaceSettings: false });
  seedAgentProfiles(f.paths.agentProfiles);
  return mc;
}

// every file under a folder with its bytes, so a check can prove nothing was written there
function files(dir: string): Record<string, string> {
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries((fs.readdirSync(dir, { recursive: true }) as string[]).sort()
    .filter((name) => fs.lstatSync(path.join(dir, name)).isFile()).map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
}

const fleetOf = (f: Far): Record<string, unknown> => JSON.parse(fs.readFileSync(f.paths.fleetConfig, 'utf8')) as Record<string, unknown>;

describe('provisionFleet', () => {
  it('creates an absent fleet home with the fleet\'s id and gateway, and starts its unit on it', async () => {
    const f = far('work');
    expect(await provisionFleet(f.o)).toEqual({ outcome: 'created', home: f.home, unit: f.unit });
    expect(fleetOf(f)).toMatchObject({ id: FLEET, gatewayMachineId: GATEWAY });
    // a profile beside the private fleet takes a port of its own
    expect(JSON.parse(fs.readFileSync(f.paths.nodeConfig, 'utf8'))).toMatchObject({ port: 0 });
    expect(fs.existsSync(f.paths.hookScript)).toBe(true);
    // the gateway names the owner once the daemon asks it, so no owner record is written here
    expect(fs.existsSync(f.paths.owner)).toBe(false);
    expect(fs.readFileSync(f.unitFile, 'utf8')).toContain(`Environment="SVALL_HOME=${f.home}"`);
    expect(f.sd.calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', f.unit],
    ]);
  });

  it("keeps the units' logs in a folder only this account opens, and gives the daemon the agent homes the account's login shell sets", async () => {
    const f = far('work');
    fs.mkdirSync(path.join(f.o.prefix, 'log'), { recursive: true, mode: 0o755 });
    vi.stubEnv('SHELL', '/bin/bash');
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    vi.stubEnv('CODEX_HOME', undefined);
    const { env: _none, ...o } = f.o;
    const run: Run = async (cmd, args) => (cmd === '/bin/bash' ? { stdout: 'svall-agent-homes\n\n/home/linus/.codex-work\n', stderr: '' } : f.sd.run(cmd, args));
    await provisionFleet({ ...o, run });
    expect(fs.statSync(path.join(f.o.prefix, 'log')).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(f.unitFile, 'utf8')).toContain('Environment="CODEX_HOME=/home/linus/.codex-work"\n');
  });

  it('finishes a home an earlier run left half made, and asks nothing more of one already right than to be running', async () => {
    const f = far('work');
    // a run that wrote the fleet's id and was cut off there
    fs.mkdirSync(f.home, { recursive: true });
    fs.writeFileSync(f.paths.fleetConfig, JSON.stringify({ id: FLEET, gatewayMachineId: GATEWAY }));
    expect(await provisionFleet(f.o)).toEqual({ outcome: 'held', home: f.home, unit: f.unit });
    expect(JSON.parse(fs.readFileSync(f.paths.nodeConfig, 'utf8'))).toMatchObject({ port: 0 });
    for (const file of [f.paths.hookScript, f.unitFile]) expect(fs.existsSync(file), file).toBe(true);
    expect(f.sd.calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', f.unit],
    ]);

    const before = files(f.root);
    f.sd.calls.length = 0;
    expect(await provisionFleet(f.o)).toEqual({ outcome: 'held', home: f.home, unit: f.unit });
    expect(files(f.root)).toEqual(before);
    expect(f.sd.calls).toEqual([['systemctl', '--user', 'enable', '--now', f.unit]]);
  });

  it('restarts a unit whose file it rewrote, so a daemon already running takes the new environment', async () => {
    const stale = (f: Far): void => {
      fs.mkdirSync(path.dirname(f.unitFile), { recursive: true });
      fs.writeFileSync(f.unitFile, '[Service]\nEnvironment="CODEX_HOME=/old/codex"\n');
    };
    const f = far('work');
    fs.mkdirSync(f.home, { recursive: true });
    fs.writeFileSync(f.paths.fleetConfig, JSON.stringify({ id: FLEET, gatewayMachineId: GATEWAY }));
    stale(f);
    expect(await provisionFleet(f.o)).toEqual({ outcome: 'held', home: f.home, unit: f.unit });
    expect(fs.readFileSync(f.unitFile, 'utf8')).not.toContain('/old/codex');
    expect(f.sd.calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'restart', f.unit],
      ['systemctl', '--user', 'enable', '--now', f.unit],
    ]);

    // a fleet taking this one's id is stopped and started again on the new file, and never restarted as the old fleet
    const g = far();
    hostAdded(g);
    stale(g);
    expect(await provisionFleet(g.o)).toMatchObject({ outcome: 'rekeyed' });
    expect(g.sd.calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'stop', g.unit],
      ['systemctl', '--user', 'enable', '--now', g.unit],
    ]);
  });

  it('gives a home only host add has touched this fleet\'s id and gateway, drops its owner record and starts it again on them', async () => {
    const f = far();
    hostAdded(f);
    const state = fs.readFileSync(f.paths.state, 'utf8');
    expect(await provisionFleet(f.o)).toEqual({ outcome: 'rekeyed', home: f.home, unit: f.unit });
    expect(fleetOf(f)).toMatchObject({ id: FLEET, gatewayMachineId: GATEWAY, home: { cwd: '~/.svall/home' } });
    expect(fs.existsSync(f.paths.owner)).toBe(false);
    expect(fs.readFileSync(f.paths.state, 'utf8')).toBe(state);
    expect(f.sd.calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'stop', f.unit],
      ['systemctl', '--user', 'enable', '--now', f.unit],
    ]);
    // the daemon is stopped before the fleet it runs is changed under it
    expect(f.sd.held).toEqual([OTHER, OTHER, FLEET]);
  });

  it('finishes a rekey cut short at any step, so the fleet never keeps the owner record host add left', async () => {
    const [rm, rename] = [fs.rmSync, fs.renameSync];
    for (const cut of ['owner.json', 'fleet.json']) {
      const f = far();
      hostAdded(f);
      const crash = cut === 'owner.json'
        ? vi.spyOn(fs, 'rmSync').mockImplementation((p, o) => { if (p === f.paths.owner) throw new Error('crashed'); rm(p, o); })
        : vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => { if (to === f.paths.fleetConfig) throw new Error('crashed'); rename(from, to); });
      await expect(provisionFleet(f.o)).rejects.toThrow('crashed');
      crash.mockRestore();
      expect(await provisionFleet(f.o), cut).toMatchObject({ outcome: 'rekeyed' });
      expect(fleetOf(f), cut).toMatchObject({ id: FLEET, gatewayMachineId: GATEWAY });
      expect(fs.existsSync(f.paths.owner), cut).toBe(false);
    }
  });

  it('drops the mission control folder and agent profiles a standalone start seeded, and keeps each once anything in it has changed', async () => {
    const f = far();
    const mc = seeded(f);
    expect(await provisionFleet(f.o)).toMatchObject({ outcome: 'rekeyed' });
    expect(fs.existsSync(mc)).toBe(false);
    expect(fs.existsSync(f.paths.agentProfiles)).toBe(false);

    const g = far();
    const edited = seeded(g);
    fs.writeFileSync(path.join(edited, '.claude/settings.local.json'), '{}\n');
    const profile = fs.readdirSync(g.paths.agentProfiles)[0];
    fs.appendFileSync(path.join(g.paths.agentProfiles, profile), '\nand mine\n');
    const before = [files(edited), files(g.paths.agentProfiles)];
    expect(await provisionFleet(g.o)).toMatchObject({ outcome: 'rekeyed' });
    expect([files(edited), files(g.paths.agentProfiles)]).toEqual(before);
  });

  it('keeps a seeded mission control folder that another fleet home on the machine names as its own', async () => {
    // another fleet here, on the default home.cwd or on one of its own
    const beside = (f: Far, fleet: Record<string, unknown>): void => {
      fs.mkdirSync(path.join(f.root, '.svall-work'));
      fs.writeFileSync(path.join(f.root, '.svall-work/fleet.json'), JSON.stringify({ id: crypto.randomUUID(), ...fleet }));
    };
    const f = far();
    const mc = seeded(f);
    beside(f, {});
    const before = files(mc);
    expect(await provisionFleet(f.o)).toMatchObject({ outcome: 'rekeyed' });
    expect(files(mc)).toEqual(before);
    expect(fs.existsSync(f.paths.agentProfiles)).toBe(false);

    const g = far();
    const alone = seeded(g);
    beside(g, { home: { cwd: '~/work-mc' } });
    expect(await provisionFleet(g.o)).toMatchObject({ outcome: 'rekeyed' });
    expect(fs.existsSync(alone)).toBe(false);
  });

  it('refuses a home whose fleet has been used, naming the home and why, and changes nothing', async () => {
    const used: [Parameters<typeof hostAdded>[1], RegExp][] = [
      [{ characters: { c_1: { id: 'c_1' } } }, /holds 1 character/],
      [{ owner: { generation: 2, ownerMachineId: HERE } }, /generation 2/],
      [{ owner: { transaction: { id: 'tx-9', fromMachineId: HERE, toMachineId: GATEWAY, phase: 'preparing', startedAt: 1 } } }, /handover tx-9/],
      [{ journal: true }, /handover journal/],
    ];
    for (const [o, why] of used) {
      const f = far();
      hostAdded(f, o);
      const before = files(f.root);
      const err = await provisionFleet(f.o).catch((e: Error) => e);
      expect(err).toBeInstanceOf(ProvisionRefused);
      expect((err as Error).message).toContain(`${f.home} holds fleet ${OTHER}`);
      expect((err as Error).message).toMatch(why);
      expect(files(f.root)).toEqual(before);
      expect(f.sd.calls).toEqual([]);
    }
  });
});
