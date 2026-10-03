import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyState, FleetConfig, type Character, type ContextItem, type MachineId } from '@svall/protocol';
import { buildInventory } from '../../src/handover/inventory.js';
import { silentLogger } from '../../src/log.js';
import { startDaemon } from '../../src/main.js';
import { installedScripts, resolvePaths } from '../../src/paths.js';
import { Tmux } from '../../src/tmux/tmux.js';
import { cleanHomes, hasTmux, makeHome } from '../helpers.js';

const REPO = path.resolve(import.meta.dirname, '../../../..');

type Handling = 'manifest' | 'root' | 'machine-local';

/**
 * Every entry a fleet home holds, by its name at the top of the home, and what a handover does with it. `manifest`
 * and `root` travel: the state and fleet.json in the manifest, the rest as a root at the same path in the
 * destination's fleet home. `machine-local` stays on its machine. A `*` stands for any run of characters.
 */
const ENTRIES: Record<string, Handling> = {
  'state.json': 'manifest',
  'fleet.json': 'manifest',
  docs: 'root',
  'agent-profiles': 'root',
  // mission control's folder while fleet.json's home.cwd names it, and the .env when handover.transferFleetEnv asks
  home: 'root',
  '.env': 'root',
  'node.json': 'machine-local',
  'config.json': 'machine-local',
  'owner.json': 'machine-local',
  handover: 'machine-local',
  replicas: 'machine-local',
  token: 'machine-local',
  port: 'machine-local',
  'svalld.log': 'machine-local',
  'daemon.lock': 'machine-local',
  hooks: 'machine-local',
  'hooks.sock': 'machine-local',
  'hooks.down': 'machine-local',
  'tmux.sock': 'machine-local',
  'tmux.conf': 'machine-local',
  'tmux-binary': 'machine-local',
  'mobile-key': 'machine-local',
  'push.json': 'machine-local',
  'vapid.json': 'machine-local',
  usage: 'machine-local',
  scribe: 'machine-local',
  '*.prompt': 'machine-local',
  controller: 'machine-local',
  'app.pid': 'machine-local',
  'browser-store': 'machine-local',
  // the build that last ran this fleet here, the resources it set aside for Undo, and the mark a scripted quit leaves
  version: 'machine-local',
  trash: 'machine-local',
  'quit-quietly': 'machine-local',
};

// what a write, a repair, a migration or an archive leaves beside an entry, named by the helper from the entry's own name
const BESIDE: Record<string, Handling> = {
  '*.tmp': 'machine-local',
  '*.tmp-*': 'machine-local',
  '*.broken-*': 'machine-local',
  '*.archived-*': 'machine-local',
  'state.json.v*': 'machine-local',
  'config.json.bak': 'machine-local',
  'svalld.log.1': 'machine-local',
};

const JOIN = /\bjoin\(\s*(?:[\w$.]*\.)?(?:home|fleetHome)\s*,\s*['`]([^'`/]+)['`]/g;
// where the code names an entry of a fleet home: a literal joined onto one, appended to one, or under the private fleet's
const SCANS: [glob: string, patterns: RegExp[]][] = [
  ['packages/*/src/**/*.ts', [JOIN, /~\/\.svall\/([\w.-]+)/g]],
  ['packages/svalld/hooks/*.mjs', [JOIN]],
  ['apps/desktop/mac/Sources/**/*.swift', [/\bSvallHome\.path \+ "\/([^"/]+)/g]],
  ['apps/desktop/mac/Sources/Svall/SvallHome.swift', [/\b(?:path|home) \+ "\/([^"/]+)/g, /\bread\("([^"]+)"\)/g]],
  ['scripts/*.sh', [/\$\{?home\}?\/([\w.-]+)/g]],
];
// literals the scan finds joined onto a `home` that is no fleet home: a user's home, Claude's config folder, or CODEX_HOME
const ELSEWHERE: Record<string, string[]> = {
  'packages/svalld/src/paths.ts': ['.claude', '.claude.json'],
  'packages/svalld/src/codex/install.ts': ['.codex'],
  'packages/svalld/src/handover/inventory.ts': ['.claude', '.codex', '.claude.json', '.ssh'],
  'packages/svalld/src/handover/sessions/claude.ts': ['.config.json', '.claude.json', 'settings.json'],
  'packages/svalld/src/handover/sessions/codex.ts': ['config.toml'],
  'packages/cli/src/controller/host.ts': ['.cache', '.local'],
};

/** The entries `text` names, with a template's `${…}` read as `*`. */
function scan(file: string, text: string, patterns: RegExp[]): string[] {
  const names = patterns.flatMap((p) => [...text.matchAll(p)].map((m) => m[1].replace(/\$\{[^}]*\}/g, '*')));
  return names.filter((n) => !ELSEWHERE[file]?.includes(n));
}

/** Every entry the code names in a fleet home, with the files that name it; resolvePaths is asked as well as read. */
function named(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (name: string, file: string) => out.set(name, [...(out.get(name) ?? []), file]);
  for (const [glob, patterns] of SCANS) {
    for (const file of fs.globSync(glob, { cwd: REPO })) for (const n of scan(file, fs.readFileSync(path.join(REPO, file), 'utf8'), patterns)) add(n, file);
  }
  const top = (p: string) => path.relative('/F', p).split('/')[0];
  for (const [key, v] of Object.entries(resolvePaths('/F'))) {
    if (key !== 'home') add(top(typeof v === 'string' ? v : (v as (a: string, b: string) => string)('x', '/x')), `resolvePaths().${key}`);
  }
  for (const p of installedScripts('/F')) add(top(p), 'installedScripts()');
  return out;
}

const wildcard = (pattern: string): RegExp => new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
/** How a handover treats the entry `name`, or undefined when no entry of the list covers it. */
function handling(name: string): Handling | undefined {
  const all = { ...ENTRIES, ...BESIDE };
  return all[name] ?? Object.entries(all).find(([k]) => k.includes('*') && wildcard(k).test(name))?.[1];
}

describe('the entries of a fleet home', () => {
  it('classifies every entry the code names in a fleet home as travelling or machine-local', () => {
    const unclassified = [...named()].filter(([n]) => !handling(n));
    expect(unclassified).toEqual([]);
  });

  it('fails on an entry nobody classified, however the code names it', () => {
    expect(scan('packages/svalld/src/x.ts', "fs.writeFileSync(path.join(this.deps.paths.home, 'scratch.json'), '')", [JOIN]).filter((n) => !handling(n))).toEqual(['scratch.json']);
    expect(scan('packages/cli/src/x.ts', 'path.join(o.fleetHome, `${id}.lease`)', [JOIN]).filter((n) => !handling(n))).toEqual(['*.lease']);
    expect(scan('x.swift', 'let file = SvallHome.path + "/cookies"', SCANS[2][1]).filter((n) => !handling(n))).toEqual(['cookies']);
  });

  it('names no entry the code no longer names', () => {
    const found = [...named().keys()];
    expect(Object.keys(ENTRIES).filter((k) => !found.includes(k))).toEqual([]);
  });

  it('carries each entry that travels as a root, and leaves every other entry behind', () => {
    const home = fs.realpathSync(makeHome());
    const fleetHome = path.join(home, '.svall');
    const sample = (name: string) => path.join(fleetHome, name.replaceAll('*', 'x'));
    for (const name of Object.keys({ ...ENTRIES, ...BESIDE })) {
      if (name === '.env') fs.mkdirSync(fleetHome, { recursive: true });
      else fs.mkdirSync(sample(name), { recursive: true });
    }
    fs.writeFileSync(sample('.env'), 'KEY=1\n');
    const behind = Object.entries({ ...ENTRIES, ...BESIDE }).filter(([, h]) => h !== 'root').map(([n]) => sample(n));
    const state = emptyState();
    const context: ContextItem[] = behind.map((ref) => ({ kind: 'folder', ref, label: '', source: 'manual' }));
    state.characters.c1 = { id: 'c1', islandId: 'i1', cell: { x: 0, y: 0 }, name: 'c1', note: '', portrait: 'fox', instructions: '', cwd: home, context, shell: { lastOutputAt: 0 }, unread: false } satisfies Character;
    const fleet = FleetConfig.parse({ id: '5e1f0b1c-2d3e-4f50-8617-9a0b1c2d3e4f', handover: { transferFleetEnv: true } });
    const mac = '9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
    const trift = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
    const inv = buildInventory(state, { fleet }, { source: { machineId: mac, home, fleetHome }, destination: { machineId: trift, home, fleetHome } });

    const carried = inv.roots.map((r) => r.path).filter((p) => p.startsWith(`${fleetHome}/`)).sort();
    expect(carried).toEqual(Object.entries(ENTRIES).filter(([, h]) => h === 'root').map(([n]) => sample(n)).sort());
    const refused = inv.blockers.filter((b) => b.message.includes(`overlaps the fleet home ${fleetHome}`)).map((b) => b.message.split(' overlaps')[0]);
    expect(refused.sort()).toEqual([...behind].sort());
  });
});

const runIf = hasTmux() ? describe : describe.skip;

runIf('a started fleet home', () => {
  const homes: string[] = [];
  afterEach(async () => {
    for (const h of homes.splice(0)) { const p = resolvePaths(h); await new Tmux(p.tmuxSock, p.tmuxConf).killServer(); }
    cleanHomes();
  });

  it('holds only entries the list classifies once a daemon has started and stopped there', async () => {
    const home = makeHome();
    homes.push(home);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh', port: 0 }));
    await (await startDaemon({ home, port: 0, log: silentLogger })).stop();
    const entries = fs.readdirSync(home);
    expect(entries).toEqual(expect.arrayContaining(['state.json', 'fleet.json', 'node.json', 'token', 'hooks', 'agent-profiles']));
    expect(entries.filter((n) => !handling(n))).toEqual([]);
  });
});
