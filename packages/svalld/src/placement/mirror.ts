import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ApiError, REPORT_MS, Sha256, type AgentKind, type MachineId, type SetupRow } from '@svall/protocol';
import { lockAgentFiles } from '../kernel-lock.js';
import { clean, holds } from '../path-tools.js';
import { relocate } from './relocate.js';
import type { WorkerLink } from '../link/home.js';
import type { HomeConnection } from '../link/worker.js';
import type { Logger } from '../log.js';
import { fileSha } from './bundle.js';
import { applyMirror, dropBlobs } from './mirror-apply.js';
import { readPlugins, readServers } from './mirror-config.js';
import { CONFIG_ITEMS, readConsent, setConsent } from './mirror-consent.js';
import { mirrorPlan, packMirror } from './mirror-plan.js';
import { ConfigReport, configReport, forRobot, ReportAsk, reportAsk, setupRows } from './mirror-report.js';
import { configState, OPENCODE_FILES, readState, StateAsk, WorkerFacts, type MirrorHomes } from './mirror-state.js';
import { unpack } from './move-steps.js';

// unpacking and applying a mirror of several trees at their limit
const APPLY_MS = 2 * 60_000;

const Offer = z.object({ id: z.string(), sha256: Sha256 });
const Apply = z.object({ id: z.string(), seq: z.number().int().positive() });

/** The home's side: its agent configuration packed and sent to a worker, by what the consent file ticks for it. */
export class Mirror {
  // each worker's last push, which its next one waits for
  private chains = new Map<MachineId, Promise<unknown>>();
  // each worker's last push sequence, which its next one goes above
  private sent = new Map<MachineId, number>();

  /** `overridesThere`: the fleet's overrides folder on a worker, as its rows name it. */
  constructor(private o: MirrorHomes & { consent: string; log: Logger; overridesThere?: string }) {}

  /** Resolves once the worker has applied what `link` carried; pushes to one worker go one at a time, in order. */
  push(link: Pick<WorkerLink, 'call' | 'sendBlob' | 'machine'>): Promise<{ sent: number }> {
    const run = (this.chains.get(link.machine) ?? Promise.resolve()).then(() => this.pushNow(link));
    this.chains.set(link.machine, run.catch(() => {}));
    return run;
  }

  /** Resolves once every push to `machine` begun so far has ended, applied or not. */
  settled(machine: MachineId): Promise<unknown> {
    return this.chains.get(machine) ?? Promise.resolve();
  }

  /** Ticks `fields` of `item` for `machine`, or, `on` false, unticks every field of it. */
  consent(machine: MachineId, item: string, fields: string[], on: boolean): void {
    setConsent(this.o.consent, machine, item, fields, on);
  }

  /** The file of this Mac that holds `item` and cannot be read now, which leaves the item on a worker as the mirror last wrote it. */
  unreadFile(item: string): string | undefined {
    const o = this.o;
    const plugin = /^claude:plugin:(.+?)(?::mcp:.*)?$/.exec(item)?.[1];
    const installs = plugin === undefined ? [] : readPlugins(o.claudeDir, []).filter((p) => p.name === plugin);
    const holdsItem = (f: string): boolean => {
      if (/^claude:(agent|marketplace):/.test(item)) return false;
      if (plugin !== undefined) return f === path.join(o.claudeDir, 'plugins/installed_plugins.json') || installs.some((i) => holds(clean(i.installPath), f) || i.unreadMarket === f);
      if (item === CONFIG_ITEMS.settings) return f === path.join(o.claudeDir, 'settings.json');
      if (item.startsWith('claude:')) return f === o.claudeJson;
      if (item.startsWith('codex:')) return f === path.join(o.codexDir, 'config.toml');
      return item.startsWith('opencode:') && OPENCODE_FILES.some((n) => f === path.join(o.opencodeDir, n));
    };
    return mirrorPlan(o).unreadable.find(holdsItem);
  }

  /**
   * The setup rows of the mirror to `machine`: what its next push carries, and what the worker holds and runs while linked.
   * `o.robot` narrows them to a robot's agents and folders, which lie under `home` on the worker.
   */
  async report(
    link: Pick<WorkerLink, 'call' | 'connected' | 'mismatch'> | undefined, machine: MachineId,
    o: { name: string; fleetFlag: string; robot?: { agents: AgentKind[]; folders: string[]; home?: string } },
  ): Promise<SetupRow[]> {
    const ask = async <T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T | undefined> => {
      if (!link?.connected()) return undefined;
      try {
        return schema.parse(await link.call(method, params, { timeoutMs: REPORT_MS }));
      } catch (e) {
        this.o.log.error(`mirror: ${o.name} did not answer ${method}: ${(e as Error).message}`);
        return undefined;
      }
    };
    const facts = await ask('config.state', { homedir: this.o.homedir, projects: this.projects() }, WorkerFacts);
    const plan = mirrorPlan(this.o, readConsent(this.o.consent, machine), facts);
    // a worker that did not answer the first is not asked again
    const report = facts && await ask('config.report', reportAsk(plan), ConfigReport);
    const unchecked = link?.mismatch() ? `not checked: ${o.name} runs another release; upgrade it` : `not checked: ${o.name} is not reachable`;
    const r = o.robot;
    const shown = r ? forRobot(plan, { agents: r.agents, folders: r.folders.map((f) => (r.home ? relocate(f, { from: r.home, to: this.o.homedir }) : f)) }) : plan;
    return setupRows(shown, report, { machine: o.name, fleetFlag: o.fleetFlag, unchecked, overrides: this.o.overridesThere ?? '~/.svall/mirror-overrides' });
  }

  // the Mac's project folders that hold servers
  private projects(): string[] {
    return [...new Set(readServers(this.o, []).servers.flatMap((s) => (typeof s.scope === 'object' && 'project' in s.scope ? [s.scope.project] : [])))];
  }

  private async pushNow(link: Pick<WorkerLink, 'call' | 'sendBlob' | 'machine'>): Promise<{ sent: number }> {
    const facts = WorkerFacts.parse(await link.call('config.state', { homedir: this.o.homedir, projects: this.projects() }));
    const plan = mirrorPlan(this.o, readConsent(this.o.consent, link.machine), facts);
    for (const line of plan.skipped) this.o.log.info(`mirror: ${line}; it stays on this Mac`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-mirror-'));
    try {
      const file = path.join(dir, 'mirror.tar');
      const { sent } = await packMirror(plan, file, facts.state);
      const id = `mirror_${crypto.randomUUID()}`;
      await link.call('config.blob', { id, sha256: await fileSha(file) });
      await link.sendBlob(id, file);
      // above any push this home gave up on, which the worker may still be applying
      const seq = Math.max(this.sent.get(link.machine) ?? 0, facts.state.applied ?? 0) + 1;
      this.sent.set(link.machine, seq);
      await link.call('config.apply', { id, seq }, { timeoutMs: APPLY_MS });
      return { sent };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

const parse = <T>(schema: z.ZodType<T>, raw: unknown): T => {
  const p = schema.safeParse(raw);
  if (!p.success) throw new ApiError('invalid_params', z.prettifyError(p.error));
  return p.data;
};

/**
 * A worker's side. `config.apply` refuses a push whose `seq` is not above the last applied, and gives up one abandoned before it
 * held the agent files; a blob may hold ticked keys, so none outlasts the link it came over or the daemon that took it.
 */
export function mirrorCalls(o: MirrorHomes & {
  overrides: string; stage: string; stateFile: string; varsFile: string; envFile: string; connection: Pick<HomeConnection, 'receiveBlob'>; log: Logger;
}): { calls: Record<string, (raw: unknown) => Promise<unknown>>; linkLost(): void } {
  const blobs = new Map<string, { dir: string; sha256: string; got: Promise<{ sha256: string }>; applying?: true; abandon: AbortController }>();
  const drop = (id: string): void => {
    const b = blobs.get(id);
    blobs.delete(id);
    if (b) fs.rmSync(b.dir, { recursive: true, force: true });
  };
  dropBlobs(o.stage);
  const calls: Record<string, (raw: unknown) => Promise<unknown>> = {
    'config.state': async (raw) => configState(parse(StateAsk, raw), o),
    'config.report': async (raw) => configReport(parse(ReportAsk, raw), o),
    'config.blob': async (raw) => {
      const { id, sha256 } = parse(Offer, raw);
      fs.mkdirSync(o.stage, { recursive: true });
      const dir = fs.mkdtempSync(path.join(o.stage, 'mirror-'));
      const got = o.connection.receiveBlob(id, path.join(dir, 'mirror.tar'));
      // a link that closes before the apply leaves nothing behind
      got.catch(() => drop(id));
      blobs.set(id, { dir, sha256, got, abandon: new AbortController() });
      return { ready: true };
    },
    'config.apply': async (raw) => {
      const { id, seq } = parse(Apply, raw);
      const b = blobs.get(id);
      if (!b) throw new ApiError('not_found', `no agent configuration ${id} came here`);
      b.applying = true;
      // the home stops waiting after APPLY_MS
      const late = setTimeout(() => b.abandon.abort(new ApiError('abandoned', 'the home gave up on this agent configuration before it was applied')), APPLY_MS);
      try {
        if ((await b.got).sha256 !== b.sha256) throw new Error('the agent configuration did not arrive as it left');
        await unpack(path.join(b.dir, 'mirror.tar'), path.join(b.dir, 'blob'));
        const unlock = await lockAgentFiles(o.homedir, b.abandon.signal);
        let done: { written: string[]; removed: string[] };
        try {
          // an older push would put back what a later one took away
          const last = readState(o.stateFile).applied;
          if (last !== undefined && seq <= last) throw new ApiError('stale', `push ${seq} of the agent configuration came after push ${last}, which this machine applied`);
          done = await applyMirror(path.join(b.dir, 'blob'), { ...o, seq });
        } finally { unlock(); }
        if (done.written.length || done.removed.length) o.log.info(`mirror: ${done.written.length} files of the home's agent configuration written, ${done.removed.length} removed`);
        return done;
      } finally {
        clearTimeout(late);
        blobs.delete(id);
        // the next start removes it; the apply's answer stands
        await fsp.rm(b.dir, { recursive: true, force: true }).catch((e: Error) => o.log.error(`mirror: ${b.dir} was not removed: ${e.message}`));
      }
    },
  };
  // one being applied is given up unless it holds the agent files already, and goes once it ends
  const linkLost = (): void => {
    for (const [id, b] of blobs) {
      if (b.applying) b.abandon.abort(new ApiError('abandoned', 'the link closed before this agent configuration was applied'));
      else drop(id);
    }
  };
  return { calls, linkLost };
}
