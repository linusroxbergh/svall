import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { z } from 'zod';
import { AgentKind } from '@svall/protocol';
import { BATCH_WIDTH, DurableBatch, writeDurable } from '../durable.js';
import { sha256Hex } from '../hash.js';
import { clean, holds } from '../path-tools.js';
import { pool } from '../pool.js';
import { realPath } from '../paths.js';
import { fileSha } from './bundle.js';
import { filesIn } from './docs-sync.js';
import { agentDoc } from './mirror-agents.js';
import { configPlace, configRedacted, fieldPlace, getAt, isReferenceOnly, parseJsonc, relocatedServer, setAt, type Place } from './mirror-config.js';
import { CONFIG_ITEMS } from './mirror-consent.js';
import {
  CODEX_MAC_ONLY, CODEX_WORKER_OWNED, Doc, DOC_NAMES, InPlace, isCopy, isCopyOf, isDoc, isNoFile, MANIFEST, mover, OPENCODE_FILES, OPENCODE_WORKER_OWNED, placedIn,
  PLUGIN_LISTS, readState, recordKey, relocated, ROOTS, serverSha, statOf, WORKER_OWNED, type Copied, type DocName, type Homes, type MirrorHomes, type Root, type WorkerState,
} from './mirror-state.js';

// matches no file and no value, so a push writes again what an apply cut short may have left half done
const UNSURE = '0'.repeat(64);

// the record while an apply writes: every key either record holds, a changed one as unsure, a copied value as either
function provisional(state: WorkerState, next: WorkerState): WorkerState {
  const keys = (a: Record<string, unknown>, b: Record<string, unknown>) => [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const shas = (a: Record<string, string>, b: Record<string, string>) => Object.fromEntries(keys(a, b).map((k) => [k, b[k] === undefined || a[k] === b[k] ? a[k] : UNSURE]));
  const either = (a: Record<string, Copied>, b: Record<string, Copied>) => Object.fromEntries(keys(a, b).map((k) => {
    const both = [...new Set([a[k], b[k]].flat().filter((h): h is string => h !== undefined))];
    return [k, both.length === 1 ? both[0] : both];
  }));
  return {
    files: shas(state.files, next.files), servers: shas(state.servers, next.servers),
    docs: Object.fromEntries(keys(state.docs, next.docs).map((d) => [d, shas(state.docs[d] ?? {}, next.docs[d] ?? {})])),
    secrets: either(state.secrets, next.secrets), whole: either(state.whole ?? {}, next.whole ?? {}), keyed: either(state.keyed ?? {}, next.keyed ?? {}),
    bare: { ...state.bare, ...next.bare }, ...(next.applied !== undefined && { applied: next.applied }),
  };
}

const Manifest = z.object({
  homes: z.object({ homedir: z.string(), claudeDir: z.string(), claudeJson: z.string(), codexDir: z.string(), opencodeDir: z.string() }),
  servers: z.array(z.object({
    agent: AgentKind, entry: Doc, bare: Doc, secretFields: z.array(z.string()), ticked: z.array(z.string()),
    doc: z.enum(DOC_NAMES).optional(), place: z.array(z.string()),
  })),
  configs: z.array(z.object({ key: z.string(), fields: z.array(z.string()), ticked: z.array(z.string()) })),
  settings: Doc,
  settingsEnv: z.record(z.string(), z.string()),
  codex: Doc.optional(),
  opencode: z.array(z.object({ file: z.enum(OPENCODE_FILES), doc: Doc, fields: z.array(z.string()) })),
  vars: z.array(z.string()),
  unreadable: z.array(z.string()),
  unreadInstalls: z.array(z.string()).default([]),
  keep: z.array(z.string()),
  keyed: z.array(z.string()).default([]),
  inPlace: z.array(InPlace).default([]),
});
type Manifest = z.infer<typeof Manifest>;

const sha = (v: unknown): string => sha256Hex(JSON.stringify(v));

const stringPlaces = (v: unknown, place: Place = []): Place[] => (typeof v === 'string' ? [place] : typeof v !== 'object' || v === null ? []
  : Object.entries(v).flatMap(([k, x]) => stringPlaces(x, [...place, Array.isArray(v) ? Number(k) : k])));

// `file`, through a link, readable and writable by its owner alone
function ownerOnly(file: string): void {
  const at = realPath(file);
  const mode = statOf(at)?.mode;
  if (mode !== undefined && (mode & 0o777) !== 0o600) fs.chmodSync(at, 0o600);
}

// `data` at `file`, through a link, unless it holds those bytes already
function put(file: string, data: Buffer, mode: number): boolean {
  const at = realPath(file);
  if (fs.existsSync(at) && fs.readFileSync(at).equals(data)) return false;
  fs.mkdirSync(path.dirname(at), { recursive: true });
  writeDurable(at, data, { mode });
  return true;
}

// as `put`, written in `batch`
async function place(batch: DurableBatch, file: string, data: Buffer, mode: number): Promise<boolean> {
  const at = realPath(file);
  const was = await fsp.readFile(at).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
  if (was?.equals(data)) return false;
  await batch.write(at, data, mode);
  return true;
}

const asJson = (doc: Doc): string => `${JSON.stringify(doc, null, 2)}\n`;
type DocSpec = {
  name: DocName; at: (h: Homes) => string; parse: (text: string) => unknown; format: (doc: Doc) => string;
  /** Keys its merge never writes, and the consent item of its key fields. */
  owned: readonly string[]; item?: string;
  /** Its override, in the overrides' layout; `servers` the key whose servers an override merges into by name, taking no other when `serversOnly`. */
  override: string; servers?: string; serversOnly?: boolean; empty?: Doc;
};
const DOCS: DocSpec[] = [
  { name: 'settings.json', at: (h) => path.join(h.claudeDir, 'settings.json'), parse: JSON.parse, format: asJson, owned: WORKER_OWNED, item: CONFIG_ITEMS.settings, override: 'claude/settings.json' },
  {
    name: '.claude.json', at: (h) => h.claudeJson, parse: JSON.parse, format: asJson, owned: [], override: 'claude/.claude.json', servers: 'mcpServers', serversOnly: true,
    empty: { mcpServers: {} },
  },
  {
    name: 'config.toml', at: (h) => path.join(h.codexDir, 'config.toml'), parse: parseToml, format: (d) => stringifyToml(d), owned: [...CODEX_WORKER_OWNED, ...CODEX_MAC_ONLY],
    item: CONFIG_ITEMS.codex, override: 'codex/config.toml', servers: 'mcp_servers',
  },
  ...OPENCODE_FILES.map((name): DocSpec => ({
    name, at: (h) => path.join(h.opencodeDir, name), parse: (t) => parseJsonc(t), format: asJson, owned: OPENCODE_WORKER_OWNED, item: CONFIG_ITEMS.opencode,
    override: `opencode/${name}`, servers: 'mcp',
  })),
];

// a config file's object, or undefined for none; one that holds no object stops the mirror, named without what it holds
function readDocFile(file: string, parse: (text: string) => unknown): Doc | undefined {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (isNoFile(e)) return undefined;
    throw e;
  }
  let doc: unknown;
  try { doc = parse(text); } catch { /* named below */ }
  if (!isDoc(doc)) throw new Error(`${file} cannot be parsed, so the mirror left this machine's agent configuration as it was`);
  return doc;
}

const overlay = (a: unknown, b: unknown): unknown =>
  isDoc(a) && isDoc(b) ? { ...a, ...Object.fromEntries(Object.entries(b).map(([k, v]) => [k, overlay(a[k], v)])) } : b;

function overrideOver(d: DocSpec, doc: Doc, override: Doc | undefined): void {
  for (const [k, v] of Object.entries(override ?? {})) {
    if (k === d.servers) doc[k] = overlay(doc[k], v);
    else if (!d.serversOnly) doc[k] = v;
  }
}

/** Config file `name` of this machine with its override merged over it; undefined where either cannot be parsed. */
export function docWithOverride(name: DocName, o: Homes & { overrides: string }): Doc | undefined {
  const d = DOCS.find((x) => x.name === name);
  if (!d) return undefined;
  try {
    const doc = readDocFile(d.at(o), d.parse) ?? {};
    overrideOver(d, doc, readDocFile(path.join(o.overrides, d.override), d.parse));
    return doc;
  } catch {
    return undefined;
  }
}

/**
 * A secret value's place in a doc: `want` the Mac's if ticked, else `bare`; `named` when the place is the value itself, not a url
 * or arg holding it; `remerged` when this merge wrote over it; `overOwn` when it may replace the worker's own; `server` its Codex server.
 */
type Leaf = { record: string; place: Place; want?: string; bare?: string; named: boolean; remerged: boolean; overOwn: boolean; server?: Place };

// `v` at the leaf; a Codex env value not set is named in its server's env_vars instead, and only then
function setLeaf(doc: Doc, l: Leaf, v: string | undefined): void {
  setAt(doc, l.place, v);
  if (!l.server) return;
  const name = String(l.place[l.place.length - 1]);
  const names = getAt(doc, [...l.server, 'env_vars']);
  const rest = (Array.isArray(names) ? names : []).filter((n: unknown) => n !== name && !(isDoc(n) && n.name === name));
  setAt(doc, [...l.server, 'env_vars'], v === undefined ? [...rest, name] : rest.length ? rest : undefined);
}

// a ticked value is the Mac's unless it would go over the worker's own; a copy is emptied once unticked; the worker's own goes
// back where the merge wrote over it. `next` keeps a copy while its place holds it or its bare form
function settle(doc: Doc, was: Doc, l: Leaf, recorded: Copied | undefined, next: WorkerState): void {
  const pre = getAt(was, l.place);
  const copied = isCopy(recorded, pre);
  const own = typeof pre === 'string' && pre !== '' && pre !== l.bare && !copied && (l.named || !l.remerged);
  const now = getAt(doc, l.place);
  const keep = (h: Copied): void => {
    next.secrets[l.record] = h;
    (next.bare ??= {})[l.record] = { ...(l.bare !== undefined && { value: l.bare }), ...(l.server && { envVar: true as const }) };
  };
  if (l.want !== undefined && (l.overOwn || !own)) {
    if (now !== l.want) setLeaf(doc, l, l.want);
    keep(sha256Hex(l.want));
    return;
  }
  if (copied && now !== l.bare) setLeaf(doc, l, l.bare);
  else if (own && now !== pre) setLeaf(doc, l, pre as string);
  const after = getAt(doc, l.place);
  if (recorded !== undefined && (isCopy(recorded, after) || after === l.bare)) keep(recorded);
}

function leavesOf(fields: string[], placesOf: (field: string) => Place[]): { place: Place; fields: string[] }[] {
  const groups = new Map<string, { place: Place; fields: string[] }>();
  for (const f of fields) {
    for (const place of placesOf(f)) {
      const k = JSON.stringify(place);
      groups.set(k, { place, fields: [...(groups.get(k)?.fields ?? []), f] });
    }
  }
  return [...groups.values()];
}

/**
 * Puts the mirror at `blobDir` into this machine's homes. A record of all it may write goes first, so an apply cut short still
 * knows each copy it left, the final one last; files go off the event loop, a few at once, so the link is answered meanwhile.
 */
export async function applyMirror(
  blobDir: string, o: MirrorHomes & { overrides: string; stateFile: string; varsFile: string; seq?: number },
): Promise<{ written: string[]; removed: string[] }> {
  const m = Manifest.parse(JSON.parse(fs.readFileSync(path.join(blobDir, MANIFEST), 'utf8')));
  const state = readState(o.stateFile);
  const applied = o.seq ?? state.applied;
  const next: WorkerState = { files: {}, docs: {}, servers: {}, secrets: {}, ...(applied !== undefined && { applied }) };
  const written: string[] = [];
  const removed: string[] = [];
  const move = mover(m.homes, o);
  // read before anything is written: a config file or override that cannot be parsed stops the mirror rather than be replaced
  const current = DOCS.map((d) => ({ doc: readDocFile(d.at(o), d.parse), override: readDocFile(path.join(o.overrides, d.override), d.parse) }));
  const docs = DOCS.map((d, i) => applyDoc(d, current[i].doc, current[i].override, { m, state, next, move }));
  const carried = (Object.keys(ROOTS) as Root[]).flatMap((root) => {
    const home = o[ROOTS[root]];
    return home ? filesIn(path.join(blobDir, root)).map((rel) => ({ root, home, rel, to: path.posix.join(root, rel), from: path.join(blobDir, root, rel) })) : [];
  });
  const shas = await pool(carried, BATCH_WIDTH, (f) => fileSha(f.from));
  carried.forEach((f, i) => { next.files[f.to] = shas[i]; });
  for (const to of m.keyed) {
    const h = next.files[to] ?? state.files[to];
    if (h) (next.keyed ??= {})[to] = h;
  }
  // a key in a file the agent needs is recorded by its place there, as a doc's is; an override stands there instead
  for (const f of m.inPlace) {
    if (fs.existsSync(path.join(o.overrides, f.to))) continue;
    for (const p of f.places) {
      const k = JSON.stringify([f.to, ...p.place]);
      next.secrets[k] = p.sha;
      (next.bare ??= {})[k] = { value: p.bare };
    }
  }
  const batch = new DurableBatch();
  await place(batch, o.stateFile, Buffer.from(asJson(provisional(state, next))), 0o600);
  await batch.settle();
  const fileOf = (to: string): string | undefined => {
    const [root, ...rest] = to.split('/');
    const home = Object.hasOwn(ROOTS, root) ? o[ROOTS[root as Root]] : undefined;
    return home && path.join(home, ...rest);
  };

  // a config file holding a ticked key is its owner's alone, whether or not this apply changed it
  for (const [i, d] of DOCS.entries()) {
    const { doc, keyed } = docs[i];
    if (doc && await place(batch, d.at(o), Buffer.from(d.format(doc)), keyed ? 0o600 : (statOf(d.at(o))?.mode ?? 0o600) & 0o777)) written.push(d.at(o));
    if (keyed) ownerOnly(d.at(o));
  }
  const changed = carried.filter((f) => state.files[f.to] !== next.files[f.to]);
  const wrote = await pool(changed, BATCH_WIDTH, async ({ root, home, rel, from }) => {
    const data = await fsp.readFile(from);
    const override = path.join(o.overrides, root, rel);
    const list = root === 'claude' && PLUGIN_LISTS.some((n) => rel === path.join('plugins', n));
    const bytes = fs.existsSync(override) ? await fsp.readFile(override) : list ? Buffer.from(asJson(relocated(JSON.parse(data.toString('utf8')), move) as Doc)) : data;
    const file = path.join(home, rel);
    return await place(batch, file, bytes, fs.statSync(from).mode & 0o777) ? file : undefined;
  });
  written.push(...wrote.filter((f) => f !== undefined));
  const keep = new Set(m.keep);
  const pluginList = path.join(m.homes.claudeDir, 'plugins/installed_plugins.json');
  // a plugin file stays as the mirror last wrote it while the Mac cannot read it or a manifest or list that may name it
  const unread = (to: string): boolean => {
    if (!to.startsWith('claude/plugins/')) return false;
    const mac = path.join(m.homes.claudeDir, to.slice('claude/'.length));
    return m.unreadInstalls.some((i) => holds(clean(i), mac))
      || m.unreadable.some((u) => u === pluginList || u === mac || (u.endsWith('/.claude-plugin/plugin.json') && holds(path.dirname(path.dirname(u)), mac)));
  };
  for (const [to, h] of Object.entries(state.files)) {
    if (Object.hasOwn(next.files, to)) continue;
    if (keep.has(to) || unread(to)) {
      next.files[to] = h;
      if (unread(to) && state.keyed?.[to]) (next.keyed ??= {})[to] = state.keyed[to];
      for (const k of Object.keys(state.secrets).filter((x) => unread(to) && JSON.parse(x)[0] === to)) {
        next.secrets[k] = state.secrets[k];
        if (state.bare?.[k]) (next.bare ??= {})[k] = state.bare[k];
      }
      continue;
    }
    const file = fileOf(to);
    if (file && fs.lstatSync(file, { throwIfNoEntry: false })) {
      await fsp.rm(file, { force: true });
      removed.push(file);
    }
  }
  // a file holding a ticked key is its owner's alone, whether or not this apply wrote it
  for (const to of Object.keys(next.keyed ?? {})) {
    const file = fileOf(to);
    if (file) ownerOnly(file);
  }
  // the overrides of whole files, each over what the mirror wrote there
  const docOverrides = new Set(DOCS.map((d) => d.override));
  for (const root of Object.keys(ROOTS) as Root[]) {
    const home = o[ROOTS[root]];
    if (!home) continue;
    for (const rel of filesIn(path.join(o.overrides, root))) {
      if (docOverrides.has(path.posix.join(root, rel))) continue;
      const from = path.join(o.overrides, root, rel);
      const file = path.join(home, rel);
      if (await place(batch, file, await fsp.readFile(from), fs.statSync(from).mode & 0o777)) written.push(file);
    }
  }

  await place(batch, o.varsFile, Buffer.from(`${JSON.stringify(m.vars, null, 2)}\n`), 0o644);
  await batch.settle();
  await place(batch, o.stateFile, Buffer.from(asJson(next)), 0o600);
  await batch.settle();
  return { written, removed };
}

type Applying = { m: Manifest; state: WorkerState; next: WorkerState; move: (p: string) => string };

// one config file as the mirror leaves it, none when unchanged, and whether it holds a ticked value; one the Mac could not
// read keeps its record
function applyDoc(d: DocSpec, current: Doc | undefined, override: Doc | undefined, { m, state, next, move }: Applying): { doc?: Doc; keyed: boolean } {
  const doc: Doc = current ?? structuredClone(d.empty ?? {});
  const before = JSON.stringify(doc);
  const was = JSON.parse(before) as Doc;
  const leave = m.unreadable.includes(d.at(m.homes));
  const records = <T>(of: Record<string, T>): [string, T][] => Object.entries(of).filter(([k]) => JSON.parse(k)[0] === d.name);
  const leaves: Leaf[] = [];

  // its keys, each written when the Mac's changed since the mirror last wrote it
  const config = m.configs.find((c) => c.key === d.item);
  const oc = m.opencode.find((x) => x.file === d.name);
  const macDoc = d.name === 'settings.json' ? m.settings : d.name === 'config.toml' ? m.codex : oc?.doc;
  // this file's own secret fields: an OpenCode file shares its row with the other
  const fields = oc ? oc.fields : config?.fields ?? [];
  const remergedKeys = new Set<string>();
  let bareDoc: Doc = {};
  if (d.name !== '.claude.json' && leave) next.docs[d.name] = state.docs[d.name] ?? {};
  else if (d.name !== '.claude.json') {
    const ticked = relocated(macDoc ?? {}, move) as Doc;
    const bare = configRedacted(ticked, (config?.ticked ?? []).filter((f) => fields.includes(f)));
    bareDoc = bare;
    const recorded = state.docs[d.name] ?? {};
    const shas: Record<string, string> = {};
    for (const [k, v] of Object.entries(bare)) {
      if (d.owned.includes(k)) continue;
      shas[k] = sha(v);
      if (recorded[k] === shas[k]) continue;
      doc[k] = structuredClone(v);
      remergedKeys.add(k);
    }
    for (const k of Object.keys(recorded)) if (!Object.hasOwn(shas, k) && !d.owned.includes(k)) delete doc[k];
    next.docs[d.name] = shas;
    for (const g of leavesOf(fields, (f) => configPlace(ticked, f))) {
      leaves.push({
        record: recordKey(d.name, g.place), place: g.place, want: g.fields.some((f) => config?.ticked.includes(f)) ? getAt(ticked, g.place) as string : undefined,
        bare: getAt(bare, g.place) as string, named: g.fields.every((f) => f === g.place.join('.')), remerged: remergedKeys.has(String(g.place[0])), overOwn: true,
      });
    }
  }
  // Claude's env, which the worker owns: a ticked key never over one the worker set itself
  if (d.name === 'settings.json') {
    for (const f of config?.fields ?? []) {
      if (!f.startsWith('env.')) continue;
      const k = f.slice('env.'.length);
      leaves.push({
        record: recordKey(d.name, ['env', k]), place: ['env', k], want: config?.ticked.includes(f) ? m.settingsEnv[k] : undefined, named: true, remerged: false, overOwn: false,
      });
    }
  }

  // its servers, each in its own place, a Claude project's under the worker's own path of it
  const placed = (place: Place): Place => placedIn(d.name, place, move);
  const servers: Record<string, string> = {};
  const carried: { place: string[]; at: Place; bare: Doc; codex: boolean }[] = [];
  for (const s of m.servers.filter((x) => x.doc === d.name && Object.keys(x.entry).length)) {
    const rk = recordKey(d.name, s.place);
    const at = placed(s.place);
    const entry = relocatedServer(s.entry, move);
    const bare = relocatedServer(s.bare, move);
    carried.push({ place: s.place, at, bare, codex: s.agent === 'codex' });
    servers[rk] = sha(bare);
    // a server ticked whole carries its fields as they are, keys among them
    const whole = !s.secretFields.length && s.ticked.length ? serverSha(bare) : undefined;
    if (whole) (next.whole ??= {})[rk] = whole;
    const remerged = state.servers[rk] !== servers[rk] || getAt(doc, at) === undefined;
    if (remerged) setAt(doc, at, structuredClone(bare));
    for (const g of leavesOf(s.secretFields, (f) => fieldPlace(s.agent, s.entry, f))) {
      leaves.push({
        record: recordKey(d.name, [...s.place, ...g.place]), place: [...at, ...g.place],
        want: g.fields.some((f) => s.ticked.includes(f)) ? getAt(entry, g.place) as string : undefined, bare: getAt(bare, g.place) as string | undefined,
        named: !g.fields.some((f) => f.startsWith('url') || f.startsWith('args[')), remerged, overOwn: true,
        ...(s.agent === 'codex' && g.place[0] === 'env' && { server: at }),
      });
    }
  }
  for (const [rk, h] of records(state.servers)) {
    if (Object.hasOwn(servers, rk)) continue;
    if (!leave) setAt(doc, placed((JSON.parse(rk) as Place).slice(1)), undefined);
    else {
      servers[rk] = h;
      if (state.whole?.[rk]) (next.whole ??= {})[rk] = state.whole[rk];
    }
  }
  Object.assign(next.servers, servers);

  for (const l of leaves) settle(doc, was, l, state.secrets[l.record], next);
  // a value copied where the Mac now holds no secret is emptied as that place stands bare, while it is still the copy
  for (const [k, h] of records(state.secrets)) {
    if (leave) {
      next.secrets[k] ??= h;
      if (state.bare?.[k]) (next.bare ??= {})[k] ??= state.bare[k];
    }
    if (leave || Object.hasOwn(next.secrets, k)) continue;
    const place = (JSON.parse(k) as Place).slice(1);
    const s = carried.find((c) => c.place.every((p, i) => place[i] === p));
    const leaf = s ? place.slice(s.place.length) : place;
    const l: Leaf = {
      record: k, place: s ? [...s.at, ...leaf] : placed(place), named: true, remerged: false, overOwn: true,
      bare: (s ? getAt(s.bare, leaf) : d.name === 'settings.json' && place[0] === 'env' ? undefined : getAt(bareDoc, place)) as string | undefined,
      ...(s?.codex && leaf[0] === 'env' && { server: s.at }),
    };
    if (isCopy(h, getAt(doc, l.place))) setLeaf(doc, l, l.bare);
  }

  overrideOver(d, doc, override);
  const keyed = leaves.some((l) => l.want !== undefined) || m.servers.some((x) => x.doc === d.name && Object.keys(x.entry).length > 0 && x.ticked.length > 0);
  return JSON.stringify(doc) === before ? { keyed } : { doc, keyed };
}

// removes the blobs a daemon left under `stage`, which may hold ticked keys, answering how many
export function dropBlobs(stage: string): number {
  const left = (fs.existsSync(stage) ? fs.readdirSync(stage, { withFileTypes: true }) : []).filter((f) => f.isDirectory() && f.name.startsWith('mirror-'));
  for (const f of left) fs.rmSync(path.join(stage, f.name), { recursive: true, force: true });
  return left.length;
}

/**
 * Takes back each copy the mirror's record names while it is still the copy: a value becomes its bare form, a server copied
 * whole leaves, another keyed file goes. Answers a line for each file it changed or could not, and each copy changed since.
 */
export function takeBackCopies(o: Homes & { stateFile: string }): string[] {
  const state = readState(o.stateFile);
  const done: string[] = [];
  const what = (keys: number, servers: number): string => [keys && `${keys} ${keys === 1 ? 'key' : 'keys'} the mirror copied`, servers && `${servers} ${servers === 1 ? 'server' : 'servers'} the mirror copied whole`]
    .filter(Boolean).join(' and ');
  // a value there that is neither copy nor bare form counts as changed only where the record keeps a bare form
  const takeBack = (doc: unknown, k: string, at: Place, one: boolean, server?: Place): 'took' | 'changed' | undefined => {
    const v = getAt(doc, at);
    const bare = state.bare?.[k];
    if (!isCopy(state.secrets[k], v)) {
      return bare && one && typeof v === 'string' && v !== '' && v !== bare.value && !isReferenceOnly(v) ? 'changed' : undefined;
    }
    setLeaf(doc as Doc, { record: k, place: at, named: true, remerged: false, overOwn: true, ...(server && { server }) }, bare ? bare.value : '');
    return 'took';
  };
  for (const d of DOCS) {
    const keys = Object.keys(state.secrets).filter((k) => JSON.parse(k)[0] === d.name);
    const whole = Object.keys(state.whole ?? {}).filter((k) => JSON.parse(k)[0] === d.name);
    if (!keys.length && !whole.length) continue;
    let doc: Doc | undefined;
    try { doc = readDocFile(d.at(o), d.parse); } catch (e) {
      done.push(`could not take the mirror's keys back from ${d.at(o)}: ${(e as Error).message}`);
      continue;
    }
    if (!doc) continue;
    const projects = Object.keys(isDoc(doc.projects) ? doc.projects : {});
    // a Claude project lies under this machine's own path of it, which the record does not keep
    const places = (k: string): Place[] => {
      const place = (JSON.parse(k) as Place).slice(1);
      return d.name === '.claude.json' && place[0] === 'projects' ? projects.map((p) => ['projects', p, ...place.slice(2)]) : [place];
    };
    // one a record may name in several projects is not told apart from a server of the worker's own
    let [n, changed] = [0, 0];
    for (const k of keys) {
      for (const at of places(k)) {
        const r = takeBack(doc, k, at, places(k).length === 1, state.bare?.[k]?.envVar ? at.slice(0, -2) : undefined);
        if (r === 'took') n += 1;
        else if (r === 'changed') changed += 1;
      }
    }
    let [w, rewritten] = [0, 0];
    for (const k of whole) {
      for (const at of places(k)) {
        const v = getAt(doc, at);
        if (!isDoc(v)) continue;
        if (!isCopyOf(state.whole?.[k], serverSha(v))) {
          if (places(k).length === 1) rewritten += 1;
          continue;
        }
        setAt(doc, at, undefined);
        w += 1;
      }
    }
    if (n || w) {
      put(d.at(o), Buffer.from(d.format(doc)), (statOf(d.at(o))?.mode ?? 0o600) & 0o777);
      done.push(`took ${what(n, w)} out of ${d.at(o)}`);
    }
    if (changed || rewritten) done.push(`left ${what(changed, rewritten)} in ${d.at(o)}, which changed there since`);
  }
  // a file the agent needs keeps itself, its keys taken back where they lie: a subagent's in its frontmatter's mcpServers
  const inPlace = new Map<string, string[]>();
  for (const k of Object.keys(state.secrets)) {
    const to = JSON.parse(k)[0] as string;
    if (!(DOC_NAMES as readonly string[]).includes(to)) inPlace.set(to, [...(inPlace.get(to) ?? []), k]);
  }
  for (const [to, keys] of inPlace) {
    if (!to.startsWith('claude/')) continue;
    const file = path.join(o.claudeDir, to.slice('claude/'.length));
    let text: string;
    try { text = fs.readFileSync(realPath(file), 'utf8'); } catch { continue; }
    let doc: { value: unknown; write: (value: unknown) => string } | undefined;
    try { doc = to.endsWith('.md') ? agentDoc(text) : { value: JSON.parse(text), write: (v) => asJson(v as Doc) }; } catch { /* below */ }
    const value = doc?.value;
    const recorded = new Set(keys.map((k) => JSON.stringify((JSON.parse(k) as Place).slice(1))));
    let [n, left] = [0, !doc];
    for (const k of doc ? keys : []) {
      const at = (JSON.parse(k) as Place).slice(1);
      const v = getAt(value, at);
      const bare = state.bare?.[k]?.value;
      // a copy is taken back at its place, or, moved as by an item added above it, where it alone lies now; a copy also
      // lying where no record puts one, or one gone while its place holds no bare form, leaves the file as changed
      const found = stringPlaces(value).filter((p) => isCopy(state.secrets[k], getAt(value, p)));
      const own = isCopy(state.secrets[k], v);
      if (own || found.length === 1) {
        setAt(value as Doc, own ? at : found[0], bare ?? '');
        n += 1;
      }
      if (own ? found.some((p) => !recorded.has(JSON.stringify(p))) : found.length > 1 || (!found.length && !(typeof v === 'string' && (v === bare || v === '' || isReferenceOnly(v))))) left = true;
    }
    if (doc && n) {
      put(file, Buffer.from(doc.write(doc.value)), (statOf(realPath(file))?.mode ?? 0o600) & 0o777);
      done.push(`took ${what(n, 0)} out of ${file}`);
    }
    if (left) done.push(`left ${file}, which holds keys the mirror copied and changed there since`);
  }
  // another file the mirror wrote holding a ticked key, a plugin's under Claude's folder, goes while it is the copy
  for (const [to, h] of Object.entries(state.keyed ?? {})) {
    if (!to.startsWith('claude/') || inPlace.has(to)) continue;
    const file = path.join(o.claudeDir, to.slice('claude/'.length));
    let bytes: Buffer;
    try { bytes = fs.readFileSync(realPath(file)); } catch { continue; }
    if (!isCopyOf(h, sha256Hex(bytes))) {
      done.push(`left ${file}, which holds keys the mirror copied and changed there since`);
      continue;
    }
    try {
      fs.rmSync(realPath(file), { force: true });
      done.push(`removed ${file}, which held keys the mirror copied`);
    } catch (e) {
      done.push(`could not remove ${file}, which holds keys the mirror copied: ${(e as Error).message}`);
    }
  }
  const blobs = dropBlobs(path.dirname(o.stateFile));
  if (blobs) done.push(`removed ${blobs} mirror ${blobs === 1 ? 'blob' : 'blobs'} left in ${path.dirname(o.stateFile)}`);
  return done;
}
