import { describe, expect, it } from 'vitest';
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
});
