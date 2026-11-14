import type { Client } from '../client.js';
import { printResult } from '../format.js';
import { withClient } from '../client.js';

export function scribeActions(connect: () => Promise<Client>, json: () => boolean) {
  return {
    sweep: async (o: { names?: boolean; islands?: boolean }) => {
      if (o.names && o.islands) throw new Error('use --names or --islands, not both');
      const r = await withClient(connect, (c) => c.call('scribe.sweep', { names: o.names, islands: o.islands }));
      printResult(r, json(), () => r.lines.join('\n') || 'nothing changed');
    },
  };
}
