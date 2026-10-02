function parsePair(spec: string, what: string): [number, number] {
  const m = /^(-?\d+),(-?\d+)$/.exec(spec.trim());
  if (!m) throw new Error(`bad ${what} "${spec}", expected two integers like 3,4`);
  return [Number(m[1]), Number(m[2])];
}

/** A cell or a place from `flag`, given as x,y. */
export const point = (spec: string | undefined, flag: string): { x: number; y: number } | undefined => {
  if (spec === undefined) return undefined;
  const [x, y] = parsePair(spec, flag);
  return { x, y };
};

/** A size from `flag`, given as w,h. */
export const size = (spec: string | undefined, flag: string): { w: number; h: number } | undefined => {
  if (spec === undefined) return undefined;
  const [w, h] = parsePair(spec, flag);
  return { w, h };
};

/** A whole number from `flag`, from `min` to `max`. */
export function int(value: string, flag: string, { min = -Infinity, max = Infinity } = {}): number {
  if (!/^-?\d+$/.test(value.trim())) throw new Error(`bad ${flag} "${value}", expected a whole number`);
  const n = Number(value);
  if (n < min || n > max) throw new Error(`bad ${flag} "${value}", expected ${max === Infinity ? `at least ${min}` : `${min} to ${max}`}`);
  return n;
}

/** A number from `flag`, such as a ratio, from `min` to `max`. */
export function num(value: string, flag: string, { min, max }: { min: number; max: number }): number {
  const n = /^\d*\.?\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!(n >= min && n <= max)) throw new Error(`bad ${flag} "${value}", expected a number from ${min} to ${max}`);
  return n;
}
