import fs from 'node:fs';
import { Command } from 'commander';
import { resolvePaths } from '@svall/svalld/paths';
import type { Client } from '../client.js';
import { printResult, table } from '../format.js';
import { contextOf, stateOf } from '../render.js';

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function statusCommand(connect: () => Promise<Client>, json: () => boolean, home: () => string): Command {
  return new Command('status').description('show every island and character').action(async () => {
    const paths = resolvePaths(home());
    const c = await connect();
    const state = await c.call('state.get', {});
    const chars = Object.values(state.characters);
    const islands = Object.values(state.islands);
    printResult(state, json(), () => [
      `svalld running on port ${Number(fs.readFileSync(paths.port, 'utf8'))} (home ${home()})`,
      `${islands.length} island(s), ${chars.length} character(s)`,
      '',
      table(islands.map((i) => ({
        island: i.id, name: i.name, kind: i.kind ?? '', characters: String(chars.filter((ch) => ch.islandId === i.id).length),
      }))),
      '',
      table(chars.map((ch) => ({
        character: ch.id, name: ch.name, island: state.islands[ch.islandId]?.name ?? ch.islandId, state: stateOf(ch),
        ctx: contextOf(ch), cwd: ch.cwd, note: clip(ch.note, 40),
      }))),
    ].join('\n'));
    c.close();
  });
}
