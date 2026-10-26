import { describe, expect, it } from 'vitest';
import { Mutation } from '../src/journal.js';
import { Robot } from '../src/state.js';

const minimalRobot = {
  id: 'c_1', islandId: 'home', cell: { x: 1, y: 1 }, name: 'n', portrait: 'owl', note: '', instructions: '', cwd: '/tmp', context: [], shell: { lastOutputAt: 0 }, unread: false,
};

describe('robot placement', () => {
  it('a robot without machine, placement or moving parses, as every state before 11 wrote it', () => {
    expect(Robot.safeParse({ ...minimalRobot }).success).toBe(true);
  });

  it('keepHere is no longer a field', () => {
    expect(Robot.parse({ ...minimalRobot, keepHere: true })).not.toHaveProperty('keepHere');
  });

  it('a mutation parses with its id, method and snapshot version; a bad id does not', () => {
    expect(Mutation.parse({ id: 'mu_0123456789', method: 'robot.close', params: { id: 'c_1' }, snapshotVersion: 3, at: 1 })).toMatchObject({ id: 'mu_0123456789', method: 'robot.close' });
    expect(Mutation.safeParse({ id: 'x', method: 'robot.close', params: {}, snapshotVersion: 3, at: 1 }).success).toBe(false);
  });
});
