import fs from 'node:fs';
import path from 'node:path';
import { shq } from './text.js';
import { editUserFiles, readUserFile, requireWritableUserFile, userFileTarget, type UserFileEdit } from './user-file.js';

const START = '# >>> Svall PATH >>>';
const END = '# <<< Svall PATH <<<';
const block = /(?:\r?\n)?# >>> Svall PATH >>>\r?\n[\s\S]*?# <<< Svall PATH <<<\r?\n?/g;

type PathRecord = { file: string; created: boolean };
export const pathRecordFile = (home: string): string => path.join(home, 'setup-path.json');

export function startupFile(home: string, shell: string, zdotdir?: string, xdgConfigHome?: string): string | undefined {
  const name = path.basename(shell);
  // A new .bash_profile would hide .bash_login or .profile, even after its PATH block was removed.
  const bash = () => ['.bash_profile', '.bash_login', '.profile'].map((f) => path.join(home, f)).find((f) => fs.existsSync(f)) ?? path.join(home, '.bash_profile');
  const file = name === 'zsh' ? path.join(zdotdir || home, '.zshrc') : name === 'bash' ? bash()
    : name === 'fish' ? path.join(xdgConfigHome || path.join(home, '.config'), 'fish/conf.d/svall.fish') : undefined;
  if (!file) return;
  return userFileTarget(file);
}

/** A read-only startup file stays manual, with the copyable PATH command on the setup screen. */
export function writableStartupFile(home: string, shell: string, zdotdir?: string, xdgConfigHome?: string): string | undefined {
  try {
    const file = startupFile(home, shell, zdotdir, xdgConfigHome);
    if (file) requireWritableUserFile(readUserFile(file));
    return file;
  } catch { return undefined; }
}

export function setupPath(file: string, shimDir: string, fish = false, remove = false, recordFile?: string): string[] {
  const current = readUserFile(file, 0o644);
  const text = current.text ?? '';
  const clean = text.replace(block, '\n');
  const line = fish ? `fish_add_path --path ${shq(shimDir)}` : `export PATH=${shq(shimDir)}:"$PATH"`;
  const record = recordFile ? readUserFile(recordFile) : undefined;
  const records: PathRecord[] = record?.text ? JSON.parse(record.text) : [];
  const owned = records.find((r) => r.file === current.target);
  const next = remove ? owned?.created && !clean.trim() ? undefined : current.text === undefined ? undefined : clean
    : `${clean}${clean && !clean.endsWith('\n') ? '\n' : ''}${START}\n${line}\n${END}\n`;
  const edits: UserFileEdit[] = [{ current, next, what: remove ? 'removed Svall PATH from' : 'Svall PATH' }];
  if (record) {
    const rest = records.filter((r) => r.file !== current.target);
    if (!remove) rest.push(owned ?? { file: current.target, created: current.text === undefined });
    edits.push({ current: record, next: rest.length ? `${JSON.stringify(rest, null, 2)}\n` : undefined, what: 'Svall PATH ownership', backup: false });
  }
  return editUserFiles(edits);
}

export function removeSetupPaths(home: string): string[] {
  const file = pathRecordFile(home);
  const record = readUserFile(file);
  const records: PathRecord[] = record.text ? JSON.parse(record.text) : [];
  return records.flatMap((r) => setupPath(r.file, '', false, true, file));
}
