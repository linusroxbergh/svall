import type { FleetState } from '@svall/protocol';
import type { Client } from '../client.js';

export async function withClient<T>(connect: () => Promise<Client>, f: (c: Client) => Promise<T>): Promise<T> {
  const c = await connect();
  try { return await f(c); } finally { c.close(); }
}

export const withFleet = <T>(connect: () => Promise<Client>, f: (c: Client, state: FleetState) => Promise<T>): Promise<T> =>
  withClient(connect, async (c) => f(c, await c.call('state.get', {})));
