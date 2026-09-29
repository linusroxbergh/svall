import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '@svall/protocol';
import { Config } from '../src/config.js';
import { Fleet } from '../src/fleet.js';
import { silentLogger } from '../src/log.js';
import { resolvePaths } from '../src/paths.js';
import { Store } from '../src/store.js';
import { TerminalHub, type Viewer } from '../src/terminals.js';
import { tmuxConfText } from '../src/tmux/conf.js';
import { Tmux } from '../src/tmux/tmux.js';
import { cleanHomes, hasTmux, makeHome, waitFor } from './helpers.js';

const runIf = hasTmux() ? describe : describe.skip;

function viewer(backlog = 0, kind: Viewer['kind'] = 'app'): Viewer & { events: Event[] } {
  const events: Event[] = [];
  return { kind, events, send: (ev) => { events.push(ev); }, backlog: () => backlog };
}
const outputText = (v: { events: Event[] }) =>
  v.events.filter((e) => e.event === 'term.output').map((e) => Buffer.from((e.data as { data: string }).data, 'base64').toString()).join('');

runIf('TerminalHub', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const f of cleanup.splice(0)) await f(); cleanHomes(); });

  async function boot() {
    const home = makeHome();
    const paths = resolvePaths(home);
    const config = Config.parse({ shell: '/bin/sh' });
    fs.writeFileSync(paths.tmuxConf, tmuxConfText(config));
    const store = Store.load(paths.state, () => {});
    const tmux = new Tmux(paths.tmuxSock, paths.tmuxConf);
    const fleet = new Fleet({ store, tmux, paths, config, log: silentLogger, pollMs: 200 });
    const started = fleet.start();
    cleanup.push(async () => { await started.catch(() => {}); fleet.stop(); await tmux.killServer(); });
    await started;
    const hub = new TerminalHub(fleet, tmux, store, silentLogger);
    const c = await fleet.createCharacter({ islandId: fleet.createIsland({ name: 'x' }).id, cwd: '/tmp' });
    return { fleet, tmux, store, hub, c };
  }

  it('seeds, streams to every viewer, and goes quiet after close', async () => {
    const { hub, c } = await boot();
    const a = viewer();
    const b = viewer();
    const seed = await hub.open(c.id, 100, 30, 2000, a);
    expect(Buffer.from(seed, 'base64').toString()).toMatch(/\$/);
    await hub.open(c.id, 100, 30, 2000, b);
    expect(hub.viewerCount(c.id)).toBe(2);
    await hub.input(c.id, Buffer.from('echo term-ok\n'));
    await waitFor(() => outputText(a).includes('term-ok') && outputText(b).includes('term-ok'));
    hub.close(c.id, a);
    hub.closeAll(b);
    expect(hub.viewerCount(c.id)).toBe(0);
    const before = a.events.length;
    await hub.input(c.id, Buffer.from('echo after\n'));
    await new Promise((r) => setTimeout(r, 300));
    expect(a.events.length).toBe(before);
  });

  it('resumes a paused pane once viewers drained, and resyncs on continue', async () => {
    const { hub, fleet, c } = await boot();
    let backlog = 5_000_000;
    const v: Viewer & { events: Event[] } = { kind: 'app', events: [], send: (ev) => { v.events.push(ev); }, backlog: () => backlog };
    await hub.open(c.id, 80, 24, 2000, v);
    const cont = vi.spyOn(fleet, 'continuePane');
    fleet.emit('pause', c.id);
    await new Promise((r) => setTimeout(r, 120));
    expect(cont).not.toHaveBeenCalled();
    backlog = 0;
    await waitFor(() => cont.mock.calls.length === 1);
    fleet.emit('continue', c.id);
    await waitFor(() => v.events.some((e) => e.event === 'term.resync'));
  });

  it('resyncs open terminals after a control reset', async () => {
    const { hub, fleet, c } = await boot();
    const v = viewer();
    await hub.open(c.id, 80, 24, 2000, v);
    fleet.emit('control-reset');
    await waitFor(() => v.events.some((e) => e.event === 'term.resync'));
  });

  it('keeps typed bytes in order when every key arrives as its own call', async () => {
    const { hub, c } = await boot();
    const v = viewer();
    await hub.open(c.id, 100, 30, 2000, v);
    const text = 'echo in-order\n';
    await Promise.all([...text].map((ch) => hub.input(c.id, Buffer.from(ch))));
    await waitFor(() => outputText(v).includes('in-order\r\n'));
    expect(outputText(v)).toContain('echo in-order');
  });

  it('takes Enter or Esc typed into a blocked agent as its answer, and arrows as no answer', async () => {
    const { hub, store, c } = await boot();
    const block = (id: string) => store.update((d) => {
      d.characters[c.id].agent = { kind: 'claude', sessionId: 's', status: 'blocked', promptId: id, prompt: 'may I', lastActivityAt: 1 };
    });
    block('q1');
    await hub.input(c.id, Buffer.from('\x1b[B'));
    expect(store.state.characters[c.id].agent).toMatchObject({ status: 'blocked', promptId: 'q1' });
    await hub.input(c.id, Buffer.from('\r'));
    expect(store.state.characters[c.id].agent?.status).toBe('working');
    expect(store.state.characters[c.id].agent?.promptId).toBeUndefined();
    block('q2');
    await hub.input(c.id, Buffer.from('\x1b'));
    expect(store.state.characters[c.id].agent?.status).toBe('idle');
    block('q3');
    await hub.input(c.id, Buffer.from('\x03'));
    expect(store.state.characters[c.id].agent?.status).toBe('idle');
  });

  it('seeds the scrollback the caller asked for', async () => {
    const { hub, tmux, c } = await boot();
    const capture = vi.spyOn(tmux, 'capture');
    await hub.open(c.id, 100, 30, 120, viewer());
    expect(capture).toHaveBeenCalledWith(c.tmux!.paneId, 120, true);
  });

  it('lets a phone size the window a desktop terminal is attached to, and an app yield to it', async () => {
    const { hub, tmux, c } = await boot();
    const size = async () => (await tmux.run('display-message', '-p', '-t', c.tmux!.windowId, '#{window_width}')).trim();
    vi.spyOn(tmux, 'listSessions').mockResolvedValue([{ name: `v-${c.id}`, attached: 1, created: Date.now() }]);
    await hub.open(c.id, 61, 24, 2000, viewer(0, 'app'));
    expect(await size()).not.toBe('61');
    await hub.resize(c.id, 41, 24, viewer(0, 'phone'));
    expect(await size()).toBe('41');
  });

  it('gives the window back to automatic sizing when the last viewer leaves', async () => {
    const { hub, tmux, c } = await boot();
    const v = viewer();
    await hub.open(c.id, 41, 24, 2000, v);
    expect((await tmux.run('show-options', '-w', '-t', c.tmux!.windowId, '-v', 'window-size')).trim()).toBe('manual');
    hub.close(c.id, v);
    await waitFor(async () => (await tmux.run('show-options', '-w', '-t', c.tmux!.windowId, 'window-size')).trim() === '');
  });

  it('releases the phone width while an app viewer is still watching', async () => {
    const { hub, tmux, c } = await boot();
    const app = viewer(0, 'app');
    const phone = viewer(0, 'phone');
    await hub.open(c.id, 100, 30, 2000, app);
    await hub.open(c.id, 41, 24, 2000, phone);
    hub.close(c.id, phone);
    expect(hub.viewerCount(c.id)).toBe(1);
    await waitFor(async () => (await tmux.run('show-options', '-w', '-t', c.tmux!.windowId, 'window-size')).trim() === '');
  });

  it('keeps out a phone whose socket closed while its open was under way, so the window goes back when the other leaves', async () => {
    const { hub, tmux, c } = await boot();
    const a = viewer(0, 'phone');
    const b = viewer(0, 'phone');
    await hub.open(c.id, 40, 20, 10, a);
    let release!: () => void;
    const capture = vi.spyOn(tmux, 'capture').mockImplementationOnce(async () => { await new Promise<void>((r) => { release = r; }); return Buffer.from(''); });
    const opening = hub.open(c.id, 30, 15, 10, b);
    await waitFor(() => capture.mock.calls.length === 1);
    hub.closeAll(b);
    release();
    await expect(opening).rejects.toThrow(/closed while opening/);
    expect(hub.viewerCount(c.id)).toBe(1);
    hub.closeAll(a);
    expect(hub.viewerCount(c.id)).toBe(0);
    await waitFor(async () => (await tmux.run('show-options', '-w', '-t', c.tmux!.windowId, 'window-size')).trim() === '');
  });

  it('rejects opening a dormant character', async () => {
    const { hub, tmux, store, c } = await boot();
    await tmux.killWindow(c.tmux!.windowId);
    await waitFor(() => store.state.characters[c.id].tmux === undefined);
    await expect(hub.open(c.id, 80, 24, 2000, viewer())).rejects.toThrow(/dormant/);
  });
});
