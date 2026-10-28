import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Sha256 } from '@svall/protocol';
import { canonicalJson, sha256Hex } from '../hash.js';
import { clean, holds } from '../path-tools.js';
import { relocate } from './relocate.js';
import { realPath } from '../paths.js';
import type { Place } from './mirror-config.js';

/** Where a machine keeps what the mirror carries; `agentProfiles` is the fleet home's. */
export type MirrorHomes = { claudeDir: string; codexDir: string; homedir: string; claudeJson: string; opencodeDir: string; agentProfiles?: string };
export type Homes = Pick<MirrorHomes, 'homedir' | 'claudeDir' | 'claudeJson' | 'codexDir' | 'opencodeDir'>;

/** The agent config files the mirror merges by key rather than carries whole. */
export const DOC_NAMES = ['settings.json', '.claude.json', 'config.toml', 'opencode.json', 'opencode.jsonc'] as const;
export type DocName = (typeof DOC_NAMES)[number];
export const OPENCODE_FILES = ['opencode.json', 'opencode.jsonc'] as const;

const Place = z.array(z.union([z.string(), z.number()]));
export const InPlace = z.object({ to: z.string(), places: z.array(z.object({ place: Place, sha: Sha256, bare: z.string() })) });
export type InPlace = z.infer<typeof InPlace>;

const Shas = z.record(z.string(), Sha256);
const Copies = z.record(z.string(), z.union([Sha256, z.array(Sha256)]));
const Bare = z.record(z.string(), z.object({ value: z.string().optional(), envVar: z.literal(true).optional() }));
/**
 * What the mirror last wrote on a worker, by sha256 under a file's `to` or the JSON of a doc and the keys into it; a copy an
 * apply cut short holds either of two shas. `bare` is what an untick leaves, `envVar` where a Codex server's env_vars names it.
 */
export const WorkerState = z.object({
  files: Shas, docs: z.record(z.string(), Shas), servers: Shas, secrets: Copies, whole: Copies.optional(), keyed: Copies.optional(), bare: Bare.optional(),
  applied: z.number().int().nonnegative().optional(),
});
export type WorkerState = z.infer<typeof WorkerState>;
export type Copied = WorkerState['secrets'][string];
export const isCopyOf = (recorded: Copied | undefined, h: string | undefined): boolean => recorded !== undefined && h !== undefined && [recorded].flat().includes(h);
// a server's sha whatever order its keys lie in, as TOML writes a table's plain keys first; none for a value JSON cannot hold
export const serverSha = (v: unknown): string | undefined => {
  try { return sha256Hex(canonicalJson(v)); } catch { return undefined; }
};

export const isCopy = (recorded: Copied | undefined, v: unknown): boolean => typeof v === 'string' && isCopyOf(recorded, sha256Hex(v));

/** The Mac's home and its project folders, which the worker answers for. */
export const StateAsk = z.object({ homedir: z.string(), projects: z.array(z.string()) });
export const WorkerFacts = z.object({ state: WorkerState, projects: z.record(z.string(), z.boolean()) });
/** The worker's record, and whether it has each project folder of the Mac's, by the Mac's path. */
export type WorkerFacts = z.infer<typeof WorkerFacts>;

export const ROOTS = { claude: 'claudeDir', codex: 'codexDir', home: 'homedir', profiles: 'agentProfiles', opencode: 'opencodeDir' } as const;
export type Root = keyof typeof ROOTS;
// the worker's own: its `svall setup` writes hooks and statusLine, which on the Mac name the app bundle, and the rest hold
// secrets or run what fetches them
export const WORKER_OWNED = ['hooks', 'statusLine', 'env', 'apiKeyHelper', 'awsCredentialExport', 'awsAuthRefresh', 'otelHeadersHelper'];
export const CODEX_WORKER_OWNED = ['projects', 'hooks', 'mcp_servers'];
export const CODEX_MAC_ONLY = ['notify', 'desktop', 'marketplaces', 'plugins'];
export const OPENCODE_WORKER_OWNED = ['mcp'];
// Claude's plugin lists, whose paths land by home
export const PLUGIN_LISTS = ['installed_plugins.json', 'known_marketplaces.json'];
// a settings value under a key named so is a path, which lands by home
const PATH_KEY = /(Path|Dir|Location|cwd)$/;
export const MANIFEST = 'mirror.json';
export const Doc = z.record(z.string(), z.unknown());
export type Doc = z.infer<typeof Doc>;

export const statOf = (file: string): fs.Stats | undefined => {
  try { return fs.statSync(file); } catch { return undefined; }
};
export const isDoc = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isNoFile = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT';

// every string under a path key moved by `move`
export function relocated(v: unknown, move: (p: string) => string, under = false): unknown {
  if (typeof v === 'string') return under && path.posix.isAbsolute(v) ? move(v) : v;
  if (Array.isArray(v)) return v.map((x) => relocated(x, move, under));
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, relocated(x, move, under || PATH_KEY.test(k))]));
  return v;
}

/** The mirror's record on this machine; an empty one where there is none. */
export function readState(file: string): WorkerState {
  try {
    const p = WorkerState.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (p.success) return p.data;
  } catch { /* none yet */ }
  return { files: {}, docs: {}, servers: {}, secrets: {} };
}

/** What a worker tells the home before a mirror: its record, and which of the Mac's project folders it has under its home. */
export function configState(ask: z.infer<typeof StateAsk>, o: { stateFile: string; homedir: string }): WorkerFacts {
  const r = { from: ask.homedir, to: o.homedir };
  return { state: readState(o.stateFile), projects: Object.fromEntries(ask.projects.map((p) => [p, fs.existsSync(relocate(p, r))])) };
}

/** How the mirror moves a path from the Mac's homes into this machine's: one under Claude's folder into this one's, else by home. */
export function mover(mac: { homedir: string; claudeDir: string }, here: { homedir: string; claudeDir: string }): (p: string) => string {
  const claude = { from: mac.claudeDir, to: here.claudeDir };
  return (p) => relocate(p, holds(clean(claude.from), clean(p)) ? claude : { from: mac.homedir, to: here.homedir });
}

/** Where `place` in doc `name` lies on this machine: a Claude project's under this machine's own path of it. */
export const placedIn = (name: DocName, place: Place, move: (p: string) => string): Place =>
  (name === '.claude.json' && place[0] === 'projects' ? ['projects', realPath(move(String(place[1]))).normalize('NFC'), ...place.slice(2)] : place);

/** The record's key for what lies at `place` in doc `name`, `place` as the Mac holds it. */
export const recordKey = (name: DocName, place: Place): string => JSON.stringify([name, ...place]);
