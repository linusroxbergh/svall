import { z } from 'zod';
import { Mutation, UPDATE_FIELDS, cellKey, isLand, methods, type FleetState, type Island, type MachineId, type Robot } from '@svall/protocol';
import { settleItems } from '../context/items.js';
import { removeDocs } from '../docs.js';
import { setNote, type Fleet } from '../fleet.js';
import { blockedCells, occupiedCells, placeOnIsland, uniqueName } from '../layout.js';
import type { Logger } from '../log.js';
import type { Paths } from '../paths.js';
import type { Store } from '../store.js';

export const RECOVERED = (worker: string) => `recovered from ${worker}`;
export const lostLine = (worker: string, field: string, value: unknown) => `${worker} set ${field} to ${JSON.stringify(value)} while this Mac slept; it had changed here since`;
export const notApplied = (worker: string, what: string, why: string) => `${worker} ${what} while this Mac slept; it could not be applied here: ${why}`;
export const sharesBranch = (branch: string, other: string) => `shares branch ${branch} with ${other}`;

/** Adds a line to a robot's note, once. */
export function addLine(c: Robot, line: string): void {
  if (!c.note.includes(line)) c.note = c.note ? `${c.note}\n${line}` : line;
}

const DID: Record<Mutation['method'], string> = {
  'robot.create': 'started this robot', 'robot.update': 'changed this robot', 'robot.close': 'closed this robot', 'robot.run': 'sent this robot a prompt',
};
const Id = z.object({ id: z.string() });
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// whether an island gives a robot a cell without overlapping a neighbour it could not push clear
function gives(state: FleetState, islandId: string): boolean {
  try { placeOnIsland(structuredClone(state), islandId); return true; } catch { return false; }
}

/** What a worker did while this Mac slept, applied here once each, in the order the worker did it. */
export class Replay {
  // the robots each worker's mutations started here that no reconnect has checked yet
  private made = new Map<MachineId, string[]>();

  constructor(private o: { store: Store; fleet: Pick<Fleet, 'createIsland'>; paths: Pick<Paths, 'docs'>; log: Logger }) {}

  /** Never throws: a mutation that does not parse is logged and skipped, one that cannot apply is logged and its robot's note says why. */
  async apply(raw: unknown, machine: MachineId): Promise<void> {
    const worker = this.o.store.state.machines?.[machine]?.name ?? machine;
    const parsed = Mutation.safeParse(raw);
    if (!parsed.success) {
      this.o.log.error(`${worker}: a mutation svalld cannot read is skipped: ${z.prettifyError(parsed.error)}`);
      return;
    }
    const m = parsed.data;
    try {
      if (m.method === 'robot.create') this.create(m, machine, worker);
      else if (m.method === 'robot.update') this.update(m, worker);
      else if (m.method === 'robot.close') this.close(m, machine, worker);
      // a run was typed on the worker at the time; its mutation is the record of it
    } catch (e) {
      const why = (e as Error).message;
      this.o.log.error(`${worker}: ${m.method} ${m.id} not applied: ${why}`);
      const id = m.method === 'robot.create' ? m.robot?.id : Id.safeParse(m.params).data?.id;
      if (id && Object.hasOwn(this.o.store.state.robots, id)) this.o.store.update((d) => addLine(d.robots[id], notApplied(worker, DID[m.method], why)));
    }
  }

  /** The robots `machine` started here since the last call. */
  created(machine: MachineId): string[] {
    const ids = this.made.get(machine) ?? [];
    this.made.delete(machine);
    return ids;
  }

  private create(m: Mutation, machine: MachineId, worker: string): void {
    const r = m.robot;
    if (!r) throw new Error('it carries no robot');
    const { state } = this.o.store;
    if (Object.hasOwn(state.robots, r.id)) return;
    const own = Object.hasOwn(state.islands, r.islandId) ? state.islands[r.islandId] : undefined;
    const kept = own && isLand(own, r.cell) && !occupiedCells(state, own.id).has(cellKey(r.cell)) && !blockedCells(state, own.id).has(cellKey(r.cell));
    const island = own && (kept || gives(state, own.id)) ? own : this.recovered(worker);
    this.o.store.update((d) => {
      // the recovered island grows to take the robot whatever its neighbours
      const cell = kept ? r.cell : placeOnIsland(d, island.id, undefined, this.o.log, true);
      const c: Robot = { ...structuredClone(r), machine, islandId: island.id, cell, name: uniqueName(Object.values(d.robots).map((o) => o.name), r.name) };
      // a placed robot's board column is the home's
      delete c.column;
      delete c.columnSource;
      d.robots[r.id] = c;
    });
    this.made.set(machine, [...(this.made.get(machine) ?? []), r.id]);
  }

  // a field changed here since the worker's base, or a name another robot has taken, keeps this Mac's value, and the note names the worker's
  private update(m: Mutation, worker: string): void {
    const p = methods['robot.update'].params.parse(m.params);
    const { robots } = this.o.store.state;
    if (!Object.hasOwn(robots, p.id)) {
      this.o.log.info(`${worker}: ${p.id} is closed here; what ${worker} changed of it while this Mac slept is dropped`);
      return;
    }
    const c = robots[p.id];
    const next: Partial<Pick<Robot, (typeof UPDATE_FIELDS)[number]>> = {};
    const lost: string[] = [];
    for (const k of UPDATE_FIELDS) {
      if (p[k] === undefined) continue;
      const value = k === 'context' && p.context ? settleItems(p.context, c.context) : p[k];
      if (same(value, c[k])) continue;
      const taken = k === 'name' && Object.values(robots).some((o) => o.id !== c.id && o.name.toLowerCase() === p.name!.toLowerCase());
      if (taken || !same(m.base?.[k], c[k])) lost.push(lostLine(worker, k, p[k]));
      else Object.assign(next, { [k]: value });
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

  private close(m: Mutation, machine: MachineId, worker: string): void {
    const { id } = Id.parse(m.params);
    const { robots } = this.o.store.state;
    // closed here meanwhile
    if (!Object.hasOwn(robots, id)) return;
    if (robots[id].machine !== machine) throw new Error(`it no longer runs on ${worker}`);
    this.o.store.update((d) => { delete d.robots[id]; });
    removeDocs(this.o.paths.docs, 'robot', id, this.o.log);
  }

  // where a worker's robots go when their island is gone or full here
  private recovered(worker: string): Island {
    const name = RECOVERED(worker);
    return Object.values(this.o.store.state.islands).find((i) => i.name.toLowerCase() === name.toLowerCase()) ?? this.o.fleet.createIsland({ name });
  }
}
