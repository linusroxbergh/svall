import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = path.join(__dirname, '..', 'src');
const read = (f: string) => fs.readFileSync(path.join(src, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// every stylesheet but the one that defines the values
const sheets = fs.globSync('**/*.css', { cwd: src }).filter((f) => f !== 'tokens.css').sort();

// what a rule may not hold raw: the value belongs in tokens.css
const RAW: [string, RegExp][] = [
  ['hex colour', /#[0-9a-fA-F]{3,8}\b/],
  ['rgb colour', /\brgba?\(/],
  ['named colour', /(?<![-\w.#'"])(white|black|red|green|blue|yellow|orange|purple|gr[ae]y|silver)(?![-\w])/],
  ['px radius', /-radius:\s*[^;}]*\d+px/],
  ['raw duration', /\b(transition|animation)[a-z-]*:\s*[^;}]*\d*\.?\d+m?s\b/],
  ['raw easing', /cubic-bezier\(/],
  ['app layer', /z-index:\s*(3[5-9]|[4-9]\d|\d{3,})\b/],
  ['px gap', /\bgap:\s*[^;}]*\d+px/],
  ['px padding', /\bpadding(-[a-z]+)*:\s*[^;}]*\d+px/],
  // a hairline or nothing is not spacing
  ['px margin', /\bmargin(-[a-z]+)*:\s*[^;}]*?(?<![\w.])(?!1px)\d*\.?\d+px/],
  ['px type size', /\bfont(-size)?:\s*[^;}]*\d+px/],
  ['numeric weight', /\bfont(-weight)?:\s*[1-9]00\b/],
];

// a font face's descriptors are not properties: var() there is invalid and the face loses its weight, so they stay raw
const FACE = /@font-face\s*\{[^}]*\}/g;
const offenders = (css: string) => [
  ...(css.match(FACE) ?? []).filter((face) => face.includes('var(')).map(() => 'font-face var()'),
  ...RAW.flatMap(([what, re]) => (css.replace(FACE, '').match(new RegExp(re.source, 'g')) ?? []).map((h) => `${what}: ${h.trim()}`)),
];

describe('stylesheets draw from tokens.css', () => {
  it('catches a raw value in a longhand', () =>
    expect(offenders('.x { padding-inline-start: 6px; border-top-left-radius: 4px; margin-block: -8px; font-weight: 500 }')).toHaveLength(4));
  it('lets a hairline margin, a tokened one and a font face through, but not a token in a face', () => {
    expect(offenders('.x { margin: 0 -1px 1px auto; margin-left: calc(-1 * var(--sp-md)) } @font-face { font-weight: 300 700 }')).toEqual([]);
    expect(offenders('@font-face { font-weight: var(--w-regular) }')).toEqual(['font-face var()']);
  });
  it('finds the stylesheets', () => expect(sheets).toEqual(expect.arrayContaining(['styles.css', 'map/map.css', 'mobile/mobile.css', 'fonts.css'])));
  it.each(sheets)('%s', (f) => expect(offenders(read(f))).toEqual([]));
});
