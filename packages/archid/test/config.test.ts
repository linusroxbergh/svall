import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config, loadConfig } from '../src/config.js';
import { newId } from '../src/ids.js';
import { resolvePaths, userPaths } from '../src/paths.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(() => { cleanHomes(); vi.unstubAllEnvs(); });

describe('config and paths', () => {
  it('defaults when the file is missing', () => {
    expect(loadConfig('/nonexistent/config.json')).toMatchObject({ port: 47800, host: '127.0.0.1' });
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
    expect(() => Config.parse({ mobile: { httpsPort: 8080 } })).toThrow();
    expect(loadConfig('/nonexistent/config.json').home).toEqual({
      cwd: '~/.archipelago/home', command: 'claude --model sonnet',
      actions: [
        { label: 'update info', prompt: '/archi-update-info' }, { label: 'status', prompt: '/archi-status' },
      ],
    });
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ home: { cwd: '/mc', actions: [{ label: 'x', prompt: '/x' }] } }));
    expect(loadConfig(path.join(home, 'config.json')).home).toEqual({ cwd: '/mc', command: 'claude --model sonnet', actions: [{ label: 'x', prompt: '/x' }] });
  });
  it('makes prefixed ids', () => {
    expect(newId('c')).toMatch(/^c_[a-z0-9]{6}$/);
    expect(newId('i')).not.toBe(newId('i'));
  });
});
