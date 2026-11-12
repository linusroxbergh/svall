import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ApiError, REPORT_MS, Sha256, type AgentKind, type MachineId, type SetupRow } from '@svall/protocol';
import { readEnvFile, VAR_NAME } from '../claude.js';
import { envValueFault, writeEnvVar } from '../env-file.js';
import { lockAgentFiles } from '../kernel-lock.js';
import { clean, holds } from '../path-tools.js';
import { relocate } from './relocate.js';
import type { WorkerLink } from '../link/home.js';
import type { HomeConnection } from '../link/worker.js';
import type { Logger } from '../log.js';
import { homeWord, machineWord } from '../machine.js';
import { fileSha } from './bundle.js';
import { applyMirror, dropBlobs, type Manifest } from './mirror-apply.js';
import { readPlugins, readServers, secretsOf } from './mirror-config.js';
import { CONFIG_ITEMS, itemKey, readConsent, replaceConsent, setConsent } from './mirror-consent.js';
import { holdsSetup, mirrorPlan, packMirror, readyToPush, tickedWhole } from './mirror-plan.js';
import { ConfigReport, configReport, forRobot, ReportAsk, reportAsk, setupRows } from './mirror-report.js';
import { configState, OPENCODE_FILES, readState, StateAsk, WorkerFacts, type MirrorHomes } from './mirror-state.js';
import { unpack } from './move-steps.js';

// unpacking and applying a mirror of several trees at their limit
const APPLY_MS = 2 * 60_000;

const Offer = z.object({ id: z.string(), sha256: Sha256 });
const EnvSet = z.object({ name: z.string().regex(VAR_NAME), value: z.string().min(1).max(4096) });
const Apply = z.object({ id: z.string(), seq: z.number().int().positive() });

/** What a push needs of the link to the machine it writes: a home's to a worker, or, `copy`, a worker's to its home as a person asks. */
export type MirrorLink = { machine: MachineId; call: WorkerLink['call']; sendBlob(id: string, file: string): Promise<void>; copy?: true };
export type Pushed = { sent: number; backup?: string; replaced?: string[]; left?: string[] };

/** Where a push onto this machine keeps what it replaces of a person's own: a Mac, or a machine that dials its home, holds one. It is asked of the machine itself, as the record a home keeps of it says what was typed at its enrolment. */
export const backupsHere = (folder: string, worker?: { homeSsh?: string }, platform: NodeJS.Platform = process.platform): string | undefined =>
  (platform === 'darwin' || worker?.homeSsh ? folder : undefined);

/** The sender's side: its agent configuration packed and sent to a target, by what the consent file ticks for it. */
export class Mirror {
  // each worker's last push, which its next one waits for
  private chains = new Map<MachineId, Promise<unknown>>();
  // each worker's last push sequence, which its next one goes above
  private sent = new Map<MachineId, number>();

  /** `overridesThere`: the fleet's overrides folder on a worker, as its rows name it. */
  /** `envFile`: the fleet's .env on this Mac, one place a variable may be copied to a worker from. */
  constructor(private o: MirrorHomes & { consent: string; log: Logger; overridesThere?: (machine: MachineId) => string; envFile?: string }) {}

  /** Resolves once the worker has applied what `link` carried; pushes to one worker go one at a time, in order. */
  push(link: MirrorLink): Promise<Pushed> {
    return this.inTurn(link.machine, () => this.pushNow(link));
  }

  /** Runs `run` in turn with the pushes to `machine`: after those begun so far, and before any begun later. */
  inTurn<T>(machine: MachineId, run: () => Promise<T>): Promise<T> {
    const turn = (this.chains.get(machine) ?? Promise.resolve()).then(run);
    this.chains.set(machine, turn.catch(() => {}));
    return turn;
  }

  /** Resolves once every push to `machine` begun so far has ended, applied or not. */
  settled(machine: MachineId): Promise<unknown> {
    return this.chains.get(machine) ?? Promise.resolve();
  }

  /** Whether this machine holds an agent setup of a person's making. */
  holdsSetup(): boolean {
    return holdsSetup(mirrorPlan(this.o));
  }

  /** Ticks `fields` of `item` for `machine`, or, `on` false, unticks every field of it, or with `exact` those `fields`. */
  consent(machine: MachineId, item: string, fields: string[], on: boolean, exact = false): void {
    const consent = readConsent(this.o.consent, machine);
    const whole = readServers(this.o, readPlugins(this.o.claudeDir, [])).servers.find((s) => itemKey(s) === item && tickedWhole(s, consent));
    if (whole) replaceConsent(this.o.consent, machine, item, [...new Set(secretsOf(whole).map((f) => f.field))]);
    setConsent(this.o.consent, machine, item, fields, on, exact);
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
   * The setup rows of the mirror to `machine`, in the caller's names: what its next push carries, and what the worker holds and runs while linked.
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
    const stale = link?.mismatch() !== undefined;
    const name = machineWord(machine, o.name);
    const unchecked = stale ? `not checked: ${name} runs another release` : `not checked: ${name} is not reachable`;
    const r = o.robot;
    const shown = r ? forRobot(plan, { agents: r.agents, folders: r.folders.map((f) => (r.home ? relocate(f, { from: r.home, to: this.o.homedir }) : f)) }) : plan;
    return setupRows(shown, report, { machine: name, fleetFlag: o.fleetFlag, unchecked, stale, overrides: this.o.overridesThere?.(machine) ?? '~/.svall/mirror-overrides', here: this.hereHas(), apt: facts?.platform === 'linux', mac: facts?.platform === 'darwin' });
  }

  /** Whether this Mac has a variable to copy to a worker: in the daemon's own environment, or the fleet's .env here. */
  hereHas(): (name: string) => boolean {
    const env = this.o.envFile ? readEnvFile(this.o.envFile) : {};
    return (name) => Boolean(process.env[name] || env[name]);
  }

  /** The value this Mac has for a variable, from where `hereHas` looks; none when it has none. */
  hereValue(name: string): string | undefined {
    return process.env[name] || (this.o.envFile ? readEnvFile(this.o.envFile)[name] : undefined) || undefined;
  }

  // the Mac's project folders that hold servers
  private projects(): string[] {
    return [...new Set(readServers(this.o, []).servers.flatMap((s) => (typeof s.scope === 'object' && 'project' in s.scope ? [s.scope.project] : [])))];
  }

  private async pushNow(link: MirrorLink): Promise<Pushed> {
    const facts = WorkerFacts.parse(await link.call('config.state', { homedir: this.o.homedir, projects: this.projects() }));
    const plan = mirrorPlan(this.o, readConsent(this.o.consent, link.machine), facts);
    // a source with no setup yet has nothing of its own to give, and what `svall setup` left here must not go over what a target holds ahead of a seed
    if (facts.keeps && facts.state.applied === undefined && !(link.copy ? holdsSetup(plan) : readyToPush(plan))) {
      if (!link.copy && holdsSetup(plan)) this.o.log.info(`mirror: ${plan.unreadable.join(', ')} cannot be read, and the first push onto a machine that keeps its own setup waits until it can`);
      return { sent: 0 };
    }
    for (const line of plan.skipped) this.o.log.info(`mirror: ${line}; it stays on ${homeWord()}`);
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
      const { backup, replaced, left } = await link.call<Omit<Pushed, 'sent'>>('config.apply', { id, seq }, { timeoutMs: APPLY_MS });
      return { sent, ...(backup && { backup }), ...(replaced && { replaced }), ...(left && { left }) };
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
  overrides: string; stage: string; stateFile: string; varsFile: string; envFile: string; connection: Pick<HomeConnection, 'receiveBlob'>; log: Logger; backups?: string; additive?: boolean; refuse?: (m: Manifest, files: string[]) => void; platform?: NodeJS.Platform;
}): { calls: Record<string, (raw: unknown) => Promise<unknown>>; linkLost(): void; failed(): string | undefined } {
  let failed: string | undefined;
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
    // a variable for the fleet's robots here, into its .env as svall worker env writes it; the value is never logged
    'env.set': async (raw) => {
      const { name, value } = parse(EnvSet, raw);
      const fault = envValueFault(value);
      if (fault) throw new ApiError('invalid_params', fault);
      writeEnvVar(o.envFile, name, value);
      return {};
    },
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
      if (!b) throw new ApiError('not_found', `no agent setup ${id} came here`);
      b.applying = true;
      // the home stops waiting after APPLY_MS
      const late = setTimeout(() => b.abandon.abort(new ApiError('abandoned', 'the home gave up on this agent setup before it was applied')), APPLY_MS);
      try {
        if ((await b.got).sha256 !== b.sha256) throw new Error('the agent setup did not arrive as it left');
        await unpack(path.join(b.dir, 'mirror.tar'), path.join(b.dir, 'blob'));
        const unlock = await lockAgentFiles(o.homedir, b.abandon.signal);
        let done: Awaited<ReturnType<typeof applyMirror>>;
        try {
          // an older push would put back what a later one took away
          const last = readState(o.stateFile).applied;
          if (last !== undefined && seq <= last) throw new ApiError('stale', `push ${seq} of the agent setup came after push ${last}, which this machine applied`);
          done = await applyMirror(path.join(b.dir, 'blob'), { ...o, seq });
        } finally { unlock(); }
        if (done.written.length || done.removed.length) o.log.info(`mirror: ${done.written.length} files of the home's agent setup written, ${done.removed.length} removed`);
        failed = undefined;
        return done;
      } catch (e) {
        failed = (e as Error).message;
        throw e;
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
      if (b.applying) b.abandon.abort(new ApiError('abandoned', 'the link closed before this agent setup was applied'));
      else drop(id);
    }
  };
  return { calls, linkLost, failed: () => failed };
}
