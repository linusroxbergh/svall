import { describe, expect, it } from 'vitest';
import type { Character, ContextItem } from '@svall/protocol';
import { CharacterAnswer, IslandAnswer, acceptLine, acceptLinks, acceptName, characterPrompt, islandPrompt, parseAnswer, prEvidence } from '../src/scribe/prompt.js';

const char = (extra: Partial<Character> = {}): Character => ({
  id: 'c', islandId: 'i', cell: { x: 0, y: 0 }, name: 'golden heron', portrait: 'fox', note: '', instructions: '', cwd: '/repo', context: [],
  shell: { lastOutputAt: 0 }, unread: false, ...extra,
});

describe('acceptName', () => {
  const none = new Set<string>();
  it('replaces a generated name', () => {
    expect(acceptName('golden heron', { value: 'deploy web', reason: 'generated' }, none)).toBe('deploy web');
  });
  it('refuses to treat a given name as generated', () => {
    expect(acceptName('robin review', { value: 'deploy web', reason: 'generated' }, none)).toBeUndefined();
  });
  it('puts an identifier in front of a given name', () => {
    expect(acceptName('robin review', { value: '#542 robin review', reason: 'identifier' }, none)).toBe('#542 robin review');
  });
  it('refuses an identifier change that loses the given name', () => {
    expect(acceptName('robin review', { value: '#542 review', reason: 'identifier' }, none)).toBeUndefined();
  });
  it('refuses to keep a generated name behind an identifier', () => {
    expect(acceptName('golden heron', { value: '#542 golden heron', reason: 'identifier' }, none)).toBeUndefined();
  });
  it('drops words from the end of a name too long to fit', () => {
    expect(acceptName('golden heron', { value: 'find settings session bug', reason: 'generated' }, none)).toBe('find settings session');
    expect(acceptName('golden heron', { value: 'internationalisation-work', reason: 'generated' }, none)).toBeUndefined();
    expect(acceptName('quite long given name', { value: '#542 quite long given name', reason: 'identifier' }, none)).toBeUndefined();
  });
  it('refuses a name another character has, and no change at all', () => {
    expect(acceptName('golden heron', { value: 'deploy web', reason: 'generated' }, new Set(['deploy web']))).toBeUndefined();
    expect(acceptName('golden heron', { value: 'ENG-1907 auth', reason: 'generated' }, new Set(['eng-1907 auth']))).toBeUndefined();
    expect(acceptName('deploy web', { value: 'deploy web', reason: 'identifier' }, none)).toBeUndefined();
    expect(acceptName('deploy web', null, none)).toBeUndefined();
  });
});

describe('acceptLine', () => {
  it('keeps one line and drops an empty answer', () => {
    expect(acceptLine('  rewriting\n the helpers ', 80)).toBe('rewriting the helpers');
    expect(acceptLine('  ', 80)).toBeUndefined();
    expect(acceptLine(undefined, 80)).toBeUndefined();
  });
  it('drops words from the end of a line too long to fit', () => {
    expect(acceptLine('rewriting the auth test helpers', 20)).toBe('rewriting the auth');
    expect(acceptLine('x'.repeat(30), 20)).toBe('x'.repeat(20));
  });
});

describe('acceptLinks', () => {
  const manual: ContextItem = { kind: 'other', ref: 'https://mine', label: 'mine', source: 'manual' };
  const held: ContextItem = { kind: 'other', ref: 'https://held', label: 'held', source: 'scribe', pinned: true };
  const transcript = 'see https://docs.example/a and https://mine and https://docs.example/b';

  it('takes URLs the transcript names, keeps held ones with their pin, and drops the rest', () => {
    const out = acceptLinks([
      { url: 'https://docs.example/a', label: 'design doc' },
      { url: 'https://invented.example', label: 'made up' },
      { url: 'https://mine', label: 'dup of manual' },
      { url: 'https://held', label: 'held' },
      { url: 'https://docs.example/a/', label: 'same link again' },
      { url: 'not a url', label: 'x' },
    ], transcript, [manual, held]);
    expect(out).toEqual([
      { kind: 'other', ref: 'https://docs.example/a', label: 'design doc', source: 'scribe' },
      { kind: 'other', ref: 'https://held', label: 'held', source: 'scribe', pinned: true },
    ]);
  });

  it('links a comment or file view in a PR or issue to the PR or issue itself', () => {
    const t = 'see https://github.com/o/r/pull/5#discussion_r9 and https://github.com/o/r/issues/7/files';
    expect(acceptLinks([
      { url: 'https://github.com/o/r/pull/5#discussion_r9', label: '#5' },
      { url: 'https://github.com/o/r/issues/7/files', label: '#7' },
    ], t, []).map((l) => [l.kind, l.ref])).toEqual([['pr', 'https://github.com/o/r/pull/5'], ['issue', 'https://github.com/o/r/issues/7']]);
  });

  it('keeps a label short, and falls back to the url for an empty one', () => {
    const [long, empty] = acceptLinks([
      { url: 'https://docs.example/a', label: `the ${'very '.repeat(1000)}long label` },
      { url: 'https://docs.example/b', label: ' ' },
    ], transcript, []);
    expect(long.label.length).toBeLessThanOrEqual(40);
    expect(long.label).toMatch(/^the very very/);
    expect(empty.label).toBe('https://docs.example/b');
  });

  it('keeps a pinned link the answer leaves out, and lets an unpinned one go', () => {
    const loose: ContextItem = { kind: 'other', ref: 'https://loose', label: 'loose', source: 'scribe' };
    expect(acceptLinks([], transcript, [manual, held, loose])).toEqual([held]);
  });

  it("takes the branch's PR, which no transcript need name, with its pin, but not the repository fallback", () => {
    const pr: ContextItem = { kind: 'pr', ref: 'https://github.com/o/r/pull/5', label: '#5', source: 'auto', prState: 'open', pinned: true };
    const repo: ContextItem = { kind: 'github', ref: 'https://github.com/o/r', label: 'o/r', source: 'auto' };
    expect(acceptLinks([{ url: pr.ref, label: '#5' }, { url: repo.ref, label: 'o/r' }], `see ${repo.ref}`, [pr, repo]))
      .toEqual([{ kind: 'pr', ref: pr.ref, label: '#5', source: 'scribe', pinned: true }]);
  });

  it("keeps a held PR the branch's lookup still reads, whatever the answer says", () => {
    const own: ContextItem = { kind: 'pr', ref: 'https://github.com/o/r/pull/5', label: '#5', source: 'scribe', prState: 'open' };
    const old: ContextItem = { kind: 'pr', ref: 'https://github.com/o/r/pull/4', label: '#4', source: 'scribe' };
    expect(acceptLinks([], transcript, [own, old])).toEqual([own]);
  });
});

describe('parseAnswer', () => {
  it('reads an object out of a fenced answer', () => {
    const a = parseAnswer(CharacterAnswer, '```json\n{"note": "x", "name": {"value": "deploy web", "reason": "generated"}}\n```');
    expect(a).toEqual({ note: 'x', name: { value: 'deploy web', reason: 'generated' } });
    expect(parseAnswer(IslandAnswer, '{"description": "d"}')).toEqual({ description: 'd' });
    expect(parseAnswer(CharacterAnswer, '{"note": "x", "links": null}')).toEqual({ note: 'x', links: null });
  });
  it('throws on prose, bad JSON and a wrong shape', () => {
    expect(() => parseAnswer(CharacterAnswer, 'I could not tell.')).toThrow(/^the scribe's answer has no JSON object$/);
    // the parser's own message would quote the answer, which is text from a transcript
    expect(() => parseAnswer(CharacterAnswer, '{"note": the transcript said hunter2}')).toThrow(/^the scribe's answer is not valid JSON$/);
    expect(() => parseAnswer(CharacterAnswer, '{"name": {"value": "x", "reason": "because"}}')).toThrow(/^the scribe's answer has the wrong shape: name\.reason Invalid option[^\n]*$/);
  });
});

describe('characterPrompt', () => {
  it('marks a generated name and a hand-written note, and lists links by source', () => {
    const p = characterPrompt(char({ note: 'mine', noteSource: 'manual', context: [{ kind: 'pr', ref: 'https://gh/pull/5', label: '#5', source: 'auto' }] }), 'USER: hi', ['deploy web']);
    expect(p).toContain('Name: golden heron (generated placeholder)');
    expect(p).toContain('Note (hand-written): mine');
    expect(p).toContain('- auto #5 https://gh/pull/5');
    expect(p).toContain('must not repeat: deploy web');
    expect(p).toContain('<transcript>\nUSER: hi\n</transcript>');
    expect(characterPrompt(char({ name: 'robin review', note: 'x' }), '', [])).toContain('Name: robin review\n');
  });
});

describe('prEvidence', () => {
  const repo = { kind: 'github' as const, ref: 'https://github.com/o/r', label: 'o/r', source: 'auto' as const };
  it('resolves an explicit PR number using the linked repository', () => {
    const evidence = prEvidence(char({ context: [repo] }), 'USER: review PR #42', '');
    expect(evidence).toEqual(['https://github.com/o/r/pull/42']);
    expect(characterPrompt(char({ context: [repo] }), 'USER: review PR #42', [], evidence)).toContain('- https://github.com/o/r/pull/42');
    expect(acceptLinks([{ url: evidence[0], label: '#42' }], `USER: review PR #42\n${evidence.join('\n')}`, [])).toMatchObject([{ kind: 'pr', ref: evidence[0] }]);
  });
  it('recovers a PR URL from an older tool result, without inventing one from an issue number', () => {
    const evidence = prEvidence(char({ context: [repo] }), 'USER: continue review', 'tool https://github.com/o/r/pull/42#discussion_r1 then https://github.com/o/r/issues/9');
    expect(evidence).toEqual(['https://github.com/o/r/pull/42']);
    expect(prEvidence(char({ context: [repo] }), 'USER: fix issue #9', '')).toEqual([]);
  });
  it('resolves a numbered PR mentioned before the condensed turns', () => {
    expect(prEvidence(char({ context: [repo] }), 'AGENT: continuing review', 'USER: Please review pull request #42')).toEqual(['https://github.com/o/r/pull/42']);
  });
  it('keeps a second PR that the first is named far more often than', () => {
    const urls = ['https://github.com/o/r/pull/41', ...Array<string>(9).fill('https://github.com/o/r/pull/42')].join(' ');
    expect(prEvidence(char(), '', urls)).toEqual(['https://github.com/o/r/pull/41', 'https://github.com/o/r/pull/42']);
    const refs = ['PR #43', ...Array<string>(9).fill('PR #44')].join('\n');
    expect(prEvidence(char({ context: [repo] }), refs, '')).toEqual(['https://github.com/o/r/pull/43', 'https://github.com/o/r/pull/44']);
  });
});

describe('islandPrompt', () => {
  it('marks a hand-written description and lists the island\'s links and each member\'s', () => {
    const island = { id: 'i', name: 'auth', description: 'mine', descriptionSource: 'manual' as const, instructions: '', position: { x: 0, y: 0 }, size: { w: 8, h: 6 }, seed: 1,
      context: [{ kind: 'other' as const, ref: 'https://docs.example/plan', label: 'plan', source: 'manual' as const }] };
    const p = islandPrompt(island, [char({ name: 'auth tests', note: 'rewrite', context: [{ kind: 'pr', ref: 'https://gh/pull/5', label: '#5', source: 'auto' }] })]);
    expect(p).toContain('Description (hand-written): mine\nLinks:\n- manual plan https://docs.example/plan\nMembers:');
    expect(p).toContain('- auth tests | /repo | rewrite\n  - auto #5 https://gh/pull/5');
  });
});
