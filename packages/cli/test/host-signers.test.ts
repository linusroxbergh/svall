import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const release = vi.hoisted(() => ({ root: undefined as string | undefined }));
vi.mock('@svall/svalld/release', async (actual) => ({
  ...await actual<typeof import('@svall/svalld/release')>(),
  isRelease: () => release.root !== undefined,
  releaseRoot: () => release.root ?? '/checkout',
}));
const { controllerSigners } = await import('../src/commands/host.js');

const saved = process.env.SVALL_RELEASE_ROOT;
afterEach(() => {
  release.root = undefined;
  if (saved === undefined) delete process.env.SVALL_RELEASE_ROOT;
  else process.env.SVALL_RELEASE_ROOT = saved;
});

it('checks a companion against the signers the app carries, when Terminal runs the app\'s bundle with no SVALL_RELEASE_ROOT', () => {
  delete process.env.SVALL_RELEASE_ROOT;
  release.root = '/Applications/Svall.app/Contents/Resources/release';
  expect(controllerSigners()).toBe('/Applications/Svall.app/Contents/Resources/release/release/allowed_signers');
});

it('checks it against the committed signers in a checkout', () => {
  delete process.env.SVALL_RELEASE_ROOT;
  expect(controllerSigners()).toBe(path.resolve(import.meta.dirname, '../../../scripts/release/allowed_signers'));
});
