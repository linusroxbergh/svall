import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FleetState } from '../src/state.js';

// the persisted shape of each state version, as a digest of every key, type, check and optionality
const SHAPES: Record<number, string> = {
  7: '67857c366a165d29',
  8: '903acc7de64031c2',
};

// a refine is a custom check, and its function cannot be read
const checks = (d: { checks?: z.core.$ZodCheck<never>[] }): unknown[] => (d.checks ?? []).map((c) => {
  if (c._zod.def.check === 'custom') throw new Error('the state shape digest does not read a refine');
  return c._zod.def;
});

// keys and enum values sorted, so a reorder is the same shape; a schema type it has not learned throws
const shape = (t: z.core.$ZodType): unknown => {
  const d = (t as z.core.$ZodTypes)._zod.def;
  switch (d.type) {
    case 'object': return [Object.entries(d.shape).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, shape(v)]), d.catchall && shape(d.catchall)];
    case 'optional': case 'default': case 'prefault': return [d.type, shape(d.innerType)];
    case 'record': return ['record', shape(d.keyType), shape(d.valueType)];
    case 'array': return ['array', shape(d.element), checks(d)];
    case 'enum': return ['enum', Object.values(d.entries).sort()];
    case 'literal': return ['literal', d.values];
    case 'string': case 'number': case 'boolean': case 'never': return [d.type, checks(d)];
    default: throw new Error(`the state shape digest does not read ${d.type}`);
  }
};

const digest = (t: z.core.$ZodType): string => crypto.createHash('sha256')
  .update(JSON.stringify(shape(t), (_, v: unknown) => (v instanceof RegExp ? String(v) : v))).digest('hex').slice(0, 16);

describe('state version', () => {
  // an older build drops what its schema rejects under its own version: a widened enum, a key made optional or
  // a looser check needs a new version and a migration; a new optional key needs only a new digest here
  it('changes the persisted shape only together with its version', () => {
    expect(digest(FleetState)).toBe(SHAPES[FleetState.shape.version.value]);
  });

  it('reads a reorder as the same shape, and a changed pattern, key, length or strictness or a schema type it has not learned as a different one', () => {
    expect(digest(z.object({ a: z.string(), b: z.enum(['x', 'y']) }))).toBe(digest(z.object({ b: z.enum(['y', 'x']), a: z.string() })));
    expect(digest(z.string().regex(/a/))).not.toBe(digest(z.string().regex(/b/)));
    expect(digest(z.record(z.string(), z.number()))).not.toBe(digest(z.record(z.string().regex(/^c_/), z.number())));
    expect(digest(z.array(z.number()))).not.toBe(digest(z.array(z.number()).length(2)));
    expect(digest(z.object({ a: z.string() }))).not.toBe(digest(z.object({ a: z.string() }).strict()));
    expect(digest(z.object({ a: z.string() }))).not.toBe(digest(z.object({ a: z.string() }).catchall(z.number())));
    for (const t of [z.union([z.string(), z.number()]), z.string().nullable(), z.string().refine(Boolean), z.tuple([z.string()])]) {
      expect(() => digest(t)).toThrow();
    }
  });
});
