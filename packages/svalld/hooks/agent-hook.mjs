#!/usr/bin/env node
// Installed to $SVALL_HOME/hooks/agent-hook.mjs by `svall setup`, and run by Claude Code and by Codex,
// which names itself in the first argument; the second is the pid of the agent. Forwards a hook payload
// to svalld. On SessionStart and UserPromptSubmit it waits for one reply line and prints it as
// additionalContext. Never blocks the agent: exits 0 within 1.5 s of its last try at the socket.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const charId = process.env.SVALL_CHAR_ID;
const term = process.env.SVALL_TERM === '2' ? 2 : undefined;
const backend = process.argv[2] === 'codex' ? 'codex' : 'claude';
const pid = Number(process.argv[3]) || undefined;
const home = process.env.SVALL_HOME ?? path.join(os.homedir(), '.svall');
const done = () => process.exit(0);
// the release's and Svall Dev's hooks both run for every agent, so each acts only for its own variant's homes;
// a home named like neither is a test fleet's, which Svall Dev answers
const variantOf = (h) => {
  const b = path.basename(h);
  return /^\.svall(-[a-z][a-z0-9-]*)?$/.test(b) && !/^\.svall-dev(-|$)/.test(b) ? 'release' : 'dev';
};
const mine = variantOf(path.dirname(path.dirname(fileURLToPath(import.meta.url)))) === variantOf(home);
if (!charId || !mine) done();
const safety = setTimeout(done, 1500);
safety.unref();

const WAITS = new Set(['SessionStart', 'UserPromptSubmit']);

// only what the daemon reads: a whole payload carries tool_input, which can run past the receiver's line limit
const KEEP = ['hook_event_name', 'agent_id', 'session_id', 'transcript_path', 'notification_type', 'message', 'background_tasks', 'cwd', 'model', 'prompt', 'prompt_id', 'turn_id'];
// a pasted prompt runs to megabytes; only its head is ever shown, and the whole line must stay under the limit
const clip = (k, v) => (k === 'prompt' && typeof v === 'string' ? v.slice(0, 4000) : v);
const fields = (h) => Object.fromEntries(KEEP.filter((k) => h[k] !== undefined).map((k) => [k, clip(k, h[k])]));
// codex says what it asks permission for inside tool_input, which is otherwise left behind
const asked = (h) => {
  if (h.hook_event_name !== 'PermissionRequest' || h.message) return h;
  const why = h.tool_input?.description ?? h.tool_input?.command ?? h.tool_name;
  const text = Array.isArray(why) ? why.join(' ') : why;
  return typeof text === 'string' && text ? { ...h, message: text.slice(0, 500) } : h;
};
// Claude Code's StopFailure names the API error that ended the turn, and carries the text it showed for it
const failed = (h) => {
  if (h.hook_event_name !== 'StopFailure' || h.message) return h;
  const text = h.last_assistant_message || h.error;
  return typeof text === 'string' && text ? { ...h, message: text.slice(0, 500) } : h;
};

// a daemon restarting has no socket for a second or two, so a refused connect is tried again, for up to 2 s.
// A tool call is not: the next one says the same, and a daemon that stays down would hold up every tool.
// Nor is any event within a minute of one giving up, so a daemon that stays down holds up one hook a minute
const RETRIES = 8;
const RETRY_MS = 250;
const ONCE = new Set(['PreToolUse', 'PostToolUse']);
const DOWN = path.join(home, 'hooks.down');
const gaveUpLately = () => { try { return Date.now() - fs.statSync(DOWN).mtimeMs < 60_000; } catch { return false; } };

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let hook = {};
  try { hook = JSON.parse(input); } catch {}
  send(hook, 0);
});

function send(hook, tries) {
  const sock = net.createConnection(path.join(home, 'hooks.sock'));
  sock.on('error', (e) => {
    if (tries >= RETRIES) { try { fs.writeFileSync(DOWN, ''); } catch {} }
    if (tries >= RETRIES || ONCE.has(hook.hook_event_name) || (e.code !== 'ENOENT' && e.code !== 'ECONNREFUSED') || gaveUpLately()) done();
    else { safety.refresh(); setTimeout(() => send(hook, tries + 1), RETRY_MS); }
  });
  sock.on('connect', () => {
    sock.write(JSON.stringify({ charId, term, backend, pid, hook: fields(failed(asked(hook))) }) + '\n');
    // the exit waits for the write to drain, or a large payload is truncated mid-line and dropped
    if (!WAITS.has(hook.hook_event_name)) { sock.end(done); return; }
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      // the reply is in hand: stop racing the safety timer against a large write
      clearTimeout(safety);
      sock.end();
      try {
        const { additionalContext } = JSON.parse(buf.slice(0, nl));
        // a synchronous write guarantees the whole reply lands before exit, unlike a pipe write racing process.exit
        if (additionalContext) fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: hook.hook_event_name, additionalContext } }));
      } catch {}
      done();
    });
    sock.on('end', done);
  });
}
