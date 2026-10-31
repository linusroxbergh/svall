import { PORTRAITS, type Robot } from '@svall/protocol';

// robot-NN.svg in public/robots, in stepping order; 38 recolours 07, so the two never stand side by side
const FIGURES = [
  1, 2, 4, 7, 8, 18, 19,
  46, 47, 48, 49, 51, 52, 53, 54, 55, 56, 58, 60, 61, 62, 63, 64,
  66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86,
  87, 88, 38, 89, 90, 91, 92, 93,
];

// each robot's body colour, the largest coloured fill in its drawing; its card tints the backdrop with it. 68 is silver
const COLOURS: Record<number, string> = {
  1: '#b3664a', 2: '#4f9ec5', 4: '#6f3d29', 7: '#514d76', 8: '#faab50', 18: '#d44d53', 19: '#c35d36', 38: '#944827',
  46: '#d9734e', 47: '#74c3a2', 48: '#c9a386', 49: '#6c6fb8', 51: '#5aa6dc', 52: '#3f8c94', 53: '#8c8f42', 54: '#c2443a',
  55: '#e0a52e', 56: '#e27b31', 58: '#c2443a', 60: '#cd6155', 61: '#6f9fc8', 62: '#7d9c6a', 63: '#c25a7c', 64: '#2f95a9',
  66: '#5aa6dc', 67: '#3f8a55', 68: '#92a1b2', 69: '#6f86a0', 70: '#3f9a6e', 71: '#daac49', 72: '#8a4f7d', 73: '#2e7a8a',
  74: '#daac49', 75: '#d9734e', 76: '#7d9c6a', 77: '#3f8c94', 78: '#e27b31', 79: '#94603b', 80: '#913648', 81: '#ec7430',
  82: '#7f8440', 83: '#8668bb', 84: '#6b90b6', 85: '#d9a441', 86: '#5a9f84', 87: '#7e4a5f', 88: '#2e8a9c', 89: '#ec8436',
  90: '#2b7a66', 91: '#c22f44', 92: '#8e4560', 93: '#2e6b7a',
};
export const colourOf = (n: number): string | undefined => COLOURS[n];

// the robot's own figure, else the one at its portrait's place in the ring
export const figureOf = (c: Pick<Robot, 'portrait' | 'figure'>): number =>
  c.figure !== undefined && FIGURES.includes(c.figure) ? c.figure : FIGURES[PORTRAITS.indexOf(c.portrait) % FIGURES.length];
export const figureUrl = (n: number): string => `./robots/robot-${String(n).padStart(2, '0')}.svg`;
export const stepFigure = (n: number, by: 1 | -1): number => FIGURES[(FIGURES.indexOf(n) + by + FIGURES.length) % FIGURES.length];
