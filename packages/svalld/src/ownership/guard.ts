import type { MethodName } from '@svall/protocol';
import type { Viewer } from '../terminals.js';
import type { OwnershipState } from './state.js';

/**
 * What each call does to the fleet. Reads answer on an inactive replica, transaction calls are the
 * handover itself, recovery takes a forced record from a client holding the token, and the rest need
 * an unfrozen owner. A new method without a class fails typecheck.
 */
export const classification: Record<MethodName, 'read' | 'mutation' | 'terminal' | 'transaction' | 'recovery'> = {
  'state.get': 'read',
  'island.create': 'mutation',
  'island.update': 'mutation',
  'island.delete': 'mutation',
  'island.arrange': 'mutation',
  'island.show': 'read',
  'island.reorder': 'mutation',
  'char.create': 'terminal',
  'char.update': 'mutation',
  'char.move': 'mutation',
  'char.reorder': 'mutation',
  'char.close': 'mutation',
  'char.revive': 'terminal',
  'char.seen': 'mutation',
  'char.second': 'terminal',
  'char.run': 'mutation',
  'char.read': 'read',
  'char.prompts': 'read',
  'char.show': 'read',
  'char.wait': 'read',
  'char.answer': 'mutation',
  'scribe.sweep': 'mutation',
  'scribe.set': 'mutation',
  'dormancy.set': 'mutation',
  'mainAgent.set': 'mutation',
  'usage.get': 'read',
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
  'term.attach': 'terminal',
  'system.info': 'read',
  'ownership.get': 'read',
  'ownership.adopt': 'recovery',
  'handover.preflight': 'transaction',
  'handover.inspect': 'read',
  'handover.freeze': 'transaction',
  'handover.claim': 'transaction',
  'handover.prepare': 'transaction',
  'handover.activate': 'transaction',
  'handover.complete': 'transaction',
  'handover.abort': 'transaction',
  'handover.status': 'read',
  // it runs git on a path the caller names, so only the controller asks it
  'handover.reaches': 'transaction',
};

/** Throws before the handler runs when this machine may not do what the call asks, or this caller may not ask it. */
export function guardMethod(ownership: OwnershipState, method: MethodName, caller?: Viewer['kind']): void {
  const kind = classification[method];
  // a phone watches a handover and never drives one; an inspection hashes the roots and reads the folders this machine holds
  if ((kind === 'recovery' || kind === 'transaction' || method === 'handover.inspect') && caller !== 'app') {
    throw Object.assign(new Error(`${method} answers only a client that holds this fleet's token`), { code: 'unauthorized' });
  }
  if (kind === 'mutation' || kind === 'terminal') ownership.assertOwner(kind);
}
