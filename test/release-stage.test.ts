import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeRuntime, PINS, pinnedRsync, schemaVersions, VENDOR } from '../scripts/release-stage.mjs';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const temp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archi-release-stage-'));
  dirs.push(dir);
  return dir;
};

describe('the versions a release records', () => {
  it('names each version a handover has to agree on, and nothing a build leaves empty', async () => {
    const versions = await schemaVersions(temp());
    expect(Object.keys(versions).sort()).toEqual(['authoritySchema', 'protocol', 'stateSchema', 'transferSchema']);
    for (const [name, v] of Object.entries(versions)) expect(Number.isInteger(v), name).toBe(true);
  });
});

describe('the Node runtime a release carries', () => {
  it('has a digest pinned for every platform a release is built for', () => {
    for (const platform of PINS.node.platforms) expect(PINS.node.sha256[platform], platform).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a cached tarball that is not the pinned one, whatever digests sit cached beside it', async () => {
    const vendor = temp();
    const name = `node-${PINS.node.version}-linux-x64.tar.xz`;
    fs.mkdirSync(path.join(vendor, 'node'));
    fs.writeFileSync(path.join(vendor, 'node', name), 'not node');
    const shasums = path.join(vendor, 'SHASUMS256.txt');
    fs.writeFileSync(shasums, `${crypto.createHash('sha256').update('not node').digest('hex')}  ${name}\n`);
    await expect(nodeRuntime('linux-x64', { vendor, shasums })).rejects.toThrow(`${name} is not the pinned runtime`);
  });

  const cached = ['darwin-arm64', 'linux-arm64', 'linux-x64'].find((p) => fs.existsSync(path.join(VENDOR, 'node', `node-${PINS.node.version}-${p}.tar.xz`)))
    && fs.existsSync(path.join(VENDOR, 'node', `SHASUMS256-${PINS.node.version}.txt`));
  it.skipIf(!cached)('takes the pinned tarball the build cached (skipped with none cached)', async () => {
    const platform = ['darwin-arm64', 'linux-arm64', 'linux-x64'].find((p) => fs.existsSync(path.join(VENDOR, 'node', `node-${PINS.node.version}-${p}.tar.xz`)))!;
    const runtime = await nodeRuntime(platform);
    expect(runtime.sha256).toBe(PINS.node.sha256[platform]);
  });
});

describe('the rsync a controller release carries', () => {
  const source = path.join(VENDOR, 'rsync', `rsync-${PINS.rsync.version}.tar.gz`);
  // a vendor/ holding the pinned source and, where a build cached its rsync, a binary that is not one
  const vendor = (): string => {
    const dir = temp();
    const cache = path.join(dir, 'rsync', `${PINS.rsync.version}-${process.arch}`);
    fs.mkdirSync(cache, { recursive: true });
    fs.copyFileSync(source, path.join(dir, 'rsync', path.basename(source)));
    fs.writeFileSync(path.join(cache, 'rsync'), '#!/bin/sh\necho planted\n', { mode: 0o755 });
    fs.writeFileSync(path.join(cache, 'COPYING'), 'GPL\n');
    return dir;
  };

  it.skipIf(!fs.existsSync(source))('is the one a development build cached (skipped without the source cached)', async () => {
    const r = await pinnedRsync(process.arch, { vendor: vendor() });
    expect(execFileSync(r.binary, { encoding: 'utf8' })).toBe('planted\n');
  });

  // configure and make take half a minute
  it.skipIf(!fs.existsSync(source) || !process.env.ARCHI_TEST_RSYNC_BUILD)('is built from the pinned source for a signed release, whatever is cached (set ARCHI_TEST_RSYNC_BUILD=1 to run)', async () => {
    const r = await pinnedRsync(process.arch, { vendor: vendor(), fresh: true });
    expect(execFileSync(r.binary, ['--version'], { encoding: 'utf8' })).toMatch(new RegExp(`^rsync +version ${PINS.rsync.version.replace(/\./g, '\\.')} `));
  }, 300_000);
});
