import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@svall/protocol';
import { resolvePaths } from '@svall/svalld/paths';
import { agentCommand, setMainAgentCli, type AgentDeps } from '../src/commands/agent.js';

function deps(o: Partial<AgentDeps> = {}) {
  const paths = resolvePaths(fs.mkdtempSync(path.join(os.tmpdir(), 'svall-agent-')));
  const d: AgentDeps = { paths, found: ['claude', 'codex'], apply: vi.fn(async () => false), ...o };
  const saved = () => (fs.existsSync(paths.fleetConfig) ? JSON.parse(fs.readFileSync(paths.fleetConfig, 'utf8')).mainAgent : undefined);
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

describe('svall agent <name>', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('names the daemon that speaks another protocol, and leaves the config to it', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-agent-'));
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-agent-bin-'));
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    // an older svalld, as an app update leaves running until Svall reopens
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (ws) => ws.once('message', () => ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION - 1 } }))));
    fs.writeFileSync(path.join(home, 'port'), String((wss.address() as { port: number }).port));
    fs.writeFileSync(path.join(home, 'token'), 't');
    try {
      await expect(agentCommand(() => ({ name: 'private', home, managed: true }), () => true).parseAsync(['codex'], { from: 'user' }))
        .rejects.toThrow(`speaks protocol ${PROTOCOL_VERSION - 1}`);
      expect(fs.existsSync(resolvePaths(home).fleetConfig)).toBe(false);
    } finally {
      await new Promise((r) => wss.close(r));
    }
  });
});
