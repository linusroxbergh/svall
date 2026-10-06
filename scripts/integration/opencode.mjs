// Mocked OpenCode 2.0.22 for the integration run, run as `opencode` (argv[0]) so ps reads it as the native binary.
// It answers the CLI calls a handover makes, with `session export|import|delete --standalone` behaving as 2.0.22's do
// (an import of an id already there says so on stderr and exits 0). In a terminal, `opencode --standalone [-s <id>]`
// runs its private `serve --stdio` server in a group of its own, as the real TUI does, and posts the hook lines
// Svall's plugin would; `-s` on an id it does not hold starts an empty session with that id, as the real one does.
// Sessions are files under OpenCode's data folder, where the real one keeps opencode.db.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const VERSION = '2.0.22';
const args = process.argv.slice(2);
// ps then reads `opencode <args>`, as for the native binary, with no script path for startFlags to stop at
process.title = ['opencode', ...args].join(' ');
const data = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'mock-sessions');
const fileOf = (id) => path.join(data, `${id}.json`);
const read = (id) => { try { return JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); } catch { return undefined; } };
const write = (s) => {
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${fileOf(s.info.id)}.tmp`, JSON.stringify(s));
  fs.renameSync(`${fileOf(s.info.id)}.tmp`, fileOf(s.info.id));
};
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const fail = (text) => { process.stderr.write(`${text}\n`); process.exit(1); };
const newId = () => `ses_${crypto.randomBytes(6).toString('hex')}${crypto.randomBytes(14).toString('base64').replace(/[^0-9A-Za-z]/g, '').padEnd(14, 'a').slice(0, 14)}`;

if (args[0] === '--version' || args[0] === '-v') {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (args.includes('--help')) {
  process.stdout.write('opencode session import [file]\n\n  --standalone  run a private server\n  --directory   the directory the session belongs to\n');
  process.exit(0);
}
if (args[0] === 'auth') {
  process.stdout.write('0 credentials\n');
  process.exit(0);
}
// the private server lives as long as the TUI that holds its stdin
if (args[0] === 'serve') {
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
  for (const sig of ['SIGHUP', 'SIGTERM']) process.on(sig, () => process.exit(0));
  await new Promise(() => {});
}
// the scribe's pass: nothing to say
if (args[0] === 'run') process.exit(0);
if (args[0] === 'session') {
  const [, sub, ...rest] = args;
  const operand = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--directory').at(-1);
  if (sub === 'export') {
    const s = read(operand);
    if (!s) fail(`Session not found: ${operand}`);
    process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
    process.exit(0);
  }
  if (sub === 'delete') {
    if (!read(operand)) fail(`Session not found: ${operand}`);
    fs.rmSync(fileOf(operand));
    process.stdout.write(`Session ${operand} deleted\n`);
    process.exit(0);
  }
  if (sub === 'import') {
    const s = JSON.parse(fs.readFileSync(operand, 'utf8'));
    const directory = path.resolve(at('--directory') ?? process.cwd());
    if (!fs.existsSync(directory)) fail(`Error: no such directory ${directory}`);
    if (read(s.info.id)) { process.stderr.write('Session already exists\n'); process.exit(0); }
    write({ ...s, info: { ...s.info, location: { ...s.info.location, directory } } });
    process.stdout.write(`Imported session: ${s.info.id}\n`);
    process.exit(0);
  }
  fail(`unknown session command ${sub}`);
}

const cwd = process.cwd();
const resume = at('-s') ?? at('--session');
const sessionId = resume ?? newId();
const session = read(sessionId) ?? { info: { id: sessionId, location: { directory: cwd }, time: { created: Date.now() } }, messages: [] };
write(session);

const server = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', '--stdio'], { argv0: 'opencode', detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
server.on('error', () => {});

const charId = process.env.SVALL_CHAR_ID;
const term = process.env.SVALL_TERM === '2' ? 2 : undefined;
const home = process.env.SVALL_HOME ?? path.join(os.homedir(), '.svall');
const transcriptPath = path.join(home, 'transcripts', 'opencode', `${sessionId}.jsonl`);

function post(name, fields = {}) {
  if (!charId) return Promise.resolve();
  return new Promise((resolve) => {
    const sock = net.createConnection(path.join(home, 'hooks.sock'));
    const done = () => { clearTimeout(timer); sock.destroy(); resolve(); };
    const timer = setTimeout(done, 2000);
    sock.on('error', done);
    // the answer svalld gives SessionStart and UserPromptSubmit
    sock.on('data', done);
    const hook = { hook_event_name: name, session_id: sessionId, transcript_path: transcriptPath, cwd, ...fields };
    sock.write(`${JSON.stringify({ charId, term, backend: 'opencode', pid: process.pid, hook })}\n`);
    if (name !== 'SessionStart' && name !== 'UserPromptSubmit') sock.end(done);
  });
}
const log = (entry) => { try { fs.appendFileSync(transcriptPath, `${JSON.stringify(entry)}\n`); } catch { /* as the plugin */ } };

const end = () => { server.stdin.end(); process.exit(0); };
for (const sig of ['SIGHUP', 'SIGTERM']) process.on(sig, end);

fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
fs.appendFileSync(transcriptPath, '');
process.stdout.write(`fake opencode ${VERSION} · session ${sessionId}${resume ? ' (resumed)' : ''} · ${cwd}\n> `);
await post('SessionStart');

let prompts = 0;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const text = line.trim();
  if (!text) { process.stdout.write('> '); continue; }
  if (text === 'block') { await post('PermissionRequest', { tool_name: 'shell', message: 'fake permission prompt' }); continue; }
  const messageId = `msg_${Date.now().toString(36)}${++prompts}`;
  await post('UserPromptSubmit', { prompt: text, prompt_id: messageId });
  log({ kind: 'user', text });
  session.messages.push({ id: messageId, role: 'user', text }, { id: `${messageId}a`, role: 'assistant', text: `did: ${text}`, time: { completed: Date.now() } });
  write(session);
  log({ kind: 'agent', text: `did: ${text}` });
  process.stdout.write(`did: ${text}\n> `);
  await post('Stop');
}
end();
