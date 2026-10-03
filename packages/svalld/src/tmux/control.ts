import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { parseLine } from './parse.js';

type Events = {
  output: [paneId: string, data: Buffer];
  'window-close': [windowId: string];
  pause: [paneId: string];
  continue: [paneId: string];
  exit: [reason: string];
  ready: [];
};

export class ControlClient extends EventEmitter<Events> {
  private proc?: ChildProcess;
  private buf = '';
  private inReply = false;
  private ready = false;
  // what tmux said in its reply to the attach
  private said: string[] = [];
  private stopped = false;
  private exited = false;
  private stderr = '';

  constructor(private opts: { binary: string; socket: string; conf: string; session: string; readyTimeoutMs?: number }) {
    super();
  }

  start(): Promise<void> {
    const { binary, socket, conf, session } = this.opts;
    const proc = spawn(binary, ['-S', socket, '-f', conf, '-C', 'attach-session', '-t', session], {
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
    this.proc?.stdin?.write(command + '\n');
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill();
  }

  private errSuffix(): string {
    const err = this.stderr.trim();
    return err ? `: ${err}` : '';
  }

  private emitExit(reason: string): void {
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
    const ev = parseLine(line);
    if (this.inReply) {
      if (ev.type !== 'end' && ev.type !== 'error') {
        if (!this.ready) this.said.push(line);
        return;
      }
      this.inReply = false;
      if (this.ready) return;
      // the first reply is the attach's own; refused, there is nothing attached to drive
      if (ev.type === 'error') {
        this.emitExit(`tmux refused the attach: ${this.said.join(' ')}`);
        this.proc?.kill();
        return;
      }
      this.ready = true;
      this.emit('ready');
      return;
    }
    switch (ev.type) {
      case 'begin': this.inReply = true; break;
      case 'output': this.emit('output', ev.paneId, ev.data); break;
      case 'window-close': this.emit('window-close', ev.windowId); break;
      case 'pause': this.emit('pause', ev.paneId); break;
      case 'continue': this.emit('continue', ev.paneId); break;
      case 'exit': this.emitExit(ev.reason || 'tmux sent %exit'); break;
      default: break;
    }
  }
}
