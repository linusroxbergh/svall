import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SetupRow } from '@svall/protocol';
import { isExecutable, onPath } from '../agents.js';
import { readEnvFile } from '../claude.js';
import { sha256Hex } from '../handover/hash.js';
import { clean, holds } from '../handover/portable-path.js';
import { relocate } from '../handover/relocate.js';
import { realPath } from '../paths.js';
import { configNeeds, configPlace, configRedacted, fieldPlace, getAt } from './mirror-config.js';
import { CONFIG_ITEMS, fieldKey } from './mirror-consent.js';
import { docWithOverride, readState, type DocName, type MirroredServer, type MirrorHomes, type MirrorPlan } from './mirror.js';

// how a Linux worker gets the runtime a server's command names
const INSTALL_RUN: Record<string, string> = {
  node: 'sudo apt install nodejs npm', npx: 'sudo apt install nodejs npm', bun: 'curl -fsSL https://bun.sh/install | bash',
  uvx: 'curl -LsSf https://astral.sh/uv/install.sh | sh', uv: 'curl -LsSf https://astral.sh/uv/install.sh | sh', docker: 'sudo apt install docker.io', python3: 'sudo apt install python3',
};

/**
 * A secret field of `item` by where the worker holds its value: config file `doc`, or the file the mirror writes whole
 * landing at `file`, at `place` as the Mac holds it; `bare` what the mirror leaves there without the key. No value travels.
 */
const SecretAt = z.object({
  item: z.string(), field: z.string(), doc: z.enum(['settings.json', '.claude.json', 'config.toml', 'opencode.json', 'opencode.jsonc']).optional(),
  file: z.string().optional(), place: z.array(z.union([z.string(), z.number()])), bare: z.string().optional(),
});
type SecretAt = z.infer<typeof SecretAt>;
/** What the home asks a worker: the Mac's homes, the commands and variables its servers need, its secret fields and Claude's OAuth servers. */
export const ReportAsk = z.object({
  homedir: z.string(), claudeDir: z.string(), commands: z.array(z.string()), vars: z.array(z.string()), secrets: z.array(SecretAt),
  oauth: z.array(z.object({ item: z.string(), name: z.string() })),
});
export type ReportAsk = z.infer<typeof ReportAsk>;
/**
 * What a worker holds and runs: each command found, each variable its daemon has, each secret field non-empty there by
 * its field key, as the copy the mirror wrote or its own, and each Claude OAuth server it is logged in to, by item.
 */
export const ConfigReport = z.object({
  commands: z.record(z.string(), z.boolean()), vars: z.record(z.string(), z.boolean()),
  secrets: z.record(z.string(), z.enum(['copied', 'own'])), oauth: z.record(z.string(), z.boolean()),
});
export type ConfigReport = z.infer<typeof ConfigReport>;

type Doc = Record<string, unknown>;
const isDoc = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

// the servers the mirror carries: an unknown one only once ticked whole
const carried = (plan: MirrorPlan): MirroredServer[] => plan.servers.filter((s) => Object.keys(s.entry).length > 0);

/** What to ask a worker about `plan`. */
export function reportAsk(plan: MirrorPlan): ReportAsk {
  const secrets: SecretAt[] = [];
  for (const s of plan.servers.filter((x) => x.known)) {
    // a plugin's server travels in its plugin's server file
    const file = s.doc ? undefined : plan.files.find((f) => f.from === s.file && f.data !== undefined)?.to;
    if (!s.doc && !file) continue;
    for (const field of s.secretFields) {
      const leaf = fieldPlace(s.agent, s.entry, field);
      secrets.push({ item: s.key, field, ...(s.doc ? { doc: s.doc } : { file }), place: [...s.place, ...leaf], bare: text(getAt(s.bare, leaf)) });
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
      const bare = configRedacted(f.at, fields);
      for (const field of fields) {
        const place = f.doc === 'settings.json' && field.startsWith('env.') ? ['env', field.slice('env.'.length)] : configPlace(f.at, field);
        if (place) secrets.push({ item: c.key, field, doc: f.doc, place, bare: text(getAt(bare, place)) });
      }
    }
  }
  return {
    homedir: plan.homes.homedir, claudeDir: plan.homes.claudeDir, commands: [...new Set(carried(plan).flatMap((s) => s.runtimes))], vars: plan.vars, secrets,
    oauth: carried(plan).filter((s) => s.agent === 'claude' && s.oauth).map((s) => ({ item: s.key, name: s.name })),
  };
}

/**
 * A worker's answer to `ask`: each command on its daemon's PATH, or at an absolute one moved into this home as the
 * mirror moves it; each variable in its daemon's environment or its .env; each secret field where the mirror writes it
 * here, overrides merged, unless empty or bare; each Claude server with a login in its credentials.
 */
export function configReport(ask: ReportAsk, o: MirrorHomes & { overrides: string; envFile: string; stateFile: string }): ConfigReport {
  const claude = { from: ask.claudeDir, to: o.claudeDir };
  const move = (p: string): string => relocate(p, holds(clean(claude.from), clean(p)) ? claude : { from: ask.homedir, to: o.homedir });
  const env = readEnvFile(o.envFile);
  const state = readState(o.stateFile);
  const docs = new Map<DocName, Doc | undefined>();
  // the value at `s` here, and whether the mirror's record holds it as the copy it wrote
  const held = (s: SecretAt): { value: unknown; copied: boolean } => {
    if (s.doc) {
      if (!docs.has(s.doc)) docs.set(s.doc, docWithOverride(s.doc, o));
      // a Claude project's servers lie under this home's own path of it
      const place = s.doc === '.claude.json' && s.place[0] === 'projects' ? ['projects', realPath(move(String(s.place[1]))).normalize('NFC'), ...s.place.slice(2)] : s.place;
      const value = getAt(docs.get(s.doc), place);
      return { value, copied: typeof value === 'string' && state.secrets[JSON.stringify([s.doc, ...s.place])] === sha256Hex(value) };
    }
    if (!s.file?.startsWith('claude/')) return { value: undefined, copied: false };
    // a file the mirror writes whole is the copy while it is as the mirror wrote it; an override stands in for it
    const override = path.join(o.overrides, s.file);
    const own = fs.existsSync(override);
    let bytes: Buffer;
    let doc: unknown;
    try {
      bytes = fs.readFileSync(own ? override : path.join(o.claudeDir, s.file.slice('claude/'.length)));
      doc = JSON.parse(bytes.toString('utf8'));
    } catch {
      return { value: undefined, copied: false };
    }
    return { value: getAt(doc, s.place), copied: !own && sha256Hex(bytes) === state.files[s.file] };
  };
  const secrets: ConfigReport['secrets'] = {};
  for (const s of ask.secrets) {
    const { value, copied } = held(s);
    if (typeof value === 'string' && value !== '' && value !== s.bare) secrets[fieldKey(s.item, s.field)] = copied ? 'copied' : 'own';
  }
  let credentials: unknown;
  try { credentials = JSON.parse(fs.readFileSync(path.join(o.claudeDir, '.credentials.json'), 'utf8')); } catch { /* no login */ }
  const logins = isDoc(credentials) && isDoc(credentials.mcpOAuth) ? Object.keys(credentials.mcpOAuth) : [];
  return {
    commands: Object.fromEntries(ask.commands.map((c) => [c, path.posix.isAbsolute(c) ? isExecutable(move(c)) : onPath(c, process.env.PATH ?? '') !== undefined])),
    vars: Object.fromEntries(ask.vars.map((v) => [v, Boolean(process.env[v] ?? env[v])])),
    secrets,
    oauth: Object.fromEntries(ask.oauth.map((a) => [a.item, logins.some((k) => k.startsWith(`${a.name}|`))])),
  };
}

/**
 * The setup rows of the mirror to machine `o.machine` by `plan` and what the worker reported, in this order: each server
 * with keys or fields Svall does not know, each variable, login and missing runtime its servers need, the Mac-only
 * servers, each config file with keys, each plugin config and each file that cannot be read. Without a report a row that
 * hangs on one says `o.unchecked`.
 */
export function setupRows(plan: MirrorPlan, report: ConfigReport | undefined, o: { machine: string; fleetFlag: string; unchecked: string }): SetupRow[] {
  const m = o.machine;
  const rows: SetupRow[] = [];
  // an item's keys: ticked, once the worker holds each as the copy; unticked, once it holds each of its own
  const keys = (item: string, name: string, fields: string[], ticked: string[], preview: string[]): SetupRow => {
    const tick = { item, fields, on: fields.every((f) => ticked.includes(f)), preview };
    const all = (held: 'copied' | 'own'): boolean => fields.every((f) => report?.secrets[fieldKey(item, f)] === held);
    if (tick.on && all('copied')) return { key: item, status: 'ok', detail: `keys copied to ${m}: ${preview.join(', ')}`, tick };
    if (tick.on) return { key: item, status: 'warn', action: `check ${m} again`, detail: report ? `pushed; not yet on ${m}` : o.unchecked, tick };
    if (all('own')) return { key: item, status: 'ok', detail: `${m} has its own keys`, tick };
    return { key: item, status: 'warn', action: `copy ${name}'s keys to ${m}`, detail: `mirrored without ${preview.join(', ')}; or set them in ~/.svall/mirror-overrides on ${m}`, tick };
  };
  // a server or plugin config whose fields Svall does not know, which travels whole once each is ticked
  const whole = (item: string, name: string, fields: string[], on: boolean): SetupRow => {
    const tick = { item, fields, on, preview: fields };
    return on ? { key: item, status: 'ok', detail: `copied whole to ${m}`, tick }
      : { key: item, status: 'warn', action: `copy ${name} whole to ${m}`, detail: `${name} has fields Svall does not know; it is not mirrored until you tick it`, tick };
  };
  // an unknown server's preview names its fields
  for (const s of plan.servers) {
    if (!s.known) rows.push(whole(s.key, s.name, s.preview, Object.keys(s.entry).length > 0));
    else if (s.secretFields.length) rows.push(keys(s.key, s.name, s.secretFields, s.ticked, s.preview));
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
    else rows.push({ key, status: 'warn', action: `set ${v} on ${m}`, run: `svall ${o.fleetFlag}worker env ${v}`, detail: `${readers.join(', ')} read ${v}, which ${m}'s daemon does not have` });
  }
  for (const s of servers) {
    if (!s.oauth) continue;
    const key = `oauth:${s.key}`;
    if (s.agent !== 'claude') rows.push({ key, status: 'skip', ...s.oauth, detail: `log in once on ${m} with ${s.oauth.run}; Svall cannot see whether you did` });
    else if (report?.oauth[s.key]) rows.push({ key, status: 'ok', detail: `logged in on ${m}` });
    else rows.push({ key, status: 'warn', action: `log in once on ${m}`, ...s.oauth, detail: `then /mcp and sign in to ${s.name}` });
  }
  const missing = report ? [...new Set(servers.flatMap((s) => s.runtimes))].filter((bin) => report.commands[bin] === false) : [];
  for (const bin of missing) {
    const users = names((s) => s.runtimes.includes(bin)).join(', ');
    const key = `runtime:${bin}`;
    if (path.posix.isAbsolute(bin)) {
      rows.push({ key, status: 'warn', action: `install ${path.posix.basename(bin)} on ${m}`, detail: `${users} run ${bin}, which ${m} lacks (a path under this Mac's home is looked for under ${m}'s)` });
    } else rows.push({ key, status: 'warn', action: `install ${bin} on ${m}`, ...(Object.hasOwn(INSTALL_RUN, bin) && { run: INSTALL_RUN[bin] }), detail: `${users} need it` });
  }
  for (const s of plan.macOnly) {
    const key = `maconly:${s.agent}:${s.name}`;
    if (!rows.some((r) => r.key === key)) rows.push({ key, status: 'skip', detail: `${s.name} only runs on a Mac; not mirrored` });
  }
  for (const c of plan.configs) rows.push(keys(c.key, c.file, c.fields, c.ticked, c.preview));
  for (const p of plan.plugins) rows.push(whole(p.key, `${p.name}'s config`, p.fields, p.ticked));
  for (const f of plan.unreadable) rows.push({ key: `unreadable:${f}`, status: 'warn', detail: `${f} cannot be read as JSON or TOML; set it up on ${m} by hand` });
  return rows;
}
