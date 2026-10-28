import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { envValueFault, writeEnvVar } from '../src/env-file.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

describe('the fleet .env writer', () => {
  it('writes NAME=value, mode 600, in place of an earlier line, keeping the others and leaving one line when the file held two', () => {
    const file = path.join(makeHome(), '.env');
    writeEnvVar(file, 'GAMMA_TOKEN', 'xyz');
    expect(fs.readFileSync(file, 'utf8')).toBe('GAMMA_TOKEN=xyz\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.writeFileSync(file, 'A=1\nGAMMA_TOKEN=old\nB=2\nexport GAMMA_TOKEN=older\n');
    writeEnvVar(file, 'GAMMA_TOKEN', 'new');
    expect(fs.readFileSync(file, 'utf8')).toBe('A=1\nGAMMA_TOKEN=new\nB=2\n');
    writeEnvVar(file, 'C', '3');
    expect(fs.readFileSync(file, 'utf8')).toBe('A=1\nGAMMA_TOKEN=new\nB=2\nC=3\n');
  });

  it('names the fault of a value the reader would give back changed', () => {
    expect(envValueFault('ok-value')).toBeUndefined();
    for (const v of ['a\nb', ' a', 'a ', '"a"', "'a'"]) expect(envValueFault(v)).toContain('cannot be stored in .env');
  });
});
