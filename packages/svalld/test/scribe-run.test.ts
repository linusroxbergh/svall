import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentKind } from '@svall/protocol';
import { claudeRunner, perPass } from '../src/scribe/run.js';
import { cleanHomes, makeHome } from './helpers.js';

// a stand-in for `claude -p`, found first on PATH; FAKE_CLAUDE picks how it answers
const FAKE = `#!/bin/sh
cat > /dev/null
case "$FAKE_CLAUDE" in
  ok) echo "{\\"result\\":\\"char=\${SVALL_CHAR_ID:-none}\\"}" ;;
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
  const env = { PATH: process.env.PATH, SVALL_CHAR_ID: process.env.SVALL_CHAR_ID, FAKE_CLAUDE: process.env.FAKE_CLAUDE, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  let run: ReturnType<typeof claudeRunner>;
  let envFile: string;

  beforeEach(() => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'claude'), FAKE, { mode: 0o755 });
    process.env.PATH = `${home}:${env.PATH}`;
    process.env.SVALL_CHAR_ID = 'c_parent';
    delete process.env.ANTHROPIC_API_KEY;
    envFile = path.join(home, '.env');
    run = claudeRunner({ model: 'sonnet', cwd: path.join(home, 'scribe'), envFile, timeoutMs: 2000 });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    cleanHomes();
  });

  it('answers with the result, run without the character id', async () => {
    process.env.FAKE_CLAUDE = 'ok';
    await expect(run('system', 'prompt')).resolves.toBe('char=none');
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
  it('runs each pass on the CLI named at that moment', async () => {
    let agent: AgentKind = 'claude';
    const run = perPass({ claude: async () => 'from claude', codex: async () => 'from codex', opencode: async () => 'from opencode' }, () => agent);
    expect(await run('s', 'p')).toBe('from claude');
    agent = 'codex';
    expect(await run('s', 'p')).toBe('from codex');
    agent = 'opencode';
    expect(await run('s', 'p')).toBe('from opencode');
  });
});
