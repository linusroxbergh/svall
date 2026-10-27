import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { preflight, realPreflightDeps, type PreflightDeps } from '../src/commands/preflight.js';

const loggedOut = () => Object.assign(new Error('Not logged in'), { code: 1 });

function deps(commands: Record<string, string | Error>, moves = true): PreflightDeps & { calls: string[] } {
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
    node: 'v24.0.0', pathEnv: '/u/.local/bin', shimDir: '/u/.local/bin', keys: {}, platform: 'darwin', moves,
  };
}

describe('preflight of an agent CLI below its version floor', () => {
  it('still asks whether it is signed in, and says so when it is not', async () => {
    const d = deps({ 'claude --version': '2.1.250 (Claude Code)\n', 'claude auth status --json': loggedOut() });
    const claude = (await preflight(d)).find((c) => c.name === 'claude');
    expect(claude).toEqual({
      name: 'claude', status: 'warn',
      detail: '2.1.250 (Claude Code): Svall needs 2.1.251 or newer; update Claude Code; not signed in: claude auth login',
      run: 'claude auth login',
    });
    expect(d.calls).toContain('claude auth status --json');
  });

  it('gives only the version warning when it is signed in', async () => {
    const d = deps({ 'claude --version': '2.1.250 (Claude Code)\n', 'claude auth status --json': '{"loggedIn":true}\n' });
    expect((await preflight(d)).find((c) => c.name === 'claude')?.detail).toBe('2.1.250 (Claude Code): Svall needs 2.1.251 or newer; update Claude Code');
  });

  it("leaves Claude Code below a move's floor be where no robot moves, and still holds the others to theirs", async () => {
    const d = deps({ 'claude --version': '2.1.250 (Claude Code)\n', 'claude auth status --json': '{"loggedIn":true}\n', 'codex --version': 'codex-cli 0.155.0\n', 'codex login status': '' }, false);
    const checks = await preflight(d);
    expect(checks.find((c) => c.name === 'claude')).toEqual({ name: 'claude', status: 'ok', detail: '2.1.250 (Claude Code), signed in' });
    expect(checks.find((c) => c.name === 'codex')?.detail).toBe('codex-cli 0.155.0: Svall needs 0.156.0 or newer; update Codex');
  });
});

describe('preflight of OpenCode', () => {
  it("says it is signed in only when auth list names a model provider's login, as a move's checks read it", async () => {
    const opencode = async (listed: object[]) => (await preflight(deps({
      'opencode --version': 'opencode v2.0.27\n', 'opencode auth list --standalone --format json': `${JSON.stringify(listed)}\n`,
    }))).find((c) => c.name === 'opencode');
    expect(await opencode([])).toEqual({ name: 'opencode', status: 'warn', detail: 'opencode v2.0.27, not signed in: opencode auth login', run: 'opencode auth login' });
    expect((await opencode([{ id: 'mcp_linear' }]))?.status).toBe('warn');
    expect(await opencode([{ id: 'openai' }])).toEqual({ name: 'opencode', status: 'ok', detail: 'opencode v2.0.27, signed in' });
  });
});

describe('realPreflightDeps', () => {
  const local = { id: '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f', record: { name: 'mac', platform: 'darwin', arch: 'arm64', home: '/Users/linus', svallBase: '/Users/linus/.svall' } };
  const entry = { id: '66666666-7777-8888-9999-aaaaaaaaaaaa', record: { name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64', home: '/home/linus', svallBase: '/home/linus/.local/share/svall' } };

  /** The checks a fleet gets on `platform` while machines.json holds `machines`, or the text `registry` names, with Claude Code at `claude`. */
  async function rows(o: { platform: NodeJS.Platform; machines?: (typeof entry | typeof local)[]; registry?: string; claude: string }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-pre-'));
    try {
      fs.writeFileSync(path.join(dir, 'machines.json'), o.registry ?? JSON.stringify({ machines: Object.fromEntries((o.machines ?? []).map((m) => [m.id, m.record])) }));
      vi.stubEnv('SVALL_CONFIG_DIR', dir);
      const { moves } = realPreflightDeps(dir, o.platform);
      return await preflight({ ...deps({ 'claude --version': `${o.claude} (Claude Code)\n`, 'claude auth status --json': '{"loggedIn":true}\n' }), platform: o.platform, moves });
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('checks the agent floor only where robots move: on Linux, and on a Mac whose machines.json lists one', async () => {
    expect(await rows({ platform: 'darwin', machines: [], claude: '2.1.200' })).not.toContainEqual(expect.objectContaining({ name: 'claude', status: 'warn' }));
    expect(await rows({ platform: 'darwin', machines: [entry], claude: '2.1.200' })).toContainEqual(expect.objectContaining({ name: 'claude', status: 'warn' }));
    expect(await rows({ platform: 'linux', machines: [], claude: '2.1.200' })).toContainEqual(expect.objectContaining({ name: 'claude', status: 'warn' }));
    // this Mac's own entry is no machine to move a robot to, and a registry that cannot be read may list one
    expect(await rows({ platform: 'darwin', machines: [local], claude: '2.1.200' })).not.toContainEqual(expect.objectContaining({ name: 'claude', status: 'warn' }));
    expect(await rows({ platform: 'darwin', registry: '{', claude: '2.1.200' })).toContainEqual(expect.objectContaining({ name: 'claude', status: 'warn' }));
  });
});
