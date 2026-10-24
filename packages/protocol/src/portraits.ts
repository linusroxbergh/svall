import { z } from 'zod';

// a character's portrait name: a new character takes one no one else wears, and the name picks its default robot
export const PORTRAITS = [
  'bat', 'bear', 'beaver', 'camel', 'cat', 'chameleon',
  'cheetah', 'cow', 'deer', 'duck', 'eagle', 'elephant',
  'fox', 'frog', 'giraffe', 'goat', 'hamster', 'hen',
  'hippopotamus', 'horse', 'kangaroo', 'koala', 'lemur', 'llama',
  'monkey', 'ostrich', 'owl', 'panda-bear', 'penguin', 'pig',
  'polar-bear', 'rabbit', 'raccoon', 'rhinoceros', 'shark', 'sheep',
  'swan', 'tiger', 'walrus', 'wolf', 'zebra',
] as const;

export const Portrait = z.enum(PORTRAITS);
export type Portrait = z.infer<typeof Portrait>;

// a portrait no one else wears, while there are any left
export function randomPortrait(taken: ReadonlySet<string> = new Set()): Portrait {
  const free = PORTRAITS.filter((p) => !taken.has(p));
  const pool = free.length > 0 ? free : PORTRAITS;
  return pool[Math.floor(Math.random() * pool.length)];
}
