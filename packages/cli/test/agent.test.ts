import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { setMainAgentCli, type AgentDeps } from '../src/commands/agent.js';

function deps(o: Partial<AgentDeps> = {}) {
  const configFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'svall-agent-')), 'config.json');
  const d: AgentDeps = { configFile, found: ['claude', 'codex'], apply: vi.fn(async () => false), ...o };
  const saved = () => (fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')).mainAgent : undefined);
  return { d, saved };
}

describe('setMainAgentCli', () => {
  it('lets a running svalld check and save it', async () => {
    const { d, saved } = deps({ apply: vi.fn(async () => true) });
    expect(await setMainAgentCli(d, 'codex')).toBe('Main agent: Codex');
    expect(d.apply).toHaveBeenCalledWith('codex');
    expect(saved()).toBeUndefined(); // svalld wrote it, not svall
  });
  it("passes svalld's refusal on and saves nothing", async () => {
    const { d, saved } = deps({ apply: vi.fn(async () => { throw new Error("svalld doesn't find codex; install Codex, then run svall setup"); }) });
    await expect(setMainAgentCli(d, 'codex')).rejects.toThrow("svalld doesn't find codex");
    expect(saved()).toBeUndefined();
  });
  it('saves it itself when no svalld answers', async () => {
    const { d, saved } = deps();
    expect(await setMainAgentCli(d, 'codex')).toBe('Main agent: Codex; svalld uses it from its next start');
    expect(saved()).toBe('codex');
  });
  it('refuses a CLI that is not installed when no svalld answers', async () => {
    const { d, saved } = deps({ found: ['claude'] });
    await expect(setMainAgentCli(d, 'codex')).rejects.toThrow('codex is not on PATH; install Codex first');
    expect(saved()).toBeUndefined();
  });
});
