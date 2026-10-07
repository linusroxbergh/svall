import { describe, expect, it } from 'vitest';
import { preflight, type PreflightDeps } from '../src/commands/preflight.js';

const loggedOut = () => Object.assign(new Error('Not logged in'), { code: 1 });

function deps(commands: Record<string, string | Error>): PreflightDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: async (cmd, args) => {
      const key = [cmd, ...args].join(' ');
      calls.push(key);
      const answer = commands[key];
      if (answer === undefined) throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
      if (answer instanceof Error) throw answer;
      return answer;
    },
    node: 'v24.0.0', pathEnv: '/u/.local/bin', shimDir: '/u/.local/bin', keys: {}, platform: 'darwin',
  };
}

describe('preflight of an agent CLI below its version floor', () => {
  it('still asks whether it is signed in, and says so when it is not', async () => {
    const d = deps({ 'claude --version': '2.1.250 (Claude Code)\n', 'claude auth status --json': loggedOut() });
    const claude = (await preflight(d)).find((c) => c.name === 'claude');
    expect(claude).toEqual({
      name: 'claude', status: 'warn',
      detail: '2.1.250 (Claude Code): Svall needs 2.1.251 or newer; update Claude Code; not signed in: claude auth login',
    });
    expect(d.calls).toContain('claude auth status --json');
  });

  it('gives only the version warning when it is signed in', async () => {
    const d = deps({ 'claude --version': '2.1.250 (Claude Code)\n', 'claude auth status --json': '{"loggedIn":true}\n' });
    expect((await preflight(d)).find((c) => c.name === 'claude')?.detail).toBe('2.1.250 (Claude Code): Svall needs 2.1.251 or newer; update Claude Code');
  });
});
