import { readInput } from './prompts.js';
import type { Excerpt } from './select.js';

/** Characters a token at packing: the fewest of any family, so a batch's count holds whichever model reads it. */
export const CHARS_PER_TOKEN = 3.5;
const CUT = '\n…[cut]…\n';

// what an excerpt adds to a read's prompt: its fence, and the blank line after it
const tokensOf = (e: Excerpt): number => Math.ceil((readInput({ excerpts: [e] }).length + 2) / CHARS_PER_TOKEN);

// an excerpt over `cutTokens` keeps its head and tail halves
function cut(e: Excerpt, cutTokens: number): Excerpt {
  const max = Math.floor(cutTokens * CHARS_PER_TOKEN);
  if (e.text.length <= max) return e;
  const half = Math.floor((max - CUT.length) / 2);
  return { ...e, text: e.text.slice(0, half) + CUT + e.text.slice(-half) };
}

/** The excerpts in batches of at most `maxTokens`, the highest priority first and each excerpt whole in one, as `b01`, `b02`, … */
export function pack(excerpts: Excerpt[], maxTokens = 50_000, cutTokens = 4_000): { id: string; excerpts: Excerpt[]; tokens: number }[] {
  const batches: { id: string; excerpts: Excerpt[]; tokens: number }[] = [];
  const sorted = [...excerpts].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  for (const e of sorted.map((x) => cut(x, cutTokens))) {
    const tokens = tokensOf(e);
    let b = batches.find((x) => x.tokens + tokens <= maxTokens);
    if (!b) batches.push((b = { id: `b${String(batches.length + 1).padStart(2, '0')}`, excerpts: [], tokens: 0 }));
    b.excerpts.push(e);
    b.tokens += tokens;
  }
  return batches;
}
