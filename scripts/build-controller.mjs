#!/usr/bin/env node
// Builds the Mac controller release tree Svall.app carries and installs:
//
//   node scripts/build-controller.mjs --out <dir> [--version <id>] [--node-shasums <file>]
//                                       [--companion-url-base <url> [--companions <dir>]]
//
// With --companion-url-base the manifest also names the Linux companion archives built for this
// version, so `svall host add` can fetch the one matching a machine without being handed a path. A
// base relative to the release, as Svall.app's build passes, carries the archives inside it.
//
// It is the companion tree plus the rsync 3.x the controller needs, because macOS ships openrsync,
// which cannot protect remote arguments or report byte progress. rsync is built from the pinned
// upstream source and cached under vendor/, so only the first build pays for it; a signed release
// builds its own.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { signManifest, writeManifest } from './release-manifest.mjs';
import { describeVersion, pinnedRsync, releaseKey, RSYNC_CONFIGURE, stageRelease } from './release-stage.mjs';

const run = (exe, argv, o = {}) => execFileSync(exe, argv, { stdio: ['ignore', 'pipe', 'inherit'], ...o });

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
if (process.platform !== 'darwin') throw new Error(`the controller is a macOS release; this is ${process.platform}`);
const out = path.resolve(o.out);
const version = o.version ?? describeVersion();
const key = releaseKey();

const { stage, meta } = await stageRelease({
  out, version, platform: `darwin-${process.arch}`, shasums: o['node-shasums'],
  companionUrlBase: o['companion-url-base'], companionDir: o.companions,
});
const r = await pinnedRsync(process.arch, { fresh: Boolean(key) });
fs.copyFileSync(r.binary, path.join(stage, 'bin', 'rsync'));
fs.chmodSync(path.join(stage, 'bin', 'rsync'), 0o755);
// the debug map names each object file by the folder this machine built it in
run('strip', ['-S', path.join(stage, 'bin', 'rsync')]);
fs.copyFileSync(r.licence, path.join(stage, 'licenses', 'rsync-LICENSE'));
fs.copyFileSync(r.tarball, path.join(stage, 'licenses', path.basename(r.tarball)));
fs.appendFileSync(path.join(stage, 'licenses', 'NOTICE'), `rsync ${r.version} (bin/rsync)  GPL-3.0-or-later  licenses/rsync-LICENSE; `
  + `source licenses/${path.basename(r.tarball)}, built with ./configure ${RSYNC_CONFIGURE.join(' ')} and make, then strip -S\n`);

const full = { ...meta, rsync: { version: r.version, sha256: r.sha256 } };
const { entries } = writeManifest(stage, key ? full : { ...full, unsigned: true });
if (key) signManifest(stage, path.resolve(key));

process.stdout.write(`${JSON.stringify({ ...full, stage, signed: Boolean(key), entries: entries.length }, null, 2)}\n`);
