import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config, fleetMainAgent, keptPorts, loadConfig, saveConfig } from '../src/config.js';
import { newId } from '../src/ids.js';
import { resolvePaths, userPaths } from '../src/paths.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(() => { cleanHomes(); vi.unstubAllEnvs(); });

describe('config and paths', () => {
  it('defaults when the file is missing', () => {
    const c = loadConfig('/nonexistent/config.json');
    expect([c.port, c.host]).toEqual([undefined, '127.0.0.1']);
  });
  it('merges a partial file', () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port: 1234 }));
    expect(loadConfig(path.join(home, 'config.json')).port).toBe(1234);
  });
  it('derives all paths from home', () => {
    const p = resolvePaths('/x');
    expect(p.tmuxSock).toBe('/x/tmux.sock');
    expect(p.hookScript).toBe('/x/hooks/agent-hook.mjs');
    expect(p.statusScript).toBe('/x/hooks/claude-status.mjs');
    expect(p.push).toBe(path.join('/x', 'push.json'));
    expect(p.vapid).toBe(path.join('/x', 'vapid.json'));
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
    expect(Config.parse({ mobile: { httpsPort: 8444 } }).mobile.httpsPort).toBe(8444);
    expect(() => Config.parse({ mobile: { httpsPort: 0 } })).toThrow();
    expect(loadConfig('/nonexistent/config.json').home).toEqual({
      cwd: '~/.svall/home',
      actions: [
        { label: 'update info', prompt: '/svall-update-info' }, { label: 'status', prompt: '/svall-status' },
      ],
    });
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: '/mc', actions: [{ label: 'x', prompt: '/x' }] } }));
    expect(loadConfig(path.join(home, 'config.json')).home).toEqual({ cwd: '/mc', actions: [{ label: 'x', prompt: '/x' }] });
    expect(Config.parse({ home: { command: 'my-agent' } }).home.command).toBe('my-agent');
  });
  it('makes prefixed ids', () => {
    expect(newId('c')).toMatch(/^c_[a-z0-9]{6}$/);
    expect(newId('i')).not.toBe(newId('i'));
  });
});

describe('saveConfig', () => {
  const file = () => path.join(makeHome(), 'config.json');
  it('sets the key and keeps every other one', () => {
    const f = file();
    fs.writeFileSync(f, JSON.stringify({ port: 47801, scribe: { model: 'haiku' } }));
    saveConfig(f, { mainAgent: 'codex' });
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({ port: 47801, scribe: { model: 'haiku' }, mainAgent: 'codex' });
    expect(loadConfig(f).mainAgent).toBe('codex');
  });
  it('creates the file when there is none', () => {
    const f = file();
    saveConfig(f, { mainAgent: 'claude' });
    expect(loadConfig(f).mainAgent).toBe('claude');
  });
  it('refuses a file that does not parse, and leaves it as it was', () => {
    const f = file();
    fs.writeFileSync(f, '{ "port": 1,');
    expect(() => saveConfig(f, { mainAgent: 'codex' })).toThrow(/invalid config/);
    expect(fs.readFileSync(f, 'utf8')).toBe('{ "port": 1,');
  });
  it('writes a linked config.json where it points, keeping its mode', () => {
    const dir = makeHome();
    const real = path.join(dir, 'dotfiles.json');
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(real, '{}', { mode: 0o600 });
    fs.symlinkSync(real, f);
    saveConfig(f, { mainAgent: 'codex' });
    expect(fs.lstatSync(f).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, 'utf8')).mainAgent).toBe('codex');
    expect(fs.statSync(real).mode & 0o777).toBe(0o600);
  });
  it('saves the phone port beside the mobile keys already there', () => {
    const f = file();
    fs.writeFileSync(f, JSON.stringify({ mobile: { logins: ['me@example.com'] } }));
    saveConfig(f, { mobile: { httpsPort: 8444 } });
    expect(JSON.parse(fs.readFileSync(f, 'utf8')).mobile).toEqual({ logins: ['me@example.com'], httpsPort: 8444 });
  });
  it('leaves the scribe agent unset unless it is named', () => {
    expect(loadConfig(file()).scribe.agent).toBeUndefined();
  });
  it('keeps the fleet name, and refuses one svall could not open the fleet by', () => {
    const f = file();
    saveConfig(f, { name: 'home' });
    expect(loadConfig(f).name).toBe('home');
    fs.writeFileSync(f, JSON.stringify({ name: 'Home Base' }));
    expect(() => loadConfig(f)).toThrow(/name: /);
  });
});

describe('the agents setup turns off', () => {
  it('leaves an agent Svall supports after a setup on', () => {
    const home = makeHome();
    const file = path.join(home, 'config.json');
    // the list setup saved before OpenCode, which could name only Claude Code and Codex
    fs.writeFileSync(file, JSON.stringify({ integrations: ['claude'] }));
    expect(loadConfig(file).integrations).toEqual(['claude', 'opencode']);
    saveConfig(file, { integrations: ['claude', 'opencode'] });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ agentsOff: ['codex'] });
    expect(loadConfig(file).integrations).toEqual(['claude', 'opencode']);
  });
});

describe('keptPorts', () => {
  it('lists the phone ports the fleets keep, past a fleet that keeps none or whose config does not parse', () => {
    const [kept, none, broken] = [makeHome(), makeHome(), makeHome()];
    fs.writeFileSync(path.join(kept, 'config.json'), JSON.stringify({ mobile: { httpsPort: 8444 } }));
    fs.writeFileSync(path.join(broken, 'config.json'), '{');
    expect(keptPorts([kept, none, broken, '/nonexistent'])).toEqual([8444]);
  });
});

describe('fleetMainAgent', () => {
  it("gives a fleet that names no main agent the private fleet's, and keeps one a fleet names", () => {
    const privateConfig = path.join(os.homedir(), '.svall', 'config.json');
    fs.mkdirSync(path.dirname(privateConfig), { recursive: true });
    const before = fs.existsSync(privateConfig) ? fs.readFileSync(privateConfig, 'utf8') : undefined;
    fs.writeFileSync(privateConfig, JSON.stringify({ mainAgent: 'codex' }));
    try {
      const work = makeHome();
      expect(fleetMainAgent(work, undefined)).toBe('codex');
      expect(fleetMainAgent(work, 'claude')).toBe('claude');
      expect(fleetMainAgent(path.dirname(privateConfig), undefined)).toBeUndefined();
      fs.writeFileSync(privateConfig, '{');
      expect(fleetMainAgent(work, undefined)).toBeUndefined();
    } finally {
      if (before === undefined) fs.rmSync(privateConfig); else fs.writeFileSync(privateConfig, before);
    }
  });
});
