import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_KINDS } from '@svall/svalld/agents';
import { HANDOVER_KINDS } from '@svall/svalld/sessions/registry';

const read = (rel: string): string => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const CATALOGUE = read('../../../docs/remote-machines/errors.md');
const SSH = read('../../svalld/src/link/ssh.ts');
const HOST = read('../src/controller/host.ts');
const DOCTOR = read('../src/commands/doctor.ts');
const PREFLIGHT = read('../src/commands/preflight.ts');

const all = (text: string, pattern: RegExp): string[] => [...text.matchAll(pattern)].map((m) => m[1]);
const quoted = (text: string): string[] => all(text, /'([^']+)'/g);

/** The literals of a type written as `'a' | 'b'`; one written any other way, such as through an alias, is refused. */
function literals(type: string, what: string): string[] {
  const body = type.trim();
  if (!/^\|?\s*'[^']+'(\s*\|\s*'[^']+')*$/.test(body)) throw new Error(`${what} is not a union of string literals: ${body}`);
  return quoted(body);
}

/** The literals of a union declared as `start …;`. */
function union(text: string, start: string): string[] {
  const at = text.indexOf(start);
  if (at < 0) throw new Error(`no ${start}`);
  return literals(text.slice(at + start.length, text.indexOf(';', at)), start);
}

// the codes the code names only in its text, not in a list it exports
const named = {
  steps: (text: string) => all(text, /run\.step\('([^']+)'/g),
  // a setup row's gap names what will not work there, not a check
  checks: (text: string) => [...all(text, /(?<!gap: \{ )name(?::| =) '([^']+)'/g), ...all(text, /(?:failed|unitCheck)\('([^']+)'/g)],
};

/** The first cell of every table row under `heading`, down to the next heading as high or higher. */
function listed(heading: string): string[] {
  const lines = CATALOGUE.split('\n');
  const at = lines.indexOf(heading);
  if (at < 0) throw new Error(`errors.md has no "${heading}"`);
  const level = heading.indexOf(' ');
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const h = /^(#+) /.exec(line);
    if (h && h[1].length <= level) break;
    const cell = /^\| `([^`]+)` \|/.exec(line);
    if (cell) out.push(cell[1]);
  }
  return out;
}

const sorted = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

// each list of codes a user can be shown, read from where the code declares or emits it
const CODES: Record<string, () => string[]> = {
  '## Connection errors': () => union(SSH, 'export type SshErrorKind ='),
  '### Step statuses': () => union(HOST, 'export type StepStatus ='),
  // an agent's step and check are named by its kind; Add Machine checks only the agents a move carries
  '### Steps': () => [...named.steps(HOST), ...HANDOVER_KINDS],
  '### Doctor checks': () => [...named.checks(DOCTOR), ...named.checks(PREFLIGHT), ...named.checks(HOST), ...AGENT_KINDS],
};

describe('the error catalogue', () => {
  for (const [heading, codes] of Object.entries(CODES)) {
    it(`lists every code under ${heading.replace(/^#+ /, '')} the code has, once, and none it lacks`, () => {
      const found = codes();
      expect(found.length).toBeGreaterThan(0);
      expect(sorted(listed(heading))).toEqual(sorted(found));
      expect(listed(heading)).toHaveLength(new Set(listed(heading)).size);
    });
  }

  it('reads a code whatever its name holds, and refuses a type it cannot read', () => {
    expect(named.steps("await run.step('agent-login', f); await run.step('rsync2', g);")).toEqual(['agent-login', 'rsync2']);
    expect(named.checks("{ name: 'gh-auth', status: 'ok' }; const name = 'disk 3'; checks.push(failed('disk2', err));")).toEqual(['gh-auth', 'disk 3', 'disk2']);
    expect(() => union("export type SshErrorKind = TunnelKind | 'auth';", 'export type SshErrorKind =')).toThrow(/not a union of string literals/);
  });
});
