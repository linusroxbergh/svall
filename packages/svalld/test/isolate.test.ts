import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { onPath } from '../src/agents.js';
import { HANDOVER_KINDS, agentAdapters, probeAgent, realProbeDeps } from '../src/handover/sessions/registry.js';
import { claudePaths } from '../src/paths.js';

describe('test isolation', () => {
  it('keeps tests off the Claude config and the terminal of whoever runs them', () => {
    expect(claudePaths().dir).toBe(path.join(os.homedir(), '.claude'));
    expect(process.env.SVALL_TERM).toBeUndefined();
  });

  it("finds a double for every CLI a test could reach the owner's machine through, before the real one", () => {
    const doubles = [process.env.SVALL_TEST_BIN, path.join(import.meta.dirname, 'fixtures/bin')];
    for (const bin of ['claude', 'codex', 'tailscale', 'gh', 'launchctl']) expect(doubles, bin).toContain(onPath(bin, process.env.PATH!));
  });

  it('gives claude, codex and opencode doubles of a supported release, logged in, and claude and codex ones that hold no session to resume', async () => {
    const probes = await Promise.all(HANDOVER_KINDS.map((kind) => probeAgent(kind, realProbeDeps())));
    expect(agentAdapters(probes)).toEqual([
      expect.objectContaining({ kind: 'claude', version: '2.1.283', adapter: 1, loggedIn: true }),
      expect.objectContaining({ kind: 'codex', version: '0.156.1', adapter: 1, loggedIn: true }),
      expect.objectContaining({ kind: 'opencode', version: '2.0.22', adapter: 1, loggedIn: true }),
    ]);
    const run = promisify(execFile);
    const sid = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
    await expect(run('claude', ['--resume', sid, '--add-dir', '/tmp'])).rejects.toMatchObject({ code: 1, stderr: `No conversation found with session ID: ${sid}\n` });
    await expect(run('codex', ['resume', '-c', 'tui.resume_cwd=session', sid])).rejects.toMatchObject({ code: 1, stderr: `no rollout found for thread id ${sid}\n` });
  });

  // a whole vitest run of sessions.test.ts: a few seconds alone, several times that beside the full suite
  it('leaves the HOME a runner that does not move it gives the tests that write a Claude config', async () => {
    const home = fs.mkdtempSync('/tmp/svall-sentinel-');
    try {
      fs.mkdirSync(path.join(home, '.claude/projects/-Users-x-proj'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude/projects/-Users-x-proj/transcript.jsonl'), '{}\n');
      fs.writeFileSync(path.join(home, '.claude.json'), '{"projects":{}}');
      const claude = () => fs.readdirSync(path.join(home, '.claude'), { recursive: true }).sort();
      const before = claude();
      // the package on its own, as `pnpm --filter @svall/svalld exec vitest` runs it, without the root config's isolate.ts
      const vitest = path.join(import.meta.dirname, '../../../node_modules/.bin/vitest');
      const { stdout } = await promisify(execFile)(vitest, ['run', 'test/handover/sessions.test.ts'], {
        cwd: path.join(import.meta.dirname, '..'), env: { ...process.env, HOME: home, CI: '1', NO_COLOR: '1' },
      });
      expect(stdout).toMatch(/Test Files +1 passed \(1\)/);
      expect(claude()).toEqual(before);
      expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).toBe('{"projects":{}}');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
