import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { onPath } from '../src/agents.js';
import { claudePaths } from '../src/paths.js';

describe('test isolation', () => {
  it('keeps tests off the Claude config and the terminal of whoever runs them', () => {
    expect(claudePaths().dir).toBe(path.join(os.homedir(), '.claude'));
    expect(process.env.SVALL_TERM).toBeUndefined();
  });

  it("finds a double for every CLI a test could reach the owner's machine through, before the real one", () => {
    const doubles = [process.env.SVALL_TEST_BIN, path.join(import.meta.dirname, 'fixtures/bin')];
    for (const bin of ['claude', 'codex', 'tailscale', 'gh', 'launchctl']) expect(doubles, bin).toContain(onPath(bin, process.env.PATH!));
  });
});
