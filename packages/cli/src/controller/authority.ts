import { OwnerRecord } from '@archipelago/protocol';
import { classifyExit, shellQuote, SshError, type SshMaster } from './ssh.js';

const OWNER_TIMEOUT = 30_000;

/** What the gateway answered about a fleet: the record it holds, or why it would not act. */
export type OwnerAnswer = { record: OwnerRecord } | { error: { code: string; message: string; data?: Record<string, unknown> } };

export type OwnerRequest = {
  master: Pick<SshMaster, 'run'>;
  /** the `archi` on the machine that serves the socket */
  exe: string;
  op: string;
  fleetId: string;
  params?: Record<string, unknown>;
};

/**
 * One `archi gateway owner` on the machine the gateway runs on. The wrapper prints its frame on
 * stdout whether it succeeded or not, so the exit code is not what is read here.
 */
export async function remoteOwner(o: OwnerRequest): Promise<OwnerAnswer> {
  const argv = [shellQuote(o.exe), 'gateway', 'owner', shellQuote(o.op), '--fleet', shellQuote(o.fleetId)];
  if (o.params) argv.push('--params', shellQuote(JSON.stringify(o.params)));
  const r = await o.master.run(argv, { timeoutMs: OWNER_TIMEOUT });
  const line = r.stdout.trim().split('\n').at(-1) ?? '';
  const answer = parseAnswer(line);
  if (!answer) {
    const said = (r.stderr.trim() || line).slice(0, 200) || 'no output';
    throw new SshError(classifyExit(r, 'other'), `archi gateway owner ${o.op} exited ${r.code} without an ownership frame: ${said}`);
  }
  return answer;
}

function parseAnswer(line: string): OwnerAnswer | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const frame = raw as { result?: { record?: unknown }; error?: { code?: unknown; message?: unknown; data?: unknown } };
  if (frame.error && typeof frame.error.code === 'string' && typeof frame.error.message === 'string') {
    const { data } = frame.error;
    const structured = data && typeof data === 'object' && !Array.isArray(data) ? { data: data as Record<string, unknown> } : {};
    return { error: { code: frame.error.code, message: frame.error.message, ...structured } };
  }
  const record = OwnerRecord.safeParse(frame.result?.record);
  return record.success ? { record: record.data } : undefined;
}
