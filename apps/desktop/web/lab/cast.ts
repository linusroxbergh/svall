import type { Robot } from './RobotToken.js';

// width over height of each robot's artwork, and a palette colour set against its own body colour
export const ROBOTS: Robot[] = ([
  [0.65, 'sun'], [0.74, 'coral'], [1.26, 'sky'], [0.61, 'sun'], [1.22, 'coral'], [1.01, 'sun'], [0.81, 'moss'], [0.9, 'sky'],
  [0.67, 'moss'], [0.97, 'coral'], [0.97, 'sky'], [0.83, 'sun'], [0.91, 'sky'], [1.02, 'coral'], [0.71, 'sky'], [1.2, 'earth'],
] as const).map(([ar, tint], i) => ({ id: `robot-${String(i + 1).padStart(2, '0')}`, ar, tint }));

export const robotUrl = (r: Robot): string => `./robots/${r.id}.svg`;

// a mask or image that arrives after first paint is not always repainted in WebKit, so the robots load first
export const preloadRobots = (): Promise<unknown> =>
  Promise.all(ROBOTS.map((r) => { const im = new Image(); im.src = robotUrl(r); return im.decode().catch(() => {}); }));
