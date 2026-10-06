import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import { expandHome } from '@svall/svalld/paths';
import { AgentKind, type AgentStatus } from '@svall/protocol';
import type { Client } from '../client.js';
import { contextOptions, editContext, type ContextFlags } from '../context.js';
import { printResult, table } from '../format.js';
import { contextOf, stateOf } from '../render.js';
import { withFleet } from './fleet.js';
import { int, point } from './parse.js';
import { charId, islandId, NoMatch } from './resolve.js';

/** The agent `svall char new` starts: a named one, or the main agent for a bare --agent or a --run with no --command. */
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

export function charCommands(connect: () => Promise<Client>, json: () => boolean): Command {
  const cmd = new Command('char').description('manage characters');

  cmd.command('list').description("list every character, or one island's").option('--island <id>').action((o: { island?: string }) => withFleet(connect, async (_c, state) => {
    const island = o.island ? islandId(state, o.island) : undefined;
    const chars = Object.values(state.characters).filter((ch) => !island || ch.islandId === island);
    printResult(chars, json(), () => table(chars.map((ch) => ({
      id: ch.id, island: state.islands[ch.islandId]?.name ?? ch.islandId, name: ch.name, state: stateOf(ch),
      ctx: contextOf(ch), branch: ch.repo?.branch ?? '', cwd: ch.cwd,
      cell: `${ch.cell.x},${ch.cell.y}`,
    }))));
  }));

  cmd.command('new').description('make a character: a terminal on an island')
    .requiredOption('--island <id>').requiredOption('--cwd <path>')
    .option('--name <name>')
    .addOption(new Option('--agent [name]', 'start claude, codex or opencode in its terminal; without a name, the main agent').conflicts(['claude', 'codex', 'opencode', 'command']))
    .addOption(new Option('--claude', 'the same as --agent claude').conflicts(['codex', 'opencode', 'command']))
    .addOption(new Option('--codex', 'the same as --agent codex').conflicts(['opencode', 'command']))
    .addOption(new Option('--opencode', 'the same as --agent opencode').conflicts('command'))
    .option('--command <cmd>').option('--cell <x,y>')
    .option('--run <text>', 'type text and Enter once the agent has started; starts the main agent unless --agent or --command says otherwise')
    .option('--agent-profile <name>', 'a role from the fleet\'s agent-profiles folder, e.g. reviewer')
    .addHelpText('after', `
Handing work to a new character:
  svall char new --island <id> --cwd <path> --name "<name>" --run "<prompt>"
  - In a git repo, a character given --run moves into a worktree of its own unless Settings turns that off; --cwd can name one no agent works in.
  - The prompt is all it knows: goal, paths, links, what done looks like.
  - Names: at most 24 characters, lower case: PR or ticket id, area, task, one or two words each: "#472 auth review", not "#472 deep review r3".
  - New island: svall island create "<name>" --description "<one line>".
  - Wait (svall char wait <id> --until done,blocked) only when you need the result; closing is the user's call.
  - Write ids out: a command holding $SVALL_CHAR_ID asks the user for permission.`)
    .action(async (o: { island: string; cwd: string; name?: string; agent?: string | true; claude?: boolean; codex?: boolean; opencode?: boolean; command?: string; cell?: string; run?: string; agentProfile?: string }) => {
      if (typeof o.agent === 'string' && !AgentKind.safeParse(o.agent).success) throw new Error(`unknown agent ${o.agent}; use claude, codex or opencode`);
      const cell = point(o.cell, '--cell');
      await withFleet(connect, async (c, state) => {
        const agent = agentFor(o, state.mainAgent ?? 'claude');
        // the daemon would give a taken name a number, and the name would go on reaching the character that has it
        const name = o.name?.toLowerCase();
        const taken = name !== undefined && Object.values(state.characters).find((ch) => ch.name.toLowerCase() === name);
        if (taken) throw new Error(`character "${taken.name}" already exists (${taken.id}); pick another name`);
        const ch = await c.call('char.create', {
          islandId: islandId(state, o.island), cwd: path.resolve(expandHome(o.cwd)), name: o.name, command: agent ?? o.command, cell, run: o.run, agentProfile: o.agentProfile,
        });
        printResult(ch, json(), () => (ch.runSent === false ? `${ch.id} (prompt not sent)` : ch.id));
      });
    });

  cmd.command('move <id>').description('move a character to another island or cell').requiredOption('--island <id>').option('--cell <x,y>', 'omit it and the daemon picks a free cell')
    .action((id: string, o: { island: string; cell?: string }) => withFleet(connect, async (c, state) => {
      const ch = await c.call('char.move', { id: charId(state, id), islandId: islandId(state, o.island), cell: point(o.cell, '--cell') });
      printResult(ch, json(), () => `${ch.id} ${stateOf(ch)}`);
    }));

  cmd.command('run <id> <text...>').description("type text into a character's terminal, then Enter").option('--no-enter').option('--term <n>', 'terminal to type into: 1 (default) or 2')
    .action((id: string, text: string[], o: { enter: boolean; term?: string }) => withFleet(connect, async (c, state) => {
      await c.call('char.run', { id: charId(state, id), text: text.join(' '), enter: o.enter, term: termOf(o.term) });
      printResult({}, json(), () => 'sent');
    }));

  cmd.command('read <id>').description("print the end of a character's screen, or of its transcript").option('--transcript').option('--lines <n>', 'screen lines, or turns with --transcript', '50').option('--term <n>', 'terminal to read: 1 (default) or 2')
    .action((id: string, o: { transcript?: boolean; lines: string; term?: string }) => withFleet(connect, async (c, state) => {
      const r = await c.call('char.read', { id: charId(state, id), source: o.transcript ? 'transcript' : 'screen', lines: int(o.lines, '--lines', { min: 1 }), term: termOf(o.term) });
      printResult(r, json(), () => r.text);
    }));

  cmd.command('wait <id>').description('wait for a status; exits 0 on a match, 2 on timeout, 3 when the character is gone').requiredOption('--until <statuses>').option('--timeout <seconds>', '', '600').option('--term <n>', 'terminal to wait on: 1 (default) or 2')
    .action(async (id: string, o: { until: string; timeout: string; term?: string }) => {
      // the client's own timer takes 31 bits of milliseconds
      const wait = { until: o.until.split(',') as AgentStatus[], timeoutMs: int(o.timeout, '--timeout', { min: 0, max: 2_000_000 }) * 1000, term: termOf(o.term) };
      const r = await withFleet(connect, async (c, state) => {
        let target: string | undefined;
        // a character closed before the wait began is as gone as one that closes during it; stderr tells a typo apart
        try { target = charId(state, id); } catch (e) {
          if (!(e instanceof NoMatch)) throw e;
          process.stderr.write(`svall: ${e.message}\n`);
        }
        return target === undefined ? { status: 'gone' as const } : await c.call('char.wait', { id: target, ...wait });
      });
      printResult(r, json(), () => r.status);
      if (r.status === 'timeout') process.exitCode = 2;
      if (r.status === 'gone') process.exitCode = 3;
    });

  contextOptions(cmd.command('update <id>').description("change a character's name, note, island, context, instructions or agent profile")
    .option('--name <n>').option('--note <n>').option('--note-file <path>', 'read the note from a file, for text a shell would mangle')
    .option('--island <id>').option('--agent-profile <name>', 'a role from the fleet\'s agent-profiles folder; \'\' clears it'))
    .action(async (id: string, o: { name?: string; note?: string; noteFile?: string; island?: string; agentProfile?: string } & ContextFlags & { instructions?: string }) => {
      if (o.note !== undefined && o.noteFile) throw new Error('use --note or --note-file, not both');
      await withFleet(connect, async (c, state) => {
        const current = state.characters[charId(state, id)];
        const ch = await c.call('char.update', {
          id: current.id, name: o.name,
          note: o.noteFile ? fs.readFileSync(expandHome(o.noteFile), 'utf8').trim() : o.note,
          islandId: o.island && islandId(state, o.island), context: editContext(current.context, o), instructions: o.instructions, agentProfile: o.agentProfile,
        });
        printResult(ch, json(), () => `${ch.id} ${ch.name}`);
      });
    });

  cmd.command('show <id>').description('print the brief the agent gets').action((id: string) => withFleet(connect, async (c, state) => {
    const r = await c.call('char.show', { id: charId(state, id) });
    printResult(r, json(), () => r.text);
  }));

  for (const [name, method, what] of [
    ['seen', 'char.seen', "mark a character's last turn seen: done turns idle"],
    ['revive', 'char.revive', "resume a dormant character's session in a new terminal"],
  ] as const) {
    cmd.command(`${name} <id>`).description(what).action((id: string) => withFleet(connect, async (c, state) => {
      const ch = await c.call(method, { id: charId(state, id) });
      printResult(ch, json(), () => `${ch.id} ${stateOf(ch)}`);
    }));
  }

  cmd.command('close <id>').description('delete a character, its terminal and its docs').action((id: string) => withFleet(connect, async (c, state) => {
    await c.call('char.close', { id: charId(state, id) });
    printResult({}, json(), () => 'closed');
  }));

  return cmd;
}
