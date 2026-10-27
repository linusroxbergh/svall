// Mocked Claude Code for the integration run: answers the CLI probes a move makes, and in a terminal runs as an
// agent that posts Svall's hook events (with its own pid) and, after each turn, the context reading its statusLine
// would send (the transcript's record count as a percentage) to $SVALL_HOME/hooks.sock, and keeps a transcript where
// Claude Code 2.1.x keeps one (<config>/projects/<slug of the real cwd>/<session>.jsonl). `--resume <id>` finds that
// transcript under the real cwd's slug, or else the newest of that id in another project folder, and appends to it, as
// the real CLI does after its folder moved; it fails the way the real one does when there is none. As the real one,
// its SessionStart names the cwd's slug either way.
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
// print mode and the usage control request (scribe, usage.get): answer get_usage, a scribe pass with a note naming this
// machine, anything else quietly
if (args.includes('-p') || args.includes('--print') || args.includes('--input-format') || !process.stdin.isTTY) {
  if (args.includes('--input-format')) {
    for await (const line of readline.createInterface({ input: process.stdin })) {
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg?.request?.subtype !== 'get_usage') continue;
      process.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { subscription_type: 'max', rate_limits_available: false } } })}\n`);
    }
  } else if (args.includes('--output-format') && args[args.indexOf('--output-format') + 1] === 'json') {
    await new Promise((resolve) => { process.stdin.on('end', resolve).resume(); });
    process.stdout.write(`${JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify({ note: `noted on ${os.hostname()}` }) })}\n`);
  }
  process.exit(0);
}

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const resume = at('--resume') ?? at('-r');
const sessionId = resume ?? crypto.randomUUID();
const cwd = process.cwd();
const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
const named = path.join(configDir, 'projects', slug, `${sessionId}.jsonl`);
const elsewhere = () => {
  const projects = path.join(configDir, 'projects');
  const found = (fs.existsSync(projects) ? fs.readdirSync(projects) : []).map((d) => path.join(projects, d, `${sessionId}.jsonl`)).filter((p) => fs.existsSync(p));
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
};
const transcriptPath = resume && !fs.existsSync(named) ? elsewhere() ?? named : named;

if (resume && !fs.existsSync(transcriptPath)) {
  process.stdout.write(`No conversation found with session ID: ${resume}\n`);
  process.exit(1);
}

const robotId = process.env.SVALL_ROBOT_ID;
const term = process.env.SVALL_TERM === '2' ? 2 : undefined;
const home = process.env.SVALL_HOME;

function send(line) {
  if (!home || !robotId) return Promise.resolve();
  return new Promise((resolve) => {
    const sock = net.createConnection(path.join(home, 'hooks.sock'));
    const done = () => { clearTimeout(timer); sock.destroy(); resolve(); };
    const timer = setTimeout(done, 2000);
    sock.on('error', done);
    sock.on('connect', () => sock.end(`${JSON.stringify(line)}\n`, done));
  });
}
const post = (hook) => send({ robotId, term, pid: process.pid, hook: { session_id: sessionId, transcript_path: transcriptPath, cwd, ...hook } });

let last = null;
let records = fs.existsSync(transcriptPath) ? fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean).length : 0;
const append = (entry) => {
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true, mode: 0o700 });
  const uuid = crypto.randomUUID();
  const rec = { parentUuid: last, isSidechain: false, userType: 'external', cwd, sessionId, version: VERSION, ...entry, uuid, timestamp: new Date().toISOString() };
  last = uuid;
  fs.appendFileSync(transcriptPath, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
  records += 1;
};

let ending = false;
const end = async () => {
  if (ending) return;
  ending = true;
  await post({ hook_event_name: 'SessionEnd', reason: 'other' });
  process.exit(0);
};
for (const sig of ['SIGHUP', 'SIGTERM']) process.on(sig, () => { void end(); });

// Claude Code's prompt line, which svalld reads as clear before it types a prompt
const PROMPT = '❯\u00a0';
process.stdout.write(`fake claude ${VERSION} · session ${sessionId}${resume ? ' (resumed)' : ''} · ${cwd}\n${PROMPT}`);
await post({ hook_event_name: 'SessionStart', source: resume ? 'resume' : 'startup', transcript_path: named });

let prompts = 0;
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const text = line.trim();
  if (!text) { process.stdout.write(PROMPT); continue; }
  if (text === 'block') { await post({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'fake permission prompt' }); continue; }
  const promptId = `p_${Date.now().toString(36)}_${++prompts}`;
  await post({ hook_event_name: 'UserPromptSubmit', prompt: text, prompt_id: promptId });
  append({ type: 'user', promptId, message: { role: 'user', content: text } });
  append({ type: 'assistant', message: { model: 'fake-model', role: 'assistant', content: [{ type: 'text', text: `did: ${text}` }], usage: { input_tokens: 1000, output_tokens: 10 } } });
  process.stdout.write(`did: ${text}\n${PROMPT}`);
  await send({ robotId, term, status: { contextPct: Math.min(records, 100), sessionId, model: 'fake-model' } });
  await post({ hook_event_name: 'Stop' });
}
await end();
