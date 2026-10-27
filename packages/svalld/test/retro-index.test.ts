import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { outlineClaude } from '../src/agent/claude-outline.js';
import { outlineCodex } from '../src/agent/codex-outline.js';
import { outlineOpencode } from '../src/agent/opencode-outline.js';
import { indexSessions, SCAN_CHUNK, type IndexJob } from '../src/retro/index.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'retro');
const claude = path.join(dir, 'claude-session.jsonl');
const subagent = path.join(dir, 'claude-subagent.jsonl');
const codex = path.join(dir, 'codex-rollout.jsonl');
const exported = path.join(dir, 'opencode-export.json');
const span = { from: Date.parse('2026-10-20T00:00:00Z'), to: Date.parse('2026-10-28T00:00:00Z') };
const OPENCODE = 'ses_0123456789abAbCdEfGhIjKlMn';
const read = (file: string) => fs.readFileSync(file, 'utf8');

const temps: string[] = [];
afterEach(() => { for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const temp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-retro-index-'));
  temps.push(d);
  return d;
};

// an opencode that exports the fixture session and knows no other
const fakeOpencode = (): string => {
  const bin = path.join(temp(), 'opencode');
  fs.writeFileSync(bin, `#!/bin/sh
[ "$*" = "session export --standalone ${OPENCODE}" ] || { echo "Session not found" >&2; exit 1; }
cat ${JSON.stringify(exported)}
`, { mode: 0o755 });
  return bin;
};

const job = (o: Partial<IndexJob> = {}): IndexJob => ({
  files: [
    { agent: 'claude', session: 'claude-session', file: claude, subagents: [subagent] },
    { agent: 'codex', session: '01a1c0de-0000-7000-8000-000000000001', file: codex },
    { agent: 'opencode', session: OPENCODE, file: '', cwd: '/gone' },
  ],
  span, skills: [], onDisk: [], opencodeBin: fakeOpencode(), ...o,
});

describe('indexSessions', () => {
  it('indexes the fixtures in a worker thread', async () => {
    const j = job({ skills: ['babysit-pr', 'ship-it', 'review', 'never-run'], onDisk: [claude, codex] });
    const inline = await indexSessions(j, { inline: true });
    expect(inline.outlines).toEqual([
      outlineClaude(read(claude), claude, span, [read(subagent)]),
      outlineCodex(read(codex), codex, span),
      outlineOpencode(JSON.parse(read(exported)), span),
    ]);
    // the resumed session's turns before the span stay out, and its subagent's calls count with it
    expect(inline.outlines[0]).toMatchObject({ tools: 5, errors: 2 });
    expect(inline.outlines[0].turns.some((t) => t.text.includes('old'))).toBe(false);
    expect(inline.skillsSeen).toEqual(['babysit-pr', 'ship-it', 'review']);
    // split across workers, the result comes back in the job's order
    expect(await indexSessions(j)).toEqual(inline);
    expect(await indexSessions(j, { workers: 3 })).toEqual(inline);
  });

  it('skips a file that is gone', async () => {
    const gone = path.join(temp(), 'gone.jsonl');
    const r = await indexSessions(job({
      files: [
        { agent: 'claude', session: 'gone', file: gone },
        { agent: 'claude', session: 'claude-session', file: claude, subagents: [gone, subagent] },
        { agent: 'opencode', session: 'ses_ffffffffffffAbCdEfGhIjKlMn', file: '' },
      ],
      skills: ['ship-it'], onDisk: [gone, claude],
    }), { workers: 2 });
    expect(r.outlines).toEqual([outlineClaude(read(claude), claude, span, [read(subagent)])]);
    expect(r.skillsSeen).toEqual(['ship-it']);
  });

  it('finds which skills any transcript on disk ran, across a chunk boundary', async () => {
    const d = temp();
    // each named once, straddling the end of the first chunk the scan reads
    const straddle = (name: string, run: string) => {
      const file = path.join(d, `${name}.jsonl`);
      const cut = Math.floor(run.length / 2);
      fs.writeFileSync(file, Buffer.concat([Buffer.alloc(SCAN_CHUNK - cut - 1, 'x'), Buffer.from(`\n${run}`), Buffer.alloc(1024, 'x')]));
      return file;
    };
    const onDisk = [
      straddle('claude-skill', '{"type":"tool_use","name":"Skill","input":{"skill":"superpowers:brainstorming"}}'),
      straddle('slash', '"content":"<command-name>/work-review</command-name>"'),
      straddle('rollout-codex-read', '{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"sed -n 1,200p /Users/me/.codex/skills/publish/SKILL.md"}}'),
    ];
    // a rollout's instructions and world state list every skill's SKILL.md, and a tool's output or a message may name one
    const listed = path.join(d, 'rollout-listed.jsonl');
    fs.writeFileSync(listed, [
      { type: 'session_meta', payload: { instructions: '- handover: /Users/me/.codex/skills/handover/SKILL.md' } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ text: '/Users/me/.codex/skills/handover/SKILL.md' }] } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', output: '/Users/me/.codex/skills/handover/SKILL.md' } },
    ].map((l) => JSON.stringify(l)).join('\n'));
    const quoted = path.join(d, 'quoted.jsonl');
    // a call quoted inside another string, a name that only starts like a skill's, and a SKILL.md a Claude session
    // only reads or mentions, are no runs
    fs.writeFileSync(quoted, '{"text":"{\\"skill\\":\\"handover\\"}"}\n{"input":{"skill":"publishing"}}\n{"input":{"file_path":"/Users/me/.claude/skills/handover/SKILL.md"}}\n');
    const r = await indexSessions(job({ files: [], skills: ['handover', 'publish', 'superpowers:brainstorming', 'work-review'], onDisk: [...onDisk, quoted, listed] }));
    expect(r).toEqual({ outlines: [], skillsSeen: ['publish', 'superpowers:brainstorming', 'work-review'] });
  });
});
