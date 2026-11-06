import type { Event, MethodName, Params, Result } from '@svall/protocol';
import { Api, ApiError, type Status } from './api.js';
import type { Via } from './placement.js';
import type { AppStore } from './store/index.js';

// the Mac's own, wherever the fleet's home is
const MACHINE_METHODS = new Set<string>(['fleets.list', 'fleets.create', 'fleets.start', 'fleet.stop', 'fleet.home', 'home.connection', 'home.fallback', 'feedback.preview'] satisfies MethodName[]);
// a robot on this machine is answered here: its terminal attaches to this tmux, and its files are edited in place
const ROBOT_HERE = new Set<string>(['term.attach', 'fs.list', 'fs.read', 'fs.write', 'repo.status', 'repo.file', 'repo.watch', 'repo.unwatch'] satisfies MethodName[]);

// spaced so a far daemon that stays down costs a far `svall connection-info` now and then
const ASK_MS = [500, 1000, 2000, 5000, 15_000];
// a daemon that did not say which machine is the home, asked again
const KNOW_MS = 5000;
// failed opens with none online since, past which a banner says so: what refuses a page, an origin say, no probe sees
const OPENS = 3;

/** An answer the page no longer waits for, as it left the source that was to give it. */
export class SourceLeft extends Error {
  constructor() { super('svalld connection closed'); }
}

type Opts = { makeApi?: (url: string, token: string) => Api; onSwitch?: () => void; onLocalBack?: () => void };

const endpoint = (port: number) => `ws://127.0.0.1:${port}`;

/**
 * The API the page works through: the fleet's home while it answers, else this machine's daemon, which also answers for
 * what is this machine's. An answer or event from a source the page has left lands nowhere; `retryHome` is a person asking
 * again. The home's token is held here and in its socket alone: the store never has it.
 */
export class FollowApi extends Api {
  private home?: Api;
  private homeOnline = false;
  // a home that dials this machine gives no route: the daemon here serves the window over its link
  private served = false;
  private localOnline = false;
  private localStatus: Status = 'connecting';
  private reported?: Status;
  private active?: Api;
  private generation = 0;
  private me?: Via['machine'];
  private asked = false;
  private askAgain?: ReturnType<typeof setTimeout>;
  private knowAgain?: ReturnType<typeof setTimeout>;
  private tries = 0;
  private failedOpens = 0;
  // a home the page knows it is not on: until its daemon says otherwise, the page stands in for it
  private far = false;

  constructor(readonly local: Api, private store: AppStore, private opts: Opts = {}) {
    super({ url: '' });
    local.onStatus = (s) => this.localStatusChanged(s);
    local.onEvent = (e) => this.heardFrom(local, e);
    local.onOpen = () => { this.localOpened(); };
  }

  override start(): void { this.local.start(); }
  override setEndpoint(endpoint: Parameters<Api['setEndpoint']>[0]): void { this.local.setEndpoint(endpoint); }

  override call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    if (this.isHere(method, params)) return this.local.call(method, params);
    const source = this.far && this.home && this.active === this.home ? this.home : this.local;
    const generation = this.generation;
    return source.call(method, params).then((r) => {
      if (generation !== this.generation) throw new SourceLeft();
      return r;
    }, (e: unknown) => {
      throw generation === this.generation ? e : new SourceLeft();
    });
  }

  /** Asks again what nothing asks by itself: a refused login, a version or a mismatch that a person has dealt with. */
  retryHome(): void {
    this.tries = 0;
    this.failedOpens = 0;
    void this.ask(true);
  }

  // the same daemon answers these whichever source the page follows, so a switch leaves their answers good
  private isHere(method: string, params: unknown): boolean {
    if (MACHINE_METHODS.has(method)) return true;
    const id = (params as { id?: unknown } | undefined)?.id;
    return this.far && ROBOT_HERE.has(method) && typeof id === 'string' && this.store.getState().fleet.robots[id]?.machine === this.me;
  }

  private heardFrom(source: Api, e: Event): void {
    // a watch of a robot on this machine stays here while the page follows the home
    if (source === this.active || (source === this.local && e.event === 'repo.changed')) this.onEvent(e);
  }

  private localStatusChanged(s: Status): void {
    this.localStatus = s;
    if (s !== 'online') this.localOnline = false;
    if (s === 'offline' || s === 'outdated') {
      // a home socket that is not up would offer its token to whoever holds the forward's port once the forward has gone
      if (!this.homeOnline) this.dropHome();
      // the shell starts the daemon again and re-reads its port
      this.onLocalLost(s);
    }
    this.pick();
  }

  /** The shell is asked for the port again: set by the page. */
  onLocalLost: (s: Status) => void = () => {};

  private localOpened(): void {
    clearTimeout(this.knowAgain);
    let turned = false;
    this.local.call('fleet.home', {}).then((h) => {
      turned = !this.far && !h.mine;
      this.me = h.me;
      this.far = !h.mine;
      if (!h.mine) {
        // a daemon enrolled meanwhile under another home leaves nothing to follow of the old one
        if (this.store.getState().via?.home !== h.machine) this.dropHome();
        this.store.getState().setHome({ ...this.store.getState().home, name: h.name, state: this.homeOnline ? 'connected' : 'connecting' });
        this.store.getState().setVia({ machine: h.me, home: h.machine, name: h.name, ...((this.homeOnline || this.served) && { online: true as const }), ...(this.served && { served: true as const }) });
      } else {
        this.home?.stop();
        this.home = undefined;
        this.homeOnline = false;
        this.served = false;
        this.store.getState().setHome(undefined);
        this.store.getState().setVia(undefined);
      }
    }, (e: unknown) => {
      // what the page knew stands; a daemon that answered has none to name, and a socket that closed asks again as it opens
      if (!(e instanceof ApiError) && this.localStatus === 'online') this.knowAgain = setTimeout(() => this.localOpened(), KNOW_MS);
    }).then(() => {
      if (this.localStatus !== 'online') return;
      this.localOnline = true;
      const was = this.active;
      this.pick();
      // a daemon that named its home only on a later try stands in with no move to say so
      if (turned && this.active === was) this.announce();
      // the socket's close took this machine's watches with it, and no move sends them again while the home stays
      if (this.home && this.active === this.home) this.opts.onLocalBack?.();
      if (!this.far) return;
      void this.ask(!this.asked);
      this.asked = true;
    });
  }

  private async ask(retry = false): Promise<void> {
    clearTimeout(this.askAgain);
    this.askAgain = undefined;
    let a: Result<'home.connection'>;
    try {
      a = await this.local.call('home.connection', retry ? { retry } : {});
    } catch (e) {
      // the daemon answered, and asking again waits on whatever it could not read
      const { home } = this.store.getState();
      if (e instanceof ApiError && this.far && home) this.store.getState().setHome({ ...home, state: 'unreachable', detail: e.message });
      if (this.far && this.localOnline) this.askSoon();
      return;
    }
    if (!this.far) return;
    const { token, port, ssh, controlSocket, state, name, detail, newer, release } = a;
    const master = ssh && controlSocket ? { ssh, controlSocket } : undefined;
    const route = state === 'connected' && port && token ? endpoint(port) : undefined;
    const stuck = !!route && !this.homeOnline && this.failedOpens >= OPENS;
    this.store.getState().setHome({ name, state: stuck ? 'unreachable' : route && !this.homeOnline ? 'connecting' : state, ...(stuck ? { detail: this.stuckDetail(name) } : detail && { detail }), ...(newer && { newer }), ...(release && { release }), ...(master && { master }) });
    if (route) {
      this.follow(route, token!);
      return;
    }
    // no route is held for a home that gives none, so its old socket stops knocking
    this.dropHome();
    if (state === 'connected') this.tries = ASK_MS.length;
    this.setServed(state === 'connected');
    // the daemon answers a mismatch or its link from memory, so asking again runs nothing there
    if (state === 'connecting' || state === 'unreachable' || state === 'connected') this.askSoon();
  }

  private stuckDetail(name: string): string { return `the API on ${name} answers, and closes this window's socket`; }

  // at most one ask waits, whatever else reports the home gone meanwhile, as each failed open of its socket does
  private askSoon(): void {
    if (this.askAgain !== undefined) return;
    const ms = ASK_MS[Math.min(this.tries, ASK_MS.length - 1)];
    this.tries++;
    this.askAgain = setTimeout(() => { this.askAgain = undefined; void this.ask(); }, ms);
  }

  private setServed(on: boolean): void {
    if (on === this.served) return;
    this.served = on;
    this.announce();
  }

  // what the store and this machine's daemon know of where the window stands
  private announce(): void {
    const { via } = this.store.getState();
    const online = this.served || (!!this.home && this.active === this.home);
    if (via) this.store.getState().setVia({ machine: via.machine, home: via.home, name: via.name, ...(online && { online }), ...(this.served && { served: true as const }) });
    this.local.call('home.fallback', { on: !online }).catch(() => {});
  }

  private follow(url: string, token: string): void {
    if (this.home) {
      this.home.setEndpoint({ url, token });
      return;
    }
    const home = this.opts.makeApi?.(url, token) ?? new Api({ url, token });
    this.home = home;
    home.onEvent = (e) => this.heardFrom(home, e);
    home.onOpen = () => { if (this.home === home) { this.tries = 0; this.failedOpens = 0; this.homeOnline = true; this.pick(); } };
    home.onStatus = (s) => { if (this.home === home) this.homeStatus(s); };
    home.start();
  }

  private homeStatus(s: Status): void {
    if (s === 'online') {
      this.store.getState().setHome({ ...this.store.getState().home!, state: 'connected' });
      return;
    }
    if (s === 'connecting') return;
    const was = this.homeOnline;
    this.homeOnline = false;
    if (!was && s !== 'outdated') this.failedOpens++;
    const stuck = this.failedOpens >= OPENS;
    const home = this.store.getState().home!;
    // another protocol: no retry changes it, and no earlier socket's trouble says why; a wrong token closes as any other socket, and the next ask brings the right one
    this.store.getState().setHome({ ...home, state: s === 'outdated' ? 'version' : stuck ? 'unreachable' : 'connecting', ...(s === 'outdated' ? { detail: undefined } : stuck && { detail: this.stuckDetail(home.name) }) });
    // this socket's retry would offer the token to whatever holds the port once the forward has gone, so only an answer opens another
    this.dropHome();
    if (s !== 'outdated' && this.localStatus === 'online') this.askSoon();
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
    if (!next && this.active) {
      this.active = undefined;
      if (this.far) this.announce();
    }
    this.report(next ? 'online' : this.localStatus);
  }

  private move(next: Api): void {
    const first = this.active === undefined && next === this.local && !this.far;
    this.active = next;
    this.generation++;
    if (this.far) this.announce();
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
