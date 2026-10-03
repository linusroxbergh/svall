import type { Portrait } from '@svall/protocol';

export const portraitUrl = (p: Portrait): string => `./animals/${p}.svg`;

// the disc behind each animal, chosen to contrast its body
type Tint = 'sky' | 'sun' | 'coral' | 'earth' | 'moss' | 'slate';

const TINTS: Record<Tint, readonly Portrait[]> = {
  sky: ['beaver', 'cat', 'eagle', 'hamster', 'horse', 'owl', 'penguin', 'shark', 'sheep', 'tiger', 'walrus'],
  sun: ['camel', 'cheetah', 'deer', 'hippopotamus', 'kangaroo', 'koala', 'rhinoceros'],
  coral: ['goat', 'hen', 'lemur', 'llama', 'panda-bear', 'rabbit', 'wolf'],
  earth: ['duck', 'frog', 'giraffe', 'ostrich', 'pig', 'raccoon', 'zebra'],
  moss: ['bear', 'cow', 'elephant', 'monkey', 'swan'],
  slate: ['bat', 'chameleon', 'fox', 'polar-bear'],
};

const TINT_OF = new Map<Portrait, Tint>(
  (Object.entries(TINTS) as [Tint, readonly Portrait[]][]).flatMap(([t, ps]) => ps.map((p) => [p, t] as const)),
);

export const portraitTint = (p: Portrait): Tint => TINT_OF.get(p) ?? 'slate';
