import { z } from 'zod';
import { ISLAND_FIELDS, Mutation, UPDATE_FIELDS, cellKey, isLand, methods, type ContextItem, type FleetState, type Island, type MachineId, type ParsedParams, type Robot } from '@svall/protocol';
import { settleItems } from '../context/items.js';
import { removeDocs } from '../docs.js';
import { setNote } from '../fleet.js';
import { isIslandId, isRobotId } from '../ids.js';
import { addIsland, dropIsland, updateIsland, type IslandPatch } from '../islands.js';
import { blockedCells, occupiedCells, placeOnIsland, unfold, uniqueName } from '../layout.js';
import type { Logger } from '../log.js';
import type { Paths } from '../paths.js';
import type { Store } from '../store.js';
import { homeRootOf } from './repo-key.js';

const RECOVERED = (worker: string) => `recovered from ${worker}`;
const lostLine = (worker: string, field: string, value: unknown) => `${worker} set ${field} to ${JSON.stringify(value)} while this Mac slept; it had changed here since`;
const takenLine = (worker: string, name: string, other: 'robot' | 'island') => `${worker} set name to ${JSON.stringify(name)} while this Mac slept; another ${other} has that name here`;
const notApplied = (worker: string, what: string, why: string) => `${worker} ${what} while this Mac slept; it could not be applied here: ${why}`;
const sharesBranch = (branch: string, other: string) => `shares branch ${branch} with ${other}`;
const notHere = (worker: string, ref: string) => `${worker} added ${ref} to the context while this Mac slept; it is not on this Mac`;
const HOME_HERE = 'mission control changes only on this Mac';

/** A note with `line` added, once. */
export const withLine = (note: string, line: string): string => (note.includes(line) ? note : note ? `${note}\n${line}` : line);

/** The line a robot's note gets when another robot is on its branch of its repository, the clones named as on the home. */
export function sharedBranch(state: FleetState, id: string, homedir: string | undefined): string | undefined {
  const c = Object.hasOwn(state.robots, id) ? state.robots[id] : undefined;
  const branch = c?.repo?.branch;
  if (!c || !branch) return undefined;
  const root = (r: Robot) => homeRootOf(r, state.machines, homedir);
  const other = Object.values(state.robots).find((r) => r.id !== id && r.repo?.branch === branch && root(r) === root(c));
  return other && sharesBranch(branch, other.name);
}

// a line the replay writes is the user's, so the scribe leaves the note as it stands
export const addLine = (c: Robot, line: string): void => setNote(c, withLine(c.note, line));
// a reason on one line, as a note keeps it
export const oneLine = (e: unknown): string => (e instanceof z.ZodError ? z.prettifyError(e) : e instanceof Error ? e.message : String(e)).replace(/\s*\n\s*/g, ' ');

// a journaled update is taken whatever its note's length, which caps only what a request may ask for
const Update = methods['robot.update'].params.extend({ note: z.string().optional() });
const IslandCreate = methods['island.create'].params;
const IslandUpdate = methods['island.update'].params;

// what a robot's note says a mutation did, when it could not be applied
const DID: Partial<Record<Mutation['method'], string>> = {
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

/** An event's change to the store, made inside the link's hold, and what follows once that change is written; `docs`
 *  when the worker is to have the fleet's docs once the event is acked. */
export type Staged = { change(): void; after?(): void; docs?: true };

/** What a worker did while this Mac slept, in the order the worker did it: the link applies each mutation once by its outbox
 *  epoch and seq, and each kind here is idempotent by content, not by mutation id. */
export class Replay {
  // the robots each worker's mutations started here before its link was synced, for its reconnect to check
  private made = new Map<MachineId, string[]>();
  // the robots a synced worker's mutations started here, checked once a report brings their repo
  private fresh = new Set<string>();
  // the name each island a worker made here took in place of the one the worker gave it, which the worker's updates name as their base
  private renamed = new Map<string, { from: string; to: string }>();

  constructor(private o: { store: Store; paths: Pick<Paths, 'docs'>; log: Logger; synced: (machine: MachineId) => boolean; homedir: string }) {}

  /** Reads from disk what a mutation needs. Neither step throws: a mutation that does not parse is logged and skipped, one that
   *  cannot apply is logged and its robot's note says why. `change` writes the store alone; logs and removed docs wait for `after`. */
  async prepare(raw: unknown, machine: MachineId): Promise<Staged & { after(): void }> {
    const worker = this.o.store.state.machines?.[machine]?.name ?? machine;
    const parsed = Mutation.safeParse(raw);
    if (!parsed.success) {
      this.o.log.error(`${worker}: a mutation svalld cannot read is skipped: ${z.prettifyError(parsed.error)}`);
      return { change() {}, after() {} };
    }
    const m = parsed.data;
    const p = m.method === 'robot.update' ? Update.safeParse(m.params) : undefined;
    const settled = p?.success && p.data.context ? this.settle(p.data.id, p.data.context) : undefined;
    const later: (() => void)[] = [];
    const log: Logger = { info: (s) => later.push(() => this.o.log.info(s)), error: (s) => later.push(() => this.o.log.error(s)) };
    return {
      change: () => {
        try {
          if (m.method === 'robot.create') this.create(m, machine, worker, log);
          else if (p && !p.success) throw p.error;
          else if (p) this.update(m, p.data, settled, machine, worker, log);
          else if (m.method === 'robot.close') {
            const id = this.close(m, machine, worker);
            if (id) later.push(() => removeDocs(this.o.paths.docs, 'robot', id, this.o.log));
          } else if (m.method === 'island.create') this.createIsland(m);
          else if (m.method === 'island.update') this.updateIsland(m, worker, log);
          else if (m.method === 'island.delete') {
            const id = this.deleteIsland(m);
            if (id) later.push(() => removeDocs(this.o.paths.docs, 'island', id, this.o.log));
          }
          // a run was typed on the worker at the time; its mutation is the record of it
        } catch (e) {
          const why = oneLine(e);
          log.error(`${worker}: ${m.method} ${m.id} not applied: ${why}`);
          const id = m.method === 'robot.create' ? m.robot?.id : Id.safeParse(m.params).data?.id;
          const did = DID[m.method];
          if (did && id && Object.hasOwn(this.o.store.state.robots, id)) this.o.store.update((d) => addLine(d.robots[id], notApplied(worker, did, why)));
        }
      },
      after: () => { for (const run of later.splice(0)) run(); },
    };
  }

  /** The robots `machine` started here before its link was synced, since the last call. */
  created(machine: MachineId): string[] {
    const ids = this.made.get(machine) ?? [];
    this.made.delete(machine);
    return ids;
  }

  /** Notes the branch a robot a synced worker started shares with another, once a report has brought its repo. */
  reported(id: string): void {
    if (!this.fresh.has(id) || !this.o.store.state.robots[id]?.repo) return;
    this.fresh.delete(id);
    const line = sharedBranch(this.o.store.state, id, this.o.homedir);
    if (line) this.o.store.update((d) => { d.robots[id].note = withLine(d.robots[id].note, line); });
  }

  private create(m: Mutation, machine: MachineId, worker: string, log: Logger): void {
    const r = m.robot;
    if (!r) throw new Error('it carries no robot');
    if (!isRobotId(r.id)) throw new Error(`${JSON.stringify(r.id)} is not a robot id`);
    if (Object.hasOwn(this.o.store.state.robots, r.id)) return;
    this.o.store.update((d) => {
      const own = Object.hasOwn(d.islands, r.islandId) ? d.islands[r.islandId] : undefined;
      const kept = own && isLand(own, r.cell) && !occupiedCells(d, own.id).has(cellKey(r.cell)) && !blockedCells(d, own.id).has(cellKey(r.cell));
      const island = own && (kept || gives(d, own.id)) ? own : recovered(d, worker);
      // forced, the recovered island takes the robot whatever its neighbours; its own island only when it gives a cell unforced
      const cell = kept ? r.cell : placeOnIsland(d, island.id, undefined, log, true);
      // a folded island comes back to take it, as one given a robot's cell does
      if (kept && island.collapsed) unfold(d, island.id, log);
      const c: Robot = { ...structuredClone(r), machine, islandId: island.id, cell, name: uniqueName(Object.values(d.robots).map((o) => o.name), r.name) };
      // a placed robot's board column is the home's
      delete c.column;
      delete c.columnSource;
      d.robots[r.id] = c;
    });
    if (this.o.synced(machine)) this.fresh.add(r.id);
    else this.made.set(machine, [...(this.made.get(machine) ?? []), r.id]);
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
  private update(m: Mutation, p: ParsedParams<'robot.update'>, settled: Settled | undefined, machine: MachineId, worker: string, log: Logger): void {
    const { robots } = this.o.store.state;
    if (!Object.hasOwn(robots, p.id)) {
      log.info(`${worker}: ${p.id} is closed here; what ${worker} changed of it while this Mac slept is dropped`);
      return;
    }
    const c = robots[p.id];
    if (c.machine !== machine) throw new Error(`it no longer runs on ${worker}`);
    const next: Partial<Pick<Robot, (typeof UPDATE_FIELDS)[number]>> = {};
    const lost: string[] = [];
    for (const k of UPDATE_FIELDS) {
      if (p[k] === undefined) continue;
      const value = k === 'context' ? settled?.items : p[k];
      const changed = !same(value, c[k]);
      const taken = k === 'name' && Object.values(robots).some((o) => o.id !== c.id && o.name.toLowerCase() === p.name!.toLowerCase());
      const here = !same(m.base?.[k], c[k]);
      if (changed && (taken || here)) {
        lost.push(here ? lostLine(worker, k, p[k]) : takenLine(worker, p.name!, 'robot'));
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

  // under the worker's id, so a robot it started on the island lands on it here, and within the limits a call has
  private createIsland(m: Mutation): void {
    const i = m.island;
    if (!i) throw new Error('it carries no island');
    if (!isIslandId(i.id)) throw new Error(`${JSON.stringify(i.id)} is not an island id`);
    if (i.kind === 'home') throw new Error(HOME_HERE);
    if (Object.hasOwn(this.o.store.state.islands, i.id)) return;
    const p = IslandCreate.parse(i);
    if (p.context?.length) throw new Error('it carries a context');
    this.o.store.update((d) => { addIsland(d, p, i.id); });
    const { name } = this.o.store.state.islands[i.id];
    if (name !== i.name) this.renamed.set(i.id, { from: i.name, to: name });
  }

  // as a robot's update, but what the worker's update loses is logged, as an island has no note
  private updateIsland(m: Mutation, worker: string, log: Logger): void {
    const p = IslandUpdate.parse(m.params);
    const { islands } = this.o.store.state;
    if (!Object.hasOwn(islands, p.id)) {
      log.info(`${worker}: island ${p.id} is deleted here; what ${worker} changed of it while this Mac slept is dropped`);
      return;
    }
    const i = islands[p.id];
    if (i.kind === 'home') throw new Error(HOME_HERE);
    const renamed = this.renamed.get(p.id);
    const next: IslandPatch = {};
    const lost: string[] = [];
    for (const k of ISLAND_FIELDS) {
      if (p[k] === undefined) continue;
      const held = k === 'collapsed' ? Boolean(i.collapsed) : i[k];
      if (same(p[k], held)) continue;
      const taken = k === 'name' && Object.values(islands).some((o) => o.id !== i.id && o.name.toLowerCase() === p.name!.toLowerCase());
      const base = k === 'name' && renamed?.from === m.base?.name && renamed?.to === i.name ? i.name : m.base?.[k];
      const here = !same(base, held);
      if (taken || here) lost.push(here ? lostLine(worker, k, p[k]) : takenLine(worker, p.name!, 'island'));
      else Object.assign(next, { [k]: p[k] });
    }
    updateIsland({ store: this.o.store, log }, p.id, next);
    for (const line of lost) log.info(`${worker}: island ${this.o.store.state.islands[p.id].name}: ${line}`);
  }

  // the id of the island that went, for its docs to follow; one with a robot on it here stays
  private deleteIsland(m: Mutation): string | undefined {
    const { id } = Id.parse(m.params);
    // deleted here meanwhile
    if (!Object.hasOwn(this.o.store.state.islands, id)) return undefined;
    dropIsland(this.o.store, id);
    return id;
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
