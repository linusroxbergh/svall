import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { calibrate, calibrated, DEFAULT_CPT, readCalibration, writeCalibration } from '../src/retro/calibrate.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

describe('calibration', () => {
  it('starts at 3 characters a token and moves a fifth of the way toward each sample', () => {
    expect(calibrated({}, 'claude')).toBe(DEFAULT_CPT);
    // 40k characters that took 11k tokens, 1k of them the CLI's own: 4 a token
    const once = calibrate({}, 'claude', { chars: 40_000, input: 11_000, overhead: 1_000 });
    expect(once).toEqual({ claude: { cpt: 3.2, n: 1 } });
    expect(calibrated(calibrate(once, 'claude', { chars: 40_000, input: 11_000, overhead: 1_000 }), 'claude')).toBeCloseTo(3.36, 6);
  });

  it('keeps families apart, clamps a wild sample and skips a call with no usage', () => {
    const c = calibrate({ claude: { cpt: 3.2, n: 1 } }, 'openai', { chars: 100_000, input: 30_001, overhead: 30_000 });
    expect(c.claude).toEqual({ cpt: 3.2, n: 1 });
    // a sample past 6 counts as 6
    expect(c.openai).toEqual({ cpt: 3.6, n: 1 });
    expect(calibrate(c, 'openai', { chars: 1_000, input: 0, overhead: 30_000 })).toBe(c);
  });

  it('writes 0600 and reads back, and reads a missing or broken file as none', () => {
    const file = path.join(makeHome(), 'retro', 'calibration.json');
    expect(readCalibration(file)).toEqual({});
    writeCalibration(file, { claude: { cpt: 3.2, n: 1 } });
    expect(readCalibration(file)).toEqual({ claude: { cpt: 3.2, n: 1 } });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.writeFileSync(file, '{"claude":{"cpt":"x"}}');
    expect(readCalibration(file)).toEqual({});
  });
});
