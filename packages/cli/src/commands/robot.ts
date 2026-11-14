import fs from 'node:fs';
import path from 'node:path';
import { homeWord } from '@svall/svalld/machine';
import { expandHome } from '@svall/svalld/paths';
import type { AgentStatus, Blocker, MoveSheet, SendDelivery } from '@svall/protocol';
import { Refusal, WORKTREE_ACTION, convertLine, moveSummary } from '@svall/protocol/placement';
import { RELAY_LIMIT } from '@svall/protocol/robot-message';
import { AgentKind, keptSession } from '@svall/protocol/state';
import { ApiError } from '@svall/protocol/wire';
import type { Client } from '../client.js';
import { LOCAL } from '../controller/registry.js';
import { editContext, type ContextFlags } from '../context.js';
import { printResult, table } from '../format.js';
import { contextOf, resumeFailures, stateOf } from '../render.js';
import type { There } from './host.js';
import { int, parseDuration, point } from './parse.js';
import { robotId, islandId, machineId, NoMatch } from './resolve.js';
import { withFleet } from '../client.js';

const MODEL_ONLY = /^(claude|codex|opencode) (--model|-m) [\w.:/-]+$/;

// the robot this CLI runs in; a session an older svalld started carries SVALL_CHAR_ID
const callerRobot = (): string | undefined => process.env.SVALL_ROBOT_ID ?? process.env.SVALL_CHAR_ID;

/** The agent `svall robot new` starts: a named one, or the main agent for a bare --agent or a --run with no --command. */
export function agentFor(o: { agent?: string | true; claude?: boolean; codex?: boolean; opencode?: boolean; command?: string; run?: string }, main: AgentKind): string | undefined {
  const named = o.agent === true ? main : o.agent ?? (o.claude ? 'claude' : o.codex ? 'codex' : o.opencode ? 'opencode' : undefined);
  return named ?? (o.run && !o.command ? main : undefined);
}

// the protocol takes no term for the main terminal, so --term 1 becomes an absent one
export function termOf(v: string | undefined): 2 | undefined {
  if (v === undefined || v === '1') return undefined;
  if (v === '2') return 2;
  throw new Error(`bad --term "${v}", expected 1 or 2`);
}

/** What a move carries, as one line, with what it does to a main checkout and to a question or a turn under way. */
function sheetLine(s: MoveSheet, repo: string | undefined, machine: string): string {
  return [
    moveSummary(s, repo, machine),
    ...(s.converts ? [convertLine(s.converts)] : []),
    ...(s.question ? ['its open question is dropped; it asks again'] : []),
    ...(s.interrupts ? ['what still runs is interrupted'] : []),
  ].join(' · ');
}

// each check that failed as one sentence and one action, the first as the refusal, as the checks or the move itself refused it
function refuseMove(r: Refusal, json: boolean): void {
  if (json) printResult({ ok: false, refusal: r }, true);
  else {
    const line = (b: Blocker, head: string): string => `${head}: ${b.reason}\n  → ${b.action}${b.action === WORKTREE_ACTION ? ' (--own-worktree)' : ''}\n`;
    process.stderr.write([line(r, 'refused'), ...(r.more ?? []).map((b) => line(b, 'and'))].join(''));
  }
  process.exitCode = 2;
}

export function robotActions(connect: () => Promise<Client>, json: () => boolean, there: (machine: string) => There | Promise<There>) {
  // what run and send print: delivered, queued or held, or the refusal of an agent waiting on an answer, exiting 2
  const deliver = async (send: () => Promise<{ delivery: SendDelivery }>): Promise<void> => {
    try {
      const r = await send();
      printResult(r, json(), () => (r.delivery === 'queued' ? 'queued: it goes in once the prompt line is clear'
        : r.delivery === 'held' ? `held: it has taken ${RELAY_LIMIT} robot messages since the user last prompted it; it goes in once the user lets it` : r.delivery));
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'blocked') throw e;
      process.stderr.write(`refused: ${e.message}\n`);
      process.exitCode = 2;
    }
  };

  return {
    list: (o: { island?: string; startedBy?: string }) => withFleet(connect, async (_c, state) => {
    const island = o.island ? islandId(state, o.island) : undefined;
    const by = o.startedBy ? robotId(state, o.startedBy) : undefined;
    const robots = Object.values(state.robots).filter((ch) => (!island || ch.islandId === island) && (!by || ch.startedBy === by));
    printResult(robots, json(), () => [table(robots.map((ch) => ({
      id: ch.id, island: state.islands[ch.islandId]?.name ?? ch.islandId, name: ch.name, state: stateOf(ch),
      ctx: contextOf(ch), branch: ch.repo?.branch ?? '', cwd: ch.cwd,
      cell: `${ch.cell.x},${ch.cell.y}`,
    }))), ...robots.flatMap(resumeFailures)].join('\n'));
    }),

    new: async (o: { island: string; cwd: string; name?: string; agent?: string | true; claude?: boolean; codex?: boolean; opencode?: boolean; command?: string; cell?: string; run?: string; agentProfile?: string; report?: boolean }) => {
      if (typeof o.agent === 'string' && !AgentKind.safeParse(o.agent).success) throw new Error(`unknown agent ${o.agent}; use claude, codex or opencode`);
      const by = callerRobot();
      if (o.report && !o.run) throw new Error('--report needs --run: it reports on that prompt');
      if (o.report && !by) throw new Error('--report needs a robot to report to; run it inside one');
      // a report goes to the robot's first terminal
      if (o.report && process.env.SVALL_TERM === '2') throw new Error("start it from the robot's first terminal, where the report comes back");
      const cell = point(o.cell, '--cell');
      await withFleet(connect, async (c, state) => {
        // with svallPermissions on, an agent's svall calls skip the permission prompt, so a command it starts may only pick a model
        if (o.command && state.svallPermissions && by && !MODEL_ONLY.test(o.command.trim())) {
          throw new Error('in a robot, --command only picks an agent\'s model ("claude --model opus") while robots run svall without asking; run it outside Svall, or turn that off in Settings');
        }
        const agent = agentFor(o, state.mainAgent ?? 'claude');
        if (o.report && !Object.hasOwn(state.robots, by!)) throw new Error(`robot ${by} is no longer in the fleet, so --report has nobody to report to`);
        // the daemon would give a taken name a number, and the name would go on reaching the robot that has it
        const name = o.name?.toLowerCase();
        const taken = name !== undefined && Object.values(state.robots).find((ch) => ch.name.toLowerCase() === name);
        if (taken) throw new Error(`robot "${taken.name}" already exists (${taken.id}); pick another name`);
        const ch = await c.call('robot.create', {
          islandId: islandId(state, o.island), cwd: path.resolve(expandHome(o.cwd)), name: o.name, command: agent ?? o.command, cell, run: o.run, agentProfile: o.agentProfile,
          ...(by && Object.hasOwn(state.robots, by) && { startedBy: by }), ...(o.report && { report: true }),
        });
        printResult(ch, json(), () => ch.id);
        if (ch.runSent === false) {
          process.stderr.write(o.report ? `prompt not sent; svall robot send ${ch.id} "<prompt>" --report sends it\n` : `prompt not sent; svall robot run ${ch.id} "<prompt>" sends it\n`);
          process.exitCode = 2;
        }
      });
    },

    move: async (id: string, { island, cell, machine: to, interruptAfter, carry, ownWorktree, retry }: { island?: string; cell?: string; machine?: string; interruptAfter?: string; carry?: string[]; ownWorktree?: boolean; retry?: boolean }) => {
      if (!island && !to && !retry) throw new Error('name one of --island, --machine and --retry');
      if (retry) {
        await withFleet(connect, async (c, state) => {
          const robot = state.robots[robotId(state, id)];
          if (!robot.moving) throw new Error(`${robot.name} is in no move to retry`);
          const moveId = robot.moving.id;
          await c.call('robot.moveRetry', { moveId });
          printResult({ moveId }, json(), () => moveId);
        });
        return;
      }
      if (island) {
        await withFleet(connect, async (c, state) => {
          const ch = await c.call('robot.move', { id: robotId(state, id), islandId: islandId(state, island), cell: point(cell, '--cell') });
          printResult(ch, json(), () => `${ch.id} ${stateOf(ch)}`);
        });
        return;
      }
      const interruptAfterMs = interruptAfter === undefined ? undefined : parseDuration(interruptAfter);
      await withFleet(connect, async (c, state) => {
        const robot = state.robots[robotId(state, id)];
        // this machine is the home, whose id its own system.info answers; a worker's daemon answers its own, which the fleet lists
        const machine = to === LOCAL ? (await c.call('system.info', {})).machineId : machineId(state, to!);
        const worker = to === LOCAL && state.machines?.[machine];
        if (worker) { refuseMove({ reason: `this terminal is on ${worker.name}`, action: `run this on ${(await c.call('fleet.home', {})).name}`, details: [] }, json()); return; }
        const params = { id: robot.id, machine, ...(carry && { carry }), ...(interruptAfterMs !== undefined && { interruptAfterMs }), ...(ownWorktree && { ownWorktree }) };
        const checked = await c.call('robot.moveCheck', params);
        if (!checked.ok) { refuseMove(checked.refusal, json()); return; }
        if (!json()) process.stdout.write(`${sheetLine(checked.sheet, robot.repo && path.basename(robot.repo.mainRoot), to === LOCAL ? homeWord() : state.machines![machine].name)}\n`);
        let moveId: string;
        try {
          ({ moveId } = await c.call('robot.moveTo', params));
        } catch (e) {
          const refusal = e instanceof ApiError && e.code === 'refused' ? Refusal.safeParse(e.data?.refusal) : undefined;
          if (!refusal?.success) throw e;
          refuseMove(refusal.data, json());
          return;
        }
        // what of its agent setup will not work where it lands, which a daemon that cannot list it, as a worker's, leaves
        // unsaid; the way back to this Mac takes it all along
        const rows = to === LOCAL ? [] : (await c.call('machines.setup', { machine, robot: robot.id }).catch(() => ({ rows: [] }))).rows;
        const setup = rows.filter((r) => r.gap);
        if (setup.length && !json()) {
          const name = state.machines![machine].name;
          const { robotSetupText } = await import('./host.js');
          process.stdout.write(`${robotSetupText(setup, robot.name, name, await there(name))}\n`);
        }
        printResult({ ok: true, sheet: checked.sheet, moveId, ...(setup.length > 0 && { setup }) }, json(), () => moveId);
      });
    },

    run: (id: string, text: string[], o: { enter: boolean; term?: string }) => withFleet(connect, (c, state) =>
      deliver(() => c.call('robot.run', { id: robotId(state, id), text: text.join(' '), enter: o.enter, term: termOf(o.term) }))),

    send: (id: string, text: string[], o: { report?: boolean }) => {
      const from = callerRobot();
      if (!from) throw new Error('run this inside a robot; svall robot run types as the user');
      // the header names the robot, not the terminal, so an answer goes to its first
      if (process.env.SVALL_TERM === '2') throw new Error("send from the robot's first terminal, where an answer comes back");
      return withFleet(connect, (c, state) => deliver(() => c.call('robot.send', { id: robotId(state, id), from: robotId(state, from), text: text.join(' '), ...(o.report && { report: true }) })));
    },

    read: (id: string, o: { transcript?: boolean; last?: boolean; lines: string; term?: string }) => withFleet(connect, async (c, state) => {
      const r = await c.call('robot.read', { id: robotId(state, id), source: o.last ? 'last' : o.transcript ? 'transcript' : 'screen', lines: int(o.lines, '--lines', { min: 1 }), term: termOf(o.term) });
      printResult(r, json(), () => r.text);
    }),

    wait: async (id: string, o: { until: string; timeout: string; term?: string }) => {
      // the client's own timer takes 31 bits of milliseconds
      const wait = { until: o.until.split(',') as AgentStatus[], timeoutMs: int(o.timeout, '--timeout', { min: 0, max: 2_000_000 }) * 1000, term: termOf(o.term) };
      const r = await withFleet(connect, async (c, state) => {
        let target: string | undefined;
        // a robot closed before the wait began is as gone as one that closes during it; stderr tells a typo apart
        try { target = robotId(state, id); } catch (e) {
          if (!(e instanceof NoMatch)) throw e;
          process.stderr.write(`svall: ${e.message}\n`);
        }
        return target === undefined ? { status: 'gone' as const } : await c.call('robot.wait', { id: target, ...wait });
      });
      printResult(r, json(), () => r.status);
      if (r.status === 'timeout') process.exitCode = 2;
      if (r.status === 'gone') process.exitCode = 3;
    },

    update: async (id: string, o: { name?: string; note?: string; noteFile?: string; island?: string; agentProfile?: string } & ContextFlags & { instructions?: string }) => {
      if (o.note !== undefined && o.noteFile) throw new Error('use --note or --note-file, not both');
      await withFleet(connect, async (c, state) => {
        const current = state.robots[robotId(state, id)];
        const ch = await c.call('robot.update', {
          id: current.id, name: o.name,
          note: o.noteFile ? fs.readFileSync(expandHome(o.noteFile), 'utf8').trim() : o.note,
          islandId: o.island && islandId(state, o.island), context: editContext(current.context, o), removed: o.drop.length ? o.drop : undefined, instructions: o.instructions, agentProfile: o.agentProfile,
        });
        printResult(ch, json(), () => `${ch.id} ${ch.name}`);
      });
    },

    show: (id: string) => withFleet(connect, async (c, state) => {
    const ch = state.robots[robotId(state, id)];
    const r = await c.call('robot.show', { id: ch.id });
    printResult(r, json(), () => r.text);
    }),

    seen: (id: string) => withFleet(connect, async (c, state) => {
    const ch = await c.call('robot.seen', { id: robotId(state, id) });
    printResult(ch, json(), () => `${ch.id} ${stateOf(ch)}`);
    }),

    revive: (id: string, o: { fresh?: boolean; term?: string }) => {
      if (o.term !== undefined && !o.fresh) throw new Error('--term goes with --fresh');
      const term = termOf(o.term);
      return withFleet(connect, async (c, state) => {
        const target = robotId(state, id);
        const old = (term === 2 ? state.robots[target]?.second : state.robots[target])?.agent;
        const ch = o.fresh ? await c.call('robot.fresh', { id: target, ...(term && { term }) }) : await c.call('robot.revive', { id: target });
        printResult(ch, json(), () => `${ch.id} ${stateOf(ch)}${o.fresh && old ? `; ${keptSession(old)}` : ''}`);
      });
    },

    close: (id: string) => withFleet(connect, async (c, state) => {
      await c.call('robot.close', { id: robotId(state, id) });
      printResult({}, json(), () => 'closed');
    }),
  };
}
