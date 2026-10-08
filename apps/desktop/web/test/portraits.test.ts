import fs from 'node:fs';
import path from 'node:path';
import { PORTRAITS } from '@svall/protocol';
import { describe, expect, it } from 'vitest';
import { robotUrl, stepRobot } from '../src/portraits.js';

const robots = fs.readdirSync(path.join(__dirname, '../public/robots')).filter((f) => f.endsWith('.svg')).sort();
const file = (url: string) => url.split('/').pop();

describe('robot portraits', () => {
  it('give every animal a robot, and the steppers reach every robot in turn either way', () => {
    expect(new Set(PORTRAITS.map((p) => file(robotUrl(p))))).toEqual(new Set(robots));
    for (const by of [1, -1] as const) {
      for (const from of PORTRAITS) {
        const seen = [file(robotUrl(from))];
        let p = from;
        for (let i = 0; i < robots.length; i++) seen.push(file(robotUrl((p = stepRobot(p, by)))));
        const at = robots.indexOf(seen[0]!);
        expect(seen).toEqual(Array.from({ length: robots.length + 1 }, (_, i) => robots[(at + by * i + robots.length * 2) % robots.length]));
      }
    }
  });
});
