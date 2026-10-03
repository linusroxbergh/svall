import fs from 'node:fs';

export type Logger = { info(msg: string): void; error(msg: string): void };

export function createLogger(file?: string): Logger {
  const write = (level: string, msg: string) => {
    const line = `${new Date().toISOString()} ${level} ${msg}\n`;
    // a log on a full disk or in a home that is gone has nowhere to say so, and must not take the daemon down
    if (!file) { process.stderr.write(line); return; }
    try { fs.appendFileSync(file, line); } catch { /* nowhere to say it */ }
  };
  return { info: (m) => write('info', m), error: (m) => write('error', m) };
}

// copied aside and truncated rather than renamed: launchd's stderr stays open on this file
export function rotateLog(file: string, maxBytes = 5 * 1024 * 1024): void {
  if (!fs.existsSync(file) || fs.statSync(file).size <= maxBytes) return;
  fs.copyFileSync(file, `${file}.1`);
  fs.truncateSync(file);
}

export const silentLogger: Logger = { info() {}, error() {} };
