import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { helper } from '../runtime.js';
import { ControlClient } from './control.js';

const exec = promisify(execFile);
// a tmux server that stops answering must not hang every poll and API call behind it
const CALL = { timeout: 10_000, killSignal: 'SIGKILL' } as const;

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

// the server takes the environment of the command that starts it, and hands it to every pane. The
// release root the svalld shim exports would make a checkout's `pnpm svall` in a pane act as that release
function paneEnv(): NodeJS.ProcessEnv {
  const { SVALL_RELEASE_ROOT: _release, ...env } = process.env;
  return env;
}

type LiveSession = { name: string; attached: number; created: number };

export type LiveWindow = {
  windowId: string;
  paneId: string;
  // the process tmux started in the pane: the shell, unless it replaced itself
  panePid: number;
  name: string;
  command: string;
  path: string;
  activity: number;
  dead: boolean;
};

// `shell` is the one node.json names, whatever it is
export function isShellCommand(command: string, shell?: string): boolean {
  const name = command.replace(/^-/, '');
  return SHELLS.has(name) || (!!shell && name === path.basename(shell));
}

// tmux 3.7 runs a paste through vis(3) unless given -S, a flag older versions refuse; `usage` is what
// `list-commands paste-buffer` prints, such as "paste-buffer (pasteb) [-dprS] [-s separator] …"
export function rawPasteArgs(usage: string): string[] {
  return /\[-\w*S\w*\]/.test(usage) ? ['-S'] : [];
}

/** Whether a tmux call failed for want of a server: the one on its socket died, or none was ever started there. */
export function noServer(e: unknown): boolean {
  return /no server running on |error connecting to .* \(No such file or directory\)/.test(String(e));
}

// what tmux 3.4 escapes as it prints, where 3.7 prints the byte: one that is not text as \ooo, a control character
// that has a C escape as that, and a $ before a letter, _ or { as \$
const ESCAPED: Record<string, number> = { a: 7, b: 8, f: 12, r: 13, v: 11, $: 36 };
const unescape = (v: string): string => (v.includes('\\')
  ? Buffer.concat(v.split(/\\([0-7]{3}|[abfrv$])/).map((part, i) => (i % 2 ? Buffer.of(part.length === 3 ? parseInt(part, 8) : ESCAPED[part]) : Buffer.from(part)))).toString('utf8')
  : v);

// a name or path may hold any byte but NUL: fields and rows are marked with printable text made for each listing,
// which no name can hold except by guessing it. 3.4 prints a backslash as it is, so tmux swaps each for more such text
// first, and every backslash left in what it prints is one of its escapes
function listing(fields: string[]): { format: string; rows(out: string): string[][] } {
  const token = crypto.randomBytes(8).toString('hex');
  const [sep, end, slash] = [`<${token}>`, `</${token}>`, `(${token})`];
  return {
    format: fields.map((f) => `#{s/\\\\/${slash}/:${f}}`).join(sep) + end,
    rows: (out) => out.split(`${end}\n`).filter(Boolean).map((row) => row.split(sep).map((v) => unescape(v).replaceAll(slash, '\\'))),
  };
}

export class Tmux {
  readonly binary = resolveTmux();
  private rawPaste?: Promise<string[]>;

  constructor(readonly socket: string, private conf: string) {}

  async run(...args: string[]): Promise<string> {
    return this.call(args);
  }

  // a signal that aborts ends the tmux client this call started. Without -u, a client outside a UTF-8 locale is
  // sent a tab or a letter outside ASCII as _
  private async call(args: string[], signal?: AbortSignal): Promise<string> {
    const { stdout } = await exec(this.binary, ['-u', '-S', this.socket, '-f', this.conf, ...args], {
      ...CALL,
      maxBuffer: 64 * 1024 * 1024,
      env: paneEnv(),
      signal,
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
    // a tmux that did not answer in time says nothing about the window
    const said = await this.run('display', '-p', '-t', windowId, '#{window_id}').catch((e: { killed?: boolean }) => { if (e.killed) throw e; return ''; });
    return said.trim() === windowId;
  }

  // one session per desktop terminal, holding only the character's window: when that window dies the
  // session dies and the attached client exits instead of being moved to another window. One tmux call:
  // a failing command ends its sequence, so the steps that would fail on a second attach sit behind `if -F`
  async attachSession(name: string, windowId: string): Promise<void> {
    await this.run(
      // set directly on a session with no client, destroy-unattached destroys it at once
      // link-window -k can close the placeholder's pty before tmux's child holds it, and then no SIGHUP comes:
      // cat still ends, at EOF, and as two words it skips default-shell, which (zsh) hangs on a dead pty
      'if', '-F', `#{N/s:${name}}`, '',
      `new-session -d -s ${name} cat - ; set-hook -t ${name} client-attached "set -t ${name} destroy-unattached on"`, ';',
      'if', '-F', '-t', `=${name}:`, `#{W:#{?#{==:#{window_id},${windowId}},1,}}`, '', `link-window -k -s ${windowId} -t =${name}:^`, ';',
      'set-option', '-w', '-u', '-t', windowId, 'window-size',
    );
  }

  // every client attached to the session, which leaves the session and its windows running
  async detachClients(session: string, signal?: AbortSignal): Promise<void> {
    await this.call(['detach-client', '-s', `=${session}`], signal).catch(() => {});
  }

  async killSession(name: string): Promise<void> {
    await this.run('kill-session', '-t', `=${name}`).catch(() => {});
  }

  async listSessions(): Promise<LiveSession[]> {
    const list = listing(['session_name', 'session_attached', 'session_created']);
    const out = await this.run('list-sessions', '-F', list.format).catch(() => '');
    return list.rows(out).map(([name, attached, created]) => ({ name, attached: Number(attached), created: Number(created) * 1000 }));
  }

  async ensureServer(): Promise<void> {
    try {
      await this.run('has-session', '-t', SESSION);
    } catch {
      // cat as in attachSession: a server killed as it starts can close this pty before its child holds it
      await this.run('new-session', '-d', '-s', SESSION, '-n', KEEP_WINDOW, 'cat', '-');
    }
    // a server that outlived a restart holds the agent homes of the daemon that started it, and hands them to new windows
    for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
      const value = process.env[key];
      await this.run('set-environment', '-g', ...(value ? [key, value] : ['-u', key]));
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

  // the bytes go in on stdin: as arguments tmux caps them at about 16 KB and reads a trailing ; as syntax.
  // a signal that aborts ends the tmux client
  private async paste(paneId: string, data: Buffer | string, bracketed = false, signal?: AbortSignal): Promise<void> {
    // an answer tmux failed to give is asked for again on the next paste
    this.rawPaste ??= this.run('list-commands', 'paste-buffer').then(rawPasteArgs)
      .catch((e: unknown) => { this.rawPaste = undefined; throw e; });
    const raw = await this.rawPaste;
    const name = `svall-${crypto.randomUUID()}`;
    const p = exec(this.binary, ['-S', this.socket, '-f', this.conf, 'load-buffer', '-b', name, '-', ';', 'paste-buffer', '-d', '-r', ...raw, ...(bracketed ? ['-p'] : []), '-b', name, '-t', paneId], { ...CALL, env: paneEnv(), signal });
    // a tmux that fails before reading closes the pipe; its exit status carries the error
    p.child.stdin!.on('error', () => {}).end(data);
    // a pane gone before the paste leaves the buffer behind
    await p.catch(async (e) => { await this.run('delete-buffer', '-b', name).catch(() => {}); throw e; });
  }

  async sendBytes(paneId: string, bytes: Buffer, signal?: AbortSignal): Promise<void> {
    if (bytes.length === 0) return;
    await this.paste(paneId, bytes, false, signal);
  }

  async sendLine(paneId: string, text: string, enter: boolean): Promise<void> {
    // bracketed, an app that asked for it takes the text as one paste: a busy Claude Code cuts raw text into
    // pieces, and an Enter landing among them submits only some
    if (text) await this.paste(paneId, text, true);
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

  async capture(paneId: string, lines: number, escapes = false, signal?: AbortSignal): Promise<Buffer> {
    const out = await this.call(['capture-pane', '-p', ...(escapes ? ['-e'] : []), '-t', paneId, '-S', `-${lines}`], signal);
    return Buffer.from(out.replace(/\n$/, '').replace(/\n/g, '\r\n'), 'utf8');
  }

  async listWindows(signal?: AbortSignal): Promise<LiveWindow[]> {
    const list = listing(['window_id', 'pane_id', 'pane_pid', 'window_name', 'pane_current_command', 'window_activity', 'pane_dead', 'pane_current_path']);
    // one row per window: a split window would otherwise yield several rows under the same name.
    const out = await this.call(['list-panes', '-s', '-t', SESSION, '-f', '#{pane_active}', '-F', list.format], signal);
    return list.rows(out)
      .map(([windowId, paneId, panePid, name, command, activity, dead, path]) => {
        const seconds = Number(activity);
        return { windowId, paneId, panePid: Number(panePid), name, command, path, activity: Number.isFinite(seconds) ? seconds * 1000 : 0, dead: dead === '1' };
      })
      .filter((w) => w.name !== KEEP_WINDOW);
  }

  async renameWindow(windowId: string, name: string): Promise<void> {
    await this.run('rename-window', '-t', windowId, name);
  }

  async killWindow(windowId: string, signal?: AbortSignal): Promise<void> {
    await this.call(['kill-window', '-t', windowId], signal).catch(() => {});
  }

  async killServer(): Promise<void> {
    await this.run('kill-server').catch(() => {});
  }
}
