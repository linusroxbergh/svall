import { describe, expect, it, vi } from 'vitest';
import { DROP_PART, MachineId, secondKey, type FleetState } from '@svall/protocol';
import type { DropFile } from '../src/bridge.js';
import { appendItems, dropOnTerminal, dropRefusal, inParts, parseDropTarget } from '../src/drop.js';
import { fleet } from './fixtures.js';

describe('drop targets', () => {
  it('parses a data-drop value', () => {
    expect(parseDropTarget('island:i_a')).toEqual({ kind: 'island', id: 'i_a' });
    expect(parseDropTarget('robot:c0')).toEqual({ kind: 'robot', id: 'c0' });
    expect(parseDropTarget('nope')).toBeUndefined();
    expect(parseDropTarget(null)).toBeUndefined();
  });
  it('appends one file item per path to the target, keeping what is there', () => {
    const call = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const f = fleet();
    f.robots.c0.context = [{ kind: 'pr', ref: 'https://gh/1', label: '', source: 'auto' }];
    appendItems({ call } as never, f, { kind: 'robot', id: 'c0' }, ['/a/x.md', '/b'], onError);
    expect(call).toHaveBeenCalledWith('robot.update', { id: 'c0', context: [
      { kind: 'pr', ref: 'https://gh/1', label: '', source: 'auto' },
      { kind: 'file', ref: '/a/x.md', label: '', source: 'manual' },
      { kind: 'file', ref: '/b', label: '', source: 'manual' },
    ] });
    appendItems({ call } as never, f, { kind: 'island', id: 'i_a' }, ['/c'], onError);
    expect(call).toHaveBeenLastCalledWith('island.update', { id: 'i_a', context: [{ kind: 'file', ref: '/c', label: '', source: 'manual' }] });
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a rejected write through onError', async () => {
    const call = vi.fn().mockRejectedValue(new Error('no such file or folder: /gone'));
    const onError = vi.fn();
    const f = fleet();
    appendItems({ call } as never, f, { kind: 'robot', id: 'c0' }, ['/gone'], onError);
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledWith('no such file or folder: /gone');
  });
});

const W = MachineId.parse('3f0c1a52-4b6e-4c4f-9a39-2b7d0d1e6a11');
// c0 on linus-vault, reachable or not
function placed(reachable = true): FleetState {
  const f = fleet();
  f.machines = { [W]: { name: 'linus-vault', reachable, since: 1 } };
  f.robots.c0.machine = W;
  return f;
}
const file = (name: string, bytes: number, folder = false): DropFile => ({ token: `t-${name}`, name, bytes, folder });

describe('a drop into a terminal on another machine', () => {
  it('refuses a robot on a machine out of reach, a folder and a file over 100 MB, in the app\'s words', () => {
    expect(dropRefusal(placed(false), 'c0', [file('a.png', 1)])).toBe('linus-vault is not reachable');
    const moving = placed();
    moving.robots.c0.moving = { id: 'mv_1', to: W } as never;
    expect(dropRefusal(moving, 'c0', [file('a.png', 1)])).toBe('moving to linus-vault');
    expect(dropRefusal(placed(), 'c0', [file('a.png', 1), file('src', 0, true)])).toBe('src is a folder; drop the files in it');
    expect(dropRefusal(placed(), 'c0', [file('big.mov', 120 * 2 ** 20)])).toBe('big.mov is 120 MB, over the 100 MB a drop carries');
    expect(dropRefusal(placed(), 'c0', [file('a.png', 100 * 2 ** 20)])).toBeUndefined();
  });

  it('sends each file in parts of at most a mebibyte, lands it, and types where each landed, in order', async () => {
    const call = vi.fn(async (method: string, params: { name?: string }) => (method === 'robot.drop' ? { path: `/tmp/svall-drop-1000/x/${params.name}` } : {}));
    const type = vi.fn();
    const onError = vi.fn();
    const sizes: Record<string, number> = { 'shot.png': DROP_PART + 5, 'b c.txt': 3 };
    await dropOnTerminal({
      api: { call } as never, fleet: placed(), key: secondKey('c0'), files: [file('shot.png', sizes['shot.png']), file('b c.txt', 3)],
      read: async (f) => new Response(new Uint8Array(sizes[f.name]).fill(7)).body!, type, onError,
    });
    expect(onError).not.toHaveBeenCalled();
    const parts = call.mock.calls.filter(([m]) => m === 'drop.part').map(([, p]) => p as unknown as { upload: string; index: number; data: string });
    expect(parts.map((p) => [p.index, atob(p.data).length])).toEqual([[0, DROP_PART], [1, 5], [0, 3]]);
    expect(parts[0].upload).toMatch(/^[0-9a-f]{32}$/);
    expect(parts[0].upload).toBe(parts[1].upload);
    expect(parts[2].upload).not.toBe(parts[0].upload);
    expect(call.mock.calls.filter(([m]) => m === 'robot.drop').map(([, p]) => p)).toEqual([
      { id: 'c0', upload: parts[0].upload, name: 'shot.png' }, { id: 'c0', upload: parts[2].upload, name: 'b c.txt' },
    ]);
    expect(type).toHaveBeenCalledWith(['/tmp/svall-drop-1000/x/shot.png', '/tmp/svall-drop-1000/x/b c.txt']);
  });

  it('types nothing when a file is refused, or when one does not land', async () => {
    const type = vi.fn();
    const onError = vi.fn();
    const call = vi.fn();
    await dropOnTerminal({ api: { call } as never, fleet: placed(false), key: 'c0', files: [file('a.png', 1)], read: vi.fn(), type, onError });
    expect(call).not.toHaveBeenCalled();
    expect(onError).toHaveBeenLastCalledWith('linus-vault is not reachable');
    call.mockImplementation(async (method: string) => { if (method === 'robot.drop') throw new Error('linus-vault is not reachable'); return {}; });
    await dropOnTerminal({ api: { call } as never, fleet: placed(), key: 'c0', files: [file('a.png', 1)], read: async () => new Response('x').body!, type, onError });
    expect(onError).toHaveBeenLastCalledWith('linus-vault is not reachable');
    expect(type).not.toHaveBeenCalled();
  });
});

describe('a dropped file read in parts', () => {
  const stream = (...chunks: number[]) => new ReadableStream<Uint8Array>({
    start(c) { chunks.forEach((n, i) => c.enqueue(new Uint8Array(n).fill(i + 1))); c.close(); },
  });
  const sizes = async (s: ReadableStream<Uint8Array>) => { const out: number[] = []; for await (const p of inParts(s, 4)) out.push(p.length); return out; };

  it('comes in parts of exactly the size but the last, however the stream arrives, and as one empty part when empty', async () => {
    expect(await sizes(stream(3, 6, 1))).toEqual([4, 4, 2]);
    expect(await sizes(stream(8))).toEqual([4, 4]);
    expect(await sizes(stream())).toEqual([0]);
    const bytes: number[] = [];
    for await (const p of inParts(stream(3, 2), 4)) bytes.push(...p);
    expect(bytes).toEqual([1, 1, 1, 2, 2]);
  });
});
