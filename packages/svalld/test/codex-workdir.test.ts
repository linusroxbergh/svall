import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { followRollout } from '../src/agent/codex-workdir.js';
import { cleanHomes, makeHome } from './helpers.js';

const ran = (cwd: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', cwd: `file://${cwd}` } } });

describe('followRollout', () => {
  afterEach(() => cleanHomes());

  it('keeps the place it found while later commands run where the session began', () => {
    const file = path.join(makeHome(), 'rollout.jsonl');
    fs.writeFileSync(file, ran('/repo/wt') + '\n');
    const first = followRollout(file, '/repo');
    expect(first).toEqual({ file, offset: fs.statSync(file).size, dir: '/repo/wt' });
    fs.appendFileSync(file, ran('/repo') + '\n');
    expect(followRollout(file, '/repo', first).dir).toBe('/repo/wt');
  });

  it('reads a line codex is still writing once it ends', () => {
    const file = path.join(makeHome(), 'rollout.jsonl');
    const line = ran('/repo/wt');
    fs.writeFileSync(file, line.slice(0, 20));
    const partial = followRollout(file, '/repo');
    expect(partial).toEqual({ file, offset: 0 });
    fs.appendFileSync(file, line.slice(20) + '\n');
    expect(followRollout(file, '/repo', partial).dir).toBe('/repo/wt');
  });

  it('starts over on a new rollout, and holds its mark while the file cannot be read', () => {
    const home = makeHome();
    const a = path.join(home, 'a.jsonl');
    fs.writeFileSync(a, ran('/repo/wt') + '\n');
    const mark = followRollout(a, '/repo');
    const b = path.join(home, 'b.jsonl');
    fs.writeFileSync(b, ran('/repo') + '\n');
    expect(followRollout(b, '/repo', mark).dir).toBeUndefined();
    fs.rmSync(a);
    expect(followRollout(a, '/repo', mark)).toBe(mark);
  });
});
