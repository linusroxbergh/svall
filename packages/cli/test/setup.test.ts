import { describe, expect, it } from 'vitest';
import { daemonRuns } from '../src/commands/setup.js';

describe('the probe after a Linux upgrade', () => {
  const daemon = (release: string) => () => Promise.resolve({ call: () => Promise.resolve({ release }), close: () => undefined });

  it('passes only a daemon that reports the release just installed', async () => {
    expect(await daemonRuns('1.2.4', daemon('1.2.4'), 0)).toBe(true);
    // the old daemon still answering is the upgrade that never restarted
    expect(await daemonRuns('1.2.4', daemon('1.2.3'), 300)).toBe(false);
  });

  it('keeps asking a daemon that is not up yet', async () => {
    let tries = 0;
    const late = () => (++tries < 3 ? Promise.reject(new Error('ECONNREFUSED')) : daemon('1.2.4')());
    expect(await daemonRuns('1.2.4', late, 5000, 10)).toBe(true);
  });
});
