import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL_VERSION } from '@svall/protocol';
import { signManifest, sshVerify, writeManifest, type Verify } from '../../../../scripts/release-manifest.mjs';

/** An ed25519 release key that lives only for one test, and the verifier that trusts it. */
export function ephemeralSigner(dir: string): { key: string; signers: string; verify: Verify } {
  const key = path.join(fs.mkdtempSync(path.join(dir, 'key-')), 'release');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'svall-release', '-f', key]);
  const signers = `${key}.signers`;
  const pub = fs.readFileSync(`${key}.pub`, 'utf8').split(' ').slice(0, 2).join(' ');
  fs.writeFileSync(signers, `svall-release namespaces="svall-release" ${pub}\n`);
  return { key, signers, verify: sshVerify({ allowedSigners: signers }) };
}

export type ArchiveOptions = {
  version?: string; platform?: string; protocol?: number; signedBy?: string; unsigned?: boolean;
  /** the allowed_signers the archive carries for its own upgrades */
  signersInside?: string;
  /** what its bin/svall runs */
  svall?: string;
  /** more executables it carries, by path in the release */
  files?: Record<string, string>;
};

// as build-companion.mjs packs one, so a Linux tar finds no AppleDouble member the Mac's bsdtar would add
const buildEnv = (): NodeJS.ProcessEnv => ({ ...process.env, COPYFILE_DISABLE: '1' });

/** A companion archive with a real manifest, signed by `signedBy` when that key is given. */
export function companionArchive(work: string, o: ArchiveOptions = {}): string {
  const version = o.version ?? '1.2.3';
  const platform = o.platform ?? 'linux-arm64';
  const tree = fs.mkdtempSync(path.join(work, 'tree-'));
  const dir = path.join(tree, 'releases', version);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'svall'), o.svall ?? '#!/bin/sh\n', { mode: 0o755 });
  for (const [rel, text] of Object.entries(o.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text, { mode: 0o755 });
  }
  if (o.signersInside) {
    fs.mkdirSync(path.join(dir, 'release'));
    fs.copyFileSync(o.signersInside, path.join(dir, 'release', 'allowed_signers'));
  }
  writeManifest(dir, { version, platform, protocol: o.protocol ?? PROTOCOL_VERSION, ...(o.signedBy && !o.unsigned ? {} : { unsigned: true }) });
  if (o.signedBy) signManifest(dir, o.signedBy);
  const tarball = path.join(work, `svall-companion-${version}-${platform}-${crypto.randomBytes(3).toString('hex')}.tar.gz`);
  execFileSync('tar', ['--no-xattrs', '-czf', tarball, '-C', tree, path.join('releases', version)], { env: buildEnv() });
  return tarball;
}

const REL = 'releases/1.2.3';
const MANIFEST_FILES = ['SHA256SUMS', 'SHA256SUMS.sig'];

function unpacked(work: string, archive: string): string {
  const tree = fs.mkdtempSync(path.join(work, 'unpacked-'));
  execFileSync('tar', ['-xzf', archive, '-C', tree]);
  return tree;
}

/** Members taken from several trees into one archive, in order and spelled as given, as no build writes one. */
function mixed(work: string, parts: [tree: string, members: string[]][]): string {
  const tarball = path.join(work, `crafted-${crypto.randomBytes(3).toString('hex')}.tar.gz`);
  execFileSync('tar', ['--no-xattrs', '-czf', tarball, ...parts.flatMap(([tree, members]) => ['-C', tree, ...members])], { env: buildEnv() });
  return tarball;
}

/**
 * Release 1.2.3 from `intruder`, with the SHA256SUMS and signature from `genuine` under their plain names, where an
 * installer that extracts them by name finds them, and the intruder's own after them under `spell(member)`.
 */
export function smuggledArchive(work: string, o: { genuine: string; intruder: string; spell: (member: string) => string }): string {
  const genuine = unpacked(work, o.genuine);
  const intruder = unpacked(work, o.intruder);
  const rest = fs.readdirSync(path.join(intruder, REL)).filter((f) => !MANIFEST_FILES.includes(f)).map((f) => `${REL}/${f}`);
  const sums = MANIFEST_FILES.map((f) => `${REL}/${f}`);
  return mixed(work, [[intruder, rest], [genuine, sums], [intruder, sums.map(o.spell)]]);
}

/** The `genuine` release 1.2.3, then a link in it to its own folder, and the `intruder`'s release written through that link. */
export function linkedArchive(work: string, o: { genuine: string; intruder: string }): string {
  const genuine = unpacked(work, o.genuine);
  const link = fs.mkdtempSync(path.join(work, 'link-'));
  fs.mkdirSync(path.join(link, REL), { recursive: true });
  fs.symlinkSync('.', path.join(link, REL, 'd'));
  const through = fs.mkdtempSync(path.join(work, 'through-'));
  fs.mkdirSync(path.join(through, REL), { recursive: true });
  fs.renameSync(path.join(unpacked(work, o.intruder), REL), path.join(through, REL, 'd'));
  const files = fs.readdirSync(path.join(through, REL, 'd'), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile()).map((e) => path.relative(through, path.join(e.parentPath, e.name)));
  return mixed(work, [[genuine, [REL]], [link, [`${REL}/d`]], [through, files]]);
}
