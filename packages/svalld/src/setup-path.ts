import fs from 'node:fs';
import path from 'node:path';
import { writeDurable } from './durable.js';
import { realPath } from './path-tools.js';
import { shq } from './text.js';

const START = '# >>> Svall PATH >>>';
const END = '# <<< Svall PATH <<<';
const block = /(?:\r?\n)?# >>> Svall PATH >>>\r?\n[\s\S]*?# <<< Svall PATH <<<\r?\n?/g;

// realPath resolves linked parents of files not made yet; a dangling rc link still names its intended target.
function targetOf(file: string, seen = new Set<string>()): string {
  const real = realPath(file);
  if (!fs.lstatSync(real, { throwIfNoEntry: false })?.isSymbolicLink()) return real;
  if (seen.has(real)) throw new Error(`startup file symlink loop at ${file}`);
  seen.add(real);
  return targetOf(path.resolve(path.dirname(real), fs.readlinkSync(real)), seen);
}

export function startupFile(home: string, shell: string, zdotdir?: string): string | undefined {
  const name = path.basename(shell);
  const file = name === 'zsh' ? path.join(zdotdir || home, '.zshrc') : name === 'bash' ? path.join(home, '.bash_profile')
    : name === 'fish' ? path.join(home, '.config/fish/conf.d/svall.fish') : undefined;
  if (!file) return;
  return targetOf(file);
}

export function setupPath(file: string, shimDir: string, fish = false, remove = false): string[] {
  const real = targetOf(file);
  const text = fs.existsSync(real) ? fs.readFileSync(real, 'utf8') : '';
  const clean = text.replace(block, '\n');
  const line = fish ? `fish_add_path --path ${shq(shimDir)}` : `export PATH=${shq(shimDir)}:"$PATH"`;
  const next = remove ? clean : `${clean}${clean && !clean.endsWith('\n') ? '\n' : ''}${START}\n${line}\n${END}\n`;
  if (next === text) return [];
  fs.mkdirSync(path.dirname(real), { recursive: true });
  const mode = fs.statSync(real, { throwIfNoEntry: false })?.mode;
  writeDurable(real, Buffer.from(next), { mode: mode ? mode & 0o777 : 0o644 });
  if (mode !== undefined) fs.chmodSync(real, mode & 0o777);
  return [`${remove ? 'removed Svall PATH from' : 'Svall PATH ->'} ${real}`];
}
