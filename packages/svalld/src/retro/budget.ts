import type { AgentKind, FleetConfig, Preset, Range } from '@svall/protocol';
import type { Usage } from '../scribe/run.js';
import { priceOf, type Price } from './prices.js';

/** Characters per token by model family; batches are counted at the lowest, so a family with more reads fewer tokens. */
export const RATIO: Record<'claude' | 'openai' | 'other', number> = { claude: 3.5, openai: 4, other: 3.5 };
/** The input each CLI adds to a call of its own, and whether it is billed as cache reads. */
export const OVERHEAD: Record<AgentKind, { min: number; max: number; cached: boolean }> = {
  claude: { min: 1_000, max: 1_000, cached: false }, codex: { min: 30_000, max: 40_000, cached: true }, opencode: { min: 15_000, max: 15_000, cached: false },
};
// a read answers at most 2k tokens of notes; the judge reads at most 100k of notes and 40k of targets
export const READ_OUT = 2_000, READ_REASONING = 4_000, JUDGE_OUT = 12_000, JUDGE_REASONING = 16_000, JUDGE_IN_MAX = 140_000;

const PACKED = Math.min(...Object.values(RATIO));
const FAMILY: Record<AgentKind, keyof typeof RATIO> = { claude: 'claude', codex: 'openai', opencode: 'other' };

/** A preset before it is estimated: the models that read and judge, undefined for the CLI's own. */
export type PresetPick = { name: string; label: string; read: string | undefined; judge: string | undefined };

const PRESETS: Record<AgentKind, PresetPick[]> = {
  claude: [
    { name: 'thrifty', label: 'Thrifty — Haiku reads, Sonnet judges', read: 'haiku', judge: 'sonnet' },
    { name: 'balanced', label: 'Balanced — Sonnet reads, Opus judges', read: 'sonnet', judge: 'opus' },
    { name: 'thorough', label: 'Thorough — Opus reads, Opus judges', read: 'opus', judge: 'opus' },
  ],
  // astra is OpenAI's flagship, sol its middle tier and luna its smallest
  codex: [
    { name: 'thrifty', label: 'Thrifty — gpt-6-luna reads, gpt-6-sol judges', read: 'gpt-6-luna', judge: 'gpt-6-sol' },
    { name: 'balanced', label: 'Balanced — gpt-6-sol reads, gpt-6-astra judges', read: 'gpt-6-sol', judge: 'gpt-6-astra' },
    { name: 'thorough', label: 'Thorough — gpt-6-astra reads, gpt-6-astra judges', read: 'gpt-6-astra', judge: 'gpt-6-astra' },
  ],
  opencode: [{ name: 'default', label: "Default — OpenCode's model reads and judges", read: undefined, judge: undefined }],
};

/** The agent's presets, led by a `configured` one when fleet.json names its models; a side it leaves out is the default preset's. */
export function presetsFor(agent: AgentKind, config: FleetConfig['retro']): PresetPick[] {
  const picked = config.model?.[agent];
  if (!picked) return PRESETS[agent];
  const fallback = PRESETS[agent].find((p) => p.name === 'balanced') ?? PRESETS[agent][0];
  const [read, judge] = [picked.read ?? fallback.read, picked.judge ?? fallback.judge];
  const said = (m: string | undefined) => m ?? 'its own model';
  return [{ name: 'configured', label: `Configured — ${said(read)} reads, ${said(judge)} judges`, read, judge }, ...PRESETS[agent]];
}

type Call = { tokens: Range; cost?: Range };

// one call: its input read fresh (caching is off), the CLI's own input, and at least half its output cap, at most the cap and reasoning
function call(input: number, out: number, reasoning: number, agent: AgentKind, price: Price | undefined): Call {
  const o = OVERHEAD[agent];
  const tokens = { min: input + o.min + out / 2, max: input * 1.15 + o.max + out + reasoning };
  if (!price) return { tokens };
  const own = o.cached ? price.cacheRead : price.input;
  const usd = (input: number, overhead: number, output: number) => (input * price.input + overhead * own + output * price.output) / 1e6;
  return { tokens, cost: { min: usd(input, o.min, out / 2), max: usd(input * 1.15, o.max, out + reasoning) } };
}

const readCall = (tokens: number, agent: AgentKind, model?: string): Call =>
  call(tokens * PACKED / RATIO[FAMILY[agent]], READ_OUT, READ_REASONING, agent, priceOf(model));
const judgeCall = (batches: number, agent: AgentKind, model?: string): Call =>
  call(Math.min(JUDGE_IN_MAX, batches * READ_OUT + 40_000), JUDGE_OUT, JUDGE_REASONING, agent, priceOf(model));

/** The tokens a read of a batch of `tokens` may take, to reserve before it is sent. */
export const readTokens = (tokens: number, agent: AgentKind): Range => readCall(tokens, agent).tokens;
/** The tokens the judge may take on the notes of `batches` reads. */
export const judgeTokens = (batches: number, agent: AgentKind): Range => judgeCall(batches, agent).tokens;

/** What a preset would take on the plan's batches: tokens, and cost when both models are in the price table. */
export function estimate(batches: { tokens: number }[], p: PresetPick, agent: AgentKind): Preset {
  const calls = [...batches.map((b) => readCall(b.tokens, agent, p.read)), judgeCall(batches.length, agent, p.judge)];
  const sum = (ranges: Range[]): Range => ({ min: ranges.reduce((n, r) => n + r.min, 0), max: ranges.reduce((n, r) => n + r.max, 0) });
  const tokens = sum(calls.map((c) => c.tokens));
  const costs = calls.flatMap((c) => (c.cost ? [c.cost] : []));
  return {
    name: p.name, label: p.label,
    read: { agent, ...(p.read && { model: p.read }) }, judge: { agent, ...(p.judge && { model: p.judge }) },
    tokens: { min: Math.round(tokens.min), max: Math.round(tokens.max) },
    ...(costs.length === calls.length && { cost: sum(costs) }),
  };
}

/** The approved token budget: a call reserves its estimate before it is sent and settles to what it used. */
export class Budget {
  private held = 0;
  private spent = 0;
  constructor(private total: number) {}

  /** False when the budget left, less what calls in flight hold, won't cover `tokens`. */
  reserve(tokens: number): boolean {
    if (this.spent + this.held + tokens > this.total) return false;
    this.held += tokens;
    return true;
  }

  // output already counts reasoning
  settle(reserved: number, used: Usage): void {
    this.held -= reserved;
    this.spent += used.input + used.output + used.cacheRead + used.cacheWrite;
  }

  /** What calls used so far; above the total when reasoning overran a reservation. */
  get used(): number { return this.spent; }
}
