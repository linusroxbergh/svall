import { Command } from 'commander';
import type { OwnerRecord } from '@archipelago/protocol';
import { AuthorityFailure, gatewayPaths, isOwnerOp, type OwnerOp, type OwnerParams, type OwnerParamsOf } from '@archipelago/archid/gateway/authority';
import { gatewayPrefix, main } from '@archipelago/archid/gateway/bin';
import { AuthorityClient } from '@archipelago/archid/gateway/client';

/** What one operation answered: the same frame the authority put on its socket, minus the request id. */
type OwnerFrame =
  | { result: { record: OwnerRecord } }
  | { error: { code: string; message: string; data?: Record<string, unknown> } };

const write = (frame: OwnerFrame): void => { process.stdout.write(`${JSON.stringify(frame)}\n`); };

function refuse(code: string, message: string, data?: Record<string, unknown>): void {
  write({ error: data ? { code, message, data } : { code, message } });
  process.exitCode = 1;
}

// the client's methods are typed one per operation; the authority is the one that validates params
function send(client: AuthorityClient, op: OwnerOp, params: OwnerParams): Promise<OwnerRecord> {
  switch (op) {
    case 'owner.get': return client.get(params as OwnerParamsOf<'owner.get'>);
    case 'owner.create': return client.create(params as OwnerParamsOf<'owner.create'>);
    case 'owner.begin': return client.begin(params as OwnerParamsOf<'owner.begin'>);
    case 'owner.ready': return client.ready(params as OwnerParamsOf<'owner.ready'>);
    case 'owner.commit': return client.commit(params as OwnerParamsOf<'owner.commit'>);
    case 'owner.abort': return client.abort(params as OwnerParamsOf<'owner.abort'>);
    case 'owner.complete': return client.complete(params as OwnerParamsOf<'owner.complete'>);
    case 'owner.force': return client.force(params as OwnerParamsOf<'owner.force'>);
  }
}

function rest(params: string | undefined): Record<string, unknown> {
  if (params === undefined) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(params);
  } catch (err) {
    throw new AuthorityFailure('invalid_request', `--params is not JSON: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AuthorityFailure('invalid_request', '--params is not a JSON object');
  return raw as Record<string, unknown>;
}

/** One operation on the authority of the machine this runs on, over its socket and nothing else. */
async function owner(op: string, o: { fleet: string; params?: string }): Promise<void> {
  const prefix = gatewayPrefix();
  let client: AuthorityClient | undefined;
  try {
    const name = `owner.${op}`;
    if (!isOwnerOp(name)) throw new AuthorityFailure('invalid_request', `unknown operation ${op}`);
    const params = { ...rest(o.params), fleetId: o.fleet } as OwnerParams;
    client = await AuthorityClient.connect(prefix).catch((err: unknown) => {
      throw new AuthorityFailure('disconnected', `the gateway authority did not answer on ${gatewayPaths(prefix).socket}: ${String(err)}`);
    });
    write({ result: { record: await send(client, name, params) } });
  } catch (err) {
    const failure = err instanceof AuthorityFailure ? err : new AuthorityFailure('internal', String(err));
    refuse(failure.code, failure.message, failure.data);
  } finally {
    client?.close();
  }
}

export function gatewayCommands(): Command {
  const gateway = new Command('gateway').description('the ownership authority this machine serves for the fleets it is the gateway for');

  gateway.command('serve')
    .description('serve the ownership authority on this machine\'s local socket')
    .action(async () => { await main(); });

  gateway.command('owner')
    .description('one ownership operation on this machine\'s authority, answered as one JSON line')
    .argument('<op>', 'get, create, begin, ready, commit, abort, complete or force')
    .requiredOption('--fleet <id>', 'the fleet the operation is about')
    .option('--params <json>', 'the rest of the operation\'s parameters, as one JSON object')
    .action((op: string, o: { fleet: string; params?: string }) => owner(op, o));

  return gateway;
}
