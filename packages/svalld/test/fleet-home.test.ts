import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultHome, emptyState } from '@svall/protocol';
import { placementOk } from '../src/layout.js';
import { silentLogger } from '../src/log.js';
import { expandHome, resolvePaths } from '../src/paths.js';
import { boot, cleanup, stopFleets } from './fleet-boot.js';
import { cleanHomes, hasTmux, makeHome, waitFor } from './helpers.js';

const runIf = hasTmux() ? describe : describe.skip;

runIf('Fleet home', () => {
  afterEach(async () => { await stopFleets(); cleanHomes(); });

  it('creates the home island on start, copies config into state, and protects it', async () => {
    const { fleet, store, home: svallHome } = await boot();
    // a robot is refused a cwd that is not a directory, so the folder must exist
    expect(fs.existsSync(path.join(svallHome, 'mc'))).toBe(true);
    // the buttons send /svall-… , which is a command only where the skills are
    expect(fs.readFileSync(path.join(svallHome, 'mc/.claude/skills/svall-rename/SKILL.md'), 'utf8')).toContain('name: svall-rename');
    expect(fs.readFileSync(path.join(svallHome, 'mc/.agents/skills/svall-rename/SKILL.md'), 'utf8')).toContain('name: svall-rename');
    expect(fs.existsSync(path.join(svallHome, 'mc/CLAUDE.md'))).toBe(true);
    const home = store.state.islands.home;
    expect(home).toMatchObject({ id: 'home', kind: 'home', name: 'mission control', size: { w: 8, h: 4 }, seed: 7 });
    expect(store.state.home.command).toBe('claude --model opus');
    expect(() => fleet.deleteIsland('home')).toThrow(/mission control cannot be deleted/);
    const updated = fleet.updateIsland('home', { name: 'hq', position: { x: 50, y: 50 }, size: { w: 20, h: 9 } });
    expect(updated.name).toBe('hq');
    expect(updated.position).toEqual(home.position);
    expect(updated.size).toEqual(home.size);
    await fleet.reconcileNow();
    expect(Object.values(store.state.islands).filter((i) => i.kind === 'home')).toHaveLength(1);
  });

  it('a fleet.json with its own actions gets retro once; deleting it keeps it deleted', async () => {
    const own = [{ label: 'deploy', prompt: '/deploy' }];
    const retro = { label: 'retro', prompt: '/svall-retro' };
    const first = await boot({ fleetHome: { actions: own } });
    expect(first.store.state.home.actions).toEqual([...own, retro]);
    const fleetJson = (home: string) => JSON.parse(fs.readFileSync(resolvePaths(home).fleetConfig, 'utf8')).home;
    expect(fleetJson(first.home)).toEqual({ actions: [...own, retro], offered: ['retro'] });
    // the user took the button out again
    const second = await boot({ fleetHome: { actions: own, offered: ['retro'] } });
    expect(second.store.state.home.actions).toEqual(own);
    expect(fleetJson(second.home)).toEqual({ actions: own, offered: ['retro'] });
  });

  it('a fleet with default actions shows retro, and its crew settings gain the retro rules once', async () => {
    const mc = path.join(makeHome(), 'mc');
    const shipped = fs.readFileSync(path.join(import.meta.dirname, '../home/.claude/settings.json'), 'utf8');
    const allow: string[] = JSON.parse(shipped).permissions.allow;
    const older = `${JSON.stringify({ permissions: { allow: allow.filter((r) => !r.startsWith('Bash(svall retro ')) } }, null, 2)}\n`;
    const settings = path.join(mc, '.claude/settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, older);
    const { store, home } = await boot({ homeCwd: mc, fleetHome: {} });
    expect(store.state.home.actions.at(-1)).toEqual({ label: 'retro', prompt: '/svall-retro' });
    expect(store.state.home).not.toHaveProperty('offered');
    expect(JSON.parse(fs.readFileSync(resolvePaths(home).fleetConfig, 'utf8')).home).toEqual({ offered: ['retro'] });
    expect(fs.readFileSync(settings, 'utf8')).toBe(shipped);
    // the user took them out again
    fs.writeFileSync(settings, older);
    await boot({ homeCwd: mc, fleetHome: { offered: ['retro'] } });
    expect(fs.readFileSync(settings, 'utf8')).toBe(older);
  });

  it('offers retro again on the next start when the crew settings could not take its rules', async () => {
    const mc = path.join(makeHome(), 'mc');
    const settings = path.join(mc, '.claude/settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{ not json');
    const errors: string[] = [];
    const first = await boot({ homeCwd: mc, fleetHome: {}, log: { ...silentLogger, error: (m: string) => errors.push(m) } });
    expect(errors.join('\n')).toContain('svall retro rules could not be added');
    expect(JSON.parse(fs.readFileSync(resolvePaths(first.home).fleetConfig, 'utf8')).home).toEqual({});
    fs.writeFileSync(settings, '{ "permissions": { "allow": [] } }');
    const second = await boot({ homeCwd: mc, fleetHome: {} });
    expect(JSON.parse(fs.readFileSync(resolvePaths(second.home).fleetConfig, 'utf8')).home).toEqual({ offered: ['retro'] });
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow).toContain('Bash(svall retro plan:*)');
  });

  it('a fleet.json that lists the retro button already gets no second one', async () => {
    const { actions } = defaultHome();
    const { store, home } = await boot({ fleetHome: { actions } });
    expect(store.state.home.actions).toEqual(actions);
    expect(JSON.parse(fs.readFileSync(resolvePaths(home).fleetConfig, 'utf8')).home).toEqual({ actions, offered: ['retro'] });
  });

  it('opens a new fleet on a Mac with one island holding a shell, and does not make them again once deleted', async () => {
    const { fleet, store } = await boot({ opening: true, platform: 'darwin' });
    const first = Object.values(store.state.islands).filter((i) => i.kind !== 'home');
    expect(first).toEqual([expect.objectContaining({ name: 'Island 1' })]);
    const shells = Object.values(store.state.robots);
    expect(shells).toEqual([expect.objectContaining({ islandId: first[0].id, cwd: expandHome(store.state.defaultCwd) })]);
    expect(shells[0].agent).toBeUndefined();
    expect(placementOk(store.state, first[0])).toBe(true);
    await fleet.closeRobot(shells[0].id);
    fleet.deleteIsland(first[0].id);
    // the next start reads the fleet the last one left
    const again = await boot({ opening: true, state: structuredClone(store.state) });
    expect(Object.values(again.store.state.islands).map((i) => i.name)).toEqual(['mission control']);
  });

  it.each([undefined, 'project'])('starts onboarding in the chosen project or projects folder (%s)', async (chosen) => {
    const projects = makeHome();
    const project = path.join(projects, 'storefront');
    fs.mkdirSync(project);
    const { store, tmux } = await boot({ opening: true, platform: 'darwin', mainAgent: 'codex', agentsFound: ['codex'],
      defaultCwd: projects, onboarding: { scribe: true, ...(chosen ? { firstProject: project } : {}) } });
    const first = Object.values(store.state.islands).find((i) => i.kind !== 'home')!;
    expect(first.name).toBe(chosen ? 'storefront' : 'Island 1');
    const robots = Object.values(store.state.robots);
    expect(robots).toHaveLength(1);
    expect(robots[0]).toMatchObject({ islandId: first.id, cwd: chosen ? project : projects });
    expect(store.state.scribeAsk).toBeUndefined();
    expect(store.state.scribeOff).toBeUndefined();
    await waitFor(async () => (await tmux.capture(robots[0].tmux!.paneId, 50)).toString().includes('codex'));
  });

  it('opens a new fleet on a Linux machine with an empty island, so the fleet host add started there stays unused for enable', async () => {
    const { store } = await boot({ opening: true, platform: 'linux' });
    expect(Object.values(store.state.islands).map((i) => i.name).sort()).toEqual(['Island 1', 'mission control']);
    expect(store.state.robots).toEqual({});
  });

  it('gives a fleet back its mission control, and no new island, when a start finds it missing', async () => {
    const { store } = await boot({ opening: true });
    // what salvage leaves when only mission control's entry is broken
    const salvaged = structuredClone(store.state);
    for (const i of Object.values(salvaged.islands)) if (i.kind === 'home') delete salvaged.islands[i.id];
    const again = await boot({ opening: true, state: salvaged });
    expect(Object.values(again.store.state.islands).map((i) => i.name).sort()).toEqual(['Island 1', 'mission control']);
  });

  it("starts mission control's crew on the main agent unless config.json names a command", async () => {
    const both = await boot({ agentsFound: ['claude', 'codex'] });
    expect(both.store.state.home.command).toBe('claude --model opus');
    both.fleet.setMainAgent('codex');
    expect(both.store.state.home.command).toBe('codex');
    expect((await boot({ agentsFound: ['codex'] })).store.state.home.command).toBe('codex');
    expect((await boot({ agentsFound: ['codex'], homeCommand: 'my-agent --flag' })).store.state.home.command).toBe('my-agent --flag');
  });

  it("keeps the crew's and the scribe's model for each CLI in fleet.json, mirrors the running CLI's into the fleet, and drops a pick for the default", async () => {
    const { fleet, store, home } = await boot({ agentsFound: ['claude', 'codex'] });
    const saved = () => JSON.parse(fs.readFileSync(resolvePaths(home).fleetConfig, 'utf8'));
    expect(store.state.home.model).toBe('opus');
    expect(store.state.scribeModel).toBe('haiku');
    fleet.setModel('home', 'claude', 'sonnet');
    fleet.setModel('scribe', 'claude', 'opus');
    expect(store.state.home).toMatchObject({ command: 'claude --model sonnet', model: 'sonnet' });
    expect(store.state.scribeModel).toBe('opus');
    expect(saved()).toMatchObject({ home: { model: { claude: 'sonnet' } }, scribe: { model: { claude: 'opus' } } });
    fleet.setMainAgent('codex');
    expect(store.state.home).toMatchObject({ command: 'codex', model: undefined });
    expect(store.state.scribeModel).toBe('gpt-6-luna');
    fleet.setModel('home', 'codex', 'gpt-6-astra');
    expect(store.state.home).toMatchObject({ command: 'codex -m gpt-6-astra', model: 'gpt-6-astra' });
    fleet.setMainAgent('claude');
    expect(store.state.home).toMatchObject({ command: 'claude --model sonnet', model: 'sonnet' });
    expect(store.state.scribeModel).toBe('opus');
    fleet.setModel('home', 'claude', undefined);
    expect(store.state.home).toMatchObject({ command: 'claude --model opus', model: 'opus' });
    expect(saved()).toMatchObject({ mainAgent: 'claude', home: { model: { codex: 'gpt-6-astra' } }, scribe: { model: { claude: 'opus' } } });
    expect(saved().home.model).not.toHaveProperty('claude');
  });

  it("reads a single scribe.model as a model of scribe.agent's CLI, else of claude's", async () => {
    const codex = await boot({ agentsFound: ['claude', 'codex'], scribe: { agent: 'codex', model: 'gpt-6-sol' } });
    expect(codex.store.state).toMatchObject({ mainAgent: 'claude', scribeAgent: 'codex', scribeModel: 'gpt-6-sol' });
    const claude = await boot({ agentsFound: ['claude', 'codex'], scribe: { model: 'claude-haiku-4-5' } });
    expect(claude.store.state.scribeModel).toBe('claude-haiku-4-5');
    claude.fleet.setMainAgent('codex');
    expect(claude.store.state.scribeModel).toBe('gpt-6-luna');
    claude.fleet.setModel('scribe', 'codex', 'gpt-6-sol');
    claude.fleet.setMainAgent('claude');
    expect(claude.store.state.scribeModel).toBe('claude-haiku-4-5');
  });

  it('runs each scribe pass on the CLI and model named at that moment', async () => {
    const { fleet, home } = await boot({ agentsFound: ['claude', 'codex'] });
    // stand-ins that record their arguments and answer the way each runner reads
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "$@" > "${bin}/args"\ncat > /dev/null\necho '{"result":"ok"}'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\necho "$@" > "${bin}/args"\ncat > /dev/null\nwhile [ "$1" != "-o" ]; do shift; done; printf ok > "$2"\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    cleanup.push(async () => { vi.unstubAllEnvs(); });
    const pass = async () => { await fleet['scribe']['deps'].run('s', 'p'); return fs.readFileSync(path.join(bin, 'args'), 'utf8'); };
    expect(await pass()).toMatch(/^-p --model haiku /);
    fleet.setModel('scribe', 'claude', 'sonnet');
    expect(await pass()).toMatch(/^-p --model sonnet /);
    fleet.setMainAgent('codex');
    expect(await pass()).toMatch(/^exec --json -m gpt-6-luna /);
  });

  it('places crew on home slots and refuses other cells', async () => {
    const { fleet, store } = await boot();
    const a = await fleet.createRobot({ islandId: 'home', cwd: '/tmp', name: 'a' });
    const b = await fleet.createRobot({ islandId: 'home', cwd: '/tmp', name: 'b' });
    const c = await fleet.createRobot({ islandId: 'home', cwd: '/tmp', name: 'c' });
    expect([a.cell, b.cell, c.cell]).toEqual([{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 7, y: 1 }]);
    expect(store.state.islands.home.size).toEqual({ w: 11, h: 4 });
    await expect(fleet.createRobot({ islandId: 'home', cwd: '/tmp', cell: { x: 2, y: 1 } })).rejects.toThrow(/slot/);
    expect(() => fleet.moveRobot(a.id, 'home', { x: 3, y: 2 })).toThrow(/slot/);
    const moved = fleet.moveRobot(a.id, 'home', { x: 4, y: 1 });
    expect(moved.cell).toEqual({ x: 4, y: 1 });
  });

  it('keeps a full home row as wide as it is through a swap in and a swap along it', async () => {
    const { fleet, store } = await boot();
    const crew = [];
    for (let n = 0; n < 5; n++) crew.push(await fleet.createRobot({ islandId: 'home', cwd: '/tmp', name: `m${n}` }));
    expect(store.state.islands.home.size).toEqual({ w: 17, h: 4 });
    const visitor = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'away' }).id, cwd: '/tmp', name: 'visitor' });
    fleet.moveRobot(visitor.id, 'home', { x: 13, y: 1 });
    expect(store.state.robots[crew[4].id].islandId).not.toBe('home');
    fleet.moveRobot(visitor.id, 'home', { x: 1, y: 1 });
    expect(store.state.islands.home.size).toEqual({ w: 17, h: 4 });
    expect(store.state.robots[crew[0].id].cell).toEqual({ x: 13, y: 1 });
  });

  it('drops the empty slots off the end of home but one as its crew leaves, moving no one', async () => {
    const { fleet, store } = await boot();
    const crew = [];
    for (let n = 0; n < 5; n++) crew.push(await fleet.createRobot({ islandId: 'home', cwd: '/tmp', name: `m${n}` }));
    const away = fleet.createIsland({ name: 'away' });
    const width = () => store.state.islands.home.size.w;
    // an empty slot inside the row stays
    await fleet.closeRobot(crew[1].id);
    expect(width()).toBe(17);
    fleet.moveRobot(crew[4].id, away.id);
    expect(width()).toBe(17);
    fleet.updateRobot(crew[3].id, { islandId: away.id });
    expect(width()).toBe(14);
    expect([crew[0], crew[2]].map((c) => store.state.robots[c.id].cell)).toEqual([{ x: 1, y: 1 }, { x: 7, y: 1 }]);
    fleet.moveRobot(crew[2].id, 'home', { x: 4, y: 1 });
    expect(width()).toBe(11);
    for (const c of [crew[0], crew[2]]) await fleet.closeRobot(c.id);
    expect(width()).toBe(8);
  });

  it('trims a home left wider than its crew and a spare slot on start, moving no one', async () => {
    const state = emptyState();
    state.islands.home = { id: 'home', kind: 'home', name: 'mission control', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 17, h: 4 }, seed: 7 };
    for (const [id, x] of [['c_aaaaaa', 1], ['c_bbbbbb', 7]] as const) {
      state.robots[id] = { id, islandId: 'home', cell: { x, y: 1 }, name: id, portrait: 'fox', note: '', instructions: '', cwd: '/tmp', context: [], shell: { lastOutputAt: 0 }, unread: false };
    }
    const { store } = await boot({ state });
    expect(store.state.islands.home.size).toEqual({ w: 14, h: 4 });
    expect(['c_aaaaaa', 'c_bbbbbb'].map((id) => store.state.robots[id].cell)).toEqual([{ x: 1, y: 1 }, { x: 7, y: 1 }]);
  });

  it('places the robot itself when a move omits the cell', async () => {
    const { fleet } = await boot();
    const island = fleet.createIsland({ name: 'review' });
    const a = await fleet.createRobot({ islandId: 'home', cwd: '/tmp', name: 'a' });
    const moved = fleet.moveRobot(a.id, island.id);
    expect(moved.islandId).toBe(island.id);
    expect(moved.cell).toBeDefined();
    // already there: it keeps the cell it was placed on rather than shuffling
    expect(fleet.moveRobot(a.id, island.id).cell).toEqual(moved.cell);
    expect(() => fleet.moveRobot(a.id, 'nowhere')).toThrow(/no island/);
  });

  it('keeps the home island out of world layout', async () => {
    const { fleet, store } = await boot();
    const a = fleet.createIsland({ name: 'a' });
    expect(a.position).toEqual({ x: 0, y: 0 });
    for (let i = 0; i < 3; i++) await fleet.createRobot({ islandId: 'home', cwd: '/tmp' });
    expect(store.state.islands.home.size).toEqual({ w: 11, h: 4 });
    expect(fleet.createIsland({ name: 'b' }).position).toEqual({ x: 9, y: 0 });
  });

  it('mirrors the main agent into the fleet, and sets it in fleet.json', async () => {
    const { fleet, store, home } = await boot({ agentsFound: ['claude', 'codex'] });
    expect(store.state.mainAgent).toBe('claude');
    expect(store.state.agentsFound).toEqual(['claude', 'codex']);
    expect(store.state.scribeAgent).toBe('claude');
    fleet.setMainAgent('codex');
    expect(store.state.mainAgent).toBe('codex');
    expect(store.state.scribeAgent).toBe('codex');
    expect(JSON.parse(fs.readFileSync(resolvePaths(home).fleetConfig, 'utf8')).mainAgent).toBe('codex');
  });

  it('mirrors the fleet name into the fleet, and renames it in fleet.json unless another fleet goes by it', async () => {
    const { fleet, store, home } = await boot({ name: 'home' });
    expect(store.state.name).toBe('home');
    fleet.renameFleet('base');
    expect(store.state.name).toBe('base');
    expect(JSON.parse(fs.readFileSync(resolvePaths(home).fleetConfig, 'utf8')).name).toBe('base');
    const work = path.join(os.homedir(), '.svall-work');
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, 'config.json'), '{}');
    cleanup.push(async () => fs.rmSync(work, { recursive: true, force: true }));
    expect(() => fleet.renameFleet('work')).toThrow('another fleet is called work');
    expect(() => fleet.renameFleet('Base')).toThrow('lowercase');
    expect(store.state.name).toBe('base');
  });

  it('logs where it moved a config.json that appeared beside fleet.json while it ran, as it saves a setting', async () => {
    const said: string[] = [];
    const { fleet, home } = await boot({ agentsFound: ['claude', 'codex'], log: { info: (l) => said.push(l), error: (l) => said.push(l) } });
    const p = resolvePaths(home);
    fs.writeFileSync(p.fleetConfig, JSON.stringify({ id: '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' }));
    for (const save of [() => fleet.setMainAgent('codex'), () => fleet.renameFleet('base')]) {
      said.length = 0;
      fs.writeFileSync(p.legacyConfig, '{}');
      save();
      expect(said.filter((l) => l.startsWith(`${p.legacyConfig} moved to ${p.legacyConfig}.unread-`))).toHaveLength(1);
      expect(fs.existsSync(p.legacyConfig)).toBe(false);
    }
  });

  it('takes the only agent found as the main one, and refuses one svalld cannot find', async () => {
    const { fleet, store, home } = await boot({ agentsFound: ['codex'] });
    expect(store.state.mainAgent).toBe('codex');
    expect(() => fleet.setMainAgent('claude')).toThrow("svalld doesn't find claude; install Claude Code, then run svall setup");
    expect(store.state.mainAgent).toBe('codex');
    expect(fs.existsSync(resolvePaths(home).fleetConfig)).toBe(false);
  });
});
