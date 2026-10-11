import { execFile } from 'node:child_process';

// pmset lists Graphics among the system's capabilities only in a full wake; a dark wake (Power Nap, a maintenance
// wake) lacks it and sleeps again within seconds. Output without a capabilities line counts as awake
export function fullWakeIn(systemstate: string): boolean {
  const caps = /Capabilities are:(.*)/.exec(systemstate);
  return !caps || /\bGraphics\b/.test(caps[1]);
}

/** Whether the Mac is fully awake; anywhere else, or when pmset fails, it counts as awake. */
export function fullWake(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile('/usr/bin/pmset', ['-g', 'systemstate'], { timeout: 5_000 }, (err, out) => resolve(!!err || fullWakeIn(out)));
  });
}
