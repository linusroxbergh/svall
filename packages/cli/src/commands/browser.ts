import type { FleetState } from '@svall/protocol';
import { Command } from 'commander';
import type { Client } from '../client.js';
import { printResult, table } from '../format.js';
import { withFleet } from './fleet.js';
import { robotId } from './resolve.js';

// --robot names the robot; inside a robot's own terminal SVALL_ROBOT_ID already does
function target(state: FleetState, ref: string | undefined): string {
  // a session an older svalld started carries SVALL_CHAR_ID
  const given = ref ?? process.env.SVALL_ROBOT_ID ?? process.env.SVALL_CHAR_ID;
  if (!given) throw new Error('name a robot with --robot, or run this inside one');
  return robotId(state, given);
}

export function browserCommands(connect: () => Promise<Client>, json: () => boolean): Command {
  const cmd = new Command('browser').description("a robot's browser tabs");

  cmd.command('open').description('open a url in a new tab').argument('<url>').option('--robot <id>').action((url: string, o: { robot?: string }) => withFleet(connect, async (c, state) => {
    const tab = await c.call('browser.open', { id: target(state, o.robot), url });
    printResult(tab, json(), () => tab.id);
  }));

  cmd.command('list').description('list the tabs, the active one starred').option('--robot <id>').action((o: { robot?: string }) => withFleet(connect, async (_c, state) => {
    const b = state.robots[target(state, o.robot)].browser;
    const tabs = b?.tabs ?? [];
    printResult(tabs, json(), () => table(tabs.map((t) => ({ id: t.id, active: t.id === b?.active ? '*' : '', title: t.title, url: t.url }))));
  }));

  cmd.command('close').description('close a tab').argument('<tab>').option('--robot <id>').action((tab: string, o: { robot?: string }) => withFleet(connect, async (c, state) => {
    await c.call('browser.close', { id: target(state, o.robot), tab });
    printResult({}, json(), () => 'closed');
  }));

  return cmd;
}
