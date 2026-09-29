import type { AgentKind } from '@svall/protocol';
import { spawnClaude } from '../claude.js';
import { runChild, stderrCause } from './child.js';

export type RunScribe = (system: string, prompt: string) => Promise<string>;

/** A runner that takes each pass's CLI from `agent()`, so a new main agent applies from the next pass. */
export const perPass = (runners: Record<AgentKind, RunScribe>, agent: () => AgentKind): RunScribe =>
  (system, prompt) => runners[agent()](system, prompt);

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
    if (code !== 0) throw new Error(`claude -p exited ${code}`, stderrCause(err));
    if (typeof r?.result !== 'string') throw new Error('claude -p printed no result', stderrCause(err));
    return r.result;
  };
}
