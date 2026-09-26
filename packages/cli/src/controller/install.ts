import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRelease, type Verify } from '../../../../scripts/release-manifest.mjs';
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
 * signers vouch for it. The far machine's first install checks the archive against the signers the
 * archive carries, so it is authenticated here, before it is uploaded.
 */
export async function inspectCompanion(archive: string, o: { verify: Verify }): Promise<CompanionArchive> {
  const members = (await tar(['-tzf', archive], { maxOutputBytes: MAX_LISTING })).split('\n').filter(Boolean);
  const versions = new Set(members.map((m) => /^releases\/([^/]+)\//.exec(m)?.[1]).filter(Boolean));
  if (versions.size !== 1) throw new Error(`${archive} holds ${versions.size} releases, expected exactly one`);
  const [version] = [...versions] as string[];
  if (!members.includes(`releases/${version}/release.json`)) throw new Error(`${archive} carries no releases/${version}/release.json`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'archi-companion-'));
  try {
    await tar(['-xzf', archive, '-C', work]);
    let checked: ReturnType<typeof verifyRelease>;
    try {
      checked = verifyRelease(path.join(work, 'releases', version), { verify: o.verify, allowUnsigned: true });
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

/**
 * Installs an uploaded archive with the `archi` unpacked from that same archive, which authenticates
 * its own signature before anything reaches `current`.
 */
export async function bootstrapSetup(master: SshMaster, o: { staging: string; archive: string; version: string; allowUnsigned: boolean }): Promise<string> {
  await remote(master, ['mkdir', '-p', shellQuote(o.staging)], `mkdir -p ${o.staging}`, TAR_TIMEOUT);
  try {
    await remote(master, ['tar', '-xzf', shellQuote(o.archive), '-C', shellQuote(o.staging)], `tar -xzf ${o.archive}`, TAR_TIMEOUT);
    const exe = path.posix.join(o.staging, 'releases', o.version, 'bin', 'archi');
    return await remote(master, [shellQuote(exe), 'setup', '--release', shellQuote(o.archive), ...(o.allowUnsigned ? ['--allow-unsigned'] : [])], 'archi setup', SETUP_TIMEOUT);
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
