import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import { expandHome } from '@svall/svalld/paths';
import { AgentKind, ApiError, Refusal, WORKTREE_ACTION, convertLine, keptSession, moveSummary, type AgentStatus, type Blocker, type Delivery, type MoveSheet } from '@svall/protocol';
import type { Client } from '../client.js';
import { LOCAL } from '../controller/registry.js';
import { contextOptions, editContext, type ContextFlags } from '../context.js';
import { printResult, table } from '../format.js';
import { contextOf, resumeFailures, stateOf } from '../render.js';
import { withFleet } from './fleet.js';
import { robotSetupText, type There } from './host.js';
import { int, parseDuration, point } from './parse.js';
import { robotId, islandId, machineId, NoMatch } from './resolve.js';

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

/** `there`: how a machine is reached from this Mac's terminal, for the commands a move's list names. */
export function robotCommands(connect: () => Promise<Client>, json: () => boolean, there: (machine: string) => There): Command {
  const cmd = new Command('robot').alias('char').description('manage robots');
  // what run and send print: delivered or queued, or the refusal of an agent waiting on an answer, exiting 2
  const deliver = async (send: () => Promise<{ delivery: Delivery }>): Promise<void> => {
    try {
      const r = await send();
      printResult(r, json(), () => (r.delivery === 'queued' ? 'queued: it goes in once the prompt line is clear' : r.delivery));
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'blocked') throw e;
      process.stderr.write(`refused: ${e.message}\n`);
      process.exitCode = 2;
    }
  };

  cmd.command('list').description("list every robot, or one island's").option('--island <id>').action((o: { island?: string }) => withFleet(connect, async (_c, state) => {
    const island = o.island ? islandId(state, o.island) : undefined;
    const robots = Object.values(state.robots).filter((ch) => !island || ch.islandId === island);
    printResult(robots, json(), () => [table(robots.map((ch) => ({
      id: ch.id, island: state.islands[ch.islandId]?.name ?? ch.islandId, name: ch.name, state: stateOf(ch),
      ctx: contextOf(ch), branch: ch.repo?.branch ?? '', cwd: ch.cwd,
      cell: `${ch.cell.x},${ch.cell.y}`,
    }))), ...robots.flatMap(resumeFailures)].join('\n'));
  }));

  cmd.command('new').description('make a robot: a terminal on an island')
    .requiredOption('--island <id>').requiredOption('--cwd <path>')
    .option('--name <name>')
    .addOption(new Option('--agent [name]', 'start claude, codex or opencode in its terminal; without a name, the main agent').conflicts(['claude', 'codex', 'opencode', 'command']))
    .addOption(new Option('--claude', 'the same as --agent claude').conflicts(['codex', 'opencode', 'command']))
    .addOption(new Option('--codex', 'the same as --agent codex').conflicts(['opencode', 'command']))
    .addOption(new Option('--opencode', 'the same as --agent opencode').conflicts('command'))
    .option('--command <cmd>').option('--cell <x,y>')
    .option('--run <text>', 'type text and Enter once the agent has started; starts the main agent unless --agent or --command says otherwise; exits 2 when it could not be sent')
    .option('--agent-profile <name>', 'a role from the fleet\'s agent-profiles folder, e.g. reviewer')
    .addHelpText('after', `
Handing work to a new robot:
  svall robot new --island <id> --cwd <path> --name "<name>" --run "<prompt>"
  - In a git repo, a robot is told to start in a new worktree unless Settings turns that off; --cwd can name a worktree whose branch is the work and no other agent is in.
  - The prompt is all it knows: goal, paths, links, what done looks like.
  - Names: at most 24 characters, lower case: PR or ticket id, area, task, one or two words each: "#472 auth review", not "#472 deep review".
  - New island: svall island create "<name>" --description "<one line>".
  - Wait (svall robot wait <id> --until done,blocked) only when you need the result; closing is the user's call.
  - Check its work: svall robot read <id> --transcript, and its cwd and branch in svall status --json.
  - Message it, or any robot: svall robot send <id> "<text>"; it answers the same way. Its final message in full: svall robot read <id> --last.
  - Write ids out: a command holding $SVALL_ROBOT_ID asks the user for permission.`)
    .action(async (o: { island: string; cwd: string; name?: string; agent?: string | true; claude?: boolean; codex?: boolean; opencode?: boolean; command?: string; cell?: string; run?: string; agentProfile?: string }) => {
      if (typeof o.agent === 'string' && !AgentKind.safeParse(o.agent).success) throw new Error(`unknown agent ${o.agent}; use claude, codex or opencode`);
      const cell = point(o.cell, '--cell');
      await withFleet(connect, async (c, state) => {
        const agent = agentFor(o, state.mainAgent ?? 'claude');
        // the daemon would give a taken name a number, and the name would go on reaching the robot that has it
        const name = o.name?.toLowerCase();
        const taken = name !== undefined && Object.values(state.robots).find((ch) => ch.name.toLowerCase() === name);
        if (taken) throw new Error(`robot "${taken.name}" already exists (${taken.id}); pick another name`);
        const ch = await c.call('robot.create', {
          islandId: islandId(state, o.island), cwd: path.resolve(expandHome(o.cwd)), name: o.name, command: agent ?? o.command, cell, run: o.run, agentProfile: o.agentProfile,
        });
        printResult(ch, json(), () => ch.id);
        if (ch.runSent === false) {
          process.stderr.write(`prompt not sent; svall robot run ${ch.id} "<prompt>" sends it\n`);
          process.exitCode = 2;
        }
      });
    });

  cmd.command('move <id>').description('move a robot to another island or cell, or to run on another machine; a refused move exits 2')
    .option('--island <id>').option('--cell <x,y>', 'omit it and the daemon picks a free cell')
    .addOption(new Option('--machine <name>', 'a machine under Machines, or local for this Mac; prints what travels, then moves it').conflicts(['island', 'cell']))
    .addOption(new Option('--interrupt-after <duration>', 'interrupt what still runs after this long, e.g. 30s or 0').conflicts('island'))
    .addOption(new Option('--carry <file>', 'take a credential file such as .env along; repeatable').argParser((v: string, acc: string[] = []) => [...acc, v]).conflicts('island'))
    .addOption(new Option('--own-worktree', 'on a main checkout, move into a new worktree of its own at HEAD; the checkout keeps its changes').conflicts(['island', 'carry']))
    .addOption(new Option('--retry', 'run on the move the robot is in, from the step it stopped at').conflicts(['island', 'cell', 'machine', 'carry', 'interruptAfter', 'ownWorktree']))
    .action(async (id: string, { island, cell, machine: to, interruptAfter, carry, ownWorktree, retry }: { island?: string; cell?: string; machine?: string; interruptAfter?: string; carry?: string[]; ownWorktree?: boolean; retry?: boolean }) => {
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
        // this Mac is the home, whose id its own system.info answers; a worker's daemon answers its own, which the fleet lists
        const machine = to === LOCAL ? (await c.call('system.info', {})).machineId : machineId(state, to!);
        const worker = to === LOCAL && state.machines?.[machine];
        if (worker) { refuseMove({ reason: `this terminal is on ${worker.name}`, action: 'run this on the Mac', details: [] }, json()); return; }
        const params = { id: robot.id, machine, ...(carry && { carry }), ...(interruptAfterMs !== undefined && { interruptAfterMs }), ...(ownWorktree && { ownWorktree }) };
        const checked = await c.call('robot.moveCheck', params);
        if (!checked.ok) { refuseMove(checked.refusal, json()); return; }
        if (!json()) process.stdout.write(`${sheetLine(checked.sheet, robot.repo && path.basename(robot.repo.mainRoot), to === LOCAL ? 'this Mac' : state.machines![machine].name)}\n`);
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
          process.stdout.write(`${robotSetupText(setup, robot.name, name, there(name))}\n`);
        }
        printResult({ ok: true, sheet: checked.sheet, moveId, ...(setup.length > 0 && { setup }) }, json(), () => moveId);
      });
    });

  cmd.command('run <id> <text...>').description("type text into a robot's terminal, then Enter; prints delivered or queued, exits 2 when refused").option('--no-enter', 'leave the text in the prompt line, where runs after it queue until it is sent or cleared').option('--term <n>', 'terminal to type into: 1 (default) or 2')
    .action((id: string, text: string[], o: { enter: boolean; term?: string }) => withFleet(connect, (c, state) =>
      deliver(() => c.call('robot.run', { id: robotId(state, id), text: text.join(' '), enter: o.enter, term: termOf(o.term) }))));

  cmd.command('send <id> <text...>').description('message a robot as this one, which can answer the same way; prints delivered or queued, exits 2 when refused')
    .action((id: string, text: string[]) => {
      // a session an older svalld started carries SVALL_CHAR_ID
      const from = process.env.SVALL_ROBOT_ID ?? process.env.SVALL_CHAR_ID;
      if (!from) throw new Error('run this inside a robot; svall robot run types as the user');
      return withFleet(connect, (c, state) => deliver(() => c.call('robot.send', { id: robotId(state, id), from: robotId(state, from), text: text.join(' ') })));
    });

  cmd.command('read <id>').description("print the end of a robot's screen, or of its transcript, or its agent's last answer").option('--transcript')
    .addOption(new Option('--last', "the final message of the agent's newest turn, in full").conflicts('transcript'))
    .option('--lines <n>', 'screen lines, or turns with --transcript', '50').option('--term <n>', 'terminal to read: 1 (default) or 2')
    .action((id: string, o: { transcript?: boolean; last?: boolean; lines: string; term?: string }) => withFleet(connect, async (c, state) => {
      const r = await c.call('robot.read', { id: robotId(state, id), source: o.last ? 'last' : o.transcript ? 'transcript' : 'screen', lines: int(o.lines, '--lines', { min: 1 }), term: termOf(o.term) });
      printResult(r, json(), () => r.text);
    }));

  cmd.command('wait <id>').description('wait for a status; exits 0 on a match, 2 on timeout, 3 when the robot has no terminal (deleted or dormant)').requiredOption('--until <statuses>').option('--timeout <seconds>', '', '600').option('--term <n>', 'terminal to wait on: 1 (default) or 2')
    .action(async (id: string, o: { until: string; timeout: string; term?: string }) => {
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
    });

  contextOptions(cmd.command('update <id>').description("change a robot's name, note, island, context, instructions or agent profile")
    .option('--name <n>').option('--note <n>').option('--note-file <path>', 'read the note from a file, for text a shell would mangle')
    .option('--island <id>').option('--agent-profile <name>', 'a role from the fleet\'s agent-profiles folder; \'\' clears it'))
    .action(async (id: string, o: { name?: string; note?: string; noteFile?: string; island?: string; agentProfile?: string } & ContextFlags & { instructions?: string }) => {
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
    });

  cmd.command('show <id>').description('print the brief the agent gets').action((id: string) => withFleet(connect, async (c, state) => {
    const ch = state.robots[robotId(state, id)];
    const r = await c.call('robot.show', { id: ch.id });
    printResult(r, json(), () => r.text);
  }));

  cmd.command('seen <id>').description("mark a robot's last turn seen: done turns idle").action((id: string) => withFleet(connect, async (c, state) => {
    const ch = await c.call('robot.seen', { id: robotId(state, id) });
    printResult(ch, json(), () => `${ch.id} ${stateOf(ch)}`);
  }));

  cmd.command('revive <id>').description("resume a dormant robot's session in a new terminal")
    .option('--fresh', "start a new session instead, told what the one that could not resume held; that session's files stay")
    .option('--term <n>', 'with --fresh, the terminal: 1 (default) or 2')
    .action((id: string, o: { fresh?: boolean; term?: string }) => {
      if (o.term !== undefined && !o.fresh) throw new Error('--term goes with --fresh');
      const term = termOf(o.term);
      return withFleet(connect, async (c, state) => {
        const target = robotId(state, id);
        const old = (term === 2 ? state.robots[target]?.second : state.robots[target])?.agent;
        const ch = o.fresh ? await c.call('robot.fresh', { id: target, ...(term && { term }) }) : await c.call('robot.revive', { id: target });
        printResult(ch, json(), () => `${ch.id} ${stateOf(ch)}${o.fresh && old ? `; ${keptSession(old)}` : ''}`);
      });
    });

  cmd.command('close <id>').description('delete a robot, its terminal and its docs').action((id: string) => withFleet(connect, async (c, state) => {
    await c.call('robot.close', { id: robotId(state, id) });
    printResult({}, json(), () => 'closed');
  }));

  return cmd;
}
