import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { parseLine } from './parse.js';

type Events = {
  // as tmux escapes it; unescapeOutput gives the pane's bytes
  output: [paneId: string, escaped: string];
  'window-close': [windowId: string];
  pause: [paneId: string];
  continue: [paneId: string];
  exit: [reason: string];
  ready: [];
};

export class ControlClient extends EventEmitter<Events> {
  private proc?: ChildProcess;
  private buf = '';
  // the reply being read: its guard, whether it answers a line this client sent, and its lines so far
  private reply?: { guard: string; ours: boolean; lines: string[] };
  private ready = false;
  // a callback per line sent, in order, for the reply tmux gives it; undefined for an error or no reply
  private sent: ((reply: string | undefined) => void)[] = [];
  // asks whose reply is overdue; until it comes, asks go unanswered rather than wait behind it
  private late = 0;
  private stopped = false;
  private exited = false;
  private stderr = '';

  constructor(private opts: { binary: string; socket: string; conf: string; session: string; readyTimeoutMs?: number }) {
    super();
  }

  start(): Promise<void> {
    const { binary, socket, conf, session } = this.opts;
    // without -u, a client outside a UTF-8 locale is sent a reply's tabs and letters outside ASCII as _
    const proc = spawn(binary, ['-u', '-S', socket, '-f', conf, '-C', 'attach-session', '-t', session], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    proc.stdout!.setEncoding('latin1');
    proc.stdout!.on('data', (chunk: string) => this.onData(chunk));
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4096); });
    proc.on('exit', (code) => this.emitExit(`tmux control client exited (${code})`));
    proc.on('error', (e) => this.emitExit(`tmux control client failed: ${e.message}`));
    // a write to a client already gone fails, and its exit says so
    proc.stdin!.on('error', () => {});
    const timeoutMs = this.opts.readyTimeoutMs ?? 10_000;
    return new Promise((resolve, reject) => {
      const done = (fn: () => void) => { clearTimeout(timer); this.off('exit', onExit); this.off('ready', onReady); fn(); };
      const onExit = (reason: string) => done(() => reject(new Error(reason)));
      const onReady = () => done(resolve);
      const timer = setTimeout(() => done(() => {
        this.stop();
        reject(new Error(`tmux control client did not become ready within ${timeoutMs}ms${this.errSuffix()}`));
      }), timeoutMs);
      this.once('exit', onExit);
      this.once('ready', onReady);
    });
  }

  send(command: string): void {
    this.sent.push(() => {});
    this.proc?.stdin?.write(command + '\n');
  }

  get answering(): boolean {
    return this.ready && !this.stopped && !this.exited && this.late === 0;
  }

  /** What tmux printed for `commands`, each a line it runs as one command, as latin1; undefined when one failed, or the
   *  replies did not all come in `timeoutMs`. They go in one write, so tmux runs them in one breath as a single call would. */
  ask(commands: string[], timeoutMs = 1000): Promise<string | undefined> {
    // a line break would be read as two commands, and every reply after it go to the wrong ask
    if (!this.answering || commands.some((c) => /[\n\r]/.test(c))) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const replies: (string | undefined)[] = [];
      let overdue = false;
      const timer = setTimeout(() => { overdue = true; this.late++; resolve(undefined); }, timeoutMs);
      for (let i = 0; i < commands.length; i++) {
        this.sent.push((reply) => {
          replies.push(reply);
          if (replies.length < commands.length) return;
          clearTimeout(timer);
          if (overdue) this.late--;
          resolve(replies.every((r) => r !== undefined) ? replies.join('') : undefined);
        });
      }
      this.proc!.stdin!.write(commands.map((c) => `${c}\n`).join(''));
    });
  }

  stop(): void {
    this.stopped = true;
    this.drop();
    this.proc?.kill();
  }

  private drop(): void {
    for (const done of this.sent.splice(0)) done(undefined);
  }

  private errSuffix(): string {
    const err = this.stderr.trim();
    return err ? `: ${err}` : '';
  }

  private emitExit(reason: string): void {
    this.drop();
    if (this.stopped || this.exited) return;
    this.exited = true;
    this.emit('exit', reason + this.errSuffix());
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    const r = this.reply;
    if (r) {
      // a pane's text in a reply may read as a guard; only the one repeating this reply's number ends it
      if (line !== `%end ${r.guard}` && line !== `%error ${r.guard}`) { r.lines.push(line); return; }
      this.reply = undefined;
      const ok = line.startsWith('%end');
      if (this.ready) {
        if (r.ours) this.sent.shift()?.(!ok ? undefined : r.lines.length ? r.lines.join('\n') + '\n' : '');
        return;
      }
      // the first reply is the attach's own; refused, there is nothing attached to drive
      if (!ok) {
        this.emitExit(`tmux refused the attach: ${r.lines.join(' ')}`);
        this.proc?.kill();
        return;
      }
      this.ready = true;
      this.emit('ready');
      return;
    }
    const ev = parseLine(line);
    switch (ev.type) {
      // flags 1: the reply to a line this client sent
      case 'begin': this.reply = { guard: ev.guard, ours: ev.guard.endsWith(' 1'), lines: [] }; break;
      case 'output': this.emit('output', ev.paneId, ev.escaped); break;
      case 'window-close': this.emit('window-close', ev.windowId); break;
      case 'pause': this.emit('pause', ev.paneId); break;
      case 'continue': this.emit('continue', ev.paneId); break;
      case 'exit': this.emitExit(ev.reason || 'tmux sent %exit'); break;
      default: break;
    }
  }
}
