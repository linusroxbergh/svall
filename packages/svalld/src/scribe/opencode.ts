import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { jsonLines } from '../agent/jsonl.js';
import { runChild, stderrCause } from './child.js';
import type { RunScribe } from './run.js';

type Line = { type?: string; sessionID?: string; part?: { text?: string }; error?: { name?: string; data?: { message?: string } } };

// `opencode run` takes one prompt on stdin and has no system prompt of its own, so the system text leads it. --pure
// keeps plugins, Svall's among them, out of the pass, and no tool may run on what a transcript says
export function opencodeRunner(o: { model?: string; cwd: string; bin?: string; timeoutMs?: number }): RunScribe {
  return async (system, prompt) => {
    fs.mkdirSync(o.cwd, { recursive: true });
    const bin = o.bin ?? 'opencode';
    const { SVALL_CHAR_ID: _id, ...rest } = process.env;
    const env = { ...rest, OPENCODE_PERMISSION: '"deny"' };
    const { code, out, err } = await runChild(
      () => spawn(bin, ['run', '--format', 'json', '--pure', ...(o.model ? ['-m', o.model] : [])], { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }),
      { label: 'opencode run', stdin: `${system}\n\n---\n\n${prompt}`, timeoutMs: o.timeoutMs },
    );
    const lines = jsonLines<Line>(out);
    // every run is kept as a session, which would crowd the user's own list
    const session = lines.find((l) => l.sessionID)?.sessionID;
    if (session) execFile(bin, ['session', 'delete', session], { cwd: o.cwd, env }, () => {});
    const answer = lines.filter((l) => l.type === 'text').at(-1)?.part?.text ?? '';
    const error = lines.filter((l) => l.type === 'error').at(-1)?.error;
    const cause = !answer.trim() && error ? error.data?.message ?? error.name : undefined;
    if (cause) throw new Error(`opencode run failed: ${cause.slice(0, 300)}`);
    if (code !== 0) throw new Error(`opencode run exited ${code}`, stderrCause(err));
    if (!answer.trim()) throw new Error('opencode run wrote no answer', stderrCause(err));
    return answer;
  };
}
