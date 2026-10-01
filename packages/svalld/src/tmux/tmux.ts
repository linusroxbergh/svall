import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { helper } from '../runtime.js';
import { ControlClient } from './control.js';

const exec = promisify(execFile);

export const SESSION = 'fleet';
const KEEP_WINDOW = '_keep';
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash']);

export function resolveTmux(): string {
  const own = helper('tmux');
  if (own) return own;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, 'tmux');
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next dir */ }
  }
  return 'tmux';
}

export type LiveSession = { name: string; attached: number; created: number };

export type LiveWindow = {
  windowId: string;
  paneId: string;
  name: string;
  command: string;
  path: string;
  activity: number;
  dead: boolean;
};

export function isShellCommand(command: string): boolean {
  return SHELLS.has(command.replace(/^-/, ''));
}

// tmux 3.7 runs a paste through vis(3) unless given -S, a flag older versions refuse; `usage` is what
// `list-commands paste-buffer` prints, such as "paste-buffer (pasteb) [-dprS] [-s separator] …"
export function rawPasteArgs(usage: string): string[] {
  return /\[-\w*S\w*\]/.test(usage) ? ['-S'] : [];
}

export class Tmux {
  readonly binary = resolveTmux();
  private rawPaste?: Promise<string[]>;

  constructor(readonly socket: string, private conf: string) {}

  async run(...args: string[]): Promise<string> {
    const { stdout } = await exec(this.binary, ['-S', this.socket, '-f', this.conf, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }

  async version(): Promise<string> {
    try {
      return (await exec(this.binary, ['-V'])).stdout.trim();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('tmux not found on PATH: brew install tmux');
      throw e;
    }
  }

  async sourceConf(): Promise<void> {
    await this.run('source-file', this.conf);
  }

  async hasSession(name: string): Promise<boolean> {
    try { await this.run('has-session', '-t', `=${name}`); return true; } catch { return false; }
  }

  // display succeeds for a window that is gone too, printing an empty id
  async hasWindow(windowId: string): Promise<boolean> {
    return (await this.run('display', '-p', '-t', windowId, '#{window_id}').catch(() => '')).trim() === windowId;
  }

  // one session per desktop terminal, holding only the character's window: when that window dies the
  // session dies and the attached client exits instead of being moved to another window. One tmux call:
  // a failing command ends its sequence, so the steps that would fail on a second attach sit behind `if -F`
  async attachSession(name: string, windowId: string): Promise<void> {
    await this.run(
      // set directly on a session with no client, destroy-unattached destroys it at once
      'if', '-F', `#{N/s:${name}}`, '',
      `new-session -d -s ${name} "sleep 2147483647" ; set-hook -t ${name} client-attached "set -t ${name} destroy-unattached on"`, ';',
      'if', '-F', '-t', `=${name}:`, `#{W:#{?#{==:#{window_id},${windowId}},1,}}`, '', `link-window -k -s ${windowId} -t =${name}:^`, ';',
      'set-option', '-w', '-u', '-t', windowId, 'window-size',
    );
  }

  async killSession(name: string): Promise<void> {
    await this.run('kill-session', '-t', `=${name}`).catch(() => {});
  }

  async listSessions(): Promise<LiveSession[]> {
    const out = await this.run('list-sessions', '-F', '#{session_name}\t#{session_attached}\t#{session_created}').catch(() => '');
    return out.split('\n').filter(Boolean).map((l) => {
      const [name, attached, created] = l.split('\t');
      return { name, attached: Number(attached), created: Number(created) * 1000 };
    });
  }

  async ensureServer(): Promise<void> {
    try {
      await this.run('has-session', '-t', SESSION);
    } catch {
      await this.run('new-session', '-d', '-s', SESSION, '-n', KEEP_WINDOW, 'sleep 2147483647');
    }
  }

  connect(): ControlClient {
    return new ControlClient({ binary: this.binary, socket: this.socket, conf: this.conf, session: SESSION });
  }

  async newWindow(name: string, cwd: string, env: Record<string, string>): Promise<{ windowId: string; paneId: string }> {
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    // tmux expands -c as a format, and reads an argument ending in ; as the end of the command
    const dir = cwd.replaceAll('#', '##').replace(/;$/, '\\;');
    const out = await this.run(
      'new-window', '-d', '-P', '-F', '#{window_id} #{pane_id}', '-a', '-t', `${SESSION}:`,
      '-n', name, '-c', dir, ...envArgs,
    );
    const [windowId, paneId] = out.trim().split(' ');
    if (!windowId || !paneId) throw new Error(`tmux new-window returned ${JSON.stringify(out)}`);
    return { windowId, paneId };
  }

  // the bytes go in on stdin: as arguments tmux caps them at about 16 KB and reads a trailing ; as syntax
  private async paste(paneId: string, data: Buffer | string): Promise<void> {
    // an answer tmux failed to give is asked for again on the next paste
    this.rawPaste ??= this.run('list-commands', 'paste-buffer').then(rawPasteArgs)
      .catch((e: unknown) => { this.rawPaste = undefined; throw e; });
    const raw = await this.rawPaste;
    const name = `svall-${crypto.randomUUID()}`;
    const p = exec(this.binary, ['-S', this.socket, '-f', this.conf, 'load-buffer', '-b', name, '-', ';', 'paste-buffer', '-d', '-r', ...raw, '-b', name, '-t', paneId]);
    // a tmux that fails before reading closes the pipe; its exit status carries the error
    p.child.stdin!.on('error', () => {}).end(data);
    // a pane gone before the paste leaves the buffer behind
    await p.catch(async (e) => { await this.run('delete-buffer', '-b', name).catch(() => {}); throw e; });
  }

  async sendBytes(paneId: string, bytes: Buffer): Promise<void> {
    if (bytes.length === 0) return;
    await this.paste(paneId, bytes);
  }

  async sendLine(paneId: string, text: string, enter: boolean): Promise<void> {
    if (text) await this.paste(paneId, text);
    // Claude Code's composer truncates a submit that arrives in the same breath as the text.
    if (text && enter) await new Promise((r) => setTimeout(r, 100));
    // the same CR a key press sends, but pasted it reaches the app while the pane is in copy mode too
    if (enter) await this.paste(paneId, '\r');
  }

  async resize(windowId: string, cols: number, rows: number): Promise<void> {
    await this.run('resize-window', '-t', windowId, '-x', String(cols), '-y', String(rows));
  }

  // back to the global window-size; resize-window, -A included, pins the window to manual for its life
  async autoSize(windowId: string): Promise<void> {
    await this.run('set-option', '-w', '-u', '-t', windowId, 'window-size').catch(() => {});
  }

  async capture(paneId: string, lines: number, escapes = false): Promise<Buffer> {
    const out = await this.run('capture-pane', '-p', ...(escapes ? ['-e'] : []), '-t', paneId, '-S', `-${lines}`);
    return Buffer.from(out.replace(/\n$/, '').replace(/\n/g, '\r\n'), 'utf8');
  }

  async listWindows(): Promise<LiveWindow[]> {
    // tmux prints a path as it is, and a directory's name may hold any byte but NUL: fields and rows are
    // marked with a token made for this listing, which no name can hold except by guessing it
    const token = crypto.randomBytes(8).toString('hex');
    const [sep, end] = [`\x1f${token}`, `\x1e${token}`];
    const fmt = ['#{window_id}', '#{pane_id}', '#{window_name}', '#{pane_current_command}', '#{window_activity}', '#{pane_dead}', '#{pane_current_path}'].join(sep) + end;
    // one row per window: a split window would otherwise yield several rows under the same name.
    const out = await this.run('list-panes', '-s', '-t', SESSION, '-f', '#{pane_active}', '-F', fmt);
    return out
      .split(`${end}\n`)
      .filter(Boolean)
      .map((l) => {
        const [windowId, paneId, name, command, activity, dead, path] = l.split(sep);
        const seconds = Number(activity);
        return { windowId, paneId, name, command, path, activity: Number.isFinite(seconds) ? seconds * 1000 : 0, dead: dead === '1' };
      })
      .filter((w) => w.name !== KEEP_WINDOW);
  }

  async renameWindow(windowId: string, name: string): Promise<void> {
    await this.run('rename-window', '-t', windowId, name);
  }

  async killWindow(windowId: string): Promise<void> {
    await this.run('kill-window', '-t', windowId).catch(() => {});
  }

  async killServer(): Promise<void> {
    await this.run('kill-server').catch(() => {});
  }
}
