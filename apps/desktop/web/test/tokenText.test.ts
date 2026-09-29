import { describe, expect, it } from 'vitest';
import type { Character } from '@svall/protocol';
import { GAUGE_C, ago, gaugeDash, hintText, linkText, statusWord } from '../src/map/tokenText.js';

describe('linkText', () => {
  it('shows a file or folder by its last segment', () => {
    expect(linkText({ kind: 'file', ref: '/Users/x/notes/spec.md', label: '', source: 'manual' })).toBe('spec.md');
    expect(linkText({ kind: 'folder', ref: '/Users/x/notes/', label: '', source: 'manual' })).toBe('notes');
  });

  it('names the repository beside a PR or issue number', () => {
    expect(linkText({ kind: 'pr', ref: 'https://github.com/o/svall/pull/614', label: '#614', source: 'auto' })).toBe('svall #614');
    expect(linkText({ kind: 'pr', ref: 'https://github.com/o/svall/pull/614', label: '', source: 'scribe' })).toBe('svall #614');
    expect(linkText({ kind: 'issue', ref: 'https://www.github.com/o/svall/issues/7', label: '7', source: 'auto' })).toBe('svall #7');
  });

  it('keeps a label that says more than the number, and any ref it cannot read', () => {
    expect(linkText({ kind: 'pr', ref: 'https://github.com/o/svall/pull/614', label: 'the redesign', source: 'manual' })).toBe('the redesign');
    expect(linkText({ kind: 'pr', ref: 'https://gitea.example/o/r/pulls/9', label: '#9', source: 'manual' })).toBe('#9');
    expect(linkText({ kind: 'pr', ref: 'github.com/o/svall/pull/614', label: '', source: 'manual' })).toBe('svall #614');
  });
});

describe('hintText', () => {
  it('describes missing updates without assuming why hooks are silent', () => {
    const text = hintText({ hint: 'codex-silent' } as Character);
    expect(text).toContain('svall doctor');
    expect(text).toContain('/hooks');
    expect(text).not.toContain('trust the Svall hook');
    expect(hintText({} as Character)).toBeUndefined();
  });
});


describe('gaugeDash', () => {
  it('is empty without a context percentage, keeps a 3% sliver, and scales linearly', () => {
    expect(gaugeDash(undefined).startsWith('0 ')).toBe(true);
    expect(gaugeDash(1)).toBe(`${((GAUGE_C * 3) / 100).toFixed(2)} ${GAUGE_C.toFixed(2)}`);
    expect(gaugeDash(50)).toBe(`${(GAUGE_C / 2).toFixed(2)} ${GAUGE_C.toFixed(2)}`);
  });
});

describe('statusWord', () => {
  it('names only the loud statuses', () => {
    expect(statusWord('blocked')).toBe('blocked');
    expect(statusWord('done')).toBe('done');
    expect(statusWord('working')).toBeUndefined();
    expect(statusWord('idle')).toBeUndefined();
    expect(statusWord('shell')).toBeUndefined();
  });
});

describe('ago', () => {
  it('buckets to seconds, minutes, hours and days', () => {
    const now = 1_000_000_000_000;
    expect(ago(now - 3_000, now)).toBe('3s');
    expect(ago(now - 90_000, now)).toBe('2m');
    expect(ago(now - 2 * 3_600_000, now)).toBe('2h');
    expect(ago(now - 3 * 86_400_000, now)).toBe('3d');
  });
});
