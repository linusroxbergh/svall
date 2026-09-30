import { describe, expect, it } from 'vitest';
import { DEFAULT_CWD, emptyState } from '@svall/protocol';
import { deleteCharacter, deleteIsland, moveCharacterTo, newCharacterOn, newCharacterTarget, newNamedCharacter, openSecondTerminal, reviveCharacter, saveCharacter, saveIsland, serveFleet, skillPrompt, startHomeAction, startHomeCharacter } from '../src/actions.js';
import { ApiError, type Api } from '../src/api.js';
import { createAppStore } from '../src/store/index.js';
import { chr, fleet, isl } from './fixtures.js';

function ctx() {
  const calls: { method: string; params: unknown }[] = [];
  const api = {
    call: (method: string, params: unknown) => {
      calls.push({ method, params });
      return Promise.resolve(method === 'island.create' ? isl('i_new', 'home', 0) : {});
    },
  } as unknown as Api;
  const store = createAppStore(undefined);
  store.getState().setFleet(fleet());
  return { calls, api, store };
}

describe('newCharacterTarget', () => {
  it('lands beside the selected character, in its cwd', async () => {
    const c = ctx();
    c.store.getState().setView('board');
    c.store.getState().select('c1');
    expect(await newCharacterTarget(c)).toEqual({ islandId: 'i_b', cwd: '/tmp' });
  });

  it('takes the cwd of the character it is beside, not the island first character', async () => {
    const c = ctx();
    c.store.getState().setView('board');
    c.store.getState().applyPatch([{ op: 'replace', path: '/characters/c1/cwd', value: '/other' }]);
    c.store.getState().select('c1');
    expect(await newCharacterTarget(c)).toEqual({ islandId: 'i_b', cwd: '/other' });
  });

  it('starts in the repo when the character it is beside sits in a worktree', async () => {
    const c = ctx();
    c.store.getState().setView('board');
    c.store.getState().applyPatch([
      { op: 'replace', path: '/characters/c1/cwd', value: '/repo/.worktrees/wip' },
      { op: 'add', path: '/characters/c1/repo', value: { root: '/repo/.worktrees/wip', mainRoot: '/repo', branch: 'wip', isWorktree: true } },
    ]);
    c.store.getState().select('c1');
    expect(await newCharacterTarget(c)).toEqual({ islandId: 'i_b', cwd: '/repo' });
  });

  it('falls back to the first character with nothing selected', async () => {
    const c = ctx();
    c.store.getState().setView('board');
    expect(await newCharacterTarget(c)).toEqual({ islandId: 'i_a', cwd: '/tmp' });
  });

  it('prefers the island selected on the map, in the fleet default cwd when it has no crew', async () => {
    const c = ctx();
    c.store.getState().selectIsland('i_e');
    expect(await newCharacterTarget(c)).toEqual({ islandId: 'i_e', cwd: DEFAULT_CWD });
  });

  it('prefers the island selected on the board', async () => {
    const c = ctx();
    c.store.getState().setView('board');
    c.store.getState().selectIsland('i_e');
    expect(await newCharacterTarget(c)).toEqual({ islandId: 'i_e', cwd: DEFAULT_CWD });
  });

  it('creates an island named after the default cwd when mission control is the only one', async () => {
    const c = ctx();
    c.store.getState().setView('board');
    c.store.getState().setFleet({ ...emptyState(), islands: { home: isl('home', 'mission control', 0, { kind: 'home' }) } });
    expect(await newCharacterTarget(c)).toEqual({ islandId: 'i_new', cwd: DEFAULT_CWD });
    expect(c.calls).toEqual([{ method: 'island.create', params: { name: 'island' } }]);
  });
});

describe('moveCharacterTo', () => {
  it('joins an island through its header or inserts beside a character', () => {
    const c = ctx();
    moveCharacterTo(c, 'c1', { kind: 'island', id: 'i_a' });
    moveCharacterTo(c, 'c1', { kind: 'char', id: 'c2' });
    expect(c.calls).toEqual([
      { method: 'char.move', params: { id: 'c1', islandId: 'i_a' } },
      { method: 'char.reorder', params: { id: 'c1', targetId: 'c2', after: false } },
    ]);
  });

  it('ignores a character dropped on itself', () => {
    const c = ctx();
    moveCharacterTo(c, 'c1', { kind: 'char', id: 'c1' });
    expect(c.calls).toEqual([]);
  });

  it('inserts a character within its island instead of swapping cells', () => {
    const c = ctx();
    moveCharacterTo(c, 'c1', { kind: 'char', id: 'c0' }, false);
    expect(c.calls).toEqual([{ method: 'char.reorder', params: { id: 'c1', targetId: 'c0', after: false } }]);
  });
});

describe('newNamedCharacter', () => {
  const created = (calls: { method: string; params: unknown }[]) => ({
    call: (method: string, params: unknown) => {
      calls.push({ method, params });
      return Promise.resolve(method === 'char.create' ? { id: 'c_new' } : {});
    },
  } as unknown as Api);

  it('creates the character alone when it has neither note nor links', async () => {
    const calls: { method: string; params: unknown }[] = [];
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    store.getState().selectIsland('i_a');
    expect(await newNamedCharacter({ api: created(calls), store }, { name: 'scribe', note: '', refs: [] })).toBe('c_new');
    expect(calls).toEqual([{ method: 'char.create', params: { islandId: 'i_a', cwd: '/tmp', name: 'scribe' } }]);
  });

  it('writes the note and the links on once the character exists, each link under its own kind', async () => {
    const calls: { method: string; params: unknown }[] = [];
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    store.getState().selectIsland('i_a');
    await newNamedCharacter({ api: created(calls), store }, { name: '', note: 'read the spec', refs: ['~/spec.md', 'https://example.com/x'] });
    expect(calls).toEqual([
      { method: 'char.create', params: { islandId: 'i_a', cwd: '/tmp' } },
      { method: 'char.update', params: { id: 'c_new', note: 'read the spec', context: [
        { kind: 'file', ref: '~/spec.md', label: '', source: 'manual' },
        { kind: 'other', ref: 'https://example.com/x', label: '', source: 'manual' },
      ] } },
    ]);
  });

  it('keeps the character and toasts when the fleet refuses the note', async () => {
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    const api = {
      call: (method: string) => (method === 'char.create' ? Promise.resolve({ id: 'c_new' }) : Promise.reject(new Error('no such path'))),
    } as unknown as Api;
    expect(await newNamedCharacter({ api, store }, { name: 'scribe', note: 'read the spec', refs: [] })).toBe('c_new');
    expect(store.getState().toast).toEqual({ text: 'no such path', tone: 'error' });
  });
});

describe('a write the fleet refuses', () => {
  // fire swallows the failure, as the real socket's does, so only a call can report it
  const refusing = () => {
    const api = { call: () => Promise.reject(new Error('svalld offline')), fire: () => {} } as unknown as Api;
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    return { api, store };
  };

  it('is reported on a toast when it saves, revives or deletes', async () => {
    type D = ReturnType<typeof refusing>;
    for (const act of [(d: D) => saveCharacter(d, 'c0', { name: 'x' }), (d: D) => saveIsland(d, 'i_a', { name: 'x' }),
      (d: D) => reviveCharacter(d, 'c0'), (d: D) => deleteCharacter(d, 'c0'), (d: D) => deleteIsland(d, 'i_e')]) {
      const d = refusing();
      act(d);
      await new Promise((r) => setTimeout(r, 0));
      expect(d.store.getState().toast?.text).toBe('svalld offline');
    }
  });
});

describe('openSecondTerminal', () => {
  it('closes the pane that waited on a second terminal the fleet did not open', async () => {
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    store.getState().setPanes('c0', { left: 'browser', right: 'terminal2' });
    openSecondTerminal({ api: { call: () => Promise.reject(new Error('svalld offline')) } as unknown as Api, store }, 'c0');
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().ide.c0.panes).toEqual({ left: 'browser' });
    expect(store.getState().toast?.text).toBe('svalld offline');
  });
});

describe('an edit that never reached the fleet', () => {
  // the field that held it may be gone by the time the answer comes, so the toast keeps it to send again
  it('is kept on the toast to send again once svalld is back', async () => {
    const sent: unknown[] = [];
    let online = false;
    const api = { call: (_m: string, params: unknown) => { sent.push(params); return online ? Promise.resolve({}) : Promise.reject(new Error('svalld offline')); } } as unknown as Api;
    type D = Parameters<typeof saveCharacter>[0];
    for (const save of [(d: D) => saveCharacter(d, 'c0', { note: 'half a thought' }), (d: D) => saveIsland(d, 'i_a', { description: 'half a thought' })]) {
      online = false;
      sent.length = 0;
      const store = createAppStore(undefined);
      save({ api, store });
      await new Promise((r) => setTimeout(r, 0));
      expect(store.getState().toast).toMatchObject({ text: 'svalld offline', action: { label: 'Retry' } });
      online = true;
      store.getState().runToastAction();
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual(sent[0]);
    }
  });

  it('is not offered again when the fleet refused it', async () => {
    const api = { call: () => Promise.reject(new ApiError('invalid', 'another character is already called x')) } as unknown as Api;
    const store = createAppStore(undefined);
    saveCharacter({ api, store }, 'c0', { name: 'x' });
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().toast).toEqual({ text: 'another character is already called x', tone: 'error' });
  });
});

describe('a crew member whose directory is gone', () => {
  type Call = { method: string; params: { cwd?: string } };
  // svalld's refusal of a cwd that is not a directory, as a removed worktree is
  const goneDir = (calls: Call[], message = 'cwd /tmp is not a directory') => ({
    call: (method: string, params: { cwd?: string }) => {
      calls.push({ method, params });
      if (method === 'char.create' && params.cwd !== DEFAULT_CWD) return Promise.reject(new ApiError('invalid', message));
      return Promise.resolve({ id: 'c_new', name: 'c_new' });
    },
  } as unknown as Api);
  const store = () => { const s = createAppStore(undefined); s.getState().setFleet(fleet()); return s; };

  it('leaves a new character on its island to start in the fleet default', async () => {
    const calls: Call[] = [];
    const s = store();
    await newCharacterOn({ api: goneDir(calls), store: s }, 'i_b');
    expect(calls.map((c) => c.params)).toEqual([{ islandId: 'i_b', cwd: '/tmp' }, { islandId: 'i_b', cwd: DEFAULT_CWD }]);
    expect(s.getState().toast).toBeUndefined();
  });

  it('leaves a named character beside it to start in the fleet default', async () => {
    const calls: Call[] = [];
    const s = store();
    s.getState().selectIsland('i_a');
    expect(await newNamedCharacter({ api: goneDir(calls), store: s }, { name: 'scribe', note: '', refs: [] })).toBe('c_new');
    expect(calls.map((c) => c.params)).toEqual([{ islandId: 'i_a', cwd: '/tmp', name: 'scribe' }, { islandId: 'i_a', cwd: DEFAULT_CWD, name: 'scribe' }]);
  });

  it('reports any other refusal without a second try', async () => {
    const calls: Call[] = [];
    const s = store();
    await newCharacterOn({ api: goneDir(calls, 'island i_b is full'), store: s }, 'i_b');
    expect(calls).toHaveLength(1);
    expect(s.getState().toast?.text).toBe('island i_b is full');
  });
});

describe('deleteIsland', () => {
  it('keeps the island selected when the fleet refuses, and lets it go once it is gone', async () => {
    const refused = { api: { call: () => Promise.reject(new Error('island i_e has crew')) } as unknown as Api, store: createAppStore(undefined) };
    refused.store.getState().setFleet(fleet());
    refused.store.getState().selectIsland('i_e');
    deleteIsland(refused, 'i_e');
    await new Promise((r) => setTimeout(r, 0));
    expect(refused.store.getState().selectedIslandId).toBe('i_e');
    expect(refused.store.getState().toast?.text).toBe('island i_e has crew');

    const c = ctx();
    c.store.getState().selectIsland('i_e');
    deleteIsland(c, 'i_e');
    await new Promise((r) => setTimeout(r, 0));
    expect(c.store.getState().selectedIslandId).toBeUndefined();
  });
});

describe('serveFleet', () => {
  const status = (over: Record<string, unknown> = {}) => ({ serving: true, url: 'https://x.ts.net', port: 8443, logins: [], phones: [], ...over });

  it('takes the status the daemon answers with', async () => {
    const store = createAppStore(undefined);
    const api = { call: () => Promise.resolve(status()) } as unknown as Api;
    await serveFleet({ api, store }, true);
    expect(store.getState().mobile).toEqual(status());
    expect(store.getState().toast).toBeUndefined();
  });

  // a link that cannot be made resolves carrying its reason, so the success path has to toast too
  it('toasts the reason when the status carries one', async () => {
    const store = createAppStore(undefined);
    const api = { call: () => Promise.resolve(status({ serving: false, error: 'tailscale is not logged in' })) } as unknown as Api;
    await serveFleet({ api, store }, true);
    expect(store.getState().toast).toEqual({ text: 'tailscale is not logged in', tone: 'error' });
    expect(store.getState().mobileOpen).toBe(false);
  });

  it('toasts a rejection as well', async () => {
    const store = createAppStore(undefined);
    const api = { call: () => Promise.reject(new Error('svalld is gone')) } as unknown as Api;
    await serveFleet({ api, store }, false);
    expect(store.getState().toast).toEqual({ text: 'svalld is gone', tone: 'error' });
  });
});

describe('skillPrompt', () => {
  it("sends a button's skill to a codex crew as $name, and anything else as it is", () => {
    expect(skillPrompt('codex', '/svall-status')).toBe('$svall-status');
    expect(skillPrompt('codex -m gpt-6-luna', '/svall-organise now')).toBe('$svall-organise now');
    expect(skillPrompt('claude --model sonnet', '/svall-status')).toBe('/svall-status');
    expect(skillPrompt('codex', '/tmp/x is full')).toBe('/tmp/x is full');
    expect(skillPrompt('codex', 'regroup')).toBe('regroup');
  });
});

describe('home', () => {
  it('a new character on home takes the home cwd', async () => {
    const c = ctx();
    c.store.getState().selectIsland('home');
    expect(await newCharacterTarget(c)).toEqual({ islandId: 'home', cwd: '/mc' });
  });

  it('startHomeAction spawns a crew member with the command and prompt, and toasts', async () => {
    const calls: { method: string; params: unknown }[] = [];
    const api = { call: (method: string, params: unknown) => { calls.push({ method, params }); return Promise.resolve({ id: 'c_new', name: 'organise', runSent: true }); } } as unknown as Api;
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    await startHomeAction({ api, store }, { label: 'organise', prompt: '/svall-organise' });
    expect(calls).toEqual([{ method: 'char.create', params: { islandId: 'home', cwd: '/mc', name: 'organise', command: 'claude --model sonnet', run: '/svall-organise' } }]);
    expect(store.getState().selectedId).toBe('c_new');
    expect(store.getState().toast).toEqual({ text: 'organise started', tone: 'ok' });
  });

  it("starts a codex crew member on the button's skill as $name", async () => {
    const calls: { method: string; params: unknown }[] = [];
    const api = { call: (method: string, params: unknown) => { calls.push({ method, params }); return Promise.resolve({ id: 'c_new', name: 'organise', runSent: true }); } } as unknown as Api;
    const store = createAppStore(undefined);
    store.getState().setFleet({ ...fleet(), home: { ...fleet().home, command: 'codex' } });
    await startHomeAction({ api, store }, { label: 'organise', prompt: '/svall-organise' });
    expect(calls[0].params).toMatchObject({ command: 'codex', run: '$svall-organise', name: 'organise' });
  });

  it('names the crew member as the fleet named it, when the label was already taken', async () => {
    const api = { call: () => Promise.resolve({ id: 'c_new', name: 'status 2', runSent: true }) } as unknown as Api;
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    await startHomeAction({ api, store }, { label: 'status', prompt: '/svall-status' });
    expect(store.getState().toast?.text).toBe('status 2 started');
  });

  it('says so when the prompt was not sent, and keeps it on the toast to send', async () => {
    const sent: unknown[] = [];
    const api = {
      call: (method: string, params: unknown) => {
        if (method !== 'char.run') return Promise.resolve({ id: 'c_new', name: 'rename', runSent: false });
        sent.push({ method, params });
        return Promise.reject(new Error('c_new is dormant; revive it first'));
      },
      fire: () => {},
    } as unknown as Api;
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    await startHomeAction({ api, store }, { label: 'rename', prompt: '/svall-rename' });
    const toast = store.getState().toast;
    expect(toast?.text).toBe('rename started, prompt not sent');
    expect(toast?.action?.label).toBe('Send it');
    store.getState().runToastAction();
    expect(sent).toStrictEqual([{ method: 'char.run', params: { id: 'c_new', text: '/svall-rename', enter: true } }]);
    // a send refused this time is said so too
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().toast?.text).toBe('c_new is dormant; revive it first');
  });

  it('a free prompt starts an unnamed crew member and toasts with the name it got', async () => {
    const calls: { method: string; params: unknown }[] = [];
    const api = { call: (method: string, params: unknown) => { calls.push({ method, params }); return Promise.resolve({ id: 'c_new', name: 'bright otter', runSent: true }); } } as unknown as Api;
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    await startHomeCharacter({ api, store }, { prompt: 'regroup the fleet' });
    expect(calls).toStrictEqual([{ method: 'char.create', params: { islandId: 'home', cwd: '/mc', command: 'claude --model sonnet', run: 'regroup the fleet' } }]);
    expect(store.getState().toast).toEqual({ text: 'bright otter started', tone: 'ok' });
  });

  it('says so when svalld does not find the CLI mission control runs, and still starts the crew member', async () => {
    const calls: { method: string; params: unknown }[] = [];
    const api = { call: (method: string, params: unknown) => { calls.push({ method, params }); return Promise.resolve({ id: 'c_new', name: 'bright otter', runSent: true }); } } as unknown as Api;
    const store = createAppStore(undefined);
    store.getState().setFleet({ ...fleet(), agentsFound: ['codex'] });
    expect(await startHomeCharacter({ api, store }, { prompt: 'regroup the fleet' })).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['char.create']);
    expect(store.getState().toast).toEqual({ text: "Mission control runs claude, which svalld doesn't find. Install it, then run svall-dev setup.", tone: 'error' });
  });

  it('reports failure and toasts when the fleet refuses', async () => {
    const api = { call: () => Promise.reject(new Error('no such island')) } as unknown as Api;
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    expect(await startHomeCharacter({ api, store }, { prompt: 'regroup the fleet' })).toBe(false);
    expect(store.getState().toast).toEqual({ text: 'no such island', tone: 'error' });
  });

  it('does not steal a selection the user made while the agent was starting', async () => {
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    const api = {
      call: () => new Promise((r) => setTimeout(() => r({ id: 'c_new', name: 'bright otter', runSent: true }), 0)),
    } as unknown as Api;
    const started = startHomeCharacter({ api, store }, { prompt: 'regroup the fleet' });
    store.getState().select('c1');
    await started;
    expect(store.getState().selectedId).toBe('c1');
  });

  it('selects the crew member as soon as the mirror has it, without waiting for the agent', async () => {
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    let settle = (v: unknown) => { void v; };
    const api = { call: () => new Promise((r) => { settle = r; }) } as unknown as Api;
    const started = startHomeCharacter({ api, store }, { prompt: 'regroup the fleet' });
    // the daemon's patch lands long before it answers
    const f = fleet();
    f.characters.c_new = chr('c_new', 'home', { x: 1, y: 1 });
    store.getState().setFleet(f);
    expect(store.getState().selectedId).toBe('c_new');
    settle({ id: 'c_new', name: 'bright otter', runSent: true });
    await started;
    expect(store.getState().selectedId).toBe('c_new');
  });

  // the card of the one gone back to may hold a field being typed in, which a selection move would drop
  it('leaves the user on a character they went back to while the agent was starting', async () => {
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    store.getState().select('c0');
    let settle = (v: unknown) => { void v; };
    const api = { call: () => new Promise((r) => { settle = r; }) } as unknown as Api;
    const started = startHomeCharacter({ api, store }, { prompt: 'regroup the fleet' });
    const f = fleet();
    f.characters.c_new = chr('c_new', 'home', { x: 1, y: 1 });
    store.getState().setFleet(f);
    expect(store.getState().selectedId).toBe('c_new');
    store.getState().select('c0');
    settle({ id: 'c_new', name: 'bright otter', runSent: true });
    await started;
    expect(store.getState().selectedId).toBe('c0');
  });

  it('leaves a selection the user made before the crew member arrived', async () => {
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    const api = { call: () => new Promise(() => {}) } as unknown as Api;
    void startHomeCharacter({ api, store }, { prompt: 'regroup the fleet' });
    store.getState().select('c1');
    const f = fleet();
    f.characters.c_new = chr('c_new', 'home', { x: 1, y: 1 });
    store.getState().setFleet(f);
    expect(store.getState().selectedId).toBe('c1');
  });

  it('selects the new crew member when the user picked nothing meanwhile', async () => {
    const store = createAppStore(undefined);
    store.getState().setFleet(fleet());
    const api = { call: () => Promise.resolve({ id: 'c_new', name: 'bright otter', runSent: true }) } as unknown as Api;
    await startHomeCharacter({ api, store }, { prompt: 'regroup the fleet' });
    expect(store.getState().selectedId).toBe('c_new');
  });
});
