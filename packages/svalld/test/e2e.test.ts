import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../src/log.js';
import { startDaemon, type Daemon } from '../src/main.js';
import { resolvePaths } from '../src/paths.js';
import { Tmux } from '../src/tmux/tmux.js';
import { cleanHomes, hasTmux, makeHome, waitFor } from './helpers.js';

const runIf = hasTmux() ? describe : describe.skip;
const fake = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-claude.mjs');

runIf('fleet loop', () => {
  let daemon: Daemon | undefined;
  let home = '';
  // a start still under way when its test ends is stopped once it lands, before its tmux server is killed
  const starts: Promise<Daemon>[] = [];
  const start = (o: Parameters<typeof startDaemon>[0]): Promise<Daemon> => { const d = startDaemon(o); starts.push(d); return d; };
  afterEach(async () => {
    for (const d of starts.splice(0)) await d.then((x) => x.stop(), () => {});
    const p = resolvePaths(home);
    await new Tmux(p.tmuxSock, p.tmuxConf).killServer();
    cleanHomes();
  });

  it('runs two turns against a fake claude and survives a tmux death', async () => {
    home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh' }));
    daemon = await start({ home, port: 0, log: silentLogger });
    const fleet = daemon.fleet;
    const island = fleet.createIsland({ name: 'e2e' });
    const c = await fleet.createCharacter({ islandId: island.id, cwd: '/tmp', command: `node ${fake}` });

    expect(await fleet.waitFor(c.id, ['idle'], 15_000)).toBe('idle');
    await fleet.run(c.id, 'first task', true);
    expect(await fleet.waitFor(c.id, ['done', 'blocked'], 15_000)).toBe('done');
    await waitFor(() => fleet.readTranscript(c.id, 10).includes('first task'), 10_000);

    await fleet.run(c.id, 'second task', true);
    expect(await fleet.waitFor(c.id, ['done', 'blocked'], 15_000)).toBe('done');
    await waitFor(() => fleet.readTranscript(c.id, 10).includes('second task'), 10_000);
    const transcript = fleet.readTranscript(c.id, 10);
    expect(transcript).toContain('first task');
    expect(transcript).toContain('second task');

    const paths = resolvePaths(home);
    await new Tmux(paths.tmuxSock, paths.tmuxConf).killServer();
    await waitFor(() => daemon!.store.state.characters[c.id].tmux === undefined, 15_000);
    expect(daemon!.store.state.characters[c.id].revive).toBeDefined();

    // a crashed claude leaves its agent behind in its last status; the revived session reports the same id.
    daemon!.store.update((d) => {
      d.characters[c.id].agent = { kind: 'claude', sessionId: '0c6a3f0e-8b1d-4f2a-9e7c-1a2b3c4d5e6f', transcriptPath: '/nope', status: 'done', lastActivityAt: Date.now() };
      d.characters[c.id].revive = { command: `node ${fake}` };
    });
    await fleet.reviveCharacter(c.id);
    expect(await fleet.waitFor(c.id, ['idle'], 15_000)).toBe('idle');
  }, 60_000);

  it('types the prompt only after the fake claude has started', async () => {
    home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ shell: '/bin/sh' }));
    daemon = await start({ home, port: 0, log: silentLogger });
    const fleet = daemon.fleet;
    const c = await fleet.createCharacter({ islandId: 'home', cwd: '/tmp', name: 'organise', command: `node ${fake}`, run: '/svall-organise' });
    expect(c.runSent).toBe(true);
    expect(c.cell).toEqual({ x: 1, y: 1 });
    expect(await fleet.waitFor(c.id, ['done', 'blocked'], 15_000)).toBe('done');
    await waitFor(() => fleet.readTranscript(c.id, 10).includes('/svall-organise'), 10_000);
  }, 60_000);
});
