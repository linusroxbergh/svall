import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContextItem } from '@svall/protocol';
import { prFirst, settleItems } from '../src/context/items.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

describe('settleItems', () => {
  it('expands ~, stats a path and fixes its kind', () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'spec.md'), 'x');
    const [file, dir] = settleItems([
      { kind: 'file', ref: path.join(home, 'spec.md'), label: '', source: 'manual' },
      { kind: 'file', ref: home, label: '', source: 'manual', pinned: true },
    ]);
    expect(file.kind).toBe('file');
    expect(dir).toMatchObject({ kind: 'folder', ref: home, pinned: true });
    expect(settleItems([{ kind: 'file', ref: '~', label: '', source: 'manual' }])[0].ref).toBe(os.homedir());
  });
  it('rejects a path that does not exist and leaves links alone', () => {
    expect(() => settleItems([{ kind: 'file', ref: '/nope/never/here', label: '', source: 'manual' }])).toThrow(/no such file or folder/);
    const link = { kind: 'pr' as const, ref: 'https://github.com/o/r/pull/1', label: '', source: 'manual' as const };
    expect(settleItems([link])).toEqual([link]);
  });
  it('stores a view inside a GitHub PR or issue as the PR or issue itself', () => {
    const at = (ref: string) => settleItems([{ kind: 'pr', ref, label: '', source: 'manual' }])[0].ref;
    expect(at('https://github.com/o/r/pull/68/checks?check_run_id=9')).toBe('https://github.com/o/r/pull/68');
    expect(at('https://github.com/o/r/issues/12#issuecomment-4')).toBe('https://github.com/o/r/issues/12');
    expect(at('https://github.com/o/r/pull/68')).toBe('https://github.com/o/r/pull/68');
    expect(at('https://github.com/o/r')).toBe('https://github.com/o/r');
  });
  it('rejects a ref containing a newline or carriage return', () => {
    expect(() => settleItems([{ kind: 'other', ref: 'https://x\ny', label: '', source: 'manual' }])).toThrow(/newline/);
    expect(() => settleItems([{ kind: 'other', ref: 'https://x\ry', label: '', source: 'manual' }])).toThrow(/newline/);
  });
  it('keeps a stored item unstated when its path is gone, but still rejects a new missing path', () => {
    const stored = { kind: 'folder' as const, ref: '/nope/gone-now', label: '', source: 'manual' as const, pinned: true as const };
    expect(settleItems([stored], [stored])).toEqual([stored]);
    expect(() => settleItems([stored, { kind: 'file', ref: '/nope/never/here', label: '', source: 'manual' }], [stored]))
      .toThrow(/no such file or folder/);
  });
});

describe('prFirst', () => {
  const link = (source: ContextItem['source'], kind: ContextItem['kind'], ref: string): ContextItem => ({ kind, ref, label: '', source });
  const doc = link('manual', 'other', 'https://doc');
  const ticket = link('auto', 'linear', 'https://linear.app/x/issue/A-1');
  const branchPr = link('auto', 'pr', 'https://github.com/o/r/pull/1');
  const foundPr = link('scribe', 'pr', 'https://github.com/o/r/pull/2');
  it('puts the branch PR in front, else the first PR the scribe found, and keeps the rest in order', () => {
    expect(prFirst([doc, ticket, foundPr, branchPr])).toEqual([branchPr, doc, ticket, foundPr]);
    expect(prFirst([doc, ticket, foundPr])).toEqual([foundPr, doc, ticket]);
    expect(prFirst([doc, ticket])).toEqual([doc, ticket]);
  });
  it("puts the branch's PR the scribe holds, the one the lookup reads a state for, in front of the others it found", () => {
    const held = { ...link('scribe', 'pr', 'https://github.com/o/r/pull/4'), prState: 'open' as const };
    expect(prFirst([doc, foundPr, held])).toEqual([held, doc, foundPr]);
  });
  it('leaves a PR the user added where they put it', () => {
    const typed = link('manual', 'pr', 'https://github.com/o/r/pull/3');
    expect(prFirst([doc, typed])).toEqual([doc, typed]);
  });
});
