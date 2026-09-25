import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { expandHome } from '@archipelago/archid/paths';
import { AgentKind, type AgentStatus } from '@archipelago/protocol';
import type { Client } from '../client.js';
import { contextOptions, editContext, type ContextFlags } from '../context.js';
import { printResult, table } from '../format.js';
import { contextOf, stateOf } from '../render.js';
import { int, parsePair } from './parse.js';
import { charId, islandId, NoMatch } from './resolve.js';

// the protocol takes no term for the main terminal, so --term 1 becomes an absent one
export function termOf(v: string | undefined): 2 | undefined {
  if (v === undefined || v === '1') return undefined;
  if (v === '2') return 2;
  throw new Error(`bad --term "${v}", expected 1 or 2`);
}

export function charCommands(connect: () => Promise<Client>, json: () => boolean): Command {
  const cmd = new Command('char').description('manage characters');

  cmd.command('list').description("list every character, or one island's").option('--island <id>').action(async (o: { island?: string }) => {
    const c = await connect();
    const state = await c.call('state.get', {});
    const island = o.island ? islandId(state, o.island) : undefined;
    const chars = Object.values(state.characters).filter((ch) => !island || ch.islandId === island);
    printResult(chars, json(), () => table(chars.map((ch) => ({
      id: ch.id, island: state.islands[ch.islandId]?.name ?? ch.islandId, name: ch.name, state: stateOf(ch),
      ctx: contextOf(ch), branch: ch.repo?.branch ?? '', cwd: ch.cwd,
      cell: `${ch.cell.x},${ch.cell.y}`,
    }))));
    c.close();
  });

  cmd.command('new').description('make a character: a terminal on an island')
    .requiredOption('--island <id>').requiredOption('--cwd <path>')
    .option('--name <name>').option('--agent <name>', 'start claude or codex in its terminal').option('--claude', 'the same as --agent claude')
    .option('--command <cmd>').option('--cell <x,y>')
    .option('--run <text>', 'type text and Enter once the agent has started (needs --agent or --command)')
    .action(async (o: { island: string; cwd: string; name?: string; agent?: string; claude?: boolean; command?: string; cell?: string; run?: string }) => {
      const agent = o.agent ?? (o.claude ? 'claude' : undefined);
      if (agent !== undefined && !AgentKind.safeParse(agent).success) throw new Error(`unknown agent ${agent}; use claude or codex`);
      if (o.run && !agent && !o.command) throw new Error('--run needs --agent or --command');
      const c = await connect();
      const state = await c.call('state.get', {});
      // the daemon would give a taken name a number, and the name would go on reaching the character that has it
      const name = o.name?.toLowerCase();
      const taken = name !== undefined && Object.values(state.characters).find((ch) => ch.name.toLowerCase() === name);
      if (taken) { c.close(); throw new Error(`character "${taken.name}" already exists (${taken.id}); pick another name`); }
      const ch = await c.call('char.create', {
        islandId: islandId(state, o.island), cwd: path.resolve(expandHome(o.cwd)), name: o.name, command: agent ?? o.command,
        cell: o.cell ? (([x, y]) => ({ x, y }))(parsePair(o.cell, '--cell')) : undefined,
        run: o.run,
      });
      printResult(ch, json(), () => (ch.runSent === false ? `${ch.id} (prompt not sent)` : ch.id));
      c.close();
    });

  cmd.command('move <id>').description('move a character to another island or cell').requiredOption('--island <id>').option('--cell <x,y>', 'omit it and the daemon picks a free cell')
    .action(async (id: string, o: { island: string; cell?: string }) => {
      const c = await connect();
      const state = await c.call('state.get', {});
      const ch = await c.call('char.move', {
        id: charId(state, id), islandId: islandId(state, o.island),
        cell: o.cell ? (([x, y]) => ({ x, y }))(parsePair(o.cell, '--cell')) : undefined,
      });
      printResult(ch, json(), () => `${ch.id} ${stateOf(ch)}`);
      c.close();
    });

  cmd.command('run <id> <text...>').description("type text into a character's terminal, then Enter").option('--no-enter').option('--term <n>', 'terminal to type into: 1 (default) or 2')
    .action(async (id: string, text: string[], o: { enter: boolean; term?: string }) => {
      const c = await connect();
      const state = await c.call('state.get', {});
      await c.call('char.run', { id: charId(state, id), text: text.join(' '), enter: o.enter, term: termOf(o.term) });
      printResult({}, json(), () => 'sent');
      c.close();
    });

  cmd.command('read <id>').description("print the end of a character's screen, or of its transcript").option('--transcript').option('--lines <n>', 'screen lines, or turns with --transcript', '50').option('--term <n>', 'terminal to read: 1 (default) or 2')
    .action(async (id: string, o: { transcript?: boolean; lines: string; term?: string }) => {
      const c = await connect();
      const state = await c.call('state.get', {});
      const r = await c.call('char.read', { id: charId(state, id), source: o.transcript ? 'transcript' : 'screen', lines: int(o.lines, '--lines'), term: termOf(o.term) });
      printResult(r, json(), () => r.text);
      c.close();
    });

  cmd.command('wait <id>').description('wait for a status; exits 0 on a match, 2 on timeout, 3 when the character is gone').requiredOption('--until <statuses>').option('--timeout <seconds>', '', '600').option('--term <n>', 'terminal to wait on: 1 (default) or 2')
    .action(async (id: string, o: { until: string; timeout: string; term?: string }) => {
      const wait = { until: o.until.split(',') as AgentStatus[], timeoutMs: int(o.timeout, '--timeout') * 1000, term: termOf(o.term) };
      const c = await connect();
      const state = await c.call('state.get', {});
      let target: string | undefined;
      // a character closed before the wait began is as gone as one that closes during it; stderr tells a typo apart
      try { target = charId(state, id); } catch (e) {
        if (!(e instanceof NoMatch)) throw e;
        process.stderr.write(`archi: ${e.message}\n`);
      }
      const r = target === undefined ? { status: 'gone' as const } : await c.call('char.wait', { id: target, ...wait });
      printResult(r, json(), () => r.status);
      c.close();
      if (r.status === 'timeout') process.exitCode = 2;
      if (r.status === 'gone') process.exitCode = 3;
    });

  contextOptions(cmd.command('update <id>').description("change a character's name, note, island, context or instructions")
    .option('--name <n>').option('--note <n>').option('--note-file <path>', 'read the note from a file, for text a shell would mangle')
    .option('--island <id>'))
    .action(async (id: string, o: { name?: string; note?: string; noteFile?: string; island?: string } & ContextFlags & { instructions?: string }) => {
      if (o.note !== undefined && o.noteFile) throw new Error('use --note or --note-file, not both');
      const c = await connect();
      const state = await c.call('state.get', {});
      const current = state.characters[charId(state, id)];
      const context = editContext(current.context, o);
      const ch = await c.call('char.update', {
        id: current.id, name: o.name,
        note: o.noteFile ? fs.readFileSync(expandHome(o.noteFile), 'utf8').trim() : o.note,
        islandId: o.island && islandId(state, o.island), context, instructions: o.instructions,
      });
      printResult(ch, json(), () => `${ch.id} ${ch.name}`);
      c.close();
    });

  cmd.command('show <id>').description('print the brief the agent gets').action(async (id: string) => {
    const c = await connect();
    const state = await c.call('state.get', {});
    const r = await c.call('char.show', { id: charId(state, id) });
    printResult(r, json(), () => r.text);
    c.close();
  });

  for (const [name, method, what] of [
    ['seen', 'char.seen', "mark a character's last turn seen: done turns idle"],
    ['revive', 'char.revive', "resume a dormant character's session in a new terminal"],
  ] as const) {
    cmd.command(`${name} <id>`).description(what).action(async (id: string) => {
      const c = await connect();
      const state = await c.call('state.get', {});
      const ch = await c.call(method, { id: charId(state, id) });
      printResult(ch, json(), () => `${ch.id} ${stateOf(ch)}`);
      c.close();
    });
  }

  cmd.command('close <id>').description('delete a character, its terminal and its docs').action(async (id: string) => {
    const c = await connect();
    const state = await c.call('state.get', {});
    await c.call('char.close', { id: charId(state, id) });
    printResult({}, json(), () => 'closed');
    c.close();
  });

  return cmd;
}
