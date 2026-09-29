import crypto from 'node:crypto';

export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * JSON with every object's keys in code-unit order and no whitespace, as RFC 8785 writes the values a
 * manifest holds: equal values give equal text whatever order they were built in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => byCodeUnit(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new TypeError(`canonical JSON cannot hold ${String(value)}`);
}

export const sha256Hex = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

export const canonicalDigest = (value: unknown): string => sha256Hex(canonicalJson(value));

/** The sha256 and length of a stream, read a chunk at a time so a file of any size holds one buffer. */
export async function hashStream(chunks: AsyncIterable<Buffer>): Promise<{ sha256: string; size: number }> {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of chunks) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest('hex'), size };
}
