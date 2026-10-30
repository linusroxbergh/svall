import { describe, expect, it } from 'vitest';
import type { Robot } from '@svall/protocol';
import { ago, hintLabel, hintText, linkText, statusWord } from '../src/map/tokenText.js';

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
    const text = hintText({ hint: 'codex-silent' } as Robot);
    expect(text).toContain('svall doctor');
    expect(text).toContain('/hooks');
    expect(text).not.toContain('trust the Svall hook');
    expect(hintText({} as Robot)).toBeUndefined();
  });

  it('names the shared server, and the flag that keeps codex off it', () => {
    const c = { hint: 'codex-silent', codexDaemon: true } as Robot;
    expect(hintText(c)).toContain('codex --no-daemon');
    expect(hintText(c)).not.toContain('/hooks');
    expect(hintLabel(c)).toBe('--no-daemon');
    expect(hintLabel({ hint: 'codex-silent' } as Robot)).toBe('/hooks');
  });
});


describe('statusWord', () => {
  it('names only the loud statuses', () => {
    expect(statusWord('working')).toBe('working');
    expect(statusWord('blocked')).toBe('blocked');
    expect(statusWord('done')).toBe('done');
    expect(statusWord('moving')).toBe('moving');
    expect(statusWord('unknown')).toBe('unknown');
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
