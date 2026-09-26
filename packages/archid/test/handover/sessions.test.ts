import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyState, FleetConfig, type Character, type MachineId, type TransferSession } from '@archipelago/protocol';
import { buildInventory, type MachineMaps } from '../../src/handover/inventory.js';
import { realStages } from '../../src/handover/durable.js';
import { buildManifest } from '../../src/handover/manifest.js';
import { importState } from '../../src/handover/validate.js';
import { claudeAdapter, claudeProjectSlug } from '../../src/handover/sessions/claude.js';
import { codexAdapter } from '../../src/handover/sessions/codex.js';
import {
  adapterFor, agentAdapters, agentBlockers, installSession, placeFile, placeSessions, placeTranscripts, probeAgent, realInstallFs, sessionPathMap,
  type AgentProbe, type AgentRun, type InstallFs,
} from '../../src/handover/sessions/registry.js';
import { repairBrief } from '../../src/handover/sessions/repair.js';
import { SessionError, type PathMap, type SessionFs } from '../../src/handover/sessions/types.js';
import { HOOK_EVENTS, mergeHooks, mergeStatusLine, statusWrapper } from '../../src/setup.js';
import { codexHookCommand, mergeCodexHooks } from '../../src/codex/install.js';
import { resolvePaths } from '../../src/paths.js';
import { shq } from '../../src/text.js';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/handover');
const made: string[] = [];
const tmp = (): string => { const d = fs.realpathSync(fs.mkdtempSync('/tmp/archi-s-')); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const fsOf: SessionFs = {
  lstat: (p) => fs.promises.lstat(p),
  readdir: (p) => fs.promises.readdir(p, { encoding: 'buffer' }),
};
const lines = (data: Buffer | string): string[] => data.toString().split('\n').filter(Boolean);
const rows = (data: Buffer | string): Record<string, any>[] => lines(data).map((l) => JSON.parse(l));
const sha = (data: Buffer | string): string => crypto.createHash('sha256').update(data).digest('hex');

/** Copies a fixture folder into a fresh agent home and returns that home. */
function home(fixture: string, name = '.claude'): string {
  const dir = path.join(tmp(), name);
  fs.cpSync(path.join(FIXTURES, fixture), dir, { recursive: true });
  return dir;
}

// the real sessions each supported release wrote, sanitized: where they were made and where they go
const CLAUDE = [
  { version: '2.1.280', id: 'bf480ea6-5572-4554-8016-2dc5590f5bba', slug: '-Users-source-work-demo', from: '/Users/source', to: '/home/target', agent: 'agent-a4906877eb9919cf5' },
  { version: '2.1.251', id: '1fb0d1a7-29a9-4159-a932-5ffd2da8faba', slug: '-home-source-work-demo', from: '/home/source', to: '/Users/target', agent: 'agent-aec6de8cd1d2df280' },
] as const;
const CODEX = [
  { version: '0.155.1', file: 'sessions/2026/09/23/rollout-2026-09-23T08-44-38-01a0cd02-5930-73f0-ad55-add2b1effa04.jsonl', id: '01a0cd02-5930-73f0-ad55-add2b1effa04', from: '/Users/source', to: '/home/target' },
  { version: '0.156.1', file: 'sessions/2026/09/23/rollout-2026-09-23T08-44-52-01a0cd02-8ea0-75c1-89b3-89718ecbd91f.jsonl', id: '01a0cd02-8ea0-75c1-89b3-89718ecbd91f', from: '/home/source', to: '/Users/target' },
] as const;

const mapFor = (from: string, to: string, agentHome: string): PathMap =>
  sessionPathMap({ sourceRoots: { home: from }, destinationRoots: { home: to }, sourceHome: `${from}/${agentHome}`, destinationHome: `${to}/${agentHome}` });

describe('the adapter registry', () => {
  it('knows every Claude Code and Codex release in use, and no other', () => {
    for (const v of ['2.1.251', '2.1.278', '2.1.280']) expect(adapterFor('claude', v)).toBe(claudeAdapter);
    for (const v of ['0.155.1', '0.156.1']) expect(adapterFor('codex', v)).toBe(codexAdapter);
    for (const v of ['2.1.250', '2.1.281', '2.2.0', '2.1.280-beta.1', 'latest', '']) expect(adapterFor('claude', v)).toBeUndefined();
    for (const v of ['0.142.0-alpha.6', '0.142.0', '0.155.0', '0.157.0']) expect(adapterFor('codex', v)).toBeUndefined();
  });

  it('maps a path through the agent homes before the path roots, and leaves one no root holds', () => {
    const map = sessionPathMap({
      sourceRoots: { home: '/Users/s', work: '/Volumes/w' }, destinationRoots: { home: '/home/t' },
      sourceHome: '/Users/s/.claude-work', destinationHome: '/home/t/.claude',
    });
    expect(map('/Users/s/.claude-work/plans/p.md')).toBe('/home/t/.claude/plans/p.md');
    expect(map('/Users/s/code/app/')).toBe('/home/t/code/app/');
    expect(map('/Users/s')).toBe('/home/t');
    expect(map('/Users/sx/app')).toBeUndefined();
    // a root the destination does not declare maps nothing, and inventory has already blocked what lives there
    expect(map('/Volumes/w/app')).toBeUndefined();
    expect(map('/private/tmp/x')).toBeUndefined();
  });

  it('reports each installed CLI with the adapter that reads its sessions, 0 for none, and its login and hooks', () => {
    const probes: AgentProbe[] = [
      { kind: 'claude', version: '2.1.280', home: '/h/.claude', loggedIn: true, hooks: true },
      { kind: 'codex', version: '0.157.0', home: '/h/.codex', loggedIn: false, hooks: true },
    ];
    expect(agentAdapters(probes)).toEqual([
      { kind: 'claude', version: '2.1.280', adapter: 1, home: '/h/.claude', loggedIn: true, hooks: true },
      { kind: 'codex', version: '0.157.0', adapter: 0, home: '/h/.codex', loggedIn: false, hooks: true },
    ]);
  });
});

describe('Claude Code sessions', () => {
  it('finds a session from the exact transcript it recorded, in whatever config folder it ran with', async () => {
    const h = home('claude/2.1.280', '.claude-work');
    const { id, slug, agent } = CLAUDE[0];
    const project = path.join(h, 'projects', slug);
    // what belongs to this session, and what does not: file history stays, as its backups name machine-local files
    fs.mkdirSync(path.join(project, id, 'tool-results'), { recursive: true });
    fs.writeFileSync(path.join(project, id, 'tool-results', 'b1.txt'), 'a long tool result');
    fs.writeFileSync(path.join(project, id, 'tool-results', 'toolu_01AbC.json'), '{"items":[]}');
    fs.mkdirSync(path.join(h, 'file-history', id), { recursive: true });
    fs.writeFileSync(path.join(h, 'file-history', id, 'abc@v1'), 'alpha\n');
    fs.writeFileSync(path.join(project, '99999999-2222-4333-8444-555555555555.jsonl'), '{}\n');
    fs.writeFileSync(path.join(project, 'sessions-index.json'), '{}');
    fs.mkdirSync(path.join(h, 'session-env', id), { recursive: true });
    fs.writeFileSync(path.join(h, 'session-env', id, 'env'), 'SECRET=1');
    fs.mkdirSync(path.join(h, 'tasks', id), { recursive: true });
    fs.writeFileSync(path.join(h, '.credentials.json'), '{}');

    const found = await claudeAdapter.discover(path.join(project, `${id}.jsonl`), id, fsOf);
    expect(found).toEqual({
      home: h,
      transcript: `projects/${slug}/${id}.jsonl`,
      files: [
        `projects/${slug}/${id}.jsonl`,
        `projects/${slug}/${id}/subagents/${agent}.jsonl`,
        `projects/${slug}/${id}/subagents/${agent}.meta.json`,
        `projects/${slug}/${id}/tool-results/b1.txt`,
        `projects/${slug}/${id}/tool-results/toolu_01AbC.json`,
      ],
    });
  });

  it('refuses a session folder holding a kind of file the tested releases were not shown to need', async () => {
    const { id, slug } = CLAUDE[0];
    for (const stray of ['auto-mode-classifier-error.txt', 'subagents/agent-a1.json', 'tool-results/p1/page-1.jpg', 'notes/plan.md']) {
      const h = home('claude/2.1.280');
      const file = path.join(h, 'projects', slug, id, stray);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'x');
      const refused = await claudeAdapter.discover(path.join(h, 'projects', slug, `${id}.jsonl`), id, fsOf).then(() => undefined, (e: SessionError) => e);
      expect(refused, stray).toMatchObject({ code: 'incompatible_adapter', message: expect.stringContaining(stray) });
    }
  });

  it('refuses a transcript that is missing, another session, outside a projects folder, or a link', async () => {
    const h = home('claude/2.1.280');
    const { id, slug } = CLAUDE[0];
    const transcript = path.join(h, 'projects', slug, `${id}.jsonl`);
    const refusal = (p: string, sid: string = id) => claudeAdapter.discover(p, sid, fsOf).then(() => undefined, (e: SessionError) => e.code);
    expect(await refusal(path.join(h, 'projects', slug, '22222222-2222-4333-8444-555555555555.jsonl'), '22222222-2222-4333-8444-555555555555')).toBe('transcript_missing');
    expect(await refusal(transcript, '22222222-2222-4333-8444-555555555555')).toBe('transcript_missing');
    const loose = path.join(h, `${id}.jsonl`);
    fs.copyFileSync(transcript, loose);
    expect(await refusal(loose)).toBe('incompatible_adapter');
    const other = path.join(h, 'projects', 'elsewhere');
    fs.mkdirSync(other);
    fs.symlinkSync(transcript, path.join(other, `${id}.jsonl`));
    expect(await refusal(path.join(other, `${id}.jsonl`))).toBe('incompatible_adapter');
    fs.symlinkSync('/etc', path.join(h, 'projects', slug, id, 'escape'));
    expect(await refusal(transcript)).toBe('incompatible_adapter');
    fs.rmSync(path.join(h, 'projects', slug, id, 'escape'));
    // a sidecar folder this user cannot read is a blocker, not a crash
    const sealed = path.join(h, 'projects', slug, id, 'subagents');
    fs.chmodSync(sealed, 0o000);
    try { expect(await refusal(transcript)).toBe('path_unsupported'); } finally { fs.chmodSync(sealed, 0o755); }
  });

  it('places the transcript under the project folder Claude Code derives from the cwd it resumes in', () => {
    expect(claudeAdapter.destination('projects/-Users-source-work-demo/x.jsonl', 'x', '/home/target/work/demo')).toBe('projects/-home-target-work-demo/x.jsonl');
    expect(claudeProjectSlug('/home/t/.archi-probe/my_dir')).toBe('-home-t--archi-probe-my-dir');
    // past 200 characters Claude Code cuts the name and adds a hash of the whole path
    const long = `/home/t/${'deep/'.repeat(45)}end`;
    expect(claudeProjectSlug(long)).toBe(`${long.replace(/[^A-Za-z0-9]/g, '-').slice(0, 200)}-8y1vbo`);
  });

  it('carries sidecars beside the transcript into the new project folder', () => {
    const from = 'projects/-Users-source-work-demo/s1.jsonl';
    const to = 'projects/-home-target-work-demo/s1.jsonl';
    expect(placeFile(from, from, to)).toBe(to);
    expect(placeFile('projects/-Users-source-work-demo/s1/subagents/a.jsonl', from, to)).toBe('projects/-home-target-work-demo/s1/subagents/a.jsonl');
  });

  describe.each(CLAUDE)('as Claude Code $version wrote it', ({ version, id, slug, from, to, agent }) => {
    const transcript = `projects/${slug}/${id}.jsonl`;
    const read = (rel: string): Buffer => fs.readFileSync(path.join(FIXTURES, 'claude', version, rel));

    it('holds nothing the adapter does not know', () => {
      const map = mapFor(from, to, '.claude');
      for (const rel of [transcript, `projects/${slug}/${id}/subagents/${agent}.jsonl`, `projects/${slug}/${id}/subagents/${agent}.meta.json`]) {
        expect(claudeAdapter.validate(rel, read(rel), map)).toEqual([]);
      }
    });

    it('moves every record cwd and keeps what the conversation said byte for byte', () => {
      const before = read(transcript);
      const after = claudeAdapter.rewrite(transcript, before, mapFor(from, to, '.claude'));
      const [was, now] = [rows(before), rows(after)];
      expect(now.filter((r) => r.cwd).every((r) => r.cwd === `${to}/work/demo`)).toBe(true);
      expect(now.filter((r) => r.cwd)).toHaveLength(was.filter((r) => r.cwd).length);
      now.forEach((r, i) => {
        expect(r.message).toEqual(was[i].message);
        expect(r.toolUseResult).toEqual(was[i].toolUseResult);
        // an attachment is what the model was shown, so the environment it describes stays the source's
        expect(r.attachment).toEqual(was[i].attachment);
      });
      expect(now.find((r) => r.attachment?.type === 'environment')!.attachment.snapshot.workingDirectory).toBe(`${from}/work/demo`);
      // a line with nothing to move is the same bytes
      const kept = lines(before).filter((l) => !JSON.parse(l).cwd);
      expect(kept.every((l) => lines(after).includes(l))).toBe(true);
      expect(after.toString().endsWith('\n')).toBe(before.toString().endsWith('\n'));
    });

    it('comes back to the same bytes when moved there and back', () => {
      const there = claudeAdapter.rewrite(transcript, read(transcript), mapFor(from, to, '.claude'));
      expect(claudeAdapter.validate(transcript, there, mapFor(to, from, '.claude'))).toEqual([]);
      expect(claudeAdapter.rewrite(transcript, there, mapFor(to, from, '.claude'))).toEqual(read(transcript));
    });
  });

  // the sanitized Task 1 fixture, whose synthetic records carry the rarer path fields
  it('moves the worktree, relocation and frame paths it knows, and leaves file history naming the source files it backed up', () => {
    const map = mapFor('/Users/source', '/home/target', '.claude');
    const spike = fs.readFileSync(path.join(FIXTURES, 'claude/session.jsonl'));
    const moved = rows(claudeAdapter.rewrite('projects/p/s.jsonl', spike, map));
    expect(moved[3].worktreeSession).toEqual({ originalCwd: '/home/target/work/demo', worktreePath: '/home/target/work/demo/.worktree' });
    expect(moved[0].message.content).toContain('/Users/source/work/demo');
    expect(moved[1].message.content[0].input.file_path).toBe('/Users/source/work/demo/notes.txt');

    const v = '"version":"2.1.280"';
    const extra = [
      `{"type":"user","cwd":"/Users/source/w",${v},"message":{"role":"user","content":"hi"}}`,
      '{"type":"relocated","sessionId":"s","relocatedCwd":"/Users/source/w2"}',
      '{"type":"worktree-state","sessionId":"s","worktreeSession":{"originalCwd":"/Users/source/w","preEnterOriginalCwd":"/Users/source/w","worktreePath":"/Users/source/w/.claude/worktrees/x"}}',
      '{"type":"file-history-snapshot","messageId":"m","snapshot":{"trackedFileBackups":{"/Users/source/w/a.ts":{"backupFileName":"h@v1","realParentDir":"/Users/source/w"},"b.ts":{"backupFileName":"i@v1","realParentDir":"/Users/source/w"}}},"isSnapshotUpdate":false}',
      '{"type":"file-history-delta","messageId":"m","snapshotMessageId":"m","trackingPath":"/Users/source/w/a.ts","backup":{"backupFileName":"h@v2","realParentDir":"/Users/source/w"},"timestamp":"t"}',
      '{"type":"frame-link","sessionId":"s","path":"/Users/source/w/page.html","frameUrl":"https://x.test/f","title":"t","artifactCount":1,"timestamp":"t"}',
      '{"type":"system","subtype":"stop_hook_summary","hookInfos":[{"command":"/Users/source/.claude/hooks/x.sh"}],"cwd":"/Users/source/w","version":"2.1.280"}',
    ].join('\n') + '\n';
    const rewritten = claudeAdapter.rewrite('projects/p/s.jsonl', Buffer.from(extra), map);
    const out = rows(rewritten);
    expect(out[1].relocatedCwd).toBe('/home/target/w2');
    expect(out[2].worktreeSession).toEqual({ originalCwd: '/home/target/w', preEnterOriginalCwd: '/home/target/w', worktreePath: '/home/target/w/.claude/worktrees/x' });
    // the backups stay on the source, so a rewind here finds none of this machine's files named
    expect(lines(rewritten).slice(3, 5)).toEqual(lines(extra).slice(3, 5));
    expect(out[5].path).toBe('/home/target/w/page.html');
    expect(out[6].hookInfos).toEqual([{ command: '/Users/source/.claude/hooks/x.sh' }]);

    const meta = Buffer.from('{"agentType":"general-purpose","description":"look in /Users/source/w","worktreePath":"/Users/source/w/.claude/worktrees/a","cwd":"/Users/source/w"}\n');
    expect(JSON.parse(claudeAdapter.rewrite('projects/p/s/subagents/agent-a.meta.json', meta, map).toString())).toEqual({
      agentType: 'general-purpose', description: 'look in /Users/source/w', worktreePath: '/home/target/w/.claude/worktrees/a', cwd: '/home/target/w',
    });
  });

  it('refuses what a supported release does not write', () => {
    const map = mapFor('/Users/source', '/home/target', '.claude');
    const user = (extra: string) => `{"type":"user","cwd":"/Users/source/w","version":"2.1.280","message":{"role":"user","content":"hi"}${extra}}`;
    const issues = (...l: string[]) => claudeAdapter.validate('projects/p/s.jsonl', Buffer.from(l.join('\n') + '\n'), map);
    expect(issues(user(''))).toEqual([]);
    expect(issues(user(''), '{"type":"holodeck","sessionId":"s"}')).toEqual([expect.stringContaining('"holodeck"')]);
    expect(issues(user(''), '{"type":"attachment","attachment":{"type":"telepathy"},"version":"2.1.280"}')).toEqual([expect.stringContaining('"telepathy"')]);
    expect(issues(user(''), '{"type":"user","version":"2.1.250","message":{}}')).toEqual([expect.stringContaining('2.1.250')]);
    expect(issues(user(''), '{"type":"user","version":"2.1.281","message":{}}')).toEqual([expect.stringContaining('2.1.281')]);
    // a new field holding a source path is a variant nobody taught the adapter to move
    expect(issues(user(',"scratchDir":"/Users/source/w/.scratch"'))).toEqual([expect.stringContaining('scratchDir')]);
    expect(issues(user(''), 'not json', user(''))).toEqual([expect.stringContaining('line 2')]);
    expect(issues('{"type":"mode","mode":"normal","sessionId":"s"}')).toEqual([expect.stringContaining('release')]);
    expect(() => claudeAdapter.rewrite('projects/p/s.jsonl', Buffer.from(user(',"scratchDir":"/Users/source/w"')), map))
      .toThrow(expect.objectContaining({ code: 'incompatible_adapter' }));
    // a path outside every root, such as a temp folder, is no path this handover could move
    expect(issues(user(',"scratchDir":"/private/tmp/x"'))).toEqual([]);
  });

  it('leaves a last line that is still being written as it is', () => {
    const map = mapFor('/Users/source', '/home/target', '.claude');
    const text = '{"type":"user","cwd":"/Users/source/w","version":"2.1.280","message":{}}\n{"type":"assist';
    expect(claudeAdapter.validate('projects/p/s.jsonl', Buffer.from(text), map)).toEqual([]);
    expect(claudeAdapter.rewrite('projects/p/s.jsonl', Buffer.from(text), map).toString()).toBe(
      '{"type":"user","cwd":"/home/target/w","version":"2.1.280","message":{}}\n{"type":"assist');
  });

  it('carries saved tool output as it is, and refuses a file that is no part of a session', () => {
    const map = mapFor('/Users/source', '/home/target', '.claude');
    const output = Buffer.from('{"cwd":"/Users/source/w","listing":["/Users/source/w/a.ts"]}');
    for (const f of ['projects/p/s/tool-results/b1.txt', 'projects/p/s/tool-results/toolu_01AbC.json']) {
      expect(claudeAdapter.validate(f, output, map), f).toEqual([]);
      expect(claudeAdapter.rewrite(f, output, map)).toEqual(output);
    }
    for (const f of ['projects/p/s/auto-mode-classifier-error.txt', 'projects/p/s/subagents/agent-a.json', 'file-history/s/abc@v1', 'CLAUDE.md']) {
      expect(claudeAdapter.validate(f, output, map), f).toEqual([expect.stringContaining('does not carry')]);
      expect(() => claudeAdapter.rewrite(f, output, map), f).toThrow(expect.objectContaining({ code: 'incompatible_adapter' }));
    }
  });
});

describe('Codex sessions', () => {
  it('finds a rollout from the exact path it recorded, in whatever CODEX_HOME it ran with', async () => {
    const h = home('codex/0.156.1', 'codex-elsewhere');
    const { file, id } = CODEX[1];
    fs.writeFileSync(path.join(h, 'history.jsonl'), '{}\n');
    fs.writeFileSync(path.join(h, 'session_index.jsonl'), `{"id":"${id}","thread_name":"x"}\n`);
    fs.writeFileSync(path.join(h, 'auth.json'), '{}');
    expect(await codexAdapter.discover(path.join(h, file), id, fsOf)).toEqual({ home: h, transcript: file, files: [file] });
    expect(codexAdapter.destination(file, id, '/anywhere')).toBe(file);
  });

  it('refuses a rollout that is missing, another session, archived, loose, or a link', async () => {
    const h = home('codex/0.156.1', '.codex');
    const { file, id } = CODEX[1];
    const refusal = (p: string, sid: string = id) => codexAdapter.discover(p, sid, fsOf).then(() => undefined, (e: SessionError) => e.code);
    expect(await refusal(path.join(h, file.replace('08-44-52', '08-44-53')))).toBe('transcript_missing');
    expect(await refusal(path.join(h, file), '01a0cd02-0000-7000-8000-000000000000')).toBe('transcript_missing');
    for (const where of ['archived_sessions/2026/09/23', 'sessions']) {
      const p = path.join(h, where, path.basename(file));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.copyFileSync(path.join(h, file), p);
      expect(await refusal(p)).toBe('incompatible_adapter');
    }
    const link = path.join(h, 'sessions/2026/09/24', path.basename(file));
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(h, file), link);
    expect(await refusal(link)).toBe('incompatible_adapter');
  });

  describe.each(CODEX)('as Codex $version wrote it', ({ version, file, from, to }) => {
    const read = (): Buffer => fs.readFileSync(path.join(FIXTURES, 'codex', version, file));

    it('holds nothing the adapter does not know', () => {
      expect(codexAdapter.validate(file, read(), mapFor(from, to, '.codex'))).toEqual([]);
    });

    it('moves the live paths and keeps what the session said and ran byte for byte', () => {
      const before = rows(read());
      const after = rows(codexAdapter.rewrite(file, read(), mapFor(from, to, '.codex')));
      const cwd = `${to}/work/demo`;
      const meta = after.find((r) => r.type === 'session_meta')!.payload;
      expect([meta.cwd, ...meta.runtime_workspace_roots]).toEqual([cwd, cwd]);
      const turn = after.find((r) => r.type === 'turn_context')!.payload;
      expect(turn.cwd).toBe(cwd);
      expect(turn.workspace_roots).toEqual([cwd]);
      const entries = [...turn.permission_profile.file_system.entries, ...turn.file_system_sandbox_policy.entries]
        .filter((e: any) => e.path.type === 'path').map((e: any) => e.path.path);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((p: string) => p.startsWith(cwd))).toBe(true);
      expect(after.find((r) => r.type === 'world_state')!.payload.state.environments.environments.local.cwd).toBe(cwd);
      after.forEach((r, i) => {
        if (r.type === 'response_item') expect(r).toEqual(before[i]);
        if (r.type === 'world_state') expect(r.payload.state.environments.filesystem).toBe(before[i].payload.state.environments.filesystem);
        if (r.payload?.item?.changes) expect(r.payload.item.changes).toEqual(before[i].payload.item.changes);
      });
    });

    it('comes back to the same bytes when moved there and back', () => {
      const there = codexAdapter.rewrite(file, read(), mapFor(from, to, '.codex'));
      expect(codexAdapter.rewrite(file, there, mapFor(to, from, '.codex'))).toEqual(read());
    });
  });

  // the sanitized Task 2 fixture: a command's cwd is a file: URL, and its output is evidence
  it('moves a completed command cwd as a file: URL and leaves its output alone', () => {
    const id = '01a0aaaa-bbbb-7ccc-8ddd-eeeeffff0000';
    const file = `sessions/2026/09/21/rollout-2026-09-21T19-28-46-${id}.jsonl`;
    const data = fs.readFileSync(path.join(FIXTURES, 'codex/rollout.jsonl'));
    const map = mapFor('/Users/source', '/home/target', '.codex');
    expect(codexAdapter.validate(file, data, map)).toEqual([]);
    const out = rows(codexAdapter.rewrite(file, data, map));
    expect(out[5].payload.item.cwd).toBe('file:///home/target/work/demo');
    expect(out[5].payload.item.stdout).toBe('/Users/source/work/demo\n');
    expect(out[1].payload.state.permissions.approved_command_prefixes[1][1]).toBe('/Users/source/work/demo/notes.txt');
  });

  it('refuses what a supported release does not write', () => {
    const map = mapFor('/Users/source', '/home/target', '.codex');
    const id = '01a0cd02-5930-73f0-ad55-add2b1effa04';
    const file = `sessions/2026/09/23/rollout-2026-09-23T08-44-38-${id}.jsonl`;
    const meta = (o: object = {}) => JSON.stringify({ timestamp: 't', type: 'session_meta', payload: { id, session_id: id, cwd: '/Users/source/w', cli_version: '0.155.1', ...o } });
    const issues = (...l: string[]) => codexAdapter.validate(file, Buffer.from(l.join('\n') + '\n'), map);
    expect(issues(meta())).toEqual([]);
    expect(issues(meta({ cli_version: '0.142.0' }))).toEqual([expect.stringContaining('0.142.0')]);
    expect(issues(meta({ id: '01a0cd02-0000-7000-8000-000000000000', session_id: undefined }))).toEqual([expect.stringContaining('session_meta')]);
    expect(issues('{"timestamp":"t","type":"event_msg","payload":{"type":"task_started"}}', meta())).toEqual([expect.stringContaining('session_meta')]);
    expect(issues(meta(), '{"timestamp":"t","type":"hologram","payload":{}}')).toEqual([expect.stringContaining('"hologram"')]);
    expect(issues(meta(), '{"timestamp":"t","type":"turn_context","payload":{"cwd":"/Users/source/w","scratch_root":"/Users/source/w/.x"}}'))
      .toEqual([expect.stringContaining('scratch_root')]);
    // the rollout the Codex app's 0.142 CLI wrote
    const old = fs.readFileSync(path.join(FIXTURES, '../rollout.jsonl'));
    expect(codexAdapter.validate('sessions/2026/06/22/rollout-2026-06-22T16-19-47-019eefb3-8d5c-7b00-ad02-80c4930f7426.jsonl', old, map))
      .toEqual([expect.stringContaining('0.142.0')]);
  });
});

const MAC = '9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const TRIFT = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const FLEET = FleetConfig.parse({ id: '5e1f0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' });

function char(id: string, o: Partial<Character>): Character {
  return {
    id, islandId: 'i1', cell: { x: 0, y: 0 }, name: id, note: '', portrait: 'fox', instructions: '', cwd: '/',
    context: [], shell: { lastOutputAt: 0 }, unread: false, ...o,
  };
}

/**
 * A source machine whose home is a temp folder: one character running the real 2.1.280 Claude session in its
 * first terminal and the real 0.155.1 Codex rollout in its second, both made under a home of `/Users/source`.
 */
function machines(agentHomes: MachineMaps['destination']['agentHomes'] = { claude: '/home/target/.claude-alt', codex: '/home/target/.codex' }) {
  const base = tmp();
  const mac = path.join(base, 'Users/source');
  const work = path.join(mac, 'work/demo');
  fs.mkdirSync(work, { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'claude/2.1.280'), path.join(mac, '.claude'), { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'codex/0.155.1'), path.join(mac, '.codex'), { recursive: true });
  // the fixtures were made with a home of /Users/source, which this machine's home stands in for
  for (const f of [`.claude/projects/${CLAUDE[0].slug}/${CLAUDE[0].id}.jsonl`, `.claude/projects/${CLAUDE[0].slug}/${CLAUDE[0].id}/subagents/${CLAUDE[0].agent}.jsonl`, `.codex/${CODEX[0].file}`]) {
    const p = path.join(mac, f);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll('/Users/source', mac));
  }
  const maps: MachineMaps = {
    source: { machineId: MAC, pathRoots: { home: mac }, fleetHome: path.join(mac, '.archipelago') },
    destination: { machineId: TRIFT, pathRoots: { home: '/home/target' }, fleetHome: '/home/target/.archipelago', agentHomes },
  };
  const state = emptyState();
  state.characters.c1 = char('c1', {
    cwd: work,
    agent: { kind: 'claude', sessionId: CLAUDE[0].id, transcriptPath: path.join(mac, '.claude/projects', CLAUDE[0].slug, `${CLAUDE[0].id}.jsonl`), status: 'idle', lastActivityAt: 0 },
    second: { cwd: work, unread: false, agent: { kind: 'codex', sessionId: CODEX[0].id, transcriptPath: path.join(mac, '.codex', CODEX[0].file), status: 'idle', lastActivityAt: 0 } },
  });
  return { base, mac, work, maps, state };
}

describe('sessions in the transfer manifest', () => {
  it('lists every file of each session apart from the roots, and where each transcript will land', async () => {
    const m = machines();
    const { manifest, blockers } = await buildManifest(buildInventory(m.state, { fleet: FLEET }, m.maps), { generation: 1 });
    expect(blockers).toEqual([]);
    const [claude, codex] = manifest.sessions;
    const { id, slug, agent } = CLAUDE[0];
    expect(claude).toMatchObject({
      characterId: 'c1', agent: 'claude', sessionId: id, adapter: 1,
      sourceHome: path.join(m.mac, '.claude'), destinationHome: '/home/target/.claude-alt',
      destinationPath: `/home/target/.claude-alt/projects/-home-target-work-demo/${id}.jsonl`,
    });
    expect(claude.files.map((f) => f.path)).toEqual([
      `projects/${slug}/${id}.jsonl`, `projects/${slug}/${id}/subagents/${agent}.jsonl`, `projects/${slug}/${id}/subagents/${agent}.meta.json`,
    ]);
    const transcript = fs.readFileSync(claude.sourcePath);
    expect(claude.files[0]).toMatchObject({ type: 'file', size: transcript.length, sha256: sha(transcript) });
    expect(codex).toMatchObject({
      characterId: 'c1', term: 2, agent: 'codex', adapter: 1, sourceHome: path.join(m.mac, '.codex'),
      destinationPath: `/home/target/.codex/${CODEX[0].file}`, files: [expect.objectContaining({ path: CODEX[0].file })],
    });
    // no session file becomes a root, and nothing under an agent home is mirrored
    expect(manifest.roots.map((r) => r.sourcePath)).toEqual([m.work]);
  });

  it('blocks a session a supported release did not write, and one the destination has no home for', async () => {
    const m = machines({ codex: '/home/target/.codex' });
    const transcript = m.state.characters.c1.agent!.transcriptPath!;
    fs.writeFileSync(transcript, fs.readFileSync(transcript, 'utf8').replaceAll('"version":"2.1.280"', '"version":"2.1.290"'));
    const { manifest, blockers } = await buildManifest(buildInventory(m.state, { fleet: FLEET }, m.maps), { generation: 1 });
    expect(blockers).toEqual([
      expect.objectContaining({ code: 'agent_cli_missing', entity: { kind: 'character', id: 'c1' } }),
      expect.objectContaining({ code: 'incompatible_adapter', message: expect.stringContaining('2.1.290'), entity: { kind: 'character', id: 'c1' } }),
    ]);
    expect(manifest.sessions.find((s) => s.agent === 'claude')?.destinationPath).toBeUndefined();
  });

  it('blocks a transcript that is gone', async () => {
    const m = machines();
    fs.rmSync(m.state.characters.c1.second!.agent!.transcriptPath!);
    const { blockers } = await buildManifest(buildInventory(m.state, { fleet: FLEET }, m.maps), { generation: 1 });
    expect(blockers).toEqual([expect.objectContaining({ code: 'transcript_missing', entity: { kind: 'character', id: 'c1' } })]);
  });

  it('blocks a session whose folder holds a file its adapter does not carry, naming the file', async () => {
    const m = machines();
    const { id, slug } = CLAUDE[0];
    fs.writeFileSync(path.join(m.mac, '.claude/projects', slug, id, 'auto-mode-classifier-error.txt'), 'classifier said no');
    const { manifest, blockers } = await buildManifest(buildInventory(m.state, { fleet: FLEET }, m.maps), { generation: 1 });
    expect(blockers).toEqual([
      expect.objectContaining({ code: 'incompatible_adapter', message: expect.stringContaining('auto-mode-classifier-error.txt'), entity: { kind: 'character', id: 'c1' } }),
    ]);
    expect(manifest.sessions.map((s) => s.agent)).toEqual(['codex']);
  });
});

describe('a session arriving on the destination', () => {
  // the manifest the source built, the source's bytes staged at their manifest paths, and a destination home
  async function arrival() {
    const m = machines({ claude: path.join(tmp(), 'dest/.claude'), codex: path.join(tmp(), 'dest/.codex') });
    const { manifest } = await buildManifest(buildInventory(m.state, { fleet: FLEET }, m.maps), { generation: 1 });
    const stage = (s: TransferSession): string => {
      const dir = path.join(tmp(), 'staged');
      for (const f of s.files) fs.cpSync(path.join(s.sourceHome!, f.path), path.join(dir, f.path));
      return dir;
    };
    const roots = { sourceRoots: manifest.sourceRoots, destinationRoots: manifest.destinationRoots };
    return { m, manifest, stage, roots, claude: manifest.sessions[0], codex: manifest.sessions[1] };
  }

  it('lands under the destination agent home in its lookup layout, rewritten for that machine', async () => {
    const { claude, codex, stage, roots } = await arrival();
    const { id, agent } = CLAUDE[0];
    expect(installSession(claude, stage(claude), roots)).toEqual({ transcriptPath: claude.destinationPath });
    const project = path.join(claude.destinationHome!, 'projects/-home-target-work-demo');
    expect(rows(fs.readFileSync(path.join(project, `${id}.jsonl`))).filter((r) => r.cwd).every((r) => r.cwd === '/home/target/work/demo')).toBe(true);
    expect(fs.existsSync(path.join(project, id, 'subagents', `${agent}.meta.json`))).toBe(true);
    expect(fs.statSync(path.join(project, `${id}.jsonl`)).mode & 0o777).toBe(0o600);
    expect(installSession(codex, stage(codex), roots)).toEqual({ transcriptPath: `${codex.destinationHome}/${CODEX[0].file}` });
    expect(rows(fs.readFileSync(codex.destinationPath!))[0].payload.cwd).toBe('/home/target/work/demo');
  });

  it('keeps a copy already there when it is the same, and replaces one the incoming session only adds to', async () => {
    const { claude, stage, roots } = await arrival();
    const staged = stage(claude);
    installSession(claude, staged, roots);
    const placed = claude.destinationPath!;
    const full = fs.readFileSync(placed);
    installSession(claude, staged, roots);
    expect(fs.readFileSync(placed)).toEqual(full);
    // a round trip: the destination still holds the older copy it handed away, which the session has since grown past
    fs.writeFileSync(placed, full.subarray(0, full.indexOf('\n', full.length / 2) + 1));
    installSession(claude, staged, roots);
    expect(fs.readFileSync(placed)).toEqual(full);
  });

  it('refuses a copy the destination continued on its own, and writes nothing', async () => {
    const { claude, stage, roots } = await arrival();
    const staged = stage(claude);
    installSession(claude, staged, roots);
    const placed = claude.destinationPath!;
    fs.appendFileSync(placed, '{"type":"user","version":"2.1.280","message":{"content":"a turn taken here"}}\n');
    const meta = path.join(path.dirname(placed), CLAUDE[0].id, 'subagents', `${CLAUDE[0].agent}.meta.json`);
    fs.rmSync(meta);
    const before = fs.readFileSync(placed);
    expect(() => installSession(claude, staged, roots)).toThrow(expect.objectContaining({ code: 'destination_diverged' }));
    expect(fs.readFileSync(placed)).toEqual(before);
    expect(fs.existsSync(meta)).toBe(false);
  });

  it('refuses staged bytes that are not the ones the manifest names', async () => {
    const { codex, stage, roots } = await arrival();
    const staged = stage(codex);
    fs.appendFileSync(path.join(staged, codex.files[0].path), '\n');
    expect(() => installSession(codex, staged, roots)).toThrow(/manifest/);
    expect(fs.existsSync(codex.destinationPath!)).toBe(false);
  });

  it('refuses a manifest that names a file outside the agent home', async () => {
    const { codex, stage, roots } = await arrival();
    const staged = stage(codex);
    expect(() => installSession({ ...codex, files: [{ ...codex.files[0], path: '../../escape.jsonl' }] }, staged, roots))
      .toThrow(expect.objectContaining({ code: 'path_unsupported' }));
    expect(() => installSession({ ...codex, destinationPath: '/elsewhere/rollout.jsonl' }, staged, roots))
      .toThrow(expect.objectContaining({ code: 'path_unsupported' }));
    expect(fs.existsSync(codex.destinationPath!)).toBe(false);
  });

  it("writes nothing when a manifest names a file outside its session's own layout", async () => {
    const { claude, codex, stage, roots } = await arrival();
    const { id, slug } = CLAUDE[0];
    // a file of the manifest's choosing, staged with the bytes its entry names
    const naming = (s: TransferSession, staged: string, rel: string): TransferSession => {
      const data = Buffer.from('{"note":"not a session file"}\n');
      fs.mkdirSync(path.dirname(path.join(staged, rel)), { recursive: true });
      fs.writeFileSync(path.join(staged, rel), data);
      return { ...s, files: [...s.files, { type: 'file', path: rel, mode: 0o600, size: data.length, mtimeMs: 0, sha256: sha(data) }] };
    };
    const refused = (s: TransferSession, staged: string) => expect(() => installSession(s, staged, roots)).toThrow(expect.objectContaining({ code: 'path_unsupported' }));
    const claudeStaged = stage(claude);
    for (const rel of [
      'CLAUDE.md', 'skills/x/SKILL.md', 'settings.json', `file-history/${id}/abc@v1`, `projects/${slug}/99999999-2222-4333-8444-555555555555.jsonl`,
      `projects/${slug}/${id}/notes.md`, `projects/-elsewhere/${id}/tool-results/b1.txt`,
    ]) refused(naming(claude, claudeStaged, rel), claudeStaged);
    refused({ ...claude, destinationPath: path.join(claude.destinationHome!, 'CLAUDE.md') }, claudeStaged);
    refused({ ...claude, destinationPath: path.join(claude.destinationHome!, 'projects/-home-target-work-demo/99999999-2222-4333-8444-555555555555.jsonl') }, claudeStaged);
    const codexStaged = stage(codex);
    const another = 'sessions/2026/09/23/rollout-2026-09-23T08-44-38-99999999-2222-4333-8444-555555555555.jsonl';
    for (const rel of ['hooks.json', 'config.toml', another]) refused(naming(codex, codexStaged, rel), codexStaged);
    for (const rel of ['hooks.json', another]) refused({ ...codex, destinationPath: path.join(codex.destinationHome!, rel) }, codexStaged);
    expect(fs.existsSync(claude.destinationHome!)).toBe(false);
    expect(fs.existsSync(codex.destinationHome!)).toBe(false);
  });

  it('places the transcript last, so a retry after its write failed finishes the job', async () => {
    const { claude, stage, roots } = await arrival();
    const staged = stage(claude);
    const placed = claude.destinationPath!;
    const { id, agent } = CLAUDE[0];
    const sidecars = ['jsonl', 'meta.json'].map((ext) => path.join(path.dirname(placed), id, 'subagents', `${agent}.${ext}`));
    const full = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    const failing: InstallFs = {
      ...realInstallFs,
      stages: { open: (file, mode) => { if (file.startsWith(`${placed}.durable-`)) throw full; return realStages.open(file, mode); } },
    };
    expect(() => installSession(claude, staged, roots, failing)).toThrow(full);
    expect(sidecars.every((f) => fs.existsSync(f))).toBe(true);
    expect(fs.readdirSync(path.dirname(placed))).toEqual([id]);

    const written: string[] = [];
    const retry: InstallFs = { ...realInstallFs, stages: { rename: (from, to) => { written.push(to); fs.renameSync(from, to); } } };
    expect(installSession(claude, staged, roots, retry)).toEqual({ transcriptPath: placed });
    // the sidecars already there were the same, so only the transcript was written
    expect(written).toEqual([placed]);
    const map = sessionPathMap({ ...roots, sourceHome: claude.sourceHome!, destinationHome: claude.destinationHome! });
    for (const f of claude.files) {
      const at = path.join(claude.destinationHome!, placeFile(f.path, path.relative(claude.sourceHome!, claude.sourcePath), path.relative(claude.destinationHome!, placed)));
      expect(fs.readFileSync(at), f.path).toEqual(claudeAdapter.rewrite(f.path, fs.readFileSync(path.join(staged, f.path)), map));
    }
    expect(fs.readdirSync(path.dirname(placed)).sort()).toEqual([`${id}.jsonl`, id].sort());
  });

  it('points each imported agent at its placed transcript before anything starts', async () => {
    const { m, manifest } = await arrival();
    const placed = placeTranscripts(manifest.snapshot, manifest.sessions);
    expect(placed.characters.c1.agent!.transcriptPath).toBe(manifest.sessions[0].destinationPath);
    expect(placed.characters.c1.second!.agent!.transcriptPath).toBe(manifest.sessions[1].destinationPath);
    expect(manifest.snapshot.characters.c1.agent!.transcriptPath).toBe(m.state.characters.c1.agent!.transcriptPath);
    expect(() => placeTranscripts(manifest.snapshot, manifest.sessions.slice(1))).toThrow(/c1/);
  });
});

describe('a session under a path root declared through a link', () => {
  const SID = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
  const record = (cwd: string, text: string): string =>
    `${JSON.stringify({ type: 'user', cwd, sessionId: SID, version: '2.1.280', message: { role: 'user', content: text } })}\n`;

  /** One machine's side: its declared roots, its Claude home, and a character in `code/gamma` under its `work` root. */
  function side(root: string, work: string) {
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(work, 'gamma'), { recursive: true });
    if (work !== path.join(home, 'code')) fs.symlinkSync(work, path.join(home, 'code'));
    return { home, claude: path.join(home, '.claude'), cwd: path.join(home, 'code/gamma'), roots: { home, work: path.join(home, 'code') } };
  }

  /** Carries the one session from `from` to `to` as the handover does: the source's manifest, then the destination's placement. */
  async function carry(from: ReturnType<typeof side>, to: ReturnType<typeof side>, transcriptPath: string, ids: [MachineId, MachineId]): Promise<{ placed: string; realRoots?: Record<string, string> }> {
    const state = emptyState();
    state.characters.c1 = char('c1', { cwd: from.cwd, agent: { kind: 'claude', sessionId: SID, transcriptPath, status: 'idle', lastActivityAt: 0 } });
    const inventory = buildInventory(state, { fleet: FLEET }, {
      source: { machineId: ids[0], pathRoots: from.roots, fleetHome: path.join(from.home, '.archipelago') },
      destination: { machineId: ids[1], pathRoots: to.roots, fleetHome: path.join(to.home, '.archipelago'), agentHomes: { claude: to.claude } },
    });
    const { manifest, blockers } = await buildManifest(inventory, { generation: 1 });
    expect(blockers).toEqual([]);
    const [session] = placeSessions(manifest.sessions, importState(manifest).state);
    const staged = path.join(tmp(), 'staged');
    for (const f of session.files) fs.cpSync(path.join(session.sourceHome!, f.path), path.join(staged, f.path));
    return { placed: installSession(session, staged, manifest).transcriptPath, realRoots: manifest.sourceRealRoots };
  }

  it('lands where Claude Code looks on each machine, with every record at the real path, and comes back with every turn', async () => {
    const base = tmp();
    // the Mac declares `work` through a link to a folder elsewhere; Claude Code slugs and records the real path
    const mac = side(path.join(base, 'mac'), path.join(base, 'm3w'));
    const linux = side(path.join(base, 'linux'), path.join(base, 'linux/home/code'));
    const real = path.join(base, 'm3w/gamma');
    const original = path.join(mac.claude, 'projects', claudeProjectSlug(real), `${SID}.jsonl`);
    fs.mkdirSync(path.dirname(original), { recursive: true });
    const before = record(real, 'one') + record(real, 'two');
    fs.writeFileSync(original, before);

    const there = await carry(mac, linux, original, [MAC, TRIFT]);
    expect(there.realRoots).toEqual({ work: path.join(base, 'm3w') });
    expect(there.placed).toBe(path.join(linux.claude, 'projects', claudeProjectSlug(linux.cwd), `${SID}.jsonl`));
    expect(rows(fs.readFileSync(there.placed)).map((r) => r.cwd)).toEqual([linux.cwd, linux.cwd]);

    fs.appendFileSync(there.placed, record(linux.cwd, 'three') + record(linux.cwd, 'four'));
    const back = await carry(linux, mac, there.placed, [TRIFT, MAC]);
    // the copy the Mac kept is the start of the one that comes back, which takes its place
    expect(back.placed).toBe(original);
    const text = fs.readFileSync(original, 'utf8');
    expect(text.startsWith(before)).toBe(true);
    expect(rows(text).map((r) => [r.cwd, r.message.content])).toEqual([[real, 'one'], [real, 'two'], [real, 'three'], [real, 'four']]);
  });

  it('keeps the resume an agent closed for idleness went dormant with, flags and all, and gives one this handover rested its own', async () => {
    const base = tmp();
    const mac = side(path.join(base, 'mac'), path.join(base, 'mac/home/code'));
    const linux = side(path.join(base, 'linux'), path.join(base, 'linux/home/code'));
    const transcript = path.join(mac.claude, 'projects', claudeProjectSlug(mac.cwd), `${SID}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, record(mac.cwd, 'one'));
    const closed = `claude --dangerously-skip-permissions --effort high --resume ${SID}`;
    const imported = async (restedBy?: string) => {
      const state = emptyState();
      state.characters.c1 = char('c1', {
        cwd: mac.cwd, agent: { kind: 'claude', sessionId: SID, transcriptPath: transcript, status: 'idle', lastActivityAt: 0 }, revive: { command: closed }, restedBy,
      });
      const inventory = buildInventory(state, { fleet: FLEET }, {
        source: { machineId: MAC, pathRoots: mac.roots, fleetHome: path.join(mac.home, '.archipelago') },
        destination: { machineId: TRIFT, pathRoots: linux.roots, fleetHome: path.join(linux.home, '.archipelago'), agentHomes: { claude: linux.claude } },
      });
      const { manifest } = await buildManifest(inventory, { generation: 1 });
      return importState({ ...manifest, transactionId: 't1' }).state.characters.c1.revive;
    };
    expect(await imported()).toEqual({ command: closed });
    expect(await imported('t1')).toEqual({ command: `claude --resume ${SID}` });
  });

  it('maps a record under either spelling of a source root, onto the real spelling of the destination\'s', () => {
    const map = sessionPathMap({
      sourceRoots: { home: '/Users/s', work: '/Users/s/code' }, sourceRealRoots: { work: '/Volumes/w' },
      destinationRoots: { home: '/home/t', work: '/home/t/code' }, destinationRealRoots: { work: '/data/code' },
      sourceHome: '/Users/s/.claude', destinationHome: '/home/t/.claude',
    });
    expect(map('/Users/s/code/app')).toBe('/data/code/app');
    expect(map('/Volumes/w/app')).toBe('/data/code/app');
    expect(map('/Users/s/notes')).toBe('/home/t/notes');
  });
});

describe('agent preflight', () => {
  // setup points the hooks at the private fleet's scripts
  const { hookScript, statusScript } = resolvePaths('/home/t/.archipelago');
  const claudeSettings = JSON.stringify(mergeStatusLine(mergeHooks({}, `node ${shq(hookScript)} claude`, HOOK_EVENTS, hookScript), statusWrapper('node', statusScript), statusScript));
  const codexHooks = JSON.stringify(mergeCodexHooks({}, codexHookCommand(hookScript), hookScript));
  const missing = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  const runner = (answers: Record<string, { code?: number; stdout: string }>): AgentRun => async (cmd, args) => {
    const a = answers[[cmd, ...args].join(' ')];
    if (!a) throw missing;
    return { code: a.code ?? 0, stdout: a.stdout };
  };

  it('reads the version, login, home and hooks each CLI reports, honouring CLAUDE_CONFIG_DIR and CODEX_HOME', async () => {
    const files: Record<string, string> = { '/cfg/claude/settings.json': claudeSettings, '/cfg/codex/hooks.json': codexHooks };
    const deps = {
      run: runner({
        'claude --version': { stdout: '2.1.280 (Claude Code)\n' },
        'claude auth status': { stdout: JSON.stringify({ loggedIn: true, configDirectory: '/cfg/claude' }) },
        'codex --version': { stdout: 'codex-cli 0.156.1\n' },
        'codex login status': { stdout: 'Logged in using ChatGPT\n' },
      }),
      read: async (f: string) => files[f],
      env: { CLAUDE_CONFIG_DIR: '/cfg/claude', CODEX_HOME: '/cfg/codex' },
      homedir: '/home/t',
    };
    expect(await probeAgent('claude', deps)).toEqual({ kind: 'claude', version: '2.1.280', home: '/cfg/claude', loggedIn: true, hooks: true });
    expect(await probeAgent('codex', deps)).toEqual({ kind: 'codex', version: '0.156.1', home: '/cfg/codex', loggedIn: true, hooks: true });
  });

  it('sees a CLI that is missing, logged out or without hooks', async () => {
    const deps = {
      run: runner({
        'claude --version': { stdout: '2.1.280 (Claude Code)' },
        'claude auth status': { code: 1, stdout: JSON.stringify({ loggedIn: false }) },
      }),
      read: async () => undefined, env: {}, homedir: '/home/t',
    };
    expect(await probeAgent('claude', deps)).toEqual({ kind: 'claude', version: '2.1.280', home: '/home/t/.claude', loggedIn: false, hooks: false });
    expect(await probeAgent('codex', deps)).toEqual({ kind: 'codex', home: '/home/t/.codex', loggedIn: false, hooks: false });
  });

  it('blocks on the destination CLI, either release, login and hooks, only for the agents the fleet runs', () => {
    const ok = (kind: 'claude' | 'codex', o: Partial<AgentProbe> = {}): AgentProbe =>
      ({ kind, version: kind === 'claude' ? '2.1.280' : '0.156.1', home: `/h/.${kind}`, loggedIn: true, hooks: true, ...o });
    const codes = (source: AgentProbe[], destination: AgentProbe[], kinds: ('claude' | 'codex')[] = ['claude']) =>
      agentBlockers({ kinds, source, destination }).map((b) => b.code);
    expect(codes([ok('claude')], [ok('claude')])).toEqual([]);
    expect(codes([ok('claude')], [ok('claude', { version: '2.1.251' })])).toEqual([]);
    expect(codes([ok('claude')], [])).toEqual(['agent_cli_missing']);
    expect(codes([ok('claude')], [ok('claude', { version: undefined })])).toEqual(['agent_cli_missing']);
    expect(codes([ok('claude')], [ok('claude', { version: '2.1.281' })])).toEqual(['incompatible_adapter']);
    expect(codes([ok('claude', { version: '2.1.200' })], [ok('claude')])).toEqual(['incompatible_adapter']);
    expect(codes([ok('claude')], [ok('claude', { loggedIn: false })])).toEqual(['agent_logged_out']);
    expect(codes([ok('claude')], [ok('claude', { hooks: false })])).toEqual(['agent_hooks_missing']);
    // a fleet running no Codex does not care how Codex is on either machine
    expect(codes([ok('claude')], [ok('claude'), ok('codex', { version: '0.1.0', loggedIn: false })])).toEqual([]);
    expect(codes([ok('claude'), ok('codex')], [ok('claude'), ok('codex', { loggedIn: false })], ['claude', 'codex'])).toEqual(['agent_logged_out']);
  });
});

describe('the repair brief', () => {
  it('starts a new conversation from a summary of the old one, and says so', () => {
    const { version, id, slug } = CLAUDE[0];
    const file = path.join(FIXTURES, 'claude', version, 'projects', slug, `${id}.jsonl`);
    const before = fs.readFileSync(file);
    const brief = repairBrief('claude', before.toString(), { sessionId: id });
    expect(brief).toMatch(/^This is a new Claude Code session./);
    expect(brief).toContain(id);
    expect(brief).toContain('MARBLE-mac');
    expect(brief).not.toMatch(/resum(ed|ing) (the|this) (same )?conversation/i);
    expect(fs.readFileSync(file)).toEqual(before);
  });
});
