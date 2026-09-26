import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanHomes, makeHome } from '@archipelago/archid/test-helpers';
import { daemonRuns, setupCommand } from '../src/commands/setup.js';

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

describe('archi setup on Linux', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = 0; cleanHomes(); });

  it('looks for claude on the PATH the units run with, which holds ~/.local/bin where an ssh login may not', async () => {
    const home = makeHome();
    vi.stubEnv('HOME', home);
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\necho "2.1.300 (Claude Code)"\n', { mode: 0o755 });
    vi.stubEnv('PATH', '/usr/bin:/bin');
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    await setupCommand(() => ({ name: 'private', home: path.join(home, '.archipelago'), managed: true }), () => true, 'linux')
      .parseAsync(['--check'], { from: 'user' });
    // with no ~/.claude yet, only a claude found makes setup write its hooks
    expect(JSON.parse(out.join('')).warnings).toContain('! hooks  missing or out of date: run archi setup');
  });
});
