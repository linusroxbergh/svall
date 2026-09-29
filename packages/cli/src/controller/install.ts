import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shq } from '@svall/svalld/text';
import { stageArchive } from '../../../../scripts/install-release.mjs';
import { MANIFEST, NAMESPACE, SIG, SUMS, type Verify } from '../../../../scripts/release-manifest.mjs';
import { SshError, type SshMaster } from './ssh.js';

const TAR_TIMEOUT = 120_000;
const UPLOAD_TIMEOUT = 600_000;
const SETUP_TIMEOUT = 600_000;

/** What an archive says about itself, before a machine is asked to install it. */
export type CompanionArchive = { archive: string; version: string; platform: string; protocol: number; signed: boolean };

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/** Where a companion downloaded from a release manifest is kept. */
export const companionCache = (homedir: string = os.homedir()): string =>
  path.join(homedir, '.local', 'share', 'svall', 'companions');

/**
 * The version, platform and protocol an archive names for itself, and whether this controller's own signers vouch for
 * it, staged and checked as the installer stages it. The far machine's first install checks the archive against the
 * signers the archive carries, so it is authenticated here, before it is uploaded.
 */
export async function inspectCompanion(archive: string, o: { verify: Verify }): Promise<CompanionArchive> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-companion-'));
  try {
    const s = stageArchive(archive, work, { verify: o.verify, allowUnsigned: true });
    return { archive, version: s.version, platform: String(s.release.platform ?? ''), protocol: Number(s.release.protocol), signed: s.signed && s.release.unsigned !== true };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Whether this controller may install this archive on a machine of this architecture. */
export function requireCompatible(c: CompanionArchive, o: { release: string; protocol: number; arch: string; allowUnsigned?: boolean }): void {
  const want = `linux-${o.arch}`;
  if (c.platform !== want) throw new Error(`${c.archive} is built for ${c.platform || 'no platform'}, not for ${want}`);
  if (c.protocol !== o.protocol) throw new Error(`${c.archive} speaks protocol ${c.protocol}, not this controller's ${o.protocol}`);
  // a development controller has no release of its own to match, so the protocol is the whole agreement
  if (o.release !== 'dev' && c.version !== o.release) {
    throw new Error(`${c.archive} is release ${c.version}, not this controller's ${o.release}; a handover needs the same release on both machines`);
  }
  if (!c.signed && !o.allowUnsigned) throw new Error(`${c.archive} carries no signature; install it with --allow-unsigned or get a signed release`);
}

/**
 * The companion this desktop release publishes for a platform, from its own manifest, and whether that
 * manifest is itself an unsigned development build's.
 */
export function companionAsset(releaseRoot: string, platform: string): { url: string; sha256: string; unsignedBuild: boolean } | undefined {
  let manifest: { unsigned?: unknown; companions?: Record<string, { url?: unknown; sha256?: unknown }> };
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(releaseRoot, 'release.json'), 'utf8')) as typeof manifest;
  } catch {
    return undefined;
  }
  const asset = manifest.companions?.[platform];
  if (typeof asset?.url !== 'string' || typeof asset.sha256 !== 'string') return undefined;
  return { url: asset.url, sha256: asset.sha256, unsignedBuild: manifest.unsigned === true };
}

const sha256Of = (body: Buffer): string => crypto.createHash('sha256').update(body).digest('hex');

/**
 * Fetches a published companion into the cache, keeping nothing whose digest is not the published one, unless the cache
 * holds it already. A development build names the companion it built beside it with a file: URL, which its next build deletes.
 */
export async function downloadCompanion(o: { url: string; sha256: string; dir: string; fetch: FetchLike }): Promise<string> {
  const url = new URL(o.url);
  const name = path.basename(url.pathname) || 'companion.tar.gz';
  const dest = path.join(o.dir, name);
  let cached: Buffer | undefined;
  try { cached = fs.readFileSync(dest); } catch { /* not in the cache yet */ }
  if (cached && sha256Of(cached) === o.sha256) return dest;
  let body: Buffer;
  if (url.protocol === 'file:') {
    body = fs.readFileSync(fileURLToPath(url));
  } else {
    const res = await o.fetch(o.url);
    if (!res.ok) throw new Error(`${o.url}: HTTP ${res.status}`);
    body = Buffer.from(await res.arrayBuffer());
  }
  const digest = sha256Of(body);
  if (digest !== o.sha256) throw new Error(`${o.url} is not the published companion: expected digest ${o.sha256}, got ${digest}`);
  fs.mkdirSync(o.dir, { recursive: true });
  const part = `${dest}.part-${process.pid}`;
  fs.writeFileSync(part, body);
  fs.renameSync(part, dest);
  return dest;
}

async function remote(master: SshMaster, argv: string[], what: string, timeoutMs: number): Promise<string> {
  const r = await master.run(argv, { timeoutMs });
  if (r.code !== 0) throw new SshError(r.code === 255 ? 'unreachable' : 'other', `${what} exited ${r.code}: ${r.stderr.trim().slice(0, 400)}`);
  return r.stdout;
}

/** Streams the archive onto the far machine. The far shell is handed one word for the path. */
export async function uploadArchive(master: SshMaster, o: { archive: string; remote: string }): Promise<void> {
  const dir = path.posix.dirname(o.remote);
  await remote(master, ['mkdir', '-p', shq(dir)], `mkdir -p ${dir}`, TAR_TIMEOUT);
  const data = fs.readFileSync(o.archive);
  const r = await master.run(['sh', '-c', shq('cat > "$1"'), '--', shq(o.remote)], { input: data, timeoutMs: UPLOAD_TIMEOUT });
  if (r.code !== 0) throw new SshError(r.code === 255 ? 'unreachable' : 'other', `the companion could not be written to ${o.remote}: ${r.stderr.trim().slice(0, 400)}`);
}

// $1 the archive, $2 the staging folder, $3 the release asked for, $4 the far svallBase, or empty to skip the signature.
// Every member must be a path in releases/$3, spelled one way and listed once. Where a release is installed, the
// signature over SHA256SUMS is checked against the signers it pins before anything else leaves the archive, and again
// after, since GNU tar writes a member under a link over the file it extracted by name; a signers file holding only
// comments pins no key, as a release built before one existed does. The PATH holds only system folders, so no relative
// entry in the login shell's can reach a tool the upload carries
const UNPACK = `PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH
dir="$2/releases/$3"
signers="$4/current/release/allowed_signers"
verify() { ssh-keygen -Y verify -f "$signers" -I ${NAMESPACE} -n ${NAMESPACE} -s "$dir/${SIG}" < "$dir/${SUMS}" >/dev/null; }
members=$(tar -tzf "$1") || exit 8
printf '%s\\n' "$members" | awk -v r="releases/$3" '
  function no(why) { printf "the uploaded archive holds \\"%s\\"%s\\n", $0, why > "/dev/stderr"; exit 1 }
  { n = $0; sub("/$", "", n); k = split(n, s, "/")
    for (i = 1; i <= k; i++) if (s[i] == "" || s[i] == "." || s[i] == "..") no(", which is not a path in " r)
    if (index(n, "\\\\") || (n != "releases" && n != r && index(n, r "/") != 1)) no(", which is not a path in " r)
    if (seen[n]++) no(" twice") }' || exit 9
pinned=
if [ -z "$4" ]; then
  :
elif [ ! -e "$4/current" ] && [ ! -L "$4/current" ]; then
  echo first
elif [ ! -f "$signers" ]; then
  exit 5
elif grep -Eq '^[[:space:]]*[^#[:space:]]' "$signers"; then
  tar -xzf "$1" -C "$2" "releases/$3/${SUMS}" "releases/$3/${SIG}" || exit 7
  verify || exit 3
  pinned=1
  echo pinned
else
  echo unpinned
fi
tar -xzf "$1" -C "$2" || exit 8
[ -z "$pinned" ] || verify || exit 3
cd "$dir" || exit 1
sha256sum -c --strict --quiet ${SUMS} || exit 4
want=$(printf '  "version": "%s"' "$3")
grep -Fqx -e "$want," -e "$want" ${MANIFEST} || exit 6`;

/** How the far machine's own tools checked a staged release before any of it ran. */
export type FarCheck = 'pinned' | 'unpinned' | 'first' | 'digests';

/**
 * Unpacks an uploaded archive into `staging` on the far machine and checks it there with ssh-keygen and sha256sum,
 * against the signers the release installed at `svallBase` pins, before anything the archive carries runs. Without
 * `svallBase` it checks the digests alone.
 */
async function unpackStaged(master: SshMaster, o: { archive: string; staging: string; version: string; svallBase?: string }): Promise<{ check: FarCheck; signers: string }> {
  const signers = path.posix.join(o.svallBase ?? '', 'current', 'release', 'allowed_signers');
  const r = await master.run(['sh', '-c', shq(UNPACK), 'svall-unpack', ...[o.archive, o.staging, o.version, o.svallBase ?? ''].map(shq)], { timeoutMs: TAR_TIMEOUT });
  const said = r.stderr.trim().slice(0, 400);
  const fail: Record<number, string> = {
    3: `the uploaded release is not signed by a key ${signers} pins: ${said || 'ssh-keygen refused it'}`,
    4: `the uploaded release's files do not match its ${SUMS}: ${said || 'sha256sum refused it'}`,
    5: `${signers} is missing, so the installed release names no signer to check the uploaded one against`,
    6: `the uploaded release's ${MANIFEST} does not name release ${o.version}, the one asked for`,
    7: `the uploaded archive carries no signed ${SUMS} for release ${o.version}: ${said}`,
    // after any warning the system's tar printed while it listed the archive
    9: r.stderr.trim().split('\n').at(-1) ?? '',
  };
  if (r.code !== null && fail[r.code]) throw new SshError('other', fail[r.code]);
  if (r.code !== 0) throw new SshError(r.code === 255 ? 'unreachable' : 'other', `the far machine could not unpack and check the uploaded release (exit ${r.code}): ${said}`);
  const how = r.stdout.trim();
  return { check: how === 'pinned' || how === 'unpinned' || how === 'first' ? how : 'digests', signers };
}

const checked = (c: { check: FarCheck; signers: string }): string => ({
  pinned: `signed by a key ${c.signers} pins`,
  unpinned: 'the installed release pins no signer, so only this controller\'s signers vouched for it',
  first: 'no release is installed there yet, so only this controller\'s signers vouched for it',
  digests: 'unsigned, checked by its digests alone',
})[c.check];

/**
 * Installs an uploaded archive with the `svall` unpacked from that same archive. `installed` names the far machine's
 * svallBase: a release installed there checks the staged one with its pinned signers before its `svall` runs, and a
 * machine with none rests on the controller's check before the upload.
 */
export async function bootstrapSetup(master: SshMaster, o: { staging: string; archive: string; version: string; allowUnsigned: boolean; installed: string }): Promise<string> {
  await remote(master, ['mkdir', '-p', shq(o.staging)], `mkdir -p ${o.staging}`, TAR_TIMEOUT);
  try {
    const far = await unpackStaged(master, { archive: o.archive, staging: o.staging, version: o.version, svallBase: o.allowUnsigned ? undefined : o.installed });
    const exe = path.posix.join(o.staging, 'releases', o.version, 'bin', 'svall');
    const out = await remote(master, [shq(exe), 'setup', '--release', shq(o.archive), ...(o.allowUnsigned ? ['--allow-unsigned'] : [])], 'svall setup', SETUP_TIMEOUT);
    return `${out.trimEnd()}; ${checked(far)}\n`;
  } finally {
    // setup copies what it installs into releases/, so neither the staged tree nor the upload is needed after it
    await master.run(['rm', '-rf', shq(o.staging), shq(o.archive)], { timeoutMs: TAR_TIMEOUT }).catch(() => undefined);
  }
}

/** The release the far machine's `current` names. */
export async function currentRelease(master: SshMaster, svallBase: string): Promise<string> {
  const link = path.posix.join(svallBase, 'current');
  return path.posix.basename((await remote(master, ['readlink', shq(link)], `readlink ${link}`, TAR_TIMEOUT)).trim());
}

/**
 * Puts the far machine back on the release `to`, or without one on the newest other release it keeps, with the `svall`
 * of the release `from` that an upgrade installed: the one it replaced may predate naming a release to go back to.
 */
export function remoteRollback(master: SshMaster, o: { svallBase: string; from: string; to?: string }): Promise<string> {
  const exe = path.posix.join(o.svallBase, 'releases', o.from, 'bin', 'svall');
  const to = o.to === undefined ? [] : [o.to];
  return remote(master, [shq(exe), 'setup', '--rollback', ...to.map(shq)], ['svall setup --rollback', ...to].join(' '), SETUP_TIMEOUT);
}
