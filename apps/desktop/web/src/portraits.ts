import { PORTRAITS, stepPortrait, type Portrait } from '@svall/protocol';

export const portraitUrl = (p: Portrait): string => `./animals/${p}.svg`;

// robot-01..16 in public/robots; an animal stands for the robot at its place in the ring
const ROBOTS = 16;
const robotOf = (p: Portrait): number => PORTRAITS.indexOf(p) % ROBOTS;
export const robotUrl = (p: Portrait): string => `./robots/robot-${String(robotOf(p) + 1).padStart(2, '0')}.svg`;

// the nearest animal that way round the ring standing for the next robot, so the steppers page through the robots in turn
export function stepRobot(p: Portrait, by: 1 | -1): Portrait {
  const want = (robotOf(p) + by + ROBOTS) % ROBOTS;
  let next = stepPortrait(p, by);
  while (robotOf(next) !== want) next = stepPortrait(next, by);
  return next;
}

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
