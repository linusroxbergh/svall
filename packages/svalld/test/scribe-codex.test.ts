import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config, modelPicks } from '../src/config.js';
import { codexRunner as runner } from '../src/scribe/codex.js';
import { scribeOf, type Call } from '../src/scribe/run.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

// a stand-in for `codex`: it records its arguments and its stdin, then does what `body` says
const fakeCodex = (dir: string, body: string): string => {
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" > "${dir}/args"\ncat > "${dir}/stdin"\n${body}\n`, { mode: 0o755 });
  return bin;
};
const writeAnswer = `while [ "$1" != "-o" ]; do shift; done; printf '{"note":"ok"}' > "$2"`;
// the scribe's passes: its model and deadline, nothing else
const codexRunner = (o: { cwd: string; bin: string } & Call) => scribeOf(runner({ cwd: o.cwd, bin: o.bin }), { model: o.model, timeoutMs: o.timeoutMs });

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

describe('codexRunner for the retro', () => {
  const turn = (input: number, cached: number, output: number, reasoning: number) =>
    `echo '${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning } })}'`;

  it('turns the shell and codex\'s other default tools off, hands codex the schema and adds up what each turn spent', async () => {
    const dir = makeHome();
    const keep = `while [ "$1" != "--output-schema" ]; do shift; done; cp "$2" "${dir}/schema"`;
    const bin = fakeCodex(dir, `(${keep}); ${turn(100, 40, 10, 4)}; ${turn(50, 0, 5, 0)}; ${writeAnswer}`);
    const answer = await runner({ cwd: dir, bin, retro: true })('s', 'p', { effort: 'medium', schema: { type: 'object', required: ['notes'] } });
    expect(answer).toEqual({ text: '{"note":"ok"}', usage: { input: 110, output: 15, cacheRead: 40, cacheWrite: 0, reasoning: 4 } });
    const args = fs.readFileSync(path.join(dir, 'args'), 'utf8');
    expect(args).toContain('-c model_reasoning_effort="medium" -c features.shell_tool=false -c web_search="disabled" '
      + '--disable multi_agent --disable apps --disable view_image --disable image_generation --disable plugins --disable browser_use --disable computer_use');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'schema'), 'utf8'))).toEqual({ type: 'object', required: ['notes'] });
  });

  it('leaves the scribe its tools and gives it no schema', async () => {
    const dir = makeHome();
    await codexRunner({ cwd: dir, bin: fakeCodex(dir, writeAnswer) })('s', 'p');
    const args = fs.readFileSync(path.join(dir, 'args'), 'utf8');
    for (const flag of ['shell_tool', 'web_search', '--disable', '--output-schema']) expect(args).not.toContain(flag);
  });

  it('leaves no folder behind when the schema can\'t be written', async () => {
    const dir = makeHome();
    vi.stubEnv('TMPDIR', dir);
    try {
      await expect(runner({ cwd: path.join(dir, 'scribe'), bin: fakeCodex(dir, writeAnswer), retro: true })('s', 'p', { schema: { n: 1n } })).rejects.toThrow(/BigInt/);
    } finally { vi.unstubAllEnvs(); }
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('svall-scribe-'))).toEqual([]);
  });
});

describe('scribe config', () => {
  it('runs on the main agent unless told otherwise, and leaves the codex model to codex', () => {
    expect(Config.parse({}).scribe).toEqual({});
    expect(Config.parse({ scribe: { agent: 'codex' } }).scribe).toEqual({ agent: 'codex' });
    expect(() => Config.parse({ scribe: { agent: 'cursor' } })).toThrow();
  });

  it("gives each CLI its own pick, and a single scribe.model to scribe.agent's CLI, else to claude's", () => {
    const picks = (c: object) => modelPicks(Config.parse(c), 'scribe');
    expect(picks({ scribe: { model: 'claude-haiku-4-5' } })).toEqual({ claude: 'claude-haiku-4-5' });
    expect(picks({ scribe: { agent: 'codex', model: 'gpt-6-luna' } })).toEqual({ codex: 'gpt-6-luna' });
    expect(picks({ scribe: { model: { codex: 'gpt-6-sol', opencode: 'opencode/big-pickle' } } })).toEqual({ codex: 'gpt-6-sol', opencode: 'opencode/big-pickle' });
    expect(picks({})).toEqual({});
    expect(modelPicks(Config.parse({ home: { model: { claude: 'sonnet' } } }), 'home')).toEqual({ claude: 'sonnet' });
    expect(() => Config.parse({ home: { model: 'sonnet' } })).toThrow();
    expect(() => Config.parse({ scribe: { model: { cursor: 'x' } } })).toThrow();
  });
});
