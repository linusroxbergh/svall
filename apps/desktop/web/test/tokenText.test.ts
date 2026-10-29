import { describe, expect, it } from 'vitest';
import type { Robot } from '@svall/protocol';
import { ago, hintLabel, hintText, linkText, retroText, statusWord } from '../src/map/tokenText.js';

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

describe('retroText', () => {
  it('names the stage of a retro on the card of the robot that runs it, and on no other', () => {
    const retro = { run: 'r_1', stage: 'reading' as const, done: 7, total: 18, robot: 'c0' };
    expect(retroText(retro, 'c0')).toBe('retro reading 7/18');
    expect(retroText({ ...retro, stage: 'judging' }, 'c0')).toBe('retro judging');
    expect(retroText({ ...retro, stage: 'done' }, 'c0')).toBe('retro done');
    expect(retroText({ ...retro, stage: 'failed' }, 'c0')).toBe('retro failed');
    // with the tokens used so far
    expect(retroText({ ...retro, done: 84, total: 194, used: 410_000 }, 'c0')).toBe('retro reading 84/194 · 410k');
    expect(retroText({ ...retro, stage: 'judging', used: 1_640_000 }, 'c0')).toBe('retro judging · 1.6M');
    expect(retroText(retro, 'c1')).toBeUndefined();
    expect(retroText({ ...retro, robot: undefined }, 'c0')).toBeUndefined();
    expect(retroText(undefined, 'c0')).toBeUndefined();
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
