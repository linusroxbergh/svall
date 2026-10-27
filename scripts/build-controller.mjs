#!/usr/bin/env node
// Builds the Mac controller release tree Svall.app carries and installs:
//
//   node scripts/build-controller.mjs --out <dir> [--version <id>] [--node-shasums <file>]
//                                       [--companion-url-base <url> [--companions <dir>]]
//
// With --companion-url-base the manifest also names the Linux companion archives built for this
// version, so `svall host add` can fetch the one matching a machine without being handed a path. A
// base relative to the release, as Svall.app's build passes, carries the archives inside it.

import path from 'node:path';
import { signManifest, writeManifest } from './release-manifest.mjs';
import { describeVersion, options, releaseKey, stageRelease } from './release-stage.mjs';

const o = options(process.argv.slice(2));
if (process.platform !== 'darwin') throw new Error(`the controller is a macOS release; this is ${process.platform}`);
const out = path.resolve(o.out);
const version = o.version ?? describeVersion();
const key = releaseKey();

const { stage, meta } = await stageRelease({
  out, version, platform: `darwin-${process.arch}`, shasums: o['node-shasums'],
  companionUrlBase: o['companion-url-base'], companionDir: o.companions,
});
const { entries } = writeManifest(stage, key ? meta : { ...meta, unsigned: true });
if (key) signManifest(stage, path.resolve(key));

process.stdout.write(`${JSON.stringify({ ...meta, stage, signed: Boolean(key), entries: entries.length }, null, 2)}\n`);
