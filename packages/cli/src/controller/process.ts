import { spawn } from 'node:child_process';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE = 2000;

export type RunResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; truncated: boolean };

export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  input?: string | Uint8Array;
};

/** Every diagnostic carries command output, and command output can carry a daemon token. */
export function redact(text: string, secrets: string[]): string {
  return secrets.filter(Boolean).reduce((out, secret) => out.split(secret).join('[redacted]'), text);
}

/**
 * Runs a command with an argv array; nothing it is given ever reaches a shell. Output is bounded,
 * and a command that outlives its timeout or is aborted is sent SIGTERM and then SIGKILL. It runs
 * in a session of its own, so a terminal's Ctrl-C reaches only the process that decides what it means.
 */
export function runProcess(exe: string, argv: string[], o: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, argv, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const max = o.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    const held = { stdout: '', stderr: '', truncated: false };
    const take = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const room = max - Buffer.byteLength(held[stream]);
      if (chunk.length > room) held.truncated = true;
      held[stream] += chunk.subarray(0, Math.max(room, 0)).toString();
    };
    child.stdout.on('data', take('stdout'));
    child.stderr.on('data', take('stderr'));

    let killer: NodeJS.Timeout | undefined;
    const stop = () => {
      child.kill('SIGTERM');
      killer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE);
      killer.unref();
    };
    const timer = setTimeout(stop, o.timeoutMs);
    o.signal?.addEventListener('abort', stop, { once: true });
    const done = () => {
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      o.signal?.removeEventListener('abort', stop);
    };

    child.on('error', (err) => { done(); reject(err); });
    child.stdin.on('error', () => { /* a command that exits without reading its input */ });
    child.on('close', (code, signal) => { done(); resolve({ code, signal, ...held }); });
    child.stdin.end(o.input ?? '');
  });
}
