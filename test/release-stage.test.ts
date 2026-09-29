import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { schemaVersions } from '../scripts/release-stage.mjs';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const temp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archi-release-stage-'));
  dirs.push(dir);
  return dir;
};

describe('the versions a release records', () => {
  it('names each version a handover has to agree on, and nothing a build leaves empty', async () => {
    const versions = await schemaVersions(temp());
    expect(Object.keys(versions).sort()).toEqual(['authoritySchema', 'protocol', 'stateSchema', 'transferSchema']);
    for (const [name, v] of Object.entries(versions)) expect(Number.isInteger(v), name).toBe(true);
  });
});
