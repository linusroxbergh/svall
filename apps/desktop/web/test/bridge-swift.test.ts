import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { charOfKey, secondKey } from '@svall/protocol';

// the shell decodes and encodes each message by hand, so a name changed on one side alone only shows up here
const ts = fs.readFileSync(new URL('../src/bridge.ts', import.meta.url), 'utf8');
const swift = fs.readFileSync(new URL('../../mac/Sources/Svall/Bridge.swift', import.meta.url), 'utf8');

type Messages = Record<string, string[]>;
const sorted = (m: Messages): Messages => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v].sort()]));

// each message's fields, an optional one marked with ?
function tsUnion(name: string): Messages {
  const block = ts.split(`export type ${name} =`)[1]!.split(/;\n\n/)[0]!;
  const out: Messages = {};
  for (const [, type, rest, joined] of block.matchAll(/\{ type: '([^']+)'([^}]*)\}(?:\s*&\s*(\w+))?/g)) {
    const extra = joined ? ts.match(new RegExp(`export type ${joined} = \\{([^}]*)\\}`))![1] : '';
    out[type!] = [...`${rest}${extra}`.matchAll(/(\w+)(\?)?:/g)].map(([, f, q]) => f + (q ?? ''));
  }
  expect(Object.keys(out)).toHaveLength(block.match(/type: '/g)!.length);
  return sorted(out);
}

function swiftToShell(): Messages {
  // one chunk per case, from its label to the next, however it is wrapped
  const decoder = swift.split('forKey: .type) {')[1]!.split('case let other')[0]!;
  const chunks = decoder.split(/\bcase "/).slice(1);
  const out: Messages = {};
  for (const chunk of chunks) {
    out[chunk.slice(0, chunk.indexOf('"'))] = [...chunk.matchAll(/(decode|decodeIfPresent)\([^)]*forKey: \.(\w+)\)/g)].map(([, how, f]) => f + (how === 'decodeIfPresent' ? '?' : ''));
  }
  expect(Object.keys(out)).toHaveLength(chunks.length);
  return sorted(out);
}

function swiftFromShell(): Messages {
  const json = swift.split('var json: [String: Any] {')[1]!.split('\n    }\n')[0]!;
  const chunks = json.split(/\bcase \./).slice(1);
  const out: Messages = {};
  for (const chunk of chunks) {
    const type = chunk.match(/"type": "([^"]+)"/)?.[1];
    // the fields of the dictionary that carries the type, and any the message may leave out, set on it after it is made
    const literal = chunk.match(/\[("type": [^\]]*)\]/)?.[1] ?? '';
    const fields = [...literal.matchAll(/"(\w+)": /g), ...chunk.matchAll(/\bjson\["(\w+)"\] = /g)].map(([, f]) => f!);
    if (type) out[type] = fields.filter((f) => f !== 'type');
  }
  // a case whose type the pattern missed would otherwise drop out of the comparison unseen
  expect(Object.keys(out)).toHaveLength(chunks.length);
  return sorted(out);
}

describe('bridge between the page and the shell', () => {
  it('the shell decodes every message the page sends, with the same fields and the same optional ones', () => {
    expect(swiftToShell()).toEqual(tsUnion('ToShell'));
  });

  it('the page types every message the shell sends, with the same fields', () => {
    const page = Object.fromEntries(Object.entries(tsUnion('FromShell')).map(([k, v]) => [k, v.map((f) => f.replace('?', '')).sort()]));
    expect(swiftFromShell()).toEqual(page);
  });

  it('the shell keeps a coding key for each field the page sends, and no other', () => {
    const keys = swift.match(/enum Keys: String, CodingKey \{ case ([^}]*) \}/)![1]!.split(', ');
    const fields = Object.values(tsUnion('ToShell')).flat().map((f) => f.replace('?', ''));
    expect([...keys].sort()).toEqual([...new Set(['type', ...fields])].sort());
  });
});

// the banner's click and the phone's notification tag spell the second terminal's key out themselves
describe('a second terminal\'s key outside the protocol', () => {
  it('the shell reads the character back off it as the protocol does', () => {
    const notifier = fs.readFileSync(new URL('../../mac/Sources/Svall/Notifier.swift', import.meta.url), 'utf8');
    const [, suffix, cut] = notifier.match(/func charId\(_ key: String\) -> String \{ key\.hasSuffix\("([^"]+)"\) \? String\(key\.dropLast\((\d+)\)\) : key \}/)!;
    expect(`c_1${suffix}`).toBe(secondKey('c_1'));
    expect(`c_1${suffix}`.slice(0, -Number(cut))).toBe(charOfKey(secondKey('c_1')));
  });

  it('the service worker tags a second terminal\'s notification with it', () => {
    const sw = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
    const tagOf = new Function('p', `return ${sw.match(/const tagOf = \(p\) => (.+);\n/)![1]}`) as (p: { id: string; term?: 2 }) => string;
    expect(tagOf({ id: 'c_1', term: 2 })).toBe(secondKey('c_1'));
    expect(tagOf({ id: 'c_1' })).toBe('c_1');
  });
});
