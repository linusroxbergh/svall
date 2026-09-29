import crypto from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newId(prefix: 'c' | 'i' | 't'): string {
  const bytes = crypto.randomBytes(6);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${s}`;
}

export const isCharId = (s: string): boolean => /^c_[a-z0-9]{6}$/.test(s);
