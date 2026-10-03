#!/usr/bin/env node
// Test double for `claude`: posts the hook events svalld reacts to and writes a JSONL transcript.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';

const charId = process.env.SVALL_CHAR_ID;
const term = process.env.SVALL_TERM === '2' ? 2 : undefined;
const home = process.env.SVALL_HOME;
const sessionId = '0c6a3f0e-8b1d-4f2a-9e7c-1a2b3c4d5e6f';
const transcriptPath = path.join(home, 'transcripts', `${charId}.jsonl`);
fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });

function post(hook) {
  return new Promise((resolve) => {
    const sock = net.createConnection(path.join(home, 'hooks.sock'));
    sock.on('error', resolve);
    sock.on('connect', () => sock.end(JSON.stringify({ charId, term, hook: { session_id: sessionId, transcript_path: transcriptPath, ...hook } }) + '\n', resolve));
  });
}

const append = (entry) => fs.appendFileSync(transcriptPath, JSON.stringify(entry) + '\n');

await post({ hook_event_name: 'SessionStart' });
let prompts = 0;
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (line === 'block') { await post({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }); continue; }
  const promptId = `p_${++prompts}`;
  await post({ hook_event_name: 'UserPromptSubmit', prompt: line, prompt_id: promptId });
  append({ type: 'user', origin: { kind: 'human' }, promptId, message: { content: line } });
  append({
    type: 'assistant',
    message: { model: 'fake-model', content: [{ type: 'text', text: `did: ${line}` }], usage: { input_tokens: 1000 } },
  });
  await post({ hook_event_name: 'Stop' });
}
await post({ hook_event_name: 'SessionEnd' });
process.exit(0);
