import { sweepAtExit } from '../../../../test/sweep.js';
import tmuxLock, { refusal } from '../../../../test/tmux-lock.js';
import { freePort, newHome, startDaemon } from './daemon.js';

export default async function globalSetup(): Promise<void> {
  // a throw, so Playwright stops the web server it has already started
  const no = refusal();
  if (no) throw Object.assign(new Error(no), { stack: no });
  // held until the runner's process ends
  await tmuxLock();
  // a run stopped before its teardown leaves its tmux server and daemons to the reaper
  const home = sweepAtExit(newHome(await freePort()));
  await startDaemon(home);
  process.env.SVALL_E2E_HOME = home;
}
