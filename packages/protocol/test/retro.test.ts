import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FOCUS_OF, FleetConfig, JudgeReply, Note, NoteReply } from '../src/index.js';

// every object in a JSON schema lists all its properties as required, as Codex's output schemas demand
function allRequired(s: unknown): string[] {
  if (!s || typeof s !== 'object') return [];
  const o = s as { type?: unknown; properties?: Record<string, unknown>; required?: string[] };
  const here = o.properties && JSON.stringify([...(o.required ?? [])].sort()) !== JSON.stringify(Object.keys(o.properties).sort()) ? [Object.keys(o.properties).join(',')] : [];
  return [...here, ...Object.values(o).flatMap((v) => (Array.isArray(v) ? v.flatMap(allRequired) : allRequired(v)))];
}

const note = { source: { agent: 'claude', session: 's', line: 3 }, focus: 'skill-tweaks', category: 'skipped-step', target: null, claim: 'c', quote: 'q' };

describe('retro contracts', () => {
  it("takes a note's category only from its focus", () => {
    expect(Note.safeParse(note).success).toBe(true);
    expect(Note.safeParse({ ...note, category: 'test-gap' }).success).toBe(false);
    expect(Note.safeParse({ ...note, source: { pr: 'https://github.com/o/r/pull/1' } }).success).toBe(true);
  });

  it('asks the model for every field, so a Codex output schema takes it', () => {
    expect(allRequired(z.toJSONSchema(NoteReply))).toEqual([]);
    expect(allRequired(z.toJSONSchema(JudgeReply))).toEqual([]);
  });

  it('reads skills and reviews as three focuses', () => {
    expect(FOCUS_OF['skills-reviews']).toEqual(['skill-tweaks', 'skill-triggers', 'review-tweaks']);
    expect(FOCUS_OF.all).toHaveLength(5);
  });

  it('parses a fleet.json with no retro, and keeps a saved one', () => {
    const id = '5e1f0b1c-2d3e-4f50-8617-9a0b1c2d3e4f';
    expect(FleetConfig.parse({ id }).retro).toEqual({ exclude: { repos: [], islands: [] }, unrecorded: [] });
    const retro = { exclude: { repos: ['/r'], islands: ['Life'] }, unrecorded: ['/u'], model: { claude: { read: 'haiku' } }, reviewSkills: ['work-review'] };
    expect(FleetConfig.parse({ id, retro }).retro).toEqual(retro);
  });
});
