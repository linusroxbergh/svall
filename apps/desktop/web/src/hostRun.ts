import { app } from './boot.js';
import type { HostArgs, HostOp } from './bridge.js';
import { OP_TITLE } from './host.js';

/** Runs one `svall host …` in the shell, and has the panel follow it; none while another runs, as the shell runs one at a time. */
export function startHost(op: HostOp, args: HostArgs): boolean {
  const s = app.store.getState();
  if (s.host?.running) {
    s.showToast(`${OP_TITLE[s.host.op]} is still running; try again once it ends`);
    return false;
  }
  s.hostStarted(op, args);
  app.bridge.send({ type: 'host.start', op, args });
  return true;
}
