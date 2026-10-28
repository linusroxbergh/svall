import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { sha256Hex } from './hash.js';

// macOS's O_EXLOCK, which node names no constant for
const O_EXLOCK = 0x20;

/** A lock the kernel holds until let go or its process dies, however it dies; undefined while another holds it. macOS
 *  opens `file` with O_EXLOCK; Linux ignores O_EXLOCK, so there it is the abstract unix socket `name`. */
export function tryLock(file: string, name: string): Promise<(() => void) | undefined> {
  return process.platform === 'linux' ? lockSocket(name) : Promise.resolve(lockFile(file));
}

function lockFile(file: string): (() => void) | undefined {
  const { O_RDWR, O_CREAT, O_NONBLOCK } = fs.constants;
  try {
    let fd = fs.openSync(file, O_RDWR | O_CREAT | O_NONBLOCK | O_EXLOCK, 0o600);
    // once only: by a second close the number may name another open file
    return () => { if (fd >= 0) fs.closeSync(fd); fd = -1; };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EAGAIN') return undefined;
    throw e;
  }
}

// the kernel keeps an abstract socket's name only while the socket is open
function lockSocket(name: string): Promise<(() => void) | undefined> {
  const server = net.createServer((s) => s.destroy());
  return new Promise((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' ? resolve(undefined) : reject(e)));
    server.listen(`\0${name}`, () => {
      server.unref();
      resolve(() => { if (server.listening) server.close(); });
    });
  });
}

/** Holds this user's agent files for a mirror's apply or a move's trust seed, waiting while another fleet's daemon holds
 *  them, as every fleet's mirror writes the same files. Rejects once `signal` aborts before it holds them. */
export async function lockAgentFiles(homedir: string, signal?: AbortSignal): Promise<() => void> {
  const name = `svall-mirror-${sha256Hex(fs.realpathSync(homedir))}`;
  for (;;) {
    signal?.throwIfAborted();
    const unlock = await tryLock(path.join(homedir, '.svall-mirror.lock'), name);
    if (unlock && signal?.aborted) unlock();
    else if (unlock) return unlock;
    await new Promise((r) => setTimeout(r, 100));
  }
}
