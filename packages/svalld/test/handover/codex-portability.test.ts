import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/handover/codex');
const PROBE = path.resolve(import.meta.dirname, '../../../../scripts/spikes/probe-codex-handover.mjs');
const SESSION_ID = '01a0aaaa-bbbb-7ccc-8ddd-eeeeffff0000';
const ROLLOUT = `rollout-2026-09-21T19-28-46-${SESSION_ID}.jsonl`;
const DATE_DIR = path.join('sessions', '2026', '09', '21');
const SOURCE_CWD = '/Users/source/work/demo';
const DESTINATION_CWD = '/home/target/work/demo';

let tempDir: string | undefined;
afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function seed({ index = true } = {}) {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-codex-portability-'));
  const sourceHome = path.join(tempDir, 'Users', 'source', '.codex');
  const destinationHome = path.join(tempDir, 'home', 'target', '.codex');
  fs.mkdirSync(path.join(sourceHome, DATE_DIR), { recursive: true });
  const rollout = path.join(sourceHome, DATE_DIR, ROLLOUT);
  fs.copyFileSync(path.join(FIXTURE, 'rollout.jsonl'), rollout);
  if (index) fs.copyFileSync(path.join(FIXTURE, 'session_index.jsonl'), path.join(sourceHome, 'session_index.jsonl'));
  for (const name of ['auth.json', 'config.toml', 'history.jsonl', 'state_5.sqlite']) {
    fs.writeFileSync(path.join(sourceHome, name), 'DO_NOT_COPY');
  }
  return { rollout, sourceHome, destinationHome };
}

function run(rollout: string, destinationHome: string) {
  return JSON.parse(execFileSync(process.execPath, [PROBE, rollout, SOURCE_CWD,
    DESTINATION_CWD, destinationHome], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as {
      sessionId: string; destinationRollout: string; files: string[];
    };
}

// Prose, tool arguments and tool output record what happened on the source machine; a path typed as
// its own field is live metadata. Only the second kind may move.
const EVIDENCE = ['content', 'text', 'input', 'arguments', 'output', 'stdout', 'stderr',
  'aggregated_output', 'formatted_output', 'parsed_cmd', 'last_agent_message', 'message', 'body',
  'filesystem', 'base_instructions', 'instructions', 'approved_command_prefixes'];

function staleMetadataPaths(value: unknown, field = ''): string[] {
  if (typeof value === 'string') return value.startsWith('/Users/source/') ? [field] : [];
  if (Array.isArray(value)) return value.flatMap((item) => staleMetadataPaths(item, field));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) =>
    EVIDENCE.includes(key) ? [] : staleMetadataPaths(item, field ? `${field}.${key}` : key));
}

const readRows = (file: string) =>
  fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

describe('Codex session portability probe', () => {
  it('copies a hook-reported rollout into another CODEX_HOME and remaps its live paths', () => {
    const { rollout, destinationHome } = seed();
    const result = run(rollout, destinationHome);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.destinationRollout).toBe(path.join(destinationHome, DATE_DIR, ROLLOUT));

    const rows = readRows(result.destinationRollout);
    expect(rows[0].payload.cwd).toBe(DESTINATION_CWD);
    expect(rows[0].payload.runtime_workspace_roots).toEqual([DESTINATION_CWD]);
    expect(rows[1].payload.state.environments.environments.local.cwd).toBe(DESTINATION_CWD);
    expect(rows[2].payload.cwd).toBe(DESTINATION_CWD);
    expect(rows[2].payload.workspace_roots).toEqual([DESTINATION_CWD]);
    expect(rows[2].payload.permission_profile.file_system.entries[0].path.path).toBe(DESTINATION_CWD);
    expect(rows[2].payload.file_system_sandbox_policy.entries[0].path.path).toBe(DESTINATION_CWD);
    expect(rows[5].payload.item.cwd).toBe(`file://${DESTINATION_CWD}`);
    expect(rows.flatMap((row) => staleMetadataPaths(row))).toEqual([]);

    // What was said and what a command printed is evidence of the source machine. Keep it verbatim.
    expect(rows[3].payload.content[0].text).toContain(SOURCE_CWD);
    expect(rows[4].payload.input).toContain(SOURCE_CWD);
    expect(rows[5].payload.item.stdout).toContain(SOURCE_CWD);
    expect(rows[5].payload.item.parsed_cmd[0].cmd).toContain(SOURCE_CWD);
    expect(rows[6].payload.output[0].text).toContain(SOURCE_CWD);
    expect(rows[7].payload.last_agent_message).toContain(SOURCE_CWD);
    expect(rows[1].payload.state.environments.filesystem).toContain(SOURCE_CWD);
    expect(rows[1].payload.state.permissions.approved_command_prefixes[1][1]).toContain(SOURCE_CWD);
  });

  it('carries only this session across, and no credentials, config or cross-session history', () => {
    const { rollout, destinationHome } = seed();
    const result = run(rollout, destinationHome);
    expect(fs.readdirSync(destinationHome).sort()).toEqual(['session_index.jsonl', 'sessions']);
    const index = readRows(path.join(destinationHome, 'session_index.jsonl'));
    expect(index).toEqual([{ id: SESSION_ID, thread_name: 'Synthetic handover probe',
      updated_at: '2026-09-21T17:28:55.451Z' }]);
    expect(result.files).toEqual([result.destinationRollout, path.join(destinationHome, 'session_index.jsonl')]);
  });

  it('copies the rollout alone when the source home keeps no session index', () => {
    const { rollout, destinationHome } = seed({ index: false });
    const result = run(rollout, destinationHome);
    expect(result.files).toEqual([result.destinationRollout]);
    expect(fs.readdirSync(destinationHome)).toEqual(['sessions']);
  });

  it('refuses a second copy instead of overwriting a destination session', () => {
    const { rollout, destinationHome } = seed();
    run(rollout, destinationHome);
    expect(() => run(rollout, destinationHome)).toThrow(/already exists/);
  });

  it('rejects a file that is not a dated rollout under a Codex sessions directory', () => {
    const { sourceHome, destinationHome } = seed();
    expect(() => run(path.join(FIXTURE, 'rollout.jsonl'), destinationHome))
      .toThrow(/rollout-<timestamp>-<uuid>\.jsonl/);
    const loose = path.join(sourceHome, ROLLOUT);
    fs.copyFileSync(path.join(FIXTURE, 'rollout.jsonl'), loose);
    expect(() => run(loose, destinationHome)).toThrow(/sessions\/<yyyy>\/<mm>\/<dd>/);
  });

  it('rejects a rollout whose session_meta does not match its filename', () => {
    const { rollout, destinationHome } = seed();
    const rows = readRows(rollout);
    rows[0].payload.session_id = '01a0aaaa-bbbb-7ccc-8ddd-999988887777';
    rows[0].payload.id = rows[0].payload.session_id;
    fs.writeFileSync(rollout, rows.map((row) => JSON.stringify(row)).join('\n'));
    expect(() => run(rollout, destinationHome)).toThrow(/session_meta/);
  });

  it('rejects a rollout that does not open with session_meta', () => {
    const { rollout, destinationHome } = seed();
    fs.writeFileSync(rollout, readRows(rollout).slice(1).map((row) => JSON.stringify(row)).join('\n'));
    expect(() => run(rollout, destinationHome)).toThrow(/session_meta/);
  });
});
