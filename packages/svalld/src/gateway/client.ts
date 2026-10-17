import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import { MachineRecord, OwnerRecord, type FleetId, type MachineId } from '@svall/protocol';
import { configDir } from '../machine.js';
import { svallExe } from '../release.js';
import { shq } from '../text.js';
import { AuthorityFailure, gatewayPaths, type OwnerOp, type OwnerParamsOf } from './authority.js';
import { gatewayPrefix } from './bin.js';
import { MAX_LINE } from './server.js';

export type AuthorityClientOptions = { timeoutMs?: number };

// what the authority and its `svall gateway owner` wrapper answer: a record, or why it will not act
const Frame = z.union([
  z.object({ result: z.object({ record: OwnerRecord }) }),
  z.object({ error: z.object({ code: z.string(), message: z.string(), data: z.record(z.string(), z.unknown()).optional() }) }),
]);

/** What the gateway answered about a fleet: the record it holds, or why it would not act. */
export type OwnerAnswer = { record: OwnerRecord } | { error: { code: string; message: string; data?: Record<string, unknown> } };

function lastLine(stdout: string): unknown {
  try {
    return JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
  } catch {
    return undefined;
  }
}

/** The frame `svall gateway owner` prints as the last line of `stdout`; undefined when that line is no frame of the authority's. */
export function ownerAnswer(stdout: string): OwnerAnswer | undefined {
  const frame = Frame.safeParse(lastLine(stdout));
  if (!frame.success) return undefined;
  return 'result' in frame.data ? { record: frame.data.result.record } : { error: frame.data.error };
}

/** The machine id `svall version --json` names in `stdout`, past whatever a login shell printed around it; undefined when it names none. */
export function versionMachineId(stdout: string): string | undefined {
  return /^\s*"machineId":\s*"([^"]+)"/m.exec(stdout)?.[1];
}

type Pending = { resolve(record: OwnerRecord): void; reject(err: Error): void; timer: NodeJS.Timeout };

/** The authority as its callers see it: one socket, one answer per call, and a bound on the wait. */
export class AuthorityClient {
  private pending = new Map<number, Pending>();
  private buffer = '';
  private next = 1;

  private constructor(private socket: net.Socket, private timeoutMs: number) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('close', () => this.abandon('the gateway authority closed the connection'));
    socket.on('error', (err) => this.abandon(String(err)));
  }

  static connect(prefix: string, { timeoutMs = 10_000 }: AuthorityClientOptions = {}): Promise<AuthorityClient> {
    const socketPath = gatewayPaths(prefix).socket;
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        resolve(new AuthorityClient(socket, timeoutMs));
      });
    });
  }

  get(params: OwnerParamsOf<'owner.get'>): Promise<OwnerRecord> { return this.call('owner.get', params); }
  create(params: OwnerParamsOf<'owner.create'>): Promise<OwnerRecord> { return this.call('owner.create', params); }
  begin(params: OwnerParamsOf<'owner.begin'>): Promise<OwnerRecord> { return this.call('owner.begin', params); }
  ready(params: OwnerParamsOf<'owner.ready'>): Promise<OwnerRecord> { return this.call('owner.ready', params); }
  commit(params: OwnerParamsOf<'owner.commit'>): Promise<OwnerRecord> { return this.call('owner.commit', params); }
  abort(params: OwnerParamsOf<'owner.abort'>): Promise<OwnerRecord> { return this.call('owner.abort', params); }
  complete(params: OwnerParamsOf<'owner.complete'>): Promise<OwnerRecord> { return this.call('owner.complete', params); }
  force(params: OwnerParamsOf<'owner.force'>): Promise<OwnerRecord> { return this.call('owner.force', params); }

  close(): void {
    this.socket.destroy();
    this.abandon('the client closed the connection');
  }

  call(op: OwnerOp, params: unknown): Promise<OwnerRecord> {
    const id = this.next++;
    return new Promise<OwnerRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AuthorityFailure('timeout', `the gateway authority did not answer ${op} within ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ id, op, params })}\n`);
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (let nl = this.buffer.indexOf('\n'); nl >= 0; nl = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.settle(line);
    }
    if (this.buffer.length > MAX_LINE) {
      this.socket.destroy();
      this.abandon(`the gateway authority sent more than ${MAX_LINE} bytes without a newline`);
    }
  }

  private settle(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const id = (raw as { id?: unknown } | null)?.id;
    const waiting = typeof id === 'number' ? this.pending.get(id) : undefined;
    if (!waiting) return;
    this.pending.delete(id as number);
    clearTimeout(waiting.timer);
    const frame = Frame.safeParse(raw);
    if (!frame.success) waiting.reject(new AuthorityFailure('invalid_request', 'the gateway authority answered with what is no frame of its own'));
    else if ('error' in frame.data) waiting.reject(new AuthorityFailure(frame.data.error.code, frame.data.error.message, frame.data.error.data));
    else waiting.resolve(frame.data.result.record);
  }

  private abandon(why: string): void {
    for (const [id, waiting] of this.pending) {
      this.pending.delete(id);
      clearTimeout(waiting.timer);
      waiting.reject(new AuthorityFailure('disconnected', why));
    }
  }
}

/** Runs ssh with these arguments to its exit; rejects only when ssh cannot start. */
export type SshRun = (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const SSH_TIMEOUT_MS = 30_000;

const realSsh: SshRun = (argv) => new Promise((resolve, reject) => {
  execFile('ssh', argv, { timeout: SSH_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string') reject(err);
    else resolve({ code: err ? (typeof code === 'number' ? code : -1) : 0, stdout: String(stdout), stderr: String(stderr) });
  });
});

const Registry = z.object({ machines: z.record(z.string(), MachineRecord) });

// the far svall names its machine before the authority answers, so a route that now leads elsewhere is refused
const OWNER_GET = '"$1" version --json; exec "$1" gateway owner get --fleet "$2"';

export type FleetAuthorityOptions = {
  gatewayMachineId: MachineId;
  machineId: MachineId;
  /** where the authority keeps its socket, on the machine that is the gateway */
  prefix?: string;
  /** the controller's registry, which names the gateway's ssh route */
  registry?: string;
  ssh?: SshRun;
};

/**
 * How a daemon asks its fleet's gateway who owns the fleet: on the gateway, over the authority's own socket;
 * anywhere else, by running `svall gateway owner get` there over ssh, as the controller does.
 */
export function fleetAuthority(o: FleetAuthorityOptions): { get(fleetId: FleetId): Promise<OwnerRecord> } {
  if (o.gatewayMachineId === o.machineId) {
    const prefix = o.prefix ?? gatewayPrefix();
    return {
      get: async (fleetId) => {
        const client = await AuthorityClient.connect(prefix);
        try { return await client.get({ fleetId }); } finally { client.close(); }
      },
    };
  }
  const registry = o.registry ?? path.join(configDir(), 'machines.json');
  const ssh = o.ssh ?? realSsh;
  return {
    get: async (fleetId) => {
      let machines: Record<string, MachineRecord>;
      try { machines = Registry.parse(JSON.parse(fs.readFileSync(registry, 'utf8'))).machines; } catch {
        throw new AuthorityFailure('disconnected', `${registry} cannot be read, so there is no ssh route to the gateway ${o.gatewayMachineId}`);
      }
      // a registry that knows no way to the gateway asked for is a wrong question, not a gateway that is away
      const gateway = machines[o.gatewayMachineId];
      if (!gateway?.ssh) throw new AuthorityFailure('invalid_request', `${registry} names no ssh route to the gateway ${o.gatewayMachineId}`);
      const r = await ssh(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', gateway.ssh, ['sh', '-c', OWNER_GET, 'svall-owner', svallExe(gateway.svallBase), fleetId].map(shq).join(' ')]);
      const answeredAs = versionMachineId(r.stdout);
      const line = lastLine(r.stdout);
      const silent = (): AuthorityFailure =>
        new AuthorityFailure('disconnected', `ssh ${gateway.ssh} exited ${r.code} without an answer: ${(r.stderr.trim() || r.stdout.trim()).slice(0, 200)}`);
      // an ssh that answered nothing never reached a machine to tell apart
      if (answeredAs === undefined && line === undefined) throw silent();
      if (answeredAs !== o.gatewayMachineId) {
        throw new AuthorityFailure('identity_mismatch', answeredAs === undefined
          ? `ssh ${gateway.ssh} answered without naming its machine, so it cannot be told from another than the gateway ${o.gatewayMachineId}`
          : `ssh ${gateway.ssh} reaches machine ${answeredAs}, not the gateway ${o.gatewayMachineId}`);
      }
      // the wrapper prints its frame whether the authority answered or refused, so the exit code says nothing more
      const answer = ownerAnswer(r.stdout);
      if (line === undefined) throw silent();
      if (!answer) throw new AuthorityFailure('invalid_request', `ssh ${gateway.ssh} answered with what is no authority's frame: ${JSON.stringify(line).slice(0, 200)}`);
      if ('record' in answer) return answer.record;
      throw new AuthorityFailure(answer.error.code, answer.error.message, answer.error.data);
    },
  };
}
