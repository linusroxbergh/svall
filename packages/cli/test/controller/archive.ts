import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL_VERSION } from '@archipelago/protocol';
import { signManifest, sshVerify, writeManifest, type Verify } from '../../../../scripts/release-manifest.mjs';

/** An ed25519 release key that lives only for one test, and the verifier that trusts it. */
export function ephemeralSigner(dir: string): { key: string; signers: string; verify: Verify } {
  const key = path.join(fs.mkdtempSync(path.join(dir, 'key-')), 'release');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'archipelago-release', '-f', key]);
  const signers = `${key}.signers`;
  const pub = fs.readFileSync(`${key}.pub`, 'utf8').split(' ').slice(0, 2).join(' ');
  fs.writeFileSync(signers, `archipelago-release namespaces="archipelago-release" ${pub}\n`);
  return { key, signers, verify: sshVerify({ allowedSigners: signers }) };
}

export type ArchiveOptions = {
  version?: string; platform?: string; protocol?: number; signedBy?: string; unsigned?: boolean;
  /** the allowed_signers the archive carries for its own upgrades */
  signersInside?: string;
  /** what its bin/archi runs */
  archi?: string;
  /** more executables it carries, by path in the release */
  files?: Record<string, string>;
};

/** A companion archive with a real manifest, signed by `signedBy` when that key is given. */
export function companionArchive(work: string, o: ArchiveOptions = {}): string {
  const version = o.version ?? '1.2.3';
  const platform = o.platform ?? 'linux-arm64';
  const tree = fs.mkdtempSync(path.join(work, 'tree-'));
  const dir = path.join(tree, 'releases', version);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'archi'), o.archi ?? '#!/bin/sh\n', { mode: 0o755 });
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
  const tarball = path.join(work, `archipelago-companion-${version}-${platform}-${crypto.randomBytes(3).toString('hex')}.tar.gz`);
  execFileSync('tar', ['-czf', tarball, '-C', tree, path.join('releases', version)]);
  return tarball;
}
