import fs from 'node:fs';
import { z } from 'zod';
import { writeDurable } from '../durable.js';

/** The model families whose tokenizers differ: Claude's, OpenAI's (Codex), and whatever OpenCode runs. */
export type Family = 'claude' | 'openai' | 'other';
const Calibration = z.partialRecord(z.enum(['claude', 'openai', 'other']), z.object({ cpt: z.number().positive(), n: z.number().int().nonnegative() }));
/** Characters a token per family, as calls reported them, and how many calls it was taken from. */
export type Calibration = z.infer<typeof Calibration>;

export const DEFAULT_CPT = 3;
// a fifth of the way toward each sample; a sample outside 1.5–6 is a CLI that counted something else
const ALPHA = 0.2, LOW = 1.5, HIGH = 6;

export function readCalibration(file: string): Calibration {
  try { return Calibration.safeParse(JSON.parse(fs.readFileSync(file, 'utf8'))).data ?? {}; } catch { return {}; }
}

export const writeCalibration = (file: string, c: Calibration): void => writeDurable(file, Buffer.from(JSON.stringify(c, null, 2)), { mode: 0o600 });

export const calibrated = (c: Calibration, f: Family): number => c[f]?.cpt ?? DEFAULT_CPT;

/** `c` moved toward what one call shows: its prompt's characters over the input it reported, less its CLI's own; a call
 *  that reported none leaves it as it was. */
export function calibrate(c: Calibration, f: Family, s: { chars: number; input: number; overhead: number }): Calibration {
  const tokens = s.input - s.overhead;
  if (tokens <= 0 || s.chars <= 0) return c;
  const sample = Math.min(HIGH, Math.max(LOW, s.chars / tokens));
  const was = calibrated(c, f);
  return { ...c, [f]: { cpt: Math.round((was + ALPHA * (sample - was)) * 1e6) / 1e6, n: (c[f]?.n ?? 0) + 1 } };
}
