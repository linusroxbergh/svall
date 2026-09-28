import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HANDOVER_PHASES, HandoverError, HandoverIssueCode } from '@archipelago/protocol';
import { AGENT_KINDS } from '@archipelago/archid/agents';
import { AUTHORITY_ERROR_CODES } from '@archipelago/archid/gateway/authority';

const read = (rel: string): string => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const CATALOGUE = read('../../../docs/remote-machines/errors.md');
const EVENTS = read('../src/controller/events.ts');
const RECOVERY = read('../src/controller/recovery.ts');
const SSH = read('../src/controller/ssh.ts');
const HOST = read('../src/controller/host.ts');
const DOCTOR = read('../src/commands/doctor.ts');
const RECOVER = read('../src/commands/fleet-recover.ts');
const GATEWAY_CLIENT = read('../../archid/src/gateway/client.ts');

const all = (text: string, pattern: RegExp): string[] => [...text.matchAll(pattern)].map((m) => m[1]);
const quoted = (text: string): string[] => all(text, /'([^']+)'/g);

/** The string literals of a union declared as `start …;`, a type written on one line. */
function union(text: string, start: string): string[] {
  const at = text.indexOf(start);
  if (at < 0) throw new Error(`no ${start}`);
  return quoted(text.slice(at + start.length, text.indexOf(';', at)));
}

/** The literals a field takes in every member of a union, as `field: 'a' | 'b'`. */
const fieldValues = (text: string, field: string): string[] =>
  all(text, new RegExp(`${field}: ((?:'[^']+'(?:\\s*\\|\\s*)?)+)`, 'g')).flatMap(quoted);

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
  '## Handover phases': () => [...HANDOVER_PHASES],
  '## Blockers and warnings': () => [...HandoverIssueCode.options],
  '## Daemon refusals': () => HandoverError.options.map((o) => o.shape.code.value),
  '## Gateway answers': () => [...AUTHORITY_ERROR_CODES, ...all(GATEWAY_CLIENT, /new AuthorityFailure\('([a-z_]+)'/g)],
  '## How a run ends': () => all(EVENTS, /\|\s*\{\s*status: '([a-z]+)'/g),
  '### Standing': () => union(RECOVERY, 'export type Standing ='),
  '### Action': () => union(RECOVERY, '  action:'),
  '## Events': () => all(EVENTS, /event: '(handover\.[a-z]+)'/g),
  '## Connection errors': () => union(SSH, 'export type SshErrorKind ='),
  '### Step statuses': () => union(HOST, 'export type StepStatus ='),
  // an agent's step and check are named by its kind
  '### Steps': () => [...all(HOST, /run\.step\('([a-z]+)'/g), ...AGENT_KINDS],
  '### Doctor checks': () => [
    ...[DOCTOR, HOST].flatMap((text) => [...all(text, /name: '([a-z ]+)'/g), ...all(text, /(?:failed|unitCheck)\('([a-z ]+)'/g)]),
    ...AGENT_KINDS,
  ],
  '### What the gateway holds': () => fieldValues(RECOVER.slice(RECOVER.indexOf('export type Held ='), RECOVER.indexOf('/** What one machine holds')), 'state'),
  '### Results': () => fieldValues(RECOVER, 'result'),
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
});
