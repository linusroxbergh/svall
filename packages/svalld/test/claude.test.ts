import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { characterKeyEnv, readEnvFile, spawnClaude } from '../src/claude.js';
import { cleanHomes, makeHome } from './helpers.js';

// a stand-in for `claude`, found first on PATH: it reports its own arguments and the environment it was given
const FAKE = `#!/bin/sh
cat > /dev/null
echo "args=$*"
echo "char=\${SVALL_CHAR_ID:-none}"
echo "key=\${ANTHROPIC_API_KEY:-none}"
echo "cwd=$(pwd)"
`;

const read = (o: { args: string[]; cwd: string; envFile: string }): Promise<string> =>
  new Promise((resolve, reject) => {
    const proc = spawnClaude(o);
    let out = '';
    proc.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    proc.on('error', reject);
    proc.on('close', () => resolve(out));
    proc.stdin.end('');
  });

describe('spawnClaude', () => {
  let home: string;
  let cwd: string;
  let envFile: string;

  beforeEach(() => {
    home = makeHome();
    fs.writeFileSync(path.join(home, 'claude'), FAKE, { mode: 0o755 });
    vi.stubEnv('PATH', `${home}:${process.env.PATH}`);
    vi.stubEnv('SVALL_CHAR_ID', 'c_parent');
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);
    cwd = path.join(home, 'pass');
    envFile = path.join(home, '.env');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    cleanHomes();
  });

  it('adds the isolation flags to whatever the caller asked for', async () => {
    const out = await read({ args: ['-p', '--model', 'sonnet'], cwd, envFile });
    expect(out).toContain('args=-p --model sonnet --tools  --setting-sources project --strict-mcp-config --no-session-persistence');
  });

  it('runs without the character id, so the hook does not mistake the pass for a character', async () => {
    await expect(read({ args: [], cwd, envFile })).resolves.toContain('char=none');
  });

  it('passes the fleet .env, read afresh on every spawn', async () => {
    fs.writeFileSync(envFile, 'ANTHROPIC_API_KEY="sk-one"\n');
    await expect(read({ args: [], cwd, envFile })).resolves.toContain('key=sk-one');
    fs.writeFileSync(envFile, 'ANTHROPIC_API_KEY=sk-two\n');
    await expect(read({ args: [], cwd, envFile })).resolves.toContain('key=sk-two');
  });

  it('runs in its own empty folder, made if it is missing', async () => {
    expect(fs.existsSync(cwd)).toBe(false);
    await expect(read({ args: [], cwd, envFile })).resolves.toContain(`cwd=${fs.realpathSync(home)}/pass`);
  });
});

describe('readEnvFile', () => {
  afterEach(cleanHomes);

  it('reads KEY=value, quoted or after export, and skips the rest', () => {
    const file = path.join(makeHome(), '.env');
    fs.writeFileSync(file, '# a comment\nA=1\nexport B="two"\nC=\'three\'\nnot a line\n');
    expect(readEnvFile(file)).toEqual({ A: '1', B: 'two', C: 'three' });
  });

  it('reads a missing file as empty', () => {
    expect(readEnvFile('/tmp/svall-no-such-env')).toEqual({});
  });

  it('passes only agent API keys to character shells', () => {
    const file = path.join(makeHome(), '.env');
    fs.writeFileSync(file, 'ANTHROPIC_API_KEY=anthropic\nOPENAI_API_KEY=openai\nOTHER_SECRET=private\nSVALL_CHAR_ID=wrong\n');
    expect(characterKeyEnv(file)).toEqual({ ANTHROPIC_API_KEY: 'anthropic', OPENAI_API_KEY: 'openai' });
  });
});
