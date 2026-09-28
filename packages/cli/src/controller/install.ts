import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST, NAMESPACE, SIG, SUMS, verifyRelease, verifySignature, type Verify } from '../../../../scripts/release-manifest.mjs';
import { runProcess } from './process.js';
import { shellQuote, SshError, type SshMaster } from './ssh.js';

const TAR_TIMEOUT = 120_000;
const UPLOAD_TIMEOUT = 600_000;
const SETUP_TIMEOUT = 600_000;
const MAX_LISTING = 16 * 1024 * 1024;

/** What an archive says about itself, before a machine is asked to install it. */
export type CompanionArchive = { archive: string; version: string; platform: string; protocol: number; signed: boolean };

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/** Where a companion downloaded from a release manifest is kept. */
export const companionCache = (homedir: string = os.homedir()): string =>
  path.join(homedir, '.local', 'share', 'archipelago', 'companions');

async function tar(argv: string[], o: { timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<string> {
  const r = await runProcess('tar', argv, { timeoutMs: o.timeoutMs ?? TAR_TIMEOUT, maxOutputBytes: o.maxOutputBytes });
  if (r.code !== 0) throw new Error(`tar ${argv.join(' ')} exited ${r.code}: ${r.stderr.trim().slice(0, 400)}`);
  return r.stdout;
}

/**
 * The version, platform and protocol an archive names for itself, and whether this controller's own
 * signers vouch for it, checked over its SHA256SUMS before the rest is unpacked. The far machine's first
 * install checks the archive against the signers the archive carries, so it is authenticated here, before it is uploaded.
 */
export async function inspectCompanion(archive: string, o: { verify: Verify }): Promise<CompanionArchive> {
  const members = (await tar(['-tzf', archive], { maxOutputBytes: MAX_LISTING })).split('\n').filter(Boolean);
  const versions = new Set(members.map((m) => /^releases\/([^/]+)\//.exec(m)?.[1]).filter(Boolean));
  if (versions.size !== 1) throw new Error(`${archive} holds ${versions.size} releases, expected exactly one`);
  const [version] = [...versions] as string[];
  if (!members.includes(`releases/${version}/release.json`)) throw new Error(`${archive} carries no releases/${version}/release.json`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'archi-companion-'));
  try {
    const dir = path.join(work, 'releases', version);
    const manifest = [SUMS, SIG].map((f) => `releases/${version}/${f}`).filter((m) => members.includes(m));
    let checked: ReturnType<typeof verifyRelease>;
    try {
      if (manifest.length) await tar(['-xzf', archive, '-C', work, ...manifest]);
      verifySignature(dir, { verify: o.verify, allowUnsigned: true });
      await tar(['-xzf', archive, '-C', work]);
      checked = verifyRelease(dir, { verify: o.verify, allowUnsigned: true });
    } catch (err) {
      throw new Error(`${archive}: ${(err as Error).message}`);
    }
    const { release } = checked;
    if (release.version !== version) throw new Error(`${archive} unpacks as ${version} but its release.json says ${String(release.version)}`);
    return {
      archive,
      version,
      platform: String(release.platform ?? ''),
      protocol: Number(release.protocol),
      signed: checked.signed && release.unsigned !== true,
    };
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

/**
 * Fetches a published companion into the cache, keeping nothing whose digest is not the published one.
 * A development build names the companion it built beside it with a file: URL.
 */
export async function downloadCompanion(o: { url: string; sha256: string; dir: string; fetch: FetchLike }): Promise<string> {
  const url = new URL(o.url);
  const name = path.basename(url.pathname) || 'companion.tar.gz';
  const dest = path.join(o.dir, name);
  let body: Buffer;
  if (url.protocol === 'file:') {
    body = fs.readFileSync(fileURLToPath(url));
  } else {
    const res = await o.fetch(o.url);
    if (!res.ok) throw new Error(`${o.url}: HTTP ${res.status}`);
    body = Buffer.from(await res.arrayBuffer());
  }
  const digest = crypto.createHash('sha256').update(body).digest('hex');
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
  await remote(master, ['mkdir', '-p', shellQuote(dir)], `mkdir -p ${dir}`, TAR_TIMEOUT);
  const data = fs.readFileSync(o.archive);
  const r = await master.run(['sh', '-c', shellQuote('cat > "$1"'), '--', shellQuote(o.remote)], { input: data, timeoutMs: UPLOAD_TIMEOUT });
  if (r.code !== 0) throw new SshError(r.code === 255 ? 'unreachable' : 'other', `the companion could not be written to ${o.remote}: ${r.stderr.trim().slice(0, 400)}`);
}

// $1 the archive, $2 the staging folder, $3 the release asked for, $4 the installed release's allowed_signers, or empty
// to skip the signature. The signature over SHA256SUMS is checked before anything else leaves the archive; a signers
// file holding only comments pins no key, as a release built before one existed does. The PATH holds only system
// folders, so no relative entry in the login shell's can reach a tool the upload carries
const UNPACK = `PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH
dir="$2/releases/$3"
if [ -n "$4" ]; then
  [ -f "$4" ] || exit 5
  if grep -Eq '^[[:space:]]*[^#[:space:]]' "$4"; then
    tar -xzf "$1" -C "$2" "releases/$3/${SUMS}" "releases/$3/${SIG}" || exit 7
    ssh-keygen -Y verify -f "$4" -I ${NAMESPACE} -n ${NAMESPACE} -s "$dir/${SIG}" < "$dir/${SUMS}" >/dev/null || exit 3
    echo pinned
  else
    echo unpinned
  fi
fi
tar -xzf "$1" -C "$2" || exit 8
cd "$dir" || exit 1
sha256sum -c --strict --quiet ${SUMS} || exit 4
want=$(printf '  "version": "%s"' "$3")
grep -Fqx -e "$want," -e "$want" ${MANIFEST} || exit 6`;

/** How the far machine's own tools checked a staged release before any of it ran. */
export type FarCheck = 'pinned' | 'unpinned' | 'digests';

/**
 * Unpacks an uploaded archive into `staging` on the far machine and checks it there with ssh-keygen and sha256sum,
 * against the signers the release installed at `archiBase` pins, before anything the archive carries runs. Without
 * `archiBase` it checks the digests alone.
 */
async function unpackStaged(master: SshMaster, o: { archive: string; staging: string; version: string; archiBase?: string }): Promise<{ check: FarCheck; signers: string }> {
  const signers = o.archiBase === undefined ? '' : path.posix.join(o.archiBase, 'current', 'release', 'allowed_signers');
  const r = await master.run(['sh', '-c', shellQuote(UNPACK), 'archi-unpack', ...[o.archive, o.staging, o.version, signers].map(shellQuote)], { timeoutMs: TAR_TIMEOUT });
  const said = r.stderr.trim().slice(0, 400);
  const fail: Record<number, string> = {
    3: `the uploaded release is not signed by a key ${signers} pins: ${said || 'ssh-keygen refused it'}`,
    4: `the uploaded release's files do not match its ${SUMS}: ${said || 'sha256sum refused it'}`,
    5: `${signers} is missing, so the installed release names no signer to check the uploaded one against`,
    6: `the uploaded release's ${MANIFEST} does not name release ${o.version}, the one asked for`,
    7: `the uploaded archive carries no signed ${SUMS} for release ${o.version}: ${said}`,
  };
  if (r.code !== null && fail[r.code]) throw new SshError('other', fail[r.code]);
  if (r.code !== 0) throw new SshError(r.code === 255 ? 'unreachable' : 'other', `the far machine could not unpack and check the uploaded release (exit ${r.code}): ${said}`);
  const check = r.stdout.trim() === 'pinned' ? 'pinned' : r.stdout.trim() === 'unpinned' ? 'unpinned' : 'digests';
  return { check, signers };
}

const checked = (c: { check: FarCheck; signers: string }): string => ({
  pinned: `signed by a key ${c.signers} pins`,
  unpinned: 'the installed release pins no signer, so only this controller\'s signers vouched for it',
  digests: 'unsigned, checked by its digests alone',
})[c.check];

/**
 * Installs an uploaded archive with the `archi` unpacked from that same archive. On an upgrade, `installed` names the
 * far machine's archiBase, whose pinned signers check the staged release before its `archi` runs; a first install
 * has none, and rests on the controller's check before the upload.
 */
export async function bootstrapSetup(master: SshMaster, o: { staging: string; archive: string; version: string; allowUnsigned: boolean; installed?: string }): Promise<string> {
  await remote(master, ['mkdir', '-p', shellQuote(o.staging)], `mkdir -p ${o.staging}`, TAR_TIMEOUT);
  try {
    const far = await unpackStaged(master, { archive: o.archive, staging: o.staging, version: o.version, archiBase: o.allowUnsigned ? undefined : o.installed });
    const exe = path.posix.join(o.staging, 'releases', o.version, 'bin', 'archi');
    const out = await remote(master, [shellQuote(exe), 'setup', '--release', shellQuote(o.archive), ...(o.allowUnsigned ? ['--allow-unsigned'] : [])], 'archi setup', SETUP_TIMEOUT);
    return o.installed === undefined ? out : `${out.trimEnd()}; ${checked(far)}\n`;
  } finally {
    // setup copies what it installs into releases/, so neither the staged tree nor the upload is needed after it
    await master.run(['rm', '-rf', shellQuote(o.staging), shellQuote(o.archive)], { timeoutMs: TAR_TIMEOUT }).catch(() => undefined);
  }
}

/** The release the far machine's `current` names. */
export async function currentRelease(master: SshMaster, archiBase: string): Promise<string> {
  const link = path.posix.join(archiBase, 'current');
  return path.posix.basename((await remote(master, ['readlink', shellQuote(link)], `readlink ${link}`, TAR_TIMEOUT)).trim());
}

/**
 * Puts the far machine back on the release `to`, with the `archi` of the release `from` that an upgrade installed:
 * the one it replaced may predate naming a release to go back to.
 */
export function remoteRollback(master: SshMaster, o: { archiBase: string; from: string; to: string }): Promise<string> {
  const exe = path.posix.join(o.archiBase, 'releases', o.from, 'bin', 'archi');
  return remote(master, [shellQuote(exe), 'setup', '--rollback', shellQuote(o.to)], `archi setup --rollback ${o.to}`, SETUP_TIMEOUT);
}
