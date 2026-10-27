import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { opencodeRunner as runner } from '../src/scribe/opencode.js';
import { scribeOf, type Call } from '../src/scribe/run.js';
import { cleanHomes, makeHome, waitFor } from './helpers.js';

afterEach(cleanHomes);

// a stand-in for `opencode`: it records each run's arguments, its stdin and its env, then does what `body` says. Its
// export stops short on a pipe, as OpenCode's does when the reader stalls
const fakeOpencode = (dir: string, body: string, exported = '{}'): string => {
  const bin = path.join(dir, 'opencode');
  const out = `if [ -p /dev/stdout ]; then echo '${exported}' | head -c 20; else echo '${exported}'; fi`;
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${dir}/args"\nif [ "$1" = run ]; then cat > "${dir}/stdin"; echo "$OPENCODE_CONFIG_CONTENT" > "${dir}/config"; ${body}; fi\nif [ "$2" = export ]; then ${out}; fi\n`, { mode: 0o755 });
  return bin;
};
const argsOf = (dir: string) => fs.readFileSync(path.join(dir, 'args'), 'utf8');
// the scribe's passes: its model, nothing else
const opencodeRunner = (o: { cwd: string; bin: string } & Call) => scribeOf(runner({ cwd: o.cwd, bin: o.bin }), { model: o.model });
const line = (o: unknown) => `echo '${JSON.stringify(o)}'`;
const answers = [line({ type: 'step_start', sessionID: 'ses_1' }), line({ type: 'text', sessionID: 'ses_1', part: { text: 'thinking' } }), line({ type: 'text', sessionID: 'ses_1', part: { text: '{"note":"ok"}' } })].join('; ');

describe('opencodeRunner', () => {
  it('answers with the last text the run printed, the system prompt leading the one prompt it reads', async () => {
    const dir = makeHome();
    const run = opencodeRunner({ cwd: path.join(dir, 'scribe'), bin: fakeOpencode(dir, answers) });
    expect(await run('be brief', 'name this')).toBe('{"note":"ok"}');
    expect(fs.readFileSync(path.join(dir, 'stdin'), 'utf8')).toBe('be brief\n\n---\n\nname this');
    expect(fs.readFileSync(path.join(dir, 'args'), 'utf8').split('\n')[0]).toBe('run --standalone --format json --agent svall-scribe');
    // the transcript a pass reads is untrusted text, so its agent asks before every tool, which `opencode run` turns down,
    // and other robots' work never leaves the machine through a share
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'config'), 'utf8')))
      .toEqual({ share: 'disabled', agents: { 'svall-scribe': { mode: 'primary', permissions: [{ action: '*', resource: '*', effect: 'ask' }] } } });
  });

  it('passes a model only when one is configured', async () => {
    const dir = makeHome();
    await opencodeRunner({ model: 'opencode/big-pickle', cwd: dir, bin: fakeOpencode(dir, answers) })('s', 'p');
    expect(fs.readFileSync(path.join(dir, 'args'), 'utf8')).toContain('run --standalone --format json --agent svall-scribe -m opencode/big-pickle');
  });

  it('deletes the session the run left behind, and asks a pass nothing about what it spent', async () => {
    const dir = makeHome();
    await opencodeRunner({ cwd: dir, bin: fakeOpencode(dir, answers) })('s', 'p');
    await waitFor(() => argsOf(dir).includes('session delete --standalone ses_1'));
    expect(argsOf(dir)).not.toContain('session export');
  });

  const reply = (cost: number, input: number, output: number, reasoning: number, read: number) => ({ type: 'assistant', cost, tokens: { input, output, reasoning, cache: { read, write: 1 } } });
  const replies = [{ type: 'user', text: 'p' }, reply(0.01, 4, 10, 2, 100), reply(0.02, 6, 20, 0, 200)];

  it('runs a retro call on an agent that stops after three steps in a session it names, and reads what it spent off the whole export', async () => {
    const dir = makeHome();
    const exported = JSON.stringify({ info: {}, messages: replies });
    const answer = await runner({ cwd: dir, bin: fakeOpencode(dir, answers, exported), retro: true })('s', 'p', {});
    expect(answer).toEqual({ text: '{"note":"ok"}', usage: { input: 10, output: 32, reasoning: 2, cacheRead: 300, cacheWrite: 2, costUsd: 0.03 } });
    const args = argsOf(dir).split('\n');
    const session = /^run --standalone --format json --agent svall-retro --session (ses_[0-9a-f]{26})$/.exec(args[0])![1];
    expect(args[1]).toBe(`session export --standalone ${session}`);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'config'), 'utf8')).agents)
      .toEqual({ 'svall-retro': { mode: 'primary', steps: 3, permissions: [{ action: '*', resource: '*', effect: 'ask' }] } });
    await waitFor(() => argsOf(dir).includes(`session delete --standalone ${session}`));
  });

  it('takes a retro call\'s spend from the session\'s totals, which count its title call too', async () => {
    const dir = makeHome();
    const exported = JSON.stringify({ info: { cost: 0.05, tokens: { input: 13, output: 40, reasoning: 2, cache: { read: 300, write: 900 } } }, messages: replies });
    const answer = await runner({ cwd: dir, bin: fakeOpencode(dir, answers, exported), retro: true })('s', 'p', {});
    expect(answer.usage).toEqual({ input: 13, output: 42, reasoning: 2, cacheRead: 300, cacheWrite: 900, costUsd: 0.05 });
    await waitFor(() => argsOf(dir).includes('session delete'));
  });

  it('deletes the session of a retro call that is stopped', async () => {
    const dir = makeHome();
    const stop = new AbortController();
    const call = runner({ cwd: dir, bin: fakeOpencode(dir, 'exec sleep 30'), retro: true })('s', 'p', {}, stop.signal);
    await waitFor(() => fs.existsSync(path.join(dir, 'args')));
    stop.abort();
    await expect(call).rejects.toThrow('opencode run stopped');
    const session = /--session (\S+)/.exec(argsOf(dir))![1];
    await waitFor(() => argsOf(dir).includes(`session delete --standalone ${session}`));
  });

  it('names the error the run printed when it gave no answer', async () => {
    const dir = makeHome();
    const failed = line({ type: 'error', sessionID: 'ses_1', error: { type: 'provider.auth', message: 'no key for anthropic' } });
    const run = opencodeRunner({ cwd: dir, bin: fakeOpencode(dir, `${failed}; exit 1`) });
    await expect(run('s', 'p')).rejects.toThrow('opencode run failed: no key for anthropic');
  });
});
