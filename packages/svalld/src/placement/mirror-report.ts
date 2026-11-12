import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AgentKind, NOT_NEEDED, type SetupRow } from '@svall/protocol';
import { isExecutable, onPath } from '../agents.js';
import { readEnvFile } from '../claude.js';
import { sha256Hex } from '../hash.js';
import { homeWord } from '../machine.js';
import { clean, holds } from '../path-tools.js';
import { configNeeds, configPlace, configRedacted, FIELD_PATHS, fieldPlace, getAt, heldServer, needsOf, relocatedServer, VAR_REF } from './mirror-config.js';
import { CONFIG_ITEMS, fieldKey } from './mirror-consent.js';
import { docWithOverride, holdsWholeKey, isTheirs, ownKeys, under } from './mirror-apply.js';
import type { MirroredServer, MirrorPlan } from './mirror-plan.js';
import { DOC_NAMES, isCopy, mover, placedIn, readState, recordKey, relocated, type DocName, type MirrorHomes } from './mirror-state.js';

// how a Linux worker gets the runtime a server's command names
const INSTALL_RUN: Record<string, string> = {
  node: 'sudo apt install nodejs npm', npx: 'sudo apt install nodejs npm', bun: 'curl -fsSL https://bun.sh/install | bash',
  uvx: 'curl -LsSf https://astral.sh/uv/install.sh | sh', uv: 'curl -LsSf https://astral.sh/uv/install.sh | sh', docker: 'sudo apt install docker.io', python3: 'sudo apt install python3',
};

const Place = z.array(z.union([z.string(), z.number()]));
const CHECK_AGAIN = 'Check again';
const UNCOPIED = 'not copied: Svall does not copy this file';
// where an item lies on the worker: in config file `doc`, or in the file the mirror writes whole landing at `file`, at
// `place` as the Mac holds it
const Where = { doc: z.enum(DOC_NAMES).optional(), file: z.string().optional(), place: Place };
/** An item with keys: `bare` what the mirror carries at its place with every key emptied, and each secret field's leaf under it. */
const Keyed = z.object({ item: z.string(), ...Where, bare: z.record(z.string(), z.unknown()), fields: z.array(z.object({ field: z.string(), leaf: Place })) });
/** An item the mirror carries whole once ticked, and the fields it holds at its place. */
const Whole = z.object({ item: z.string(), ...Where, fields: z.array(z.string()) });
type Keyed = z.infer<typeof Keyed>;
type Whole = z.infer<typeof Whole>;
/**
 * What the home asks a worker, with no secret value in it: the Mac's homes, the commands and variables its servers need,
 * the ticked items it carries whole, each item with keys, and Claude's OAuth servers.
 */
export const ReportAsk = z.object({
  homedir: z.string(), claudeDir: z.string(), commands: z.array(z.string()), vars: z.array(z.string()), secrets: z.array(Keyed), whole: z.array(Whole),
  oauth: z.array(z.object({ item: z.string(), name: z.string() })),
  // each server in a doc, which a target may hold as its own
  held: z.array(z.object({ item: z.string(), agent: AgentKind, doc: z.enum(DOC_NAMES), place: z.array(z.string()) })),
});
export type ReportAsk = z.infer<typeof ReportAsk>;
/**
 * What a worker holds and runs: commands found, variables its daemon has, each secret field non-empty there as the mirror's
 * copy or its own, each item carried whole that lies there, and each Claude OAuth server logged in, by item.
 */
export const ConfigReport = z.object({
  commands: z.record(z.string(), z.boolean()), vars: z.record(z.string(), z.boolean()), secrets: z.record(z.string(), z.enum(['copied', 'own'])),
  whole: z.record(z.string(), z.boolean()), oauth: z.record(z.string(), z.boolean()),
  // an item the worker holds as its own, the very one ticked whole; and each field or item whose own value a tick went over, whose file its backup keeps
  ownWhole: z.record(z.string(), z.boolean()).optional(), replaced: z.record(z.string(), z.boolean()).optional(),
  // each server this target keeps as its own, with the variables what it holds reads; and each item edited since: holding what the mirror copied whole or not, or a link nothing writes through
  keepsOwn: z.record(z.string(), z.array(z.string())).optional(), edited: z.record(z.string(), z.enum(['copy', 'own', 'link'])).optional(),
});
export type ConfigReport = z.infer<typeof ConfigReport>;

type Doc = Record<string, unknown>;
const isDoc = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v);

// the servers the mirror carries: an unknown one only once ticked whole
const carried = (plan: MirrorPlan): MirroredServer[] => plan.servers.filter((s) => Object.keys(s.entry).length > 0);

export function reportAsk(plan: MirrorPlan): ReportAsk {
  // a server's doc, or else the plugin server file it travels in, by where that lands
  const where = (s: MirroredServer): { doc: DocName } | { file: string } | undefined => {
    if (s.doc) return { doc: s.doc };
    const to = plan.files.find((f) => f.from === s.file && f.data !== undefined)?.to;
    return to === undefined ? undefined : { file: to };
  };
  const secrets: Keyed[] = [];
  const whole: Whole[] = [];
  for (const s of plan.servers) {
    const at = where(s);
    if (!at) continue;
    if (s.known && s.secretFields.length) {
      const fields = s.secretFields.flatMap((field) => fieldPlace(s.agent, s.entry, field).map((leaf) => ({ field, leaf })));
      secrets.push({ item: s.key, ...at, place: s.place, bare: s.bare, fields });
    } else if (!s.known) {
      // a server Svall cannot copy one by one has a preview naming its fields
      whole.push({ item: s.key, ...at, place: s.place, fields: s.preview });
    }
  }
  // each config file's own fields; Claude's env lies apart from the settings the mirror merges
  const files: { item: string; doc: DocName; at: Doc; fields?: string[] }[] = [
    { item: CONFIG_ITEMS.settings, doc: 'settings.json', at: plan.settings },
    ...(plan.codex ? [{ item: CONFIG_ITEMS.codex, doc: 'config.toml' as const, at: plan.codex }] : []),
    ...plan.opencode.map((d) => ({ item: CONFIG_ITEMS.opencode, doc: d.file, at: d.doc, fields: d.fields })),
  ];
  for (const c of plan.configs) {
    for (const f of files.filter((x) => x.item === c.key)) {
      const fields = f.fields ?? c.fields;
      const leaves = fields.flatMap((field) =>
        (f.doc === 'settings.json' && field.startsWith('env.') ? [['env', field.slice('env.'.length)]] : configPlace(f.at, field)).map((leaf) => ({ field, leaf })));
      secrets.push({ item: c.key, doc: f.doc, place: [], bare: configRedacted(f.at, fields), fields: leaves });
    }
  }
  // an item carried whole travels as its files; one not ticked is asked about where the worker may hold it still
  for (const p of plan.plugins) {
    for (const file of p.files) {
      const rel = path.relative(plan.homes.claudeDir, file);
      const to = p.ticked ? plan.files.find((f) => f.from === file)?.to : rel.startsWith('..') ? undefined : path.posix.join('claude', ...rel.split(path.sep));
      if (to !== undefined) whole.push({ item: p.key, file: to, place: [], fields: [] });
    }
  }
  return {
    homedir: plan.homes.homedir, claudeDir: plan.homes.claudeDir, commands: [...new Set(carried(plan).flatMap((s) => s.runtimes))], vars: plan.vars, secrets, whole,
    oauth: carried(plan).filter((s) => s.agent === 'claude' && s.oauth).map((s) => ({ item: s.key, name: s.name })),
    held: plan.servers.flatMap((s) => (s.doc ? [{ item: s.key, agent: s.agent, doc: s.doc, place: s.place }] : [])),
  };
}

/**
 * A worker's answer to `ask`, each thing looked for where the mirror writes it here, overrides merged; a secret field counts
 * only when neither empty nor as the mirror leaves it bare.
 */
export function configReport(ask: ReportAsk, o: MirrorHomes & { overrides: string; envFile: string; stateFile: string; backups?: string }): ConfigReport {
  const move = mover(ask, o);
  const env = readEnvFile(o.envFile);
  const state = readState(o.stateFile);
  const docs = new Map<DocName, Doc | undefined>();
  const docHere = (name: DocName): Doc | undefined => {
    if (!docs.has(name)) docs.set(name, docWithOverride(name, o));
    return docs.get(name);
  };
  // a file the mirror writes whole as it stands here, its override standing in for it
  const fileHere = (to: string): { there: boolean; doc: unknown; copied: boolean } => {
    if (!to.startsWith('claude/')) return { there: false, doc: undefined, copied: false };
    const override = path.join(o.overrides, to);
    const own = fs.existsSync(override);
    let bytes: Buffer;
    try { bytes = fs.readFileSync(own ? override : path.join(o.claudeDir, to.slice('claude/'.length))); } catch {
      return { there: false, doc: undefined, copied: false };
    }
    let doc: unknown;
    try { doc = JSON.parse(bytes.toString('utf8')); } catch { /* a file of another kind */ }
    return { there: true, doc, copied: !own && sha256Hex(bytes) === state.files[to] };
  };

  const edited: NonNullable<ConfigReport['edited']> = {};
  // a keyed file that stays once no longer the copy, `link` where nothing writes through it
  const editedFile = (to: string): 'link' | 'copy' | undefined => {
    if (o.backups === undefined || !state.keyed?.[to] || !fileHere(to).there || fileHere(to).copied) return undefined;
    return fs.lstatSync(path.join(o.claudeDir, to.slice('claude/'.length)), { throwIfNoEntry: false })?.isSymbolicLink() ? 'link' : 'copy';
  };
  const secrets: ConfigReport['secrets'] = {};
  const inBackup = state.backup !== undefined && fs.existsSync(state.backup.dir);
  const replaced: Record<string, boolean> = {};
  const wasReplaced = (key: string, name: string): void => { if (inBackup && state.replaced?.some((r) => under(key, r))) replaced[name] = true; };
  for (const k of ask.secrets) {
    // what the mirror leaves there without keys, moved as apply moves it: a server's command, args and cwd, a config
    // file's path keys, a plugin's server file not at all
    const bare = k.file !== undefined ? k.bare : k.place.length ? relocatedServer(k.bare, move) : relocated(k.bare, move);
    const file = k.file !== undefined ? fileHere(k.file) : undefined;
    if (k.file !== undefined && editedFile(k.file) === 'link') edited[k.item] = 'link';
    for (const { field, leaf } of k.fields) {
      if (k.doc) wasReplaced(recordKey(k.doc, [...k.place, ...leaf]), fieldKey(k.item, field));
      const value = k.doc ? getAt(docHere(k.doc), [...placedIn(k.doc, k.place, move), ...leaf]) : getAt(file?.doc, [...k.place, ...leaf]);
      if (typeof value !== 'string' || value === '' || value === getAt(bare, leaf)) continue;
      const copied = k.doc ? isCopy(state.secrets[recordKey(k.doc, [...k.place, ...leaf])], value) || isCopy(state.wholeKeys?.[recordKey(k.doc, k.place)], value) : file?.copied === true;
      // a field at several places is copied while one holds the copy
      secrets[fieldKey(k.item, field)] = copied || secrets[fieldKey(k.item, field)] === 'copied' ? 'copied' : 'own';
    }
  }
  const whole: ConfigReport['whole'] = {};
  const ownWhole: Record<string, boolean> = {};
  for (const w of ask.whole) {
    const v = w.doc ? getAt(docHere(w.doc), placedIn(w.doc, w.place, move)) : w.file !== undefined ? getAt(fileHere(w.file).doc, w.place) : undefined;
    const recorded = w.doc ? state.servers[recordKey(w.doc, w.place)] : w.file !== undefined ? state.files[w.file] : undefined;
    // a file carried whole is there once the worker has it
    const there = !w.doc && w.file !== undefined && !w.place.length ? fileHere(w.file).there : isDoc(v) && w.fields.every((f) => Object.hasOwn(v, f));
    whole[w.item] = (whole[w.item] ?? true) && recorded !== undefined && there;
    if (w.doc) wasReplaced(recordKey(w.doc, w.place), w.item);
    if (w.doc && recorded === undefined && there) ownWhole[w.item] = true;
    const edit = w.file !== undefined ? editedFile(w.file) : undefined;
    if (edit) edited[w.item] = edit === 'link' ? edit : edited[w.item] ?? edit;
  }
  const keepsOwn: NonNullable<ConfigReport['keepsOwn']> = {};
  for (const h of o.backups === undefined ? [] : ask.held) {
    const rk = recordKey(h.doc, h.place);
    const v = getAt(docHere(h.doc), placedIn(h.doc, h.place, move));
    if (!isDoc(v)) continue;
    const theirs = isTheirs(h.agent, v, rk, state);
    if (theirs) edited[h.item] = holdsWholeKey(h.agent, v, rk, state) ? 'copy' : 'own';
    if (theirs || ownKeys(h.agent, v, rk, state).length) keepsOwn[h.item] = needsOf(heldServer(h.agent, v));
  }
  let credentials: unknown;
  try { credentials = JSON.parse(fs.readFileSync(path.join(o.claudeDir, '.credentials.json'), 'utf8')); } catch { /* no login */ }
  const logins = isDoc(credentials) && isDoc(credentials.mcpOAuth) ? Object.keys(credentials.mcpOAuth) : [];
  return {
    commands: Object.fromEntries(ask.commands.map((c) => [c, path.posix.isAbsolute(c) ? isExecutable(move(c)) : onPath(c, process.env.PATH ?? '') !== undefined])),
    vars: Object.fromEntries(ask.vars.map((v) => [v, Boolean(process.env[v] || env[v])])),
    secrets, whole, ownWhole, replaced, keepsOwn, edited,
    oauth: Object.fromEntries(ask.oauth.map((a) => [a.item, logins.some((k) => k.startsWith(`${a.name}|`))])),
  };
}

/**
 * `plan` as it reaches a robot whose terminals run `agents` in `folders` on this Mac: those agents' servers, a project's
 * only where a folder lies in that project, and their config files.
 */
export function forRobot(plan: MirrorPlan, o: { agents: AgentKind[]; folders: string[] }): MirrorPlan {
  const uses = (agent: AgentKind) => o.agents.includes(agent);
  const reaches = ({ scope }: Pick<MirroredServer, 'scope'>) => typeof scope !== 'object' || !('project' in scope) || o.folders.some((f) => holds(clean(scope.project), clean(f)));
  // a file this Mac cannot read is Codex's or OpenCode's in their folders, and Claude's anywhere else
  const agentOf = (f: string): AgentKind => (holds(plan.homes.codexDir, f) ? 'codex' : holds(plan.homes.opencodeDir, f) ? 'opencode' : 'claude');
  const { codex, ...rest } = plan;
  return {
    ...rest, ...(uses('codex') && codex && { codex }),
    servers: plan.servers.filter((s) => uses(s.agent) && reaches(s)), macOnly: plan.macOnly.filter((s) => uses(s.agent) && reaches(s)), configs: plan.configs.filter((c) => uses(c.agent)),
    plugins: uses('claude') ? plan.plugins : [], opencode: uses('opencode') ? plan.opencode : [], unreadable: plan.unreadable.filter((f) => uses(agentOf(f))),
  };
}

/**
 * The setup rows of the mirror to `o.machine` by `plan` and the worker's report: each says how the item stands there, and its
 * action how to change that. Without a report a row that hangs on one says `o.unchecked`, and a ticked one that its change is
 * saved; `o.stale`, the machine runs another release, which an upgrade ends.
 */
export function setupRows(plan: MirrorPlan, report: ConfigReport | undefined, o: { machine: string; fleetFlag: string; unchecked: string; stale?: boolean; overrides: string; here?: (name: string) => boolean; apt?: boolean; mac?: boolean }): SetupRow[] {
  const m = o.machine;
  const rows: SetupRow[] = [];
  const again = report || !o.stale ? CHECK_AGAIN : `Upgrade ${m}`;
  // a ticked item the worker does not hold yet, or was not asked about
  const notYet = (tick: NonNullable<SetupRow['tick']>, name: string): SetupRow =>
    ({ key: tick.item, status: 'warn', action: again, detail: report ? `sent, not on ${m} yet` : `saved; applies when ${m} is back`, tick, gap: { name, what: `ticked; not on ${m} yet` } });
  // an unticked item whose copy the worker still holds
  const stillOn = (tick: NonNullable<SetupRow['tick']>, name: string): SetupRow =>
    ({ key: tick.item, status: 'warn', action: CHECK_AGAIN, detail: `switched off, still on ${m}`, tick, gap: { name, what: `unticked; still on ${m}` } });
  // an item that stays as the person edited it: what the record holds cannot say a key still lies in it
  const edited = { detail: `edited on ${m}; stays as it is`, action: `Remove it on ${m} if the copied key should go` };
  const staysEdited = (tick: NonNullable<SetupRow['tick']>, name: string): SetupRow => ({
    key: tick.item, status: 'warn', ...edited, tick, gap: { name, what: 'stays as you edited it, with any key Svall copied in it' },
  });
  // the variables an unticked env key of server `s` reads on the worker: the references the mirror leaves in its place
  const reads = (s: MirroredServer, f: string): string[] => {
    const v = getAt(s.bare, [FIELD_PATHS[s.agent].env, f.slice('env.'.length)]);
    return typeof v === 'string' ? [...v.matchAll(VAR_REF)].map((x) => x[1] ?? x[2]) : [f.slice('env.'.length)];
  };
  // an item's keys: ticked, once the worker holds each, as the copy or its own; unticked, once it holds each of its own,
  // a server's env key its own once the worker's daemon has the variables it reads, and while it still holds a copy, not yet
  const keyRow = (item: string, name: string, fields: string[], ticked: string[], preview: string[], server?: MirroredServer): SetupRow => {
    const tick = { item, name, fields, on: fields.every((f) => ticked.includes(f)), preview, ticked: fields.filter((f) => ticked.includes(f)) };
    if (report?.edited?.[item] === 'link') return staysEdited(tick, name);
    const held = (f: string) => report?.secrets[fieldKey(item, f)];
    const own = (f: string) => held(f) === 'own' || (server && f.startsWith('env.') && reads(server, f).every((v) => report?.vars[v] === true));
    if (tick.on && fields.every((f) => held(f) === 'copied')) return { key: item, status: 'ok', detail: 'copied', tick };
    if (!tick.on && fields.some((f) => held(f) === 'copied')) return stillOn(tick, name);
    if (fields.every((f) => (tick.on ? held(f) : own(f)))) return { key: item, status: 'ok', detail: `${m} has its own`, tick };
    if (tick.on) return notYet(tick, name);
    const vars = server ? [...new Set(fields.filter((f) => f.startsWith('env.')).flatMap((f) => reads(server, f)))] : [];
    return {
      key: item, status: 'warn', detail: report ? 'not copied' : o.unchecked, tick,
      action: vars.length ? `Tick to copy, or set ${vars.join(', ')} on ${m}: ${vars.map((v) => `svall ${o.fleetFlag}worker env ${v}`).join(', ')}` : `Tick to copy, or set them on ${m} in ${o.overrides}`,
      gap: { name, what: `keys not copied (${fields.filter((f) => !own(f)).join(', ')})` },
    };
  };
  // what a tick went over stays in the machine's backup, and its row says so
  const inBackup = (row: SetupRow, names: string[]): SetupRow => {
    if (!names.some((n) => report?.replaced?.[n])) return row;
    const backup = `${m}'s own copy is in its backup folder`;
    return { ...row, action: row.action ? `${row.action}. ${backup}` : backup };
  };
  const keys = (item: string, name: string, fields: string[], ticked: string[], preview: string[], server?: MirroredServer): SetupRow =>
    inBackup(keyRow(item, name, fields, ticked, preview, server), fields.map((f) => fieldKey(item, f)));
  // a server or plugin config with settings Svall cannot copy one by one, whose file travels as it is once ticked
  const whole = (item: string, name: string, fields: string[], on: boolean): SetupRow => inBackup(wholeRow(item, name, fields, on), [item]);
  const wholeRow = (item: string, name: string, fields: string[], on: boolean): SetupRow => {
    const tick = { item, name, fields, on, preview: fields };
    if (report?.edited?.[item] === 'link' || (!on && report?.edited?.[item] === 'copy')) return staysEdited(tick, name);
    if (!on && report?.whole[item]) return report.edited?.[item] ? { key: item, status: 'skip', ...edited, tick } : stillOn(tick, name);
    if (!on) return { key: item, status: 'warn', detail: 'not copied', action: 'Tick to copy the whole file, keys included', tick, gap: { name, what: 'not copied; tick to copy it as it is' } };
    if (report?.ownWhole?.[item]) return { key: item, status: 'ok', detail: `${m} has its own`, tick };
    return report?.whole[item] ? { key: item, status: 'ok', detail: 'copied whole', tick } : notYet(tick, name);
  };
  // a server Svall cannot copy one by one has a preview naming its fields
  for (const s of plan.servers) {
    // a tick cannot land in a plugin's file the plan does not carry
    if (s.file && !plan.files.some((f) => f.from === s.file)) {
      if (!s.known || s.secretFields.length) rows.push({ key: s.key, status: 'skip', detail: UNCOPIED, gap: { name: s.name, what: UNCOPIED } });
    } else if (!s.known) rows.push(whole(s.key, s.name, s.preview, Object.keys(s.entry).length > 0));
    else if (s.secretFields.length) rows.push(keys(s.key, s.name, s.secretFields, s.ticked, s.preview, s));
    if (s.known && !s.ticked.length && report?.edited?.[s.key] === 'copy') rows.push({ key: `edited:${s.key}`, status: 'warn', ...edited });
    else if (s.known && !s.ticked.length && report?.edited?.[s.key] === 'own') {
      rows.push({ key: `edited:${s.key}`, status: 'skip', detail: `edited on ${m}; no longer follows ${homeWord()}`, action: `Delete it on ${m} to take ${homeWord()}'s again` });
    }
  }

  const servers = carried(plan);
  const names = (has: (s: MirroredServer) => boolean): string[] => [...new Set(servers.filter(has).map((s) => s.name))];
  for (const v of plan.vars) {
    const readers = [
      ...names((s) => s.needs.includes(v) && (report?.keepsOwn?.[s.key]?.includes(v) ?? true)), ...(plan.codex && configNeeds('codex', plan.codex).includes(v) ? ['config.toml'] : []),
      ...plan.opencode.filter((d) => configNeeds('opencode', d.doc).includes(v)).map((d) => d.file),
    ];
    if (!readers.length) continue;
    const key = `var:${v}`;
    const readBy = `${readers.join(', ')} ${readers.length === 1 ? 'reads' : 'read'} it`;
    if (report?.vars[v]) rows.push({ key, status: 'ok', detail: 'set' });
    else if (!report) rows.push({ key, status: 'warn', action: again, detail: o.unchecked });
    else {
      const run = `svall ${o.fleetFlag}worker env ${v}`;
      rows.push({ key, status: 'warn', action: run, run, detail: `not set · ${readBy}`, gap: { name: v, what: `not set; ${readBy}` }, ...(o.here?.(v) && { here: true }) });
    }
  }
  for (const s of servers) {
    if (!s.oauth) continue;
    const key = `oauth:${s.key}`;
    if (s.agent !== 'claude') {
      rows.push({ key, status: 'skip', ...s.oauth, detail: `log in once on ${m}`, gap: { name: s.name, what: 'log in once there; the row stays' } });
    } else if (report?.oauth[s.key]) rows.push({ key, status: 'ok', detail: 'logged in' });
    else rows.push({ key, status: 'warn', action: `Start claude there, then /mcp and log in to ${s.name}`, ...s.oauth, detail: 'not logged in', ...(report && { gap: { name: s.name, what: 'not logged in' } }) });
  }
  const missing = report ? [...new Set(servers.flatMap((s) => s.runtimes))].filter((bin) => report.commands[bin] === false) : [];
  for (const bin of missing) {
    const named = names((s) => s.runtimes.includes(bin));
    const users = named.join(', ');
    const one = named.length === 1;
    const key = `runtime:${bin}`;
    const name = path.posix.basename(bin);
    // the row's tick says the machine does not need the program; ticked, the row stands aside
    const tick = { item: key, fields: [NOT_NEEDED], on: plan.notNeeded.includes(bin), preview: [] };
    if (tick.on) {
      rows.push({ key, status: 'skip', detail: 'not needed here', tick, gap: { name, what: 'not needed there, you ticked' } });
      continue;
    }
    const gap = { name, what: `not installed; ${users} ${one ? 'needs' : 'need'} it` };
    if (path.posix.isAbsolute(bin)) {
      rows.push({ key, status: 'warn', action: `A path under ${homeWord()}'s home folder is looked for under ${m}'s`, detail: `not on ${m} · ${users} ${one ? 'runs' : 'run'} it`, tick, gap });
      continue;
    }
    const run = o.apt !== false && Object.hasOwn(INSTALL_RUN, bin) ? INSTALL_RUN[bin] : undefined;
    rows.push({ key, status: 'warn', action: run ?? `Install ${bin} on ${m}`, ...(run && { run }), detail: `not installed · ${users} ${one ? 'needs' : 'need'} it`, tick, gap });
  }
  for (const s of plan.macOnly) {
    const key = `maconly:${s.agent}:${s.name}`;
    // a Mac worker runs it too, and is simply not sent it
    const where = o.mac ? `stays on ${homeWord()}` : 'runs only on a Mac';
    if (!rows.some((r) => r.key === key)) rows.push({ key, status: 'skip', detail: where, gap: { name: s.name, what: where } });
  }
  for (const c of plan.configs) rows.push(keys(c.key, c.file, c.fields, c.ticked, c.preview));
  for (const p of plan.plugins) rows.push(whole(p.key, p.name, p.fields, p.ticked));
  for (const f of plan.unreadable) {
    const what = `not copied: ${homeWord()} cannot read it`;
    rows.push({ key: `unreadable:${f}`, status: 'warn', detail: what, action: `Set it up on ${m} by hand`, raw: `${f} cannot be read as JSON or TOML`, gap: { name: path.basename(f), what } });
  }
  tellApart(rows, plan.servers);
  return rows;
}

/** A gap name two servers share names each one's plugin, project or agent too, as the panel labels their rows. */
function tellApart(rows: SetupRow[], servers: MirroredServer[]): void {
  const serverOf = (r: SetupRow) => servers.find((s) => r.key === s.key || r.key === `oauth:${s.key}`);
  const holders = new Map<string, Set<string>>();
  for (const r of rows) {
    const s = r.gap && serverOf(r);
    if (s) (holders.get(r.gap!.name) ?? holders.set(r.gap!.name, new Set()).get(r.gap!.name)!).add(s.key);
  }
  for (const r of rows) {
    const s = r.gap && serverOf(r);
    if (!s || (holders.get(r.gap!.name)?.size ?? 0) < 2) continue;
    const where = s.scope === 'user' ? s.agent : 'plugin' in s.scope ? `plugin ${s.scope.plugin.split('@')[0]}` : path.basename(s.scope.project);
    r.gap = { ...r.gap!, name: `${r.gap!.name} (${where})` };
  }
}
