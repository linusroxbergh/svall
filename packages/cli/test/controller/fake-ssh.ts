import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FIXTURE = path.join(import.meta.dirname, '../fixtures/ssh.mjs');

export type FakeSsh = {
  dir: string;
  socketDir: string;
  /** every argv the fake ssh was spawned with, in order */
  calls: () => string[][];
  /** every remote command, as the words the far side's login shell split the line back into */
  remoteCalls: () => string[][];
  /** what the remote `svall connection-info` answers; unset means a daemon that is not running */
  answer: (info: unknown) => void;
  /** what the far side answers a command holding all of `match`; the first entry that fits wins */
  reply: (match: string[], r: { stdout?: string; stderr?: string; code?: number; delayMs?: number }) => void;
  /** the pid of the master on a socket, while one is up */
  masterPid: (socket: string) => number | undefined;
  /** forgets every scripted reply, so the same command can be answered differently later */
  clearReplies: () => void;
  /** takes down the master on a socket, as a network drop or a sleeping laptop would */
  dropMaster: (socket: string) => void;
  /**
   * runs every far command on this machine instead, with `rsync` as the far side's rsync and `path` as its login
   * shell's PATH; a cut takes the link down once that many bytes have crossed one command, and `undefined` lets it through again
   */
  execute: (o: { rsync: string; cutAfterBytes?: number; path?: string }) => void;
  clean: () => void;
};

/** Puts a stand-in for ssh first on PATH and hands back what it recorded. */
export function installFakeSsh(): FakeSsh {
  const dir = fs.mkdtempSync(`/tmp/svall-ssh-${crypto.randomBytes(3).toString('hex')}-`);
  const bin = path.join(dir, 'bin');
  const state = path.join(dir, 'state');
  const socketDir = path.join(dir, 'sockets');
  for (const d of [bin, state]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.symlinkSync(FIXTURE, path.join(bin, 'ssh'));

  const log = path.join(dir, 'argv.jsonl');
  const remoteLog = path.join(dir, 'remote.jsonl');
  const info = path.join(dir, 'connection-info.json');
  const replies = path.join(dir, 'replies.jsonl');
  const env = {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
    SVALL_FAKE_SSH_LOG: process.env.SVALL_FAKE_SSH_LOG, SVALL_FAKE_SSH_REMOTE_LOG: process.env.SVALL_FAKE_SSH_REMOTE_LOG,
    SVALL_FAKE_SSH_STATE: process.env.SVALL_FAKE_SSH_STATE, SVALL_FAKE_SSH_INFO: process.env.SVALL_FAKE_SSH_INFO,
    SVALL_FAKE_SSH_REPLIES: process.env.SVALL_FAKE_SSH_REPLIES,
    SVALL_FAKE_SSH_EXEC: process.env.SVALL_FAKE_SSH_EXEC, SVALL_FAKE_SSH_CUT_AFTER: process.env.SVALL_FAKE_SSH_CUT_AFTER,
    SVALL_FAKE_SSH_FAR_PATH: process.env.SVALL_FAKE_SSH_FAR_PATH,
  };
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  process.env.SVALL_FAKE_SSH_LOG = log;
  process.env.SVALL_FAKE_SSH_REMOTE_LOG = remoteLog;
  process.env.SVALL_FAKE_SSH_STATE = state;
  process.env.TMPDIR = dir;
  delete process.env.SVALL_FAKE_SSH_INFO;
  process.env.SVALL_FAKE_SSH_REPLIES = replies;

  const lines = (file: string): string[][] =>
    (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);

  return {
    dir,
    socketDir,
    calls: () => lines(log),
    remoteCalls: () => lines(remoteLog),
    answer: (value: unknown) => { fs.writeFileSync(info, JSON.stringify(value)); process.env.SVALL_FAKE_SSH_INFO = info; },
    reply: (match, r) => { fs.appendFileSync(replies, `${JSON.stringify({ match, ...r })}\n`); },
    clearReplies: () => { fs.rmSync(replies, { force: true }); },
    masterPid: (socket) => {
      const file = path.join(state, `${path.basename(socket)}.master`);
      return fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : undefined;
    },
    dropMaster: (socket) => {
      const file = path.join(state, `${path.basename(socket)}.master`);
      try { process.kill(Number(fs.readFileSync(file, 'utf8')), 'SIGTERM'); } catch { /* already gone */ }
      fs.rmSync(file, { force: true });
    },
    execute: (o) => {
      const far = path.join(bin, 'rsync');
      fs.rmSync(far, { force: true });
      fs.symlinkSync(o.rsync, far);
      process.env.SVALL_FAKE_SSH_EXEC = '1';
      if (o.cutAfterBytes) process.env.SVALL_FAKE_SSH_CUT_AFTER = String(o.cutAfterBytes);
      else delete process.env.SVALL_FAKE_SSH_CUT_AFTER;
      if (o.path) process.env.SVALL_FAKE_SSH_FAR_PATH = o.path;
      else delete process.env.SVALL_FAKE_SSH_FAR_PATH;
    },
    clean: () => {
      for (const f of fs.readdirSync(state)) {
        try { process.kill(Number(fs.readFileSync(path.join(state, f), 'utf8')), 'SIGTERM'); } catch { /* already gone */ }
      }
      for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
