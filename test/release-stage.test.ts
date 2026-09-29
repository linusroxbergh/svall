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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-release-stage-'));
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
  it.skipIf(!fs.existsSync(source) || !process.env.SVALL_TEST_RSYNC_BUILD)('is built from the pinned source for a signed release, whatever is cached (set SVALL_TEST_RSYNC_BUILD=1 to run)', async () => {
    const r = await pinnedRsync(process.arch, { vendor: vendor(), fresh: true });
    expect(execFileSync(r.binary, ['--version'], { encoding: 'utf8' })).toMatch(new RegExp(`^rsync +version ${PINS.rsync.version.replace(/\./g, '\\.')} `));
  }, 300_000);
});

describe('the release workflow', () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, '../.github/workflows/release.yml'), 'utf8');
  const jobs = new Map(text.split(/^jobs:$/m)[1].split(/^(?= {2}[\w-]+:$)/m).filter((j) => j.trim()).map((j) => [j.trim().split(':')[0], j]));
  const steps = [...jobs.values()].flatMap((j) => j.split(/^(?= {6}- )/m).slice(1));

  it('hands the signing key only to the steps that check it and sign, never to a whole job or the build, and leaves nothing behind', () => {
    expect([...jobs.keys()].filter((name) => jobs.get(name)!.includes('secrets.SVALL_RELEASE_KEY')).sort()).toEqual(['key', 'publish', 'sign']);
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('secrets.SVALL_RELEASE_KEY')) return;
      expect(line).toMatch(/^ {10}\w+: \$\{\{ secrets\.SVALL_RELEASE_KEY \}\}$/);
      // the key the line sits under: a step's own env:, never a job's or the workflow's
      expect(lines.slice(0, i).reverse().find((l) => /^ {0,9}\S/.test(l))).toMatch(/^( {8}| {6}- )env:$/);
    });
    for (const step of steps.filter((s) => s.includes('secrets.SVALL_RELEASE_KEY'))) expect(step).toContain(`trap 'rm -f "$RUNNER_TEMP/release-key"' EXIT`);
    expect(text).not.toMatch(/GITHUB_ENV|GITHUB_PATH/);
  });
});

it.each(['release.yml', 'ci.yml'])('%s runs every action at a commit, never at a tag that can move', (file) => {
  const text = fs.readFileSync(path.join(import.meta.dirname, '../.github/workflows', file), 'utf8');
  const uses = [...text.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  expect(uses.length).toBeGreaterThan(0);
  for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
});
