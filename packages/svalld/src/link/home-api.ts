import WebSocket from 'ws';
import { HelloReply, PROTOCOL_VERSION, type Result, type WorkerFile } from '@svall/protocol';
import { fleetHomeOfSocket } from '../paths.js';
import { releaseVersion } from '../release.js';
import { FleetMismatch, MachineMismatch, remoteConnectionInfo } from './connection-info.js';
import { SshError, type SshMaster } from './ssh.js';

type Answer = Result<'home.connection'>;
type Dial = { master(): SshMaster | undefined; failure(): SshError | undefined; restore(): void };
type Forward = { master: SshMaster; remote: number; local: number; cancel: () => Promise<void> };
// held until a person asks again: the far side will not change by itself
type Settled = Pick<Answer, 'state' | 'release' | 'detail' | 'newer'>;

const GREET_MS = 10_000;

/** Whether the API greets at `port`, token and all: ssh takes a forward's connection before it knows the far port answers. */
export function greets(port: number, token: string, ms = GREET_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const done = (answered: boolean) => { clearTimeout(late); ws.terminate(); resolve(answered); };
    const late = setTimeout(() => done(false), ms);
    ws.on('open', () => ws.send(JSON.stringify({ token })));
    ws.on('message', (raw) => {
      try { done(HelloReply.safeParse(JSON.parse(String(raw))).success); } catch { done(false); }
    });
    ws.on('close', () => done(false));
    ws.on('error', () => done(false));
  });
}

/**
 * How a window reaches a far home's API: the home's port forwarded over the daemon's own master, the port read anew at
 * each ask, as a far daemon that restarted may hold another, and the home's token held in memory alone.
 */
export class HomeApi {
  private forward?: Forward;
  private settled?: Settled;
  private asking?: Promise<Answer>;

  constructor(private o: { worker: () => WorkerFile; dial?: Dial; linked: () => boolean; greets?: typeof greets }) {}

  /** One attempt at a time; asks made meanwhile take its answer. */
  answer(retry = false): Promise<Answer> {
    if (retry) {
      this.settled = undefined;
      if (this.o.dial?.failure()) this.o.dial.restore();
    }
    return this.asking ??= this.ask().finally(() => { this.asking = undefined; });
  }

  async stop(): Promise<void> {
    await this.drop();
  }

  private async ask(): Promise<Answer> {
    const worker = this.o.worker();
    const base = { machine: worker.homeMachineId, name: worker.homeName };
    const { dial } = this.o;
    if (!dial) return { ...base, state: this.o.linked() ? 'connected' : 'unreachable' };
    if (this.settled) return { ...base, ...this.settled };
    const failure = dial.failure();
    if (failure) {
      await this.drop();
      return { ...base, state: failure.kind === 'auth' || failure.kind === 'host_key' ? 'auth' : 'unreachable', detail: failure.message.trim().split('\n').at(-1) };
    }
    const master = dial.master();
    if (!master) {
      await this.drop();
      return { ...base, state: 'connecting' };
    }
    if (!worker.homeSvallBase || !worker.homeSocket) return this.settle(base, { state: 'version', detail: `this Mac does not know where svall is on ${worker.homeName}; enrol it again with svall fleet enroll-worker there` });
    try {
      const info = await remoteConnectionInfo(master, { id: worker.homeMachineId, record: { name: worker.homeName, svallBase: worker.homeSvallBase } }, {
        fleetId: worker.fleetId, anyProtocol: true, fleetHome: fleetHomeOfSocket(worker.homeSocket),
      });
      if (info.protocol !== PROTOCOL_VERSION) return await this.settle(base, { state: 'version', release: info.release, detail: `${worker.homeName} runs ${info.release}, this Mac ${releaseVersion()}`, ...(info.protocol > PROTOCOL_VERSION && { newer: true as const }) });
      const { local } = await this.forwardTo(master, info.port);
      if (!await (this.o.greets ?? greets)(local, info.token)) {
        await this.drop();
        return { ...base, state: 'unreachable', detail: `the API on ${worker.homeName} does not answer` };
      }
      return { ...base, state: 'connected', ssh: master.destination, controlSocket: master.socket, port: local, token: info.token, release: info.release };
    } catch (e) {
      const message = (e as Error).message;
      // none of these holds a token: the description is never quoted, and a forward's failure names only ports
      if (e instanceof FleetMismatch) return await this.settle(base, { state: 'unreachable', detail: `${worker.homeName} runs another fleet, ${e.found}, not this one, ${worker.fleetId}` });
      if (e instanceof MachineMismatch) return await this.settle(base, { state: 'unreachable', detail: message });
      if (e instanceof SshError && e.kind === 'version') return await this.settle(base, { state: 'version', detail: message });
      await this.drop();
      return { ...base, state: 'unreachable', detail: message };
    }
  }

  private async settle(base: Pick<Answer, 'machine' | 'name'>, s: Settled): Promise<Answer> {
    this.settled = s;
    await this.drop();
    return { ...base, ...s };
  }

  private async forwardTo(master: SshMaster, remote: number): Promise<Forward> {
    if (this.forward?.master === master && this.forward.remote === remote) return this.forward;
    await this.drop();
    const { localPort, cancel } = await master.forward(remote);
    this.forward = { master, remote, local: localPort, cancel };
    return this.forward;
  }

  // a master that went away took its forward with it
  private async drop(): Promise<void> {
    const held = this.forward;
    this.forward = undefined;
    await held?.cancel().catch(() => undefined);
  }
}
