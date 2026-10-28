import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Config } from '../../src/config.js';
import { Fleet } from '../../src/fleet.js';
import { ProcessTable, killGroup } from '../../src/processes.js';
import { classifyTerminals, restTerminals, unapproved } from '../../src/placement/rest.js';
import { silentLogger } from '../../src/log.js';
import { resolvePaths } from '../../src/paths.js';
import { Store } from '../../src/store.js';
import { TerminalHub } from '../../src/terminals.js';
import { tmuxConfText } from '../../src/tmux/conf.js';
import { Tmux } from '../../src/tmux/tmux.js';
import { cleanHomes, hasTmux, makeHome, waitFor } from '../helpers.js';
import { SID, agent, fleetId, restJournal, robot } from './rest-world.js';

afterEach(cleanHomes);

const runIf = hasTmux() ? describe : describe.skip;

runIf(`resting real terminals${hasTmux() ? '' : ' (skipped: tmux is not on PATH)'}`, () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const f of cleanup.splice(0)) await f(); });

  it('ends the chosen job in a real pane, detaches an attached client, and closes both windows', async () => {
    const home = makeHome();
    const paths = resolvePaths(home);
    const config = Config.parse({ id: fleetId, shell: '/bin/sh' });
    fs.writeFileSync(paths.tmuxConf, tmuxConfText(config));
    const store = Store.load(paths.state, () => {});
    const tmux = new Tmux(paths.tmuxSock, paths.tmuxConf);
    const fleet = new Fleet({ store, tmux, paths, config, log: silentLogger, pollMs: 150 });
    await fleet.start();
    cleanup.push(async () => { fleet.stop(); await tmux.killServer(); });
    const hub = new TerminalHub(fleet, tmux, store, silentLogger);
    const c = await fleet.createRobot({ islandId: fleet.createIsland({ name: 'rest' }).id, cwd: home });
    await fleet.openSecond(c.id);
    const second = store.state.robots[c.id].second!.tmux!;
    await tmux.sendLine(second.paneId, 'sleep 300', true);
    const secondPid = (await tmux.listWindows()).find((w) => w.windowId === second.windowId)!.panePid;
    await waitFor(async () => (await ProcessTable.read()).pane(secondPid)?.foreground[0]?.args === 'sleep 300');

    const { session, socket } = await hub.attach(c.id);
    let screen = '';
    const client = spawn('python3', [path.join(import.meta.dirname, '../fixtures/on-pty.py'), tmux.binary, '-S', socket, 'attach', '-t', session], {
      env: { ...process.env, TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'inherit'],
    });
    client.stdout.on('data', (d: Buffer) => { screen += d.toString(); });
    cleanup.push(async () => { client.kill(); });
    await waitFor(async () => (await tmux.run('list-clients', '-t', `=${session}`, '-F', '#{client_name}')).trim() !== '');

    const journal = restJournal();

    const result = await restTerminals(
      { store, tmux, viewers: hub, journal },
      { choices: { terminate: [{ robotId: c.id, term: 2 }] }, pollMs: 50, settleMs: 3000 },
    );

    expect(result).toMatchObject({ ok: true });
    expect(await tmux.listWindows()).toEqual([]);
    await waitFor(() => screen.includes('detached'));
    const rested = store.state.robots[c.id];
    expect(rested.tmux).toBeUndefined();
    expect(rested.second).toEqual({ cwd: fs.realpathSync(home), unread: false, revive: { command: '' } });
    expect(journal.read().terminated).toEqual([{ robotId: c.id, term: 2, processes: ['sleep 300'] }]);
  }, 20_000);

  it('rests a fleet whose tmux server died with its windows, or left no socket at all, as one with no window, closing none', async () => {
    const paths = resolvePaths(makeHome());
    fs.writeFileSync(paths.tmuxConf, tmuxConfText(Config.parse({ id: fleetId, shell: '/bin/sh' })));
    const tmux = new Tmux(paths.tmuxSock, paths.tmuxConf);
    await tmux.ensureServer();
    cleanup.push(() => tmux.killServer());
    const store = Store.load(paths.state, () => {});
    const w = await tmux.newWindow('c_ada', paths.home, {});
    store.update((d) => { d.robots.c_ada = robot('c_ada', { tmux: w, agent: agent('claude', 'idle') }); });
    const journal = restJournal();
    const detached: string[] = [];
    const rest = () => restTerminals({ store, tmux, viewers: { detach: async (id) => { detached.push(id); } }, journal }, { choices: {} });

    // the whole unit went down: the server, every window and every agent in it, and its socket file stays behind
    const pid = Number((await tmux.run('display-message', '-p', '#{pid}')).trim());
    process.kill(pid, 'SIGKILL');
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    expect(fs.existsSync(paths.tmuxSock)).toBe(true);
    expect(await rest()).toEqual({ ok: true, terminals: [] });
    const ada = store.state.robots.c_ada;
    expect(ada.tmux).toBeUndefined();
    expect(ada).toMatchObject({ agent: { sessionId: SID }, revive: { command: `claude --resume ${SID}` } });
    // the rest closed no window, so neither an abort nor the destination opens one
    expect(journal.read().stoppedTerminals).toEqual([]);

    fs.rmSync(paths.tmuxSock);
    expect(await rest()).toEqual({ ok: true, terminals: [] });
    expect(detached).toEqual([]);
  }, 20_000);

  it('blocks on a mid-turn agent suspended with ctrl+z, and ends it at once when terminated', async () => {
    const paths = resolvePaths(makeHome());
    fs.writeFileSync(paths.tmuxConf, tmuxConfText(Config.parse({ id: fleetId, shell: '/bin/sh' })));
    const tmux = new Tmux(paths.tmuxSock, paths.tmuxConf);
    await tmux.ensureServer();
    cleanup.push(() => tmux.killServer());
    const claude = path.join(paths.home, 'bin', 'claude');
    fs.mkdirSync(path.dirname(claude));
    fs.symlinkSync('/bin/sleep', claude);
    const w = await tmux.newWindow('c_ada', paths.home, {});
    const store = Store.load(paths.state, () => {});
    store.update((d) => { d.robots.c_ada = robot('c_ada', { tmux: w, agent: agent('claude', 'working') }); });
    const [{ panePid }] = await tmux.listWindows();
    const job = async () => (await ProcessTable.read()).pane(panePid)?.foreground ?? [];
    await waitFor(async () => (await job()).length === 0);
    await tmux.sendLine(w.paneId, `${claude} 300`, true);
    await waitFor(async () => (await job())[0]?.args === `${claude} 300`);
    const [{ pid }] = await job();
    await tmux.sendBytes(w.paneId, Buffer.from('\x1a'));
    await waitFor(() => execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).startsWith('T'));

    const classified = classifyTerminals(store.state, await tmux.listWindows(), await ProcessTable.read());
    expect(unapproved(store.state, classified, {})).toEqual([
      { code: 'shell_busy', message: `ada's terminal has ${claude} 300 suspended`, robotId: 'c_ada' },
    ]);

    const signals: string[] = [];
    const result = await restTerminals(
      { store, tmux, viewers: { detach: async () => {} }, journal: restJournal(), kill: (group, signal) => { signals.push(signal); killGroup(group, signal); } },
      { choices: { terminate: true }, pollMs: 50, settleMs: 10_000 },
    );

    expect(result).toEqual({ ok: true, terminals: [{ robotId: 'c_ada' }] });
    // it took SIGTERM once continued, with no SIGKILL a settle time later
    expect(signals).toEqual(['SIGTERM', 'SIGCONT']);
  }, 20_000);
});
