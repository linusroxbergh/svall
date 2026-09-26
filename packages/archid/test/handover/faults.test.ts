import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAILPOINTS, armFailpoints, boundary, type Edge, type Failpoint } from '../../src/handover/failpoints.js';
import { cleanHomes, makeHome } from '../helpers.js';

afterEach(cleanHomes);

const REPO = path.join(import.meta.dirname, '../../../..');
const NAMES = Object.keys(FAILPOINTS) as Failpoint[];

describe('the failpoint registry', () => {
  it('runs a step as it is while nothing arms it', async () => {
    expect(boundary('source.freeze.journal', () => 7)).toBe(7);
    await expect(boundary('source.freeze.surrender', async () => 8)).resolves.toBe(8);
  });

  it('calls the armed hook on both edges of a step, after a promise only once it fulfils', async () => {
    const seen: string[] = [];
    const disarm = armFailpoints((name, edge) => { seen.push(`${name}:${edge}`); });
    try {
      boundary('source.freeze.journal', () => seen.push('step'));
      await boundary('source.freeze.surrender', async () => { seen.push('async step'); });
      await boundary('source.rest.kill', async () => { throw new Error('tmux went away'); }).catch(() => seen.push('refused'));
    } finally {
      disarm();
    }
    boundary('source.freeze.digest', () => seen.push('disarmed'));
    expect(seen).toEqual([
      'source.freeze.journal:before', 'step', 'source.freeze.journal:after',
      'source.freeze.surrender:before', 'async step', 'source.freeze.surrender:after',
      'source.rest.kill:before', 'refused', 'disarmed',
    ]);
  });

  it('stops a step at the edge where its hook throws', () => {
    const ran: Edge[] = [];
    const disarm = armFailpoints((_name, edge) => { if (edge === 'before') throw new Error('crashed'); });
    try {
      expect(() => boundary('source.freeze.journal', () => ran.push('after'))).toThrow('crashed');
    } finally {
      disarm();
    }
    expect(ran).toEqual([]);
  });

  it('cannot be armed in a release', () => {
    process.env.ARCHI_RELEASE_ROOT = makeHome();
    try {
      expect(() => armFailpoints(() => {})).toThrow(/release/);
    } finally {
      delete process.env.ARCHI_RELEASE_ROOT;
    }
  });

  it('names every failpoint where a step of the code runs it', () => {
    const sources = ['packages/archid/src', 'packages/cli/src'].flatMap((dir) => (fs.readdirSync(path.join(REPO, dir), { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts') && !f.endsWith('failpoints.ts')).map((f) => fs.readFileSync(path.join(REPO, dir, f), 'utf8')));
    expect(NAMES.filter((name) => !sources.some((text) => text.includes(`'${name}'`)))).toEqual([]);
  });
});
