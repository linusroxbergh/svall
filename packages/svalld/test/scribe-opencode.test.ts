import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { opencodeRunner } from '../src/scribe/opencode.js';
import { cleanHomes, makeHome, waitFor } from './helpers.js';

afterEach(cleanHomes);

// a stand-in for `opencode`: it records each run's arguments, its stdin and its env, then does what `body` says
const fakeOpencode = (dir: string, body: string): string => {
  const bin = path.join(dir, 'opencode');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${dir}/args"\nif [ "$1" = run ]; then cat > "${dir}/stdin"; echo "$OPENCODE_CONFIG_CONTENT" > "${dir}/config"; ${body}; fi\n`, { mode: 0o755 });
  return bin;
};
const line = (o: unknown) => `echo '${JSON.stringify(o)}'`;
const answers = [line({ type: 'step_start', sessionID: 'ses_1' }), line({ type: 'text', sessionID: 'ses_1', part: { text: 'thinking' } }), line({ type: 'text', sessionID: 'ses_1', part: { text: '{"note":"ok"}' } })].join('; ');

describe('opencodeRunner', () => {
  it('answers with the last text the run printed, the system prompt leading the one prompt it reads', async () => {
    const dir = makeHome();
    const run = opencodeRunner({ cwd: path.join(dir, 'scribe'), bin: fakeOpencode(dir, answers) });
    expect(await run('be brief', 'name this')).toBe('{"note":"ok"}');
    expect(fs.readFileSync(path.join(dir, 'stdin'), 'utf8')).toBe('be brief\n\n---\n\nname this');
    expect(fs.readFileSync(path.join(dir, 'args'), 'utf8').split('\n')[0]).toBe('run --format json --pure --agent svall-scribe');
    // the transcript a pass reads is untrusted text, so its agent asks before every tool, which `opencode run` turns down
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'config'), 'utf8'))).toEqual({ agent: { 'svall-scribe': { mode: 'primary', permission: { '*': 'ask' } } } });
  });

  it('passes a model only when one is configured', async () => {
    const dir = makeHome();
    await opencodeRunner({ model: 'opencode/big-pickle', cwd: dir, bin: fakeOpencode(dir, answers) })('s', 'p');
    expect(fs.readFileSync(path.join(dir, 'args'), 'utf8')).toContain('run --format json --pure --agent svall-scribe -m opencode/big-pickle');
  });

  it('deletes the session the run left behind', async () => {
    const dir = makeHome();
    await opencodeRunner({ cwd: dir, bin: fakeOpencode(dir, answers) })('s', 'p');
    await waitFor(() => fs.readFileSync(path.join(dir, 'args'), 'utf8').includes('session delete ses_1'));
  });

  it('names the error the run printed when it gave no answer', async () => {
    const dir = makeHome();
    const failed = line({ type: 'error', sessionID: 'ses_1', error: { name: 'ProviderAuthError', data: { message: 'no key for anthropic' } } });
    const run = opencodeRunner({ cwd: dir, bin: fakeOpencode(dir, `${failed}; exit 1`) });
    await expect(run('s', 'p')).rejects.toThrow('opencode run failed: no key for anthropic');
  });
});
