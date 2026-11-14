import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command, CommanderError } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../src/program.js';

// the commands that only talk to a daemon, which a home with none refuses before anything changes
const DAEMON = ['status', 'island', 'robot', 'scribe', 'browser', 'app', 'mobile'];

const tree = (c: Command, at: string[] = []): { at: string[]; c: Command }[] => [{ at, c }, ...c.commands.flatMap((s) => tree(s, [...at, s.name()]))];

// what `svall <argv>` prints and exits with, as main.ts ends it
async function run(argv: string[], home: string): Promise<string> {
  const program = buildProgram();
  let out = '';
  const write = (s: string | Uint8Array) => { out += String(s); return true; };
  for (const { c } of tree(program)) c.exitOverride().configureOutput({ writeOut: write, writeErr: write });
  vi.spyOn(process.stdout, 'write').mockImplementation(write);
  vi.spyOn(process.stderr, 'write').mockImplementation(write);
  let code: number;
  try {
    await program.parseAsync(argv, { from: 'user' });
    code = Number(process.exitCode ?? 0);
  } catch (e) {
    code = e instanceof CommanderError ? e.exitCode : 1;
    if (!(e instanceof CommanderError)) out += `svall: ${(e as Error).message}\n`;
  } finally {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  }
  return `$ svall ${argv.join(' ')}\n${out.replaceAll(home, '<home>')}[exit ${code}]\n`;
}

// a placeholder for each argument and required option, so the action runs as far as the daemon
const filled = (c: Command): string[] => [
  ...c.registeredArguments.filter((a) => a.required).map(() => 'x'),
  ...c.options.filter((o) => o.mandatory).flatMap((o) => [o.long!, 'x']),
];

describe('svall command surface', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  // setup and doctor read the platform for their options
  it.runIf(process.platform === 'darwin')('prints the same help, refusals, errors and exit codes for every command', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-surface-'));
    vi.stubEnv('SVALL_HOME', home);
    let all = '';
    for (const { at, c } of tree(buildProgram())) {
      all += await run([...at, '--help'], home);
      all += await run([...at, '--no-such-flag'], home);
      if (c.commands.length === 0 && DAEMON.includes(at[0]!)) all += await run([...at, ...filled(c)], home);
    }
    fs.rmSync(home, { recursive: true, force: true });
    await expect(all).toMatchFileSnapshot('./surface.snap.txt');
  });
});
