import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { claudeRelease, Unreachable, type Harness } from '../scripts/compat/harnesses.js';
import { checkInstalled, checkRelease, notify, type Report } from '../scripts/compat/main.js';

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

test('a fresh install below the version Svall needs is a problem', async () => {
  const r = await checkRelease('opencode', {}, harness({ latest: async () => ({ version: '2.0.26', fresh: '1.19.0' }) }));
  expect(r.problems).toEqual(['a fresh install (curl -fsSL https://opencode.ai/install | bash) gets 1.19.0, below the 2.0.22 Svall needs']);
});

test('events the snapshot lacks are reported as new, and none without a snapshot', async () => {
  expect((await checkRelease('codex', { codex: { version: '0.9.0', events: ['A'] } }, harness({}))).added).toEqual(['B']);
  expect((await checkRelease('codex', {}, harness({}))).added).toEqual([]);
});

test('a Claude Code release whose Agent SDK is not out yet checks the newest one that is', () => {
  expect(claudeRelease('2.1.297', ['2.1.295', '2.1.296'])).toEqual({ version: '2.1.296', fresh: '2.1.297', note: 'no Agent SDK for 2.1.297 yet' });
  expect(claudeRelease('2.1.296', ['2.1.296'])).toEqual({ version: '2.1.296', fresh: '2.1.296' });
});

test('an installed CLI\'s help is read for each flag, and a help that prints nothing says so', () => {
  const bin = path.join(tmp(), 'codex');
  fs.writeFileSync(bin, '#!/bin/sh\ncase "$1 $2" in\n"--version ") echo "codex-cli 9.9.9";;\n"--help ") echo "  resume  exec  login";;\n"exec --help") echo "  --json -m -c --sandbox --skip-git-repo-check --ephemeral --ignore-user-config -o";;\n"login --help") echo "  status";;\nesac\n', { mode: 0o755 });
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

test('the same report notifies once, and again after a clean run', () => {
  const dir = tmp();
  const sent: string[] = [];
  const send = (title: string) => { sent.push(title); };
  const text = 'codex 1.0.0 (installed: none): NEEDS A LOOK\n  - gone: EventMsg.token_count';
  expect(notify(text, true, dir, send)).toBe(true);
  expect(notify(text, true, dir, send)).toBe(false);
  expect(notify('codex 1.0.0 (installed: none): ok', false, dir, send)).toBe(false);
  expect(notify(text, true, dir, send)).toBe(true);
  expect(sent).toEqual(['gone: EventMsg.token_count', 'gone: EventMsg.token_count']);
  expect(fs.readFileSync(path.join(dir, 'report.txt'), 'utf8')).toContain(text);
});
