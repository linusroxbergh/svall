import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HANDOVER_PHASES, HandoverError, HandoverIssueCode } from '@svall/protocol';
import { AGENT_KINDS } from '@svall/svalld/agents';
import { HANDOVER_KINDS } from '@svall/svalld/handover/sessions/registry';
import { AUTHORITY_ERROR_CODES } from '@svall/svalld/gateway/authority';

const read = (rel: string): string => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const CATALOGUE = read('../../../docs/remote-machines/errors.md');
// the helper's events, outcomes and verdicts, which the app reads too
const EVENTS = read('../../protocol/src/handover-events.ts');
const SSH = read('../src/controller/ssh.ts');
const HOST = read('../src/controller/host.ts');
const DOCTOR = read('../src/commands/doctor.ts');
const PREFLIGHT = read('../src/commands/preflight.ts');
const RECOVER = read('../src/commands/fleet-recover.ts');
const GATEWAY_CLIENT = read('../../svalld/src/gateway/client.ts');

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

/** The literals a field takes in every member of a union, as `field: 'a' | 'b'`. */
const fieldValues = (text: string, field: string): string[] =>
  all(text, new RegExp(`\\b${field}: ([^;,}]+)`, 'g')).flatMap((type) => literals(type, `${field}:`));

// the codes the code names only in its text, not in a list it exports
const named = {
  statuses: (text: string) => all(text, /\|\s*\{\s*status: '([^']+)'/g),
  events: (text: string) => all(text, /event: '(handover\.[^']+)'/g),
  steps: (text: string) => all(text, /run\.step\('([^']+)'/g),
  checks: (text: string) => [...all(text, /name: '([^']+)'/g), ...all(text, /(?:failed|unitCheck)\('([^']+)'/g)],
  failures: (text: string) => all(text, /new AuthorityFailure\('([^']+)'/g),
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
  '## Handover phases': () => [...HANDOVER_PHASES],
  '## Blockers and warnings': () => [...HandoverIssueCode.options],
  '## Daemon refusals': () => HandoverError.options.map((o) => o.shape.code.value),
  '## Gateway answers': () => [...AUTHORITY_ERROR_CODES, ...named.failures(GATEWAY_CLIENT)],
  '## How a run ends': () => named.statuses(EVENTS),
  '### Standing': () => union(EVENTS, 'export type Standing ='),
  '### Action': () => union(EVENTS, '  action:'),
  '## Events': () => named.events(EVENTS),
  '## Connection errors': () => union(SSH, 'export type SshErrorKind ='),
  '### Step statuses': () => union(HOST, 'export type StepStatus ='),
  // an agent's step and check are named by its kind; Add Machine checks only the agents a handover carries
  '### Steps': () => [...named.steps(HOST), ...HANDOVER_KINDS],
  '### Doctor checks': () => [...named.checks(DOCTOR), ...named.checks(PREFLIGHT), ...named.checks(HOST), ...AGENT_KINDS],
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

  it('reads a code whatever its name holds, and refuses a type it cannot read', () => {
    expect(named.steps("await run.step('agent-login', f); await run.step('rsync2', g);")).toEqual(['agent-login', 'rsync2']);
    expect(named.statuses("  | { status: 'timed_out'; phase: HandoverPhase }")).toEqual(['timed_out']);
    expect(named.events("  | { event: 'handover.gave_up'; data: { pid: number } }")).toEqual(['handover.gave_up']);
    expect(named.checks("{ name: 'gh-auth', status: 'ok' }; checks.push(failed('disk2', err));")).toEqual(['gh-auth', 'disk2']);
    expect(named.failures("throw new AuthorityFailure('socket_2big', message);")).toEqual(['socket_2big']);
    expect(() => union("export type SshErrorKind = TunnelKind | 'auth';", 'export type SshErrorKind =')).toThrow(/not a union of string literals/);
    expect(() => fieldValues("  | { state: 'absent' }\n  | { state: GoneState; message: string };", 'state')).toThrow(/not a union of string literals/);
  });
});
