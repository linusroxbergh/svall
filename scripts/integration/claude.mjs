// Mocked Claude Code for the integration run: answers the CLI probes a handover makes, and in a terminal runs as an
// agent that posts Svall's hook events (with its own pid) to $SVALL_HOME/hooks.sock and keeps a transcript where
// Claude Code 2.1.x keeps one (<config>/projects/<slug of the real cwd>/<session>.jsonl). `--resume <id>` finds that
// transcript under the real cwd's slug, as the real CLI does, and fails the way it does when it is not there.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const VERSION = '2.1.260';
const args = process.argv.slice(2);

if (args[0] === '--version' || args[0] === '-v') {
  process.stdout.write(`${VERSION} (Claude Code)\n`);
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })}\n`);
  process.exit(0);
}
// print mode and the usage control request (scribe, usage.get): answer get_usage, anything else quietly
if (args.includes('-p') || args.includes('--print') || args.includes('--input-format') || !process.stdin.isTTY) {
  if (args.includes('--input-format')) {
    for await (const line of readline.createInterface({ input: process.stdin })) {
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg?.request?.subtype !== 'get_usage') continue;
      process.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { subscription_type: 'max', rate_limits_available: false } } })}\n`);
    }
  }
  process.exit(0);
}

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const resume = at('--resume') ?? at('-r');
const sessionId = resume ?? crypto.randomUUID();
const cwd = process.cwd();
const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
const transcriptPath = path.join(configDir, 'projects', slug, `${sessionId}.jsonl`);

if (resume && !fs.existsSync(transcriptPath)) {
  process.stdout.write(`No conversation found with session ID: ${resume}\n`);
  process.exit(1);
}

const charId = process.env.SVALL_CHAR_ID;
const term = process.env.SVALL_TERM === '2' ? 2 : undefined;
const home = process.env.SVALL_HOME;

function post(hook) {
  if (!home || !charId) return Promise.resolve();
  return new Promise((resolve) => {
    const sock = net.createConnection(path.join(home, 'hooks.sock'));
    const done = () => { clearTimeout(timer); sock.destroy(); resolve(); };
    const timer = setTimeout(done, 2000);
    sock.on('error', done);
    sock.on('connect', () => sock.end(`${JSON.stringify({ charId, term, pid: process.pid, hook: { session_id: sessionId, transcript_path: transcriptPath, cwd, ...hook } })}\n`, done));
  });
}

let last = null;
const append = (entry) => {
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true, mode: 0o700 });
  const uuid = crypto.randomUUID();
  const rec = { parentUuid: last, isSidechain: false, userType: 'external', cwd, sessionId, version: VERSION, ...entry, uuid, timestamp: new Date().toISOString() };
  last = uuid;
  fs.appendFileSync(transcriptPath, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
};

let ending = false;
const end = async () => {
  if (ending) return;
  ending = true;
  await post({ hook_event_name: 'SessionEnd', reason: 'other' });
  process.exit(0);
};
for (const sig of ['SIGHUP', 'SIGTERM']) process.on(sig, () => { void end(); });

process.stdout.write(`fake claude ${VERSION} · session ${sessionId}${resume ? ' (resumed)' : ''} · ${cwd}\n> `);
await post({ hook_event_name: 'SessionStart', source: resume ? 'resume' : 'startup' });

let prompts = 0;
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const text = line.trim();
  if (!text) { process.stdout.write('> '); continue; }
  if (text === 'block') { await post({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'fake permission prompt' }); continue; }
  const promptId = `p_${Date.now().toString(36)}_${++prompts}`;
  await post({ hook_event_name: 'UserPromptSubmit', prompt: text, prompt_id: promptId });
  append({ type: 'user', promptId, message: { role: 'user', content: text } });
  append({ type: 'assistant', message: { model: 'fake-model', role: 'assistant', content: [{ type: 'text', text: `did: ${text}` }], usage: { input_tokens: 1000, output_tokens: 10 } } });
  process.stdout.write(`did: ${text}\n> `);
  await post({ hook_event_name: 'Stop' });
}
await end();
