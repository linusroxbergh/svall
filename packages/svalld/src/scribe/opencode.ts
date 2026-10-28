import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jsonLines } from '../agent/jsonl.js';
import { cliRunner } from '../sessions/registry.js';
import { runChild, stderrCause } from './child.js';
import { NO_USAGE, type Runner, type Usage } from './run.js';

type Line = { type?: string; sessionID?: string; part?: { text?: string }; error?: { type?: string; message?: string } };
type Spent = { type?: string; cost?: number; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } };

// these asks follow the user's rules and `opencode run` turns every ask down. A denied tool leaves the request, which Zen's free
// models refuse, so only `execute`, which Code Mode runs unasked, is denied. A pass holds other robots' transcripts: never shared
const ASK = { mode: 'primary', permissions: [{ action: '*', resource: '*', effect: 'ask' }, { action: 'execute', resource: '*', effect: 'deny' }] };
const config = (retro: boolean): string => JSON.stringify({
  share: 'disabled',
  agents: retro ? { 'svall-retro': { ...ASK, steps: 3 } } : { 'svall-scribe': ASK },
});

// `run --format json` never prints its last step_finish, so spend is read off the session's export, written to a file as a
// pipe can stop short: its totals, else its replies. OpenCode counts reasoning apart from output
async function spent(bin: string, session: string, o: { cwd: string; env: NodeJS.ProcessEnv }): Promise<Usage> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-spent-'));
  try {
    const file = path.join(dir, 'export.json');
    await cliRunner(o.env, 20_000)(bin, ['session', 'export', '--standalone', session], { cwd: o.cwd, stdout: file });
    const { info, messages = [] } = JSON.parse(fs.readFileSync(file, 'utf8')) as { info?: Spent; messages?: Spent[] };
    const counted = info?.tokens ? [info] : messages.filter((m) => m.type === 'assistant');
    const sum = (f: (m: Spent) => number | undefined) => counted.reduce((n, m) => n + (f(m) ?? 0), 0);
    const reasoning = sum((m) => m.tokens?.reasoning);
    return {
      input: sum((m) => m.tokens?.input), output: sum((m) => m.tokens?.output) + reasoning, reasoning,
      cacheRead: sum((m) => m.tokens?.cache?.read), cacheWrite: sum((m) => m.tokens?.cache?.write), costUsd: sum((m) => m.cost),
    };
  } catch {
    return NO_USAGE;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// `opencode run` has no system prompt, so the system text leads its one prompt; a private server takes the config from the
// env, where the shared one would not. A retro call names its session up front, so one that times out is deleted too
export function opencodeRunner(o: { cwd: string; bin?: string; retro?: true }): Runner {
  return async (system, prompt, call, signal) => {
    fs.mkdirSync(o.cwd, { recursive: true });
    const bin = o.bin ?? 'opencode';
    const agent = o.retro ? 'svall-retro' : 'svall-scribe';
    const { SVALL_ROBOT_ID: _id, SVALL_CHAR_ID: _old, ...rest } = process.env;
    // OpenCode takes its folder from PWD over the cwd it is spawned in
    const env = { ...rest, PWD: o.cwd, OPENCODE_CONFIG_CONTENT: config(!!o.retro) };
    let session = o.retro ? `ses_${crypto.randomBytes(13).toString('hex')}` : undefined;
    try {
      const { code, out, err } = await runChild(
        () => spawn(bin, ['run', '--standalone', '--format', 'json', '--agent', agent, ...(session ? ['--session', session] : []), ...(call.model ? ['-m', call.model] : [])], { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }),
        { label: 'opencode run', stdin: `${system}\n\n---\n\n${prompt}`, timeoutMs: call.timeoutMs, signal },
      );
      const lines = jsonLines<Line>(out);
      session ??= lines.find((l) => l.sessionID)?.sessionID;
      const usage = session && o.retro ? await spent(bin, session, { cwd: o.cwd, env }) : NO_USAGE;
      const answer = lines.filter((l) => l.type === 'text').at(-1)?.part?.text ?? '';
      const error = lines.filter((l) => l.type === 'error').at(-1)?.error;
      const cause = !answer.trim() && error ? error.message ?? error.type : undefined;
      if (cause) throw new Error(`opencode run failed: ${cause.slice(0, 300)}`);
      if (code !== 0) throw new Error(`opencode run exited ${code}`, stderrCause(err));
      if (!answer.trim()) throw new Error('opencode run wrote no answer', stderrCause(err));
      return { text: answer, usage };
    } finally {
      // every run is kept as a session, which would crowd the user's own list
      if (session) execFile(bin, ['session', 'delete', '--standalone', session], { cwd: o.cwd, env, timeout: 10_000, killSignal: 'SIGKILL' }, () => {});
    }
  };
}
