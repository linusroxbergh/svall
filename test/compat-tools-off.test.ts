import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { toolsOff } from '../scripts/compat/tools-off.js';
import { NO_USAGE, type Runner } from '../packages/svalld/src/scribe/run.js';

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

test('reports a runner that failed', async () => {
  expect(await toolsOff('claude', { run: async () => { throw new Error('claude -p failed: not logged in'); } }))
    .toEqual(["tools-off probe couldn't run: claude -p failed: not logged in"]);
});
