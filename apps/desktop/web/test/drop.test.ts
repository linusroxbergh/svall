import { describe, expect, it, vi } from 'vitest';
import { appendItems, parseDropTarget } from '../src/drop.js';
import { fleet } from './fixtures.js';

describe('drop targets', () => {
  it('parses a data-drop value', () => {
    expect(parseDropTarget('island:i_a')).toEqual({ kind: 'island', id: 'i_a' });
    expect(parseDropTarget('char:c0')).toEqual({ kind: 'char', id: 'c0' });
    expect(parseDropTarget('nope')).toBeUndefined();
    expect(parseDropTarget(null)).toBeUndefined();
  });
  it('appends one file item per path to the target, keeping what is there', () => {
    const call = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const f = fleet();
    f.characters.c0.context = [{ kind: 'pr', ref: 'https://gh/1', label: '', source: 'auto' }];
    appendItems({ call } as never, f, { kind: 'char', id: 'c0' }, ['/a/x.md', '/b'], onError);
    expect(call).toHaveBeenCalledWith('char.update', { id: 'c0', context: [
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
    appendItems({ call } as never, f, { kind: 'char', id: 'c0' }, ['/gone'], onError);
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledWith('no such file or folder: /gone');
  });
});
