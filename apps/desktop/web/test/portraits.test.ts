import fs from 'node:fs';
import path from 'node:path';
import { PORTRAITS } from '@svall/protocol';
import { describe, expect, it } from 'vitest';
import { robotOf, robotUrl, stepRobot } from '../src/portraits.js';

const files = fs.readdirSync(path.join(__dirname, '../public/robots')).filter((f) => f.endsWith('.svg')).sort();
const file = (n: number) => robotUrl(n).split('/').pop();
// the robot each colourway recolours
const SOURCE: Record<number, number> = { 38: 7 };
const family = (n: number) => SOURCE[n] ?? n;

describe('robot portraits', () => {
  it('step through every robot once either way, never from a robot to its own colourway', () => {
    for (const by of [1, -1] as const) {
      const seen = [1];
      for (let i = 1; i < files.length; i++) seen.push(stepRobot(seen.at(-1)!, by));
      expect(stepRobot(seen.at(-1)!, by)).toBe(1);
      expect(seen.map(file).sort()).toEqual(files);
      seen.forEach((n, i) => expect(family(n)).not.toBe(family(seen[(i + 1) % seen.length])));
    }
  });

  it('show a character its own robot, else a different one for each animal', () => {
    expect(robotOf({ portrait: 'fox', robot: 46 })).toBe(46);
    expect(new Set(PORTRAITS.map((portrait) => robotOf({ portrait }))).size).toBe(PORTRAITS.length);
    expect(robotOf({ portrait: 'fox', robot: 99 })).toBe(robotOf({ portrait: 'fox' }));
  });
});
