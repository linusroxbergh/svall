import type { AgentKind, FleetConfig, Preset, Range } from '@svall/protocol';
import type { Usage } from '../scribe/run.js';
import type { Family } from './calibrate.js';
import { priceOf, type Price } from './prices.js';

/** The input each CLI adds to a call of its own, and whether it is billed as cache reads. */
export const OVERHEAD: Record<AgentKind, { min: number; max: number; cached: boolean }> = {
  claude: { min: 1_000, max: 1_000, cached: false }, codex: { min: 30_000, max: 40_000, cached: true }, opencode: { min: 15_000, max: 15_000, cached: false },
};
export const FAMILY: Record<AgentKind, Family> = { claude: 'claude', codex: 'openai', opencode: 'other' };

// what each call answers, its reasoning in the top of the range: a card 750–1,500 a chunk, a label 100–300 a comment, the
// synthesis 10k–32k, a verify call of four candidates 2.7k–12k
const CARD_OUT = { min: 750, max: 1_500 }, LABEL_OUT = { min: 100, max: 300 }, REASONING = 2_000;
const SYNTHESIS_OUT = { min: 10_000, max: 32_000 }, VERIFY_OUT = { min: 2_700, max: 12_000 };
/** The synthesis reads at most this much; a verify call four candidates of up to 17k each, three calls for twelve. */
export const SYNTHESIS_IN = 150_000;
const VERIFY_IN = { min: 20_000, max: 68_000 }, VERIFY_CALLS = 3;
// the synthesis input a carded session adds to the inventory and rule files it always reads
const PER_SESSION = 300;

/** A preset before it is estimated: the models that card, synthesize and verify, undefined for the CLI's own. */
export type PresetPick = { name: string; label: string; read: string | undefined; judge: string | undefined; verify: string | undefined };

const PRESETS: Record<AgentKind, PresetPick[]> = {
  claude: [
    { name: 'thrifty', label: 'Thrifty — Haiku reads, Sonnet judges, Sonnet verifies', read: 'haiku', judge: 'sonnet', verify: 'sonnet' },
    { name: 'balanced', label: 'Balanced — Haiku reads, Opus judges, Sonnet verifies', read: 'haiku', judge: 'opus', verify: 'sonnet' },
    { name: 'thorough', label: 'Thorough — Sonnet reads, Opus judges, Opus verifies', read: 'sonnet', judge: 'opus', verify: 'opus' },
  ],
  // astra is OpenAI's flagship, sol its middle tier and luna its smallest
  codex: [
    { name: 'thrifty', label: 'Thrifty — gpt-6-luna reads, gpt-6-sol judges, gpt-6-sol verifies', read: 'gpt-6-luna', judge: 'gpt-6-sol', verify: 'gpt-6-sol' },
    { name: 'balanced', label: 'Balanced — gpt-6-luna reads, gpt-6-astra judges, gpt-6-sol verifies', read: 'gpt-6-luna', judge: 'gpt-6-astra', verify: 'gpt-6-sol' },
    { name: 'thorough', label: 'Thorough — gpt-6-sol reads, gpt-6-astra judges, gpt-6-astra verifies', read: 'gpt-6-sol', judge: 'gpt-6-astra', verify: 'gpt-6-astra' },
  ],
  opencode: [{ name: 'default', label: "Default — OpenCode's model reads, judges and verifies", read: undefined, judge: undefined, verify: undefined }],
};

/** The agent's presets, led by a `configured` one when fleet.json names its models; a role it leaves out is the balanced preset's. */
export function presetsFor(agent: AgentKind, config: FleetConfig['retro']): PresetPick[] {
  const picked = config.model?.[agent];
  if (!picked) return PRESETS[agent];
  const fallback = PRESETS[agent].find((p) => p.name === 'balanced') ?? PRESETS[agent][0];
  const [read, judge, verify] = [picked.read ?? fallback.read, picked.judge ?? fallback.judge, picked.verify ?? fallback.verify];
  const said = (m: string | undefined) => m ?? 'its own model';
  return [{ name: 'configured', label: `Configured — ${said(read)} reads, ${said(judge)} judges, ${said(verify)} verifies`, read, judge, verify }, ...PRESETS[agent]];
}

/** One call before it is counted: the tokens its prompt holds and what it may answer, reasoning included at the top. */
export type CallSize = { input: Range; out: Range };
/** Every call a run makes, by stage. */
export type Work = { cards: CallSize[]; labels: CallSize[]; synthesis: CallSize; verify: CallSize[] };

const fixed = (n: number): Range => ({ min: n, max: n });
/** A card call of `chars` prompt characters over `chunks` chunks. */
export const cardCall = (chars: number, chunks: number, cpt: number): CallSize =>
  ({ input: fixed(Math.ceil(chars / cpt)), out: { min: CARD_OUT.min * chunks, max: CARD_OUT.max * chunks + REASONING } });
export const labelCall = (chars: number, items: number, cpt: number): CallSize =>
  ({ input: fixed(Math.ceil(chars / cpt)), out: { min: LABEL_OUT.min * items, max: LABEL_OUT.max * items + REASONING } });
/** The synthesis over `chars` of inventory and rule files and the groups of `sessions` cards, at most its cap. */
export const synthesisCall = (chars: number, sessions: number, cpt: number): CallSize =>
  ({ input: { min: Math.min(SYNTHESIS_IN, Math.ceil(chars / cpt) + PER_SESSION * sessions), max: SYNTHESIS_IN }, out: SYNTHESIS_OUT });
export const verifyCalls = (): CallSize[] => Array.from({ length: VERIFY_CALLS }, () => ({ input: VERIFY_IN, out: VERIFY_OUT }));
/** The least synthesis input an overrun may cut it to. */
export const SYNTHESIS_FLOOR = 60_000;
/** The synthesis input a hold of `hold` tokens covers at the cap, its output and the CLI's own allowed for. */
export const synthesisInputFor = (hold: number, agent: AgentKind): number =>
  Math.max(0, Math.floor((((hold * 10) / 11 - OVERHEAD[agent].max - SYNTHESIS_OUT.max) * 20) / 23));

// the cap reads 15% more input than counted and allows a tenth more for retries
const capped = (input: number, overhead: number, out: number): number => Math.ceil(((input * 23) / 20 + overhead + out) * 11 / 10);

/** A call's tokens: typical is its input, the CLI's own and its least output; the cap its input with slack, the CLI's most and all its output, plus retries. */
export function callTokens(c: CallSize, agent: AgentKind): Range {
  const o = OVERHEAD[agent];
  return { min: Math.ceil(c.input.min + o.min + c.out.min), max: capped(c.input.max, o.max, c.out.max) };
}

function callCost(c: CallSize, agent: AgentKind, price: Price): Range {
  const o = OVERHEAD[agent];
  const own = o.cached ? price.cacheRead : price.input;
  const usd = (input: number, overhead: number, out: number) => (input * price.input + overhead * own + out * price.output) / 1e6;
  return { min: usd(c.input.min, o.min, c.out.min), max: (usd((c.input.max * 23) / 20, o.max, c.out.max) * 11) / 10 };
}

const sum = (ranges: Range[]): Range => ({ min: ranges.reduce((n, r) => n + r.min, 0), max: ranges.reduce((n, r) => n + r.max, 0) });

/** What a run holds back before it reads: the synthesis and verify at their caps; and what reading every session may take. */
export function capOf(work: Work, agent: AgentKind): { reserved: number; reading: number } {
  if (!work.cards.length) return { reserved: 0, reading: 0 };
  return {
    reserved: callTokens(work.synthesis, agent).max + work.verify.reduce((n, c) => n + callTokens(c, agent).max, 0),
    reading: [...work.cards, ...work.labels].reduce((n, c) => n + callTokens(c, agent).max, 0),
  };
}

/** What a preset would take on the plan's work: tokens, typical and cap, and cost when every role's model has a price. */
export function estimate(work: Work, p: PresetPick, agent: AgentKind): Preset & { verify: Preset['read'] } {
  // with nothing to read there are no groups, and neither the synthesis nor the verify is called
  const roles: [CallSize[], string | undefined][] = work.cards.length
    ? [[[...work.cards, ...work.labels], p.read], [[work.synthesis], p.judge], [work.verify, p.verify]]
    : [];
  const tokens = sum(roles.flatMap(([calls]) => calls.map((c) => callTokens(c, agent))));
  const costs = roles.map(([calls, model]) => { const price = priceOf(model); return price && sum(calls.map((c) => callCost(c, agent, price))); });
  const pick = (model?: string) => ({ agent, ...(model && { model }) });
  return {
    name: p.name, label: p.label, read: pick(p.read), judge: pick(p.judge), verify: pick(p.verify),
    tokens, ...(costs.every((c) => c) && { cost: sum(costs as Range[]) }),
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

  /** Gives back part of a hold no call will use. */
  release(tokens: number): void {
    this.held -= tokens;
  }

  // output already counts reasoning
  settle(reserved: number, used: Usage): void {
    this.held -= reserved;
    this.spent += used.input + used.output + used.cacheRead + used.cacheWrite;
  }

  /** What calls used so far; above the total when reasoning overran a reservation. */
  get used(): number { return this.spent; }
  /** What is neither spent nor held. */
  get left(): number { return this.total - this.spent - this.held; }
}

// the v1 retro's batches, read until the run moves to cards

/** Characters per token by model family; batches are counted at the lowest, so a family with more reads fewer tokens. */
export const RATIO: Record<Family, number> = { claude: 3.5, openai: 4, other: 3.5 };
const READ_OUT = 2_000, READ_REASONING = 4_000, JUDGE_OUT = 12_000, JUDGE_REASONING = 16_000, JUDGE_IN_MAX = 140_000;
const PACKED = Math.min(...Object.values(RATIO));
type V1Call = { tokens: Range; cost?: Range };
function v1call(input: number, out: number, reasoning: number, agent: AgentKind, price: Price | undefined): V1Call {
  const o = OVERHEAD[agent];
  const tokens = { min: Math.ceil(input + o.min + out / 2), max: Math.ceil(input * 1.15 + o.max + out + reasoning) };
  if (!price) return { tokens };
  const own = o.cached ? price.cacheRead : price.input;
  const usd = (i: number, overhead: number, output: number) => (i * price.input + overhead * own + output * price.output) / 1e6;
  return { tokens, cost: { min: usd(input, o.min, out / 2), max: usd(input * 1.15, o.max, out + reasoning) } };
}
const readCall = (tokens: number, agent: AgentKind, model?: string): V1Call => v1call(tokens * PACKED / RATIO[FAMILY[agent]], READ_OUT, READ_REASONING, agent, priceOf(model));
const judgeCall = (batches: number, agent: AgentKind, model?: string): V1Call => v1call(Math.min(JUDGE_IN_MAX, batches * READ_OUT + 40_000), JUDGE_OUT, JUDGE_REASONING, agent, priceOf(model));
export const readTokens = (tokens: number, agent: AgentKind): Range => readCall(tokens, agent).tokens;
export const judgeTokens = (batches: number, agent: AgentKind): Range => judgeCall(batches, agent).tokens;
export function estimateBatches(batches: { tokens: number }[], p: PresetPick, agent: AgentKind): Preset {
  const calls = batches.length ? [...batches.map((b) => readCall(b.tokens, agent, p.read)), judgeCall(batches.length, agent, p.judge)] : [];
  const tokens = sum(calls.map((c) => c.tokens));
  const costs = calls.flatMap((c) => (c.cost ? [c.cost] : []));
  return {
    name: p.name, label: p.label, read: { agent, ...(p.read && { model: p.read }) }, judge: { agent, ...(p.judge && { model: p.judge }) },
    tokens: { min: Math.round(tokens.min), max: Math.round(tokens.max) }, ...(costs.length === calls.length && { cost: sum(costs) }),
  };
}
