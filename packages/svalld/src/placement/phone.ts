import { z } from 'zod';
import { ApiError, MachineId, type PhoneFallback, type SetupRow } from '@svall/protocol';
import { writeDurable } from '../durable.js';
import { readJsonOrQuarantine } from '../jsonfile.js';
import type { WorkerLink } from '../link/home.js';
import type { Logger } from '../log.js';
import type { Mobile } from '../mobile.js';
import type { PushStore } from '../push/store.js';
import type { Vapid } from '../push/vapid.js';
import type { Store } from '../store.js';
import { PhoneAnswer, type PhoneSet } from '../worker/phone.js';
import { fieldKey, readConsent } from './mirror-consent.js';

/** The consent item that lets a worker serve the phone, which carries this Mac's push keys and devices there. */
export const PHONE_ITEM = 'phone';
const PHONE_FIELD = 'on';

// tailscale refuses serve to a user it was not told to take it from
const NOT_OPERATOR = /access denied|--operator/i;

const Held = z.record(MachineId, z.object({ url: z.string(), pass: z.string() }));
type Held = z.infer<typeof Held>;

/**
 * On the home: each worker's own phone link, which serves while the worker's consent is ticked and this Mac's own link
 * serves. What each worker answered is kept on this machine alone, since it holds the worker's pass.
 */
export class PhoneFallbacks {
  private held: Held;
  // why a worker last did not serve
  private failed = new Map<MachineId, string>();
  // each worker's last sync, which its next one waits for
  private chains = new Map<MachineId, Promise<unknown>>();

  constructor(private o: {
    me: MachineId; file: string; consent: string; store: Store; links: { for(machine: MachineId): Pick<WorkerLink, 'call' | 'connected'> | undefined };
    mobile: Pick<Mobile, 'get'> & { logins(): string[] }; vapid: Vapid; push: Pick<PushStore, 'list'>; contact?: string; log: Logger;
  }) {
    this.held = readJsonOrQuarantine(o.file, o.log.error, (raw) => Held.parse(raw)) ?? {};
  }

  /** Whether `machine` serves the phone itself, which then pushes for its own robots. */
  serves(machine: MachineId | undefined): boolean {
    return machine !== undefined && Object.hasOwn(this.held, machine);
  }

  fallbacks(): { home: MachineId; fallbacks: PhoneFallback[] } {
    const names = this.o.store.state.machines ?? {};
    return {
      home: this.o.me,
      fallbacks: Object.entries(this.held).map(([m, { url, pass }]) => ({ machine: m as MachineId, name: names[m as MachineId]?.name ?? m, url, pass })),
    };
  }

  consented(machine: MachineId): boolean {
    return readConsent(this.o.consent, machine).has(fieldKey(PHONE_ITEM, PHONE_FIELD));
  }

  /** Tells each worker whether to serve the phone. */
  syncAll(): Promise<void> {
    const machines = new Set([...Object.keys(this.o.store.state.machines ?? {}), ...Object.keys(this.held)] as MachineId[]);
    machines.delete(this.o.me);
    return Promise.all([...machines].map((m) => this.sync(m))).then(() => {});
  }

  /** Tells `machine` whether to serve the phone, after any sync to it under way. */
  sync(machine: MachineId): Promise<void> {
    const run = (this.chains.get(machine) ?? Promise.resolve()).then(() => this.syncNow(machine))
      .catch((e: Error) => this.o.log.error(`phone: ${this.name(machine)} was not told: ${e.message}`));
    this.chains.set(machine, run);
    return run;
  }

  /** The setup row of `machine`'s phone link, with the consent it toggles. */
  row(machine: MachineId): SetupRow {
    const name = this.name(machine);
    const tick = { item: PHONE_ITEM, fields: [PHONE_FIELD], on: this.consented(machine), preview: [] };
    const held = this.held[machine];
    const why = this.failed.get(machine);
    if (!tick.on) return { key: PHONE_ITEM, status: 'skip', detail: `off: the phone reaches ${name}'s robots only through this Mac; ticked, ${name} serves them while this Mac is off, with this Mac's push keys`, tick };
    if (held) return { key: PHONE_ITEM, status: 'ok', detail: `the phone reaches ${name}'s robots at ${held.url} while this Mac is off`, tick };
    if (why === undefined) return { key: PHONE_ITEM, status: 'skip', detail: `ticked; ${name} serves the phone once this Mac's phone link is on and ${name} is linked`, tick };
    return {
      key: PHONE_ITEM, status: 'warn', detail: `${name} does not serve the phone: ${why}`, tick, gap: { name: 'phone', what: 'not served' },
      action: NOT_OPERATOR.test(why) ? 'sudo tailscale set --operator=$USER' : `check ${name} again`,
    };
  }

  private name(machine: MachineId): string {
    return this.o.store.state.machines?.[machine]?.name ?? machine;
  }

  // a look at this Mac's link that fails changes nothing, so a start before tailscale answers leaves each worker serving
  private async syncNow(machine: MachineId): Promise<void> {
    const status = await this.o.mobile.get();
    if (status.error) return;
    const link = this.o.links.for(machine);
    const linked = link?.connected() === true;
    if (!status.serving || !this.consented(machine)) {
      this.failed.delete(machine);
      this.drop(machine);
      // a worker that predates the phone link has nothing to turn off
      if (linked) await link.call('phone.set', { on: false } satisfies PhoneSet).catch((e: unknown) => { if (!(e instanceof ApiError && e.code === 'unknown_method')) throw e; });
      return;
    }
    if (!linked) return;
    const set: PhoneSet = {
      on: true, logins: this.o.mobile.logins(), origin: new URL(status.url).origin, vapid: this.o.vapid, subscriptions: this.o.push.list(),
      ...(this.o.contact && { contact: this.o.contact }),
    };
    let answer: PhoneAnswer;
    try {
      answer = PhoneAnswer.parse(await link.call('phone.set', set));
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'unknown_method')) throw e;
      answer = { error: 'it runs a release that cannot serve the phone; upgrade it' };
    }
    if (answer.url && answer.pass) {
      this.failed.delete(machine);
      this.keep(machine, { url: answer.url, pass: answer.pass });
      return;
    }
    this.failed.set(machine, answer.error ?? 'it did not say why');
    this.drop(machine);
  }

  private keep(machine: MachineId, entry: Held[MachineId]): void {
    const was = this.held[machine];
    if (was?.url === entry.url && was.pass === entry.pass) return;
    this.write({ ...this.held, [machine]: entry });
  }

  private drop(machine: MachineId): void {
    if (!Object.hasOwn(this.held, machine)) return;
    const { [machine]: _gone, ...rest } = this.held;
    this.write(rest);
  }

  private write(held: Held): void {
    writeDurable(this.o.file, held, { mode: 0o600 });
    this.held = held;
  }
}
