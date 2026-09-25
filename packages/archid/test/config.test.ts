import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config, loadConfig, saveMainAgent } from '../src/config.js';
import { newId } from '../src/ids.js';
import { resolvePaths, userPaths } from '../src/paths.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(() => { cleanHomes(); vi.unstubAllEnvs(); });

describe('config and paths', () => {
  it('defaults when the fleet has no home', () => {
    expect(loadConfig(resolvePaths('/nonexistent'))).toMatchObject({ port: 47800, host: '127.0.0.1' });
  });
  it('merges a partial file', () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'node.json'), JSON.stringify({ port: 1234 }));
    expect(loadConfig(resolvePaths(home)).port).toBe(1234);
  });
  it('derives all paths from home', () => {
    const p = resolvePaths('/x');
    expect(p.tmuxSock).toBe('/x/tmux.sock');
    expect(p.hookScript).toBe('/x/hooks/agent-hook.mjs');
    expect(p.statusScript).toBe('/x/hooks/claude-status.mjs');
    expect(p.push).toBe(path.join('/x', 'push.json'));
    expect(p.vapid).toBe(path.join('/x', 'vapid.json'));
    expect([p.fleetConfig, p.nodeConfig, p.legacyConfig]).toEqual(['/x/fleet.json', '/x/node.json', '/x/config.json']);
    expect([p.owner, p.handoverDir, p.journal, p.replicas]).toEqual(['/x/owner.json', '/x/handover', '/x/handover/journal.json', '/x/replicas']);
    expect(p.preparedState('tx-1')).toBe('/x/handover/prepared-tx-1.json');
    expect(p.preparedState('../escape')).toBe('/x/handover/prepared-..%2Fescape.json');
  });
  it('finds the Claude settings in CLAUDE_CONFIG_DIR when it is set', () => {
    const home = path.join(os.homedir(), '.claude', 'settings.json');
    expect(userPaths().claudeSettings).toBe(home);
    expect(userPaths().claudeSettingsFiles).toEqual([home]);
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/x/claude');
    expect(userPaths().claudeSettings).toBe('/x/claude/settings.json');
    expect(userPaths().claudeSettingsFiles).toEqual(['/x/claude/settings.json', home]);
  });
  it('defaults the home block and merges a partial one', () => {
    expect(Config.parse({}).mobile.pushContact).toBeUndefined();
    expect(Config.parse({ mobile: { pushContact: 'mailto:me@example.com' } }).mobile.pushContact).toBe('mailto:me@example.com');
    expect(() => Config.parse({ mobile: { pushContact: 'me@example.com' } })).toThrow('mailto');
    expect(Config.parse({}).mobile.httpsPort).toBeUndefined();
    expect(Config.parse({ mobile: { httpsPort: 10000 } }).mobile.httpsPort).toBe(10000);
    expect(() => Config.parse({ mobile: { httpsPort: 8080 } })).toThrow();
    expect(loadConfig(resolvePaths('/nonexistent')).home).toEqual({
      cwd: '~/.archipelago/home',
      actions: [
        { label: 'update info', prompt: '/archi-update-info' }, { label: 'status', prompt: '/archi-status' },
      ],
    });
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify({ id: crypto.randomUUID(), home: { cwd: '/mc', actions: [{ label: 'x', prompt: '/x' }] } }));
    expect(loadConfig(resolvePaths(home)).home).toEqual({ cwd: '/mc', actions: [{ label: 'x', prompt: '/x' }] });
    expect(Config.parse({ home: { command: 'my-agent' } }).home.command).toBe('my-agent');
  });
  it('makes prefixed ids', () => {
    expect(newId('c')).toMatch(/^c_[a-z0-9]{6}$/);
    expect(newId('i')).not.toBe(newId('i'));
  });
});

describe('saveMainAgent', () => {
  const file = () => path.join(makeHome(), 'config.json');
  it('sets the key and keeps every other one', () => {
    const f = file();
    fs.writeFileSync(f, JSON.stringify({ port: 47801, scribe: { model: 'haiku' } }));
    saveMainAgent(f, 'codex');
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({ port: 47801, scribe: { model: 'haiku' }, mainAgent: 'codex' });
    expect(loadConfig(f).mainAgent).toBe('codex');
  });
  it('creates the file when there is none', () => {
    const f = file();
    saveMainAgent(f, 'claude');
    expect(loadConfig(f).mainAgent).toBe('claude');
  });
  it('refuses a file that does not parse, and leaves it as it was', () => {
    const f = file();
    fs.writeFileSync(f, '{ "port": 1,');
    expect(() => saveMainAgent(f, 'codex')).toThrow(/invalid config/);
    expect(fs.readFileSync(f, 'utf8')).toBe('{ "port": 1,');
  });
  it('writes a linked config.json where it points, keeping its mode', () => {
    const dir = makeHome();
    const real = path.join(dir, 'dotfiles.json');
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(real, '{}', { mode: 0o600 });
    fs.symlinkSync(real, f);
    saveMainAgent(f, 'codex');
    expect(fs.lstatSync(f).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, 'utf8')).mainAgent).toBe('codex');
    expect(fs.statSync(real).mode & 0o777).toBe(0o600);
  });
  it('leaves the scribe agent unset unless it is named', () => {
    expect(loadConfig(file()).scribe.agent).toBeUndefined();
  });
});
