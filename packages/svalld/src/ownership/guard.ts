import type { MethodName } from '@svall/protocol';
import type { OwnershipState } from './state.js';

/**
 * What each call does to the fleet. Reads answer on an inactive replica, and the rest need an unfrozen owner. A new
 * method without a class fails typecheck.
 */
export const classification: Record<MethodName, 'read' | 'mutation' | 'terminal'> = {
  'state.get': 'read',
  'island.create': 'mutation',
  'island.update': 'mutation',
  'island.delete': 'mutation',
  'island.arrange': 'mutation',
  'island.show': 'read',
  'island.reorder': 'mutation',
  'robot.create': 'terminal',
  'robot.update': 'mutation',
  'robot.move': 'mutation',
  'robot.reorder': 'mutation',
  'robot.star': 'mutation',
  'robot.unstar': 'mutation',
  'robot.place': 'mutation',
  'robot.release': 'mutation',
  'robot.close': 'mutation',
  'robot.sleep': 'mutation',
  'robot.revive': 'terminal',
  'robot.fresh': 'terminal',
  'robot.seen': 'mutation',
  'robot.second': 'terminal',
  'robot.run': 'mutation',
  'robot.read': 'read',
  'robot.prompts': 'read',
  'robot.show': 'read',
  'robot.wait': 'read',
  'robot.answer': 'mutation',
  'robot.moveCheck': 'mutation',
  'robot.moveTo': 'mutation',
  'robot.moveRetry': 'mutation',
  'machines.list': 'read',
  'machines.refresh': 'read',
  'machines.setup': 'read',
  'machines.consent': 'mutation',
  'column.add': 'mutation',
  'column.rename': 'mutation',
  'column.reorder': 'mutation',
  'column.delete': 'mutation',
  'scribe.sweep': 'mutation',
  'scribe.set': 'mutation',
  'placing.set': 'mutation',
  'worktrees.set': 'mutation',
  'dormancy.set': 'mutation',
  'mainAgent.set': 'mutation',
  'model.set': 'mutation',
  'usage.get': 'read',
  'load.get': 'read',
  // listing, creating and starting other fleets on this Mac leaves this one alone
  'fleets.list': 'read',
  'fleets.create': 'read',
  'fleets.start': 'read',
  'fleet.rename': 'mutation',
  // a quit stops this machine's daemon; Fleet.stopAll ends agents only where the fleet is writable
  'fleet.stop': 'read',
  'mobile.get': 'read',
  'mobile.set': 'mutation',
  'resources.get': 'read',
  'resources.delete': 'mutation',
  'resources.restore': 'mutation',
  'fs.list': 'read',
  'fs.read': 'read',
  'fs.write': 'mutation',
  'docs.create': 'mutation',
  'docs.rename': 'mutation',
  'docs.delete': 'mutation',
  'repo.status': 'read',
  'repo.file': 'read',
  'repo.watch': 'read',
  'repo.unwatch': 'read',
  'push.key': 'read',
  'push.subscribe': 'mutation',
  'push.unsubscribe': 'mutation',
  'push.get': 'read',
  'browser.open': 'mutation',
  'browser.close': 'mutation',
  'browser.activate': 'mutation',
  'browser.update': 'mutation',
  'term.open': 'terminal',
  'term.input': 'mutation',
  'term.resize': 'mutation',
  // letting go of a terminal takes nothing from the fleet, so a replica may close what it opened
  'term.close': 'read',
  'term.lastScreen': 'read',
  'term.attach': 'terminal',
  'system.info': 'read',
};

/**
 * Throws before the handler runs when this machine may not do what the call asks. A `worker` serves a home's fleet:
 * what it does not read itself its home allows.
 */
export function guardMethod(ownership: OwnershipState, method: MethodName, worker = false): void {
  const kind = classification[method];
  if ((kind === 'mutation' || kind === 'terminal') && !worker) ownership.assertOwner(kind);
}
