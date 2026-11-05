import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { z } from 'zod';
import { AgentKind } from '@svall/protocol';
import type { Logger } from '../log.js';
import { BATCH_WIDTH, cleanupDurableTemps, DurableBatch, writeDurable } from '../durable.js';
import { sha256Hex } from '../hash.js';
import { clean, holds } from '../path-tools.js';
import { pool } from '../pool.js';
import { realPath } from '../paths.js';
import { fileSha } from './bundle.js';
import { filesIn } from './docs-sync.js';
import { agentDoc } from './mirror-agents.js';
import { AGENT_FIELDS, configPlace, configRedacted, configSecrets, fieldPlace, getAt, heldServer, isReferenceOnly, parseJsonc, readMirrorVars, relocatedServer, secretsOf, setAt, type Place } from './mirror-config.js';
import { CONFIG_ITEMS } from './mirror-consent.js';
import { entriesOf, isList, ownEntries, parsed, withOwnEntries } from './mirror-lists.js';
import {
  CODEX_MAC_ONLY, CODEX_WORKER_OWNED, Doc, DOC_NAMES, InPlace, isCopy, isCopyOf, isDoc, isNoFile, MANIFEST, mover, OPENCODE_FILES, OPENCODE_WORKER_OWNED, placedIn,
  readState, recordKey, relocated, ROOTS, serverSha, statOf, WORKER_OWNED, type Copied, type DocName, type Homes, type MirrorHomes, type Root, type WorkerState,
} from './mirror-state.js';

// how many times an apply merges a config file again that changed under it
const REMERGES = 3;
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
    secrets: either(state.secrets, next.secrets), whole: either(state.whole ?? {}, next.whole ?? {}), wholeKeys: either(state.wholeKeys ?? {}, next.wholeKeys ?? {}), keyed: either(state.keyed ?? {}, next.keyed ?? {}),
    bare: { ...state.bare, ...next.bare }, ...(next.applied !== undefined && { applied: next.applied }), ...(next.backup && { backup: next.backup }),
    ...(next.listed && { listed: Object.fromEntries(keys(state.listed ?? {}, next.listed).map((k) => [k, [...new Set([...state.listed?.[k] ?? [], ...next.listed?.[k] ?? []])]])) }),
    ...(next.replaced && { replaced: next.replaced }),
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
  unticked: z.array(z.string()).default([]),
  keyed: z.array(z.string()).default([]),
  inPlace: z.array(InPlace).default([]),
});
export type Manifest = z.infer<typeof Manifest>;

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

const held = (at: string): Promise<Buffer | void> => fsp.readFile(at).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });

// as `put`, written in `batch`
async function place(batch: DurableBatch, file: string, data: Buffer, mode: number): Promise<boolean> {
  const at = realPath(file);
  if ((await held(at))?.equals(data)) return false;
  await batch.write(at, data, mode);
  return true;
}

// the newest folder `newBackup` named under `backups`, which a push that finds no record goes on in
const lastBackup = (backups: string): string | undefined => {
  const names = fs.existsSync(backups) ? fs.readdirSync(backups, { withFileTypes: true }).filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}(-\d+)?$/.test(e.name)).map((e) => e.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
  return names.length ? path.join(backups, names[names.length - 1]) : undefined;
};

// a folder under `backups` no earlier push named, by the day here
function newBackup(backups: string): string {
  const day = new Date().toLocaleDateString('en-CA');
  for (let n = 1; ; n++) {
    const dir = path.join(backups, n === 1 ? day : `${day}-${n}`);
    if (!fs.existsSync(dir)) return dir;
  }
}

// copies each of `files` under `dir` by its place under the user's home, on disk before any is touched, answering how many; an
// earlier copy stays, and bytes other than the newest's lie beside it under the next free name. `own` stands in for what the
// file holds. A copy may hold keys, so it is the owner's alone
async function keepCopies(files: { file: string; own?: Buffer }[], dir: string, homedir: string): Promise<number> {
  const fleetHome = path.dirname(path.dirname(dir));
  const batch = new DurableBatch();
  const parents = new Set([fleetHome]);
  const kept = await pool(files, BATCH_WIDTH, async ({ file, own }) => {
    const rel = path.relative(homedir, file);
    const at = path.join(dir, rel.startsWith('..') ? path.join('outside-home', file) : rel);
    const was = own ?? await held(realPath(file));
    if (!was) return false;
    let [to, newest]: [string, string | undefined] = [at, undefined];
    for (let n = 2; fs.existsSync(to); n++) [to, newest] = [`${at}.${n}`, to];
    if (newest && fs.readFileSync(newest).equals(was)) return false;
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    await batch.write(to, was, (fs.statSync(realPath(file)).mode & 0o700) | 0o600);
    for (let d = path.dirname(to); d !== fleetHome && d !== path.dirname(d); d = path.dirname(d)) parents.add(d);
    return true;
  });
  await batch.settle([...parents]);
  return kept.filter(Boolean).length;
}

// a temp a killed write left beside a config file, which may hold a ticked key
const sweepTemps = (o: Homes): void => { for (const d of DOCS) cleanupDurableTemps(path.dirname(realPath(d.at(o))), -Infinity); };

const asJson = (doc: Doc): string => `${JSON.stringify(doc, null, 2)}\n`;

// Svall's own rollback copies of `file`, regular files alone: setup stamps them beside the file as named, the trust seed beside where a link leads
function rollbacksOf(file: string): string[] {
  return [...new Set([file, realPath(file)])].flatMap((f) => {
    const prefix = `${path.basename(f)}.bak-`;
    const entries = fs.existsSync(path.dirname(f)) ? fs.readdirSync(path.dirname(f), { withFileTypes: true }) : [];
    return entries.filter((e) => e.isFile() && e.name.startsWith(prefix) && /^\d{13}$/.test(e.name.slice(prefix.length))).map((e) => path.join(path.dirname(f), e.name));
  });
}
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

const textOf = (file: string): string | undefined => {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) {
    if (isNoFile(e)) return undefined;
    throw e;
  }
};

// a config file's object from its text, or undefined for none; one that holds no object stops the mirror, named without what it holds
function docIn(file: string, text: string | undefined, parse: (text: string) => unknown): Doc | undefined {
  if (text === undefined) return undefined;
  let doc: unknown;
  try { doc = parse(text); } catch { /* named below */ }
  if (!isDoc(doc)) throw new Error(`${file} cannot be parsed, so the mirror left this machine's agent configuration as it was`);
  return doc;
}

const readDocFile = (file: string, parse: (text: string) => unknown): Doc | undefined => docIn(file, textOf(file), parse);

const overlay = (a: unknown, b: unknown): unknown =>
  isDoc(a) && isDoc(b) ? { ...a, ...Object.fromEntries(Object.entries(b).map(([k, v]) => [k, overlay(a[k], v)])) } : b;

// `keeps`: a target that keeps its own holds no override of a server it no longer has, as one alone can be a config its agent
// refuses, unless the override names what the server runs
function overrideOver(d: DocSpec, doc: Doc, override: Doc | undefined, keeps = false): void {
  for (const [k, v] of Object.entries(override ?? {})) {
    if (k !== d.servers) {
      if (!d.serversOnly) doc[k] = v;
      continue;
    }
    const over = keeps && isDoc(v) ? Object.fromEntries(Object.entries(v).filter(([name, o]) => getAt(doc, [k, name]) !== undefined || (isDoc(o) && (o.command !== undefined || o.url !== undefined)))) : v;
    if (!keeps || Object.keys(over as Doc).length) doc[k] = overlay(doc[k], over);
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
 * A secret value's place in a doc: `entry` the record key of the entry it lies in; `want` the Mac's if ticked, else `bare`; `ownable`
 * when what it held may be the worker's own on a target that keeps none by the entry: the place is the value itself, not a url or arg
 * holding it, or this merge did not write over it; `sparesOwn` when a tick stays off that; `server` its Codex server.
 */
type Leaf = { record: string; entry: string; place: Place; want?: string; bare?: string; ownable: boolean; sparesOwn?: true; server?: Place };

// whether record `k` is the entry at record key `rk` or lies in it
export const under = (k: string, rk: string): boolean => k === rk || k.startsWith(`${rk.slice(0, -1)},`);

// whether `v`, in the entry at record key `rk`, is what the mirror copied: a key recorded in that entry, wherever it lies now, or a string of one copied whole
const mirrors = (state: WorkerState, rk: string, v: unknown): boolean => typeof v === 'string'
  && (isCopy(state.wholeKeys?.[rk], v) || Object.keys(state.secrets).some((k) => under(k, rk) && isCopy(state.secrets[k], v)));

// `v` at the leaf; a Codex env value not set is named in its server's env_vars instead, and only then
function setLeaf(doc: Doc, l: Pick<Leaf, 'place' | 'server'>, v: string | undefined): void {
  setAt(doc, l.place, v);
  if (!l.server) return;
  const name = String(l.place[l.place.length - 1]);
  const names = getAt(doc, [...l.server, 'env_vars']);
  const rest = (Array.isArray(names) ? names : []).filter((n: unknown) => n !== name && !(isDoc(n) && n.name === name));
  setAt(doc, [...l.server, 'env_vars'], v === undefined ? [...rest, name] : rest.length ? rest : undefined);
}

// a ticked value is the Mac's unless it would go over the worker's own; a copy is emptied once unticked; the worker's own goes
// back where the merge wrote over it. `next` keeps a copy while its place holds it or its bare form. A target that keeps its own
// does so by the whole entry, ahead of this, so nothing here is its own, and a value it held before the mirror wrote it is no copy
function settle(doc: Doc, was: Doc, l: Leaf, recorded: Copied | undefined, { state, next, keeps, lost }: Applying): void {
  const pre = getAt(was, l.place);
  const copied = keeps ? mirrors(state, l.entry, pre) : isCopy(recorded, pre);
  const own = !keeps && typeof pre === 'string' && pre !== '' && pre !== l.bare && !copied && l.ownable;
  const now = getAt(doc, l.place);
  const keep = (h: Copied): void => {
    next.secrets[l.record] = h;
    (next.bare ??= {})[l.record] = { ...(l.bare !== undefined && { value: l.bare }), ...(l.server && { envVar: true as const }) };
  };
  if (l.want !== undefined && !(l.sparesOwn && own)) {
    if (now !== l.want) setLeaf(doc, l, l.want);
    if (!keeps || lost || copied || pre !== l.want) keep(sha256Hex(l.want));
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
 * Puts the mirror at `blobDir` into this machine's homes. With `backups`, each file the record does not name is copied first,
 * all before anything is written, into one folder, and the apply answers it when this one kept any. A record of all it may
 * write goes next, so an apply cut short still knows each copy it left, the final one last; files go off the event loop, a few
 * at once, so the link is answered meanwhile. `additive`: a worker's Copy, which removes nothing here but a whole item an untick took back.
 */
export async function applyMirror(
  blobDir: string, o: MirrorHomes & { overrides: string; stateFile: string; varsFile: string; seq?: number; backups?: string; additive?: boolean; refuse?: (m: Manifest, files: string[]) => void; log?: Pick<Logger, 'error'> },
): Promise<{ written: string[]; removed: string[]; backup?: string; replaced?: string[]; left?: string[] }> {
  const m = Manifest.parse(JSON.parse(fs.readFileSync(path.join(blobDir, MANIFEST), 'utf8')));
  const state = readState(o.stateFile);
  const applied = o.seq ?? state.applied;
  const keeps = o.backups !== undefined;
  const earlier = o.backups !== undefined && !state.backup ? lastBackup(o.backups) : undefined;
  const lost = earlier !== undefined && !Object.keys({ ...state.files, ...state.servers, ...state.docs }).length;
  const backup = o.backups === undefined ? state.backup : { dir: state.backup?.dir ?? earlier ?? newBackup(o.backups) };
  const next: WorkerState = { files: {}, docs: {}, servers: {}, secrets: {}, ...(applied !== undefined && { applied }), ...(backup && { backup }), ...(state.listed && { listed: { ...state.listed } }), ...(state.replaced && { replaced: state.replaced }) };
  const written: string[] = [];
  const removed: string[] = [];
  const left: string[] = [];
  const move = mover(m.homes, o);
  const applying: Applying = { m, state, next, move, additive: o.additive === true, keeps, lost };
  const sent = (Object.keys(ROOTS) as Root[]).flatMap((root) => {
    const home = o[ROOTS[root]];
    return home ? filesIn(path.join(blobDir, root)).map((rel) => ({ root, home, rel, to: path.posix.join(root, rel), from: path.join(blobDir, root, rel) })) : [];
  });
  o.refuse?.(m, sent.map((f) => f.to));
  // a link to a keyed file no longer the copy is the person's: nothing writes through it, and its record stays, until they remove the link
  const editedLink = async (to: string, file: string): Promise<boolean> => keeps && state.keyed?.[to] !== undefined && fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() === true
    && statOf(file)?.isFile() === true && !isCopyOf(state.keyed[to], await fileSha(realPath(file)).catch(() => undefined));
  const edited = await pool(sent, BATCH_WIDTH, (f) => editedLink(f.to, path.join(f.home, f.rel)));
  const frozen = new Set(sent.filter((_, i) => edited[i]).map((f) => f.to));
  const carried = sent.filter((f) => !frozen.has(f.to));
  sweepTemps(o);
  // read before anything is written: a config file or override that cannot be parsed stops the mirror rather than be replaced
  const current = DOCS.map((d) => {
    const text = textOf(d.at(o));
    return { text, doc: docIn(d.at(o), text, d.parse), override: readDocFile(path.join(o.overrides, d.override), d.parse) };
  });
  const docs = DOCS.map((d, i) => applyDoc(d, current[i].doc, current[i].override, applying));
  const shas = await pool(carried, BATCH_WIDTH, (f) => fileSha(f.from));
  carried.forEach((f, i) => { next.files[f.to] = shas[i]; });
  for (const f of carried.filter((x) => keeps && isList(x.to))) (next.listed ??= {})[f.to] = Object.keys(entriesOf(f.to, JSON.parse(fs.readFileSync(f.from, 'utf8'))));
  for (const to of m.keyed) {
    const h = next.files[to] ?? state.files[to];
    if (h) (next.keyed ??= {})[to] = h;
  }
  // a key in a file the agent needs is recorded by its place there, as a doc's is; an override stands there instead
  for (const f of m.inPlace) {
    if (fs.existsSync(path.join(o.overrides, f.to)) || frozen.has(f.to)) continue;
    for (const p of f.places) {
      const k = JSON.stringify([f.to, ...p.place]);
      next.secrets[k] = p.sha;
      (next.bare ??= {})[k] = { value: p.bare };
    }
  }
  const docOverrides = new Set(DOCS.map((d) => d.override));
  const overrides = (Object.keys(ROOTS) as Root[]).flatMap((root) => {
    const home = o[ROOTS[root]];
    return home ? filesIn(path.join(o.overrides, root)).filter((rel) => !docOverrides.has(path.posix.join(root, rel))).map((rel) => ({ to: path.posix.join(root, rel), from: path.join(o.overrides, root, rel), file: path.join(home, rel) })) : [];
  });
  const batch = new DurableBatch();
  // a file a tick goes over is kept with what the mirror copied there taken out, and each place noted
  const overIn = (i: number) => ({ file: DOCS[i].at(o), own: Buffer.from(ownText(DOCS[i], current[i].text ?? '', state)) });
  const noteOver = (): void => { if (docs.some((d) => d.over.length)) next.replaced = [...new Set([...state.replaced ?? [], ...docs.flatMap((d) => d.over)])]; };
  let kept = 0;
  if (o.backups !== undefined && backup) {
    const unnamed = (to: string): boolean => !Object.hasOwn(state.files, to);
    const replaced = await pool(overrides.filter((f) => unnamed(f.to) && !Object.hasOwn(next.files, f.to)), BATCH_WIDTH, async (f) => ((await held(realPath(f.file)))?.equals(await fsp.readFile(f.from)) === false ? [f.file] : []));
    const first = [
      ...DOCS.flatMap((d, i) => (docs[i].over.length ? [overIn(i)] : current[i].doc && !namesDoc(state, d.name) && (docs[i].doc || namesDoc(next, d.name)) ? [{ file: d.at(o) }] : [])),
      ...[...carried.filter((f) => unnamed(f.to)).map((f) => path.join(f.home, f.rel)), ...replaced.flat()].map((file) => ({ file })),
    ];
    // a push cut short while it copies goes on in the same folder, and has written nothing else
    if (first.length && !state.backup) {
      await place(batch, o.stateFile, Buffer.from(asJson({ ...state, backup })), 0o600);
      await batch.settle();
    }
    kept = await keepCopies(first, backup.dir, o.homedir);
    noteOver();
  }
  await place(batch, o.stateFile, Buffer.from(asJson(provisional(state, next))), 0o600);
  await batch.settle();
  const fileOf = (to: string): string | undefined => {
    const [root, ...rest] = to.split('/');
    const home = Object.hasOwn(ROOTS, root) ? o[ROOTS[root as Root]] : undefined;
    return home && path.join(home, ...rest);
  };

  // a config file holding a ticked key is its owner's alone, whether or not this apply changed it
  for (const [i, d] of DOCS.entries()) {
    // what an agent wrote there since it was read stays, as Claude Code writes its login to .claude.json as it runs
    for (let tries = 0, text = textOf(d.at(o)); keeps && text !== current[i].text && tries < REMERGES; tries++, text = textOf(d.at(o))) {
      current[i].text = text;
      forgetDoc(next, d.name);
      docs[i] = applyDoc(d, docIn(d.at(o), text, d.parse), current[i].override, applying);
      if (o.backups !== undefined && backup && docs[i].over.length) {
        kept += await keepCopies([overIn(i)], backup.dir, o.homedir);
        noteOver();
      }
    }
    const { doc, keyed } = docs[i];
    if (doc && await place(batch, d.at(o), Buffer.from(d.format(doc)), keyed ? 0o600 : (statOf(d.at(o))?.mode ?? 0o600) & 0o777)) written.push(d.at(o));
    if (keyed) ownerOnly(d.at(o));
  }
  const changed = carried.filter((f) => state.files[f.to] !== next.files[f.to]);
  const wrote = await pool(changed, BATCH_WIDTH, async ({ root, home, rel, to, from }) => {
    const data = await fsp.readFile(from);
    const override = path.join(o.overrides, root, rel);
    const file = path.join(home, rel);
    const moved = (): Doc => relocated(JSON.parse(data.toString('utf8')), move) as Doc;
    const bytes = fs.existsSync(override) ? await fsp.readFile(override) : !isList(to) ? data : Buffer.from(asJson(keeps ? withOwnEntries(to, moved(), parsed(await held(realPath(file))), applying) : moved()));
    return await place(batch, file, bytes, fs.statSync(from).mode & 0o777) ? file : undefined;
  });
  written.push(...wrote.filter((f) => f !== undefined));
  const staying = new Set(m.keep);
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
    const file = fileOf(to);
    const copy = file !== undefined && isCopyOf(state.keyed?.[to], await fileSha(realPath(file)).catch(() => undefined));
    // a Copy removes nothing but a keyed file its sender lists as unticked, while it is still the copy
    const takenBack = o.additive && m.unticked.includes(to) && copy;
    const link = file !== undefined && await editedLink(to, file);
    const stays = (o.additive && !takenBack) || unread(to) || link;
    if (file !== undefined && state.keyed?.[to] && !copy && statOf(realPath(file)) && (link || (o.additive && m.unticked.includes(to)))) left.push(file);
    if (staying.has(to) || stays) {
      next.files[to] = h;
      if (stays && state.keyed?.[to]) (next.keyed ??= {})[to] = state.keyed[to];
      for (const k of Object.keys(state.secrets).filter((x) => stays && JSON.parse(x)[0] === to)) {
        next.secrets[k] = state.secrets[k];
        if (state.bare?.[k]) (next.bare ??= {})[k] = state.bare[k];
      }
      continue;
    }
    delete next.listed?.[to];
    if (!file || !fs.lstatSync(file, { throwIfNoEntry: false })) continue;
    // a list the home no longer has leaves what this machine's own plugins need of it
    const list = keeps && isList(to) ? withOwnEntries(to, {}, parsed(await held(realPath(file))), applying) : {};
    if (Object.keys(entriesOf(to, list)).length) {
      await place(batch, file, Buffer.from(asJson(list)), (statOf(realPath(file))?.mode ?? 0o600) & 0o777);
      continue;
    }
    // a key the mirror wrote through a link lies where the link leads, while what lies there is still the copy
    if (keeps && copy) await fsp.rm(realPath(file), { force: true });
    await fsp.rm(file, { force: true });
    removed.push(file);
  }
  // a file holding a ticked key is its owner's alone, whether or not this apply wrote it
  for (const to of Object.keys(next.keyed ?? {})) {
    const file = fileOf(to);
    if (file) ownerOnly(file);
  }
  // the overrides of whole files, each over what the mirror wrote there
  for (const { from, file } of overrides) {
    if (await place(batch, file, await fsp.readFile(from), fs.statSync(from).mode & 0o777)) written.push(file);
  }

  // a Copy leaves each server it does not name, and so what those read
  const vars = o.additive ? [...new Set([...readMirrorVars(o.varsFile), ...m.vars])] : m.vars;
  await place(batch, o.varsFile, Buffer.from(`${JSON.stringify(vars, null, 2)}\n`), 0o644);
  await batch.settle();
  removed.push(...await dropRollbacks([state, next], o, (file, e) => o.log?.error(`mirror: the rollback copy ${file} was left: ${e.message}`)));
  await place(batch, o.stateFile, Buffer.from(asJson(next)), 0o600);
  await batch.settle();
  const over = [...new Set(docs.flatMap((d) => d.over))].map(entryName);
  left.push(...docs.flatMap((d) => d.left));
  return { written, removed, ...(kept > 0 && backup && { backup: backup.dir }), ...(over.length > 0 && { replaced: over }), ...(left.length > 0 && { left }) };
}

// `keeps`: a target that keeps its own entries, a Mac or a dial-out worker or a home taking a Copy; `lost`: one that found no
// record beside a backup, so what it holds is not known for its own
type Applying = { m: Manifest; state: WorkerState; next: WorkerState; move: (p: string) => string; additive: boolean; keeps: boolean; lost: boolean };

// what each doc's servers and keys are, as the record keeps them
const AGENT_OF: Record<DocName, AgentKind> = { 'settings.json': 'claude', '.claude.json': 'claude', 'config.toml': 'codex', 'opencode.json': 'opencode', 'opencode.jsonc': 'opencode' };
const inDoc = (of: Record<string, unknown> | undefined, name: string): string[] => Object.keys(of ?? {}).filter((k) => JSON.parse(k)[0] === name);
// whether the record holds anything of doc `name`, as it does once the mirror has merged into it
const namesDoc = (r: WorkerState, name: DocName): boolean => Object.keys(r.docs[name] ?? {}).length > 0 || [r.servers, r.secrets, r.whole].some((of) => inDoc(of, name).length > 0);
function forgetDoc(r: WorkerState, name: DocName): void {
  delete r.docs[name];
  for (const of of [r.servers, r.secrets, r.whole, r.wholeKeys, r.bare]) for (const k of inDoc(of, name)) delete of![k];
}

// the entry a key at `place` belongs to, which a target keeps or a tick replaces whole: a table under a top-level key, or that key's
// value where one of `docs` holds no table there
const entryOf = (place: Place, ...docs: Doc[]): Place => (place.length === 1 || docs.some((d) => d[place[0]] !== undefined && !isDoc(d[place[0]])) ? place.slice(0, 1) : place.slice(0, 2));
// by what they hold, whatever order it lies in; a value canonical JSON cannot hold by its text
const same = (a: unknown, b: unknown): boolean => (serverSha(a) ?? JSON.stringify(a)) === (serverSha(b) ?? JSON.stringify(b));
const overlap = (a: Place, b: Place): boolean => a.slice(0, b.length).every((k, i) => k === b[i]);
const isTable = (v: unknown): boolean => isDoc(v) && Object.values(v).every(isDoc);

// each place in server entry `entry` of a key the target holds itself: a literal no record names a copy
export function ownKeys(agent: AgentKind, entry: Doc, rk: string, state: WorkerState): Place[] {
  if (isCopyOf(state.whole?.[rk], serverSha(entry))) return [];
  return secretsOf(heldServer(agent, entry)).flatMap(({ field }) => fieldPlace(agent, entry, field))
    .filter((p) => !mirrors(state, rk, getAt(entry, p)));
}

// whether server entry `held` is the person's, whatever its sender holds: a copy made whole and edited since, or of a shape the mirror writes only whole
export const isTheirs = (agent: AgentKind, held: Doc, rk: string, state: WorkerState): boolean =>
  (state.whole?.[rk] !== undefined ? !isCopyOf(state.whole[rk], serverSha(held)) : !heldServer(agent, held).known);

// what a target's row calls the entry at record key `rk`
export const entryName = (rk: string): string => (JSON.parse(rk) as string[]).slice(1).join('.').replace(/^(mcpServers|mcp_servers|mcp)\./, '');

// one config file as the mirror leaves it, none when unchanged, and whether it holds a ticked value; one the Mac could not
// read keeps its record
function applyDoc(d: DocSpec, current: Doc | undefined, override: Doc | undefined, applying: Applying): { doc?: Doc; keyed: boolean; over: string[]; left: string[] } {
  const { m, state, next, move, additive, keeps, lost } = applying;
  // where a tick goes over what the target held itself, and the places that tell whether it did
  const overs: { record: string; place: Place }[] = [];
  // a whole server copied and edited since, which stays
  const left: string[] = [];
  const doc: Doc = current ?? structuredClone(d.empty ?? {});
  const before = JSON.stringify(doc);
  const was = structuredClone(doc);
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
    const tickedFields = (config?.ticked ?? []).filter((f) => fields.includes(f));
    const bare = configRedacted(ticked, tickedFields);
    bareDoc = bare;
    const recorded = state.docs[d.name] ?? {};
    const shas: Record<string, string> = {};
    const tableOf = (k: string): string => `${d.name}#${k}`;
    // what this target keeps of `k` under the sender's `v`: in a table of entries, or a plugin's enabling, what the mirror did not write; a Copy removes nothing
    const ownTable = (k: string, v?: unknown): Doc => (isDoc(doc[k]) && (additive || k === 'enabledPlugins' || (isTable(doc[k]) && (v === undefined || isTable(v))))
      ? ownEntries(tableOf(k), doc[k], Object.hasOwn(recorded, k), applying) : {});
    for (const [k, v] of Object.entries(bare)) {
      if (d.owned.includes(k)) continue;
      shas[k] = sha(v);
      const table = keeps && isDoc(v);
      if (table) (next.listed ??= {})[tableOf(k)] = Object.keys(v);
      if (recorded[k] === shas[k]) continue;
      doc[k] = table ? { ...ownTable(k, v), ...structuredClone(v) } : structuredClone(v);
      remergedKeys.add(k);
    }
    for (const k of Object.keys(recorded)) {
      if (Object.hasOwn(shas, k) || d.owned.includes(k)) continue;
      if (additive) shas[k] = recorded[k];
      else if (keeps && Object.keys(ownTable(k)).length) doc[k] = ownTable(k);
      else delete doc[k];
      if (keeps) delete next.listed?.[tableOf(k)];
    }
    // the entry that holds a key of the target's own stays whole while the sender's is unticked; a tick replaces it whole, the
    // file copied first, as it does an entry where a key lands over another value, with no copy, as a rotation lands so too
    const tickedPlaces = keeps ? tickedFields.flatMap((f) => configPlace(ticked, f)) : [];
    const going = tickedPlaces.filter((p) => getAt(was, p) !== getAt(ticked, p)).map((p) => entryOf(p, ticked));
    const heldKeys = !keeps ? [] : configSecrets(AGENT_OF[d.name], Object.fromEntries(Object.entries(was).filter(([k]) => !d.owned.includes(k))))
      .flatMap((f) => configPlace(was, f.field)).filter((p) => !mirrors(state, recordKey(d.name, entryOf(p, was)), getAt(was, p)));
    for (const p of heldKeys) {
      const entry = entryOf(p, was, bare);
      const over = tickedPlaces.map((t) => entryOf(t, ticked)).find((t) => overlap(t, entry));
      if (over) {
        going.push(over);
        overs.push({ record: recordKey(d.name, entry), place: entry });
      } else setAt(doc, entry, structuredClone(getAt(was, entry)));
    }
    for (const entry of going) setAt(doc, entry, structuredClone(getAt(bare, entry)));
    next.docs[d.name] = shas;
    for (const g of leavesOf(fields, (f) => configPlace(ticked, f))) {
      leaves.push({
        record: recordKey(d.name, g.place), entry: recordKey(d.name, entryOf(g.place, ticked)), place: g.place, want: g.fields.some((f) => config?.ticked.includes(f)) ? getAt(ticked, g.place) as string : undefined,
        bare: getAt(bare, g.place) as string, ownable: g.fields.every((f) => f === g.place.join('.')) || !remergedKeys.has(String(g.place[0])),
      });
    }
  }
  // Claude's env, which the worker owns: on a Linux worker its home dials, a ticked key never over one the worker set itself
  if (d.name === 'settings.json') {
    for (const f of config?.fields ?? []) {
      if (!f.startsWith('env.')) continue;
      const k = f.slice('env.'.length);
      const holds = getAt(was, ['env', k]);
      const going = config?.ticked.includes(f) && typeof holds === 'string' && holds !== '' && !isReferenceOnly(holds) && !isCopy(state.secrets[recordKey(d.name, ['env', k])], holds);
      if (keeps && going) overs.push({ record: recordKey(d.name, ['env', k]), place: ['env', k] });
      leaves.push({
        record: recordKey(d.name, ['env', k]), entry: recordKey(d.name, ['env', k]), place: ['env', k], want: config?.ticked.includes(f) ? m.settingsEnv[k] : undefined, ownable: true, sparesOwn: true,
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
    const holds = getAt(doc, at);
    // a server ticked whole carries its fields as they are, keys among them
    const whole = !s.secretFields.length && s.ticked.length ? serverSha(bare) : undefined;
    const own = keeps && isDoc(holds) ? ownKeys(s.agent, holds, rk, state) : [];
    const theirs = keeps && !lost && isDoc(holds) && isTheirs(s.agent, holds, rk, state);
    const groups = leavesOf(s.secretFields, (f) => fieldPlace(s.agent, s.entry, f));
    const ticked = (g: { fields: string[] }): boolean => g.fields.some((f) => s.ticked.includes(f));
    carried.push({ place: s.place, at, bare, codex: s.agent === 'codex' });
    // the very one ticked whole, or an entry of the target's own the sender's unticked: it stays whole, the mirror's no longer
    if (keeps && !lost && isDoc(holds) && state.servers[rk] === undefined && whole && serverSha(holds) === whole) continue;
    if (!s.ticked.length && (own.length || theirs)) continue;
    if (own.length || theirs) overs.push({ record: rk, place: at });
    servers[rk] = sha(bare);
    if (whole) {
      (next.whole ??= {})[rk] = whole;
      (next.wholeKeys ??= {})[rk] = [...new Set(stringsIn(bare))].map(sha256Hex);
    }
    // a tick replaces the entry whole, so a key lands by the sender's form of it
    const landing = keeps && (own.length > 0 || groups.some((g) => ticked(g) && !same(getAt(holds, g.place), getAt(entry, g.place))));
    const remerged = state.servers[rk] !== servers[rk] || holds === undefined || landing;
    if (remerged) setAt(doc, at, structuredClone(bare));
    for (const g of groups) {
      leaves.push({
        record: recordKey(d.name, [...s.place, ...g.place]), entry: rk, place: [...at, ...g.place],
        want: ticked(g) ? getAt(entry, g.place) as string : undefined, bare: getAt(bare, g.place) as string | undefined,
        ownable: !g.fields.some((f) => f.startsWith('url') || f.startsWith('args[')) || !remerged,
        ...(s.agent === 'codex' && g.place[0] === 'env' && { server: at }),
      });
    }
  }
  for (const [rk, h] of records(state.servers)) {
    if (Object.hasOwn(servers, rk)) continue;
    const at = placed((JSON.parse(rk) as Place).slice(1));
    const holds = getAt(doc, at);
    const edited = keeps && isDoc(holds) && state.whole?.[rk] !== undefined && !isCopyOf(state.whole[rk], serverSha(holds));
    // a Copy removes nothing but a whole server its sender lists as unticked, while it is still the copy
    const takenBack = additive && m.servers.some((x) => x.doc === d.name && recordKey(d.name, x.place) === rk) && (!isDoc(holds) || isCopyOf(state.whole?.[rk], serverSha(holds)));
    if (leave || edited || (additive && !takenBack)) {
      // one edited matches no sender's form, so a later tick replaces it, the file copied first
      servers[rk] = edited && !leave ? UNSURE : h;
      if (state.whole?.[rk]) (next.whole ??= {})[rk] = state.whole[rk];
      if (state.wholeKeys?.[rk]) (next.wholeKeys ??= {})[rk] = state.wholeKeys[rk];
      if (edited && holdsWholeKey(AGENT_OF[d.name], holds, rk, state)) left.push(entryName(rk));
    } else if (!(keeps && isDoc(holds) && (ownKeys(AGENT_OF[d.name], holds, rk, state).length || isTheirs(AGENT_OF[d.name], holds, rk, state)))) setAt(doc, at, undefined);
  }
  Object.assign(next.servers, servers);

  for (const l of leaves) settle(doc, was, l, state.secrets[l.record], applying);
  // a value copied where the Mac now holds no secret is emptied as that place stands bare, while it is still the copy; a Copy
  // keeps the record of one its sender no longer lists
  const lists = (k: string): boolean => leaves.some((l) => l.record === k) || m.servers.some((x) => x.doc === d.name && under(k, recordKey(d.name, x.place)));
  for (const [k, h] of records(state.secrets)) {
    if (leave || (additive && !lists(k))) {
      next.secrets[k] ??= h;
      if (state.bare?.[k]) (next.bare ??= {})[k] ??= state.bare[k];
    }
    if (leave || Object.hasOwn(next.secrets, k)) continue;
    const place = (JSON.parse(k) as Place).slice(1);
    const s = carried.find((c) => c.place.every((p, i) => place[i] === p));
    const leaf = s ? place.slice(s.place.length) : place;
    const l: Pick<Leaf, 'place' | 'server'> = { place: s ? [...s.at, ...leaf] : placed(place), ...(s?.codex && leaf[0] === 'env' && { server: s.at }) };
    const bare = (s ? getAt(s.bare, leaf) : getAt(bareDoc, place)) as string | undefined;
    const parentAt = l.place.slice(0, -1);
    const parent = getAt(doc, parentAt);
    // an array has no key to remove, and an entry a target keeps may require what lies here, so each takes the bare form
    const emptied = keeps && !l.server && !(d.name === 'settings.json' && place[0] === 'env') ? state.bare?.[k]?.value ?? '' : Array.isArray(parent) ? '' : undefined;
    if (isCopy(h, getAt(doc, l.place))) setLeaf(doc, l, bare ?? emptied);
    // a copy the person moved in its list or table is still the copy
    else if (keeps) for (const [n, v] of Object.entries(parent ?? {})) if (isCopy(h, v)) setAt(doc, [...parentAt, Array.isArray(parent) ? Number(n) : n], emptied);
  }

  overrideOver(d, doc, override, keeps);
  const keyed = leaves.some((l) => l.want !== undefined) || m.servers.some((x) => x.doc === d.name && Object.keys(x.entry).length > 0 && x.ticked.length > 0);
  // an override may stand where a tick would go over
  const over = overs.filter((o) => !same(getAt(doc, o.place), getAt(was, o.place))).map((o) => o.record);
  return JSON.stringify(doc) === before ? { keyed, over, left } : { doc, keyed, over, left };
}

// config file `d` as it stands in `text` with what the mirror copied there taken out, as a backup holds no key it copied
function ownText(d: DocSpec, text: string, state: WorkerState): string {
  const doc = d.parse(text) as Doc;
  const was = JSON.stringify(doc);
  // a server still as the mirror copied it whole goes; each copied string goes from what else holds one, a config entry too
  const servers = inDoc(state.servers, d.name);
  const configs = inDoc(state.secrets, d.name).filter((k) => !servers.some((r) => under(k, r))).map((k) => recordKey(d.name, entryOf((JSON.parse(k) as Place).slice(1), doc)));
  for (const k of new Set([...servers, ...configs])) {
    for (const at of placesIn(d, doc, k)) {
      const places = stringPlaces(getAt(doc, at));
      const copied = places.filter((p) => mirrors(state, k, getAt(doc, [...at, ...p])));
      if (isCopyOf(state.whole?.[k], serverSha(getAt(doc, at)))) setAt(doc, at, undefined);
      else for (const p of copied) setAt(doc, [...at, ...p], '');
    }
  }
  return JSON.stringify(doc) === was ? text : d.format(doc);
}

// a Claude project lies under this machine's own path of it, which the record does not keep
const placesIn = (d: DocSpec, doc: Doc, k: string): Place[] => {
  const place = (JSON.parse(k) as Place).slice(1);
  return d.name === '.claude.json' && place[0] === 'projects' ? Object.keys(isDoc(doc.projects) ? doc.projects : {}).map((p) => ['projects', p, ...place.slice(2)]) : [place];
};

// what in a server copied whole could be a key: a secret field's string, or any string of a field the mirror cannot read
const keyStrings = (agent: AgentKind, held: Doc): unknown[] => [
  ...secretsOf(heldServer(agent, held)).flatMap(({ field }) => fieldPlace(agent, held, field)).map((p) => getAt(held, p)),
  ...Object.keys(held).filter((f) => !AGENT_FIELDS[agent].includes(f)).flatMap((f) => [...stringsIn(held[f])]),
];

// whether `held`, at record key `rk` of a server copied whole, may hold a key copied with it; a record naming none of its strings cannot tell
export const holdsWholeKey = (agent: AgentKind, held: Doc, rk: string, state: WorkerState): boolean => state.whole?.[rk] !== undefined
  && (state.wholeKeys?.[rk] === undefined || keyStrings(agent, held).some((v) => isCopy(state.wholeKeys?.[rk], v)));

// each string under `v`, one by one, as a .claude.json may hold a great many
function* stringsIn(v: unknown): Generator<string> {
  if (typeof v === 'string') yield v;
  else if (typeof v === 'object' && v !== null) for (const x of Object.values(v)) yield* stringsIn(x);
}

/**
 * Removes each rollback copy of a config file that holds a value the records say the mirror copied and the file itself no longer
 * holds, so an untick reaches it, and answers them. One that cannot be parsed is left, as nothing says what it holds, and one
 * that cannot be read or removed goes to `failed`. It lets the event loop on between strings.
 */
async function dropRollbacks(records: WorkerState[], o: Homes, failed: (file: string, e: Error) => void): Promise<string[]> {
  const copied = new Set(records.flatMap((r) => [...Object.values(r.secrets), ...Object.values(r.whole ?? {})].flat()));
  const wholeKeys = new Set(records.flatMap((r) => Object.values(r.wholeKeys ?? {}).flat()));
  const gone: string[] = [];
  if (!copied.size) return gone;
  for (const d of DOCS) {
    try {
      const files = rollbacksOf(d.at(o));
      if (!files.length) continue;
      const whole = [...new Set(records.flatMap((r) => inDoc(r.whole, d.name)))];
      // each string and whole server `file` holds, and which of those the mirror copied; a server copied whole may be edited since, so its keys count one by one
      const shasIn = async (file: string): Promise<{ shas: Set<string>; keys: Set<string> }> => {
        const doc = docIn(file, (await held(file))?.toString('utf8'), d.parse);
        const shas = new Set<string>();
        let n = 0;
        for (const v of stringsIn(doc)) {
          shas.add(sha256Hex(v));
          if (++n % 1000 === 0) await new Promise(setImmediate);
        }
        const keys = new Set<string>();
        for (const at of doc ? whole.flatMap((k) => placesIn(d, doc, k)) : []) {
          shas.add(serverSha(getAt(doc, at)) ?? '');
          const entry = getAt(doc, at);
          for (const v of isDoc(entry) ? keyStrings(AGENT_OF[d.name], entry) : []) if (typeof v === 'string' && wholeKeys.has(sha256Hex(v))) keys.add(sha256Hex(v));
        }
        for (const h of shas) if (copied.has(h)) keys.add(h);
        return { shas, keys };
      };
      let live: Set<string>;
      try { live = (await shasIn(d.at(o))).shas; } catch { continue; }
      for (const file of files) {
        let keys: Set<string>;
        try { ({ keys } = await shasIn(file)); } catch { continue; }
        if (![...keys].some((h) => !live.has(h))) continue;
        try {
          await fsp.rm(file, { force: true });
          gone.push(file);
        } catch (e) { failed(file, e as Error); }
      }
    } catch (e) { failed(d.at(o), e as Error); }
  }
  return gone;
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
export async function takeBackCopies(o: Homes & { stateFile: string }): Promise<string[]> {
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
    setLeaf(doc as Doc, { place: at, ...(server && { server }) }, bare ? bare.value : '');
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
    const places = (k: string): Place[] => placesIn(d, doc!, k);
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
  sweepTemps(o);
  const dropped = await dropRollbacks([state], o, (f, e) => done.push(`could not remove ${f}, a rollback copy that holds keys the mirror copied: ${e.message}`));
  for (const f of dropped) done.push(`removed ${f}, a rollback copy that held keys the mirror copied`);
  const blobs = dropBlobs(path.dirname(o.stateFile));
  if (blobs) done.push(`removed ${blobs} mirror ${blobs === 1 ? 'blob' : 'blobs'} left in ${path.dirname(o.stateFile)}`);
  return done;
}
