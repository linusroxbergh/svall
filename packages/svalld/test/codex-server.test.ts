import { describe, expect, it } from 'vitest';
import { isCodexServer, onSharedServer } from '../src/codex/server.js';
import type { Proc } from '../src/dormancy.js';

// as ps printed codex 0.162.1's shared server, its updater and a TUI on it
const DAEMON = '/Users/u/.codex/packages/app-server-daemon/releases/0.162.1-aarch64-apple-darwin/bin/codex app-server --listen unix:// --analytics-default-enabled --managed-daemon';
const proc = (pid: number, ppid: number, args: string): Proc => ({ pid, ppid, pgid: pid, args });

describe('isCodexServer', () => {
  it('knows the shared server and an IDE one from a TUI', () => {
    expect(isCodexServer(DAEMON)).toBe(true);
    expect(isCodexServer('codex app-server --listen stdio://')).toBe(true);
    expect(isCodexServer('/Users/u/.codex/packages/standalone/releases/0.162.1-aarch64-apple-darwin/bin/codex')).toBe(false);
    expect(isCodexServer('codex resume app-server')).toBe(false);
    expect(isCodexServer('/usr/bin/codex-code-mode-host')).toBe(false);
  });
});

describe('onSharedServer', () => {
  const shell = 100;

  it('holds a plain codex while the shared server runs', () => {
    const procs = [proc(shell, 1, '-zsh'), proc(200, shell, 'codex'), proc(300, 1, DAEMON)];
    expect(onSharedServer(shell, procs)).toBe(true);
    expect(onSharedServer(shell, [proc(shell, 1, '-zsh'), proc(200, shell, 'codex resume 019eefb3-8d5c-7b00-ad02-80c4930f7426'), proc(300, 1, DAEMON)])).toBe(true);
  });

  it('knows the TUI that started the server, its parent', () => {
    expect(onSharedServer(shell, [proc(shell, 1, '-zsh'), proc(200, shell, 'codex'), proc(300, 200, DAEMON)])).toBe(true);
  });

  it('lets a codex run its own server by a flag, and one with no shared server to join', () => {
    for (const flags of ['--no-daemon', '-c model="o3"', '--profile=work', '--oss', '--remote ws://x', '--dangerously-bypass-hook-trust']) {
      expect(onSharedServer(shell, [proc(shell, 1, '-zsh'), proc(200, shell, `codex ${flags}`), proc(300, 1, DAEMON)])).toBe(false);
    }
    expect(onSharedServer(shell, [proc(shell, 1, '-zsh'), proc(200, shell, 'codex')])).toBe(false);
  });

  it('finds the native codex under the node script npm installs', () => {
    const procs = [proc(shell, 1, '-zsh'), proc(200, shell, 'node /usr/local/bin/codex.js --no-daemon'), proc(210, 200, '/usr/local/lib/node_modules/@openai/codex/vendor/codex/codex --no-daemon'), proc(300, 1, DAEMON)];
    expect(onSharedServer(shell, procs)).toBe(false);
    expect(onSharedServer(shell, procs.map((p) => ({ ...p, args: p.args.replace(' --no-daemon', '') })))).toBe(true);
  });

  it('says nothing of a pane with no codex under it', () => {
    expect(onSharedServer(shell, [proc(shell, 1, '-zsh'), proc(300, 1, DAEMON)])).toBe(false);
  });
});
