import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudePaths } from '../src/resources/scan.js';

describe('test isolation', () => {
  it('keeps tests off the Claude config and the terminal of whoever runs them', () => {
    expect(claudePaths().dir).toBe(path.join(os.homedir(), '.claude'));
    expect(process.env.SVALL_TERM).toBeUndefined();
  });
});
