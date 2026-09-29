import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// what a rule may not hold raw: the value belongs in tokens.css
const RAW: [string, RegExp][] = [
  ['hex colour', /#[0-9a-fA-F]{3,8}\b/],
  ['rgb colour', /\brgba?\(/],
  ['named colour', /(?<![-\w.#'"])(white|black|red|green|blue|yellow|orange|purple|gr[ae]y|silver)(?![-\w])/],
  ['px radius', /-radius:\s*[^;}]*\d+px/],
  ['raw duration', /\b(transition|animation)[a-z-]*:\s*[^;}]*\d*\.?\d+m?s\b/],
  ['app layer', /z-index:\s*(3[5-9]|[4-9]\d|\d{3,})\b/],
  ['px gap', /\bgap:\s*[^;}]*\d+px/],
  ['px padding', /\bpadding(-[a-z]+)*:\s*[^;}]*\d+px/],
  // a descriptor is not a property: var() there is invalid and the face loses its weight
  ['font-face var()', /@font-face\s*\{[^}]*var\(/],
];

const offenders = (css: string) =>
  RAW.flatMap(([what, re]) => {
    const hits = css.match(new RegExp(re.source, 'g')) ?? [];
    return hits.map((h) => `${what}: ${h.trim()}`);
  });

describe('stylesheets draw from tokens.css', () => {
  it('catches a raw value in a longhand', () =>
    expect(offenders('.x { padding-inline-start: 6px; border-top-left-radius: 4px; }')).toHaveLength(2));
  it('styles.css', () => expect(offenders(read('styles.css'))).toEqual([]));
  it('mobile.css', () => expect(offenders(read('mobile/mobile.css'))).toEqual([]));
});
