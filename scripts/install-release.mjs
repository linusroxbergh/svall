// Installs a release, on the Mac and on a Linux companion alike:
//
//   node scripts/install-release.mjs --release <dir or tarball> --prefix <dir>
//                                    [--allow-unsigned] [--allowed-signers <file>] [--signer <id>]
//
// The release is untrusted until it is authenticated, so nothing is written anywhere `current`
// could reach: it is staged, authenticated there, renamed whole into releases/<version>/, and only
// then reached by a `current` symlink renamed over the old one. The release `current` pointed at
// before stays for rollback.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST, SIG, SUMS, sshVerify, verifyRelease, verifySignature } from './release-manifest.mjs';

export const DEFAULT_PREFIX = path.join(os.homedir(), '.local', 'share', 'archipelago');

// an installed release carries the signers its own upgrades are checked against; a checkout has
// the committed file instead, and this module is inlined into `archi`, so it cannot climb to it
export const allowedSigners = () => (process.env.ARCHI_RELEASE_ROOT
  ? path.join(process.env.ARCHI_RELEASE_ROOT, 'release', 'allowed_signers')
  : path.join(path.dirname(fileURLToPath(import.meta.url)), 'release', 'allowed_signers'));

// the release names its own version, and that name becomes a directory under releases/
const VERSION = /^[A-Za-z0-9._+-]+$/;

const isTarball = (p) => /\.tar\.gz$|\.tgz$/.test(p);

/**
 * Puts the release tree in `staging`, from a directory of one or from an archive holding one. An archive's
 * signature over its SHA256SUMS is checked before anything else leaves it.
 */
function stage(source, staging, o) {
  fs.mkdirSync(staging, { recursive: true });
  if (!isTarball(source)) {
    fs.cpSync(source, staging, { recursive: true, verbatimSymlinks: true });
    const version = JSON.parse(fs.readFileSync(path.join(staging, MANIFEST), 'utf8')).version;
    return { version: String(version ?? ''), dir: staging };
  }
  const members = execFileSync('tar', ['-tzf', source], { encoding: 'utf8' }).split('\n');
  const versions = new Set(members.map((m) => /^releases\/([^/]+)\//.exec(m)?.[1]).filter(Boolean));
  if (versions.size !== 1) throw new Error(`${source} holds ${versions.size} releases, expected exactly one`);
  const [version] = versions;
  const dir = path.join(staging, 'releases', version);
  const manifest = [SUMS, SIG].map((f) => `releases/${version}/${f}`).filter((m) => members.includes(m));
  if (manifest.length) execFileSync('tar', ['-xzf', source, '-C', staging, ...manifest], { stdio: 'pipe' });
  verifySignature(dir, o);
  execFileSync('tar', ['-xzf', source, '-C', staging], { stdio: 'pipe' });
  return { version, dir };
}

/**
 * Installs `source` under `prefix` and points `current` at it. `verify(dir, signer)` throws to
 * refuse a signature; without `allowUnsigned` a release carrying none is refused outright.
 */
export function installRelease(o) {
  const source = path.resolve(o.source);
  const prefix = path.resolve(o.prefix ?? DEFAULT_PREFIX);
  const releases = path.join(prefix, 'releases');
  const current = path.join(prefix, 'current');
  fs.mkdirSync(prefix, { recursive: true });
  const before = fs.existsSync(current) ? fs.readlinkSync(current) : undefined;

  const staging = path.join(prefix, `.staging-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  let version;
  let checked;
  let displaced;
  try {
    const staged = stage(source, staging, { verify: o.verify, allowUnsigned: o.allowUnsigned, signer: o.signer });
    version = staged.version;
    const release = path.join(releases, version);
    if (!VERSION.test(version) || path.dirname(release) !== releases)
      throw new Error(`${source} names an unusable release directory: ${JSON.stringify(version)}`);
    checked = verifyRelease(staged.dir, { verify: o.verify, allowUnsigned: o.allowUnsigned, signer: o.signer });
    if (checked.release.version !== version)
      throw new Error(`${source} unpacks as ${version} but ${MANIFEST} says ${checked.release.version}`);
    fs.mkdirSync(releases, { recursive: true });
    // a build of the same name comes round again all the time in development; it takes that name
    // over only once it is whole, and the tree it replaces goes after `current` has moved
    if (fs.existsSync(release)) {
      displaced = path.join(releases, `.replaced-${version}-${process.pid}`);
      fs.renameSync(release, displaced);
    }
    try {
      fs.renameSync(staged.dir, release);
    } catch (e) {
      if (displaced) fs.renameSync(displaced, release);
      throw e;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  // renaming a symlink over another is atomic, so `current` is never briefly absent or dangling
  const release = path.join(releases, version);
  const staged = `${current}.tmp-${process.pid}`;
  fs.rmSync(staged, { force: true });
  fs.symlinkSync(release, staged);
  fs.renameSync(staged, current);
  if (displaced) fs.rmSync(displaced, { recursive: true, force: true });

  return {
    prefix, version, current, release,
    signed: checked.signed,
    replaced: Boolean(displaced),
    entries: checked.entries.length,
    rollbackTo: before ?? null,
    releasesKept: fs.readdirSync(releases).sort(),
  };
}

/** The newest release that is not the one `current` is on. */
function previousRelease(releases, current) {
  const others = fs.readdirSync(releases)
    .map((name) => path.join(releases, name))
    .filter((dir) => dir !== current && fs.statSync(dir).isDirectory() && !path.basename(dir).startsWith('.'))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!others.length) throw new Error(`no release under ${releases} to go back to`);
  return others[0];
}

/** Puts `current` back on `to`, or on the release before it, as atomically as the install moved it. */
export function rollbackRelease(prefix, to) {
  const root = path.resolve(prefix ?? DEFAULT_PREFIX);
  const releases = path.join(root, 'releases');
  const current = path.join(root, 'current');
  const from = fs.existsSync(current) ? fs.readlinkSync(current) : undefined;
  const release = to ? path.resolve(root, to) : previousRelease(releases, from);
  if (!fs.existsSync(release)) throw new Error(`no release at ${release} to go back to`);
  const staged = `${current}.tmp-${process.pid}`;
  fs.rmSync(staged, { force: true });
  fs.symlinkSync(release, staged);
  fs.renameSync(staged, current);
  return { prefix: root, current, release, version: path.basename(release), from: from ?? null };
}

function options(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) throw new Error(`bad argument: ${argv[i]}`);
    const key = argv[i].slice(2);
    if (key === 'allow-unsigned') { o.allowUnsigned = true; continue; }
    if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`);
    o[key] = argv[i += 1];
  }
  if (!o.release) throw new Error('--release <dir or tarball> is required');
  return o;
}

export function main(argv) {
  const o = options(argv);
  const signers = o['allowed-signers'] ?? allowedSigners();
  return installRelease({
    source: o.release,
    prefix: o.prefix,
    signer: o.signer,
    allowUnsigned: o.allowUnsigned,
    verify: sshVerify({ allowedSigners: signers }),
  });
}

// only when this file is the program: bundled into `archi`, it is a library the setup command calls
if (path.basename(process.argv[1] ?? '') === 'install-release.mjs') {
  process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`);
}
