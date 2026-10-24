import fs from 'node:fs';
import { Command } from 'commander';
import { ellipsis } from '@svall/protocol';
import { resolvePaths } from '@svall/svalld/paths';
import type { Client } from '../client.js';
import { printResult, table } from '../format.js';
import { contextOf, resumeFailures, stateOf } from '../render.js';
import { withFleet } from './fleet.js';

export function statusCommand(connect: () => Promise<Client>, json: () => boolean, home: () => string): Command {
  return new Command('status').description('show every island and robot').action(() => withFleet(connect, async (c, state) => {
    const paths = resolvePaths(home());
    const robots = Object.values(state.robots);
    const islands = Object.values(state.islands);
    printResult(state, json(), () => [
      c.via ? `svalld on ${c.via}, which runs this fleet (home ${home()} here)` : `svalld running on port ${Number(fs.readFileSync(paths.port, 'utf8'))} (home ${home()})`,
      `${islands.length} island(s), ${robots.length} robot(s)`,
      '',
      table(islands.map((i) => ({
        island: i.id, name: i.name, kind: i.kind ?? '', robots: String(robots.filter((ch) => ch.islandId === i.id).length),
      }))),
      '',
      table(robots.map((ch) => ({
        robot: ch.id, name: ch.name, island: state.islands[ch.islandId]?.name ?? ch.islandId, state: stateOf(ch),
        ctx: contextOf(ch), cwd: ch.cwd, note: ellipsis(ch.note, 40),
      }))),
      ...robots.flatMap(resumeFailures),
    ].join('\n'));
  }));
}
