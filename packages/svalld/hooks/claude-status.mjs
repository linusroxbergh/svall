#!/usr/bin/env node
// Installed to $SVALL_HOME/hooks/claude-status.mjs by `svall setup`.
// Reports Claude's own context reading to svalld, then runs the statusline
// command it wraps (argv[2]) on the same input and passes its output through.
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const charId = process.env.SVALL_CHAR_ID;
const term = process.env.SVALL_TERM === '2' ? 2 : undefined;
const home = process.env.SVALL_HOME ?? path.join(os.homedir(), '.svall');
const inner = process.argv[2];
// the release's and Svall Dev's hooks both run for every agent, so each acts only for its own variant's homes;
// a home named like neither is a test fleet's, which Svall Dev answers
const variantOf = (h) => {
  const b = path.basename(h);
  return /^\.svall(-[a-z][a-z0-9-]*)?$/.test(b) && !/^\.svall-dev(-|$)/.test(b) ? 'release' : 'dev';
};
const mine = variantOf(path.dirname(path.dirname(fileURLToPath(import.meta.url)))) === variantOf(home);

// stdin that never closes must not hold Claude Code's statusline pipe open
const watchdog = setTimeout(() => process.exit(0), 5000);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  clearTimeout(watchdog);
  if (charId && mine) report(input);
  if (!inner) return;
  const child = spawn(inner, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
  child.on('error', () => { process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 0; });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
});

function report(text) {
  let s;
  try { s = JSON.parse(text); } catch { return; }
  const w = s?.context_window;
  if (!w || typeof w.used_percentage !== 'number') return;
  const status = {
    sessionId: typeof s.session_id === 'string' ? s.session_id : undefined,
    contextPct: w.used_percentage,
    model: typeof s.model?.id === 'string' ? s.model.id : undefined,
  };
  const sock = net.createConnection(path.join(home, 'hooks.sock'));
  // a daemon that has stopped reading must not delay the statusline: drop the socket once the line is out
  const done = () => sock.destroy();
  sock.setTimeout(1500, done);
  sock.on('error', done);
  sock.on('connect', () => sock.end(JSON.stringify({ charId, term, status }) + '\n', done));
}
