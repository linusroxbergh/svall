import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { MachineId } from '@svall/protocol';
import { writeDurable } from '../durable.js';
import type { McpServer, Secret } from './mirror-config.js';

/** What the mirror asks consent for: a server by its item key, or a whole file by one of these. */
export const CONFIG_ITEMS = { settings: 'claude:settings', codex: 'codex:config', opencode: 'opencode:config' } as const;

export function itemKey(s: McpServer): string {
  if (s.scope === 'user') return `${s.agent}:mcp:${s.name}`;
  return 'project' in s.scope ? `${s.agent}:mcp:${s.name}@${s.scope.project}` : `claude:plugin:${s.scope.plugin}:mcp:${s.name}`;
}

/** A plugin's settings.json, whose fields the mirror does not know. */
export const pluginKey = (name: string): string => `claude:plugin:${name}`;

/** The unit of consent: one field of one item. */
export const fieldKey = (item: string, field: string): string => `${item}#${field}`;

const Consent = z.record(z.string(), z.array(z.string()));

function readAll(file: string): Record<string, string[]> {
  try {
    const p = Consent.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return p.success ? p.data : {};
  } catch {
    return {};
  }
}

/** The field keys ticked for `machine`; none for a file that is missing or cannot be read. */
export const readConsent = (file: string, machine: MachineId): Set<string> => new Set(readAll(file)[machine] ?? []);

function writeAll(file: string, all: Record<string, string[]>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeDurable(file, all, { mode: 0o600 });
}

/** Ticks each of `fields` of `item` for `machine`, or, `on` false, unticks every field of it. */
export function setConsent(file: string, machine: MachineId, item: string, fields: string[], on: boolean): void {
  const all = readAll(file);
  const keys = (all[machine] ?? []).filter((k) => on || !k.startsWith(`${item}#`));
  if (on) for (const f of fields) if (!keys.includes(fieldKey(item, f))) keys.push(fieldKey(item, f));
  all[machine] = keys;
  writeAll(file, all);
}

export function clearConsent(file: string, machine: MachineId): void {
  const all = readAll(file);
  delete all[machine];
  writeAll(file, all);
}

/** The ones of `fields` ticked for `item`; the item is on when they are all of them. */
export const tickedFields = (consent: ReadonlySet<string>, item: string, fields: string[]): string[] => fields.filter((f) => consent.has(fieldKey(item, f)));

/** A value shown masked: its ends when it is long enough to keep them hidden. */
export const mask = (v: string): string => (v.length >= 16 ? `${v.slice(0, 3)}…${v.slice(-2)}` : '••••');

export const preview = (secrets: Secret[]): string[] => secrets.map((f) => `${f.field} ${mask(f.value)}`);
