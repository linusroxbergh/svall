#!/usr/bin/env node
// Installed to $ARCHI_HOME/hooks/agent-hook.mjs by `archi setup`, and run by Claude Code and by Codex,
// which names itself in the first argument; the second is the pid of the agent. Forwards a hook payload
// to archid. On SessionStart and UserPromptSubmit it waits for one reply line and prints it as
// additionalContext. Never blocks the agent: exits 0 within 1.5 s.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const charId = process.env.ARCHI_CHAR_ID;
const term = process.env.ARCHI_TERM === '2' ? 2 : undefined;
const backend = process.argv[2] === 'codex' ? 'codex' : 'claude';
const pid = Number(process.argv[3]) || undefined;
const home = process.env.ARCHI_HOME ?? path.join(os.homedir(), '.archipelago');
const done = () => process.exit(0);
if (!charId) done();
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

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let hook = {};
  try { hook = JSON.parse(input); } catch {}
  const sock = net.createConnection(path.join(home, 'hooks.sock'));
  sock.on('error', done);
  sock.on('connect', () => {
    sock.write(JSON.stringify({ charId, term, backend, pid, hook: fields(asked(hook)) }) + '\n');
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
});
