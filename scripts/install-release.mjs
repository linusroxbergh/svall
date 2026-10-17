// Installs a release, on the Mac and on a Linux companion alike:
//
//   node scripts/install-release.mjs --release <dir or tarball> --prefix <dir>
//                                    [--allow-unsigned] [--allowed-signers <file>] [--signer <id>]
//
// The release is untrusted until it is authenticated, so nothing is written anywhere `current`
// could reach: it is staged, authenticated there, renamed whole into releases/<version>/, and only
// then reached by a `current` symlink renamed over the old one. The release `current` pointed at
// before stays for rollback, and every other is removed.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveRelease, KEEP_MODES, MANIFEST, SIG, SUMS, sshVerify, TAR, verifyRelease, verifySignature, verifyTree } from './release-manifest.mjs';

export const DEFAULT_PREFIX = path.join(os.homedir(), '.local', 'share', 'svall');

// an installed release carries the signers its own upgrades are checked against; a checkout has
// the committed file instead, and this module is inlined into `svall`, so it cannot climb to it
export const allowedSigners = () => (process.env.SVALL_RELEASE_ROOT
  ? path.join(process.env.SVALL_RELEASE_ROOT, 'release', 'allowed_signers')
  : path.join(path.dirname(fileURLToPath(import.meta.url)), 'release', 'allowed_signers'));

// the release names its own version, and that name becomes a directory under releases/
const VERSION = /^[A-Za-z0-9._+-]+$/;

const isTarball = (p) => /\.tar\.gz$|\.tgz$/.test(p);

const tar = (argv) => execFileSync(TAR, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });

const contentOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file) : undefined);

/**
 * Unpacks a release archive into `staging` and authenticates it there, as every installer of one does. It must hold one
 * release under a name an installer takes, each member a path in it spelled one way and listed once. The signature over
 * its SHA256SUMS is checked before anything else leaves the archive; after the rest is unpacked that SHA256SUMS must still
 * be the one there, since GNU tar writes a member under a link inside the release over a file it extracted by name, and
 * every file and the tree must match it. `verify(dir, signer)` throws to refuse a signature.
 */
export function stageArchive(archive, staging, o = {}) {
  const { version, members } = archiveRelease(archive, tar(['-tzf', archive]));
  if (!VERSION.test(version) || version === '.' || version === '..') throw new Error(`${archive} names its release ${JSON.stringify(version)}, which no installer takes`);
  if (!members.includes(`releases/${version}/${MANIFEST}`)) throw new Error(`${archive} carries no releases/${version}/${MANIFEST}`);
  fs.mkdirSync(staging, { recursive: true });
  const dir = path.join(staging, 'releases', version);
  let checked;
  try {
    const manifest = [SUMS, SIG].map((f) => `releases/${version}/${f}`).filter((m) => members.includes(m));
    if (manifest.length) tar(['-xz', ...KEEP_MODES, '-f', archive, '-C', staging, ...manifest]);
    const signed = verifySignature(dir, o);
    const sums = contentOf(path.join(dir, SUMS));
    tar(['-xz', ...KEEP_MODES, '-f', archive, '-C', staging]);
    const after = contentOf(path.join(dir, SUMS));
    if (sums === undefined ? after !== undefined : !after?.equals(sums)) throw new Error(`the archive writes over the ${SUMS} its signature was checked over`);
    checked = { ...verifyTree(dir, o), signed };
  } catch (e) {
    throw new Error(`${archive}: ${e.message}`);
  }
  if (checked.release.version !== version) throw new Error(`${archive} unpacks as ${version} but its ${MANIFEST} says ${checked.release.version}`);
  return { version, dir, ...checked };
}

/** Puts the release tree in `staging`, from a directory of one or from an archive holding one, and authenticates it. */
function stage(source, staging, o) {
  if (isTarball(source)) return stageArchive(source, staging, o);
  fs.mkdirSync(staging, { recursive: true });
  fs.cpSync(source, staging, { recursive: true, verbatimSymlinks: true });
  keepModes(source, staging);
  const checked = verifyRelease(staging, o);
  return { version: String(checked.release.version ?? ''), dir: staging, ...checked };
}

/** Gives every entry `cpSync` copied into `to` the mode it has in `from`, since the copy takes the umask off it. */
function keepModes(from, to) {
  for (const e of fs.readdirSync(to, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) keepModes(path.join(from, e.name), path.join(to, e.name));
    fs.chmodSync(path.join(to, e.name), fs.lstatSync(path.join(from, e.name)).mode & 0o7777);
  }
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
  let checked;
  let displaced;
  try {
    checked = stage(source, staging, { verify: o.verify, allowUnsigned: o.allowUnsigned, signer: o.signer });
    const release = path.join(releases, checked.version);
    if (!VERSION.test(checked.version) || path.dirname(release) !== releases)
      throw new Error(`${source} names an unusable release directory: ${JSON.stringify(checked.version)}`);
    fs.mkdirSync(releases, { recursive: true });
    // a build of the same name comes round again all the time in development; it takes that name
    // over only once it is whole, and the tree it replaces goes after `current` has moved
    if (fs.existsSync(release)) {
      displaced = path.join(releases, `.replaced-${checked.version}-${process.pid}`);
      fs.renameSync(release, displaced);
    }
    try {
      fs.renameSync(checked.dir, release);
    } catch (e) {
      if (displaced) fs.renameSync(displaced, release);
      throw e;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  const { version } = checked;
  const release = path.join(releases, version);
  // the tree a same-named reinstall replaced is gone, so the release before it is the one to go back to
  const was = before === undefined ? undefined : path.resolve(prefix, before);
  const back = was !== undefined && was !== release && fs.existsSync(was) ? was : otherReleases(releases, release)[0];
  // renaming a symlink over another is atomic, so `current` is never briefly absent or dangling
  const staged = `${current}.tmp-${process.pid}`;
  fs.rmSync(staged, { force: true });
  fs.symlinkSync(release, staged);
  fs.renameSync(staged, current);
  if (displaced) fs.rmSync(displaced, { recursive: true, force: true });
  for (const dir of otherReleases(releases, release)) if (dir !== back) fs.rmSync(dir, { recursive: true, force: true });

  return {
    prefix, version, current, release,
    signed: checked.signed,
    replaced: Boolean(displaced),
    entries: checked.entries.length,
    rollbackTo: back ?? null,
    releasesKept: fs.readdirSync(releases).sort(),
  };
}

/** The releases under `releases` but `current`, newest first. */
function otherReleases(releases, current) {
  return fs.readdirSync(releases)
    .map((name) => path.join(releases, name))
    .filter((dir) => dir !== current && fs.statSync(dir).isDirectory() && !path.basename(dir).startsWith('.'))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

/** Puts `current` back on `to`, or on the release before it, as atomically as the install moved it. */
export function rollbackRelease(prefix, to) {
  const root = path.resolve(prefix ?? DEFAULT_PREFIX);
  const releases = path.join(root, 'releases');
  const current = path.join(root, 'current');
  const from = fs.existsSync(current) ? fs.readlinkSync(current) : undefined;
  const release = to ? path.resolve(root, to) : otherReleases(releases, from === undefined ? undefined : path.resolve(root, from))[0];
  if (!release) throw new Error(`no release under ${releases} to go back to`);
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

// only when this file is the program: bundled into `svall`, it is a library the setup command calls
if (path.basename(process.argv[1] ?? '') === 'install-release.mjs') {
  process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`);
}
