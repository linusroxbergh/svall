import type { FleetState } from '@svall/protocol';
import type { Client } from '../client.js';

/** Runs `f` on a connection to the fleet, closed however `f` ends. */
export async function withClient<T>(connect: () => Promise<Client>, f: (c: Client) => Promise<T>): Promise<T> {
  const c = await connect();
  try { return await f(c); } finally { c.close(); }
}

/** Runs `f` on a connection to the fleet and the fleet's state, read first. */
export const withFleet = <T>(connect: () => Promise<Client>, f: (c: Client, state: FleetState) => Promise<T>): Promise<T> =>
  withClient(connect, async (c) => f(c, await c.call('state.get', {})));
