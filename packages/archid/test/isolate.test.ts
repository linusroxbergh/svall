import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { AgentKind } from '@archipelago/protocol';
import { agentAdapters, probeAgent, realProbeDeps } from '../src/handover/sessions/registry.js';
import { claudePaths } from '../src/resources/scan.js';

describe('test isolation', () => {
  it('keeps tests off the Claude config and the terminal of whoever runs them', () => {
    expect(claudePaths().dir).toBe(path.join(os.homedir(), '.claude'));
    expect(process.env.ARCHI_TERM).toBeUndefined();
  });

  it('puts doubles of claude and codex first on PATH, a supported release logged in that holds no session to resume', async () => {
    const onPath = (cmd: string) => process.env.PATH!.split(':').map((d) => path.join(d, cmd)).find((f) => {
      try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; }
    });
    // before either runs, so a run without isolate.ts never reaches the real ones
    expect(os.homedir()).toMatch(/^\/tmp\/archi-home-/);
    expect([onPath('claude'), onPath('codex')]).toEqual([path.join(os.homedir(), 'bin/claude'), path.join(os.homedir(), 'bin/codex')]);

    const probes = await Promise.all(AgentKind.options.map((kind) => probeAgent(kind, realProbeDeps())));
    expect(agentAdapters(probes)).toEqual([
      expect.objectContaining({ kind: 'claude', version: '2.1.283', adapter: 1, loggedIn: true }),
      expect.objectContaining({ kind: 'codex', version: '0.156.1', adapter: 1, loggedIn: true }),
    ]);
    const run = promisify(execFile);
    const sid = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
    await expect(run('claude', ['--resume', sid, '--add-dir', '/tmp'])).rejects.toMatchObject({ code: 1, stderr: `No conversation found with session ID: ${sid}\n` });
    await expect(run('codex', ['resume', '-c', 'tui.resume_cwd=session', sid])).rejects.toMatchObject({ code: 1, stderr: `no rollout found for thread id ${sid}\n` });
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
        cwd: path.join(import.meta.dirname, '..'), env: { ...process.env, HOME: home, CI: '1', NO_COLOR: '1' },
      });
      expect(stdout).toMatch(/Test Files +1 passed \(1\)/);
      expect(claude()).toEqual(before);
      expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).toBe('{"projects":{}}');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
