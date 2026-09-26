import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Config, scribeModel } from '../src/config.js';
import { codexRunner } from '../src/scribe/codex.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

// a stand-in for `codex`: it records its arguments and its stdin, then does what `body` says
const fakeCodex = (dir: string, body: string): string => {
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" > "${dir}/args"\ncat > "${dir}/stdin"\n${body}\n`, { mode: 0o755 });
  return bin;
};
const writeAnswer = `while [ "$1" != "-o" ]; do shift; done; printf '{"note":"ok"}' > "$2"`;

describe('codexRunner', () => {
  it('reads the answer out of the last-message file, the system prompt leading the one prompt exec takes', async () => {
    const dir = makeHome();
    const run = codexRunner({ cwd: path.join(dir, 'scribe'), bin: fakeCodex(dir, writeAnswer) });
    expect(await run('be brief', 'name this')).toBe('{"note":"ok"}');
    expect(fs.readFileSync(path.join(dir, 'stdin'), 'utf8')).toBe('be brief\n\n---\n\nname this');
    const args = fs.readFileSync(path.join(dir, 'args'), 'utf8');
    for (const flag of ['exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--sandbox read-only']) expect(args).toContain(flag);
    expect(args).not.toContain('-m ');
  });

  it('passes a model only when one is configured', async () => {
    const dir = makeHome();
    await codexRunner({ model: 'gpt-5.1-codex-mini', cwd: dir, bin: fakeCodex(dir, writeAnswer) })('s', 'p');
    expect(fs.readFileSync(path.join(dir, 'args'), 'utf8')).toContain('-m gpt-5.1-codex-mini');
  });

  it('names the cause codex reports on its event stream when the run fails', async () => {
    const dir = makeHome();
    const failed = JSON.stringify({ type: 'turn.failed', error: { message: JSON.stringify({ type: 'error', status: 400, error: { message: 'The model is not supported' } }) } });
    const run = codexRunner({ cwd: dir, bin: fakeCodex(dir, `echo '${failed}'; exit 1`) });
    await expect(run('s', 'p')).rejects.toThrow('codex exec failed: The model is not supported');
  });

  it('falls back to stderr, and says so when a run that exits clean wrote no answer', async () => {
    const dir = makeHome();
    await expect(codexRunner({ cwd: dir, bin: fakeCodex(dir, 'echo "not signed in" >&2; exit 1') })('s', 'p')).rejects.toMatchObject({ message: 'codex exec exited 1', cause: 'not signed in' });
    await expect(codexRunner({ cwd: dir, bin: fakeCodex(dir, 'exit 0') })('s', 'p')).rejects.toThrow(/wrote no answer/);
  });

  it('keeps the event stream, the model\'s own text, out of the error', async () => {
    const dir = makeHome();
    const said = `echo '{"type":"item.completed","item":{"type":"agent_message","text":"the transcript said this"}}'`;
    await expect(codexRunner({ cwd: dir, bin: fakeCodex(dir, `${said}; exit 1`) })('s', 'p')).rejects.toThrow(/^codex exec exited 1$/);
    await expect(codexRunner({ cwd: dir, bin: fakeCodex(dir, said) })('s', 'p')).rejects.toThrow(/^codex exec wrote no answer$/);
  });

  it('gives up on a run that hangs', async () => {
    const dir = makeHome();
    await expect(codexRunner({ cwd: dir, bin: fakeCodex(dir, 'exec sleep 30'), timeoutMs: 200 })('s', 'p')).rejects.toThrow(/timed out after 200ms/);
  });

  it('asks codex for low reasoning effort, and a model only when one is set', async () => {
    const dir = makeHome();
    await codexRunner({ cwd: dir, bin: fakeCodex(dir, writeAnswer) })('s', 'p');
    const args = fs.readFileSync(path.join(dir, 'args'), 'utf8');
    expect(args).toContain('-c model_reasoning_effort="low"');
    expect(args).not.toContain('-m ');
  });
});

describe('scribe config', () => {
  it('runs on the main agent unless told otherwise, and leaves the codex model to codex', () => {
    expect(Config.parse({}).scribe).toEqual({});
    expect(Config.parse({ scribe: { agent: 'codex' } }).scribe).toEqual({ agent: 'codex' });
    expect(() => Config.parse({ scribe: { agent: 'cursor' } })).toThrow();
  });

  it('gives scribe.model to the CLI it was set for', () => {
    expect(scribeModel({ model: 'haiku' }, 'claude')).toBe('haiku');
    expect(scribeModel({ model: 'haiku' }, 'codex')).toBeUndefined();
    expect(scribeModel({ agent: 'codex', model: 'gpt-6-luna' }, 'codex')).toBe('gpt-6-luna');
    expect(scribeModel({ agent: 'codex', model: 'gpt-6-luna' }, 'claude')).toBeUndefined();
  });
});
