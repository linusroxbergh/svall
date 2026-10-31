import { sweepAtExit } from '../../../../test/sweep.js';
import tmuxLock from '../../../../test/tmux-lock.js';
import { freePort, newHome, startDaemon } from './daemon.js';

export default async function globalSetup(): Promise<void> {
  // held until the runner's process ends
  await tmuxLock();
  // a run stopped before its teardown leaves its tmux server and daemons to the reaper
  const home = sweepAtExit(newHome(await freePort()));
  await startDaemon(home);
  process.env.SVALL_E2E_HOME = home;
}
