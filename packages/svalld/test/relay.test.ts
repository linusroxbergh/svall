import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RELAY_LIMIT, robotMessage, type Agent, type Robot } from '@svall/protocol';
import { Blocked, Dormant, Invalid } from '../src/errors.js';
import { startRelay, type Notify } from '../src/fleet/relay.js';
import { silentLogger } from '../src/log.js';
import { Store } from '../src/store.js';
import { cleanHomes, makeHome, waitFor } from './helpers.js';

afterEach(cleanHomes);

const tick = () => new Promise((r) => setImmediate(r));
const agent = (status: Agent['status'], extra: Partial<Agent> = {}): Agent => ({ kind: 'claude', sessionId: 's', status, lastActivityAt: 0, ...extra });
const prompt = (id: string, text: string) => ({ lastPrompt: { id, text, at: 0 } });
const LEAD = 'c_lead00';
const KID = 'c_kid000';
const asked = prompt('p1', robotMessage({ name: 'lead', id: LEAD }, 'review PR 472'));

function setup(o: { notify?: Notify; here?: (c: Robot) => boolean } = {}) {
  const store = Store.load(path.join(makeHome(), 'state.json'), () => {});
  const said: { to: string; text: string }[] = [];
  const notify: Notify = o.notify ?? ((to, text) => { said.push({ to, text }); return Promise.resolve('sent'); });
  const robot = (id: string, name: string, extra: Partial<Robot> = {}): Robot => ({
    id, islandId: 'i', cell: { x: id === LEAD ? 1 : 3, y: 1 }, name, portrait: 'fox', note: '', instructions: '', cwd: '/tmp', context: [],
    shell: { lastOutputAt: 0 }, unread: false, tmux: { windowId: `@${name}`, paneId: `%${name}` }, ...extra,
  });
  store.update((d) => {
    d.islands.i = { id: 'i', name: 'i', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 8, h: 4 }, seed: 1 };
    d.robots[LEAD] = robot(LEAD, 'lead', { agent: agent('idle') });
    d.robots[KID] = robot(KID, 'kid', { agent: agent('idle', prompt('p0', 'earlier')), report: { to: LEAD, after: 'p0', tagged: true } });
  });
  const stop = startRelay({ store, notify, log: silentLogger, here: o.here ?? (() => true) });
  const kid = (patch: (c: Robot) => void) => store.update((d) => patch(d.robots[KID]));
  return { store, said, stop, kid };
}

describe('relay', () => {
  it("tells the sender once per spell it waits on the user while its request runs, then that it is done, and owes nothing after", async () => {
    const { store, said, stop, kid } = setup();
    // a turn of the user's is not the request
    kid((c) => { c.agent = agent('working', prompt('u1', 'mine')); });
    kid((c) => { c.agent = agent('done', prompt('u1', 'mine')); });
    await tick();
    expect(said).toEqual([]);
    kid((c) => { c.agent = agent('working', asked); });
    await tick();
    kid((c) => { c.agent = agent('blocked', { ...asked, prompt: 'Bash: rm -rf build', promptId: 'q1' }); });
    await tick();
    // a question dialog's next step comes under an id of its own
    kid((c) => { c.agent = agent('blocked', { ...asked, prompt: 'Bash: rm -rf build', promptId: 'q2' }); });
    await tick();
    kid((c) => { c.agent = agent('working', asked); });
    await tick();
    kid((c) => { c.agent = agent('blocked', { ...asked, prompt: 'Write: notes.md', promptId: 'q3' }); });
    await tick();
    kid((c) => { c.agent = agent('done', asked); });
    await waitFor(() => said.length === 3);
    expect(said).toEqual([
      { to: LEAD, text: `[svall] kid (${KID}) is blocked: Bash: rm -rf build` },
      { to: LEAD, text: `[svall] kid (${KID}) is blocked: Write: notes.md` },
      { to: LEAD, text: `[svall] kid (${KID}) is done; full answer: svall robot read ${KID} --last` },
    ]);
    await waitFor(() => !store.state.robots[LEAD].inbox);
    expect(store.state.robots[KID].report).toBeUndefined();
    expect(store.state.robots[LEAD].relayed).toEqual({ n: 3 });
    kid((c) => { c.agent = agent('working', asked); });
    kid((c) => { c.agent = agent('done', asked); });
    await tick();
    expect(said).toHaveLength(3);
    stop();
  });

  it('waits out a quit that cut the request short, and reports the turn its resume carries on in', async () => {
    const { said, stop, kid } = setup();
    kid((c) => { c.agent = agent('working', asked); });
    await tick();
    // the quit lays it dormant, to resume as the fleet starts
    kid((c) => { delete c.tmux; c.revive = { command: 'claude --resume s', interrupted: true }; });
    await tick();
    kid((c) => { c.tmux = { windowId: '@kid', paneId: '%kid' }; delete c.revive; c.agent = agent('idle', asked); });
    await tick();
    expect(said).toEqual([]);
    kid((c) => { c.agent = agent('working', prompt('n1', 'You were interrupted; carry on')); });
    await tick();
    kid((c) => { c.agent = agent('done', prompt('n1', 'You were interrupted; carry on')); });
    await waitFor(() => said.length === 1);
    expect(said).toEqual([{ to: LEAD, text: `[svall] kid (${KID}) is done; full answer: svall robot read ${KID} --last` }]);
    stop();
  });

  it.each([
    ['an Esc', (c: Robot) => { c.agent = agent('idle', asked); }, 'stopped: its turn was interrupted'],
    ['an API error', (c: Robot) => { c.agent = agent('done', { ...asked, prompt: 'API Error: 529 Overloaded' }); }, 'stopped on an API error: API Error: 529 Overloaded'],
    ['its agent exiting', (c: Robot) => { delete c.agent; }, 'stopped: its agent exited'],
    ['its window closing', (c: Robot) => { delete c.tmux; }, 'stopped: its agent exited'],
  ])('tells the sender a request ended on %s', async (_, end, line) => {
    const { said, stop, kid } = setup();
    kid((c) => { c.agent = agent('working', asked); });
    await tick();
    kid(end);
    await waitFor(() => said.length === 1);
    expect(said).toEqual([{ to: LEAD, text: `[svall] kid (${KID}) ${line}` }]);
    stop();
  });

  it('tells the sender its robot was closed, begun or not, and owes a closed sender nothing', async () => {
    const { store, said, stop } = setup();
    store.update((d) => { delete d.robots[KID]; });
    await waitFor(() => said.length === 1);
    expect(said).toEqual([{ to: LEAD, text: `[svall] kid (${KID}) was closed` }]);
    stop();
    const b = setup();
    b.store.update((d) => { delete d.robots[LEAD]; });
    await tick();
    expect(b.store.state.robots[KID].report).toBeUndefined();
    b.stop();
  });

  it('gives the user a finish its sender was told of once the sender closes before taking the line, where the robot runs here', async () => {
    for (const here of [true, false]) {
      // a sender busy with its own turn holds the line
      const { store, stop, kid } = setup({ notify: () => new Promise(() => {}), here: () => here });
      kid((c) => { c.agent = agent('working', asked); });
      kid((c) => { c.agent = agent('done', asked); });
      await waitFor(() => !!store.state.robots[LEAD].inbox);
      store.update((d) => { delete d.robots[LEAD]; });
      await tick();
      expect(store.state.robots[KID].unread).toBe(here);
      stop();
    }
  });

  it('types a line again when the session it waited for went first, or once a sender waiting on an answer moves on', async () => {
    const answers: (() => Promise<'sent' | 'retry'>)[] = [() => Promise.resolve('retry'), () => Promise.reject(new Blocked('lead is waiting on an answer')), () => Promise.resolve('sent')];
    const tried: string[] = [];
    const { store, stop, kid } = setup({ notify: (_to, text) => { tried.push(text); return answers.shift()!(); } });
    kid((c) => { c.agent = agent('working', asked); });
    kid((c) => { c.agent = agent('done', asked); });
    await waitFor(() => tried.length === 2);
    await tick();
    expect(tried).toHaveLength(2);
    store.update((d) => { d.robots[LEAD].agent = agent('idle'); d.robots[LEAD].note = 'answered'; });
    await waitFor(() => !store.state.robots[LEAD].inbox);
    expect(tried).toHaveLength(3);
    stop();
  });

  it('keeps the lines of a sender that lies dormant until it is back', async () => {
    const tried: string[] = [];
    let up = false;
    const { store, stop, kid } = setup({ notify: (_to, text) => { tried.push(text); return up ? Promise.resolve('sent') : Promise.reject(new Dormant('lead is dormant; revive it first')); } });
    kid((c) => { c.agent = agent('working', asked); });
    kid((c) => { c.agent = agent('done', asked); });
    await waitFor(() => tried.length > 0);
    await new Promise((r) => setTimeout(r, 50));
    // it tries again on a change to the fleet, not on its own
    const before = tried.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(tried).toHaveLength(before);
    expect(store.state.robots[LEAD].inbox).toHaveLength(1);
    up = true;
    store.update((d) => { d.robots[LEAD].note = 'revived'; });
    await waitFor(() => !store.state.robots[LEAD].inbox);
    expect(tried).toHaveLength(before + 1);
    stop();
  });

  it('drops the lines of a robot that can take none: one that refuses them, or runs no agent', async () => {
    const { store, stop, kid } = setup({ notify: () => Promise.reject(new Invalid('lead runs no agent')) });
    kid((c) => { c.agent = agent('working', asked); });
    kid((c) => { c.agent = agent('done', asked); });
    await waitFor(() => !store.state.robots[LEAD].inbox && !store.state.robots[KID].report);
    stop();
    const b = setup();
    b.store.update((d) => { delete d.robots[LEAD].agent; d.robots[LEAD].inbox = [{ from: KID, text: 'x', end: true }]; });
    await waitFor(() => !b.store.state.robots[LEAD].inbox);
    expect(b.said).toEqual([]);
    b.stop();
  });

  it("holds robot messages for the user past the limit, and lets them in after the user's own prompt", async () => {
    const { store, said, stop } = setup();
    store.update((d) => {
      d.robots[LEAD].agent = agent('idle', prompt('u1', 'mine'));
      d.robots[LEAD].relayed = { n: RELAY_LIMIT, user: 'u1' };
      d.robots[LEAD].inbox = [{ from: KID, text: 'x' }];
    });
    await waitFor(() => !!store.state.robots[LEAD].relayed?.held);
    expect(said).toEqual([]);
    store.update((d) => { d.robots[LEAD].agent = agent('idle', prompt('u2', 'carry on')); });
    await waitFor(() => said.length === 1);
    await waitFor(() => !store.state.robots[LEAD].inbox);
    expect(store.state.robots[LEAD].relayed).toEqual({ n: 1, user: 'u2' });
    stop();
  });
});
