import { PORTRAITS, type Character, type Portrait } from '@svall/protocol';

export const portraitUrl = (p: Portrait): string => `./animals/${p}.svg`;

// robot-NN.svg in public/robots, in stepping order. 34–45 recolour 20, 06, 07, 08, 11 and 13 two ways each,
// so they come last and take turns, never beside their own robot or each other
const ROBOTS = [
  1, 2, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 25, 26, 27, 28, 30, 31, 32, 33,
  46, 47, 48, 49, 50, 51, 52, 53, 54, 55,
  34, 36, 38, 40, 42, 44, 35, 37, 39, 41, 43, 45,
];

// the character's own robot, else the one at its animal's place in the ring
export const robotOf = (c: Pick<Character, 'portrait' | 'robot'>): number =>
  c.robot !== undefined && ROBOTS.includes(c.robot) ? c.robot : ROBOTS[PORTRAITS.indexOf(c.portrait) % ROBOTS.length];
export const robotUrl = (n: number): string => `./robots/robot-${String(n).padStart(2, '0')}.svg`;
export const stepRobot = (n: number, by: 1 | -1): number => ROBOTS[(ROBOTS.indexOf(n) + by + ROBOTS.length) % ROBOTS.length];

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
