import { z } from 'zod';
import { Mutation, UPDATE_FIELDS, cellKey, isLand, methods, type ContextItem, type FleetState, type Island, type MachineId, type ParsedParams, type Robot } from '@svall/protocol';
import { settleItems } from '../context/items.js';
import { removeDocs } from '../docs.js';
import { setNote } from '../fleet.js';
import { addIsland } from '../islands.js';
import { blockedCells, occupiedCells, placeOnIsland, unfold, uniqueName } from '../layout.js';
import type { Logger } from '../log.js';
import type { Paths } from '../paths.js';
import type { Store } from '../store.js';

export const RECOVERED = (worker: string) => `recovered from ${worker}`;
export const lostLine = (worker: string, field: string, value: unknown) => `${worker} set ${field} to ${JSON.stringify(value)} while this Mac slept; it had changed here since`;
export const notApplied = (worker: string, what: string, why: string) => `${worker} ${what} while this Mac slept; it could not be applied here: ${why}`;
export const sharesBranch = (branch: string, other: string) => `shares branch ${branch} with ${other}`;
export const notHere = (worker: string, ref: string) => `${worker} added ${ref} to the context while this Mac slept; it is not on this Mac`;

/** A note with `line` added, once. */
export const withLine = (note: string, line: string): string => (note.includes(line) ? note : note ? `${note}\n${line}` : line);

// a line the replay writes is the user's, so the scribe leaves the note as it stands
const addLine = (c: Robot, line: string): void => setNote(c, withLine(c.note, line));
// a reason on one line, as a note keeps it
const oneLine = (e: unknown): string => (e instanceof z.ZodError ? z.prettifyError(e) : (e as Error).message).replace(/\s*\n\s*/g, ' ');

const DID: Record<Mutation['method'], string> = {
  'robot.create': 'started this robot', 'robot.update': 'changed this robot', 'robot.close': 'closed this robot', 'robot.run': 'sent this robot a prompt',
};
const Id = z.object({ id: z.string() });
// a context as this Mac stores it, and the refs of the paths it does not have
type Settled = { items: ContextItem[]; missing: string[] };
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// where a worker's robots go when their island is gone or full here, made in the write that places the first
function recovered(d: FleetState, worker: string): Island {
  const name = RECOVERED(worker);
  return Object.values(d.islands).find((i) => i.name.toLowerCase() === name.toLowerCase()) ?? addIsland(d, { name });
}

// whether an island gives a robot a cell without overlapping a neighbour it could not push clear
function gives(state: FleetState, islandId: string): boolean {
  try { placeOnIsland(structuredClone(state), islandId); return true; } catch { return false; }
}

/** A mutation's change to the store, made inside the link's hold, and what follows once that change is written. */
export type Staged = { change(): void; after(): void };

/** What a worker did while this Mac slept, applied here once each, in the order the worker did it. */
export class Replay {
  // the robots each worker's mutations started here that no reconnect has checked yet
  private made = new Map<MachineId, string[]>();

  constructor(private o: { store: Store; paths: Pick<Paths, 'docs'>; log: Logger }) {}

  /** Reads from disk what a mutation needs. Neither step throws: a mutation that does not parse is logged and skipped, one that
   *  cannot apply is logged and its robot's note says why. `change` writes the store alone; logs and removed docs wait for `after`. */
  async prepare(raw: unknown, machine: MachineId): Promise<Staged> {
    const worker = this.o.store.state.machines?.[machine]?.name ?? machine;
    const parsed = Mutation.safeParse(raw);
    if (!parsed.success) {
      this.o.log.error(`${worker}: a mutation svalld cannot read is skipped: ${z.prettifyError(parsed.error)}`);
      return { change() {}, after() {} };
    }
    const m = parsed.data;
    const p = m.method === 'robot.update' ? methods['robot.update'].params.safeParse(m.params) : undefined;
    const settled = p?.success && p.data.context ? this.settle(p.data.id, p.data.context) : undefined;
    const later: (() => void)[] = [];
    const log: Logger = { info: (s) => later.push(() => this.o.log.info(s)), error: (s) => later.push(() => this.o.log.error(s)) };
    return {
      change: () => {
        try {
          if (m.method === 'robot.create') this.create(m, machine, worker, log);
          else if (p && !p.success) throw p.error;
          else if (p) this.update(m, p.data, settled, worker, log);
          else if (m.method === 'robot.close') {
            const id = this.close(m, machine, worker);
            if (id) later.push(() => removeDocs(this.o.paths.docs, 'robot', id, this.o.log));
          }
          // a run was typed on the worker at the time; its mutation is the record of it
        } catch (e) {
          const why = oneLine(e);
          log.error(`${worker}: ${m.method} ${m.id} not applied: ${why}`);
          const id = m.method === 'robot.create' ? m.robot?.id : Id.safeParse(m.params).data?.id;
          if (id && Object.hasOwn(this.o.store.state.robots, id)) this.o.store.update((d) => addLine(d.robots[id], notApplied(worker, DID[m.method], why)));
        }
      },
      after: () => { for (const run of later.splice(0)) run(); },
    };
  }

  /** `prepare`, `change` and `after` at once, for a caller in no hold. */
  async apply(raw: unknown, machine: MachineId): Promise<void> {
    const staged = await this.prepare(raw, machine);
    staged.change();
    staged.after();
  }

  /** The robots `machine` started here since the last call. */
  created(machine: MachineId): string[] {
    const ids = this.made.get(machine) ?? [];
    this.made.delete(machine);
    return ids;
  }

  private create(m: Mutation, machine: MachineId, worker: string, log: Logger): void {
    const r = m.robot;
    if (!r) throw new Error('it carries no robot');
    if (Object.hasOwn(this.o.store.state.robots, r.id)) return;
    this.o.store.update((d) => {
      const own = Object.hasOwn(d.islands, r.islandId) ? d.islands[r.islandId] : undefined;
      const kept = own && isLand(own, r.cell) && !occupiedCells(d, own.id).has(cellKey(r.cell)) && !blockedCells(d, own.id).has(cellKey(r.cell));
      const island = own && (kept || gives(d, own.id)) ? own : recovered(d, worker);
      // forced, the recovered island takes the robot whatever its neighbours; its own island was probed to give a cell without
      const cell = kept ? r.cell : placeOnIsland(d, island.id, undefined, log, true);
      // a folded island comes back to take it, as one given a robot's cell does
      if (kept && island.collapsed) unfold(d, island.id, log);
      const c: Robot = { ...structuredClone(r), machine, islandId: island.id, cell, name: uniqueName(Object.values(d.robots).map((o) => o.name), r.name) };
      // a placed robot's board column is the home's
      delete c.column;
      delete c.columnSource;
      d.robots[r.id] = c;
    });
    this.made.set(machine, [...(this.made.get(machine) ?? []), r.id]);
  }

  // each item of an update's context as this Mac stores it, read before the hold; a path this Mac lacks is left out
  private settle(id: string, items: ContextItem[]): Settled {
    const { robots } = this.o.store.state;
    const held = Object.hasOwn(robots, id) ? robots[id].context : [];
    const settled: Settled = { items: [], missing: [] };
    for (const it of items) {
      try { settled.items.push(...settleItems([it], held)); } catch { settled.missing.push(it.ref); }
    }
    return settled;
  }

  // a field changed here since the worker's base, or a name another robot has taken, keeps this Mac's value, and the note names the worker's
  private update(m: Mutation, p: ParsedParams<'robot.update'>, settled: Settled | undefined, worker: string, log: Logger): void {
    const { robots } = this.o.store.state;
    if (!Object.hasOwn(robots, p.id)) {
      log.info(`${worker}: ${p.id} is closed here; what ${worker} changed of it while this Mac slept is dropped`);
      return;
    }
    const c = robots[p.id];
    const next: Partial<Pick<Robot, (typeof UPDATE_FIELDS)[number]>> = {};
    const lost: string[] = [];
    for (const k of UPDATE_FIELDS) {
      if (p[k] === undefined) continue;
      const value = k === 'context' ? settled?.items : p[k];
      const changed = !same(value, c[k]);
      const taken = k === 'name' && Object.values(robots).some((o) => o.id !== c.id && o.name.toLowerCase() === p.name!.toLowerCase());
      if (changed && (taken || !same(m.base?.[k], c[k]))) {
        lost.push(lostLine(worker, k, p[k]));
        continue;
      }
      if (changed) Object.assign(next, { [k]: value });
      if (k === 'context') lost.push(...(settled?.missing ?? []).map((ref) => notHere(worker, ref)));
    }
    this.o.store.update((d) => {
      const r = d.robots[p.id];
      if (next.name !== undefined) r.name = next.name;
      if (next.note !== undefined) setNote(r, next.note);
      if (next.instructions !== undefined) r.instructions = next.instructions;
      if (next.context) r.context = next.context;
      for (const line of lost) addLine(r, line);
    });
  }

  // the id of the robot whose record went, for its docs to follow
  private close(m: Mutation, machine: MachineId, worker: string): string | undefined {
    const { id } = Id.parse(m.params);
    const { robots } = this.o.store.state;
    // closed here meanwhile
    if (!Object.hasOwn(robots, id)) return undefined;
    if (robots[id].machine !== machine) throw new Error(`it no longer runs on ${worker}`);
    this.o.store.update((d) => { delete d.robots[id]; });
    return id;
  }
}
