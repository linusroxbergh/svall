import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config, configuredMainAgent, loadConfig, saveMainAgent } from '../src/config.js';
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
  const paths = () => resolvePaths(makeHome());
  it('sets the key in fleet.json and keeps every other one', () => {
    const p = paths();
    const id = crypto.randomUUID();
    fs.writeFileSync(p.fleetConfig, JSON.stringify({ id, scribe: { model: 'haiku' } }));
    saveMainAgent(p, 'codex');
    expect(JSON.parse(fs.readFileSync(p.fleetConfig, 'utf8'))).toEqual({ id, scribe: { model: 'haiku' }, mainAgent: 'codex' });
    expect(loadConfig(p).mainAgent).toBe('codex');
  });
  it('creates fleet.json when there is none', () => {
    const p = paths();
    saveMainAgent(p, 'claude');
    expect(loadConfig(p).mainAgent).toBe('claude');
  });
  it('splits a config.json out first, so the choice lands beside what it held', () => {
    const p = paths();
    fs.writeFileSync(p.legacyConfig, JSON.stringify({ port: 47801, scribe: { model: 'haiku' } }));
    saveMainAgent(p, 'codex');
    expect(fs.existsSync(p.legacyConfig)).toBe(false);
    expect(loadConfig(p)).toMatchObject({ port: 47801, scribe: { model: 'haiku' }, mainAgent: 'codex' });
  });
  it('refuses a file that does not parse, and leaves it as it was', () => {
    const p = paths();
    fs.writeFileSync(p.nodeConfig, '{}');
    fs.writeFileSync(p.fleetConfig, '{ "id": 1,');
    expect(() => saveMainAgent(p, 'codex')).toThrow(/invalid config/);
    expect(fs.readFileSync(p.fleetConfig, 'utf8')).toBe('{ "id": 1,');
  });
  it('writes a linked fleet.json where it points, keeping its mode', () => {
    const p = paths();
    const real = path.join(p.home, 'dotfiles.json');
    fs.writeFileSync(real, JSON.stringify({ id: crypto.randomUUID() }), { mode: 0o640 });
    fs.symlinkSync(real, p.fleetConfig);
    saveMainAgent(p, 'codex');
    expect(fs.lstatSync(p.fleetConfig).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, 'utf8')).mainAgent).toBe('codex');
    expect(fs.statSync(real).mode & 0o777).toBe(0o640);
  });
  it('leaves the scribe agent unset unless it is named', () => {
    expect(loadConfig(paths()).scribe.agent).toBeUndefined();
  });
  it('is read from fleet.json, or from a config.json not yet split, without splitting it', () => {
    const p = paths();
    expect(configuredMainAgent(p)).toBeUndefined();
    fs.writeFileSync(p.legacyConfig, JSON.stringify({ mainAgent: 'codex' }));
    expect(configuredMainAgent(p)).toBe('codex');
    expect(fs.existsSync(p.fleetConfig)).toBe(false);
    saveMainAgent(p, 'claude');
    expect(configuredMainAgent(p)).toBe('claude');
  });
});
