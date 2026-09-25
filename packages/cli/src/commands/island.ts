import { Command } from 'commander';
import type { Client } from '../client.js';
import { contextOptions, editContext, type ContextFlags } from '../context.js';
import { printResult, table } from '../format.js';
import { int, parsePair } from './parse.js';
import { islandId } from './resolve.js';

export function islandCommands(connect: () => Promise<Client>, json: () => boolean): Command {
  const cmd = new Command('island').description('manage islands');

  cmd.command('list').description('list every island').action(async () => {
    const c = await connect();
    const state = await c.call('state.get', {});
    const islands = Object.values(state.islands);
    const count = (id: string) => Object.values(state.characters).filter((ch) => ch.islandId === id).length;
    printResult(islands, json(), () => table(islands.map((i) => ({
      id: i.id, name: i.name, kind: i.kind ?? '', characters: String(count(i.id)), size: `${i.size.w}x${i.size.h}`, at: `${i.position.x},${i.position.y}`,
    }))));
    c.close();
  });

  contextOptions(cmd.command('create <name>').description('make an island')
    .option('--at <x,y>').option('--size <w,h>').option('--description <d>'))
    .action(async (name: string, o: { at?: string; size?: string; description?: string; instructions?: string } & ContextFlags) => {
      const c = await connect();
      const state = await c.call('state.get', {});
      // the daemon would give a colliding name a number rather than refuse it, and the fleet would carry a twin
      const taken = Object.values(state.islands).find((i) => i.name.toLowerCase() === name.toLowerCase());
      if (taken) { c.close(); throw new Error(`island "${taken.name}" already exists (${taken.id}); move characters onto it or pick another name`); }
      const [x, y] = o.at ? parsePair(o.at, '--at') : [undefined, undefined];
      const [w, h] = o.size ? parsePair(o.size, '--size') : [undefined, undefined];
      const island = await c.call('island.create', {
        name, description: o.description, context: editContext([], o), instructions: o.instructions,
        position: x !== undefined ? { x, y: y! } : undefined, size: w !== undefined ? { w, h: h! } : undefined,
      });
      printResult(island, json(), () => island.id);
      c.close();
    });

  cmd.command('rename <id> <name>').description('rename an island').action(async (id: string, name: string) => {
    const c = await connect();
    const state = await c.call('state.get', {});
    const island = await c.call('island.update', { id: islandId(state, id), name });
    printResult(island, json(), () => `${island.id} ${island.name}`);
    c.close();
  });

  contextOptions(cmd.command('update <id>').description("change an island's name, description, place, size, context or instructions")
    .option('--name <n>').option('--description <d>').option('--at <x,y>').option('--size <w,h>'))
    .action(async (id: string, o: { name?: string; description?: string; at?: string; size?: string; instructions?: string } & { context: string[]; pin: string[]; unpin: string[]; drop: string[] }) => {
      const c = await connect();
      const state = await c.call('state.get', {});
      const current = state.islands[islandId(state, id)];
      const [x, y] = o.at ? parsePair(o.at, '--at') : [undefined, undefined];
      const [w, h] = o.size ? parsePair(o.size, '--size') : [undefined, undefined];
      const island = await c.call('island.update', {
        id: current.id, name: o.name, description: o.description, context: editContext(current.context, o), instructions: o.instructions,
        position: x !== undefined ? { x, y: y! } : undefined, size: w !== undefined ? { w, h: h! } : undefined,
      });
      printResult(island, json(), () => `${island.id} ${island.name}`);
      c.close();
    });

  cmd.command('arrange').description('resize every island to its crew and pack the fleet together')
    .option('--aspect <n>', 'width over height of the window to fill')
    .action(async (o: { aspect?: string }) => {
      const c = await connect();
      await c.call('island.arrange', { aspect: o.aspect ? int(o.aspect, '--aspect') : undefined });
      const state = await c.call('state.get', {});
      printResult(state.islands, json(), () => 'arranged');
      c.close();
    });

  cmd.command('show <id>').description('print the brief the agent gets').action(async (id: string) => {
    const c = await connect();
    const state = await c.call('state.get', {});
    const r = await c.call('island.show', { id: islandId(state, id) });
    printResult(r, json(), () => r.text);
    c.close();
  });

  cmd.command('delete <id>').description('delete an empty island and its docs').action(async (id: string) => {
    const c = await connect();
    const state = await c.call('state.get', {});
    await c.call('island.delete', { id: islandId(state, id) });
    printResult({}, json(), () => 'deleted');
    c.close();
  });

  return cmd;
}
