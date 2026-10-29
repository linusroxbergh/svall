import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOME_ISLAND, type Island, type Robot } from '@svall/protocol';
import { BRIEF_CHANGED, renderBrief } from '../src/context/brief.js';
import type { GitRunner } from '../src/links/git.js';
import { PRIVATE, profileHome } from '../src/profile.js';
import { appendSessions, type SessionRecord } from '../src/retro/sessions.js';
import { discover, opencodeSessions, otherFleets, repoFinder, repoWork, scope, type Candidate } from '../src/retro/scope.js';
import type { CliRun } from '../src/sessions/types.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

const FROM = Date.parse('2026-10-20T00:00:00Z');
const IN = FROM + 3_600_000;
const OLD = FROM - 86_400_000;

const cand = (session: string, o: Partial<Candidate> = {}): Candidate => ({ agent: 'claude', session, file: `/t/${session}.jsonl`, mtime: IN, ...o });
const rec = (session: string, o: Partial<SessionRecord> = {}): SessionRecord => ({ at: 1, start: 1, session, robot: 'c_a', island: 'i_work', ...o });
const repos = (m: Record<string, string>) => (cwd: string): Promise<string | undefined> => Promise.resolve(m[cwd]);
const none = { homes: new Set<string>(), sessions: new Set<string>() };
const base = { home: '/f/mine', own: new Map<string, SessionRecord>(), others: none, exclude: { repos: [], islands: [] }, unrecorded: [], islandName: () => undefined, repoOf: repos({}), remote: 0 };

describe('scope', () => {
  it('never takes a session another fleet recorded', async () => {
    const homedir = makeHome();
    const [mine, theirs] = [profileHome(PRIVATE, homedir), profileHome('work', homedir)];
    for (const h of [mine, theirs]) { fs.mkdirSync(h); fs.writeFileSync(path.join(h, 'fleet.json'), '{}'); }
    appendSessions(path.join(theirs, 'retro', 'sessions.ndjson'), [{ at: 1, session: 'S1', robot: 'c_b' }]);
    appendSessions(path.join(mine, 'retro', 'sessions.ndjson'), [{ at: 1, session: 'S2', robot: 'c_a' }]);
    const others = otherFleets(mine, homedir);
    expect(others).toEqual({ homes: new Set([fs.realpathSync(theirs)]), sessions: new Set(['S1']) });
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
    expect(r.inScope).toEqual([{ ...cand('E', { cwd: '/keep', agent: 'codex' }), record: own.get('E'), repo: '/keep', repos: ['/keep'], island: 'i_work' }]);
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
    // asked once for the folder two sessions share, and for the one gone by the nearest folder still there
    expect(calls).toBe(2);
  });

  it('puts a session in a worktree removed since in its repo', async () => {
    const repo = makeHome();
    execFileSync('git', ['init', '-q', repo]);
    expect(await repoFinder()(path.join(repo, '.claude', 'worktrees', 'gone'))).toBe(fs.realpathSync(repo));
  });

  it('compares repos by real path, and leaves out an excluded repo even when it is picked', async () => {
    const [real, other] = [fs.realpathSync(makeHome()), fs.realpathSync(makeHome())];
    const link = path.join(makeHome(), 'link');
    fs.symlinkSync(real, link);
    const repoOf = repos({ '/w/a': real, '/w/b': other });
    const picked = await scope({ ...base, candidates: [cand('A', { cwd: '/w/a' })], unrecorded: [link], repoOf });
    expect(picked.inScope.map((c) => c.session)).toEqual(['A']);
    expect(picked.counts.unrecorded).toEqual([{ repo: real, count: 1, picked: true }]);
    const out = await scope({
      ...base, repoOf, candidates: [cand('A', { cwd: '/w/a' }), cand('B', { cwd: '/w/b' }), cand('C')],
      own: new Map([['C', rec('C', { repo: other })]]), exclude: { repos: [link, `${other}/`], islands: [] }, unrecorded: [link, other],
    });
    expect(out.inScope).toEqual([]);
    expect(out.counts).toMatchObject({ inScope: 0, excluded: 3, unrecorded: [] });
  });

  it('leaves out what ran inside an excluded folder, in git or not, recorded or picked', async () => {
    const [notes, work] = [fs.realpathSync(makeHome()), fs.realpathSync(makeHome())];
    const app = path.join(work, 'app');
    const r = await scope({
      ...base, repoOf: repos({ [app]: app }), exclude: { repos: [notes, work], islands: [] }, unrecorded: [notes, app],
      candidates: [cand('MINE-notes', { cwd: path.join(notes, 'sub') }), cand('MINE-app', { cwd: app }), cand('UNREC-notes', { cwd: notes }), cand('UNREC-app', { cwd: app })],
      own: new Map([['MINE-notes', rec('MINE-notes')], ['MINE-app', rec('MINE-app')]]),
    });
    expect(r.inScope).toEqual([]);
    expect(r.counts).toMatchObject({ excluded: 4, unrecorded: [] });
  });

  it("takes a Codex sub-agent's rollout as the session that started it", async () => {
    const child = (parent: string) => cand(`${parent}-child`, { agent: 'codex', cwd: '/r', parent });
    const r = await scope({
      ...base, candidates: [child('THEIRS'), child('LIFE'), child('MINE')], others: { ...none, sessions: new Set(['THEIRS']) },
      own: new Map([['LIFE', rec('LIFE', { island: 'i_life' })], ['MINE', rec('MINE')]]),
      exclude: { repos: [], islands: ['i_life'] }, unrecorded: ['/r'], repoOf: repos({ '/r': '/r' }),
    });
    expect(r.inScope.map((c) => [c.session, c.record?.session])).toEqual([['MINE-child', 'MINE']]);
    expect(r.counts).toMatchObject({ otherFleets: 1, excluded: 1, unrecorded: [] });
  });

  it('puts a session no fleet recorded with the fleet its context names, and leaves one naming no fleet here unrecorded', async () => {
    // a context names its home as the fleet's paths do, links unresolved
    const [mine, theirs] = [fs.realpathSync(makeHome()), fs.realpathSync(makeHome())];
    const [toMine, toTheirs] = [path.join(makeHome(), 'mine'), path.join(makeHome(), 'theirs')];
    fs.symlinkSync(mine, toMine);
    fs.symlinkSync(theirs, toTheirs);
    const briefed = (session: string, home: string, island = 'i_work') => cand(session, { cwd: '/r', fleet: { home, island } });
    const r = await scope({
      ...base, home: mine, others: { ...none, homes: new Set([theirs]) },
      candidates: [
        briefed('MINE', toMine), briefed('CREW', toMine, 'home'), briefed('LIFE', toMine, 'i_life'), briefed('THEIRS', toTheirs),
        briefed('AWAY', '/home/u/.svall/cache'), cand('PLAIN', { cwd: '/r' }), cand('MINE-child', { agent: 'codex', cwd: '/r', parent: 'MINE' }),
      ],
      exclude: { repos: [], islands: ['Life'] }, islandName: (id) => ({ i_life: 'Life' })[id], repoOf: repos({ '/r': '/r' }),
    });
    expect(r.inScope.map((c) => [c.session, c.repo, c.island])).toEqual([['MINE', '/r', 'i_work'], ['CREW', '/r', 'home'], ['MINE-child', '/r', 'i_work']]);
    expect(r.counts).toMatchObject({ inScope: 3, excluded: 1, otherFleets: 1, unrecorded: [{ repo: '/r', count: 2, picked: false }] });
  });

  it('places a session by the repos it worked in, kept or offered, and reads only those it may keep', async () => {
    const own = new Map([...['MOVED', 'TWO', 'GONE', 'IDLE'].map((s): [string, SessionRecord] => [s, rec(s, { repo: '/a' })]), ['LIFE', rec('LIFE', { island: 'i_life' })]]);
    const read: string[] = [];
    const worked = async (cs: Candidate[]) => {
      read.push(...cs.map((c) => c.session));
      return new Map([['MOVED', ['/b']], ['TWO', ['/b', '/x']], ['GONE', ['/x', '/b']], ['IDLE', []], ['PLAIN', ['/b']]]);
    };
    const r = await scope({
      ...base, own, worked, others: { ...none, sessions: new Set(['THEIRS']) },
      candidates: [
        ...['MOVED', 'TWO', 'GONE', 'IDLE', 'PLAIN'].map((s) => cand(s, { cwd: '/a' })), cand('LIFE'), cand('THEIRS'), cand('ses_oc', { agent: 'opencode', cwd: '/a' }),
      ],
      exclude: { repos: ['/x'], islands: ['i_life'] }, unrecorded: ['/b'], repoOf: repos({ '/a': '/a' }),
    });
    expect(read).toEqual(['MOVED', 'TWO', 'GONE', 'IDLE', 'PLAIN']);
    expect(r.inScope.map((c) => [c.session, c.repo, c.repos])).toEqual([['MOVED', '/b', ['/b']], ['TWO', '/b', ['/b']], ['IDLE', '/a', ['/a']], ['PLAIN', '/b', ['/b']]]);
    expect(r.counts).toMatchObject({ excluded: 2, otherFleets: 1, unrecorded: [{ repo: '/a', count: 1, picked: false }, { repo: '/b', count: 1, picked: true }] });
  });

  it('trusts what a fleet recorded over the context a session names', async () => {
    const theirs = fs.realpathSync(makeHome());
    const r = await scope({
      ...base, others: { ...none, homes: new Set([theirs]) }, own: new Map([['S', rec('S')]]),
      candidates: [cand('S', { cwd: '/r', fleet: { home: theirs, island: 'i_x' } })], repoOf: repos({ '/r': '/r' }),
    });
    expect(r.inScope.map((c) => c.session)).toEqual(['S']);
  });
});

describe('repoWork', () => {
  it('places work in the repos written in, else run in, each with a fifth of it, asking git of checkouts alone', async () => {
    const root = fs.realpathSync(makeHome());
    const [a, b, c] = ['a', 'b', 'c'].map((n) => path.join(root, n));
    const wt = path.join(a, '.claude', 'worktrees', 'wt');
    for (const d of [a, b, c]) fs.mkdirSync(path.join(d, '.git'), { recursive: true });
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: elsewhere\n');
    const asked: string[] = [];
    const reposOf = repoWork(async (dir) => { asked.push(dir); return dir.startsWith(a) ? a : dir; });
    const wrote = { [path.join(a, 'src')]: 3, [path.join(wt, 'src')]: 3, [path.join(a, 'gone', 'deep')]: 2, [b]: 3, [c]: 1, [path.join(root, 'scratch')]: 9 };
    expect(await reposOf({ wrote, ran: { [c]: 50 } })).toEqual([a, b]);
    expect(asked).toEqual([a, wt, a, b, c]);
    expect(await reposOf({ wrote: { [path.join(root, 'scratch')]: 4 }, ran: { [c]: 4, [path.join(b, 'gone')]: 1 } })).toEqual([c, b]);
    expect(await reposOf({ wrote: {}, ran: {} })).toEqual([]);
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
    // a sub-agent's rollout: its own session_meta first, naming its parent, then its parent's
    const X3 = '019eefb3-8d5c-7b00-ad02-80c4930f7428';
    const x3 = touch(path.join(day, `rollout-2026-10-20T10-05-00-${X3}.jsonl`), [
      `{"type":"session_meta","payload":{"id":"${X3}","parent_thread_id":"${X1}","cwd":"/w/sub"}}`,
      `{"type":"session_meta","payload":{"id":"${X1}","cwd":"/w/two"}}`,
    ].join('\n') + '\n', IN);

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
      { agent: 'codex', session: X3, file: x3, cwd: '/w/sub', mtime: IN, parent: X1 },
      { agent: 'claude', session: S1, file: s1, cwd: '/w/one', mtime: IN, subagents: [sub] },
      { agent: 'opencode', session: 'ses_new', file: '', cwd: '/w/three', mtime: IN },
    ]);
    expect(dirs).toEqual(['/w/three', '/w/three/wt', '/w/broken']);
  });

  it('reads the fleet from the Svall context a robot gave the session, at its start or further on, never from one it quoted', async () => {
    const root = makeHome();
    const [claudeDir, codexDir] = [path.join(root, 'claude'), path.join(root, 'codex')];
    const brief = (home: string, island: string) =>
      `# Svall context\nIsland: work\n\n- island: ${home}/docs/islands/${island}\n- robot: ${home}/docs/robots/c_abc123\n\n\`svall robot show c_abc123\` reprints this.`;
    const hook = (text: string) => JSON.stringify({
      type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'SessionStart', content: '', stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: text } }) },
    });
    const quoted = (text: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: text }] } });
    const start = JSON.stringify({ type: 'user', cwd: '/w/one' });
    const long = JSON.stringify({ type: 'assistant', text: 'x'.repeat(70 * 1024) });
    const S3 = '5c3e8f2a-2b4c-4d6e-9f0a-1b2c3d4e5f60';
    const project = path.join(claudeDir, 'projects', '-w-one');
    touch(path.join(project, `${S1}.jsonl`), [start, hook(brief('/h/work', 'i_one'))].join('\n') + '\n', IN);
    touch(path.join(project, `${S2}.jsonl`), [start, quoted(brief('/h/other', 'i_q')), long, hook(brief('/h/work', 'i_two'))].join('\n') + '\n', IN);
    touch(path.join(project, `${S3}.jsonl`), [start, quoted(brief('/h/other', 'i_q'))].join('\n') + '\n', IN);
    touch(path.join(codexDir, 'sessions', '2026', '10', '20', `rollout-2026-10-20T10-00-00-${X1}.jsonl`), [
      `{"type":"session_meta","payload":{"id":"${X1}","cwd":"/w/two"}}`,
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: brief('/h/work', 'i_three') }] } }),
    ].join('\n') + '\n', IN);

    const found = await discover({ span: { from: FROM, to: IN }, claudeDir, codexDir });
    expect(Object.fromEntries(found.map((c) => [c.session, c.fleet]))).toEqual({
      [S1]: { home: '/h/work', island: 'i_one' }, [S2]: { home: '/h/work', island: 'i_two' }, [S3]: undefined, [X1]: { home: '/h/work', island: 'i_three' },
    });
    expect(found.find((c) => c.session === X1)?.cwd).toBe('/w/two');
  });

  it("reads the island of a context Svall renders, mission control's too, from its folder list and never from a diff or a note", async () => {
    const root = makeHome();
    const claudeDir = path.join(root, 'claude');
    const island = (o: Partial<Island>): Island => ({ id: 'i_x', name: 'Work', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 6, h: 4 }, seed: 1, ...o });
    const robot: Robot = { id: 'c_a', islandId: 'i_x', cell: { x: 1, y: 1 }, name: 'r', portrait: 'fox', note: 'todo\n- island: /h/note/docs/islands/i_note', instructions: '', context: [], cwd: '/w', shell: { lastOutputAt: 0 }, unread: false };
    const brief = (on: Island) => renderBrief(on, robot, [{ tier: 'island', dir: `/h/real/docs/islands/${on.id}`, docs: [] }, { tier: 'robot', dir: '/h/real/docs/robots/c_a', docs: [] }]);
    const added = (text: string) => JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', hookEvent: 'UserPromptSubmit', content: [text] } });
    const project = path.join(claudeDir, 'projects', '-w');
    touch(path.join(project, `${S1}.jsonl`), [added(`${BRIEF_CHANGED}\n- island: /h/old/docs/islands/i_old`), added(brief(island({ id: HOME_ISLAND, kind: 'home' })))].join('\n') + '\n', IN);
    touch(path.join(project, `${S2}.jsonl`), added(brief(island({ id: 'i_real' }))) + '\n', IN);

    const found = await discover({ span: { from: FROM, to: IN }, claudeDir, codexDir: '/nonexistent/codex' });
    expect(Object.fromEntries(found.map((c) => [c.session, c.fleet]))).toEqual({ [S1]: { home: '/h/real', island: HOME_ISLAND }, [S2]: { home: '/h/real', island: 'i_real' } });
  });

  it('finds nothing in stores that are not there', async () => {
    expect(await discover({ span: { from: FROM, to: IN }, claudeDir: '/nonexistent/claude', codexDir: '/nonexistent/codex' })).toEqual([]);
  });
});
