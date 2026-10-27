import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitRunner } from '../src/links/git.js';
import { PRIVATE, profileHome } from '../src/profile.js';
import { appendSessions, type SessionRecord } from '../src/retro/sessions.js';
import { discover, opencodeSessions, otherFleetSessions, repoFinder, scope, type Candidate } from '../src/retro/scope.js';
import type { CliRun } from '../src/sessions/types.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

const FROM = Date.parse('2026-10-20T00:00:00Z');
const IN = FROM + 3_600_000;
const OLD = FROM - 86_400_000;

const cand = (session: string, o: Partial<Candidate> = {}): Candidate => ({ agent: 'claude', session, file: `/t/${session}.jsonl`, mtime: IN, ...o });
const rec = (session: string, o: Partial<SessionRecord> = {}): SessionRecord => ({ at: 1, start: 1, session, robot: 'c_a', island: 'i_work', ...o });
const repos = (m: Record<string, string>) => (cwd: string): Promise<string | undefined> => Promise.resolve(m[cwd]);
const base = { own: new Map<string, SessionRecord>(), others: new Set<string>(), exclude: { repos: [], islands: [] }, unrecorded: [], islandName: () => undefined, repoOf: repos({}), remote: 0 };

describe('scope', () => {
  it('never takes a session another fleet recorded', async () => {
    const homedir = makeHome();
    const [mine, theirs] = [profileHome(PRIVATE, homedir), profileHome('work', homedir)];
    for (const h of [mine, theirs]) { fs.mkdirSync(h); fs.writeFileSync(path.join(h, 'fleet.json'), '{}'); }
    appendSessions(path.join(theirs, 'retro', 'sessions.ndjson'), [{ at: 1, session: 'S1', robot: 'c_b' }]);
    appendSessions(path.join(mine, 'retro', 'sessions.ndjson'), [{ at: 1, session: 'S2', robot: 'c_a' }]);
    const others = otherFleetSessions(mine, homedir);
    expect([...others]).toEqual(['S1']);
    const r = await scope({ ...base, candidates: [cand('S1', { cwd: '/r' })], own: new Map([['S1', rec('S1')]]), others, unrecorded: ['/r'], repoOf: repos({ '/r': '/r' }), remote: 2 });
    expect(r.inScope).toEqual([]);
    expect(r.counts).toEqual({ inScope: 0, excluded: 0, otherFleets: 1, remote: 2, unrecorded: [], missing: {} });
  });

  it('leaves out an excluded island, by id or name, and an excluded repo, recorded or found from the cwd', async () => {
    const own = new Map([
      ['A', rec('A', { island: 'i_life' })],
      ['B', rec('B', { island: 'i_side' })],
      ['C', rec('C', { repo: '/skip' })],
      ['D', rec('D')],
      ['E', rec('E', { repo: '/keep' })],
    ]);
    const r = await scope({
      ...base, own,
      candidates: [cand('A'), cand('B'), cand('C'), cand('D', { cwd: '/skip/wt' }), cand('E', { cwd: '/keep', agent: 'codex' })],
      exclude: { repos: ['/skip'], islands: ['i_life', 'Side'] },
      islandName: (id) => ({ i_life: 'Life', i_side: 'Side', i_work: 'Work' })[id],
      repoOf: repos({ '/skip/wt': '/skip', '/keep': '/elsewhere' }),
    });
    expect(r.inScope).toEqual([{ ...cand('E', { cwd: '/keep', agent: 'codex' }), record: own.get('E'), repo: '/keep' }]);
    expect(r.counts).toMatchObject({ inScope: 1, excluded: 4, otherFleets: 0, unrecorded: [], missing: { cost: 1 } });
  });

  it('groups unrecorded sessions by repo with their counts and reads only the picked ones', async () => {
    const r = await scope({
      ...base,
      candidates: [cand('A', { cwd: '/a/wt' }), cand('B', { cwd: '/a', agent: 'codex' }), cand('C', { cwd: '/b' }), cand('D', { cwd: '/a/wt' })],
      unrecorded: ['/a'],
      repoOf: repos({ '/a/wt': '/a', '/a': '/a', '/b': '/b' }),
    });
    expect(r.inScope.map((c) => [c.session, c.repo, c.record])).toEqual([['A', '/a', undefined], ['B', '/a', undefined], ['D', '/a', undefined]]);
    expect(r.counts).toEqual({
      inScope: 3, excluded: 0, otherFleets: 0, remote: 0, missing: { cost: 1 },
      unrecorded: [{ repo: '/a', count: 3, picked: true }, { repo: '/b', count: 1, picked: false }],
    });
  });

  it('groups an unrecorded session whose cwd is gone or outside any repo under its cwd', async () => {
    const plain = makeHome();
    let calls = 0;
    const git: GitRunner = () => { calls++; return Promise.resolve({ code: 128, stdout: '', stderr: 'not a git repository' }); };
    const repoOf = repoFinder(git);
    const r = await scope({
      ...base, repoOf,
      candidates: [cand('A', { cwd: '/nonexistent/gone' }), cand('B', { cwd: plain }), cand('C', { cwd: plain }), cand('D')],
      unrecorded: ['/nonexistent/gone'],
    });
    expect(r.counts.unrecorded).toEqual([
      { repo: plain, count: 2, picked: false }, { repo: '/nonexistent/gone', count: 1, picked: true }, { repo: 'unknown', count: 1, picked: false },
    ]);
    expect(r.inScope.map((c) => [c.session, c.repo])).toEqual([['A', undefined]]);
    // asked once for the folder two sessions share, and never for the one that is gone
    expect(calls).toBe(1);
  });
});

describe('discover', () => {
  const touch = (file: string, text: string, at: number): string => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    fs.utimesSync(file, at / 1000, at / 1000);
    return file;
  };
  const S1 = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
  const S2 = '4a1c7d2e-1b3f-4c5d-8e9f-0a1b2c3d4e5f';
  const X1 = '019eefb3-8d5c-7b00-ad02-80c4930f7426';
  const X2 = '019eefb3-8d5c-7b00-ad02-80c4930f7427';

  it('keeps the files touched in the span, with their cwd and a Claude session\'s subagent files', async () => {
    const root = makeHome();
    const [claudeDir, codexDir] = [path.join(root, 'claude'), path.join(root, 'codex')];
    const project = path.join(claudeDir, 'projects', '-w-one');
    const s1 = touch(path.join(project, `${S1}.jsonl`), '{"type":"mode","mode":"normal"}\n{"type":"user","cwd":"/w/one","sessionId":"x"}\n', IN);
    const sub = touch(path.join(project, S1, 'subagents', 'agent-a1.jsonl'), '{"type":"user","cwd":"/w/one"}\n', IN);
    touch(path.join(project, S1, 'subagents', 'agent-a2.jsonl'), '{"type":"user","cwd":"/w/one"}\n', OLD);
    touch(path.join(project, `${S2}.jsonl`), '{"type":"user","cwd":"/w/one"}\n', OLD);
    touch(path.join(project, 'memory', 'note.md'), 'not a session', IN);
    const day = path.join(codexDir, 'sessions', '2026', '10', '20');
    const x1 = touch(path.join(day, `rollout-2026-10-20T10-00-00-${X1}.jsonl`), `{"type":"session_meta","payload":{"id":"${X1}","cwd":"/w/two"}}\n`, IN);
    touch(path.join(day, `rollout-2026-10-19T10-00-00-${X2}.jsonl`), `{"type":"session_meta","payload":{"id":"${X2}","cwd":"/w/two"}}\n`, OLD);
    touch(path.join(day, 'notes.txt'), '', IN);

    const listed = [{ id: 'ses_new', title: 't', updated: IN, created: OLD, projectId: 'p', directory: '/w/three' }, { id: 'ses_old', title: 't', updated: OLD, created: OLD, projectId: 'p', directory: '/w/three' }];
    const dirs: (string | undefined)[] = [];
    const run: CliRun = (cmd, args, o) => {
      expect([cmd, ...args]).toEqual(['opencode', 'session', 'list', '--format', 'json', '--standalone', '--max-count', '1000']);
      dirs.push(o?.cwd);
      return Promise.resolve(o?.cwd === '/w/broken' ? { code: 1, stdout: '', stderr: 'no' } : { code: 0, stdout: JSON.stringify(listed), stderr: '' });
    };

    const found = await discover({ span: { from: FROM, to: IN }, claudeDir, codexDir, opencode: () => opencodeSessions(['/w/three', '/w/three/wt', '/w/broken'], run) });
    expect(found.sort((a, b) => a.session.localeCompare(b.session))).toEqual([
      { agent: 'codex', session: X1, file: x1, cwd: '/w/two', mtime: IN },
      { agent: 'claude', session: S1, file: s1, cwd: '/w/one', mtime: IN, subagents: [sub] },
      { agent: 'opencode', session: 'ses_new', file: '', cwd: '/w/three', mtime: IN },
    ]);
    expect(dirs).toEqual(['/w/three', '/w/three/wt', '/w/broken']);
  });

  it('finds nothing in stores that are not there', async () => {
    expect(await discover({ span: { from: FROM, to: IN }, claudeDir: '/nonexistent/claude', codexDir: '/nonexistent/codex' })).toEqual([]);
  });
});
