#!/usr/bin/env node
// Builds the Mac controller release tree Archipelago.app carries and installs:
//
//   node scripts/build-controller.mjs --out <dir> [--version <id>] [--node-shasums <file>]
//                                       [--companion-url-base <url> [--companions <dir>]]
//
// With --companion-url-base the manifest also names the Linux companion archives built for this
// version, so `archi host add` can fetch the one matching a machine without being handed a path.
//
// It is the companion tree plus the rsync 3.x the controller needs, because macOS ships openrsync,
// which cannot protect remote arguments or report byte progress. rsync is built from the pinned
// upstream source and cached under vendor/, so only the first build pays for it.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signManifest, writeManifest } from './release-manifest.mjs';
import { describeVersion, PINS, releaseKey, stageRelease, VENDOR } from './release-stage.mjs';

const run = (exe, argv, o = {}) => execFileSync(exe, argv, { stdio: ['ignore', 'pipe', 'inherit'], ...o });

const CONFIGURE = ['--disable-xxhash', '--disable-zstd', '--disable-lz4', '--disable-openssl', '--disable-md2man'];

/** The pinned rsync, built once per version and architecture and kept under vendor/ after that. */
async function rsync(arch) {
  const { version } = PINS.rsync;
  const cache = path.join(VENDOR, 'rsync', `${version}-${arch}`);
  const binary = path.join(cache, 'rsync');
  const licence = path.join(cache, 'COPYING');
  if (fs.existsSync(binary) && fs.existsSync(licence)) return { version, binary, licence, sha256: PINS.rsync.sha256 };

  const name = `rsync-${version}.tar.gz`;
  const tarball = path.join(VENDOR, 'rsync', name);
  if (!fs.existsSync(tarball)) {
    const url = `https://download.samba.org/pub/rsync/src/${name}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(tarball), { recursive: true });
    fs.writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  if (digest !== PINS.rsync.sha256) throw new Error(`${name} is not the pinned source: expected ${PINS.rsync.sha256}, got ${digest}`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'archi-rsync-'));
  try {
    run('tar', ['-xzf', tarball, '-C', work, '--strip-components', '1']);
    run('./configure', CONFIGURE, { cwd: work });
    run('make', ['-j', String(os.availableParallelism())], { cwd: work });
    fs.mkdirSync(cache, { recursive: true });
    fs.copyFileSync(path.join(work, 'rsync'), binary);
    fs.chmodSync(binary, 0o755);
    fs.copyFileSync(path.join(work, 'COPYING'), licence);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return { version, binary, licence, sha256: PINS.rsync.sha256 };
}

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
const r = await rsync(process.arch);
fs.copyFileSync(r.binary, path.join(stage, 'bin', 'rsync'));
fs.chmodSync(path.join(stage, 'bin', 'rsync'), 0o755);
fs.copyFileSync(r.licence, path.join(stage, 'licenses', 'rsync-LICENSE'));

const full = { ...meta, rsync: { version: r.version, sha256: r.sha256 } };
const { entries } = writeManifest(stage, key ? full : { ...full, unsigned: true });
if (key) signManifest(stage, path.resolve(key));

process.stdout.write(`${JSON.stringify({ ...full, stage, signed: Boolean(key), entries: entries.length }, null, 2)}\n`);
