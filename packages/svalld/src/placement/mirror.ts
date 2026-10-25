import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ApiError, Sha256 } from '@svall/protocol';
import { writeDurable } from '../handover/durable.js';
import { clean, holds } from '../handover/portable-path.js';
import { relocate } from '../handover/relocate.js';
import type { WorkerLink } from '../link/home.js';
import type { HomeConnection } from '../link/worker.js';
import type { Logger } from '../log.js';
import { realPath } from '../paths.js';
import { readJsonSettings, same } from '../settings-file.js';
import { isCredential, packTar } from './bundle.js';
import { filesIn } from './docs-sync.js';
import { fileSha, unpack } from './move.js';

export const MIRROR_FILE_MAX = 5 * 1024 * 1024;
const MIRROR_TREE_MAX = 200 * 1024 * 1024;

/** Where a machine keeps what the mirror carries; `agentProfiles` is the fleet home's. */
export type MirrorHomes = { claudeDir: string; codexDir: string; homedir: string; agentProfiles?: string };
/** Each file by where it lands: `to` starts with its home (`claude`, `codex`, `home` or `profiles`) and goes on under it. */
export type MirrorPlan = { files: { from: string; to: string; mode: number }[]; settings: Record<string, unknown>; skipped: string[] };

const ROOTS = { claude: 'claudeDir', codex: 'codexDir', home: 'homedir', profiles: 'agentProfiles' } as const;
type Root = keyof typeof ROOTS;
// the worker's `svall setup` writes these, which on the Mac name the app bundle
const WORKER_OWNED = ['hooks', 'statusLine'];
// a settings value under a key named so is a path, which lands by home
const PATH_KEY = /(Path|Dir|cwd)$/;
const MANIFEST = 'mirror.json';
const Manifest = z.object({ homedir: z.string(), claudeDir: z.string(), settings: z.record(z.string(), z.unknown()) });
const Offer = z.object({ id: z.string(), sha256: Sha256 });

const statOf = (file: string): fs.Stats | undefined => {
  try { return fs.statSync(file); } catch { return undefined; }
};

type Found = { file: string; rel: string; size: number; mode: number };

// the plain files under `dir`, links followed, less version control and anything named like a credential; a file over
// the limit is named in `skipped`
function walk(dir: string, skipped: string[], rel = '', seen = new Set<string>()): Found[] {
  let names: string[];
  try {
    const real = fs.realpathSync(dir);
    if (seen.has(real)) return [];
    seen.add(real);
    names = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  const found: Found[] = [];
  for (const name of names) {
    if (name === '.git' || name === '.credentials.json' || isCredential(name)) continue;
    const file = path.join(dir, name);
    const st = statOf(file);
    if (st?.isDirectory()) found.push(...walk(file, skipped, path.posix.join(rel, name), seen));
    else if (st?.isFile() && st.size > MIRROR_FILE_MAX) skipped.push(`${file} is over ${MIRROR_FILE_MAX / 2 ** 20} MB`);
    else if (st?.isFile()) found.push({ file, rel: path.posix.join(rel, name), size: st.size, mode: st.mode & 0o777 });
  }
  return found;
}

// Claude's settings less what the worker owns; settings that cannot be read carry none
function claudeSettings(dir: string, skipped: string[]): Record<string, unknown> {
  const file = path.join(dir, 'settings.json');
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') skipped.push(`${file} cannot be read: ${(e as Error).message}`);
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    skipped.push(`${file} holds no settings object`);
    return {};
  }
  const settings: Record<string, unknown> = { ...parsed };
  for (const k of WORKER_OWNED) delete settings[k];
  return settings;
}

/**
 * What the home's agent configuration mirror carries: Claude's CLAUDE.md, skills, rules, agents, commands, keybindings
 * and settings, Codex's AGENTS.md, ~/.agents/skills and the fleet's agent profiles. Logins, plugins and ~/.claude.json
 * never travel; a file over 5 MB or a tree over 200 MB is skipped with a line in `skipped`.
 */
export function mirrorPlan(o: MirrorHomes): MirrorPlan {
  const files: MirrorPlan['files'] = [];
  const skipped: string[] = [];
  const tree = (root: Root, top: string, under: string): void => {
    const found = walk(top, skipped);
    if (found.reduce((n, f) => n + f.size, 0) > MIRROR_TREE_MAX) {
      skipped.push(`${top} is over ${MIRROR_TREE_MAX / 2 ** 20} MB`);
      return;
    }
    for (const f of found) files.push({ from: f.file, to: path.posix.join(root, under, f.rel), mode: f.mode });
  };
  const one = (root: Root, dir: string, name: string): void => {
    const from = path.join(dir, name);
    const st = statOf(from);
    if (st?.isFile() && st.size > MIRROR_FILE_MAX) skipped.push(`${from} is over ${MIRROR_FILE_MAX / 2 ** 20} MB`);
    else if (st?.isFile()) files.push({ from, to: path.posix.join(root, name), mode: st.mode & 0o777 });
  };
  one('claude', o.claudeDir, 'CLAUDE.md');
  one('claude', o.claudeDir, 'keybindings.json');
  for (const t of ['skills', 'rules', 'agents', 'commands']) tree('claude', path.join(o.claudeDir, t), t);
  one('codex', o.codexDir, 'AGENTS.md');
  tree('home', path.join(o.homedir, '.agents/skills'), '.agents/skills');
  if (o.agentProfiles) tree('profiles', o.agentProfiles, '');
  return { files, settings: claudeSettings(o.claudeDir, skipped), skipped };
}

/** Packs the plan into the tar `file`: each file at its `to`, and the settings with the homes they were read under. */
export async function packMirror(plan: MirrorPlan, from: Pick<MirrorHomes, 'homedir' | 'claudeDir'>, file: string): Promise<void> {
  const stage = `${file}.d`;
  fs.rmSync(stage, { recursive: true, force: true });
  try {
    for (const f of plan.files) {
      const to = path.join(stage, f.to);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(f.from, to);
      fs.chmodSync(to, f.mode);
    }
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, MANIFEST), JSON.stringify({ homedir: from.homedir, claudeDir: from.claudeDir, settings: plan.settings }));
    await packTar(stage, [MANIFEST, ...plan.files.map((f) => f.to)], file);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// every string under a path key moved by `move`
function relocated(v: unknown, move: (p: string) => string, under = false): unknown {
  if (typeof v === 'string') return under && path.posix.isAbsolute(v) ? move(v) : v;
  if (Array.isArray(v)) return v.map((x) => relocated(x, move, under));
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, relocated(x, move, under || PATH_KEY.test(k))]));
  return v;
}

// `data` at `file`, through a link, unless it holds those bytes already
function put(file: string, data: Buffer, mode: number): boolean {
  const at = realPath(file);
  if (fs.existsSync(at) && fs.readFileSync(at).equals(data)) return false;
  fs.mkdirSync(path.dirname(at), { recursive: true });
  writeDurable(at, data, { mode });
  return true;
}

/**
 * Puts the mirror unpacked at `blobDir` into this machine's homes and returns the files written: each whose bytes differ,
 * an override's in place of the home's; Claude's settings merged by key over this machine's, its hooks and statusLine
 * kept, paths moved by home, the override's settings last.
 */
export function applyMirror(blobDir: string, o: MirrorHomes & { overrides: string }): string[] {
  const m = Manifest.parse(JSON.parse(fs.readFileSync(path.join(blobDir, MANIFEST), 'utf8')));
  const settingsFile = path.join(o.claudeDir, 'settings.json');
  // read before anything is written: settings that are not JSON stop the mirror rather than be replaced
  const current = readJsonSettings(settingsFile);
  const overridden = readJsonSettings(path.join(o.overrides, 'claude/settings.json')).settings;
  const written: string[] = [];
  for (const root of Object.keys(ROOTS) as Root[]) {
    const home = o[ROOTS[root]];
    if (!home) continue;
    for (const rel of filesIn(path.join(blobDir, root))) {
      const override = path.join(o.overrides, root, rel);
      const from = fs.existsSync(override) ? override : path.join(blobDir, root, rel);
      const file = path.join(home, rel);
      if (put(file, fs.readFileSync(from), fs.statSync(from).mode & 0o777)) written.push(file);
    }
  }
  const claude = { from: m.claudeDir, to: o.claudeDir };
  const move = (p: string): string => relocate(p, holds(clean(claude.from), clean(p)) ? claude : { from: m.homedir, to: o.homedir });
  const next: Record<string, unknown> = { ...current.settings, ...(relocated(m.settings, move) as Record<string, unknown>) };
  for (const k of WORKER_OWNED) {
    if (Object.hasOwn(current.settings, k)) next[k] = current.settings[k];
    else delete next[k];
  }
  Object.assign(next, overridden);
  if (!same(current.settings, next)) {
    put(settingsFile, Buffer.from(`${JSON.stringify(next, null, 2)}\n`), (statOf(settingsFile)?.mode ?? 0o644) & 0o777);
    written.push(settingsFile);
  }
  return written;
}

/** The home's side: its agent configuration packed and sent to a worker, which applies it once it has arrived. */
export class Mirror {
  constructor(private o: MirrorHomes & { log: Logger }) {}

  async push(link: Pick<WorkerLink, 'call' | 'sendBlob'>): Promise<void> {
    const plan = mirrorPlan(this.o);
    for (const line of plan.skipped) this.o.log.info(`mirror: ${line}; it stays on this Mac`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-mirror-'));
    try {
      const file = path.join(dir, 'mirror.tar');
      await packMirror(plan, this.o, file);
      const id = `mirror_${crypto.randomUUID()}`;
      await link.call('config.blob', { id, sha256: await fileSha(file) });
      await link.sendBlob(id, file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** A worker's `config.blob`: the blob's id is taken before the home sends a byte, and the mirror applied once it has arrived as it left. */
export function mirrorCalls(o: MirrorHomes & { overrides: string; stage: string; connection: Pick<HomeConnection, 'receiveBlob'>; log: Logger }): Record<string, (raw: unknown) => Promise<unknown>> {
  return {
    'config.blob': async (raw) => {
      const p = Offer.safeParse(raw);
      if (!p.success) throw new ApiError('invalid_params', z.prettifyError(p.error));
      fs.mkdirSync(o.stage, { recursive: true });
      const dir = fs.mkdtempSync(path.join(o.stage, 'mirror-'));
      const tar = path.join(dir, 'mirror.tar');
      void o.connection.receiveBlob(p.data.id, tar).then(async ({ sha256 }) => {
        if (sha256 !== p.data.sha256) throw new Error('it did not arrive as it left');
        await unpack(tar, path.join(dir, 'blob'));
        const written = applyMirror(path.join(dir, 'blob'), o);
        if (written.length) o.log.info(`mirror: ${written.length} files of the home's agent configuration written`);
      }).catch((e: Error) => o.log.error(`mirror: the home's agent configuration was not applied: ${e.message}`))
        .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
      return { ready: true };
    },
  };
}
