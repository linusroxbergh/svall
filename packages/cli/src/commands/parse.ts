function parsePair(spec: string, what: string): [number, number] {
  const m = /^(-?\d+),(-?\d+)$/.exec(spec.trim());
  if (!m) throw new Error(`bad ${what} "${spec}", expected two integers like 3,4`);
  return [Number(m[1]), Number(m[2])];
}

export const point = (spec: string | undefined, flag: string): { x: number; y: number } | undefined => {
  if (spec === undefined) return undefined;
  const [x, y] = parsePair(spec, flag);
  return { x, y };
};

export const size = (spec: string | undefined, flag: string): { w: number; h: number } | undefined => {
  if (spec === undefined) return undefined;
  const [w, h] = parsePair(spec, flag);
  return { w, h };
};

export function int(value: string, flag: string, { min = -Infinity, max = Infinity } = {}): number {
  const n = Number(value);
  if (!/^-?\d+$/.test(value.trim()) || !Number.isSafeInteger(n)) throw new Error(`bad ${flag} "${value}", expected a whole number`);
  if (n < min || n > max) throw new Error(`bad ${flag} "${value}", expected ${max === Infinity ? `at least ${min}` : `${min} to ${max}`}`);
  return n;
}

export function num(value: string, flag: string, { min, max }: { min: number; max: number }): number {
  const n = /^\d*\.?\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!(n >= min && n <= max)) throw new Error(`bad ${flag} "${value}", expected a number from ${min} to ${max}`);
  return n;
}

export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(s.trim());
  if (!m) throw new Error(`bad duration "${s}": seconds, or a number with ms, s, m or h after it, like 30s`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 's') as 'ms' | 's' | 'm' | 'h'];
  return Math.round(Number(m[1]) * unit);
}
