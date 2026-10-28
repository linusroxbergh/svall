import { describe, expect, it } from 'vitest';
import { contextKind, farRootId, type ContextItem, type FleetState, type MachineId, type ResourceSource } from '@svall/protocol';
import { badgeOf, chainOf, countOf, docSlug, docsOf, isDoc, kindRows, qualifierOf, shelfSource, sourceOfRoot, tierWhere, visible, whereGroups, whereTier, withCard } from '../src/resources/model.js';

const VAULT = '4b7a3c1e-2d5f-4e6a-9b8c-0f1e2d3c4b5a' as MachineId;
const STUDIO = '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' as MachineId;
const item = (name: string, detail?: string) => ({ id: `x:${name}`, name, ...(detail && { detail }), reveal: `/x/${name}`, target: 'file' as const });
const user: ResourceSource = {
  rootId: 'r:/h/.claude', root: '/h/.claude', name: 'Claude', tier: 'global', islandIds: [], robotIds: [],
  groups: [
    { kind: 'instructions', items: [item('CLAUDE.md')] },
    { kind: 'skills', items: [item('ship-it', 'Commit, PR and merge'), item('grill-me', 'Interview me about a plan')] },
    { kind: 'mcp', items: [item('linear', 'http · mcp.linear.app')] },
  ],
};
const app: ResourceSource = { rootId: 'r:/r/app', root: '/r/app', name: 'app', tier: 'repo', islandIds: ['i1'], robotIds: ['a'], groups: [{ kind: 'skills', items: [item('prepush')] }, { kind: 'mcp', items: [item('local')] }] };

describe('resources model', () => {
  it('counts a kind, and everything under all', () => {
    expect(countOf(user, 'skills')).toBe(2);
    expect(countOf(user, 'hooks')).toBe(0);
    expect(countOf(user, 'all')).toBe(4);
    expect(countOf(undefined, 'all')).toBe(0);
  });
  it('shows one kind, or every kind in display order under all', () => {
    expect(visible(user, 'skills', '').map((g) => [g.kind, g.items.length])).toEqual([['skills', 2]]);
    expect(visible(user, 'all', '').map((g) => g.kind)).toEqual(['instructions', 'skills', 'mcp']);
  });
  it('narrows by name and by detail, and drops a kind left empty', () => {
    expect(visible(user, 'all', 'LINEAR').map((g) => g.items.map((i) => i.name))).toEqual([['linear']]);
    expect(visible(user, 'all', 'interview')[0].items.map((i) => i.name)).toEqual(['grill-me']);
    expect(visible(user, 'skills', 'zzz')).toEqual([]);
  });
  it('finds a source by its root', () => {
    expect(sourceOfRoot([user, app], '/r/app')).toBe(app);
    expect(sourceOfRoot([user, app], '/nope')).toBeUndefined();
    expect(sourceOfRoot([user, app], undefined)).toBeUndefined();
  });
  it('finds a worker\'s clone by its root and the machine it is on, and one here by its root alone', () => {
    const at = (m?: MachineId): ResourceSource => ({ ...app, root: '/srv/app', rootId: m ? farRootId(m, '/srv/app') : 'r:/srv/app' });
    const here = at(), one = at(VAULT), two = at(STUDIO);
    expect(sourceOfRoot([one, two, here], '/srv/app', STUDIO)).toBe(two);
    expect(sourceOfRoot([one, two, here], '/srv/app')).toBe(here);
  });
});

const src = (tier: ResourceSource['tier'], name: string, root: string, extra: Partial<ResourceSource> = {}): ResourceSource =>
  ({ rootId: `r:${root}`, root, name, tier, islandIds: [], robotIds: [], groups: [], ...extra });
// only what the model reads
type Card = { description?: string; note?: string; instructions?: string; context?: ContextItem[] };
const link = (ref: string, pinned?: true): ContextItem => ({ kind: contextKind(ref), ref, label: '', source: 'manual', ...(pinned && { pinned }) });
const state = (islands: Record<string, { name: string; kind?: 'home' } & Card>, robots: Record<string, { name: string; islandId: string; cwd: string; mainRoot?: string; branch?: string } & Card>): FleetState => ({
  islands: Object.fromEntries(Object.entries(islands).map(([id, i]) => [id, { id, ...i }])),
  robots: Object.fromEntries(Object.entries(robots).map(([id, c]) => [id, { id, name: c.name, islandId: c.islandId, cwd: c.cwd, note: c.note ?? '', instructions: c.instructions ?? '', context: c.context ?? [], ...(c.mainRoot && { repo: { root: c.cwd, mainRoot: c.mainRoot, branch: c.branch ?? 'main', isWorktree: c.cwd !== c.mainRoot } }) }])),
}) as unknown as FleetState;

const f = state(
  { i1: { name: 'ATLAS' }, i2: { name: 'mobile' }, i3: { name: 'empty' }, home: { name: 'Mission control', kind: 'home' } },
  {
    c1: { name: 'deep robin', islandId: 'i1', cwd: '/Users/l/code/atlas/.claude/worktrees/docs', mainRoot: '/Users/l/code/atlas', branch: 'worktree-docs' },
    c2: { name: 'violet tern', islandId: 'i1', cwd: '/Users/l/code/atlas', mainRoot: '/Users/l/code/atlas' },
    c3: { name: 'calm otter', islandId: 'i2', cwd: '/Users/l/code/atlas', mainRoot: '/Users/l/code/atlas' },
    c4: { name: 'brisk vole', islandId: 'i2', cwd: '/Users/l/code/phone' },
    h1: { name: 'pilot', islandId: 'home', cwd: '/Users/l/mc' },
  },
);
const claude = src('global', 'Claude', '/Users/l/.claude');
const codex = src('global', 'Codex', '/Users/l/.codex');
const repoA = src('repo', 'atlas', '/Users/l/code/atlas', { islandIds: ['i1', 'i2'], robotIds: ['c1', 'c2', 'c3'] });
const repoP = src('repo', 'phone', '/Users/l/code/phone', { islandIds: ['i2'], robotIds: ['c4'] });
// a slug nobody stands in: its source is rooted at its own docs folder
const orphan = src('repo', 'gone-0a1b2c3d', '/d/repos/gone-0a1b2c3d', { docs: 'r:/d/repos/gone-0a1b2c3d' });
const isle = (id: string, name: string, robots: string[]) => src('island', name, `/d/islands/${id}`, { islandIds: [id], robotIds: robots });
const chr = (id: string, name: string, islandId: string) => src('robot', name, `/d/robots/${id}`, { islandIds: [islandId], robotIds: [id] });
const all = [claude, codex, repoA, repoP, orphan, isle('i1', 'ATLAS', ['c1', 'c2']), isle('i2', 'mobile', ['c3', 'c4']), isle('i3', 'empty', []), isle('home', 'Mission control', ['h1']),
  chr('c1', 'deep robin', 'i1'), chr('c2', 'violet tern', 'i1'), chr('c3', 'calm otter', 'i2'), chr('c4', 'brisk vole', 'i2'), chr('h1', 'pilot', 'home')];
const ours = src('fleet', 'private', '/Users/l/.svall/docs/fleet', { docs: 'r:/Users/l/.svall/docs/fleet' });
const roles = src('profiles', 'Agent profiles', '/Users/l/.svall/agent-profiles', { agentProfiles: 'r:/Users/l/.svall/agent-profiles' });

describe('whereGroups', () => {
  it('groups sources by tier in ladder order, each with its count', () => {
    expect(whereGroups(all, f, '').map((g) => [g.tier, g.count])).toEqual([['global', 2], ['fleet', 0], ['repo', 3], ['island', 4], ['robot', 5], ['profiles', 0]]);
  });
  it('stands the fleet between global and the repositories, and the agent profiles past the robots', () => {
    expect(whereGroups([roles, ...all, ours], f, '').map((g) => [g.tier, g.count])).toEqual([['global', 2], ['fleet', 1], ['repo', 3], ['island', 4], ['robot', 5], ['profiles', 1]]);
  });
  it('sub-groups robots by island and nothing else', () => {
    const groups = whereGroups(all, f, '');
    expect(groups[4].sections.map((s) => [s.heading, s.sources.map((x) => x.name)])).toEqual([
      ['ATLAS', ['deep robin', 'violet tern']], ['mobile', ['calm otter', 'brisk vole']], ['Mission control', ['pilot']],
    ]);
    expect(groups[2].sections).toEqual([{ sources: [repoA, repoP, orphan] }]);
  });
  it('orders the islands as the fleet does, Mission control last', () => {
    const groups = whereGroups(all, f, '');
    expect(groups[3].sections.map((s) => s.sources.map((x) => x.name))).toEqual([['ATLAS', 'empty', 'mobile', 'Mission control']]);
  });
  it('sorts an island the fleet does not have after the rest', () => {
    const groups = whereGroups([...all, isle('i9', 'stray', [])], f, '');
    expect(groups[3].sections[0].sources.map((x) => x.name)).toEqual(['ATLAS', 'empty', 'mobile', 'Mission control', 'stray']);
  });
  it('filters across every group by name and qualifier, keeping a group with no match at zero', () => {
    const groups = whereGroups(all, f, 'ATLAS');
    expect(groups.map((g) => [g.tier, g.count])).toEqual([['global', 0], ['fleet', 0], ['repo', 1], ['island', 1], ['robot', 0], ['profiles', 0]]);
  });
});

describe('a tier as a Where', () => {
  it('names a tier, and reads it back from nothing else', () => {
    expect(whereTier(tierWhere('repo'))).toBe('repo');
    expect(whereTier(repoA.rootId)).toBeUndefined();
    expect(whereTier(undefined)).toBeUndefined();
  });
  it('is no source: the shelf stands on none, rather than falling back to the first', () => {
    expect(shelfSource({ resources: all, resourcesWhere: tierWhere('island'), fleet: f })).toBeUndefined();
    expect(shelfSource({ resources: all, resourcesWhere: undefined, fleet: f })?.rootId).toBe(claude.rootId);
  });
});

describe('qualifierOf', () => {
  it('is a short path for global and repo, a crew count for an island, a branch or folder for a robot', () => {
    expect(qualifierOf(claude, f)).toBe('~/.claude');
    expect(qualifierOf(repoA, f)).toBe('~/code/atlas');
    expect(qualifierOf(orphan, f)).toBe('no robots here');
    expect(qualifierOf(all[5], f)).toBe('2 robots');
    expect(qualifierOf(isle('i3', 'empty', []), f)).toBe('no robots');
    expect(qualifierOf(isle('x', 'solo', ['c1']), f)).toBe('1 robot');
    expect(qualifierOf(all[9], f)).toBe('worktree-docs');
    expect(qualifierOf(all[12], f)).toBe('~/code/phone');
  });
  it('tells two sources apart when their names differ only by case', () => {
    expect(qualifierOf(repoA, f)).not.toBe(qualifierOf(all[5], f));
  });
  it('says the fleet holds for this window alone', () => {
    expect(qualifierOf(ours, f)).toBe('this window only');
    expect(qualifierOf(roles, f)).toBe('read only by a robot given one');
  });
  it('names the worker a clone is on', () => {
    const onVault = { ...f, machines: { [VAULT]: { name: 'linus-vault', reachable: true, since: 0 } } };
    expect(qualifierOf(src('repo', 'app', '/home/ada/app', { rootId: farRootId(VAULT, '/home/ada/app') }), onVault)).toBe('~/app on linus-vault');
  });
});

describe('kindRows', () => {
  it('lists All and every kind, Docs first, marking the ones with nothing', () => {
    const rows = kindRows(repoA);
    expect(rows.map((r) => r.what).slice(0, 3)).toEqual(['all', 'docs', 'instructions']);
    expect(rows).toHaveLength(11);
  });
  it('offers the card’s own kinds to an island and a robot, and to nothing else', () => {
    const card = ['note', 'agentInstructions', 'links'];
    for (const s of [isle('i1', 'ATLAS', []), chr('c1', 'deep robin', 'i1')]) {
      expect(kindRows(s).map((r) => r.what).slice(0, 5)).toEqual(['all', 'docs', ...card]);
      expect(kindRows(s)).toHaveLength(14);
    }
    for (const s of [claude, repoA]) expect(kindRows(s).map((r) => r.what).filter((w) => card.includes(w))).toEqual([]);
  });
  it('offers agent profiles to their own source alone, and nothing else to it', () => {
    expect(kindRows(roles).map((r) => r.what)).toEqual(['all', 'agentProfiles']);
    for (const s of [claude, ours, repoA, isle('i1', 'ATLAS', []), chr('c1', 'deep robin', 'i1')]) expect(kindRows(s).some((r) => r.what === 'agentProfiles')).toBe(false);
  });
  it('calls the note kind Description on an island, the way the row and the crumb do', () => {
    const label = (s: Parameters<typeof kindRows>[0]) => kindRows(s).find((r) => r.what === 'note')?.label;
    expect(label(isle('i1', 'ATLAS', []))).toBe('Description');
    expect(label(chr('c1', 'deep robin', 'i1'))).toBe('Note');
  });
});

describe('withCard', () => {
  // the card's own fields, on top of what the scan found
  const carded = state(
    { i1: { name: 'ATLAS', description: 'The repo and both worktrees.', instructions: 'Run the by-eye pass.', context: [link('https://github.com/l/svall')] } },
    { c1: { name: 'deep robin', islandId: 'i1', cwd: '/c', note: 'Mobile pass owed.\nThen the docs.', instructions: '', context: [link('https://x.test/a', true), link('/c/plan.md')] } },
  );
  it('gives a robot its note, its instructions and a row a link, in the What column’s order', () => {
    const s = withCard(chr('c1', 'deep robin', 'i1'), carded);
    expect(s.groups.map((g) => [g.kind, g.items.map((i) => i.name)])).toEqual([
      ['note', ['Note']], ['agentInstructions', ['Instructions']], ['links', ['x.test/a', 'plan.md']],
    ]);
    expect(countOf(s, 'all')).toBe(4);
    expect(s.groups[0].items[0].detail).toBe('Mobile pass owed.');
    expect(s.groups[1].items[0].detail).toBe('nothing written');
  });
  it('calls an island’s note its description, and keeps the scan’s docs among the card', () => {
    const docs = { kind: 'docs' as const, items: [{ id: 'd', name: 'plan', reveal: '/x', target: 'file' as const }] };
    const s = withCard(src('island', 'ATLAS', '/d/islands/i1', { islandIds: ['i1'], groups: [docs] }), carded);
    expect(s.groups.map((g) => g.kind)).toEqual(['docs', 'note', 'agentInstructions', 'links']);
    expect(s.groups[1].items[0]).toMatchObject({ name: 'Description', detail: 'The repo and both worktrees.' });
  });
  it('names the entity in a row id, so one island’s chosen row is not another’s', () => {
    const a = withCard(chr('c1', 'deep robin', 'i1'), carded).groups.flatMap((g) => g.items.map((i) => i.id));
    const b = withCard(src('island', 'ATLAS', '/d/islands/i1', { islandIds: ['i1'] }), carded).groups.flatMap((g) => g.items.map((i) => i.id));
    expect(a).toEqual(['card:c1:note', 'card:c1:instructions', 'card:c1:link:0', 'card:c1:link:1']);
    expect(a.filter((id) => b.includes(id))).toEqual([]);
  });
  it('leaves a source with no card, and one whose entity the fleet has lost, as it found them', () => {
    expect(withCard(claude, carded)).toBe(claude);
    expect(withCard(repoA, carded)).toBe(repoA);
    expect(withCard(chr('gone', 'gone', 'i1'), carded).groups).toEqual([]);
  });
});

describe('badgeOf', () => {
  const it_ = (name: string) => ({ name });
  it('marks what is attached to the prompt, what is looked up, and leaves configuration alone', () => {
    expect(badgeOf('instructions', it_('CLAUDE.md'))).toBe('attached');
    expect(badgeOf('agentInstructions', it_('Instructions'))).toBe('attached');
    for (const k of ['note', 'links'] as const) expect(badgeOf(k, it_('x'))).toBeUndefined();
    expect(badgeOf('autoMemory', it_('MEMORY.md'))).toBe('attached');
    expect(badgeOf('autoMemory', it_('plan.md'))).toBe('lookup');
    for (const k of ['docs', 'skills', 'agents', 'commands'] as const) expect(badgeOf(k, it_('x'))).toBe('lookup');
    expect(badgeOf('docs', it_('x'), 'fleet')).toBe('attached');
    expect(badgeOf('docs', it_('x'), 'repo')).toBe('lookup');
    for (const k of ['mcp', 'hooks', 'plugins', 'settings'] as const) expect(badgeOf(k, it_('x'))).toBeUndefined();
  });
});

describe('chainOf', () => {
  const labels = (c: ReturnType<typeof chainOf>) => c?.chips.map((x) => [x.tier, x.label]);
  it('is four chips for a robot, its worktree counted as the repository', () => {
    const chain = chainOf(all, f, all[9]);
    expect(chain?.heading).toBe('deep robin reads, in order');
    expect(labels(chain)).toEqual([['global', 'Claude'], ['repo', 'atlas'], ['island', 'ATLAS'], ['robot', 'deep robin']]);
    expect(chain?.chips[1].rootIds).toEqual([repoA.rootId]);
  });
  it('has no repository chip for mission control’s crew', () => {
    expect(labels(chainOf(all, f, all[13]))).toEqual([['global', 'Claude'], ['island', 'Mission control'], ['robot', 'pilot']]);
  });
  it('names an island’s one repository, counts them when its crew differ, and drops the slot when it has no crew', () => {
    const one = chainOf(all, f, all[5]);
    expect(one?.heading).toBe('a robot here reads');
    expect(labels(one)).toEqual([['global', 'Claude'], ['repo', 'atlas'], ['island', 'ATLAS']]);
    const two = chainOf(all, f, all[6]);
    expect(labels(two)).toEqual([['global', 'Claude'], ['repo', '2 repos'], ['island', 'mobile']]);
    expect(two?.chips[1].rootIds).toEqual([repoA.rootId, repoP.rootId]);
    expect(labels(chainOf(all, f, all[7]))).toEqual([['global', 'Claude'], ['island', 'empty']]);
  });
  it('puts the fleet between the agent’s global source and the repository', () => {
    expect(labels(chainOf([...all, ours], f, all[9]))).toEqual([['global', 'Claude'], ['fleet', 'private'], ['repo', 'atlas'], ['island', 'ATLAS'], ['robot', 'deep robin']]);
    expect(labels(chainOf([...all, ours], f, all[13]))).toEqual([['global', 'Claude'], ['fleet', 'private'], ['island', 'Mission control'], ['robot', 'pilot']]);
    expect(chainOf([...all, ours], f, ours)).toBeUndefined();
    expect(chainOf([...all, ours, roles], f, all[9])?.chips.some((c) => c.tier === 'profiles')).toBe(false);
  });
  it('is nothing for a global or a repository source', () => {
    expect(chainOf(all, f, claude)).toBeUndefined();
    expect(chainOf(all, f, repoA)).toBeUndefined();
  });
  it('takes a placed robot\'s repository from the worker it is on, though this Mac has a clone at the same path', () => {
    const placed = { ...f, robots: { ...f.robots, c1: { ...f.robots.c1, machine: STUDIO } } } as unknown as FleetState;
    const far = src('repo', 'atlas', '/Users/l/code/atlas', { rootId: farRootId(STUDIO, '/Users/l/code/atlas'), islandIds: ['i1'], robotIds: ['c1'] });
    expect(chainOf([...all, far], placed, all[9])?.chips[1].rootIds).toEqual([far.rootId]);
    expect(chainOf([...all, far], placed, all[5])?.chips[1].rootIds).toEqual([far.rootId, repoA.rootId]);
  });
  it('names the global source the robot’s own agent reads', () => {
    const onCodex = { ...f, robots: { ...f.robots, c1: { ...f.robots.c1, agent: { kind: 'codex' } } } } as unknown as FleetState;
    expect(labels(chainOf(all, onCodex, all[9]))?.[0]).toEqual(['global', 'Codex']);
    // an island stands for mixed crew, and a robot with no agent running falls back
    expect(labels(chainOf(all, onCodex, all[5]))?.[0]).toEqual(['global', 'Claude']);
    expect(labels(chainOf(all, onCodex, all[10]))?.[0]).toEqual(['global', 'Claude']);
  });
});

describe('docSlug', () => {
  it('lowercases, hyphenates, and drops a typed .md', () => {
    expect(docSlug('  Native Surfaces.md ')).toBe('native-surfaces');
    expect(docSlug('branch_plan v2')).toBe('branch-plan-v2');
  });
  it('keeps a letter that carries an accent, dropping only the accent', () => {
    expect(docSlug('Städning')).toBe('stadning');
    expect(docSlug('Åtgärder v2')).toBe('atgarder-v2');
  });
  it('refuses a name with nothing left in it', () => {
    expect(docSlug('   ')).toBeUndefined();
    expect(docSlug('—.md')).toBeUndefined();
  });
});

describe('isDoc', () => {
  const source = (docs?: string) => ({ rootId: 'r:/x', root: '/x', name: 'x', tier: 'island', islandIds: [], robotIds: [], groups: [], ...(docs && { docs }) }) as ResourceSource;
  it('is a .md directly in a folder that takes docs', () => {
    expect(isDoc([source('r:/d/islands/i1')], 'r:/d/islands/i1', 'plan.md')).toBe(true);
  });
  it('is not a file in a subfolder, another extension, or another root', () => {
    expect(isDoc([source('r:/d/islands/i1')], 'r:/d/islands/i1', 'sub/plan.md')).toBe(false);
    expect(isDoc([source('r:/d/islands/i1')], 'r:/d/islands/i1', 'plan.txt')).toBe(false);
    expect(isDoc([source('r:/d/islands/i1')], 'r:/repo', 'README.md')).toBe(false);
  });
});

describe('docsOf', () => {
  it('finds an entity’s source and its docs', () => {
    const items = [{ id: 'a', name: 'plan', detail: 'What is left.', reveal: '/x', target: 'file' as const }];
    const withDocs = [...all.slice(0, 9), { ...all[9], groups: [{ kind: 'docs' as const, items }] }];
    expect(docsOf(withDocs, 'robot', 'c1')).toEqual({ source: withDocs[9], items });
    expect(docsOf(all, 'island', 'i1').items).toEqual([]);
    expect(docsOf(all, 'island', 'nope')).toEqual({ source: undefined, items: [] });
  });
});
