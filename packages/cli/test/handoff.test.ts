import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handoffTarget } from '../src/handoff.js';

describe('handoffTarget', () => {
  it('sends a Svall Dev home to svall-dev from the release CLI', () => {
    expect(handoffTarget({ SVALL_HOME: '/u/.svall-dev-work' }, '/u/.local/bin')).toBe('/u/.local/bin/svall-dev');
  });
  it('keeps its own homes, ad-hoc homes and no home at all', () => {
    for (const env of [{ SVALL_HOME: '/u/.svall' }, { SVALL_HOME: '/u/.svall-work' }, { SVALL_HOME: '/tmp/x' }, {}]) {
      expect(handoffTarget(env, '/u/.local/bin')).toBeUndefined();
    }
  });
});

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it('lets Svall Dev answer to svall until a release takes the name', async () => {
  vi.resetModules();
  vi.stubEnv('SVALL_VARIANT', 'dev');
  const { shimNames, shimText } = await import('@svall/svalld/setup');
  const { bundleRuntime } = await import('@svall/svalld/runtime');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-'));
  expect(shimNames(dir)).toEqual(['svall-dev', 'svall']);
  fs.writeFileSync(path.join(dir, 'svall'), shimText(bundleRuntime('/Applications/Svall.app')));
  expect(shimNames(dir)).toEqual(['svall-dev']);
});
