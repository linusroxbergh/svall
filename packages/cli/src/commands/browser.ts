import type { FleetState } from '@svall/protocol';
import { Command } from 'commander';
import type { Client } from '../client.js';
import { printResult, table } from '../format.js';
import { withFleet } from './fleet.js';
import { charId } from './resolve.js';

// --char names the character; inside a character's own terminal SVALL_CHAR_ID already does
function target(state: FleetState, ref: string | undefined): string {
  const given = ref ?? process.env.SVALL_CHAR_ID;
  if (!given) throw new Error('name a character with --char, or run this inside one');
  return charId(state, given);
}

export function browserCommands(connect: () => Promise<Client>, json: () => boolean): Command {
  const cmd = new Command('browser').description("a character's browser tabs");

  cmd.command('open').description('open a url in a new tab').argument('<url>').option('--char <id>').action((url: string, o: { char?: string }) => withFleet(connect, async (c, state) => {
    const tab = await c.call('browser.open', { id: target(state, o.char), url });
    printResult(tab, json(), () => tab.id);
  }));

  cmd.command('list').description('list the tabs, the active one starred').option('--char <id>').action((o: { char?: string }) => withFleet(connect, async (_c, state) => {
    const b = state.characters[target(state, o.char)].browser;
    const tabs = b?.tabs ?? [];
    printResult(tabs, json(), () => table(tabs.map((t) => ({ id: t.id, active: t.id === b?.active ? '*' : '', title: t.title, url: t.url }))));
  }));

  cmd.command('close').description('close a tab').argument('<tab>').option('--char <id>').action((tab: string, o: { char?: string }) => withFleet(connect, async (c, state) => {
    await c.call('browser.close', { id: target(state, o.char), tab });
    printResult({}, json(), () => 'closed');
  }));

  return cmd;
}
