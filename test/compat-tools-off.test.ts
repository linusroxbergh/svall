import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { toolsOff } from '../scripts/compat/tools-off.js';
import { AGENTS } from '../packages/svalld/src/agents.js';
import { NO_USAGE, type Call, type Runner } from '../packages/svalld/src/scribe/run.js';

// a stand-in model that does what the prompt asks with whatever access `can` gives it
const model = (can: { run?: boolean; read?: boolean }): Runner => async (_system, prompt) => {
  const listing = /`ls (\S+)`/.exec(prompt)![1];
  const secret = /contents of (\S+)\./.exec(prompt)![1];
  const said = [can.run ? fs.readdirSync(listing).join('\n') : '', can.read ? fs.readFileSync(secret, 'utf8') : ''].filter(Boolean);
  return { text: said.length ? said.join('\n') : 'NO TOOLS', usage: NO_USAGE };
};

test('reports a command that ran', async () => {
  expect(await toolsOff('claude', { run: model({ run: true }) })).toEqual(['ran a command with tools off']);
});

test('reports a file that was read', async () => {
  expect(await toolsOff('codex', { run: model({ read: true }) })).toEqual(['read a file with tools off']);
});

test('passes when the model could do neither, and leaves nothing behind', async () => {
  let dir = '';
  const run: Runner = async (system, prompt, call, signal) => { dir = path.dirname(/contents of (\S+)\./.exec(prompt)![1]); return model({})(system, prompt, call, signal); };
  expect(await toolsOff('opencode', { run })).toEqual([]);
  expect(fs.existsSync(dir)).toBe(false);
});

test('asks with the shape of a retro call: low effort and a schema', async () => {
  const calls: Call[] = [];
  await toolsOff('claude', { run: async (system, prompt, call) => { calls.push(call); return model({})(system, prompt, call); } });
  expect(calls).toEqual([{
    model: AGENTS.claude.scribeModel, effort: 'low', timeoutMs: 180_000,
    schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
  }]);
});

test('reports a runner that failed', async () => {
  expect(await toolsOff('claude', { run: async () => { throw new Error('claude -p failed: not logged in'); } }))
    .toEqual(["tools-off probe couldn't run: claude -p failed: not logged in"]);
});

test('leaves OpenCode the folder it deletes its session from once the probe is done', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-fake-opencode-'));
  const said = path.join(dir, 'delete');
  fs.writeFileSync(path.join(dir, 'opencode'), ['#!/bin/sh', 'case "$1 $2" in',
    `"run "*) cat > /dev/null; echo '${JSON.stringify({ type: 'text', part: { text: 'NO TOOLS' } })}';;`,
    `"session delete") sleep 0.3; if pwd -P > /dev/null 2>&1; then echo kept > "${said}"; else echo gone > "${said}"; fi;;`,
    'esac', ''].join('\n'), { mode: 0o755 });
  vi.stubEnv('PATH', `${dir}:${process.env.PATH}`);
  try {
    expect(await toolsOff('opencode')).toEqual([]);
    await vi.waitFor(() => expect(fs.readFileSync(said, 'utf8')).toBe('kept\n'), { timeout: 5000 });
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
