import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FEEDBACK_DIAGNOSTICS_MAX, type SystemInfo } from '@svall/protocol';
import { dispatch, type Ctx } from '../src/api/methods.js';
import { diagnostics } from '../src/feedback.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

const info = {
  machineId: 'm', release: '0.22.0', protocol: 1, stateSchema: 1, platform: 'darwin', arch: 'arm64', git: '2.50.0',
  agentAdapters: [{ kind: 'claude', version: '2.1.296', adapter: 1, hooks: true, loggedIn: true }, { kind: 'codex', adapter: 1 }],
} as SystemInfo;

function logOf(n: number, pad = '') {
  const home = makeHome();
  const log = path.join(home, 'svalld.log');
  fs.writeFileSync(log, Array.from({ length: n }, (_, i) => `line ${i} ${home}/.svall${pad}`).join('\n') + '\n');
  return { home, log };
}

describe('diagnostics', () => {
  it('has the header, agents, the last 200 log lines, home masked', async () => {
    const { home, log } = logOf(250);
    const text = await diagnostics({ info: async () => info, log, home, macos: async () => '26.0' });
    const lines = text.split('\n');
    expect(lines[0]).toBe('svall 0.22.0 · macOS 26.0 · arm64');
    expect(lines[1]).toBe('git 2.50.0');
    expect(text).toContain('claude 2.1.296 · hooks on · logged in');
    expect(text).toContain('\ncodex ?\n');
    expect(text).toContain('svalld.log, last 200 lines');
    expect(text).toContain('line 249');
    expect(text).not.toContain('line 49 ');
    expect(text).toContain('line 50 ');
    expect(text).not.toContain(home);
  });

  it('still answers without a log or a macOS version', async () => {
    const text = await diagnostics({ info: async () => info, log: '/nonexistent/svalld.log', home: '/h', macos: async () => undefined });
    expect(text.split('\n')[0]).toBe('svall 0.22.0 · macOS ? · arm64');
    expect(text).toContain('(no log)');
  });

  it('stays under the cap by dropping the oldest log lines', async () => {
    const { home, log } = logOf(200, 'x'.repeat(1000));
    const text = await diagnostics({ info: async () => info, log, home, macos: async () => '26.0' });
    expect(text.length).toBeLessThanOrEqual(FEEDBACK_DIAGNOSTICS_MAX);
    expect(text).toContain('line 199');
    expect(text).not.toContain('line 0 ');
  });
});

describe('diagnostics of one huge line', () => {
  it('cuts the start of the line so the text fits', async () => {
    const home = makeHome();
    const log = path.join(home, 'svalld.log');
    fs.writeFileSync(log, `${'a'.repeat(60_000)}END\n`);
    const text = await diagnostics({ info: async () => info, log, home, macos: async () => '26.0' });
    expect(text.length).toBe(FEEDBACK_DIAGNOSTICS_MAX);
    expect(text.endsWith('aaaEND')).toBe(true);
    expect(text.split('\n')[0]).toBe('svall 0.22.0 · macOS 26.0 · arm64');
  });
});

describe('feedback.preview', () => {
  it("answers diagnostics' text, and refuses where none are wired", async () => {
    const ctx = { diagnostics: async () => 'the text' } as Ctx;
    expect(await dispatch({ id: 1, method: 'feedback.preview', params: {} }, ctx)).toEqual({ id: 1, result: { text: 'the text' } });
    expect(await dispatch({ id: 2, method: 'feedback.preview', params: {} }, {} as Ctx)).toMatchObject({ id: 2, error: { code: 'not_on_worker' } });
  });
});
