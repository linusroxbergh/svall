import { PROTOCOL_VERSION, serverWait, type Event, type MethodName, type Params, type Response, type Result } from '@svall/protocol';

// where svalld answers, and the token to say on arrival; a socket the proxy has already vouched for has none
export type Endpoint = { url: string; token?: string };

export type Status = 'connecting' | 'online' | 'offline' | 'outdated';
export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type Opts = { WS?: typeof WebSocket; minDelay?: number; maxDelay?: number; callTimeout?: number };

export class Api {
  onStatus: (s: Status) => void = () => {};
  onEvent: (e: Event) => void = () => {};
  onOpen: () => void = () => {};

  private WS: typeof WebSocket;
  private minDelay: number;
  private maxDelay: number;
  private callTimeout: number;
  private ws?: WebSocket;
  private online = false;
  // a daemon on another protocol stays reported as such across retries, until one answers in ours or none answers
  private outdated = false;
  private next = 1;
  private pending = new Map<number, Pending>();
  private delay: number;
  private stopped = true;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private endpoint: Endpoint, opts: Opts = {}) {
    this.WS = opts.WS ?? WebSocket;
    this.minDelay = opts.minDelay ?? 500;
    this.maxDelay = opts.maxDelay ?? 5000;
    this.callTimeout = opts.callTimeout ?? 30_000;
    this.delay = this.minDelay;
  }

  start(): void { this.stopped = false; this.open(); }

  /** A daemon that restarted on a free port comes back on a different one; the next attempt uses this. */
  setEndpoint(endpoint: Endpoint): void { this.endpoint = endpoint; }

  stop(): void { this.stopped = true; clearTimeout(this.timer); this.ws?.close(); }

  /** Drops the socket as closed without waiting for its close, which one lost to a network change may never send. */
  restart(): void {
    const ws = this.ws;
    const closed = ws?.onclose;
    if (!ws || !closed || !this.online) return;
    ws.onclose = null;
    ws.close();
    closed.call(ws, new Event('close') as CloseEvent);
  }

  call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    const ws = this.ws;
    if (!ws || !this.online) return Promise.reject(new Error('svalld offline'));
    const id = this.next++;
    const ms = serverWait(method, params) + this.callTimeout;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`svalld did not answer ${method} within ${ms}ms`));
      }, ms);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** A call whose result nobody waits for; a failure is logged instead of surfacing as an unhandled rejection. */
  fire<M extends MethodName>(method: M, params: Params<M>): void {
    this.call(method, params).catch((e: Error) => console.warn(`${method}: ${e.message}`));
  }

  private open(): void {
    if (!this.outdated) this.onStatus('connecting');
    const ws = new this.WS(this.endpoint.url);
    this.ws = ws;
    let answered = false;
    const token = this.endpoint.token;
    ws.onopen = () => { if (token !== undefined) ws.send(JSON.stringify({ token })); };
    // a socket already replaced by a reconnect speaks for nobody: neither its messages nor its close count
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg: Response | Event;
      try { msg = JSON.parse(String(ev.data)) as Response | Event; } catch { return; }
      if (!this.online) {
        const hello = 'result' in msg ? msg.result as { ok?: boolean; protocol?: number } : undefined;
        if (hello?.ok) answered = true;
        if (hello?.ok && hello.protocol !== PROTOCOL_VERSION) {
          this.outdated = true;
          this.onStatus('outdated');
          ws.close();
        } else if (hello?.ok) {
          this.outdated = false;
          this.online = true;
          this.delay = this.minDelay;
          this.onStatus('online');
          this.onOpen();
        }
        return;
      }
      if ('event' in msg) { this.onEvent(msg); return; }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if ('error' in msg) p.reject(new ApiError(msg.error.code, msg.error.message));
      else p.resolve(msg.result);
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.online = false;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('svalld connection closed')); }
      this.pending.clear();
      if (this.stopped) return;
      if (!answered) this.outdated = false;
      if (!this.outdated) this.onStatus('offline');
      this.timer = setTimeout(() => this.open(), this.delay);
      this.delay = Math.min(this.delay * 2, this.maxDelay);
    };
  }
}
