import crypto from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newId(prefix: 'c' | 'i' | 't' | 'k'): string {
  const bytes = crypto.randomBytes(6);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${s}`;
}

export const newMutationId = (): string => `mu_${[...crypto.randomBytes(10)].map((b) => ALPHABET[b % ALPHABET.length]).join('')}`;

export const isRobotId = (s: string): boolean => /^c_[a-z0-9]{6}$/.test(s);
export const isIslandId = (s: string): boolean => /^i_[a-z0-9]{6}$/.test(s);
