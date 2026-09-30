import path from 'node:path';
import { fileURLToPath } from 'node:url';

// the app's runtime bundles define both; there every asset sits beside the bundle, and the helpers in Contents/Helpers
declare const SVALL_BUNDLED: boolean;
declare const SVALL_VERSION: string;

const here = path.dirname(fileURLToPath(import.meta.url));

/** Whether this code runs from Svall.app's runtime bundle rather than from a checkout's sources. */
export const bundled: boolean = typeof SVALL_BUNDLED !== 'undefined';

/** The app version the bundle was built as; undefined in a checkout. */
export const bundledVersion: string | undefined = typeof SVALL_VERSION !== 'undefined' ? SVALL_VERSION : undefined;

export type Variant = 'release' | 'dev';
// a checkout is Svall Dev, so it never touches the release's fleets; the tests pin the release's names with SVALL_VARIANT
export const variant: Variant = bundled || process.env.SVALL_VARIANT === 'release' ? 'release' : 'dev';

/** A folder the daemon reads its own files from. */
export const assetDir = (name: 'hooks' | 'home' | 'agent-profiles'): string =>
  bundled ? path.join(here, name) : path.resolve(here, '..', name);

/** The phone page svalld serves. */
export const mobileDist = bundled ? path.join(here, 'mobile') : path.resolve(here, '../../../apps/desktop/web/dist-mobile');

/** A binary the app ships in Contents/Helpers; undefined in a checkout. */
export const helper = (name: string): string | undefined => bundled ? path.resolve(here, '../../Helpers', name) : undefined;
