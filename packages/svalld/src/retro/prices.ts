/** The day the list prices below were checked; a plan shows it beside its costs. */
export const PRICES_CHECKED = '2026-10-27';

/** USD per million tokens. */
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };

// Anthropic's list prices; cacheWrite is the one-hour write claude -p makes, at twice input. Haiku's is its rate for
// prompts up to 100k tokens, which a batch stays under
const OPUS: Price = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 };
const SONNET: Price = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 };
const HAIKU: Price = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.2 };
const FABLE: Price = { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 20 };

/** List prices by the model ids and aliases the CLIs take; OpenAI's are for prompts up to 272k tokens and charge no cache write. */
export const PRICES: Record<string, Price> = {
  opus: OPUS, 'claude-opus-5-5': OPUS,
  sonnet: SONNET, 'claude-sonnet-5-5': SONNET,
  haiku: HAIKU, 'claude-haiku-5-5': HAIKU,
  fable: FABLE, 'claude-fable-5-1': FABLE,
  'gpt-6-astra': { input: 10, output: 50, cacheRead: 1, cacheWrite: 10 },
  'gpt-6-sol': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.1 },
};

/** A model's price, or undefined when the table lacks it and the plan shows tokens only. */
export const priceOf = (model?: string): Price | undefined => (model && Object.hasOwn(PRICES, model) ? PRICES[model] : undefined);
