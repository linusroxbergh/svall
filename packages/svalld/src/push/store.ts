import { z } from 'zod';
import { PushStatus } from '@svall/protocol';
import { readJsonOrQuarantine, writeJsonAtomic } from '../jsonfile.js';

export const Subscription = z.object({
  endpoint: z.string(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
  statuses: z.array(PushStatus),
  login: z.string(),
  addedAt: z.number(),
});
export type Subscription = z.infer<typeof Subscription>;

const File = z.object({ subscriptions: z.array(Subscription) });

/** Every device that asked to be told, by push endpoint. The file holds the devices' keys, so it is the daemon's alone. */
export class PushStore {
  private subs: Subscription[];

  constructor(private file: string, private log: (msg: string) => void) {
    this.subs = this.read();
  }

  list(): Subscription[] { return [...this.subs]; }

  get(endpoint: string): Subscription | undefined { return this.subs.find((s) => s.endpoint === endpoint); }

  upsert(sub: Subscription): void {
    const i = this.subs.findIndex((s) => s.endpoint === sub.endpoint);
    if (i === -1) this.subs.push(sub); else this.subs[i] = { ...sub, addedAt: this.subs[i].addedAt };
    this.persist();
  }

  remove(endpoint: string): boolean {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    if (this.subs.length === before) return false;
    this.persist();
    return true;
  }

  clear(): void {
    this.subs = [];
    this.persist();
  }

  private read(): Subscription[] {
    return readJsonOrQuarantine(this.file, this.log, (raw) => File.parse(raw).subscriptions) ?? [];
  }

  private persist(): void {
    writeJsonAtomic(this.file, { subscriptions: this.subs }, { mode: 0o600 });
  }
}
