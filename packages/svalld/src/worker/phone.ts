import fs from 'node:fs';
import { z } from 'zod';
import { ApiError } from '@svall/protocol';
import { writeDurable } from '../durable.js';
import { readJsonOrQuarantine } from '../jsonfile.js';
import { watchServed, type Mobile } from '../mobile.js';
import { Subscription } from '../push/store.js';
import type { Vapid } from '../push/vapid.js';

const PhoneOn = z.object({
  on: z.literal(true), logins: z.array(z.string()), origin: z.string(), vapid: z.object({ publicKey: z.string(), privateKey: z.string() }),
  subscriptions: z.array(Subscription), contact: z.string().optional(),
});
type PhoneOn = z.infer<typeof PhoneOn>;

/** What the home sends a worker for its phone link: what the home's own link accepts and signs pushes with, or off. */
export const PhoneSet = z.discriminatedUnion('on', [PhoneOn, z.object({ on: z.literal(false) })]);
export type PhoneSet = z.infer<typeof PhoneSet>;
/** The worker's answer: its link and pass while it serves, else why not. */
export const PhoneAnswer = z.object({ url: z.string().optional(), pass: z.string().optional(), error: z.string().optional() });
export type PhoneAnswer = z.infer<typeof PhoneAnswer>;

type Link = Pick<Mobile, 'get' | 'set'> & { served(): string | undefined };

/**
 * On a worker: its own phone link, which the page falls back to while the home does not answer. It serves only while the
 * home's phone.json is here, and stands in for the home's logins, origin, push keys and devices.
 */
export class WorkerPhone {
  private held?: PhoneOn;
  private link: Link;
  // how often a look that fails is tried again, once watched, and the look under way while the link is on
  private watching?: { ms: number; stop?: () => void };

  /** `link`: this worker's own phone link, taking the logins it lets through. */
  constructor(private o: { file: string; link: (logins: () => string[]) => Link; pass: string; log: (msg: string) => void }) {
    this.held = readJsonOrQuarantine(o.file, o.log, (raw) => PhoneOn.parse(raw));
    this.link = o.link(() => this.logins());
  }

  /** Looks at the link each time it turns on, and at once if it is: a daemon on another port is followed under the same key.
   *  The returned function stops it. */
  watch(ms: number): () => void {
    this.watching = { ms };
    this.look();
    return () => { this.watching?.stop?.(); this.watching = undefined; };
  }

  private look(): void {
    const w = this.watching;
    if (w && !w.stop && this.held) w.stop = watchServed(this.link, () => this.on, w.ms);
  }

  get on(): boolean {
    return this.held !== undefined;
  }

  logins(): string[] {
    return this.held?.logins ?? [];
  }

  origins(): string[] {
    return this.held ? [this.held.origin] : [];
  }

  vapid(): Vapid | undefined {
    return this.held?.vapid;
  }

  /** The home's devices, as its last phone.set carried them. */
  list(): Subscription[] {
    return [...this.held?.subscriptions ?? []];
  }

  get(endpoint: string): Subscription | undefined {
    return this.held?.subscriptions.find((s) => s.endpoint === endpoint);
  }

  // a device the push service says is gone leaves this copy; the home's own store learns it on its next push
  remove(endpoint: string): boolean {
    const held = this.held;
    if (!held?.subscriptions.some((s) => s.endpoint === endpoint)) return false;
    this.write({ ...held, subscriptions: held.subscriptions.filter((s) => s.endpoint !== endpoint) });
    return true;
  }

  /** Who a push names as its sender: the home's contact, else the home's own page. */
  contact(): string | undefined {
    return this.held && (this.held.contact ?? `${this.held.origin}/`);
  }

  served(): string | undefined {
    return this.held ? this.link.served() : undefined;
  }

  /** Takes the home's phone.set. A link already served stays as it is, so the key turns over only on an off. */
  async set(raw: unknown): Promise<PhoneAnswer> {
    const p = PhoneSet.safeParse(raw);
    if (!p.success) throw new ApiError('invalid_params', z.prettifyError(p.error));
    if (!p.data.on) {
      const was = this.held;
      this.held = undefined;
      this.watching?.stop?.();
      if (this.watching) this.watching.stop = undefined;
      fs.rmSync(this.o.file, { force: true });
      if (!was) return {};
      const s = await this.link.set(false);
      return s.error ? { error: s.error } : {};
    }
    this.write(p.data);
    this.look();
    let s = await this.link.get();
    if (!s.serving && !s.error) s = await this.link.set(true);
    return s.serving ? { url: s.url, pass: this.o.pass } : { error: s.error ?? `tailscale serve did not take port ${s.port}` };
  }

  private write(p: PhoneOn): void {
    writeDurable(this.o.file, p, { mode: 0o600 });
    this.held = p;
  }
}
