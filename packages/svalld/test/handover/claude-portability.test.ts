import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/handover/claude');
const PROBE = path.resolve(import.meta.dirname, '../../../../scripts/spikes/probe-claude-handover.mjs');
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const SOURCE_CWD = '/Users/source/work/demo';
const DESTINATION_CWD = '/home/target/work/demo';
const SOURCE_SLUG = '-Users-source-work-demo';
const DESTINATION_SLUG = '-home-target-work-demo';

let tempDir: string | undefined;
afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function seed() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-claude-portability-'));
  const sourceConfig = path.join(tempDir, 'source', '.claude');
  const destinationConfig = path.join(tempDir, 'destination', '.claude');
  const project = path.join(sourceConfig, 'projects', SOURCE_SLUG);
  const sidecars = path.join(project, SESSION_ID, 'subagents');
  fs.mkdirSync(sidecars, { recursive: true });
  const transcript = path.join(project, `${SESSION_ID}.jsonl`);
  fs.copyFileSync(path.join(FIXTURE, 'session.jsonl'), transcript);
  fs.copyFileSync(path.join(FIXTURE, 'subagent.jsonl'), path.join(sidecars, 'agent-synthetic.jsonl'));
  fs.copyFileSync(path.join(FIXTURE, 'subagent.meta.json'), path.join(sidecars, 'agent-synthetic.meta.json'));
  fs.copyFileSync(path.join(FIXTURE, 'sessions-index.json'), path.join(project, 'sessions-index.json'));
  const history = path.join(sourceConfig, 'file-history', SESSION_ID);
  fs.mkdirSync(history, { recursive: true });
  fs.writeFileSync(path.join(history, 'synthetic@v2'), 'synthetic snapshot');
  const env = path.join(sourceConfig, 'session-env', SESSION_ID);
  fs.mkdirSync(env, { recursive: true });
  fs.writeFileSync(path.join(env, 'secret'), 'DO_NOT_COPY');
  fs.writeFileSync(path.join(sourceConfig, '.credentials.json'), 'DO_NOT_COPY');
  return { transcript, destinationConfig };
}

function run(transcript: string, destinationConfig: string) {
  return JSON.parse(execFileSync(process.execPath, [PROBE, transcript, SOURCE_CWD,
    DESTINATION_CWD, destinationConfig], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as {
      sessionId: string; destinationTranscript: string; files: string[];
    };
}

function staleMetadataPaths(value: unknown, field = ''): string[] {
  if (typeof value === 'string') return value.startsWith('/Users/source/') ? [field] : [];
  if (Array.isArray(value)) return value.flatMap((item) => staleMetadataPaths(item, field));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) =>
    ['message', 'toolUseResult', 'wireToolInputs', 'content', 'rendered'].includes(key)
      ? [] : staleMetadataPaths(item, field ? `${field}.${key}` : key));
}

describe('Claude Code session portability probe', () => {
  it('discovers a hook transcript and copies only its session graph into a different home/project slug', () => {
    const { transcript, destinationConfig } = seed();
    const result = run(transcript, destinationConfig);
    const destinationProject = path.join(destinationConfig, 'projects', DESTINATION_SLUG);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.destinationTranscript).toBe(path.join(destinationProject, `${SESSION_ID}.jsonl`));
    expect(result.files).toContain(path.join(destinationProject, SESSION_ID, 'subagents', 'agent-synthetic.jsonl'));
    expect(fs.readFileSync(path.join(destinationConfig, 'file-history', SESSION_ID, 'synthetic@v2'), 'utf8'))
      .toBe('synthetic snapshot');
    expect(fs.existsSync(path.join(destinationConfig, 'session-env'))).toBe(false);
    expect(fs.existsSync(path.join(destinationConfig, '.credentials.json'))).toBe(false);

    const rows = fs.readFileSync(result.destinationTranscript, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows.filter((row) => row.cwd).map((row) => row.cwd)).toEqual([
      DESTINATION_CWD, DESTINATION_CWD, DESTINATION_CWD,
    ]);
    expect(rows[2].attachment.snapshot.workingDirectory).toBe(DESTINATION_CWD);
    expect(rows[2].attachment.files[0].path).toBe(`${DESTINATION_CWD}/notes.txt`);
    expect(rows[3].worktreeSession.worktreePath).toBe(`${DESTINATION_CWD}/.worktree`);
    expect(rows.flatMap((row) => staleMetadataPaths(row))).toEqual([]);
    // Past conversation and tool arguments are evidence, not live metadata. Do not rewrite their text.
    expect(rows[0].message.content).toContain(SOURCE_CWD);
    expect(rows[1].message.content[0].input.file_path).toContain(SOURCE_CWD);
    const subagent = fs.readFileSync(path.join(destinationProject, SESSION_ID, 'subagents',
      'agent-synthetic.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(subagent.map((row) => row.cwd)).toEqual([DESTINATION_CWD, DESTINATION_CWD]);
    expect(subagent.flatMap((row) => staleMetadataPaths(row))).toEqual([]);
    const index = JSON.parse(fs.readFileSync(path.join(destinationProject, 'sessions-index.json'), 'utf8'));
    expect(index.entries).toHaveLength(1);
    expect(index.originalPath).toBe(DESTINATION_CWD);
    expect(index.entries[0].fullPath).toBe(result.destinationTranscript);
    expect(index.entries[0].projectPath).toBe(DESTINATION_CWD);
    expect(staleMetadataPaths(index)).toEqual([]);
  });

  it('refuses a second copy instead of overwriting a destination session', () => {
    const { transcript, destinationConfig } = seed();
    run(transcript, destinationConfig);
    expect(() => run(transcript, destinationConfig)).toThrow(/already exists/);
  });

  it('rejects paths that are not UUID-named transcripts under projects', () => {
    const { destinationConfig } = seed();
    expect(() => run(path.join(FIXTURE, 'session.jsonl'), destinationConfig))
      .toThrow(/UUID-named Claude transcript/);
  });

  it('refuses a transcript that is a symlink', () => {
    const { transcript, destinationConfig } = seed();
    const link = path.join(path.dirname(transcript), '99999999-2222-4333-8444-555555555555.jsonl');
    fs.symlinkSync(transcript, link);
    expect(() => run(link, destinationConfig)).toThrow(/Refusing session symlink/);
  });
});
