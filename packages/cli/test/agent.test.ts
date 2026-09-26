import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolvePaths } from '@archipelago/archid/paths';
import { setMainAgentCli, type AgentDeps } from '../src/commands/agent.js';

function deps(o: Partial<AgentDeps> = {}) {
  const paths = resolvePaths(fs.mkdtempSync(path.join(os.tmpdir(), 'archi-agent-')));
  const d: AgentDeps = { paths, found: ['claude', 'codex'], apply: vi.fn(async () => false), ...o };
  const saved = () => (fs.existsSync(paths.fleetConfig) ? JSON.parse(fs.readFileSync(paths.fleetConfig, 'utf8')).mainAgent : undefined);
  return { d, saved };
}

describe('setMainAgentCli', () => {
  it('lets a running archid check and save it', async () => {
    const { d, saved } = deps({ apply: vi.fn(async () => true) });
    expect(await setMainAgentCli(d, 'codex')).toBe('Main agent: Codex');
    expect(d.apply).toHaveBeenCalledWith('codex');
    expect(saved()).toBeUndefined(); // archid wrote it, not archi
  });
  it("passes archid's refusal on and saves nothing", async () => {
    const { d, saved } = deps({ apply: vi.fn(async () => { throw new Error("archid doesn't find codex; install Codex, then run archi setup"); }) });
    await expect(setMainAgentCli(d, 'codex')).rejects.toThrow("archid doesn't find codex");
    expect(saved()).toBeUndefined();
  });
  it('saves it itself when no archid answers', async () => {
    const { d, saved } = deps();
    expect(await setMainAgentCli(d, 'codex')).toBe('Main agent: Codex; archid uses it from its next start');
    expect(saved()).toBe('codex');
  });
  it('refuses a CLI that is not installed when no archid answers', async () => {
    const { d, saved } = deps({ found: ['claude'] });
    await expect(setMainAgentCli(d, 'codex')).rejects.toThrow('codex is not on PATH; install Codex first');
    expect(saved()).toBeUndefined();
  });
});
