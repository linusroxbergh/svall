import fs from 'node:fs';
import path from 'node:path';
import jsonpatch, { type Operation } from 'fast-json-patch';
import { FleetState, NewerStateVersion, OlderStateVersion, emptyState, migrateState } from '@svall/protocol';
import { readJsonOrQuarantine, writeJsonAtomic } from './jsonfile.js';
import { sinkHome, trimHome } from './layout.js';

type Listener = (ops: Operation[]) => void;

// the newest copy a newer svalld kept of `file` as this version wrote it, before migrating it
function keptCopy(file: string): string | undefined {
  const prefix = `${path.basename(file)}.v${FleetState.shape.version.value}-`;
  const copies = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(prefix))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
  return copies.length ? path.join(path.dirname(file), copies[copies.length - 1]) : undefined;
}

export class Store {
  private listeners = new Set<Listener>();

  private constructor(private file: string, private current: FleetState, private log: (msg: string) => void) {}

  static load(file: string, log: (msg: string) => void): Store {
    let read;
    try {
      read = readJsonOrQuarantine(file, log,
        (raw) => ({ raw, ...migrateState(raw) }),
        (e) => e instanceof NewerStateVersion || e instanceof OlderStateVersion);
    } catch (e) {
      const kept = e instanceof NewerStateVersion ? keptCopy(file) : undefined;
      if (kept) (e as Error).message += `; or, to go back to the fleet as this version last saw it, move ${kept} to ${file}`;
      throw e;
    }
    if (!read) return new Store(file, emptyState(), log);
    const store = new Store(file, read.state, log);
    if (read.dropped.length) {
      const kept = `${file}.broken-${Date.now()}`;
      fs.copyFileSync(file, kept);
      log(`state.json: left out ${read.dropped.join('; ')}; the file as read is kept at ${kept}`);
    }
    if (read.migrated) {
      // the file as it was read stays beside the migrated one, so a downgrade has something to go back to
      const old = (read.raw as { version?: number } | null)?.version;
      const kept = `${file}.v${old}-${Date.now()}`;
      fs.copyFileSync(file, kept);
      log(`state.json migrated to version ${read.state.version}; version ${old} kept at ${kept}`);
    }
    if (read.migrated || read.dropped.length) store.persist();
    return store;
  }

  get state(): FleetState {
    return this.current;
  }

  update(mutate: (draft: FleetState) => void): Operation[] {
    const next = structuredClone(this.current);
    mutate(next);
    // the shape rules the map depends on, kept wherever the fleet changes: mission control is its floor, and no wider than its crew needs
    sinkHome(next);
    trimHome(next);
    const ops = jsonpatch.compare(this.current, next);
    if (ops.length === 0) return ops;
    // written before it is taken: a write that fails leaves the fleet as every listener last saw it
    writeJsonAtomic(this.file, next);
    this.current = next;
    for (const l of this.listeners) {
      try { l(ops); } catch (err) { this.log(`store listener failed: ${String(err)}`); }
    }
    return ops;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private persist(): void {
    writeJsonAtomic(this.file, this.current);
  }
}
