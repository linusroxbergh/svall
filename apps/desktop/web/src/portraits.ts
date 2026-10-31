import { PORTRAITS, type Robot } from '@svall/protocol';

// robot-NN.svg in public/robots, in stepping order; 38 recolours 07, so the two never stand side by side
const FIGURES = [
  1, 2, 4, 7, 8, 18, 19,
  46, 47, 48, 49, 51, 52, 53, 54, 55, 56, 58, 60, 61, 62, 63, 64,
  66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86,
  87, 88, 38, 89, 90, 91, 92, 93,
];

// the robot's own figure, else the one at its portrait's place in the ring
export const figureOf = (c: Pick<Robot, 'portrait' | 'figure'>): number =>
  c.figure !== undefined && FIGURES.includes(c.figure) ? c.figure : FIGURES[PORTRAITS.indexOf(c.portrait) % FIGURES.length];
export const figureUrl = (n: number): string => `./robots/robot-${String(n).padStart(2, '0')}.svg`;
export const stepFigure = (n: number, by: 1 | -1): number => FIGURES[(FIGURES.indexOf(n) + by + FIGURES.length) % FIGURES.length];
