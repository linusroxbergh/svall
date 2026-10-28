import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jsonLines } from '../agent/jsonl.js';
import { runChild, stderrCause } from './child.js';
import type { Runner, Usage } from './run.js';

// the flags that keep a headless pass off the user's machine: nothing written, no session left behind,
// and none of their config, which is where their MCP servers and hooks live
const ISOLATION = ['--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config'];
// a retro call turns off the shell, web search and the other tool features codex has on by default
const TOOLS_OFF = ['-c', 'features.shell_tool=false', '-c', 'web_search="disabled"',
  ...['multi_agent', 'apps', 'view_image', 'image_generation', 'plugins', 'browser_use', 'computer_use'].flatMap((f) => ['--disable', f])];

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

type TurnUsage = { input_tokens?: number; cached_input_tokens?: number; cache_write_input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number };

// what each turn reported spending; codex counts its cached input inside input_tokens
function usage(events: string): Usage {
  const turns = jsonLines<{ type?: string; usage?: TurnUsage }>(events).filter((e) => e.type === 'turn.completed' && e.usage).map((e) => e.usage!);
  const sum = (k: keyof TurnUsage) => turns.reduce((n, u) => n + (u[k] ?? 0), 0);
  return {
    input: Math.max(0, sum('input_tokens') - sum('cached_input_tokens')), output: sum('output_tokens'),
    cacheRead: sum('cached_input_tokens'), cacheWrite: sum('cache_write_input_tokens'), reasoning: sum('reasoning_output_tokens'),
  };
}

// `codex exec` has no system prompt, so the system text leads its one prompt; cwd is an empty folder, so no project
// instructions load
export function codexRunner(o: { cwd: string; bin?: string; retro?: true }): Runner {
  return async (system, prompt, call, signal) => {
    fs.mkdirSync(o.cwd, { recursive: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-scribe-'));
    const last = path.join(dir, 'last.txt');
    const schema = path.join(dir, 'schema.json');
    // without a robot id the Svall hook exits at once, so the pass is not mistaken for a robot
    const { SVALL_ROBOT_ID: _id, SVALL_CHAR_ID: _old, ...env } = process.env;
    const args = [
      'exec', '--json', ...(call.model ? ['-m', call.model] : []), ...(call.effort ? ['-c', `model_reasoning_effort="${call.effort}"`] : []),
      ...(o.retro ? TOOLS_OFF : []), ...ISOLATION, ...(call.schema ? ['--output-schema', schema] : []), '-o', last, '-',
    ];
    try {
      if (call.schema) fs.writeFileSync(schema, JSON.stringify(call.schema));
      const { code, out, err } = await runChild(
        () => spawn(o.bin ?? 'codex', args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }),
        { label: 'codex exec', stdin: `${system}\n\n---\n\n${prompt}`, timeoutMs: call.timeoutMs, signal },
      );
      let answer = '';
      try { answer = fs.readFileSync(last, 'utf8'); } catch { /* a failed run writes none */ }
      // a run that recovered from an error still ends with an answer, so only one that did not is read for its cause
      const cause = code !== 0 || !answer.trim() ? failure(out) : undefined;
      if (cause) throw new Error(`codex exec failed: ${cause.slice(0, 300)}`);
      if (code !== 0) throw new Error(`codex exec exited ${code}`, stderrCause(err));
      if (!answer.trim()) throw new Error('codex exec wrote no answer', stderrCause(err));
      return { text: answer, usage: usage(out) };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
