import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContextItem } from '@svall/protocol';
import { editContext, parseContext } from '../src/context.js';

describe('parseContext', () => {
  it('takes the label after the first whitespace and infers the kind', () => {
    expect(parseContext('https://github.com/a/b/pull/7 The PR')).toEqual([{ kind: 'pr', ref: 'https://github.com/a/b/pull/7', label: 'The PR', source: 'manual' }]);
    expect(parseContext('~/notes/spec.md')).toEqual([{ kind: 'file', ref: '~/notes/spec.md', label: '~/notes/spec.md', source: 'manual' }]);
  });
  it('splits a spec that carries several links, each with the label that follows it', () => {
    expect(parseContext('https://a A one https://b B')).toEqual([
      { kind: 'other', ref: 'https://a', label: 'A one', source: 'manual' },
      { kind: 'other', ref: 'https://b', label: 'B', source: 'manual' },
    ]);
    expect(parseContext('https://a /tmp/notes.md the notes')).toEqual([
      { kind: 'other', ref: 'https://a', label: 'https://a', source: 'manual' },
      { kind: 'file', ref: '/tmp/notes.md', label: 'the notes', source: 'manual' },
    ]);
  });
  it('keeps a label that only looks like a path or a host', () => {
    expect(parseContext('https://a the spec.md in api/v2')).toEqual([{ kind: 'other', ref: 'https://a', label: 'the spec.md in api/v2', source: 'manual' }]);
  });
  it('reads a label written ahead of its link, so a later link is never swallowed by it', () => {
    expect(parseContext('PR #7 https://github.com/a/b/pull/7'))
      .toEqual([{ kind: 'pr', ref: 'https://github.com/a/b/pull/7', label: 'PR #7', source: 'manual' }]);
    expect(parseContext('PR #7 https://github.com/a/b/pull/7 ticket https://linear.app/acme/issue/ENG-1')).toEqual([
      { kind: 'pr', ref: 'https://github.com/a/b/pull/7', label: 'ticket', source: 'manual' },
      { kind: 'linear', ref: 'https://linear.app/acme/issue/ENG-1', label: 'https://linear.app/acme/issue/ENG-1', source: 'manual' },
    ]);
  });
  it('rejects a spec with no ref in it', () => {
    expect(() => parseContext('   ')).toThrow('expected <ref>[ label]');
    expect(() => parseContext('just some words')).toThrow('expected <ref>[ label]');
  });
});

describe('editContext', () => {
  const auto: ContextItem = { kind: 'pr', ref: 'https://gh/1', label: '#1', source: 'auto' };
  const a: ContextItem = { kind: 'other', ref: 'https://a', label: 'https://a', source: 'manual' };
  const none = { context: [], pin: [], unpin: [], drop: [] };
  it('is undefined when nothing was asked', () => {
    expect(editContext([auto, a], none)).toBeUndefined();
  });
  it('replaces manual items and keeps auto and scribe ones', () => {
    const scribe: ContextItem = { kind: 'other', ref: 'https://doc', label: 'doc', source: 'scribe' };
    expect(editContext([auto, scribe, a], { ...none, context: ['https://b B'] })).toEqual([auto, scribe, { kind: 'other', ref: 'https://b', label: 'B', source: 'manual' }]);
  });
  it('pins, unpins and drops by ref', () => {
    expect(editContext([auto, a], { ...none, pin: ['https://a'] })).toEqual([auto, { ...a, pinned: true }]);
    expect(editContext([auto, { ...a, pinned: true }], { ...none, unpin: ['https://a'] })).toEqual([auto, a]);
    expect(editContext([auto, a], { ...none, drop: ['https://gh/1'] })).toEqual([a]);
  });
  it('pins a freshly given item on an empty starting list', () => {
    expect(editContext([], { context: ['https://a'], pin: ['https://a'], unpin: [], drop: [] }))
      .toEqual([{ kind: 'other', ref: 'https://a', label: 'https://a', source: 'manual', pinned: true }]);
  });
  it('pins a ~ path given in the same command', () => {
    expect(editContext([], { context: ['~/notes/spec.md'], pin: ['~/notes/spec.md'], unpin: [], drop: [] }))
      .toEqual([{ kind: 'file', ref: '~/notes/spec.md', label: '~/notes/spec.md', source: 'manual', pinned: true }]);
  });
  it('expands a leading ~ in pin, unpin and drop refs to match the stored path', () => {
    const stored: ContextItem = { kind: 'file', ref: path.join(os.homedir(), 'notes/spec.md'), label: '', source: 'manual' };
    expect(editContext([stored], { ...none, pin: ['~/notes/spec.md'] })).toEqual([{ ...stored, pinned: true }]);
    expect(editContext([{ ...stored, pinned: true }], { ...none, unpin: ['~/notes/spec.md'] })).toEqual([stored]);
    expect(editContext([stored], { ...none, drop: ['~/notes/spec.md'] })).toEqual([]);
  });
});
