import type { FleetState, Robot } from '@svall/protocol';
import { repoRootOf } from '../docs.js';
import { relocate } from './relocate.js';

/** The clone a robot works in, as this machine names it: a placed robot's path is taken from its machine's user folder into `homedir`. */
export function homeRootOf(c: Robot, machines: FleetState['machines'], homedir: string | undefined): string | undefined {
  const root = repoRootOf(c);
  const from = c.machine && machines?.[c.machine]?.home;
  return root && from && homedir ? relocate(root, { from, to: homedir }) : root;
}
