import { afterEach, describe, expect, it } from 'vitest';
import { emptyState } from '@svall/protocol';
import { hookCommand, statusWrapper } from '../../src/agent-hooks.js';
import { Config } from '../../src/config.js';
import { markDormant } from '../../src/dormancy.js';
import { Fleet } from '../../src/fleet.js';
import { ProcessTable } from '../../src/processes.js';
import { classifyTerminals, restTerminals, unapproved } from '../../src/placement/rest.js';
import { silentLogger } from '../../src/log.js';
import { installedScripts } from '../../src/paths.js';
import { Tmux } from '../../src/tmux/tmux.js';
import { cleanHomes } from '../helpers.js';
import { SID, SID2, World, agent, boot, fleetId, robot, win } from './rest-world.js';

afterEach(cleanHomes);

describe('restTerminals', () => {
  it('rests idle agents and shells at their prompt, detaching viewers before a window closes, and leaves both slots dormant with resume commands', async () => {
    const { store, world, deps } = boot([
      robot('c_ada', { tmux: win(1), agent: agent('claude', 'idle'), second: { cwd: '/side', unread: false, tmux: win(2) } }),
      robot('c_bo', { tmux: win(3), agent: agent('codex', 'done', SID2) }),
    ]);
    world.pane(1, { job: [`claude --resume ${SID}`] });
    world.pane(2, { path: '/side/moved' });
    world.pane(3, { job: ['codex'] });
    let stoppedBeforeKill: unknown;
    world.onKill = () => { stoppedBeforeKill ??= deps.journal.read().stoppedTerminals; };

    const result = await restTerminals(deps, { choices: {} });

    expect(result).toEqual({
      ok: true,
      terminals: [
        { robotId: 'c_ada' },
        { robotId: 'c_ada', term: 2 },
        { robotId: 'c_bo' },
      ],
    });
    expect(world.log).toEqual(['detach c_ada', 'detach c_bo', 'kill @1', 'kill @2', 'kill @3']);
    const stopped = [{ robotId: 'c_ada' }, { robotId: 'c_ada', term: 2 }, { robotId: 'c_bo' }];
    expect(stoppedBeforeKill).toEqual(stopped);
    expect(deps.journal.read().stoppedTerminals).toEqual(stopped);
    const ada = store.state.robots.c_ada;
    expect(ada.tmux).toBeUndefined();
    expect(ada.cwd).toBe('/work/c_ada');
    expect(ada.revive).toEqual({ command: `claude --resume ${SID}` });
    expect(ada.second).toEqual({ cwd: '/side/moved', unread: false, revive: { command: '' } });
    expect(store.state.robots.c_bo).toMatchObject({ revive: { command: `codex resume -c tui.resume_cwd=session ${SID2}` } });
    expect(world.timers()).toBe(0);
  });

  it('lays a terminal to rest with its agent when the fleet took its exit hook and its window close first, as the live fleet does', async () => {
    const { store, world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('claude', 'idle') })]);
    world.pane(1, { job: [`claude --resume ${SID}`] });
    world.onKill = () => store.update((d) => { delete d.robots.c_ada.agent; markDormant(d.robots.c_ada); });

    expect((await restTerminals(deps, { choices: {} })).ok).toBe(true);
    expect(store.state.robots.c_ada).toMatchObject({ agent: { sessionId: SID }, revive: { command: `claude --resume ${SID}` } });
  });

  it('leaves a robot put to sleep alone while its window still closes and its agent still exits', async () => {
    const slept = robot('c_ada', { agent: agent('claude', 'idle'), revive: { command: `claude --resume ${SID}` } });
    const { store, world, deps } = boot([slept, robot('c_bo', { tmux: win(3), agent: agent('codex', 'done', SID2) })]);
    world.pane(1, { job: [`claude --resume ${SID}`], tools: ['node server.js'] });
    world.pane(3, { job: ['codex'] });

    expect(await restTerminals(deps, { choices: {} })).toEqual({ ok: true, terminals: [{ robotId: 'c_bo' }] });
    expect(world.log).toEqual(['detach c_bo', 'kill @3']);
    expect(store.state.robots.c_ada).toEqual(slept);
  });

  it('resumes each rested agent with the launch flags an idle close would keep, and one whose launch cannot be repeated without any', async () => {
    const SID3 = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e';
    const { store, world, deps } = boot([
      robot('c_ada', { tmux: win(1), agent: agent('claude', 'idle'), second: { cwd: '/side', unread: false, tmux: win(2), agent: agent('codex', 'idle', SID2) } }),
      robot('c_bo', { tmux: win(3), agent: agent('claude', 'done', SID3) }),
    ]);
    world.pane(1, { job: ['claude --dangerously-skip-permissions --model opus --effort high -- fix it'] });
    world.pane(2, { job: ['codex --yolo -m gpt-6-astra -p work'] });
    world.pane(3, { job: ['claude --settings /x/deny.json'] });

    expect((await restTerminals(deps, { choices: {} })).ok).toBe(true);

    const { c_ada: ada, c_bo: bo } = store.state.robots;
    expect(ada.revive).toEqual({ command: `claude --dangerously-skip-permissions --effort 'high' --resume ${SID}` });
    expect(ada.second?.revive).toEqual({ command: `codex resume -c tui.resume_cwd=session --yolo -m 'gpt-6-astra' -p 'work' ${SID2}` });
    expect(bo.revive).toEqual({ command: `claude --resume ${SID3}` });
  });

  it('refuses a foreground job nobody chose to end at the recheck, before it interrupts, signals or closes anything', async () => {
    const { store, world, deps } = boot([
      robot('c_ada', { tmux: win(1) }),
      robot('c_bo', { tmux: win(3), agent: agent('claude', 'working') }),
    ]);
    world.pane(1, { job: ['npm run dev', 'node vite'] });
    world.pane(3, { job: ['claude'] });
    const before = structuredClone(store.state);

    // were the recheck not first, the working agent would be interrupted at once
    const result = await restTerminals(deps, { choices: { interruptAfterMs: 0, terminate: [{ robotId: 'c_bo' }] } });

    expect(result).toEqual({
      ok: false,
      blockers: [{ code: 'shell_busy', message: "ada's terminal is running npm run dev", robotId: 'c_ada' }],
    });
    expect(world.log).toEqual([]);
    expect(store.state).toEqual(before);
    expect(deps.journal.read().terminated).toEqual([]);
  });

  it('refuses a blocked agent unless the choices say it may be interrupted', async () => {
    const { world, deps } = boot([robot('c_ada', { tmux: win(1), second: { cwd: '/s', unread: false, tmux: win(2), agent: agent('codex', 'blocked', SID2, 'Allow rm -rf build?') } })]);
    world.pane(1);
    world.pane(2, { job: ['codex'] });

    expect(await restTerminals(deps, { choices: { terminate: true } })).toEqual({
      ok: false,
      blockers: [{ code: 'agent_blocked', message: "ada's second terminal is waiting on an answer: Allow rm -rf build?", robotId: 'c_ada' }],
    });
    expect(world.log).toEqual([]);
  });

  it('waits on a working agent until its hook reports the turn over, and rests it on that event', async () => {
    const { store, world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    world.pane(1, { job: ['claude'] });
    let result: unknown;
    const run = restTerminals(deps, { choices: {}, pollMs: 500, waitMs: 60_000 }).then((r) => { result = r; });

    await world.settle();
    await world.advance(500);
    await world.advance(500);
    expect(result).toBeUndefined();
    expect(world.log).toEqual([]);

    // the Stop hook lands while the rest waits; no clock moves before the rest follows it
    store.update((d) => { d.robots.c_ada.agent!.status = 'done'; });
    await world.settle();
    await run;
    expect(result).toMatchObject({ ok: true });
    expect(world.log).toEqual(['detach c_ada', 'kill @1']);
  });

  it('reports an agent still working when the wait runs out, and never sends it Escape', async () => {
    const { world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    world.pane(1, { job: ['claude'] });
    let result: unknown;
    const run = restTerminals(deps, { choices: {}, pollMs: 500, waitMs: 2000 }).then((r) => { result = r; });

    await world.settle();
    for (let t = 0; t < 4; t++) await world.advance(500);
    await run;
    expect(result).toEqual({
      ok: false,
      blockers: [{ code: 'agent_working', message: "ada's terminal is still working", robotId: 'c_ada' }],
    });
    expect(world.log).toEqual([]);
  });

  it('interrupts a working agent only once the chosen delay has passed, and rests it when the process tree shows its tool command ended', async () => {
    const { store, world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    const pane = world.pane(1, { job: ['claude'], tools: ['/bin/zsh -c npm test'] });
    let result: unknown;
    const run = restTerminals(deps, { choices: { interruptAfterMs: 30_000 }, pollMs: 500, settleMs: 10_000 }).then((r) => { result = r; });

    await world.settle();
    await world.advance(29_500);
    expect(world.log).toEqual([]);
    await world.advance(500);
    expect(world.log).toEqual(['keys %1 1b']);

    // Claude Code reports no hook for an interrupted turn; the tool command is still running
    await world.advance(500);
    expect(result).toBeUndefined();
    delete pane.tools;
    await world.advance(500);
    await run;

    expect(result).toEqual({ ok: true, terminals: [{ robotId: 'c_ada' }] });
    expect(world.log).toEqual(['keys %1 1b', 'detach c_ada', 'kill @1']);
    // its turn was cut short, so its revive tells it what of its background work is gone
    expect(store.state.robots.c_ada.revive).toEqual({ command: `claude --resume ${SID}`, interrupted: true });
  });

  it('reports an interrupted agent that does not come to rest, and closes nothing', async () => {
    const { world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('claude', 'blocked') })]);
    world.pane(1, { job: ['claude'], tools: ['/bin/zsh -c npm test'] });
    let result: unknown;
    const run = restTerminals(deps, { choices: { interruptAfterMs: 0 }, pollMs: 500, settleMs: 2000 }).then((r) => { result = r; });

    await world.settle();
    for (let t = 0; t < 4; t++) await world.advance(500);
    await run;
    expect(result).toEqual({
      ok: false,
      // the command that keeps it from settling is named, for the sheet to show
      blockers: [{ code: 'agent_unsettled', message: "ada's terminal did not come to rest after it was interrupted: /bin/zsh -c npm test still runs", robotId: 'c_ada' }],
    });
    expect(world.log).toEqual(['keys %1 1b']);
  });

  it('waits out the turn of an agent beside a job suspended with ctrl+z, and only then terminates them both', async () => {
    const { store, world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    world.pane(1, { job: ['claude'], stopped: 'vim notes.md' });
    let result: unknown;
    const run = restTerminals(deps, { choices: { terminate: true }, pollMs: 500, waitMs: 60_000 }).then((r) => { result = r; });

    await world.settle();
    await world.advance(500);
    await world.advance(500);
    expect(result).toBeUndefined();
    expect(world.log).toEqual([]);

    store.update((d) => { d.robots.c_ada.agent!.status = 'done'; });
    await world.settle();
    await world.advance(500);
    await run;
    expect(result).toEqual({ ok: true, terminals: [{ robotId: 'c_ada' }] });
    // the stopped job takes its SIGTERM once continued
    expect(world.log).toEqual(['SIGTERM 1001', 'SIGTERM 1090', 'SIGCONT 1090', 'detach c_ada', 'kill @1']);
  });

  it('reports a job suspended beside an agent that settled after its interrupt, and closes nothing', async () => {
    const { world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    world.pane(1, { job: ['claude'], stopped: 'vim notes.md' });
    let result: unknown;
    const run = restTerminals(deps, { choices: { interruptAfterMs: 0 }, pollMs: 500, settleMs: 2000 }).then((r) => { result = r; });

    await world.settle();
    for (let t = 0; t < 2; t++) await world.advance(500);
    await run;
    expect(result).toEqual({
      ok: false,
      blockers: [{ code: 'shell_busy', message: "ada's terminal has vim notes.md suspended", robotId: 'c_ada' }],
    });
    expect(world.log).toEqual(['keys %1 1b']);
  });

  it('resumes an agent suspended with ctrl+z that it terminates with the launch flags it was started with', async () => {
    const { store, world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    world.pane(1, { stopped: 'claude --dangerously-skip-permissions --effort high' });

    const run = restTerminals(deps, { choices: { terminate: true }, pollMs: 500 });
    await world.settle();
    await world.advance(500);

    expect(await run).toEqual({ ok: true, terminals: [{ robotId: 'c_ada' }] });
    expect(world.log).toEqual(['SIGTERM 1090', 'SIGCONT 1090', 'detach c_ada', 'kill @1']);
    expect(store.state.robots.c_ada.revive).toEqual({ command: `claude --dangerously-skip-permissions --effort 'high' --resume ${SID}`, interrupted: true });
  });

  it('terminates an interrupted agent that will not settle when its terminal may be terminated, journaling it first and keeping the session it carries', async () => {
    const { store, world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    world.pane(1, { job: ['claude'], tools: ['/bin/zsh -c npm test'] });
    let journaled: unknown;
    world.onSignal = () => { journaled = deps.journal.read().terminated; };
    let result: unknown;
    const run = restTerminals(deps, {
      choices: { interruptAfterMs: 0, terminate: [{ robotId: 'c_ada' }] }, pollMs: 500, settleMs: 1000,
    }).then((r) => { result = r; });

    await world.settle();
    await world.advance(500);
    await world.advance(500);
    expect(world.log).toEqual(['keys %1 1b', 'SIGTERM 1001', 'SIGTERM 1050']);
    expect(journaled).toEqual([{ robotId: 'c_ada', processes: ['claude', '/bin/zsh -c npm test'] }]);
    // the agent's SessionEnd hook arrives as it exits
    store.update((d) => { delete d.robots.c_ada.agent; });
    await world.advance(500);
    await run;

    expect(result).toEqual({ ok: true, terminals: [{ robotId: 'c_ada' }] });
    expect(store.state.robots.c_ada.agent?.sessionId).toBe(SID);
    expect(store.state.robots.c_ada.revive).toEqual({ command: `claude --resume ${SID}`, interrupted: true });
    expect(deps.journal.read().terminated).toEqual([{ robotId: 'c_ada', processes: ['claude', '/bin/zsh -c npm test'] }]);
  });

  it("ends the tool commands of a terminal it terminates too, journaled first, and follows SIGTERM with SIGKILL for one that ignores it", async () => {
    const { world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    world.pane(1, { job: ['claude'], tools: ['/bin/zsh -c npm run dev'], stubbornTools: true });
    let journaled: unknown;
    world.onSignal = () => { journaled ??= deps.journal.read().terminated; };
    let result: unknown;
    const run = restTerminals(deps, {
      choices: { interruptAfterMs: 0, terminate: [{ robotId: 'c_ada' }] }, pollMs: 500, settleMs: 1000,
    }).then((r) => { result = r; });

    await world.settle();
    await world.advance(500);
    await world.advance(500);
    expect(world.log).toEqual(['keys %1 1b', 'SIGTERM 1001', 'SIGTERM 1050']);
    expect(journaled).toEqual([{ robotId: 'c_ada', processes: ['claude', '/bin/zsh -c npm run dev'] }]);
    // the agent is gone and its shell is back at the prompt, but the dev server it started still runs
    await world.advance(500);
    expect(result).toBeUndefined();
    await world.advance(500);
    expect(world.log).toEqual(['keys %1 1b', 'SIGTERM 1001', 'SIGTERM 1050', 'SIGKILL 1050']);
    await world.advance(500);
    await run;

    expect(result).toEqual({ ok: true, terminals: [{ robotId: 'c_ada' }] });
  });

  it("ends Codex's own-group helpers on the terminal with it when its terminal is terminated, and closes nothing until the last is gone", async () => {
    const { store, world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('codex', 'working') })]);
    const pane = world.pane(1, {
      job: ['codex'], tools: ['/bin/zsh -lc npm test'], servers: ['node_repl', '/opt/codex/bin/codex-code-mode-host'],
      lingeringServers: true, stubbornServers: ['/opt/codex/bin/codex-code-mode-host'],
    });
    let journaled: unknown;
    world.onSignal = () => { journaled ??= deps.journal.read().terminated; };
    let result: unknown;
    const run = restTerminals(deps, { choices: { interruptAfterMs: 0, terminate: true }, pollMs: 500, settleMs: 1000 })
      .then((r) => { result = r; });

    await world.settle();
    await world.advance(500);
    await world.advance(500);
    expect(world.log).toEqual(['keys %1 1b', 'SIGTERM 1001', 'SIGTERM 1050', 'SIGTERM 1070', 'SIGTERM 1071']);
    expect(journaled).toEqual([{ robotId: 'c_ada', processes: ['codex', '/bin/zsh -lc npm test', 'node_repl', '/opt/codex/bin/codex-code-mode-host'] }]);
    // Codex and its tool are gone and the shell is back at its prompt, but its code-mode host still holds on
    await world.advance(500);
    expect(result).toBeUndefined();
    await world.advance(500);
    expect(world.log.slice(5)).toEqual(['SIGKILL 1071']);
    await world.advance(500);
    await run;

    expect(result).toEqual({ ok: true, terminals: [{ robotId: 'c_ada' }] });
    expect(pane.servers?.filter(Boolean)).toEqual([]);
    expect(world.log.slice(6)).toEqual(['detach c_ada', 'kill @1']);
    expect(store.state.robots.c_ada.revive).toEqual({ command: `codex resume -c tui.resume_cwd=session ${SID}`, interrupted: true });
  });

  it('rests an idle agent still running commands in the background only by terminating it when chosen, and names those commands otherwise', async () => {
    const idle = () => boot([robot('c_ada', { tmux: win(1), agent: agent('claude', 'idle') })]);
    const kept = idle();
    kept.world.pane(1, { job: ['claude'], tools: ['/bin/zsh -c npm run dev'] });
    expect(await restTerminals(kept.deps, { choices: { interruptAfterMs: 0 } })).toEqual({
      ok: false,
      blockers: [{
        code: 'agent_unsettled', message: "ada's terminal is idle with work still running in the background: /bin/zsh -c npm run dev still runs",
        robotId: 'c_ada',
      }],
    });
    expect(kept.world.log).toEqual([]);

    const ended = idle();
    ended.world.pane(1, { job: ['claude'], tools: ['/bin/zsh -c npm run dev'] });
    let result: unknown;
    const run = restTerminals(ended.deps, { choices: { terminate: [{ robotId: 'c_ada' }] }, pollMs: 500, settleMs: 1000 }).then((r) => { result = r; });
    await ended.world.settle();
    await ended.world.advance(500);
    await run;
    expect(result).toMatchObject({ ok: true });
    expect(ended.world.log).toEqual(['SIGTERM 1001', 'SIGTERM 1050', 'detach c_ada', 'kill @1']);
    expect(ended.deps.journal.read().terminated).toEqual([{ robotId: 'c_ada', processes: ['claude', '/bin/zsh -c npm run dev'] }]);
    // what it ran in the background is gone, which its revive tells it
    expect(ended.store.state.robots.c_ada.revive).toEqual({ command: `claude --resume ${SID}`, interrupted: true });
  });

  it('holds up a Claude Code agent whose monitor still watches as one with a command left running, and rests it once ended with the note on what was stopped', async () => {
    const watching = () => boot([robot('c_ada', { tmux: win(1), agent: { ...agent('claude', 'done'), monitors: ['b1'] } })]);
    const kept = watching();
    kept.world.pane(1, { job: ['claude'], tools: ['/bin/zsh -c tail -f build.log'] });
    expect(await restTerminals(kept.deps, { choices: {} })).toEqual({
      ok: false,
      blockers: [{
        code: 'agent_unsettled', message: "ada's terminal is idle with work still running in the background: /bin/zsh -c tail -f build.log still runs",
        robotId: 'c_ada',
      }],
    });
    expect(kept.world.log).toEqual([]);

    const ended = watching();
    ended.world.pane(1, { job: ['claude'], tools: ['/bin/zsh -c tail -f build.log'] });
    let result: unknown;
    const run = restTerminals(ended.deps, { choices: { terminate: [{ robotId: 'c_ada' }] }, pollMs: 500, settleMs: 1000 }).then((r) => { result = r; });
    await ended.world.settle();
    await ended.world.advance(500);
    await run;
    expect(result).toMatchObject({ ok: true });
    expect(ended.world.log).toEqual(['SIGTERM 1001', 'SIGTERM 1050', 'detach c_ada', 'kill @1']);
    expect(ended.store.state.robots.c_ada.revive).toEqual({ command: `claude --resume ${SID}`, interrupted: true });
    expect(ended.store.state.robots.c_ada.agent?.monitors).toBeUndefined();
  });

  it('rests a Claude Code agent whose monitors the hooks still list though nothing of theirs runs, on either terminal, keeping neither their ids nor the note a crash leaves', async () => {
    const { store, world, deps } = boot([robot('c_ada', {
      tmux: win(1), agent: { ...agent('claude', 'done'), monitors: ['b1'] },
      second: { cwd: '/side', unread: false, tmux: win(2), agent: { ...agent('claude', 'idle', SID2), monitors: ['b2'] } },
    })]);
    world.pane(1, { job: ['claude'] });
    world.pane(2, { job: ['claude'] });

    expect((await restTerminals(deps, { choices: {} })).ok).toBe(true);

    const ada = store.state.robots.c_ada;
    expect(ada.revive).toEqual({ command: `claude --resume ${SID}` });
    expect(ada.agent?.monitors).toBeUndefined();
    expect(ada.second?.revive).toEqual({ command: `claude --resume ${SID2}` });
    expect(ada.second?.agent?.monitors).toBeUndefined();
  });

  it('waits for an interrupt chosen for later than the wait would last, and interrupts then', async () => {
    const { world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    world.pane(1, { job: ['claude'] });
    let result: unknown;
    const run = restTerminals(deps, { choices: { interruptAfterMs: 3000 }, waitMs: 1000, pollMs: 500, settleMs: 1000 })
      .then((r) => { result = r; });

    await world.settle();
    for (let t = 500; t < 3000; t += 500) await world.advance(500);
    expect(result).toBeUndefined();
    expect(world.log).toEqual([]);
    await world.advance(500);
    expect(world.log).toEqual(['keys %1 1b']);
    await world.advance(500);
    await run;

    expect(result).toEqual({ ok: true, terminals: [{ robotId: 'c_ada' }] });
  });

  it('ends a job only in the terminal the choice names, journaling it before the signal, and follows an ignored SIGTERM with SIGKILL', async () => {
    const { store, world, deps } = boot([robot('c_ada', { tmux: win(1), second: { cwd: '/s', unread: false, tmux: win(2) } })]);
    world.pane(1);
    world.pane(2, { job: ['tail -f build.log'], ignoresTerm: true });
    let journaled: unknown;
    world.onSignal = () => { journaled ??= deps.journal.read().terminated; };
    let result: unknown;
    const run = restTerminals(deps, { choices: { terminate: [{ robotId: 'c_ada', term: 2 }] }, pollMs: 500, settleMs: 1000 })
      .then((r) => { result = r; });

    await world.settle();
    expect(world.log).toEqual(['SIGTERM 2001']);
    expect(journaled).toEqual([{ robotId: 'c_ada', term: 2, processes: ['tail -f build.log'] }]);
    await world.advance(500);
    expect(result).toBeUndefined();
    await world.advance(500);
    expect(world.log).toEqual(['SIGTERM 2001', 'SIGKILL 2001']);
    await world.advance(500);
    await run;

    expect(result).toEqual({ ok: true, terminals: [{ robotId: 'c_ada' }, { robotId: 'c_ada', term: 2 }] });
    expect(world.log).toEqual(['SIGTERM 2001', 'SIGKILL 2001', 'detach c_ada', 'kill @1', 'kill @2']);
    expect(store.state.robots.c_ada.second?.revive).toEqual({ command: '' });
  });

  it('stops before closing anything when a shell at rest starts a job while an agent is still working', async () => {
    const { world, deps } = boot([
      robot('c_ada', { tmux: win(1), agent: agent('claude', 'working') }),
      robot('c_bo', { tmux: win(3) }),
    ]);
    world.pane(1, { job: ['claude'] });
    const bo = world.pane(3);
    let result: unknown;
    const run = restTerminals(deps, { choices: {}, pollMs: 500 }).then((r) => { result = r; });

    await world.settle();
    await world.advance(500);
    expect(result).toBeUndefined();
    bo.job = ['make release'];
    await world.advance(500);
    await run;

    expect(result).toEqual({
      ok: false,
      blockers: [{ code: 'shell_busy', message: "bo's terminal is running make release", robotId: 'c_bo' }],
    });
    expect(world.log).toEqual([]);
  });

  it("confirms an interrupted Codex, standalone or behind npm's launcher, once its tool command ends though its MCP servers stay", async () => {
    const { store, world, deps } = boot([
      robot('c_ada', { tmux: win(1), agent: agent('codex', 'working') }),
      robot('c_bo', { tmux: win(3), agent: agent('codex', 'working', SID2) }),
    ]);
    const standalone = world.pane(1, {
      job: ['codex'], servers: ['node_repl', 'node /opt/homebrew/bin/adlc mcp-server', '/opt/codex/bin/codex-code-mode-host'], tools: ['/bin/zsh -lc npm test'],
    });
    const npm = world.pane(3, {
      job: ['node /usr/local/bin/codex', '/usr/local/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/codex/codex'],
      servers: ['node /home/ada/mcp/server.js'], tools: ['/bin/bash -lc cargo build'],
    });
    let result: unknown;
    const run = restTerminals(deps, { choices: { interruptAfterMs: 0 }, pollMs: 500, settleMs: 10_000 }).then((r) => { result = r; });

    await world.settle();
    expect(world.log).toEqual(['keys %1 1b', 'keys %3 1b']);
    await world.advance(500);
    expect(result).toBeUndefined();
    delete standalone.tools;
    await world.advance(500);
    // the command runs under the native Codex, a level below the launcher holding the terminal
    expect(result).toBeUndefined();
    delete npm.tools;
    await world.advance(500);
    await run;

    expect(result).toEqual({
      ok: true,
      terminals: [
        { robotId: 'c_ada' },
        { robotId: 'c_bo' },
      ],
    });
    expect(store.state.robots.c_bo.revive).toEqual({ command: `codex resume -c tui.resume_cwd=session ${SID2}`, interrupted: true });
  });

  it('reads a terminal whose agent record has gone stale by what holds it, and neither rests nor interrupts that job unasked', async () => {
    const { world, deps } = boot([
      robot('c_ada', { tmux: win(1), agent: agent('claude', 'idle') }),
      robot('c_bo', { tmux: win(3), agent: agent('codex', 'working', SID2) }),
    ]);
    world.pane(1, { job: ['npm run dev'] });
    world.pane(3, { job: ['vim notes.md'] });

    expect(await restTerminals(deps, { choices: { interruptAfterMs: 0 } })).toEqual({
      ok: false,
      blockers: [
        { code: 'shell_busy', message: "ada's terminal is running npm run dev", robotId: 'c_ada' },
        { code: 'shell_busy', message: "bo's terminal is running vim notes.md", robotId: 'c_bo' },
      ],
    });
    expect(world.log).toEqual([]);
  });

  it('reclassifies from state on a hook event, and reads the process tree again only before it acts', async () => {
    const { store, world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    world.pane(1, { job: ['claude'] });
    let result: unknown;
    const run = restTerminals(deps, { choices: {}, pollMs: 500 }).then((r) => { result = r; });

    await world.settle();
    expect(world.reads).toBe(1);
    for (let pct = 10; pct < 60; pct += 10) {
      store.update((d) => { d.robots.c_ada.agent!.contextPct = pct; });
      await world.settle();
    }
    expect(world.reads).toBe(1);
    store.update((d) => { d.robots.c_ada.agent!.status = 'done'; });
    await world.settle();
    await run;

    expect(world.reads).toBe(2);
    expect(result).toMatchObject({ ok: true });
  });

  it('gives up on a ps that does not answer, closing nothing', async () => {
    const { world, deps } = boot([robot('c_ada', { tmux: win(1) })]);
    world.pane(1);
    world.hangPs = true;
    let error: unknown;
    const run = restTerminals(deps, { choices: {}, callTimeoutMs: 5000 }).catch((e) => { error = e; });

    await world.settle();
    await world.advance(4999);
    expect(error).toBeUndefined();
    await world.advance(1);
    await run;
    expect(String(error)).toMatch(/ps did not answer within 5000 ms/);
    // the ps it gave up on is told to go
    expect(world.psSignals[0]?.aborted).toBe(true);
    expect(world.log).toEqual([]);
  });

  it('leaves a terminal whose window it closed dormant with its session even when a later window will not close', async () => {
    const { store, world, deps, paths } = boot([
      robot('c_ada', { tmux: win(1), agent: agent('claude', 'idle') }),
      robot('c_bo', { tmux: win(3), agent: agent('codex', 'idle', SID2) }),
    ]);
    world.pane(1, { job: ['claude'] });
    world.pane(3, { job: ['codex'] });
    world.hangKill.add('@3');
    let error: unknown;
    const run = restTerminals(deps, { choices: {}, callTimeoutMs: 5000 }).catch((e) => { error = e; });

    await world.settle();
    await world.advance(5000);
    await run;
    expect(String(error)).toMatch(/kill-window did not answer/);

    // the first window is gone and its record says so, so the exit hook its agent sends next finds nothing to take
    const fleet = new Fleet({ store, tmux: new Tmux(paths.tmuxSock, paths.tmuxConf), paths, config: Config.parse({ id: fleetId }), log: silentLogger });
    await fleet.onSocketEvent({ hook: { robotId: 'c_ada', backend: 'claude', name: 'SessionEnd', sessionId: SID } });
    expect(store.state.robots.c_ada.tmux).toBeUndefined();
    expect(store.state.robots.c_ada.agent?.sessionId).toBe(SID);
    expect(store.state.robots.c_ada.revive).toEqual({ command: `claude --resume ${SID}` });
    expect(store.state.robots.c_bo.tmux).toEqual(win(3));
  });

  it('stops with the journal open and the slot live when a window is still open after its kill, laying only the ones closed before it dormant', async () => {
    const { store, world, deps } = boot([
      robot('c_ada', { tmux: win(1), agent: agent('claude', 'idle') }),
      robot('c_bo', { tmux: win(3), agent: agent('codex', 'idle', SID2) }),
    ]);
    world.pane(1, { job: ['claude'] });
    world.pane(3, { job: ['codex'] });
    world.keepOnKill.add('@3');

    await expect(restTerminals(deps, { choices: {} })).rejects.toThrow(/bo's terminal is still open/);

    expect(store.state.robots.c_ada).toMatchObject({ revive: { command: `claude --resume ${SID}` } });
    expect(store.state.robots.c_ada.tmux).toBeUndefined();
    expect(store.state.robots.c_bo.tmux).toEqual(win(3));
    expect(store.state.robots.c_bo.revive).toBeUndefined();
    expect(deps.journal.read().stoppedTerminals).toEqual([{ robotId: 'c_ada' }, { robotId: 'c_bo' }]);
  });

  it('still waits on a background job of an interrupted Claude, but not on its Svall statusline and hook', async () => {
    const { world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    const node = '/Applications/Svall.app/Contents/Helpers/node';
    const [script, status] = installedScripts('/Users/ada/.svall');
    const pane = world.pane(1, {
      job: ['claude'],
      tools: [
        `/bin/sh -c ${statusWrapper(node, status)} 'ccstatusline'`,
        `/bin/sh -c ${hookCommand(node, script, 'claude')}`,
        '/Users/ada/.svall/hooks/svall-hook claude 1001',
        '/bin/zsh -c npm run dev',
      ],
    });
    let result: unknown;
    const run = restTerminals(deps, { choices: { interruptAfterMs: 0 }, pollMs: 500, settleMs: 10_000 }).then((r) => { result = r; });

    await world.settle();
    await world.advance(500);
    expect(result).toBeUndefined();
    pane.tools = pane.tools!.slice(0, 3);
    await world.advance(500);
    await run;
    expect(result).toMatchObject({ ok: true });
  });

  it('reports a job that outlives its termination as a busy shell, even under a stale agent record', async () => {
    const { world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('claude', 'idle') })]);
    world.pane(1, { job: ['tail -f build.log'], unkillable: true });
    let result: unknown;
    const run = restTerminals(deps, { choices: { terminate: true }, pollMs: 500, settleMs: 1000 }).then((r) => { result = r; });

    await world.settle();
    for (let t = 0; t < 4; t++) await world.advance(500);
    await run;
    expect(world.log).toEqual(['SIGTERM 1001', 'SIGKILL 1001']);
    expect(result).toEqual({
      ok: false,
      blockers: [{ code: 'shell_busy', message: "ada's terminal is still running tail -f build.log after it was terminated", robotId: 'c_ada' }],
    });
  });

  it('stops waiting when cancelled, and closes nothing', async () => {
    const { world, deps } = boot([robot('c_ada', { tmux: win(1), agent: agent('claude', 'working') })]);
    world.pane(1, { job: ['claude'] });
    const cancel = new AbortController();
    const run = restTerminals(deps, { choices: {}, pollMs: 500, cancel: cancel.signal });

    await world.settle();
    await world.advance(500);
    cancel.abort();
    await expect(run).rejects.toThrow(/abort/i);
    expect(world.log).toEqual([]);
  });

  it('makes a terminal whose window already went dormant too', async () => {
    const { store, world, deps } = boot([
      robot('c_ada', { tmux: win(1), second: { cwd: '/s', unread: false, tmux: win(2), agent: agent('claude', 'idle', SID2) } }),
    ]);
    world.pane(1);

    const result = await restTerminals(deps, { choices: {} });

    expect(result).toEqual({ ok: true, terminals: [{ robotId: 'c_ada' }] });
    expect(world.log).toEqual(['detach c_ada', 'kill @1']);
    // the rest did not stop the second, so an abort has nothing of it to bring back, nor a destination to open
    expect(deps.journal.read().stoppedTerminals).toEqual([{ robotId: 'c_ada' }]);
    expect(store.state.robots.c_ada.second).toEqual({
      cwd: '/s', unread: false, agent: agent('claude', 'idle', SID2), revive: { command: `claude --resume ${SID2}` },
    });
  });
});

describe('unapproved', () => {
  it('names what would stop resting without touching anything, and leaves a working agent to be waited on', async () => {
    const world = new World();
    const state = emptyState();
    state.robots.c_ada = robot('c_ada', { tmux: win(1), agent: agent('claude', 'working'), second: { cwd: '/s', unread: false, tmux: win(2) } });
    state.robots.c_bo = robot('c_bo', { tmux: win(3), agent: agent('claude', 'blocked', SID2) });
    world.pane(1, { job: ['claude'] });
    world.pane(2, { job: ['npm run dev'] });
    world.pane(3, { job: ['claude'] });
    state.robots.c_cy = robot('c_cy', { tmux: win(4), agent: agent('claude', 'idle', SID2) });
    world.pane(4, { job: ['claude'], tools: ['/bin/zsh -c npm run dev'] });

    const terminals = classifyTerminals(state, await world.tmux.listWindows(), await world.processes());

    expect(terminals.map((t) => t.class)).toEqual(['agent-working', 'foreground', 'agent-blocked', 'agent-ready']);
    expect(unapproved(state, terminals, {}).map((b) => b.code)).toEqual(['shell_busy', 'agent_blocked', 'agent_unsettled']);
    expect(unapproved(state, terminals, { interruptAfterMs: 30_000, terminate: [{ robotId: 'c_ada', term: 2 }, { robotId: 'c_cy' }] })).toEqual([]);
    expect(world.log).toEqual([]);
  });

  it('takes a job suspended with ctrl+z as holding its terminal, and an agent holding the terminal beside one as that agent first', () => {
    const state = emptyState();
    state.robots.c_ada = robot('c_ada', { tmux: win(1), agent: agent('claude', 'working') });
    state.robots.c_bo = robot('c_bo', { tmux: win(2), agent: agent('claude', 'idle', SID2) });
    state.robots.c_cy = robot('c_cy', { tmux: win(3), agent: agent('claude', 'working', SID2) });
    state.robots.c_dee = robot('c_dee', { tmux: win(4), agent: agent('claude', 'blocked', SID2, 'Bash: rm -rf build') });
    const live = [1, 2, 3, 4].map((n) => ({ ...win(n), panePid: n * 1000, name: '', command: '', path: `/pane/${n}`, activity: 0, dead: false }));
    // a Claude started after vim was stopped
    const beside = (n: number) => [
      { pid: n, ppid: 1, pgid: n, tpgid: n + 2, stat: 'Ss', args: '-zsh' },
      { pid: n + 1, ppid: n, pgid: n + 1, tpgid: n + 2, stat: 'T', args: 'vim notes.md' },
      { pid: n + 2, ppid: n, pgid: n + 2, tpgid: n + 2, stat: 'S+', args: 'claude' },
    ];
    const table = new ProcessTable([
      // the shell has its terminal back from the Claude it stopped
      { pid: 1000, ppid: 1, pgid: 1000, tpgid: 1000, stat: 'Ss', args: '-zsh' },
      { pid: 1001, ppid: 1000, pgid: 1001, tpgid: 1000, stat: 'T', args: 'claude --dangerously-skip-permissions --effort high' },
      { pid: 1050, ppid: 1001, pgid: 1050, tpgid: 0, stat: 'Ss', args: '/bin/zsh -c npm test' },
      ...beside(2000), ...beside(3000), ...beside(4000),
    ]);

    const terminals = classifyTerminals(state, live, table);

    expect(terminals.map((t) => t.class)).toEqual(['foreground', 'agent-ready', 'agent-working', 'agent-blocked']);
    // the working agent is waited on, and the one waiting on an answer is answered or interrupted, before its stopped job counts
    expect(unapproved(state, terminals, {})).toEqual([
      { code: 'shell_busy', message: "ada's terminal has claude --dangerously-skip-permissions --effort high suspended", robotId: 'c_ada' },
      { code: 'shell_busy', message: "bo's terminal has vim notes.md suspended", robotId: 'c_bo' },
      { code: 'agent_blocked', message: "dee's terminal is waiting on an answer: Bash: rm -rf build", robotId: 'c_dee' },
    ]);
    expect(unapproved(state, terminals, { terminate: true }).map((b) => b.code)).toEqual(['agent_blocked']);
  });
});
