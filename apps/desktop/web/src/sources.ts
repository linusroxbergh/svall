import type { Event, MethodName, Params, Result } from '@svall/protocol';
import { Api, type Status } from './api.js';
import type { Via } from './placement.js';
import type { AppStore } from './store/index.js';

// the Mac's own, wherever the fleet's home is
const MACHINE_METHODS = new Set<string>(['fleets.list', 'fleets.create', 'fleets.start', 'fleet.stop', 'fleet.home', 'home.connection', 'home.fallback'] satisfies MethodName[]);
// a robot on this machine is answered here: its terminal attaches to this tmux, and its files are edited in place
const ROBOT_HERE = new Set<string>(['term.attach', 'fs.list', 'fs.read', 'fs.write', 'repo.status', 'repo.file', 'repo.watch', 'repo.unwatch'] satisfies MethodName[]);

// spaced so a far daemon that stays down costs a far `svall connection-info` now and then
const ASK_MS = [500, 1000, 2000, 5000, 15_000];

/** An answer the page no longer waits for, as it left the source that was to give it. */
export class SourceLeft extends Error {
  constructor() { super('svalld connection closed'); }
}

type Opts = { makeApi?: (url: string, token: string) => Api; onSwitch?: () => void };

const endpoint = (port: number) => `ws://127.0.0.1:${port}`;

/**
 * The API the page works through: the fleet's home while it answers, else this machine's daemon, which also answers for
 * what is this machine's. An answer or event from a source the page has left lands nowhere; `retryHome` is a person asking
 * again. The home's token is held here and in its socket alone: the store never has it.
 */
export class FollowApi extends Api {
  private home?: Api;
  private homeOnline = false;
  private localOnline = false;
  private localStatus: Status = 'connecting';
  private reported?: Status;
  private active?: Api;
  private generation = 0;
  private me?: Via['machine'];
  private asked = false;
  private askAgain?: ReturnType<typeof setTimeout>;
  private tries = 0;
  // a home the page knows it is not on: until its daemon says otherwise, the page stands in for it
  private far = false;

  constructor(readonly local: Api, private store: AppStore, private opts: Opts = {}) {
    super({ url: '' });
    local.onStatus = (s) => this.localStatusChanged(s);
    local.onEvent = (e) => this.heardFrom(local, e);
    local.onOpen = () => { this.localOpened(); };
  }

  override start(): void { this.local.start(); }
  override stop(): void { clearTimeout(this.askAgain); this.home?.stop(); this.local.stop(); }
  override setEndpoint(endpoint: Parameters<Api['setEndpoint']>[0]): void { this.local.setEndpoint(endpoint); }

  override call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    const source = this.sourceOf(method, params);
    if (source === this.local && MACHINE_METHODS.has(method)) return source.call(method, params);
    const generation = this.generation;
    return source.call(method, params).then((r) => {
      if (generation !== this.generation) throw new SourceLeft();
      return r;
    });
  }

  /** Asks again what nothing asks by itself: a refused login, a version or a mismatch that a person has dealt with. */
  retryHome(): void {
    this.tries = 0;
    void this.ask(true);
  }

  private sourceOf(method: string, params: unknown): Api {
    if (!this.far || this.active !== this.home || !this.home) return this.local;
    if (MACHINE_METHODS.has(method)) return this.local;
    const id = (params as { id?: unknown } | undefined)?.id;
    if (ROBOT_HERE.has(method) && typeof id === 'string' && this.store.getState().fleet.robots[id]?.machine === this.me) return this.local;
    return this.home;
  }

  private heardFrom(source: Api, e: Event): void {
    // a watch of a robot on this machine stays here while the page follows the home
    if (source === this.active || (source === this.local && e.event === 'repo.changed')) this.onEvent(e);
  }

  private localStatusChanged(s: Status): void {
    this.localStatus = s;
    if (s !== 'online') this.localOnline = false;
    // the shell starts the daemon again and re-reads its port
    if (s === 'offline' || s === 'outdated') this.onLocalLost(s);
    this.pick();
  }

  /** The shell is asked for the port again: set by the page. */
  onLocalLost: (s: Status) => void = () => {};

  private localOpened(): void {
    this.local.call('fleet.home', {}).then((h) => {
      this.me = h.me;
      this.far = !h.mine;
      if (!h.mine) {
        // a daemon enrolled meanwhile under another home leaves nothing to follow of the old one
        if (this.store.getState().via?.home !== h.machine) this.dropHome();
        this.store.getState().setHome({ ...this.store.getState().home, name: h.name, state: this.homeOnline ? 'connected' : 'connecting' });
        this.store.getState().setVia({ machine: h.me, home: h.machine, name: h.name, ...(this.homeOnline && { online: true as const }) });
      } else {
        this.home?.stop();
        this.home = undefined;
        this.homeOnline = false;
        this.store.getState().setHome(undefined);
        this.store.getState().setVia(undefined);
      }
    }, () => { this.far = false; }).then(() => {
      this.localOnline = true;
      this.pick();
      if (this.far) void this.ask(!this.asked);
      this.asked = true;
    });
  }

  private async ask(retry = false): Promise<void> {
    clearTimeout(this.askAgain);
    let a: Result<'home.connection'>;
    try {
      a = await this.local.call('home.connection', retry ? { retry } : {});
    } catch (e) {
      void e;
      if (this.far && this.localOnline) this.askSoon();
      return;
    }
    if (!this.far) return;
    const { token, port, ssh, controlSocket, state, name, detail, release, newer } = a;
    const master = ssh && controlSocket ? { ssh, controlSocket } : undefined;
    this.store.getState().setHome({ name, state: state === 'connected' && !this.homeOnline ? 'connecting' : state, ...(detail && { detail }), ...(release && { release }), ...(newer && { newer }), ...(master && { master }) });
    if (state === 'connected' && port && token) {
      this.follow(endpoint(port), token);
      return;
    }
    // no route is held for a home that gives none, so its old socket stops knocking
    this.dropHome();
    // the daemon answers a mismatch from memory, so asking again runs nothing there
    if (state === 'connecting' || state === 'unreachable') this.askSoon();
  }

  private askSoon(): void {
    clearTimeout(this.askAgain);
    const ms = ASK_MS[Math.min(this.tries, ASK_MS.length - 1)];
    this.tries++;
    this.askAgain = setTimeout(() => { void this.ask(); }, ms);
  }

  private follow(url: string, token: string): void {
    if (this.home) {
      this.home.setEndpoint({ url, token });
      return;
    }
    const home = this.opts.makeApi?.(url, token) ?? new Api({ url, token });
    this.home = home;
    home.onEvent = (e) => this.heardFrom(home, e);
    home.onOpen = () => { if (this.home === home) { this.tries = 0; this.homeOnline = true; this.pick(); } };
    home.onStatus = (s) => { if (this.home === home) this.homeStatus(s); };
    home.start();
  }

  private homeStatus(s: Status): void {
    if (s === 'online') {
      this.store.getState().setHome({ ...this.store.getState().home!, state: 'connected' });
      return;
    }
    if (s === 'connecting') return;
    this.homeOnline = false;
    if (s === 'offline') {
      this.store.getState().setHome({ ...this.store.getState().home!, state: 'connecting' });
      this.askSoon();
    } else {
      // another protocol, or a home that refuses this window: no retry changes either
      this.store.getState().setHome({ ...this.store.getState().home!, state: s === 'outdated' ? 'version' : 'auth' });
      this.dropHome();
    }
    this.pick();
  }

  private dropHome(): void {
    const { home } = this;
    this.home = undefined;
    this.homeOnline = false;
    home?.stop();
    if (home && this.active === home) this.pick();
  }

  // the home whenever it answers, else this machine's daemon
  private pick(): void {
    const next = this.far && this.homeOnline ? this.home : this.localOnline ? this.local : undefined;
    if (next && next !== this.active) return this.move(next);
    if (!next) this.active = undefined;
    this.report(next ? 'online' : this.localStatus);
  }

  private move(next: Api): void {
    const first = this.active === undefined && next === this.local && !this.far;
    this.active = next;
    this.generation++;
    if (this.far) {
      const { via } = this.store.getState();
      const online = next === this.home;
      if (via) this.store.getState().setVia({ machine: via.machine, home: via.home, name: via.name, ...(online && { online }) });
      this.local.call('home.fallback', { on: !online }).catch(() => {});
    }
    if (!first) { this.opts.onSwitch?.(); this.report('connecting'); }
    this.report('online');
    this.onOpen();
  }

  private report(s: Status): void {
    if (s === this.reported) return;
    this.reported = s;
    this.onStatus(s);
  }
}
