import fs from 'node:fs';
import path from 'node:path';
import jsonpatch, { type Operation } from 'fast-json-patch';
import { Character, FleetState, NewerStateVersion, OlderStateVersion, emptyState, migrateState } from '@svall/protocol';
import { readJsonOrQuarantine } from './jsonfile.js';
import { sinkHome, trimHome } from './layout.js';
import { cleanupDurableTemps, syncDir, writeDurable } from './handover/durable.js';
import { variant } from './runtime.js';

type Listener = (ops: Operation[]) => void;

// state.json is written at most this often, so a burst of changes reaches the disk as one write
const WRITE_EVERY_MS = 250;

// the newest copy a newer svalld kept of `file` as this version wrote it, before migrating it
function keptCopy(file: string): string | undefined {
  const prefix = `${path.basename(file)}.v${FleetState.shape.version.value}-`;
  const copies = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(prefix))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
  return copies.length ? path.join(path.dirname(file), copies[copies.length - 1]) : undefined;
}

export class Store {
  private listeners = new Set<Listener>();
  private writing?: NodeJS.Timeout;
  // a change not yet on disk
  private dirty = false;
  private batching: () => boolean = () => false;

  private constructor(private file: string, private current: FleetState, private log: (msg: string) => void) {}

  static load(file: string, log: (msg: string) => void): Store {
    cleanupDurableTemps(path.dirname(file));
    let read;
    try {
      read = readJsonOrQuarantine(file, log,
        (raw) => ({ raw, ...migrateState(raw) }),
        (e) => e instanceof NewerStateVersion || e instanceof OlderStateVersion);
    } catch (e) {
      if (e instanceof NewerStateVersion) e.message += ` (${variant === 'release' ? 'Svall → Check for Updates…' : 'git pull && pnpm desktop:install'})`;
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
    if (read.migrated || read.dropped.length) store.persist(read.state);
    return store;
  }

  get state(): FleetState {
    return this.current;
  }

  update(mutate: (draft: FleetState) => void): Operation[] {
    const next = structuredClone(this.current);
    mutate(next);
    // the shape rules the map depends on, kept wherever the fleet changes: mission control is its floor, and no wider than its crew needs and a spare slot
    sinkHome(next);
    trimHome(next);
    const ops = jsonpatch.compare(this.current, next);
    if (ops.length === 0) return ops;
    // a character without what the schema requires breaks whatever reads the fleet, so none is written
    const touched = new Set(ops.filter((o) => o.path.startsWith('/characters/')).map((o) => jsonpatch.unescapePathComponent(o.path.split('/')[2])));
    for (const id of touched) {
      const bad = next.characters[id] && Character.safeParse(next.characters[id]).error;
      if (bad) throw new Error(`character ${id} would not be valid: ${bad.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    if (!this.batching()) {
      this.commit(next, ops);
      return ops;
    }
    // taken at once and written soon after: a crash loses at most the last WRITE_EVERY_MS of changes
    this.dirty = true;
    this.writing ??= setTimeout(() => this.flush(), WRITE_EVERY_MS);
    this.notify(next, ops);
    return ops;
  }

  /** Batches the writes while `when` holds, as for a fleet no handover is moving; otherwise each change is on disk before it is taken. */
  batchWritesWhile(when: () => boolean): void {
    this.batching = when;
  }

  /** Validates a prepared snapshot without making it the active state. */
  static readSnapshot(file: string): FleetState {
    return FleetState.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  /**
   * Makes a prepared file the active state once the gateway has committed the transaction: renamed into
   * place, both directories synced, then published as it is on disk rather than written again.
   */
  promote(preparedFile: string): Operation[] {
    const next = Store.readSnapshot(preparedFile);
    fs.renameSync(preparedFile, this.file);
    syncDir(path.dirname(this.file));
    syncDir(path.dirname(preparedFile));
    return this.publish(next);
  }

  /** Publishes what state.json holds, for a promotion whose rename landed before this process published it. */
  reload(): Operation[] {
    return this.publish(Store.readSnapshot(this.file));
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Writes what has changed since the last write that went through; a write that fails is logged and tried again by
   *  the next change or flush. */
  flush(): void {
    clearTimeout(this.writing);
    this.writing = undefined;
    if (!this.dirty) return;
    // a fleet home that is gone stays gone
    try {
      if (!fs.existsSync(path.dirname(this.file))) throw new Error(`${path.dirname(this.file)} is gone`);
      this.persist(this.current);
    } catch (e) { this.log(`state.json not written: ${String(e)}`); }
  }

  // on disk before any listener runs, so a viewer never sees a patch the next start would disagree with,
  // and a write that fails leaves the fleet as every listener last saw it
  private commit(next: FleetState, ops: Operation[]): void {
    this.persist(next);
    this.notify(next, ops);
  }

  // what is published is what state.json now holds
  private publish(next: FleetState): Operation[] {
    clearTimeout(this.writing);
    this.writing = undefined;
    this.dirty = false;
    const ops = jsonpatch.compare(this.current, next);
    this.notify(next, ops);
    return ops;
  }

  private notify(next: FleetState, ops: Operation[]): void {
    this.current = next;
    for (const l of this.listeners) {
      try { l(ops); } catch (err) { this.log(`store listener failed: ${String(err)}`); }
    }
  }

  private persist(state: FleetState): void {
    writeDurable(this.file, state, { mode: 0o600 });
    clearTimeout(this.writing);
    this.writing = undefined;
    this.dirty = false;
  }
}
