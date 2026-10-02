import { describe, expect, it, vi } from 'vitest';
import { connectionFromUrl, createBridge, openItem, openUrl, revealFile, type FromShell } from '../src/bridge.js';

describe('bridge', () => {
  it('is absent in a plain browser and never throws on send', () => {
    const win = {} as unknown as Window;
    const b = createBridge(win);
    expect(b.present).toBe(false);
    expect(() => b.send({ type: 'notify.settings' })).not.toThrow();
  });
  it('posts JSON to the shell and dispatches shell messages', () => {
    const postMessage = vi.fn();
    const win = { webkit: { messageHandlers: { svall: { postMessage } } } } as unknown as Window;
    const b = createBridge(win);
    expect(b.present).toBe(true);
    b.send({ type: 'term.hide', id: 'c_1' });
    expect(postMessage).toHaveBeenCalledWith(JSON.stringify({ type: 'term.hide', id: 'c_1' }));
    const got: FromShell[] = [];
    const off = b.onMessage((m) => got.push(m));
    win.__svall!.receive(JSON.stringify({ type: 'key', chord: 'cmd+t' }));
    expect(got).toEqual([{ type: 'key', chord: 'cmd+t' }]);
    off();
    win.__svall!.receive(JSON.stringify({ type: 'key', chord: 'cmd+e' }));
    expect(got).toHaveLength(1);
  });
  it('hands a message to every handler, whatever one before it throws', () => {
    const win = { webkit: { messageHandlers: { svall: { postMessage: vi.fn() } } } } as unknown as Window;
    const b = createBridge(win);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const got: FromShell[] = [];
    b.onMessage(() => { throw new Error('broken'); });
    b.onMessage((m) => got.push(m));
    win.__svall!.receive(JSON.stringify({ type: 'quit.ask' }));
    expect(got).toEqual([{ type: 'quit.ask' }]);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
  it('delivers ghostty.configErrors to handlers', () => {
    const win = { webkit: { messageHandlers: { svall: { postMessage: vi.fn() } } } } as unknown as Window;
    const b = createBridge(win);
    const got: FromShell[] = [];
    b.onMessage((m) => got.push(m));
    win.__svall!.receive(JSON.stringify({ type: 'ghostty.configErrors', errors: ['bad font'] }));
    expect(got).toEqual([{ type: 'ghostty.configErrors', errors: ['bad font'] }]);
  });
  it('opens http, https and mailto urls only, through the shell when present', () => {
    const postMessage = vi.fn();
    const win = { webkit: { messageHandlers: { svall: { postMessage } } } } as unknown as Window;
    openUrl(createBridge(win), 'https://x.test/');
    expect(postMessage).toHaveBeenCalledWith(JSON.stringify({ type: 'openUrl', url: 'https://x.test/' }));
    openUrl(createBridge(win), 'javascript:alert(1)');
    expect(postMessage).toHaveBeenCalledTimes(1);
    openUrl(createBridge(win), 'xyz.com/path');
    expect(postMessage).toHaveBeenLastCalledWith(JSON.stringify({ type: 'openUrl', url: 'https://xyz.com/path' }));
    openUrl(createBridge(win), ' https://x.test/ ');
    expect(postMessage).toHaveBeenLastCalledWith(JSON.stringify({ type: 'openUrl', url: 'https://x.test/' }));
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    try {
      const browser = createBridge({} as Window);
      openUrl(browser, 'mailto:a@b.test');
      openUrl(browser, 'file:///etc/passwd');
    } finally { vi.unstubAllGlobals(); }
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('mailto:a@b.test', '_blank');
  });
  it('opens an item by kind: folders through openFolder, files through reveal, links through openUrl', () => {
    const postMessage = vi.fn();
    const b = createBridge({ webkit: { messageHandlers: { svall: { postMessage } } } } as unknown as Window);
    openItem(b, { kind: 'folder', ref: '/a', label: '', source: 'manual' });
    openItem(b, { kind: 'file', ref: '/a/x.md', label: '', source: 'manual' });
    openItem(b, { kind: 'pr', ref: 'https://gh/1', label: '', source: 'auto' });
    expect(postMessage.mock.calls.map(([j]) => JSON.parse(j))).toEqual([
      { type: 'openFolder', path: '/a' }, { type: 'reveal', path: '/a/x.md' }, { type: 'openUrl', url: 'https://gh/1' },
    ]);
    revealFile(b, 'relative');
    expect(postMessage).toHaveBeenCalledTimes(3);
  });
  it('reads the browser-mode connection from the URL', () => {
    expect(connectionFromUrl('?port=47800&token=abc')).toEqual({ host: '127.0.0.1', port: 47800, token: 'abc' });
    expect(connectionFromUrl('?port=1&token=t&host=10.0.0.2')?.host).toBe('10.0.0.2');
    expect(connectionFromUrl('')).toBeUndefined();
  });
});
