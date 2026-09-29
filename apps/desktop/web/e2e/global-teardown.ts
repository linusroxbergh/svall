import fs from 'node:fs';
import { killTmux, stopDaemon } from './daemon.js';

export default async function globalTeardown(): Promise<void> {
  const home = process.env.SVALL_E2E_HOME;
  if (!home) return;
  await stopDaemon(home);
  killTmux(home);
  fs.rmSync(home, { recursive: true, force: true });
}
