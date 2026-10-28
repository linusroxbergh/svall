import { app } from './boot.js';
import type { HostArgs, HostOp } from './bridge.js';

/** Runs one `svall host …` in the shell, and has the panel follow it. */
export function startHost(op: HostOp, args: HostArgs): void {
  app.store.getState().hostStarted(op, args);
  app.bridge.send({ type: 'host.start', op, args });
}
