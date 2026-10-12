import { describe, expect, it } from 'vitest';
import { fullWake, fullWakeIn } from '../src/scribe/wake.js';

describe('fullWake', () => {
  it('reads a dark wake as pmset reports it: no Graphics among the capabilities', () => {
    expect(fullWakeIn('Current System Capabilities are: CPU Graphics Audio Network \nCurrent Power State: 4\n')).toBe(true);
    expect(fullWakeIn('Current System Capabilities are: CPU Network \nCurrent Power State: 4\n')).toBe(false);
    expect(fullWakeIn('')).toBe(true);
  });

  it.runIf(process.platform === 'darwin')('reads this Mac as awake while the tests run', async () => {
    expect(await fullWake()).toBe(true);
  });
});
