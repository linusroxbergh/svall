import fs from 'node:fs';
import path from 'node:path';
import { writeDurable } from './durable.js';
import { realPath } from './path-tools.js';

// Resolve even a dangling file link before rename: an atomic write must replace its target, never the user's link.
export function userFileTarget(file: string, seen = new Set<string>()): string {
  const real = realPath(file);
  if (!fs.lstatSync(real, { throwIfNoEntry: false })?.isSymbolicLink()) return real;
  if (seen.has(real)) throw new Error(`file symlink loop at ${file}`);
  seen.add(real);
  return userFileTarget(path.resolve(path.dirname(real), fs.readlinkSync(real)), seen);
}

export type UserFile = { file: string; target: string; text?: string; mode: number };
export type UserFileEdit = { current: UserFile; next?: string; what: string; backup?: boolean };

export function readUserFile(file: string, defaultMode = 0o600): UserFile {
  const target = userFileTarget(file);
  const stat = fs.statSync(target, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error(`${file} is not a regular file`);
  return { file, target, text: stat ? fs.readFileSync(target, 'utf8') : undefined, mode: stat ? stat.mode & 0o777 : defaultMode };
}

export function requireWritableUserFile(current: UserFile): void {
  if (current.text !== undefined) {
    if (!(current.mode & 0o222)) throw new Error(`${current.file} is read-only, so nothing was changed`);
    fs.accessSync(current.target, fs.constants.W_OK);
  }
  let parent = path.dirname(current.target);
  while (!fs.existsSync(parent) && parent !== path.dirname(parent)) parent = path.dirname(parent);
  if (!(fs.statSync(parent).mode & 0o222)) throw new Error(`${current.file} has a read-only parent directory`);
  fs.accessSync(parent, fs.constants.W_OK);
}

function backup(current: UserFile): string {
  let stamp = Date.now(), file: string;
  for (;;) {
    file = `${current.target}.bak-${stamp++}`;
    try {
      fs.writeFileSync(file, current.text!, { mode: current.mode, flag: 'wx' });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  fs.chmodSync(file, current.mode);
  const prefix = `${path.basename(current.target)}.bak-`;
  const old = fs.readdirSync(path.dirname(current.target))
    .filter((f) => f.startsWith(prefix) && /^\d{13}$/.test(f.slice(prefix.length)) && f !== path.basename(file)).sort().slice(0, -2);
  for (const f of old) fs.rmSync(path.join(path.dirname(current.target), f));
  return `backup -> ${file}`;
}

function put(current: UserFile, text: string | undefined): void {
  if (text === undefined) fs.rmSync(current.target, { force: true });
  else {
    writeDurable(current.target, Buffer.from(text), { mode: current.mode });
    if (current.text !== undefined) fs.chmodSync(current.target, current.mode);
  }
}

/** Preflight all destinations before changing one; restore their previous bytes if a later write fails. */
export function editUserFiles(edits: UserFileEdit[]): string[] {
  const changed = edits.filter(({ current, next }) => current.text !== next);
  const targets = new Set<string>();
  for (const { current } of changed) {
    if (targets.has(current.target)) throw new Error(`multiple user-file edits resolve to ${current.target}`);
    targets.add(current.target);
  }
  for (const { current } of changed) requireWritableUserFile(current);
  const done = changed.filter(({ current, backup: keep }) => current.text !== undefined && keep !== false).map(({ current }) => backup(current));
  const attempted: UserFile[] = [];
  try {
    for (const { current, next, what } of changed) {
      attempted.push(current);
      put(current, next);
      done.push(next === undefined ? `removed ${current.file}` : `${what} -> ${current.file}`);
    }
  } catch (error) {
    const failures: unknown[] = [];
    for (const current of attempted.reverse()) {
      try { put(current, current.text); } catch (e) { failures.push(e); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], 'a user-file update failed and could not be fully restored; recover the reported files from their backups');
    throw error;
  }
  return done;
}
