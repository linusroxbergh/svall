#!/usr/bin/env node
// Builds the Linux companion archives a desktop release publishes:
//
//   node scripts/build-companion.mjs --out <dir> [--arch x64,arm64] [--version <id>]
//                                    [--node-shasums <SHASUMS256.txt>]
//
// Each archive holds the bundled production JavaScript, the pinned Node runtime verified against
// nodejs.org, the tmux scripts/tmux-build.sh builds for it, the phone bundle, the hook and
// mission-control templates and the licences of all of it, under releases/<version>/.
// SVALL_RELEASE_KEY signs the manifest; without it the release is marked unsigned and an installer
// will only take it with --allow-unsigned.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signManifest, writeManifest } from './release-manifest.mjs';
import { describeVersion, options, releaseKey, stageRelease } from './release-stage.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The tmux the units start, as Ubuntu 24.04's is too old for Shift+Enter, and the licences of what is linked into it. */
function stageTmux(stage, arch) {
  const binary = execFileSync(path.join(REPO, 'scripts/tmux-build.sh'), ['--linux', arch], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  // the folder is named for the versions it was built from: <tmux>-libevent-<version>-utf8proc-<version>-linux-<arch>
  const [, tmux, libevent, utf8proc] = /^(.+)-libevent-(.+)-utf8proc-(.+)-linux-[^-]+$/.exec(path.basename(path.dirname(binary)));
  fs.copyFileSync(binary, path.join(stage, 'bin', 'tmux'));
  fs.chmodSync(path.join(stage, 'bin', 'tmux'), 0o755);
  for (const name of ['tmux', 'libevent', 'utf8proc']) {
    fs.copyFileSync(path.join(path.dirname(binary), `LICENSE.${name}`), path.join(stage, 'licenses', `${name}-LICENSE`));
  }
  fs.appendFileSync(path.join(stage, 'licenses', 'NOTICE'), `tmux ${tmux} (bin/tmux)  ISC  licenses/tmux-LICENSE\n`
    + `libevent ${libevent} (linked into bin/tmux)  BSD-3-Clause  licenses/libevent-LICENSE\n`
    + `utf8proc ${utf8proc} (linked into bin/tmux)  MIT  licenses/utf8proc-LICENSE\n`);
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
  stageTmux(stage, arch);
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
