import { z } from 'zod';
import { FleetState, Island, Robot, STATE_SCHEMA_VERSION, defaultColumns } from './state.js';

/** The oldest state.json version any release has read, which this one still lifts to its own. */
export const OLDEST_STATE_SCHEMA_VERSION = 7;

const CURRENT = STATE_SCHEMA_VERSION;
const OLDEST = OLDEST_STATE_SCHEMA_VERSION;

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

const Entities = z.object({ islands: z.record(z.string(), z.unknown()), robots: z.record(z.string(), z.unknown()) }).passthrough();

// each island, robot and fleet-wide field is read on its own: one the schema rejects is left out, and named;
// a robot outlives its island, for the daemon to re-home, and every fleet-wide field has a default or may be absent
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
  const { islands, robots, ...fields } = Entities.parse(raw);
  const shape: Record<string, z.ZodTypeAny> = FleetState.shape;
  const kept = Object.fromEntries(Object.entries(fields).filter(([k, v]) => keep(`field ${k}`, shape[k], v)));
  return { state: FleetState.parse({ ...kept, islands: each('island', Island, islands), robots: each('robot', Robot, robots) }), dropped };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// up to v8 a second terminal had no directory of its own, so it starts where its character stands;
// v8 only added OpenCode as an agent kind, so a v7 file lifts the same way
function liftV9(raw: object): object {
  const { characters } = raw as { characters?: unknown };
  if (!isRecord(characters)) return raw;
  return {
    ...raw,
    characters: Object.fromEntries(Object.entries(characters).map(([id, c]) =>
      [id, isRecord(c) && isRecord(c.second) && c.second.cwd === undefined ? { ...c, second: { cwd: c.cwd, ...c.second } } : c])),
  };
}

// a v9 file keeps its robots under characters, and each one's figure under robot
function liftV10(raw: object): object {
  const { characters, ...rest } = raw as { characters?: unknown };
  if (!isRecord(characters)) return raw;
  return {
    ...rest,
    robots: Object.fromEntries(Object.entries(characters).map(([id, c]) => {
      if (!isRecord(c) || !('robot' in c)) return [id, c];
      const { robot, ...kept } = c;
      return [id, { ...kept, figure: robot }];
    })),
  };
}

// a v10 file has no board: it gets the default columns with every robot in the first, and placing waits on the user's ask
function liftV11(raw: object): object {
  return { ...raw, columns: defaultColumns(), placingAsk: true };
}

export function migrateState(raw: unknown): { state: FleetState; migrated: boolean; dropped: string[] } {
  const version = (raw as { version?: unknown } | null)?.version;
  if (typeof version === 'number' && version > CURRENT) throw new NewerStateVersion(version);
  if (typeof version === 'number' && version < OLDEST) throw new OlderStateVersion(version);
  if (version !== 7 && version !== 8 && version !== 9 && version !== 10 && version !== CURRENT) throw new Error(`unsupported state version ${String(version)}`);
  if (version === CURRENT) return { ...salvage(raw as object), migrated: false };
  const lifted = version === 9 || version === 10 ? raw as object : liftV9(raw as object);
  return { ...salvage({ ...liftV11(version === 10 ? lifted : liftV10(lifted)), version: CURRENT }), migrated: true };
}
