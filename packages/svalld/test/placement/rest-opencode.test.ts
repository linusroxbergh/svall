import { afterEach, describe, expect, it } from 'vitest';
import { armFailpoints } from '../../src/failpoints.js';
import { restTerminals } from '../../src/placement/rest.js';
import { cleanHomes } from '../helpers.js';
import { OC_SERVER, OSID, agent, boot, robot, win } from './rest-world.js';

afterEach(cleanHomes);

describe('restTerminals', () => {
  it('rests an idle OpenCode, its private server and Svall\'s plugin its own, and waits for that server to exit once its window closes', async () => {
    const { store, world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('opencode', 'idle', OSID) })]);
    world.pane(1, { job: [`opencode --standalone -s ${OSID}`], server: OC_SERVER, serverLingersMs: 300 });
    let result: unknown;
    const run = restTerminals(deps, { choices: {}, pollMs: 100, settleMs: 1000 }).then((r) => { result = r; });

    await world.settle();
    expect(world.log).toEqual(['detach c_ada', 'kill @1']);
    // the session is dormant as soon as its window closes, but the server still holds its database
    expect(store.state.robots.c_ada.revive).toEqual({ command: `opencode -s ${OSID}` });
    await world.advance(200);
    expect(result).toBeUndefined();
    await world.advance(100);
    await run;

    expect(result).toEqual({ ok: true, terminals: [{ robotId: 'c_ada' }] });
    expect(world.log).toEqual(['detach c_ada', 'kill @1']);
  });

  it('kills a private OpenCode server that outlasts its closed window by the settle time, with what it runs, journaled first, and sees them gone', async () => {
    const { world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('opencode', 'done', OSID) })]);
    world.pane(1, { job: [`opencode --standalone -s ${OSID}`], server: OC_SERVER, serverLingersMs: 60_000, lateChild: 'node /mcp/server.js' });
    let stopped: unknown;
    world.onKill = () => { stopped ??= deps.journal.read().stoppedTerminals; };
    let journaled: unknown;
    world.onSignal = () => { journaled ??= deps.journal.read().serverKills; };
    let result: unknown;
    const run = restTerminals(deps, { choices: {}, pollMs: 500, settleMs: 1000 }).then((r) => { result = r; });

    await world.settle();
    await world.advance(500);
    expect(result).toBeUndefined();
    await world.advance(500);
    await run;

    expect(result).toEqual({ ok: true, terminals: [{ robotId: 'c_ada' }] });
    expect(world.log).toEqual(['detach c_ada', 'kill @1', 'SIGKILL 1060', 'SIGKILL 1080']);
    // the server is journaled with its terminal before the window closes, so a rest or an abort after a crash finds it
    expect(stopped).toEqual([{ robotId: 'c_ada', server: { pid: 1060, pgid: 1060, args: OC_SERVER, boot: 'boot-1' } }]);
    expect(journaled).toEqual([{
      robotId: 'c_ada', boot: 'boot-1', processes: [{ pid: 1060, pgid: 1060, args: OC_SERVER }, { pid: 1080, pgid: 1080, args: 'node /mcp/server.js' }],
    }]);
    expect(deps.journal.read().terminated).toEqual([]);
    expect(world.orphans).toEqual([]);
  });

  it('waits for, and kills, a private OpenCode server a rest that died left running once it rests again, before it answers', async () => {
    const { world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('opencode', 'done', OSID) })]);
    world.pane(1, { job: [`opencode --standalone -s ${OSID}`], server: OC_SERVER, serverLingersMs: 60_000 });
    // the daemon dies as the wait for the server ends
    const disarm = armFailpoints((name, edge) => { if (name === 'move.rest.server.journal' && edge === 'before') throw new Error('crashed'); });
    let failed: unknown;
    const first = restTerminals(deps, { choices: {}, pollMs: 500, settleMs: 1000 }).catch((e: Error) => { failed = e.message; });
    await world.settle();
    for (let t = 0; t < 2; t++) await world.advance(500);
    await first;
    disarm();
    expect(failed).toBe('crashed');

    let result: unknown;
    const again = restTerminals(deps, { choices: {}, pollMs: 500, settleMs: 1000 }).then((r) => { result = r; });
    await world.settle();
    await world.advance(500);
    expect(result).toBeUndefined();
    await world.advance(500);
    await again;

    expect(result).toEqual({ ok: true, terminals: [] });
    expect(world.log).toEqual(['detach c_ada', 'kill @1', 'SIGKILL 1060']);
    expect(deps.journal.read().serverKills).toEqual([{ robotId: 'c_ada', boot: 'boot-1', processes: [{ pid: 1060, pgid: 1060, args: OC_SERVER }] }]);
    expect(world.orphans).toEqual([]);
  });

  for (const [what, stopped] of [
    ['with the server it had before an abort reopened it', { robotId: 'c_ada', server: { pid: 5060, pgid: 5060, args: OC_SERVER, boot: 'boot-1' } }],
    ['with no server', { robotId: 'c_ada' }],
  ] as const) {
    it(`journals and waits for the live server of a terminal the journal already names ${what}`, async () => {
      const { world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('opencode', 'done', OSID) })]);
      deps.journal.write({ ...deps.journal.read(), stoppedTerminals: [stopped] });
      world.pane(1, { job: [`opencode --standalone -s ${OSID}`], server: OC_SERVER, serverLingersMs: 60_000 });
      let result: unknown;
      const run = restTerminals(deps, { choices: {}, pollMs: 500, settleMs: 1000 }).then((r) => { result = r; });

      await world.settle();
      await world.advance(500);
      expect(result).toBeUndefined();
      await world.advance(500);
      await run;

      expect(result).toEqual({ ok: true, terminals: [{ robotId: 'c_ada' }] });
      expect(world.log).toEqual(['detach c_ada', 'kill @1', 'SIGKILL 1060']);
      expect(deps.journal.read().stoppedTerminals).toEqual([{ robotId: 'c_ada', server: { pid: 1060, pgid: 1060, args: OC_SERVER, boot: 'boot-1' } }]);
    });
  }

  // a server and a kill journaled under boot-0, whose pids now run the same command lines
  const rebooted = () => {
    const b = boot([robot('c_ada', { agent: agent('opencode', 'done', OSID), revive: { command: `opencode -s ${OSID}` } })]);
    b.deps.journal.write({
      ...b.deps.journal.read(),
      stoppedTerminals: [{ robotId: 'c_ada', server: { pid: 1060, pgid: 1060, args: OC_SERVER, boot: 'boot-0' } }],
      serverKills: [{ robotId: 'c_ada', boot: 'boot-0', processes: [{ pid: 1080, pgid: 1080, args: 'node /mcp/server.js' }] }],
    });
    b.world.orphans.push(
      { row: { pid: 1060, ppid: 1, pgid: 1060, tpgid: 0, stat: 'Ss', args: OC_SERVER }, until: Infinity },
      { row: { pid: 1080, ppid: 1, pgid: 1080, tpgid: 0, stat: 'Ss', args: 'node /mcp/server.js' }, until: Infinity },
    );
    return b;
  };

  it('takes a server or a kill journaled under another boot of this machine for gone, though its pid now runs the same command line', async () => {
    const { world, deps } = rebooted();
    let result: unknown;
    void restTerminals(deps, { choices: {}, pollMs: 500, settleMs: 1000 }).then((r) => { result = r; });

    await world.settle();
    expect(result).toEqual({ ok: true, terminals: [] });
    expect(world.log).toEqual([]);
  });

  it('matches a journaled server by its pid and command line alone when this boot cannot be read', async () => {
    const { world, deps } = rebooted();
    let result: unknown;
    const run = restTerminals({ ...deps, bootId: () => undefined }, { choices: {}, pollMs: 500, settleMs: 1000 }).then((r) => { result = r; });

    await world.settle();
    await world.advance(500);
    expect(result).toBeUndefined();
    await world.advance(500);
    await run;
    expect(result).toEqual({ ok: true, terminals: [] });
    expect(world.log).toEqual(['SIGKILL 1060', 'SIGKILL 1080']);
  });

  it('takes a journaled server whose pid now runs another command for gone, signalling nothing', async () => {
    const { world, deps } = boot([robot('c_ada', { agent: agent('opencode', 'done', OSID), revive: { command: `opencode -s ${OSID}` } })]);
    deps.journal.write({ ...deps.journal.read(), stoppedTerminals: [{ robotId: 'c_ada', server: { pid: 1060, pgid: 1060, args: OC_SERVER } }] });
    world.orphans.push({ row: { pid: 1060, ppid: 1, pgid: 1060, tpgid: 0, stat: 'Ss', args: 'vim notes.md' }, until: Infinity });

    expect(await restTerminals(deps, { choices: {} })).toEqual({ ok: true, terminals: [] });
    expect(world.log).toEqual([]);
  });

  it('kills again what the kill of a lingering server journaled and still runs when it rests again, and fails while any of it survives', async () => {
    const { world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('opencode', 'done', OSID) })]);
    world.pane(1, { job: [`opencode --standalone -s ${OSID}`], server: OC_SERVER, serverLingersMs: 60_000, lateChild: 'node /mcp/server.js' });
    world.stuck = ['node /mcp/server.js'];
    const rest = async (advances: number): Promise<unknown> => {
      const run = restTerminals(deps, { choices: {}, pollMs: 500, settleMs: 1000 }).catch((e: Error) => e.message);
      await world.settle();
      for (let t = 0; t < advances; t++) await world.advance(500);
      return run;
    };

    expect(await rest(4)).toBe("ada's terminal: node /mcp/server.js still runs after SIGKILL");
    // the server is gone, so only the journal still leads to what it ran
    expect(await rest(2)).toBe("ada's terminal: node /mcp/server.js still runs after SIGKILL");
    expect(world.log.slice(2)).toEqual(['SIGKILL 1060', 'SIGKILL 1080', 'SIGKILL 1080']);
    world.stuck = false;
    expect(await rest(0)).toEqual({ ok: true, terminals: [] });
    expect(world.log.slice(5)).toEqual(['SIGKILL 1080']);
    expect(world.orphans).toEqual([]);
  });

  it('fails the rest when a private OpenCode server outlives its SIGKILL', async () => {
    const { world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('opencode', 'done', OSID) })]);
    world.pane(1, { job: [`opencode --standalone -s ${OSID}`], server: OC_SERVER, serverLingersMs: 60_000 });
    world.stuck = true;
    let failed: unknown;
    const run = restTerminals(deps, { choices: {}, pollMs: 500, settleMs: 1000 }).catch((e: Error) => { failed = e.message; });

    await world.settle();
    for (let t = 0; t < 4; t++) await world.advance(500);
    await run;

    expect(failed).toMatch(/ada's terminal: .*serve --stdio.* still runs after SIGKILL/);
  });

  it("rests an idle OpenCode whose server still runs its MCP and language servers, which close with it", async () => {
    const { world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('opencode', 'idle', OSID) })]);
    world.pane(1, { job: [`opencode --standalone -s ${OSID}`], server: OC_SERVER, tools: ['node /mcp/server.js', 'typescript-language-server --stdio'] });
    expect(await restTerminals(deps, { choices: {} })).toEqual({ ok: true, terminals: [{ robotId: 'c_ada' }] });
    expect(world.log).toEqual(['detach c_ada', 'kill @1']);
  });

  it("refuses an idle OpenCode whose job outlived the shell command that started it, and ends it with its group when chosen", async () => {
    const idle = () => {
      const b = boot([robot('c_ada', { tmux: win(1), agent: agent('opencode', 'idle', OSID) })]);
      b.world.pane(1, { job: [`opencode --standalone -s ${OSID}`], server: OC_SERVER, tools: ['sleep 300'] });
      // reparented, still in the group of the command the server runs
      b.world.orphans.push({ row: { pid: 1090, ppid: 1, pgid: 1050, tpgid: 0, stat: 'S', args: 'sleep 501' }, until: Infinity });
      return b;
    };
    const kept = idle();
    expect(await restTerminals(kept.deps, { choices: {} })).toEqual({
      ok: false,
      blockers: [{
        code: 'agent_unsettled', message: "ada's terminal is idle with work still running in the background: sleep 501 still runs",
        robotId: 'c_ada',
      }],
    });
    expect(kept.world.log).toEqual([]);

    const ended = idle();
    let result: unknown;
    const run = restTerminals(ended.deps, { choices: { terminate: true }, pollMs: 500, settleMs: 1000 }).then((r) => { result = r; });
    await ended.world.settle();
    await ended.world.advance(500);
    await run;
    expect(result).toMatchObject({ ok: true });
    expect(ended.world.log).toEqual(['SIGTERM 1001', 'SIGTERM 1060', 'SIGTERM 1050', 'detach c_ada', 'kill @1']);
    expect(ended.world.orphans).toEqual([]);
    expect(ended.store.state.robots.c_ada.revive).toEqual({ command: `opencode -s ${OSID}`, interrupted: true });
  });

  it('interrupts a working or blocked OpenCode with two Escapes sent 200 ms apart, and rests a working one only once its plugin reports the turn over, not when its command ends alone', async () => {
    const OSID2 = 'ses_0123456789abCDEFGHIJKLMNop';
    const { store, world, deps } = boot([
      robot('c_ada', { tmux: win(1), agent: agent('opencode', 'working', OSID) }),
      robot('c_bo', { tmux: win(3), agent: agent('opencode', 'blocked', OSID2, 'Allow rm -rf build?') }),
    ]);
    const pane = world.pane(1, { job: [`opencode --standalone -s ${OSID}`], server: OC_SERVER, tools: ['sleep 300'] });
    world.pane(3, { job: [`opencode --standalone -s ${OSID2}`], server: OC_SERVER });
    let result: unknown;
    const run = restTerminals(deps, { choices: { interruptAfterMs: 0 }, pollMs: 500, settleMs: 10_000 }).then((r) => { result = r; });

    await world.settle();
    // OpenCode interrupts only on a second Escape within 5 s, and reads two in one write as one
    expect(world.log).toEqual(['keys %1 1b']);
    await world.advance(199);
    expect(world.log).toEqual(['keys %1 1b']);
    await world.advance(1);
    expect(world.log).toEqual(['keys %1 1b', 'keys %1 1b', 'keys %3 1b']);
    await world.advance(200);
    expect(world.log).toEqual(['keys %1 1b', 'keys %1 1b', 'keys %3 1b', 'keys %3 1b']);
    // unlike Claude Code, OpenCode reports the interrupted turn, so a command gone alone does not settle it
    delete pane.tools;
    await world.advance(500);
    await world.advance(500);
    expect(result).toBeUndefined();
    store.update((d) => { d.robots.c_ada.agent!.status = 'idle'; });
    await world.advance(500);
    await run;

    expect(result).toEqual({ ok: true, terminals: [{ robotId: 'c_ada' }, { robotId: 'c_bo' }] });
    expect(world.log.slice(4)).toEqual(['detach c_ada', 'detach c_bo', 'kill @1', 'kill @3']);
  });
});
