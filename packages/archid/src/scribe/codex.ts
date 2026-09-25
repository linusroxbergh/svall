import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runChild } from './child.js';
import type { RunScribe } from './run.js';

// the flags that keep a headless pass off the user's machine: nothing written, no session left behind,
// and none of their config, which is where their MCP servers and hooks live
const ISOLATION = ['--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config'];

// codex reports a failed turn on its event stream and leaves stderr empty; the message it wraps is the API's own
function failure(events: string): string | undefined {
  for (const line of events.trim().split('\n').reverse()) {
    let e: { type?: string; message?: string; error?: { message?: string } };
    try { e = JSON.parse(line); } catch { continue; }
    const message = e.type === 'turn.failed' ? e.error?.message : e.type === 'error' ? e.message : undefined;
    if (!message) continue;
    try { return (JSON.parse(message) as { error?: { message?: string } }).error?.message ?? message; } catch { return message; }
  }
  return undefined;
}

// `codex exec` takes one prompt and has no system prompt of its own, so the system text leads it. Without a
// model codex picks its own default. cwd is an empty folder, so no project instructions load
export function codexRunner(o: { model?: string; cwd: string; bin?: string; timeoutMs?: number }): RunScribe {
  return async (system, prompt) => {
    fs.mkdirSync(o.cwd, { recursive: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archi-scribe-'));
    const last = path.join(dir, 'last.txt');
    // without a character id the Archipelago hook exits at once, so the pass is not mistaken for a character
    const { ARCHI_CHAR_ID: _id, ...env } = process.env;
    try {
      const { code, out, err } = await runChild(
        () => spawn(o.bin ?? 'codex', ['exec', '--json', ...(o.model ? ['-m', o.model] : []), ...ISOLATION, '-o', last, '-'],
          { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }),
        { label: 'codex exec', stdin: `${system}\n\n---\n\n${prompt}`, timeoutMs: o.timeoutMs },
      );
      let answer = '';
      try { answer = fs.readFileSync(last, 'utf8'); } catch { /* a failed run writes none */ }
      // a run that recovered from an error still ends with an answer, so only one that did not is read for its cause
      const cause = code !== 0 || !answer.trim() ? failure(out) : undefined;
      if (cause) throw new Error(`codex exec failed: ${cause.slice(0, 300)}`);
      if (code !== 0) throw new Error(`codex exec exited ${code}: ${(err || out).trim().slice(0, 300)}`);
      if (!answer.trim()) throw new Error(`codex exec wrote no answer: ${(err || out).trim().slice(0, 300)}`);
      return answer;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
