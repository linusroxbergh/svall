import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// the one place the layout is named: a published release exports SVALL_RELEASE_ROOT from its bin/
// shims, and a development build runs from the checkout this module was compiled out of
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKOUT = path.resolve(HERE, '../../..');

// Svall.app's runtime bundle defines it, and the app carries its controller release beside that bundle
declare const SVALL_BUNDLED: boolean;

const root = (): string | undefined =>
  process.env.SVALL_RELEASE_ROOT || (typeof SVALL_BUNDLED !== 'undefined' ? path.resolve(HERE, '../release') : undefined);

export function isRelease(): boolean {
  return root() !== undefined;
}

/** Where this build keeps the assets it ships. */
export function releaseRoot(): string {
  return root() ?? CHECKOUT;
}

/** The checkout a development build runs from; a published release has none. */
export function repoRoot(): string {
  if (isRelease()) throw new Error('this is an installed release, not a checkout');
  if (!fs.existsSync(path.join(CHECKOUT, 'pnpm-workspace.yaml')))
    throw new Error(`no Svall checkout at ${CHECKOUT}`);
  return CHECKOUT;
}

const asset = (release: string, checkout: string): string =>
  (root() ? path.join(root()!, release) : path.join(CHECKOUT, checkout));

/** The systemd user unit templates a Linux setup renders. */
export const systemdDir = (): string => asset('systemd', 'packages/svalld/systemd');

/** The svall a companion installed under `svallBase` runs: the one in the release `current` points at. */
export const svallExe = (svallBase: string): string => path.posix.join(svallBase, 'current', 'bin', 'svall');

/** The askpass the first ssh of `svall host add` asks through when there is no terminal. */
export const askpassPath = (): string => asset('bin/svall-askpass', 'scripts/release/svall-askpass');

/** Where `svall mobile` builds the phone page, and where svalld serves it from. */
export const mobileDistDir = (): string => asset('web-mobile', 'apps/desktop/web/dist-mobile');

/** The svalld build a handover compares against the other machine's. */
export function releaseVersion(): string {
  const dir = root();
  if (!dir) return 'dev';
  try {
    const version = (JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' && version ? version : 'dev';
  } catch {
    return 'dev';
  }
}
