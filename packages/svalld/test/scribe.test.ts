import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentStatus, Character, Island } from '@svall/protocol';
import { briefDiff, briefReply, renderBrief } from '../src/context/brief.js';
import type { DocFolder } from '../src/docs.js';
import { silentLogger, type Logger } from '../src/log.js';
import { REST_BYTES, REST_MS } from '../src/scribe/eligible.js';
import { RETRY_MS, SETTLE_MS, SPACING_MS, Scribe } from '../src/scribe/scribe.js';
import { Store } from '../src/store.js';
import { cleanHomes, makeHome } from './helpers.js';

const T0 = 1_000_000_000;
const settle = async () => { for (let n = 0; n < 5; n++) await new Promise((r) => setImmediate(r)); };

type Call = { system: string; prompt: string };

function world(answers: (call: Call) => string | Promise<string>, brief: (island: Island, character: Character) => string = (i, c) => renderBrief(i, c), log: Logger = silentLogger) {
  const home = makeHome();
  const store = Store.load(path.join(home, 'state.json'), () => {});
  let now = T0;
  const calls: Call[] = [];
  const scribe = new Scribe({
    store, log, now: () => now, brief,
    run: async (system, prompt) => { calls.push({ system, prompt }); return answers({ system, prompt }); },
  });
  store.update((d) => { delete d.scribeAsk; });
  const island = (id: string, extra: Partial<Island> = {}) => store.update((d) => {
    d.islands[id] = { id, name: id, description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 8, h: 6 }, seed: 1, ...extra };
  });
  const char = (id: string, extra: Partial<Character> & { status?: AgentStatus; quietMs?: number; bytes?: number } = {}) => {
    const { status = 'done', quietMs = REST_MS, bytes = 4000, ...rest } = extra;
    const transcriptPath = path.join(home, `${id}.jsonl`);
    const line = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    fs.writeFileSync(transcriptPath, [line('working on https://docs.example/plan'), line('x'.repeat(bytes))].join('\n') + '\n');
    store.update((d) => {
      d.characters[id] = {
        id, islandId: 'i1', cell: { x: 0, y: 0 }, name: 'golden heron', portrait: 'fox', note: '', instructions: '', cwd: '/repo', context: [],
        tmux: { windowId: `@${id}`, paneId: `%${id}` }, shell: { lastOutputAt: 0 }, unread: false,
        agent: { kind: 'claude', sessionId: 's', transcriptPath, status, lastActivityAt: now - quietMs },
        ...rest,
      };
    });
  };
  return { store, scribe, calls, island, char, advance: (ms: number) => { now += ms; } };
}

const answer = (o: object) => () => JSON.stringify(o);

afterEach(() => cleanHomes());

describe('Scribe, automatically', () => {
  it('names, notes and links a character at rest, then describes its island once it settles', async () => {
    const w = world(({ system }) => system.includes('island')
      ? JSON.stringify({ description: 'the docs rewrite' })
      : JSON.stringify({ name: { value: 'docs plan', reason: 'generated' }, note: 'drafting the plan', links: [{ url: 'https://docs.example/plan', label: 'plan' }] }));
    w.island('i1');
    w.char('a');
    w.scribe.tick();
    await settle();
    const a = w.store.state.characters.a;
    expect(a.name).toBe('docs plan');
    expect(a.note).toBe('drafting the plan');
    expect(a.context).toEqual([{ kind: 'other', ref: 'https://docs.example/plan', label: 'plan', source: 'scribe' }]);
    expect(w.calls[0].prompt).toContain('Name: golden heron (generated placeholder)');

    w.advance(SETTLE_MS);
    w.scribe.tick();
    await settle();
    expect(w.store.state.islands.i1.description).toBe('the docs rewrite');
    expect(w.calls[1].prompt).toContain('- docs plan | /repo | drafting the plan');
  });

  it('leaves a character alone until it has rested and grown', async () => {
    const w = world(answer({ note: 'x' }));
    w.island('i1');
    w.char('busy', { status: 'working', quietMs: 0 });
    w.char('fresh', { quietMs: REST_MS - 1 });
    w.char('small', { bytes: 100 });
    w.char('waiting', { status: 'blocked' });
    w.scribe.tick();
    await settle();
    expect(w.calls).toEqual([]);
  });

  it('runs one pass at a time, a minute apart, and not again without new transcript', async () => {
    const w = world(answer({ note: 'x' }));
    w.island('i1');
    w.char('a');
    w.char('b');
    w.scribe.tick();
    await settle();
    w.scribe.tick();
    await settle();
    expect(w.calls).toHaveLength(1);
    w.advance(SPACING_MS - 1);
    w.scribe.tick();
    await settle();
    expect(w.calls).toHaveLength(1);
    w.advance(1);
    w.scribe.tick();
    await settle();
    expect(w.calls).toHaveLength(2);
    w.advance(SPACING_MS);
    w.scribe.tick();
    await settle();
    expect(w.calls.filter((c) => c.system.includes('coding agent\'s work'))).toHaveLength(2);
  });

  it('does nothing when switched off', async () => {
    const w = world(answer({ note: 'x' }));
    w.store.update((d) => { d.scribeOff = true; });
    w.island('i1');
    w.char('a');
    w.scribe.tick();
    await settle();
    expect(w.calls).toEqual([]);
  });

  it('waits while a new fleet has not chosen to turn it on or off', async () => {
    const w = world(answer({ note: 'x' }));
    w.store.update((d) => { d.scribeAsk = true; });
    w.island('i1');
    w.char('a');
    w.scribe.tick();
    await settle();
    expect(w.calls).toEqual([]);
  });

  it('passes a character again once it starts a new, smaller session', async () => {
    const w = world(answer({ note: 'x' }));
    w.island('i1');
    w.char('a', { bytes: 50_000 });
    w.scribe.tick();
    await settle();
    const fresh = path.join(path.dirname(w.store.state.characters.a.agent!.transcriptPath!), 'a-new.jsonl');
    fs.writeFileSync(fresh, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'y'.repeat(3000) }] } })}\n`);
    w.store.update((d) => { d.characters.a.agent!.transcriptPath = fresh; });
    w.advance(SPACING_MS);
    w.scribe.tick();
    await settle();
    expect(w.calls).toHaveLength(2);
  });

  it('takes a transcript it finds at a daemon start as seen, until it grows', async () => {
    const w = world(answer({ note: 'x' }));
    w.island('i1');
    w.char('a');
    const calls: Call[] = [];
    const restarted = new Scribe({
      store: w.store, log: silentLogger, now: () => T0, brief: (i, c) => renderBrief(i, c),
      run: async (system, prompt) => { calls.push({ system, prompt }); return '{"note":"x"}'; },
    });
    restarted.tick();
    await settle();
    expect(calls).toEqual([]);
    fs.appendFileSync(w.store.state.characters.a.agent!.transcriptPath!, 'y'.repeat(REST_BYTES) + '\n');
    restarted.tick();
    await settle();
    expect(calls).toHaveLength(1);
  });

  it('starts over a state holding a transcript path no file can have', async () => {
    const w = world(answer({ note: 'x' }));
    w.island('i1');
    for (const [id, transcriptPath] of [['a', `/${'x'.repeat(5000)}.jsonl`], ['b', `/tmp/${'x'.repeat(300)}.jsonl`]]) {
      w.char(id);
      w.store.update((d) => { d.characters[id].agent!.transcriptPath = transcriptPath; });
    }
    const restarted = new Scribe({ store: w.store, log: silentLogger, now: () => T0, brief: (i, c) => renderBrief(i, c), run: async () => '{}' });
    restarted.tick();
    await settle();
  });

  it('skips a queued character that is waiting on the user by its turn', async () => {
    const w = world(answer({ note: 'x' }));
    w.island('i1');
    w.char('a');
    w.char('b');
    w.scribe.tick();
    await settle();
    w.store.update((d) => { d.characters.b.agent!.status = 'blocked'; });
    w.advance(SPACING_MS);
    w.scribe.tick();
    await settle();
    expect(w.calls.filter((c) => c.prompt.startsWith('Name:'))).toHaveLength(1);
    expect(w.store.state.characters.b.note).toBe('');
  });

  it('links an island to what its members link once a member\'s links change, and keeps that out of the next prompt', async () => {
    const w = world(({ system }) => system.includes('island')
      ? JSON.stringify({ links: [{ url: 'https://docs.example/plan', label: 'plan' }, { url: 'https://invented.example', label: 'x' }] })
      : JSON.stringify({ links: [{ url: 'https://docs.example/plan', label: 'plan' }] }));
    w.island('i1');
    w.char('a');
    w.store.update((d) => { d.characters.a.agent!.brief = renderBrief(d.islands.i1, d.characters.a); });
    w.scribe.tick();
    await settle();
    w.advance(SETTLE_MS);
    w.scribe.tick();
    await settle();
    const s = w.store.state;
    expect(w.calls.at(-1)!.prompt).toContain('  - scribe plan https://docs.example/plan');
    expect(s.islands.i1.context).toEqual([{ kind: 'other', ref: 'https://docs.example/plan', label: 'plan', source: 'scribe' }]);
    expect(briefReply('UserPromptSubmit', renderBrief(s.islands.i1, s.characters.a), s.characters.a.agent!.brief)).toEqual({});
  });

  it('keeps its change out of a session that has been given no brief yet', async () => {
    const w = world(answer({ note: 'scribe note' }));
    w.island('i1');
    w.char('a');
    w.scribe.tick();
    await settle();
    const s = w.store.state;
    expect(s.characters.a.note).toBe('scribe note');
    expect(briefReply('UserPromptSubmit', renderBrief(s.islands.i1, s.characters.a), s.characters.a.agent!.brief)).toEqual({});
  });

  it('keeps the links it finds out of the next prompt, and gives them to a session that starts again', async () => {
    const w = world(answer({ links: [{ url: 'https://docs.example/plan', label: 'plan' }] }));
    w.island('i1');
    w.char('a', { note: 'before' });
    w.store.update((d) => { d.characters.a.agent!.brief = renderBrief(d.islands.i1, d.characters.a); });
    w.scribe.tick();
    await settle();
    const s = w.store.state;
    const brief = renderBrief(s.islands.i1, s.characters.a);
    expect(briefReply('UserPromptSubmit', brief, s.characters.a.agent!.brief)).toEqual({});
    expect(briefReply('SessionStart', brief, s.characters.a.agent!.brief).reply).toContain('https://docs.example/plan');
  });

  it('keeps a hand-written note and still names the character', async () => {
    const w = world(answer({ name: { value: 'docs plan', reason: 'generated' }, note: 'something else' }));
    w.island('i1');
    w.char('a', { note: 'mine', noteSource: 'manual' });
    w.scribe.tick();
    await settle();
    expect(w.store.state.characters.a).toMatchObject({ name: 'docs plan', note: 'mine', noteSource: 'manual' });
    expect(w.calls[0].prompt).toContain('Note (hand-written): mine');
  });

  it('lets an edit made during the pass win', async () => {
    let w!: ReturnType<typeof world>;
    w = world(() => {
      w.store.update((d) => { d.characters.a.name = 'my name'; d.characters.a.note = 'typed meanwhile'; });
      return JSON.stringify({ name: { value: 'docs plan', reason: 'generated' }, note: 'scribe note' });
    });
    w.island('i1');
    w.char('a');
    w.scribe.tick();
    await settle();
    expect(w.store.state.characters.a).toMatchObject({ name: 'my name', note: 'typed meanwhile' });
  });

  it('holds off a failing character longer each time, and shows the failure until a pass succeeds', async () => {
    let fail = true;
    const w = world(() => { if (fail) throw new Error('not logged in\nrun claude'); return JSON.stringify({ note: 'third try' }); });
    w.island('i1');
    w.char('a');
    w.scribe.tick();
    await settle();
    expect(w.store.state.characters.a.note).toBe('');
    expect(w.store.state.scribeError).toEqual({ message: 'not logged in', at: T0 });
    w.advance(RETRY_MS - 1);
    w.scribe.tick();
    await settle();
    expect(w.calls).toHaveLength(1);
    w.advance(1);
    w.scribe.tick();
    await settle();
    expect(w.calls).toHaveLength(2);
    fail = false;
    w.advance(2 * RETRY_MS - 1);
    w.scribe.tick();
    await settle();
    expect(w.calls).toHaveLength(2);
    w.advance(1);
    w.scribe.tick();
    await settle();
    expect(w.store.state.characters.a.note).toBe('third try');
    expect(w.store.state).not.toHaveProperty('scribeError');
  });

  it('shows the stderr a failed pass printed, and keeps it out of the log', async () => {
    const logged: string[] = [];
    const w = world(() => { throw new Error('claude -p exited 1', { cause: 'Invalid API key' }); }, undefined, { info: () => {}, error: (m) => logged.push(m) });
    w.island('i1');
    w.char('a');
    w.scribe.tick();
    await settle();
    expect(w.store.state.scribeError).toEqual({ message: 'claude -p exited 1: Invalid API key', at: T0 });
    expect(logged).toContain('scribe: golden heron: claude -p exited 1');
    expect(logged.join('\n')).not.toContain('Invalid API key');
  });

  it('never passes mission control, and keeps a hand-written description while it links the island', async () => {
    const w = world(answer({ note: 'x', description: 'nope', links: [{ url: 'https://docs.example/plan', label: 'plan' }] }));
    w.island('home', { kind: 'home' });
    w.island('i1', { description: 'mine', descriptionSource: 'manual' });
    w.char('crew', { islandId: 'home' });
    w.char('a');
    w.scribe.tick();
    await settle();
    w.advance(SPACING_MS);
    w.scribe.tick();
    await settle();
    expect(w.store.state.characters.crew.note).toBe('x');
    w.advance(SETTLE_MS);
    w.scribe.tick();
    await settle();
    expect(w.store.state.islands.i1).toMatchObject({ description: 'mine', context: [{ ref: 'https://docs.example/plan' }] });
    expect(w.store.state.islands.home).toMatchObject({ description: '', context: [] });
    expect(w.calls.filter((c) => c.system.includes('island')).map((c) => c.prompt.split('\n')[0])).toEqual(['Island: i1']);
  });

  it('keeps its own change out of the next prompt while another pending change still gets there', async () => {
    const w = world(answer({ note: 'scribe note' }));
    w.island('i1', { description: 'old' });
    w.char('a', { note: 'before' });
    const delivered = renderBrief(w.store.state.islands.i1, w.store.state.characters.a);
    w.store.update((d) => { d.characters.a.agent!.brief = delivered; d.islands.i1.description = 'new'; d.islands.i1.descriptionSource = 'manual'; });
    w.scribe.tick();
    await settle();
    const s = w.store.state;
    expect(s.characters.a.note).toBe('scribe note');
    const diff = briefDiff(s.characters.a.agent!.brief!, renderBrief(s.islands.i1, s.characters.a));
    expect(diff).toContain('+ Island: i1 — new');
    expect(diff).not.toContain('scribe note');
  });

  it('carries the brief the fleet renders, docs and all, rather than a plain one of its own', async () => {
    const folders: DocFolder[] = [{ tier: 'island', dir: '/docs/islands/i1', docs: [{ name: 'plan', path: '/docs/islands/i1/plan.md' }] }];
    const brief = (island: Island, c: Character) => renderBrief(island, c, folders);
    const w = world(({ system }) => system.includes('island')
      ? JSON.stringify({ description: 'the docs rewrite' })
      : JSON.stringify({ note: 'scribe note' }), brief);
    w.island('i1');
    w.char('a', { note: 'before' });
    w.store.update((d) => { d.characters.a.agent!.brief = brief(d.islands.i1, d.characters.a); });
    w.scribe.tick();
    await settle();
    const afterChar = w.store.state;
    expect(afterChar.characters.a.note).toBe('scribe note');
    expect(afterChar.characters.a.agent!.brief).toContain('- plan (/docs/islands/i1/plan.md)');
    expect(afterChar.characters.a.agent!.brief).toBe(brief(afterChar.islands.i1, afterChar.characters.a));

    w.advance(SETTLE_MS);
    w.scribe.tick();
    await settle();
    const afterIsland = w.store.state;
    expect(afterIsland.islands.i1.description).toBe('the docs rewrite');
    expect(afterIsland.characters.a.agent!.brief).toBe(brief(afterIsland.islands.i1, afterIsland.characters.a));
  });
});

describe('Scribe, swept', () => {
  it('adds a referenced PR in a worktree even when the branch has no PR and removes the repo fallback', async () => {
    const pr = 'https://github.com/o/r/pull/42';
    const w = world(answer({ links: [{ url: pr, label: '#42' }] }));
    w.island('i1');
    w.char('a', { context: [{ kind: 'github', ref: 'https://github.com/o/r', label: 'o/r', source: 'auto' }] });
    const file = w.store.state.characters.a.agent!.transcriptPath!;
    fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'Please review PR #42' } }) + '\n');
    await w.scribe.sweep();
    expect(w.calls[0].prompt).toContain(`PR evidence (candidate links; choose only those this work is about):\n- ${pr}`);
    expect(w.store.state.characters.a.context).toEqual([{ kind: 'pr', ref: pr, label: '#42', source: 'scribe' }]);
  });

  it("holds the branch's PR in place of its auto chip, with its state, beside a second PR the work is on", async () => {
    const own = 'https://github.com/o/r/pull/42', other = 'https://github.com/o/r/pull/41';
    // listed second, the branch's own PR still leads
    const w = world(answer({ links: [{ url: other, label: '#41' }, { url: own, label: '#42' }] }));
    w.island('i1');
    w.char('a', { context: [{ kind: 'pr', ref: own, label: '#42', source: 'auto', prState: 'draft' }] });
    const file = w.store.state.characters.a.agent!.transcriptPath!;
    fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: `Rebase ${other} onto main` } }) + '\n');
    await w.scribe.sweep();
    expect(w.calls[0].system).toContain('every PR');
    expect(w.store.state.characters.a.context).toEqual([
      { kind: 'pr', ref: own, label: '#42', source: 'scribe', prState: 'draft' },
      { kind: 'pr', ref: other, label: '#41', source: 'scribe' },
    ]);
  });

  it('puts the PR the work is on in front of every link, and leaves it there on the next pass', async () => {
    const pr = 'https://github.com/o/r/pull/42';
    const w = world(answer({ links: [{ url: 'https://docs.example/plan', label: 'plan' }, { url: pr, label: '#42' }] }));
    w.island('i1');
    w.char('a', { context: [{ kind: 'other', ref: 'https://keep', label: 'keep', source: 'manual' }] });
    const file = w.store.state.characters.a.agent!.transcriptPath!;
    fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: `Review ${pr} against https://docs.example/plan` } }) + '\n');
    await w.scribe.sweep();
    expect(w.calls[0].system).toContain('the PR the work is on first');
    expect(w.store.state.characters.a.context.map((l) => l.label)).toEqual(['#42', 'keep', 'plan']);
    expect((await w.scribe.sweep()).some((l) => l.includes('links:'))).toBe(false);
  });

  it('passes every live character now, then every island, and says what changed', async () => {
    const w = world(({ system, prompt }) => system.includes('island')
      ? JSON.stringify({ description: 'the docs rewrite' })
      : JSON.stringify({ name: prompt.startsWith('Name: robin review') ? { value: '#542 robin review', reason: 'identifier' } : { value: 'docs plan', reason: 'generated' }, note: 'working' }));
    w.island('i1');
    w.char('a', { status: 'working', quietMs: 0, bytes: 10 });
    w.char('b', { name: 'robin review', quietMs: 0, bytes: 10 });
    w.char('asleep', { tmux: undefined });
    const lines = await w.scribe.sweep();
    expect(lines).toEqual([
      'golden heron → docs plan', 'docs plan  note: working',
      'robin review → #542 robin review', '#542 robin review  note: working',
      'island i1  description: the docs rewrite',
    ]);
    expect(w.store.state.characters.asleep.name).toBe('golden heron');
  });

  it('writes only names with names, and only descriptions with islands', async () => {
    const w = world(({ system }) => system.includes('island')
      ? JSON.stringify({ description: 'd' })
      : JSON.stringify({ name: { value: 'docs plan', reason: 'generated' }, note: 'n' }));
    w.island('i1');
    w.char('a');
    expect(await w.scribe.sweep({ names: true })).toEqual(['golden heron → docs plan']);
    expect(w.store.state.characters.a.note).toBe('');
    expect(await w.scribe.sweep({ islands: true })).toEqual(['island i1  description: d']);
    expect(w.store.state.characters.a.note).toBe('');
  });

  it('leaves the note to the next automatic pass after a names-only sweep', async () => {
    const w = world(answer({ name: { value: 'docs plan', reason: 'generated' }, note: 'n' }));
    w.island('i1');
    w.char('a');
    await w.scribe.sweep({ names: true });
    w.scribe.tick();
    await settle();
    expect(w.store.state.characters.a.note).toBe('n');
  });

  it('runs a sweep asking for something else after the one running, rather than joining it', async () => {
    const w = world(answer({ name: { value: 'docs plan', reason: 'generated' }, note: 'n' }));
    w.island('i1');
    w.char('a');
    const [names, all] = await Promise.all([w.scribe.sweep({ names: true }), w.scribe.sweep()]);
    expect(names).toEqual(['golden heron → docs plan']);
    expect(all).toContain('docs plan  note: n');
  });

  it('refuses while the scribe is off or not yet answered, and says where it is turned on', async () => {
    const w = world(answer({ note: 'x' }));
    w.island('i1');
    w.char('a');
    for (const key of ['scribeOff', 'scribeAsk'] as const) {
      w.store.update((d) => { d.scribeOff = undefined; d.scribeAsk = undefined; d[key] = true; });
      await expect(w.scribe.sweep()).rejects.toThrow(/^the scribe is off.*turn it on with the scribe switch in the app's settings \(Cmd\+,\)$/);
      await expect(w.scribe.sweep({ islands: true })).rejects.toThrow('the scribe is off');
    }
    expect(w.calls).toEqual([]);
  });

  it('starts no pass once the scribe is switched off mid-sweep, and a sweep waiting behind it refuses', async () => {
    let switchOff = () => {};
    const w = world(() => { switchOff(); return JSON.stringify({ note: 'x' }); });
    switchOff = () => w.store.update((d) => { d.scribeOff = true; });
    w.island('i1');
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) w.char(id);
    const [first, second] = await Promise.allSettled([w.scribe.sweep({ names: true }), w.scribe.sweep()]);
    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({ status: 'rejected', reason: { message: expect.stringMatching(/^the scribe is off/) } });
    // the passes already started when it went off are the most that spend
    expect(w.calls.length).toBeLessThanOrEqual(3);
  });

  it('joins a sweep already running, and reports a failure on its line', async () => {
    const w = world(() => { throw new Error('no model'); });
    w.island('i1');
    w.char('a');
    const [one, two] = await Promise.all([w.scribe.sweep(), w.scribe.sweep()]);
    expect(one).toBe(two);
    expect(one).toEqual(['golden heron  failed: no model', 'island i1  failed: no model']);
    expect(w.calls).toHaveLength(2);
  });
});
