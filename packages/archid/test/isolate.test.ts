import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { claudePaths } from '../src/resources/scan.js';

describe('test isolation', () => {
  it('keeps tests off the Claude config and the terminal of whoever runs them', () => {
    expect(claudePaths().dir).toBe(path.join(os.homedir(), '.claude'));
    expect(process.env.ARCHI_TERM).toBeUndefined();
  });

  it('leaves the HOME a runner that does not move it gives the tests that write a Claude config', async () => {
    const home = fs.mkdtempSync('/tmp/archi-sentinel-');
    try {
      fs.mkdirSync(path.join(home, '.claude/projects/-Users-x-proj'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude/projects/-Users-x-proj/transcript.jsonl'), '{}\n');
      fs.writeFileSync(path.join(home, '.claude.json'), '{"projects":{}}');
      const claude = () => fs.readdirSync(path.join(home, '.claude'), { recursive: true }).sort();
      const before = claude();
      // the package on its own, as `pnpm --filter @archipelago/archid exec vitest` runs it, without the root config's isolate.ts
      const vitest = path.join(import.meta.dirname, '../../../node_modules/.bin/vitest');
      const { stdout } = await promisify(execFile)(vitest, ['run', 'test/handover/sessions.test.ts'], {
        cwd: path.join(import.meta.dirname, '..'), env: { ...process.env, HOME: home, CI: '1' },
      });
      expect(stdout).toMatch(/Test Files +1 passed \(1\)/);
      expect(claude()).toEqual(before);
      expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).toBe('{"projects":{}}');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
