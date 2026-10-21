import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { preflight, realPreflightDeps, type PreflightDeps } from '../src/commands/preflight.js';

const loggedOut = () => Object.assign(new Error('Not logged in'), { code: 1 });

function deps(commands: Record<string, string | Error>, handover = true): PreflightDeps & { calls: string[] } {
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
    node: 'v24.0.0', pathEnv: '/u/.local/bin', shimDir: '/u/.local/bin', keys: {}, platform: 'darwin', handover,
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

  it("leaves Claude Code below a handover's floor be for a fleet that never hands over, and still holds the others to theirs", async () => {
    const d = deps({ 'claude --version': '2.1.250 (Claude Code)\n', 'claude auth status --json': '{"loggedIn":true}\n', 'codex --version': 'codex-cli 0.155.0\n', 'codex login status': '' }, false);
    const checks = await preflight(d);
    expect(checks.find((c) => c.name === 'claude')).toEqual({ name: 'claude', status: 'ok', detail: '2.1.250 (Claude Code), signed in' });
    expect(checks.find((c) => c.name === 'codex')?.detail).toBe('codex-cli 0.155.0: Svall needs 0.156.0 or newer; update Codex');
  });
});

describe('realPreflightDeps', () => {
  it('counts a fleet as handing over once fleet.json names a gateway or turns handover on, and any fleet on Linux', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-pre-'));
    try {
      const fleet = (more: object) => fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f', ...more }));
      expect(realPreflightDeps(home, 'darwin').handover).toBe(false);
      expect(realPreflightDeps(home, 'linux').handover).toBe(true);
      fleet({ handover: { enabled: false } });
      expect(realPreflightDeps(home, 'darwin').handover).toBe(false);
      fleet({ handover: { enabled: true } });
      expect(realPreflightDeps(home, 'darwin').handover).toBe(true);
      fleet({ gatewayMachineId: '11111111-2222-3333-4444-555555555555' });
      expect(realPreflightDeps(home, 'darwin').handover).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
