import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

type Piped = ChildProcessByStdio<Writable, Readable, Readable>;

const TIMEOUT_MS = 90_000;

/** The child's stderr as an error's cause, which the scribe shows but keeps out of the log; its stdout, the model's own text, goes in neither. */
export const stderrCause = (err: string): ErrorOptions => (err.trim() ? { cause: err.trim().slice(0, 300) } : {});

/** What the child printed and how it ended; a child still running at the deadline, or when `signal` aborts, is
 *  killed and the call rejects. Its stdin takes `stdin`, and an agent that refuses at once never reads it. */
export function runChild(
  start: () => Piped,
  o: { label: string; stdin: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const proc = start();
    let out = '', err = '';
    const timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
    const fail = (e: Error) => { proc.kill('SIGKILL'); reject(e); };
    const timer = setTimeout(() => fail(new Error(`${o.label} timed out after ${timeoutMs}ms`)), timeoutMs);
    const abort = () => fail(new Error(`${o.label} stopped`));
    o.signal?.addEventListener('abort', abort, { once: true });
    const settle = () => { clearTimeout(timer); o.signal?.removeEventListener('abort', abort); };
    proc.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    proc.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
    proc.on('error', (e) => { settle(); reject(e); });
    proc.on('close', (code) => { settle(); resolve({ code, out, err }); });
    proc.stdin.on('error', () => {});
    proc.stdin.end(o.stdin);
  });
}
