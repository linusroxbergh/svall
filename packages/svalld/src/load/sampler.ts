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

const key = (p: LiveProc): string => `${p.pid}:${p.start}`;

/** Samples the process table every few seconds while someone keeps asking, and idles otherwise. */
export class LoadSampler {
  private readonly now: () => number;
  private readonly everyMs: number;
  private readonly leaseMs: number;
  private readonly firstGapMs: number;
  private prev?: Reading;
  private snap?: LoadSnapshot;
  private starting?: Promise<LoadSnapshot>;
  private timer?: ReturnType<typeof setInterval>;
  private until = 0;

  constructor(private d: SamplerDeps) {
    this.now = d.now ?? Date.now;
    this.everyMs = d.everyMs ?? 4000;
    this.leaseMs = d.leaseMs ?? 10_000;
    this.firstGapMs = d.firstGapMs ?? 500;
  }

  get(): Promise<LoadSnapshot> {
    this.until = this.now() + this.leaseMs;
    if (this.snap) return Promise.resolve(this.snap);
    return (this.starting ??= this.begin().finally(() => { this.starting = undefined; }));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.prev = this.snap = undefined;
  }

  private async begin(): Promise<LoadSnapshot> {
    this.prev = { at: this.now(), procs: await this.d.read() };
    await new Promise((r) => setTimeout(r, this.firstGapMs));
    const snap = await this.sample();
    this.timer = setInterval(() => {
      if (this.now() >= this.until) return this.stop();
      this.sample().catch(() => {});
    }, this.everyMs);
    return snap;
  }

  private async sample(): Promise<LoadSnapshot> {
    const procs = await this.d.read();
    const at = this.now();
    const prev = this.prev!;
    this.prev = { at, procs };
    const before = new Map(prev.procs.map((p) => [key(p), p.cpuNs]));
    const elapsedNs = Math.max(at - prev.at, 1) * 1e6;
    const usage = (ps: LiveProc[]): LoadUsage => ({
      cpu: ps.reduce((s, p) => s + Math.max(p.cpuNs - (before.get(key(p)) ?? 0), 0), 0) / elapsedNs * 100,
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
    return (this.snap = { at, total, app, ...(codex ? { codex } : {}), chars });
  }
}
