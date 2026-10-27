import fs from 'node:fs';
import net from 'node:net';

// macOS's O_EXLOCK, which node names no constant for
const O_EXLOCK = 0x20;

/**
 * A lock the kernel holds until it is let go or its process dies, however it dies; undefined while another holds it. On
 * macOS it is `file` opened with O_EXLOCK; Linux ignores O_EXLOCK, so there it is the abstract unix socket `name`.
 */
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
