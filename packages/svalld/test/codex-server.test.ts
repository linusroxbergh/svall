import { describe, expect, it } from 'vitest';
import { isCodexServer, onSharedServer, underCodexServer } from '../src/codex/server.js';
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
    expect(isCodexServer('/bin/zsh -c echo /u/.codex/bin/codex app-server --managed-daemon')).toBe(false);
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
    for (const flags of ['--no-daemon', '-c model="o3"', '--profile=work', '--oss', '--dangerously-bypass-hook-trust']) {
      expect(onSharedServer(shell, [proc(shell, 1, '-zsh'), proc(200, shell, `codex ${flags}`), proc(300, 1, DAEMON)])).toBe(false);
    }
    expect(onSharedServer(shell, [proc(shell, 1, '-zsh'), proc(200, shell, 'codex')])).toBe(false);
  });

  it('holds a codex on a server --remote names, shared server or not', () => {
    expect(onSharedServer(shell, [proc(shell, 1, '-zsh'), proc(200, shell, 'codex --remote ws://127.0.0.1:4500')])).toBe(true);
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

describe('underCodexServer', () => {
  it('knows the server and a run one of its sessions started, and nothing else', () => {
    const procs = [proc(1, 0, '/sbin/launchd'), proc(100, 1, '-zsh'), proc(300, 1, DAEMON), proc(310, 300, '/bin/sh -c claude -p'), proc(320, 310, 'claude -p'), proc(400, 100, 'codex --no-daemon')];
    expect(underCodexServer(300, procs)).toBe(true);
    expect(underCodexServer(320, procs)).toBe(true);
    expect(underCodexServer(400, procs)).toBe(false);
    expect(underCodexServer(100, procs)).toBe(false);
    expect(underCodexServer(999_999, procs)).toBe(false);
  });

  it('gives up on a parent chain that loops', () => {
    expect(underCodexServer(10, [proc(10, 11, 'a'), proc(11, 10, 'b')])).toBe(false);
  });
});
