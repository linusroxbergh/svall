import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// the one place the layout is named: a published release exports ARCHI_RELEASE_ROOT from its bin/
// shims, and a development build runs from the checkout this module was compiled out of
const CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const root = (): string | undefined => process.env.ARCHI_RELEASE_ROOT || undefined;

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
    throw new Error(`no Archipelago checkout at ${CHECKOUT}`);
  return CHECKOUT;
}

const asset = (release: string, checkout: string): string =>
  (root() ? path.join(root()!, release) : path.join(CHECKOUT, checkout));

export const hooksDir = (): string => asset('hooks', 'packages/archid/hooks');

export const homeTemplateDir = (): string => asset('home', 'packages/archid/home');

/** The systemd user unit templates a Linux setup renders. */
export const systemdDir = (): string => asset('systemd', 'packages/archid/systemd');

/** The archi a companion installed under `archiBase` runs: the one in the release `current` points at. */
export const archiExe = (archiBase: string): string => path.posix.join(archiBase, 'current', 'bin', 'archi');

/** The askpass the first ssh of `archi host add` asks through when there is no terminal. */
export const askpassPath = (): string => asset('bin/archi-askpass', 'scripts/release/archi-askpass');

/** Where `archi mobile` builds the phone page, and where archid serves it from. */
export const mobileDistDir = (): string => asset('web-mobile', 'apps/desktop/web/dist-mobile');

/** The archid build a handover compares against the other machine's. */
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
