import { availableParallelism } from 'node:os';
import type { LoadChar, LoadSnapshot, LoadUsage } from '@svall/protocol';
import { attribute, type Scope } from './attribute.js';
import type { LiveProc } from './procs.js';

export type SamplerDeps = {
  read: () => Promise<LiveProc[]>;
  scope: (procs: LiveProc[]) => Promise<Scope>;
  sleepable: (id: string, procs: LiveProc[]) => boolean;
  now?: () => number;
  everyMs?: number;
  leaseMs?: number;
  firstGapMs?: number;
};

type Reading = { at: number; procs: LiveProc[] };

/** Samples the process table every few seconds while someone keeps asking, and idles otherwise. */
export class LoadSampler {
  private readonly now: () => number;
  private readonly everyMs: number;
  private readonly leaseMs: number;
  private readonly firstGapMs: number;
  private prev?: Reading;
  private snap?: LoadSnapshot;
  private failed?: Error;
  private starting?: Promise<LoadSnapshot>;
  private timer?: ReturnType<typeof setInterval>;
  private until = 0;
  private gen = 0;
  private busy = false;

  constructor(private d: SamplerDeps) {
    this.now = d.now ?? Date.now;
    this.everyMs = d.everyMs ?? 4000;
    this.leaseMs = d.leaseMs ?? 10_000;
    this.firstGapMs = d.firstGapMs ?? 500;
  }

  // a sample that failed is what the asker hears of, until one succeeds; the last reading stays for the next
  get(): Promise<LoadSnapshot> {
    this.until = this.now() + this.leaseMs;
    if (this.failed) return Promise.reject(this.failed);
    if (this.snap) return Promise.resolve(this.snap);
    const starting = (this.starting ??= this.begin().finally(() => { if (this.starting === starting) this.starting = undefined; }));
    return starting;
  }

  // readings still in flight are dropped by the generation they began under
  stop(): void {
    this.gen++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.prev = this.snap = this.failed = this.starting = undefined;
    this.busy = false;
  }

  private async begin(): Promise<LoadSnapshot> {
    const gen = this.gen;
    const procs = await this.d.read();
    if (gen === this.gen) this.prev = { at: this.now(), procs };
    await new Promise((r) => setTimeout(r, this.firstGapMs));
    const snap = await this.sample(gen, this.prev ?? { at: this.now(), procs });
    if (gen === this.gen) {
      this.timer = setInterval(() => {
        if (this.now() >= this.until) return this.stop();
        if (this.busy) return;
        this.busy = true;
        this.sample(gen, this.prev!).catch((e: Error) => { if (gen === this.gen) this.failed = e; }).finally(() => { if (gen === this.gen) this.busy = false; });
      }, this.everyMs);
    }
    return snap;
  }

  private async sample(gen: number, prev: Reading): Promise<LoadSnapshot> {
    const procs = await this.d.read();
    const at = this.now();
    if (gen === this.gen) this.prev = { at, procs };
    const before = new Map(prev.procs.map((p) => [p.pid, p]));
    const elapsedNs = Math.max(at - prev.at, 1) * 1e6;
    // ps rows carry no start time, so a zero start matches any
    const gained = (p: LiveProc): number => {
      const old = before.get(p.pid);
      const same = old && (old.start === 0 || p.start === 0 || old.start === p.start);
      return Math.max(p.cpuNs - (same ? old.cpuNs : 0), 0);
    };
    const usage = (ps: LiveProc[]): LoadUsage => ({
      cpu: ps.reduce((s, p) => s + gained(p), 0) / elapsedNs * 100,
      mem: ps.reduce((s, p) => s + p.mem, 0),
      procs: ps.length,
    });

    const scope = await this.d.scope(procs);
    const owners = attribute(procs, scope);
    const chars: Record<string, LoadChar> = {};
    for (const [id, ps] of owners.chars) {
      if (!ps.length) continue;
      const panes = new Set(scope.panes.get(id));
      chars[id] = { ...usage(ps), shellOnly: ps.every((p) => panes.has(p.pid)), sleepable: this.d.sleepable(id, procs) };
    }
    const app = usage(owners.app);
    const codex = owners.codex.length ? usage(owners.codex) : undefined;
    const parts = [app, ...(codex ? [codex] : []), ...Object.values(chars)];
    const total = { cpu: parts.reduce((s, u) => s + u.cpu, 0), mem: parts.reduce((s, u) => s + u.mem, 0), procs: parts.reduce((s, u) => s + u.procs, 0) };
    const snap = { at, cores: availableParallelism(), total, app, ...(codex ? { codex } : {}), chars };
    if (gen === this.gen) { this.snap = snap; this.failed = undefined; }
    return snap;
  }
}
