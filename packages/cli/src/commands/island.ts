import { Command } from 'commander';
import type { Client } from '../client.js';
import { contextOptions, editContext, type ContextFlags } from '../context.js';
import { printResult, table } from '../format.js';
import { withClient, withFleet } from './fleet.js';
import { num, point, size } from './parse.js';
import { islandId } from './resolve.js';

export function islandCommands(connect: () => Promise<Client>, json: () => boolean): Command {
  const cmd = new Command('island').description('manage islands');

  cmd.command('list').description('list every island').action(() => withFleet(connect, async (_c, state) => {
    const islands = Object.values(state.islands);
    const count = (id: string) => Object.values(state.characters).filter((ch) => ch.islandId === id).length;
    printResult(islands, json(), () => table(islands.map((i) => ({
      id: i.id, name: i.name, kind: i.kind ?? '', characters: String(count(i.id)), size: `${i.size.w}x${i.size.h}`, at: `${i.position.x},${i.position.y}`,
    }))));
  }));

  contextOptions(cmd.command('create <name>').description('make an island')
    .option('--at <x,y>').option('--size <w,h>').option('--description <d>'))
    .action((name: string, o: { at?: string; size?: string; description?: string; instructions?: string } & ContextFlags) => withFleet(connect, async (c, state) => {
      // the daemon would give a colliding name a number rather than refuse it, and the fleet would carry a twin
      const taken = Object.values(state.islands).find((i) => i.name.toLowerCase() === name.toLowerCase());
      if (taken) throw new Error(`island "${taken.name}" already exists (${taken.id}); move characters onto it or pick another name`);
      const island = await c.call('island.create', {
        name, description: o.description, context: editContext([], o), instructions: o.instructions, position: point(o.at, '--at'), size: size(o.size, '--size'),
      });
      printResult(island, json(), () => island.id);
    }));

  cmd.command('rename <id> <name>').description('rename an island').action((id: string, name: string) => withFleet(connect, async (c, state) => {
    const island = await c.call('island.update', { id: islandId(state, id), name });
    printResult(island, json(), () => `${island.id} ${island.name}`);
  }));

  contextOptions(cmd.command('update <id>').description("change an island's name, description, place, size, context or instructions")
    .option('--name <n>').option('--description <d>').option('--at <x,y>').option('--size <w,h>'))
    .action((id: string, o: { name?: string; description?: string; at?: string; size?: string; instructions?: string } & ContextFlags) => withFleet(connect, async (c, state) => {
      const current = state.islands[islandId(state, id)];
      const island = await c.call('island.update', {
        id: current.id, name: o.name, description: o.description, context: editContext(current.context, o), instructions: o.instructions,
        position: point(o.at, '--at'), size: size(o.size, '--size'),
      });
      printResult(island, json(), () => `${island.id} ${island.name}`);
    }));

  cmd.command('arrange').description('resize every island to its crew and pack the fleet together')
    .option('--aspect <n>', 'width over height of the window to fill')
    .action(async (o: { aspect?: string }) => {
      const aspect = o.aspect ? num(o.aspect, '--aspect') : undefined;
      const islands = await withClient(connect, async (c) => {
        await c.call('island.arrange', { aspect });
        return (await c.call('state.get', {})).islands;
      });
      printResult(islands, json(), () => 'arranged');
    });

  cmd.command('show <id>').description('print the brief the agent gets').action((id: string) => withFleet(connect, async (c, state) => {
    const r = await c.call('island.show', { id: islandId(state, id) });
    printResult(r, json(), () => r.text);
  }));

  cmd.command('delete <id>').description('delete an empty island and its docs').action((id: string) => withFleet(connect, async (c, state) => {
    await c.call('island.delete', { id: islandId(state, id) });
    printResult({}, json(), () => 'deleted');
  }));

  return cmd;
}
