#!/usr/bin/env node
// Builds the Linux companion archives a desktop release publishes:
//
//   node scripts/build-companion.mjs --out <dir> [--arch x64,arm64] [--version <id>]
//                                    [--node-shasums <SHASUMS256.txt>]
//
// Each archive holds the bundled production JavaScript, the pinned Node runtime verified against
// nodejs.org, the phone bundle, the hook and mission-control templates and the licences of all of
// it, under releases/<version>/. SVALL_RELEASE_KEY signs the manifest; without it the release is
// marked unsigned and an installer will only take it with --allow-unsigned.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { signManifest, writeManifest } from './release-manifest.mjs';
import { describeVersion, releaseKey, stageRelease } from './release-stage.mjs';

function options(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument: ${argv[i]}`);
    o[argv[i].slice(2)] = argv[i += 1];
  }
  if (!o.out) throw new Error('--out <dir> is required');
  return o;
}

const o = options(process.argv.slice(2));
const out = path.resolve(o.out);
const version = o.version ?? describeVersion();
const key = releaseKey();
const built = [];

for (const arch of (o.arch ?? 'x64,arm64').split(',')) {
  const platform = `linux-${arch}`;
  // one staging tree per architecture, so the archives can be built and inspected side by side
  const tree = path.join(out, platform);
  const { stage, meta } = await stageRelease({ out: tree, version, platform, shasums: o['node-shasums'] });
  writeManifest(stage, key ? meta : { ...meta, unsigned: true });
  if (key) signManifest(stage, path.resolve(key));

  const tarball = path.join(out, `svall-companion-${version}-${platform}.tar.gz`);
  // macOS bsdtar otherwise carries every entry's Apple provenance xattr, as a pax header GNU tar
  // warns about and, once --no-xattrs silences that, as an AppleDouble `._` member
  execFileSync('tar', ['--no-xattrs', '-czf', tarball, '-C', tree, path.join('releases', version)], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  built.push({ arch, stage, tarball, tarballBytes: fs.statSync(tarball).size, ...meta });
}

process.stdout.write(`${JSON.stringify({ version, signed: Boolean(key), built }, null, 2)}\n`);
