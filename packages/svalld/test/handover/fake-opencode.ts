#!/usr/bin/env node
// Test double for OpenCode 2.0.22's session commands as they behave: each session is its export JSON, kept in the data
// folder XDG_DATA_HOME names. Importing an id it holds prints "Session already exists" and exits 0; a missing id is
// "Session not found" with exit 1; `-s` on a missing id makes an empty session with that id.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Ran = { code: number; stdout: string; stderr: string };
/** A session as `session export` writes it; `revert` is the undo it has pending, which `session import` drops. */
export type Exported = { info: { id: string; location: { directory: string }; revert?: object }; messages: { id: string; text: string }[] };

const dataDir = (env: NodeJS.ProcessEnv): string => path.join(env.XDG_DATA_HOME ?? path.join(env.HOME ?? os.homedir(), '.local/share'), 'opencode', 'fake-sessions');
const fileOf = (env: NodeJS.ProcessEnv, id: string): string => path.join(dataDir(env), `${id}.json`);

/** The sessions this data folder holds, by id. */
export function held(env: NodeJS.ProcessEnv): Record<string, Exported> {
  const dir = dataDir(env);
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir).map((f) => [f.slice(0, -'.json'.length), JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Exported]));
}

/** Writes a session into the data folder, as a run of OpenCode there would. */
export function hold(env: NodeJS.ProcessEnv, session: Exported): void {
  fs.mkdirSync(dataDir(env), { recursive: true });
  fs.writeFileSync(fileOf(env, session.info.id), JSON.stringify(session, null, 2));
}

/** An environment whose `opencode` is this double, keeping its sessions under `dir`. */
export function fakeEnv(dir: string): NodeJS.ProcessEnv {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  if (!fs.existsSync(path.join(bin, 'opencode'))) fs.symlinkSync(fileURLToPath(import.meta.url), path.join(bin, 'opencode'));
  return { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_DATA_HOME: path.join(dir, 'data') };
}

const notFound = (id: string): Ran => ({ code: 1, stdout: '', stderr: `Error: Session not found: ${id}\n` });

/** What `opencode <args>` prints and exits with. */
export function opencode(args: string[], env: NodeJS.ProcessEnv): Ran {
  const words = args.filter((a) => a !== '--standalone');
  if (words[0] === '--version') return { code: 0, stdout: '2.0.22\n', stderr: '' };
  if (words[0] === 'auth' && words[1] === 'list') return { code: 0, stdout: '0 credentials\n', stderr: '' };
  const sessions = held(env);
  // a session command without --standalone goes through the user's shared service, which a handover never asks
  if (words[0] === 'session' && !args.includes('--standalone')) return { code: 1, stdout: '', stderr: `the fake refuses ${args.join(' ')} without --standalone\n` };
  if (words[0] === 'session') {
    const [, verb, ...rest] = words;
    if (verb === 'export' || verb === 'delete') {
      const id = rest[0];
      if (!sessions[id]) return notFound(id);
      if (verb === 'export') return { code: 0, stdout: fs.readFileSync(fileOf(env, id), 'utf8'), stderr: '' };
      fs.rmSync(fileOf(env, id));
      return { code: 0, stdout: `Session ${id} deleted\n`, stderr: '' };
    }
    if (verb === 'import') {
      const at = rest.indexOf('--directory');
      const directory = at === -1 ? process.cwd() : rest[at + 1];
      const file = rest.filter((_, i) => i !== at && i !== at + 1)[0];
      const session = JSON.parse(fs.readFileSync(file, 'utf8')) as Exported;
      if (sessions[session.info.id]) return { code: 0, stdout: '', stderr: 'Session already exists\n' };
      if (!fs.existsSync(directory)) return { code: 1, stdout: '', stderr: 'Error: Internal server error\n' };
      const { revert: _, ...info } = session.info;
      hold(env, { ...session, info: { ...info, location: { directory: fs.realpathSync(directory) } } });
      return { code: 0, stdout: `Imported session: ${session.info.id}\n`, stderr: '' };
    }
  }
  const s = words.indexOf('-s');
  if (s !== -1) {
    const id = words[s + 1];
    if (!sessions[id]) hold(env, { info: { id, location: { directory: process.cwd() } }, messages: [] });
    return { code: 0, stdout: '', stderr: '' };
  }
  return { code: 1, stdout: '', stderr: `unknown command: ${args.join(' ')}\n` };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = opencode(process.argv.slice(2), process.env);
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode = r.code;
}
