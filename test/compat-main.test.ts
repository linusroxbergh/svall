import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { claudeRelease, HARNESSES, Unreachable, type Harness } from '../scripts/compat/harnesses.js';
import { checkInstalled, checkRelease, findings, type Report } from '../scripts/compat/main.js';

afterEach(() => { vi.unstubAllGlobals(); });

const harness = (over: Partial<Harness>): Harness => ({
  latest: async () => ({ version: '1.0.0', fresh: '1.0.0' }),
  files: async () => ({}),
  check: () => ({ missing: [], events: ['A', 'B'] }),
  ...over,
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'compat-'));

test('a vendor that can\'t be reached is a problem, not a pass', async () => {
  const r = await checkRelease('codex', {}, harness({ latest: async () => { throw new Unreachable('api.github.com: HTTP 403'); } }));
  expect(r.problems).toEqual(["couldn't check: api.github.com: HTTP 403"]);
});

test('a vendor answer that breaks off or isn\'t what was asked for is a problem, not a crash', async () => {
  const r = await checkRelease('codex', {}, harness({ files: async () => { throw new SyntaxError('Unexpected token <'); } }));
  expect(r.problems).toEqual(["couldn't check: Unexpected token <"]);
});

test('an Agent SDK tarball that breaks off mid-download can\'t be checked, rather than having lost its types', async () => {
  const doc = { versions: { '0.3.296': { claudeCodeVersion: '2.1.296', dist: { tarball: 'https://registry.example/sdk.tgz' } } } };
  vi.stubGlobal('fetch', async (url: string) => (url.endsWith('.tgz')
    ? { ok: true, status: 200, arrayBuffer: () => Promise.reject(new TypeError('terminated')) }
    : new Response(JSON.stringify(doc))));
  await expect(HARNESSES.claude.files('2.1.296')).rejects.toThrow('terminated');
});

test('a Claude Code release whose Agent SDK is not out yet checks the newest one that is', () => {
  expect(claudeRelease('2.1.297', ['2.1.295', '2.1.296'])).toEqual({ version: '2.1.296', fresh: '2.1.297', note: 'no Agent SDK for 2.1.297 yet' });
  expect(claudeRelease('2.1.296', ['2.1.296'])).toEqual({ version: '2.1.296', fresh: '2.1.296' });
});

test('an installed CLI\'s help is read for each flag, and a help that prints nothing says so', () => {
  const bin = path.join(tmp(), 'codex');
  const lines = (...entries: string[]) => `printf '${entries.map((e) => `  ${e}  x\\n`).join('')}'`;
  fs.writeFileSync(bin, ['#!/bin/sh', 'case "$1 $2" in',
    '"--version ") echo "codex-cli 9.9.9";;',
    `"--help ") ${lines('resume', 'exec', 'login')};;`,
    `"exec --help") ${lines('--json', '-m, --model', '-c, --config', '--sandbox', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '-o, --output-last-message')};;`,
    `"login --help") ${lines('status')};;`,
    'esac', ''].join('\n'), { mode: 0o755 });
  const r: Report = { kind: 'codex', events: [], problems: [], added: [], notes: [] };
  checkInstalled(r, bin);
  expect(r.installed).toBe('codex-cli 9.9.9');
  expect(r.problems).toEqual(['`codex --help` no longer lists app-server', '`codex resume --help` printed nothing']);
});

test('a CLI that isn\'t installed is noted, not failed', () => {
  const r: Report = { kind: 'opencode', events: [], problems: [], added: [], notes: [] };
  checkInstalled(r, path.join(tmp(), 'opencode'));
  expect(r.problems).toEqual([]);
  expect(r.notes).toEqual(["opencode isn't installed; its flags went unchecked"]);
});

test('findings name each problem and new event by CLI, and leave notes out', () => {
  const r: Report = { kind: 'opencode', version: '2.0.26', events: [], problems: ['gone: event form.created'], added: ['session.moved'], notes: ['a note'] };
  expect(findings([r])).toEqual(['opencode: gone: event form.created', 'opencode: new event session.moved']);
});
