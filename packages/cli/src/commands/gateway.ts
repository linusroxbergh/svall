import { Command } from 'commander';
import type { OwnerRecord } from '@svall/protocol';
import { AuthorityFailure, isOwnerOp } from '@svall/svalld/gateway/authority';
import { main } from '@svall/svalld/gateway/bin';
import type { OwnerAnswer } from '@svall/svalld/gateway/client';
import { localOwner } from '../controller/authority.js';

/** What one operation answered: the same frame the authority put on its socket, minus the request id. */
type OwnerFrame =
  | { result: { record: OwnerRecord } }
  | { error: { code: string; message: string; data?: Record<string, unknown> } };

const write = (frame: OwnerFrame): void => { process.stdout.write(`${JSON.stringify(frame)}\n`); };

function refuse(code: string, message: string, data?: Record<string, unknown>): void {
  write({ error: data ? { code, message, data } : { code, message } });
  process.exitCode = 1;
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
  let answer: OwnerAnswer;
  try {
    if (!isOwnerOp(`owner.${op}`)) throw new AuthorityFailure('invalid_request', `unknown operation ${op}`);
    answer = await localOwner(op, o.fleet, rest(o.params));
  } catch (err) {
    const failure = err instanceof AuthorityFailure ? err : new AuthorityFailure('internal', String(err));
    answer = { error: { code: failure.code, message: failure.message, ...(failure.data && { data: failure.data }) } };
  }
  if ('record' in answer) write({ result: { record: answer.record } });
  else refuse(answer.error.code, answer.error.message, answer.error.data);
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
