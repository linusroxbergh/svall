import { AuthorityFailure, gatewayPaths, type OwnerOp } from '@svall/svalld/gateway/authority';
import { gatewayPrefix } from '@svall/svalld/gateway/bin';
import { AuthorityClient, ownerAnswer, type OwnerAnswer } from '@svall/svalld/gateway/client';
import { shq } from '@svall/svalld/text';
import { classifyExit, SshError, type SshMaster } from './ssh.js';

const OWNER_TIMEOUT = 30_000;

export type OwnerRequest = {
  master: Pick<SshMaster, 'run'>;
  /** the `svall` on the machine that serves the socket */
  exe: string;
  op: string;
  fleetId: string;
  params?: Record<string, unknown>;
};

/**
 * One `svall gateway owner` on the machine the gateway runs on. The wrapper prints its frame on
 * stdout whether it succeeded or not, so the exit code is not what is read here.
 */
export async function remoteOwner(o: OwnerRequest): Promise<OwnerAnswer> {
  const argv = [shq(o.exe), 'gateway', 'owner', shq(o.op), '--fleet', shq(o.fleetId)];
  if (o.params) argv.push('--params', shq(JSON.stringify(o.params)));
  const r = await o.master.run(argv, { timeoutMs: OWNER_TIMEOUT });
  const answer = ownerAnswer(r.stdout);
  if (!answer) {
    const said = (r.stderr.trim() || r.stdout.trim().split('\n').at(-1) || '').slice(0, 200) || 'no output';
    throw new SshError(classifyExit(r, 'other'), `svall gateway owner ${o.op} exited ${r.code} without an ownership frame: ${said}`);
  }
  return answer;
}

/** One operation on the authority this machine serves, over its own socket; a socket that does not answer is `disconnected`. */
export async function localOwner(op: string, fleetId: string, params?: Record<string, unknown>, prefix = gatewayPrefix()): Promise<OwnerAnswer> {
  let client: AuthorityClient;
  try { client = await AuthorityClient.connect(prefix); } catch (e) {
    return { error: { code: 'disconnected', message: `the gateway authority did not answer on ${gatewayPaths(prefix).socket}: ${String(e)}` } };
  }
  try {
    return { record: await client.call(`owner.${op}` as OwnerOp, { ...params, fleetId }) };
  } catch (e) {
    if (e instanceof AuthorityFailure) return { error: { code: e.code, message: e.message, ...(e.data && { data: e.data }) } };
    throw e;
  } finally {
    client.close();
  }
}
