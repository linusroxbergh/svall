import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeRunner, perPass, scribeOf } from '../src/scribe/run.js';
import { cleanHomes, makeHome } from './helpers.js';

// a stand-in for `claude -p`, found first on PATH; FAKE_CLAUDE picks how it answers
const FAKE = `#!/bin/sh
cat > /dev/null
[ -n "$FAKE_ARGS" ] && { echo "$@"; echo "cache=\${DISABLE_PROMPT_CACHING:-on}"; } > "$FAKE_ARGS"
case "$FAKE_CLAUDE" in
  ok) echo "{\\"result\\":\\"robot=\${SVALL_ROBOT_ID:-none}\\"}" ;;
  usage) echo '{"result":"hi","total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":2,"cache_creation_input_tokens":1,"output_tokens_details":{"thinking_tokens":3}}}' ;;
  structured) echo '{"result":"{ \\"notes\\": [] }","structured_output":{"notes":[]}}' ;;
  env) echo "{\\"result\\":\\"key=\${ANTHROPIC_API_KEY:-none} other=\${OTHER:-none}\\"}" ;;
  error) echo '{"is_error":true,"result":"overloaded"}' ;;
  exit) echo 'no credentials' >&2; exit 3 ;;
  said) echo 'the transcript said this'; exit 2 ;;
  prose) echo 'the transcript said this' ;;
  login) echo '{"is_error":true,"result":"Invalid API key · Please run /login"}'; exit 1 ;;
  hang) exec sleep 5 ;;
esac
`;

describe('claudeRunner', () => {
  const env = { PATH: process.env.PATH, SVALL_ROBOT_ID: process.env.SVALL_ROBOT_ID, FAKE_CLAUDE: process.env.FAKE_CLAUDE, FAKE_ARGS: process.env.FAKE_ARGS, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  let claude: ReturnType<typeof claudeRunner>;
  let run: (system: string, prompt: string, signal?: AbortSignal) => Promise<string>;
  let envFile: string;
  let home: string;

  beforeEach(() => {
    home = makeHome();
    fs.writeFileSync(path.join(home, 'claude'), FAKE, { mode: 0o755 });
    process.env.PATH = `${home}:${env.PATH}`;
    process.env.SVALL_ROBOT_ID = 'c_parent';
    delete process.env.ANTHROPIC_API_KEY;
    envFile = path.join(home, '.env');
    claude = claudeRunner({ cwd: path.join(home, 'scribe'), envFile });
    run = scribeOf(claude, { model: 'sonnet', timeoutMs: 2000 });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    cleanHomes();
  });

  it('answers with the result, run without the robot id', async () => {
    process.env.FAKE_CLAUDE = 'ok';
    await expect(run('system', 'prompt')).resolves.toBe('robot=none');
  });

  it('passes the fleet .env to claude, read afresh on every pass', async () => {
    process.env.FAKE_CLAUDE = 'env';
    await expect(run('system', 'prompt')).resolves.toBe('key=none other=none');
    fs.writeFileSync(envFile, '# for the scribe\nANTHROPIC_API_KEY="sk-ant-test"\n\nexport OTHER=\'a b\'\nnot a line\n');
    await expect(run('system', 'prompt')).resolves.toBe('key=sk-ant-test other=a b');
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('rejects an error result, a failed exit and a pass that hangs', async () => {
    process.env.FAKE_CLAUDE = 'error';
    await expect(run('system', 'prompt')).rejects.toThrow(/^claude -p failed: overloaded$/);
    process.env.FAKE_CLAUDE = 'login';
    await expect(run('system', 'prompt')).rejects.toThrow(/^claude -p failed: Invalid API key · Please run \/login$/);
    process.env.FAKE_CLAUDE = 'exit';
    await expect(run('system', 'prompt')).rejects.toMatchObject({ message: 'claude -p exited 3', cause: 'no credentials' });
    process.env.FAKE_CLAUDE = 'hang';
    await expect(run('system', 'prompt')).rejects.toThrow('timed out after 2000ms');
  });

  it('ends a pass that is aborted, at once', async () => {
    process.env.FAKE_CLAUDE = 'hang';
    const aborter = new AbortController();
    const pending = run('system', 'prompt', aborter.signal);
    aborter.abort();
    await expect(pending).rejects.toThrow(/^claude -p stopped$/);
  });

  it('answers what the call spent', async () => {
    process.env.FAKE_CLAUDE = 'usage';
    await expect(claude('system', 'prompt', {})).resolves.toEqual({
      text: 'hi', usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3, costUsd: 0.01 },
    });
  });

  it('asks for an effort and a schema only when the call does, and turns the cache off only for a retro call', async () => {
    process.env.FAKE_CLAUDE = 'ok';
    process.env.FAKE_ARGS = path.join(home, 'args');
    await run('system', 'prompt');
    const scribe = fs.readFileSync(process.env.FAKE_ARGS, 'utf8');
    expect(scribe).toContain('-p --model sonnet --output-format json');
    expect(scribe).not.toContain('--effort');
    expect(scribe).not.toContain('--json-schema');
    expect(scribe).toContain('cache=on');
    await claudeRunner({ cwd: path.join(home, 'retro'), envFile, retro: true })('system', 'prompt', { effort: 'low', schema: { type: 'object' } });
    const retro = fs.readFileSync(process.env.FAKE_ARGS, 'utf8');
    expect(retro).toContain('-p --effort low --json-schema {"type":"object"} --output-format json');
    expect(retro).toContain('cache=1');
  });

  it('answers the structured output when the call gave a schema', async () => {
    process.env.FAKE_CLAUDE = 'structured';
    await expect(claude('system', 'prompt', { schema: { type: 'object' } })).resolves.toMatchObject({ text: '{"notes":[]}' });
  });

  // what it prints on stdout is the model's own text, from a transcript
  it('keeps what claude printed on stdout out of the error', async () => {
    process.env.FAKE_CLAUDE = 'said';
    await expect(run('system', 'prompt')).rejects.toThrow(/^claude -p exited 2$/);
    await expect(run('system', 'prompt')).rejects.not.toHaveProperty('cause');
    process.env.FAKE_CLAUDE = 'prose';
    await expect(run('system', 'prompt')).rejects.toThrow(/^claude -p printed no result$/);
  });
});

describe('perPass', () => {
  it('runs each pass on the runner picked at that moment', async () => {
    let name = 'claude';
    const run = perPass(() => { const picked = name; return async () => `from ${picked}`; });
    expect(await run('s', 'p')).toBe('from claude');
    name = 'codex';
    expect(await run('s', 'p')).toBe('from codex');
  });
});
