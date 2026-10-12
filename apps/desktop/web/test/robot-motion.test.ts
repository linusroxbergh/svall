import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = path.join(__dirname, '../public/robots');
const moving = fs
  .readdirSync(dir)
  .filter((f) => /^robot-\d+\.svg$/.test(f))
  .map((f) => ({ n: f.slice(6, -4), src: fs.readFileSync(path.join(dir, f), 'utf8') }))
  .filter(({ src }) => src.includes('<style>'));

const KEYFRAMES = /@keyframes\s+([\w-]+)\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g;

// the format scripts/robot-motion/README.md describes; check.mjs renders the motion itself
describe('robot motion', () => {
  it.each(moving)('robot-$n keys every animation on its own data-act and moves only transform and fill', ({ n, src }) => {
    const root = src.match(/<svg\b[^>]*>/)![0];
    expect(root).toMatch(new RegExp(`\\sclass="[^"]*\\br${n}\\b`));
    const lists = ['idle', 'work'].flatMap((k) => root.match(new RegExp(`\\sdata-${k}="([^"]*)"`))?.[1].split(' ').filter(Boolean) ?? []);
    expect(lists.length).toBeGreaterThan(0);

    const styles = src.match(/<style>([\s\S]*?)<\/style>/g)!;
    expect(styles).toHaveLength(1);
    const css = styles[0].replace(/<\/?style>/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, name] of css.matchAll(/@keyframes\s+([\w-]+)/g)) expect(name.startsWith(`r${n}-`)).toBe(true);
    const selectors = [...css.replace(KEYFRAMES, '').matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => m[1].split(',').map((s) => s.trim()));
    for (const s of selectors) expect(s).toMatch(new RegExp(`^\\.r${n}\\[data-act=[\\w-]+\\]`));
    const acts = new Set(selectors.map((s) => s.match(/data-act=([\w-]+)/)![1]));
    expect(new Set(lists)).toEqual(acts);
    for (const [, prop] of css.matchAll(/([a-z-]+)\s*:/g)) expect(prop).toMatch(/^(animation(-[a-z-]+)?|transform(-origin|-box)?|fill)$/);
    expect(css).not.toMatch(/infinite/);
    expect(src).not.toMatch(/<animate|<set\b|<script/);
  });
});
