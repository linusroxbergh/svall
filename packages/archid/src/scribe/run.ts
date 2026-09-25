import { spawnClaude } from '../claude.js';
import { runChild } from './child.js';

export type RunScribe = (system: string, prompt: string) => Promise<string>;

export function claudeRunner(o: { model: string; cwd: string; envFile: string; timeoutMs?: number }): RunScribe {
  return async (system, prompt) => {
    const { code, out, err } = await runChild(
      () => spawnClaude({
        args: ['-p', '--model', o.model, '--output-format', 'json', '--system-prompt', system],
        cwd: o.cwd,
        envFile: o.envFile,
      }),
      { label: 'claude -p', stdin: prompt, timeoutMs: o.timeoutMs },
    );
    let r: { is_error?: boolean; result?: unknown } | undefined;
    try { r = JSON.parse(out); } catch {}
    // an error result names its cause, such as a missing login, whatever the exit code
    if (r?.is_error && typeof r.result === 'string') throw new Error(`claude -p failed: ${r.result.slice(0, 300)}`);
    if (code !== 0) throw new Error(`claude -p exited ${code}: ${(err || out).trim().slice(0, 300)}`);
    if (typeof r?.result !== 'string') throw new Error(`claude -p failed: ${out.slice(0, 300)}`);
    return r.result;
  };
}
