import { z } from 'zod';
import { Character, FleetState, Island, STATE_SCHEMA_VERSION } from './state.js';

const CURRENT = STATE_SCHEMA_VERSION;
const OLDEST = 7;

export class NewerStateVersion extends Error {
  constructor(version: number) {
    super(`state.json is version ${version}, newer than this svalld reads (${CURRENT}): update svall`);
  }
}

export class OlderStateVersion extends Error {
  constructor(version: number) {
    super(`state.json is version ${version}, older than this svalld reads (${OLDEST}): move it aside to start an empty fleet`);
  }
}

const Entities = z.object({ islands: z.record(z.string(), z.unknown()), characters: z.record(z.string(), z.unknown()) }).passthrough();

// each island, character and fleet-wide field is read on its own: one the schema rejects is left out, and named;
// a character outlives its island, for the daemon to re-home, and every fleet-wide field has a default or may be absent
function salvage(raw: object): { state: FleetState; dropped: string[] } {
  const whole = FleetState.safeParse(raw);
  if (whole.success) return { state: whole.data, dropped: [] };
  const dropped: string[] = [];
  const keep = (name: string, schema: z.ZodTypeAny | undefined, v: unknown): boolean => {
    const r = schema?.safeParse(v);
    if (r && !r.success) dropped.push(`${name}: ${r.error.issues[0].path.join('.')}: ${r.error.issues[0].message}`);
    return !r || r.success;
  };
  const each = (kind: string, schema: z.ZodTypeAny, all: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(all).filter(([id, v]) => keep(`${kind} ${id}`, schema, v)));
  const { islands, characters, ...fields } = Entities.parse(raw);
  const shape: Record<string, z.ZodTypeAny> = FleetState.shape;
  const kept = Object.fromEntries(Object.entries(fields).filter(([k, v]) => keep(`field ${k}`, shape[k], v)));
  return { state: FleetState.parse({ ...kept, islands: each('island', Island, islands), characters: each('character', Character, characters) }), dropped };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// up to v7 a second terminal had no directory of its own, so it starts where its character stands
function liftV8(raw: object): object {
  const { characters } = raw as { characters?: unknown };
  if (!isRecord(characters)) return raw;
  return {
    ...raw,
    characters: Object.fromEntries(Object.entries(characters).map(([id, c]) =>
      [id, isRecord(c) && isRecord(c.second) && c.second.cwd === undefined ? { ...c, second: { cwd: c.cwd, ...c.second } } : c])),
  };
}

export function migrateState(raw: unknown): { state: FleetState; migrated: boolean; dropped: string[] } {
  const version = (raw as { version?: unknown } | null)?.version;
  if (typeof version === 'number' && version > CURRENT) throw new NewerStateVersion(version);
  if (typeof version === 'number' && version < OLDEST) throw new OlderStateVersion(version);
  if (version !== 7 && version !== 8) throw new Error(`unsupported state version ${String(version)}`);
  if (version === 8) return { ...salvage(raw as object), migrated: false };
  return { ...salvage({ ...liftV8(raw as object), version: 8 }), migrated: true };
}
