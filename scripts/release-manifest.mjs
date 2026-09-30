// The manifest a release carries and an installer checks it against.
//
// release.json describes every entry — its type, mode, size, content digest and link target —
// and SHA256SUMS carries a digest for every file including release.json, so one detached signature
// over SHA256SUMS covers the whole description. Nothing here downloads anything, and only signing a
// built archive unpacks one.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MANIFEST = 'release.json';
export const SUMS = 'SHA256SUMS';
export const SIG = 'SHA256SUMS.sig';
export const NAMESPACE = 'svall-release';

// covered by the signature rather than by the entry list, so the list never has to describe itself
const SELF = [MANIFEST, SUMS, SIG];

// tar options that extract each entry with the mode release.json records and nothing else: the Mac's bsdtar -p would
// also restore ACLs, file flags and xattrs, which nothing signed describes
export const KEEP_MODES = process.platform === 'darwin' ? ['-p', '--no-acls', '--no-fflags', '--no-xattrs', '--no-mac-metadata'] : ['-p'];

// the tar KEEP_MODES is written for: on the Mac its own bsdtar, not whichever tar comes first on PATH
export const TAR = process.platform === 'darwin' ? '/usr/bin/tar' : 'tar';

const digestOf = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Every entry under `dir` but the manifest's own files, sorted so two walks of one tree agree. */
export function entriesOf(dir) {
  const out = [];
  const walk = (sub) => {
    for (const e of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (!sub && SELF.includes(e.name)) continue;
      const full = path.join(dir, rel);
      const stat = fs.lstatSync(full);
      const mode = (stat.mode & 0o7777).toString(8);
      if (stat.isSymbolicLink()) out.push({ path: rel, type: 'symlink', mode, target: fs.readlinkSync(full) });
      else if (stat.isDirectory()) { out.push({ path: rel, type: 'dir', mode }); walk(rel); }
      else if (stat.isFile()) out.push({ path: rel, type: 'file', mode, size: stat.size, sha256: digestOf(full) });
      else throw new Error(`${rel} is neither a file, a directory nor a symlink`);
    }
  };
  walk('');
  return out.sort(byPath);
}

/** One digest over the entries alone, so a rebuilt tree can be compared without walking it twice. */
export function manifestDigest(entries) {
  const canonical = [...entries].sort(byPath)
    .map((e) => [e.path, e.type, e.mode, e.size ?? '', e.sha256 ?? '', e.target ?? ''].join('\0'));
  return crypto.createHash('sha256').update(canonical.join('\n')).digest('hex');
}

const sumsText = (lines) => lines.map(({ sha256, path: p }) => `${sha256}  ${p}\n`).join('');

/** Writes release.json, then SHA256SUMS over every file in the tree including release.json. */
export function writeManifest(dir, meta) {
  const entries = entriesOf(dir);
  const release = { ...meta, entriesDigest: manifestDigest(entries), files: entries };
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(release, null, 2) + '\n');
  const lines = [...entries.filter((e) => e.type === 'file'),
    { path: MANIFEST, sha256: digestOf(path.join(dir, MANIFEST)) }].sort(byPath);
  fs.writeFileSync(path.join(dir, SUMS), sumsText(lines));
  return { entries, release };
}

export function signManifest(dir, keyFile) {
  // ssh-keygen asks before it writes over a signature, and without an answer keeps the old one
  fs.rmSync(path.join(dir, SIG), { force: true });
  execFileSync('ssh-keygen', ['-Y', 'sign', '-f', keyFile, '-n', NAMESPACE, path.join(dir, SUMS)], { stdio: 'pipe' });
}

/**
 * Signs, in place, an archive a build packed unsigned, re-pinning each companion at the archive beside it now
 * (so sign the companions first).
 */
export function signArchive(archive, keyFile) {
  const { version } = archiveRelease(archive, execFileSync(TAR, ['-tzf', archive], { encoding: 'utf8' }));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-sign-'));
  try {
    execFileSync(TAR, ['-xz', ...KEEP_MODES, '-f', archive, '-C', work]);
    const dir = path.join(work, 'releases', version);
    const { files, entriesDigest, unsigned, ...meta } = verifyTree(dir, { allowUnsigned: true }).release;
    for (const c of Object.values(meta.companions ?? {})) c.sha256 = digestOf(path.join(path.dirname(archive), path.basename(c.url)));
    writeManifest(dir, meta);
    signManifest(dir, keyFile);
    execFileSync(TAR, ['--no-xattrs', '-czf', archive, '-C', work, path.join('releases', version)], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** The default verifier: a detached ssh signature over SHA256SUMS from a pinned allowed signer. */
export const sshVerify = (o) => (dir, signer) => {
  execFileSync('ssh-keygen', ['-Y', 'verify', '-f', o.allowedSigners, '-I', signer, '-n', NAMESPACE, '-s', path.join(dir, SIG)],
    { input: fs.readFileSync(path.join(dir, SUMS)), stdio: ['pipe', 'pipe', 'pipe'] });
};

function checkSums(dir) {
  const listed = new Map();
  dir = path.resolve(dir);
  for (const line of fs.readFileSync(path.join(dir, SUMS), 'utf8').split('\n').filter(Boolean)) {
    const want = line.slice(0, 64);
    const rel = line.slice(66);
    if (!/^[0-9a-f]{64}$/.test(want) || line[64] !== ' ' || !rel)
      throw new Error(`${SUMS}: not a digest line: ${JSON.stringify(line)}`);
    const file = path.resolve(dir, rel);
    if (!file.startsWith(dir + path.sep)) throw new Error(`${SUMS} names a path outside the release: ${rel}`);
    if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`${SUMS} names ${rel}, which is not a file here`);
    const got = digestOf(file);
    if (got !== want) throw new Error(`${rel}: expected ${want}, got ${got}`);
    listed.set(rel, want);
  }
  if (!listed.has(MANIFEST)) throw new Error(`${SUMS} does not cover ${MANIFEST}`);
  return listed;
}

/**
 * The one release an archive holds, from its `tar -t` listing. Every member must be a path in releases/<version>,
 * spelled one way and listed once, so a full unpack writes no other spelling over a file an installer extracted by name.
 */
export function archiveRelease(archive, listing) {
  const members = listing.split('\n').filter(Boolean);
  const versions = new Set(members.map((m) => /^releases\/([^/]+)\//.exec(m)?.[1]).filter(Boolean));
  if (versions.size !== 1) throw new Error(`${archive} holds ${versions.size} releases, expected exactly one`);
  const [version] = versions;
  const seen = new Set();
  for (const member of members) {
    const name = member.replace(/\/$/, '');
    const inside = name === 'releases' || name === `releases/${version}` || name.startsWith(`releases/${version}/`);
    if (!inside || name.includes('\\') || name.split('/').some((s) => s === '' || s === '.' || s === '..'))
      throw new Error(`${archive} holds ${JSON.stringify(member)}, which is not a path in releases/${version}`);
    if (seen.has(name)) throw new Error(`${archive} holds ${JSON.stringify(member)} twice`);
    seen.add(name);
  }
  return { version, members };
}

const describe = (e) => JSON.stringify({ type: e.type, mode: e.mode, size: e.size, sha256: e.sha256, target: e.target });

/**
 * The signature over SHA256SUMS alone, which needs nothing else of the release: an installer checks it
 * before it unpacks the rest. Whether the release is signed; `verify(dir, signer)` throws to refuse.
 */
export function verifySignature(dir, o = {}) {
  dir = path.resolve(dir);
  const signer = o.signer ?? NAMESPACE;
  const signed = fs.existsSync(path.join(dir, SIG));
  if (signed) {
    if (!o.verify) throw new Error(`${dir} is signed but no verifier was given`);
    try { o.verify(dir, signer); } catch (e) {
      throw new Error(`${SUMS} is not signed by ${signer}: ${String(e.stderr ?? '').trim() || e.message}`);
    }
  } else if (!o.allowUnsigned) {
    throw new Error(`${dir} carries no ${SIG}; install it with --allow-unsigned or get a signed release`);
  }
  return signed;
}

/**
 * Authenticates an unpacked release in place: the signature over SHA256SUMS, then every digest it
 * lists, then the tree against release.json in both directions. `verify(dir, signer)` throws to refuse.
 */
export function verifyRelease(dir, o = {}) {
  const signer = o.signer ?? NAMESPACE;
  const signed = verifySignature(dir, o);
  return { ...verifyTree(dir, o), signed, signer: signed ? signer : undefined };
}

/** Every digest SHA256SUMS lists, then the tree against release.json in both directions: what follows the signature. */
export function verifyTree(dir, o = {}) {
  dir = path.resolve(dir);
  const listed = checkSums(dir);
  const release = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
  if (release.unsigned && !o.allowUnsigned) throw new Error(`${dir} was built without a signing key; install it with --allow-unsigned`);

  const want = new Map((release.files ?? []).map((e) => [e.path, e]));
  const found = new Map(entriesOf(dir).map((e) => [e.path, e]));
  for (const [p, e] of want) {
    const got = found.get(p);
    if (!got) throw new Error(`${MANIFEST} lists ${p}, which the release does not carry`);
    if (describe(got) !== describe(e)) throw new Error(`${p} is not what ${MANIFEST} describes: ${describe(e)} against ${describe(got)}`);
  }
  for (const p of found.keys()) if (!want.has(p)) throw new Error(`${p} is in the release but not in ${MANIFEST}`);
  for (const p of listed.keys()) if (p !== MANIFEST && want.get(p)?.type !== 'file') throw new Error(`${SUMS} lists ${p}, which ${MANIFEST} does not carry as a file`);
  for (const [p, e] of want) if (e.type === 'file' && !listed.has(p)) throw new Error(`${p} is in ${MANIFEST} but not in ${SUMS}`);

  return { release, entries: [...found.values()] };
}
