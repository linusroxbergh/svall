import { spawnClaude } from '../claude.js';
import { runChild, stderrCause } from './child.js';

/** Answers a pass; an aborted `signal` ends the pass's child and rejects. */
export type RunScribe = (system: string, prompt: string, signal?: AbortSignal) => Promise<string>;

export type Effort = 'low' | 'medium' | 'high';
/** What a call spent: input read fresh, output (reasoning included, and also counted on its own), and the cache's reads and writes. */
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; costUsd?: number };
export const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
/** What one call asks of its CLI; each part left out is the CLI's own default. A schema makes the answer JSON that fits it. */
export type Call = { model?: string; effort?: Effort; schema?: Record<string, unknown>; timeoutMs?: number };
export type Answer = { text: string; usage: Usage };
/** Answers one call; an aborted `signal` ends the call's child and rejects. */
export type Runner = (system: string, prompt: string, call: Call, signal?: AbortSignal) => Promise<Answer>;

/** A runner that takes each pass's runner from `pick()`, so a new agent or model applies from the next pass. */
export const perPass = (pick: () => RunScribe): RunScribe => (system, prompt, signal) => pick()(system, prompt, signal);

/** The scribe's passes, each one call on `run`. */
export const scribeOf = (run: Runner, call: Call): RunScribe => async (system, prompt, signal) => (await run(system, prompt, call, signal)).text;

type ClaudeResult = {
  is_error?: boolean; result?: unknown; structured_output?: unknown; total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens_details?: { thinking_tokens?: number } };
};

const claudeUsage = (r: ClaudeResult): Usage => ({
  input: r.usage?.input_tokens ?? 0, output: r.usage?.output_tokens ?? 0,
  cacheRead: r.usage?.cache_read_input_tokens ?? 0, cacheWrite: r.usage?.cache_creation_input_tokens ?? 0,
  reasoning: r.usage?.output_tokens_details?.thinking_tokens ?? 0,
  ...(typeof r.total_cost_usd === 'number' && { costUsd: r.total_cost_usd }),
});

// a retro call reads each batch once, so a cache only costs: claude -p would write every prompt to the one-hour cache
export function claudeRunner(o: { cwd: string; envFile: string; retro?: true }): Runner {
  return async (system, prompt, call, signal) => {
    const { code, out, err } = await runChild(
      () => spawnClaude({
        args: [
          '-p', ...(call.model ? ['--model', call.model] : []), ...(call.effort ? ['--effort', call.effort] : []),
          ...(call.schema ? ['--json-schema', JSON.stringify(call.schema)] : []), '--output-format', 'json', '--system-prompt', system,
        ],
        cwd: o.cwd,
        envFile: o.envFile,
        ...(o.retro && { env: { DISABLE_PROMPT_CACHING: '1' } }),
      }),
      { label: 'claude -p', stdin: prompt, timeoutMs: call.timeoutMs, signal },
    );
    let r: ClaudeResult | undefined;
    try { r = JSON.parse(out); } catch {}
    // an error result names its cause, such as a missing login, whatever the exit code
    if (r?.is_error && typeof r.result === 'string') throw new Error(`claude -p failed: ${r.result.slice(0, 300)}`);
    if (code !== 0) throw new Error(`claude -p exited ${code}`, stderrCause(err));
    const text = r?.structured_output !== undefined ? JSON.stringify(r.structured_output) : r?.result;
    if (typeof text !== 'string') throw new Error('claude -p printed no result', stderrCause(err));
    return { text, usage: claudeUsage(r!) };
  };
}
