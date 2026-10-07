import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PREFIX } from '../../../scripts/install-release.mjs';
import { isRelease, mobileDistDir } from './release.js';

// the app's runtime bundles define both; there every asset sits beside the bundle, and the helpers in Contents/Helpers
declare const SVALL_BUNDLED: boolean;
declare const SVALL_VERSION: string;

const here = path.dirname(fileURLToPath(import.meta.url));

/** Whether this code runs from Svall.app's runtime bundle rather than from a checkout's sources. */
export const bundled: boolean = typeof SVALL_BUNDLED !== 'undefined';

/** The app version the bundle was built as; undefined in a checkout. */
export const bundledVersion: string | undefined = typeof SVALL_VERSION !== 'undefined' ? SVALL_VERSION : undefined;

/** The version a daemon writes to its fleet's `version` file: the app's, or `dev` for a checkout. */
export const runtimeVersion = (): string => bundledVersion ?? 'dev';

export type Variant = 'release' | 'dev';
// a checkout is Svall Dev, so it never touches the release's fleets; the tests pin the release's names with SVALL_VARIANT
export const variant: Variant = bundled || isRelease() || process.env.SVALL_VARIANT === 'release' ? 'release' : 'dev';

/** A folder the daemon reads its own files from; a companion release's bundles sit in lib/, beside these folders. */
export const assetDir = (name: 'hooks' | 'home' | 'agent-profiles'): string =>
  bundled ? path.join(here, name) : path.resolve(here, '..', name);

/** The phone page svalld serves. */
export const mobileDist = (): string => (bundled ? path.join(here, 'mobile') : mobileDistDir());

/** A binary the app ships in Contents/Helpers; undefined in a checkout. */
export const helper = (name: string): string | undefined => bundled ? path.resolve(here, '../../Helpers', name) : undefined;

/** The compiled hook helper: the app's, or for Svall Dev the one apps/desktop/mac/build.sh put in its checkout's Svall Dev.app. */
export const hookHelperSource = (): string | undefined =>
  helper('svall-hook') ?? (variant === 'dev' ? path.resolve(here, '../../../apps/desktop/mac/build.noindex/Svall Dev.app/Contents/Helpers/svall-hook') : undefined);

const hookSwift = path.resolve(here, '../../../apps/desktop/mac/Sources/SvallHook');

/** What a checkout's helper must be newer than: its sources and the scripts it stands in for. The app's was built with its own. */
export const hookHelperSources = (): string[] => bundled ? [] : [
  ...fs.readdirSync(hookSwift).filter((f) => f.endsWith('.swift')).map((f) => path.join(hookSwift, f)),
  ...['agent-hook.mjs', 'claude-status.mjs'].map((name) => path.join(assetDir('hooks'), name)),
];

/** How to run the daemon and the CLI: from a checkout's sources through tsx, on the app's own node, or from a companion release. */
export type Runtime = { daemon: string[]; cli: string[]; bundle?: string; release?: string };

// tsx otherwise reads the tsconfig of the caller's cwd, whose paths can point @svall/* at another checkout
export const checkoutRuntime = (root: string): Runtime => {
  const tsx = path.join(root, 'node_modules/.bin/tsx');
  return {
    daemon: [tsx, path.join(root, 'packages/svalld/src/bin.ts')],
    cli: [tsx, '--tsconfig', path.join(root, 'tsconfig.json'), path.join(root, 'packages/cli/src/main.ts')],
  };
};

export const bundleRuntime = (app: string): Runtime => {
  const node = path.join(app, 'Contents/Helpers/node');
  const dir = path.join(app, 'Contents/Resources/runtime');
  return { daemon: [node, path.join(dir, 'svalld.mjs')], cli: [node, path.join(dir, 'svall.mjs')], bundle: app };
};

/** A companion release reached through `release`, the `current` link, so an upgrade that moves it needs no rewrite. */
export const releaseRuntime = (release: string): Runtime =>
  ({ daemon: [path.join(release, 'bin', 'svalld')], cli: [path.join(release, 'bin', 'svall')], release });

/** The runtime this code is running from. */
export const ownRuntime = (): Runtime => {
  if (bundled) return bundleRuntime(path.resolve(here, '../../..'));
  return isRelease() ? releaseRuntime(path.join(DEFAULT_PREFIX, 'current')) : checkoutRuntime(path.resolve(here, '../../..'));
};
