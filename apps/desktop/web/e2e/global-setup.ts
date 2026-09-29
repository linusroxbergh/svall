import { freePort, newHome, startDaemon } from './daemon.js';

export default async function globalSetup(): Promise<void> {
  const home = newHome(await freePort());
  await startDaemon(home);
  process.env.SVALL_E2E_HOME = home;
}
