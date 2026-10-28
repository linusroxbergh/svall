import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { NOT_NEEDED, type AgentKind, type SetupRow } from '@svall/protocol';
import { isExecutable, onPath } from '../agents.js';
import { readEnvFile } from '../claude.js';
import { sha256Hex } from '../hash.js';
import { clean, holds } from '../path-tools.js';
import { configNeeds, configPlace, configRedacted, FIELD_PATHS, fieldPlace, getAt, relocatedServer, VAR_REF } from './mirror-config.js';
import { CONFIG_ITEMS, fieldKey } from './mirror-consent.js';
import { docWithOverride } from './mirror-apply.js';
import type { MirroredServer, MirrorPlan } from './mirror-plan.js';
import { DOC_NAMES, isCopy, mover, placedIn, readState, recordKey, relocated, type DocName, type MirrorHomes } from './mirror-state.js';

// how a Linux worker gets the runtime a server's command names
const INSTALL_RUN: Record<string, string> = {
  node: 'sudo apt install nodejs npm', npx: 'sudo apt install nodejs npm', bun: 'curl -fsSL https://bun.sh/install | bash',
  uvx: 'curl -LsSf https://astral.sh/uv/install.sh | sh', uv: 'curl -LsSf https://astral.sh/uv/install.sh | sh', docker: 'sudo apt install docker.io', python3: 'sudo apt install python3',
};

const Place = z.array(z.union([z.string(), z.number()]));
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
});
export type ReportAsk = z.infer<typeof ReportAsk>;
/**
 * What a worker holds and runs: commands found, variables its daemon has, each secret field non-empty there as the mirror's
 * copy or its own, each item carried whole that lies there, and each Claude OAuth server logged in, by item.
 */
export const ConfigReport = z.object({
  commands: z.record(z.string(), z.boolean()), vars: z.record(z.string(), z.boolean()), secrets: z.record(z.string(), z.enum(['copied', 'own'])),
  whole: z.record(z.string(), z.boolean()), oauth: z.record(z.string(), z.boolean()),
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
  };
}

/**
 * A worker's answer to `ask`, each thing looked for where the mirror writes it here, overrides merged; a secret field counts
 * only when neither empty nor as the mirror leaves it bare.
 */
export function configReport(ask: ReportAsk, o: MirrorHomes & { overrides: string; envFile: string; stateFile: string }): ConfigReport {
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

  const secrets: ConfigReport['secrets'] = {};
  for (const k of ask.secrets) {
    // what the mirror leaves there without keys, moved as apply moves it: a server's command, args and cwd, a config
    // file's path keys, a plugin's server file not at all
    const bare = k.file !== undefined ? k.bare : k.place.length ? relocatedServer(k.bare, move) : relocated(k.bare, move);
    const file = k.file !== undefined ? fileHere(k.file) : undefined;
    for (const { field, leaf } of k.fields) {
      const value = k.doc ? getAt(docHere(k.doc), [...placedIn(k.doc, k.place, move), ...leaf]) : getAt(file?.doc, [...k.place, ...leaf]);
      if (typeof value !== 'string' || value === '' || value === getAt(bare, leaf)) continue;
      const copied = k.doc ? isCopy(state.secrets[recordKey(k.doc, [...k.place, ...leaf])], value) : file?.copied === true;
      // a field at several places is copied while one holds the copy
      secrets[fieldKey(k.item, field)] = copied || secrets[fieldKey(k.item, field)] === 'copied' ? 'copied' : 'own';
    }
  }
  const whole: ConfigReport['whole'] = {};
  for (const w of ask.whole) {
    const v = w.doc ? getAt(docHere(w.doc), placedIn(w.doc, w.place, move)) : w.file !== undefined ? getAt(fileHere(w.file).doc, w.place) : undefined;
    const recorded = w.doc ? state.servers[recordKey(w.doc, w.place)] : w.file !== undefined ? state.files[w.file] : undefined;
    // a file carried whole is there once the worker has it
    const there = !w.doc && w.file !== undefined && !w.place.length ? fileHere(w.file).there : isDoc(v) && w.fields.every((f) => Object.hasOwn(v, f));
    whole[w.item] = (whole[w.item] ?? true) && recorded !== undefined && there;
  }
  let credentials: unknown;
  try { credentials = JSON.parse(fs.readFileSync(path.join(o.claudeDir, '.credentials.json'), 'utf8')); } catch { /* no login */ }
  const logins = isDoc(credentials) && isDoc(credentials.mcpOAuth) ? Object.keys(credentials.mcpOAuth) : [];
  return {
    commands: Object.fromEntries(ask.commands.map((c) => [c, path.posix.isAbsolute(c) ? isExecutable(move(c)) : onPath(c, process.env.PATH ?? '') !== undefined])),
    vars: Object.fromEntries(ask.vars.map((v) => [v, Boolean(process.env[v] || env[v])])),
    secrets, whole,
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
 * The setup rows of the mirror to `o.machine` by `plan` and the worker's report. Without a report a row that hangs on one
 * says `o.unchecked`, and a key row that its change is saved for when the machine links.
 */
export function setupRows(plan: MirrorPlan, report: ConfigReport | undefined, o: { machine: string; fleetFlag: string; unchecked: string; overrides: string }): SetupRow[] {
  const m = o.machine;
  const rows: SetupRow[] = [];
  const saved = `${o.unchecked}; saved, and takes effect when ${m} links`;
  // a ticked item the worker does not hold yet, or was not asked about
  const notYet = (tick: NonNullable<SetupRow['tick']>, name: string): SetupRow =>
    ({ key: tick.item, status: 'warn', action: `check ${m} again`, detail: report ? `sent; not on ${m} yet` : saved, tick, gap: { name, what: `ticked; not on ${m} yet` } });
  // an unticked item whose copy the worker still holds
  const stillOn = (tick: NonNullable<SetupRow['tick']>, name: string): SetupRow =>
    ({ key: tick.item, status: 'warn', action: `check ${m} again`, detail: `still on ${m}; check ${m} again`, tick, gap: { name, what: `unticked; still on ${m}` } });
  // the variables an unticked env key of server `s` reads on the worker: the references the mirror leaves in its place
  const reads = (s: MirroredServer, f: string): string[] => {
    const v = getAt(s.bare, [FIELD_PATHS[s.agent].env, f.slice('env.'.length)]);
    return typeof v === 'string' ? [...v.matchAll(VAR_REF)].map((x) => x[1] ?? x[2]) : [f.slice('env.'.length)];
  };
  // an item's keys: ticked, once the worker holds each, as the copy or its own; unticked, once it holds each of its own,
  // a server's env key its own once the worker's daemon has the variables it reads, and while it still holds a copy, not yet
  const keys = (item: string, name: string, fields: string[], ticked: string[], preview: string[], server?: MirroredServer): SetupRow => {
    const tick = { item, fields, on: fields.every((f) => ticked.includes(f)), preview };
    const held = (f: string) => report?.secrets[fieldKey(item, f)];
    const own = (f: string) => held(f) === 'own' || (server && f.startsWith('env.') && reads(server, f).every((v) => report?.vars[v] === true));
    if (tick.on && fields.every((f) => held(f) === 'copied')) return { key: item, status: 'ok', detail: `keys copied to ${m}: ${preview.join(', ')}`, tick };
    if (!tick.on && fields.some((f) => held(f) === 'copied')) return stillOn(tick, name);
    if (fields.every((f) => (tick.on ? held(f) : own(f)))) return { key: item, status: 'ok', detail: `${m} has its own keys`, tick };
    if (tick.on) return notYet(tick, name);
    const vars = server ? [...new Set(fields.filter((f) => f.startsWith('env.')).flatMap((f) => reads(server, f)))] : [];
    const without = `copied without its keys (${preview.join(', ')}); tick to copy them, ${vars.length
      ? `set ${vars.join(', ')} on ${m} (${vars.map((v) => `svall ${o.fleetFlag}worker env ${v}`).join(', ')}), or set them in ${o.overrides} there`
      : `or set them on ${m} in ${o.overrides}`}`;
    return {
      key: item, status: 'warn', action: `copy ${name}'s keys to ${m}`, detail: report ? without : `${saved}: ${without}`, tick,
      gap: { name, what: `keys not copied (${fields.filter((f) => !own(f)).join(', ')})` },
    };
  };
  // a server or plugin config with settings Svall cannot copy one by one, whose file travels as it is once ticked
  const whole = (item: string, name: string, fields: string[], on: boolean): SetupRow => {
    const tick = { item, fields, on, preview: fields };
    if (!on && report?.whole[item]) return stillOn(tick, name);
    if (!on) {
      return {
        key: item, status: 'warn', action: `copy ${name} to ${m} as it is`, detail: `${name} has settings Svall cannot copy one by one; tick to copy its file as it is, keys included`, tick,
        gap: { name, what: 'not copied; tick to copy it as it is' },
      };
    }
    return report?.whole[item] ? { key: item, status: 'ok', detail: `copied to ${m} as it is`, tick } : notYet(tick, name);
  };
  // a server Svall cannot copy one by one has a preview naming its fields
  for (const s of plan.servers) {
    if (!s.known) rows.push(whole(s.key, s.name, s.preview, Object.keys(s.entry).length > 0));
    else if (s.secretFields.length) rows.push(keys(s.key, s.name, s.secretFields, s.ticked, s.preview, s));
  }

  const servers = carried(plan);
  const names = (has: (s: MirroredServer) => boolean): string[] => [...new Set(servers.filter(has).map((s) => s.name))];
  for (const v of plan.vars) {
    const readers = [
      ...names((s) => s.needs.includes(v)), ...(plan.codex && configNeeds('codex', plan.codex).includes(v) ? ['config.toml'] : []),
      ...plan.opencode.filter((d) => configNeeds('opencode', d.doc).includes(v)).map((d) => d.file),
    ];
    if (!readers.length) continue;
    const key = `var:${v}`;
    if (report?.vars[v]) rows.push({ key, status: 'ok', detail: `${v} is set on ${m}` });
    else if (!report) rows.push({ key, status: 'warn', action: `check ${m} again`, detail: o.unchecked });
    else {
      rows.push({
        key, status: 'warn', action: `set ${v} on ${m}`, run: `svall ${o.fleetFlag}worker env ${v}`, detail: `${readers.join(', ')} ${readers.length === 1 ? 'reads' : 'read'} ${v}, which is not set on ${m}`,
        gap: { name: v, what: `not set; ${readers.join(', ')} ${readers.length === 1 ? 'reads' : 'read'} it` },
      });
    }
  }
  for (const s of servers) {
    if (!s.oauth) continue;
    const key = `oauth:${s.key}`;
    if (s.agent !== 'claude') {
      rows.push({ key, status: 'skip', ...s.oauth, detail: `log in once on ${m}; the row stays either way: ${s.oauth.run}`, gap: { name: s.name, what: 'log in once there; the row stays' } });
    } else if (report?.oauth[s.key]) rows.push({ key, status: 'ok', detail: `logged in on ${m}` });
    else rows.push({ key, status: 'warn', action: `log in once on ${m}`, ...s.oauth, detail: `then /mcp and sign in to ${s.name}`, ...(report && { gap: { name: s.name, what: 'not logged in' } }) });
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
      rows.push({ key, status: 'skip', detail: `not needed on ${m}, you ticked; untick to list it again`, tick, gap: { name, what: 'not needed there, you ticked' } });
      continue;
    }
    const gap = { name, what: `not installed; ${users} ${one ? 'needs' : 'need'} it` };
    const need = `${users} ${one ? 'needs' : 'need'} it; tick if ${m} does not`;
    if (path.posix.isAbsolute(bin)) {
      rows.push({ key, status: 'warn', action: `install ${name} on ${m}`, detail: `${users} ${one ? 'runs' : 'run'} ${bin}, which ${m} does not have; a path under this Mac's home is looked for under ${m}'s. Tick if ${m} does not need it`, tick, gap });
    } else rows.push({ key, status: 'warn', action: `install ${bin} on ${m}`, ...(Object.hasOwn(INSTALL_RUN, bin) && { run: INSTALL_RUN[bin] }), detail: need, tick, gap });
  }
  for (const s of plan.macOnly) {
    const key = `maconly:${s.agent}:${s.name}`;
    if (!rows.some((r) => r.key === key)) rows.push({ key, status: 'skip', detail: `${s.name} only runs on a Mac; not mirrored`, gap: { name: s.name, what: 'runs only on a Mac' } });
  }
  for (const c of plan.configs) rows.push(keys(c.key, c.file, c.fields, c.ticked, c.preview));
  for (const p of plan.plugins) rows.push(whole(p.key, p.name, p.fields, p.ticked));
  for (const f of plan.unreadable) {
    rows.push({ key: `unreadable:${f}`, status: 'warn', detail: `${f} cannot be read as JSON or TOML; set it up on ${m} by hand`, gap: { name: path.basename(f), what: 'not copied: this Mac cannot read it' } });
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
