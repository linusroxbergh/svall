export function parsePair(spec: string, what: string): [number, number] {
  const m = /^(-?\d+),(-?\d+)$/.exec(spec.trim());
  if (!m) throw new Error(`bad ${what} "${spec}", expected two integers like 3,4`);
  return [Number(m[1]), Number(m[2])];
}

export function int(value: string, flag: string): number {
  const n = Number(value);
  if (Number.isNaN(n)) throw new Error(`bad ${flag} "${value}", expected a number`);
  return n;
}
