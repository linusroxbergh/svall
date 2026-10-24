import { PORTRAITS, type Character } from '@svall/protocol';

// robot-NN.svg in public/robots, in stepping order. 34–39 recolour 20, 06 and 07 two ways each,
// so they come last and take turns, never beside their own robot or each other
const ROBOTS = [
  1, 2, 4, 7, 8, 18, 19,
  46, 47, 48, 49, 51, 52, 53, 54, 55, 56, 58, 60, 61, 62, 63, 64,
  66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86,
  87, 88, 38, 89, 90, 91, 92, 93,
];

// the character's own robot, else the one at its portrait's place in the ring
export const robotOf = (c: Pick<Character, 'portrait' | 'robot'>): number =>
  c.robot !== undefined && ROBOTS.includes(c.robot) ? c.robot : ROBOTS[PORTRAITS.indexOf(c.portrait) % ROBOTS.length];
export const robotUrl = (n: number): string => `./robots/robot-${String(n).padStart(2, '0')}.svg`;
export const stepRobot = (n: number, by: 1 | -1): number => ROBOTS[(ROBOTS.indexOf(n) + by + ROBOTS.length) % ROBOTS.length];
