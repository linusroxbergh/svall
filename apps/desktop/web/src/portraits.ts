import { PORTRAITS, type Character, type Portrait } from '@svall/protocol';

export const portraitUrl = (p: Portrait): string => `./animals/${p}.svg`;

// robot-NN.svg in public/robots, in stepping order. 34–39 recolour 20, 06 and 07 two ways each,
// so they come last and take turns, never beside their own robot or each other
const ROBOTS = [
  1, 2, 4, 6, 7, 8, 18, 19, 20, 21, 27,
  46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65,
  66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86,
  34, 36, 38, 35, 37, 39,
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
