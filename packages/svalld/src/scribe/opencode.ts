import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { jsonLines } from '../agent/jsonl.js';
import { runChild, stderrCause } from './child.js';
import { NO_USAGE, type Runner, type Usage } from './run.js';

type Line = { type?: string; sessionID?: string; part?: { text?: string }; error?: { type?: string; message?: string } };
type Spent = { type?: string; cost?: number; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } };

// no tool may run on what a transcript says: this agent's ask comes after any rule the user's config sets, and `opencode
// run` turns every ask down. Tools denied outright would leave the request, which Zen's free models refuse. A pass holds
// other robots' transcripts, so it is never shared, whatever the user's config says. A retro call also stops after 3 steps
const ASK = { mode: 'primary', permissions: [{ action: '*', resource: '*', effect: 'ask' }] };
const config = (retro: boolean): string => JSON.stringify({
  share: 'disabled',
  agents: retro ? { 'svall-retro': { ...ASK, steps: 3 } } : { 'svall-scribe': ASK },
});

// `run --format json` never prints its last step's step_finish, so what a call spent is read off the session's export;
// OpenCode counts reasoning apart from output
async function spent(bin: string, session: string, o: { cwd: string; env: NodeJS.ProcessEnv }): Promise<Usage> {
  try {
    const { stdout } = await promisify(execFile)(bin, ['session', 'export', '--standalone', session], { ...o, timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
    const replies = ((JSON.parse(stdout) as { messages?: Spent[] }).messages ?? []).filter((m) => m.type === 'assistant');
    const sum = (f: (m: Spent) => number | undefined) => replies.reduce((n, m) => n + (f(m) ?? 0), 0);
    const reasoning = sum((m) => m.tokens?.reasoning);
    return {
      input: sum((m) => m.tokens?.input), output: sum((m) => m.tokens?.output) + reasoning, reasoning,
      cacheRead: sum((m) => m.tokens?.cache?.read), cacheWrite: sum((m) => m.tokens?.cache?.write), costUsd: sum((m) => m.cost),
    };
  } catch {
    return NO_USAGE;
  }
}

// `opencode run` takes one prompt on stdin and has no system prompt of its own, so the system text leads it. A private
// server takes this config from the environment, where the shared background service would not. Only a retro call is
// asked what it spent
export function opencodeRunner(o: { cwd: string; bin?: string; retro?: true }): Runner {
  return async (system, prompt, call, signal) => {
    fs.mkdirSync(o.cwd, { recursive: true });
    const bin = o.bin ?? 'opencode';
    const agent = o.retro ? 'svall-retro' : 'svall-scribe';
    const { SVALL_ROBOT_ID: _id, SVALL_CHAR_ID: _old, ...rest } = process.env;
    const env = { ...rest, OPENCODE_CONFIG_CONTENT: config(!!o.retro) };
    const { code, out, err } = await runChild(
      () => spawn(bin, ['run', '--standalone', '--format', 'json', '--agent', agent, ...(call.model ? ['-m', call.model] : [])], { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }),
      { label: 'opencode run', stdin: `${system}\n\n---\n\n${prompt}`, timeoutMs: call.timeoutMs, signal },
    );
    const lines = jsonLines<Line>(out);
    const session = lines.find((l) => l.sessionID)?.sessionID;
    const usage = session && o.retro ? await spent(bin, session, { cwd: o.cwd, env }) : NO_USAGE;
    // every run is kept as a session, which would crowd the user's own list
    if (session) execFile(bin, ['session', 'delete', '--standalone', session], { cwd: o.cwd, env, timeout: 10_000, killSignal: 'SIGKILL' }, () => {});
    const answer = lines.filter((l) => l.type === 'text').at(-1)?.part?.text ?? '';
    const error = lines.filter((l) => l.type === 'error').at(-1)?.error;
    const cause = !answer.trim() && error ? error.message ?? error.type : undefined;
    if (cause) throw new Error(`opencode run failed: ${cause.slice(0, 300)}`);
    if (code !== 0) throw new Error(`opencode run exited ${code}`, stderrCause(err));
    if (!answer.trim()) throw new Error('opencode run wrote no answer', stderrCause(err));
    return { text: answer, usage };
  };
}
