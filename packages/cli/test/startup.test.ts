import path from 'node:path';
import { build, type Metafile } from 'esbuild';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');
const cli = 'packages/cli/src';
// the method schemas, which only a command that parses a daemon's answer with them needs
const SCHEMAS = /^packages\/protocol\/src\/(index|messages)\.ts$/;

// the files `from` imports before any of its code runs; a dynamic import() waits for the code that calls it
async function eager(...from: string[]): Promise<string[]> {
  const { metafile } = await build({
    absWorkingDir: root, entryPoints: from.map((f) => `${cli}/${f}`), bundle: true, write: false, outdir: 'out', metafile: true,
    platform: 'node', format: 'esm', logLevel: 'silent', external: ['bufferutil', 'utf-8-validate'],
  });
  const seen = new Set<string>();
  const walk = (f: string, m: Metafile) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const i of m.inputs[f].imports) if (i.kind === 'import-statement' && !i.external) walk(i.path, m);
  };
  for (const f of from) walk(`${cli}/${f}`, metafile);
  return [...seen];
}

describe('what a svall call loads', () => {
  it('defines every command without loading any command\'s code, the client or the method schemas', async () => {
    expect((await eager('main.ts')).filter((f) => f.startsWith(`${cli}/commands/`) || f === `${cli}/client.ts` || SCHEMAS.test(f))).toEqual([]);
  });

  it('reaches the daemon for status and robot without the method schemas', async () => {
    expect((await eager('client.ts', 'commands/status.ts', 'commands/robot.ts')).filter((f) => SCHEMAS.test(f))).toEqual([]);
  });
});
