import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { carryCompanions, companionAssets, nodeRuntime, PINS, releaseKey, schemaVersions, stageAssets, VENDOR, WORKERS } from '../scripts/release-stage.mjs';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const temp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-release-stage-'));
  dirs.push(dir);
  return dir;
};

describe('the versions a release records', () => {
  it('names each version every machine of a fleet has to agree on, and nothing a build leaves empty', async () => {
    const versions = await schemaVersions(temp());
    expect(Object.keys(versions).sort()).toEqual(['protocol', 'stateSchema']);
    for (const [name, v] of Object.entries(versions)) expect(Number.isInteger(v), name).toBe(true);
  });
});

describe('the bundles a release carries', () => {
  it("holds each worker svalld starts, as the app's runtime does", () => {
    expect(WORKERS).toContainEqual({ name: 'retro-index', entry: 'packages/svalld/src/retro/index-worker.ts' });
    const app = fs.readFileSync(path.join(import.meta.dirname, '../scripts/runtime-bundle.mjs'), 'utf8');
    for (const { name, entry } of WORKERS) {
      expect(fs.existsSync(path.join(import.meta.dirname, '..', entry)), entry).toBe(true);
      expect(app).toContain(`'${name}': '${entry}'`);
    }
  });

  it("gives the app's runtime the daemon's folders a release stages, systemd aside", () => {
    const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, '../scripts', file), 'utf8');
    const release = read('release-stage.mjs');
    const at = release.indexOf('export function stageAssets');
    const staged = [...release.slice(at, release.indexOf('\n}\n', at)).matchAll(/'packages\/svalld\/([\w-]+)'/g)].map((m) => m[1]);
    const app = /for \(const dir of \[([^\]]+)\]\)/.exec(read('runtime-bundle.mjs'))![1].split(',').map((d) => d.trim().slice(1, -1));
    expect(staged).toContain('skills');
    expect(app).toEqual(staged.filter((d) => d !== 'systemd'));
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

describe('a release', () => {
  it('pins no rsync', () => { expect(PINS).not.toHaveProperty('rsync'); });
});

describe('the assets a release carries', () => {
  const repo = path.join(import.meta.dirname, '..');
  it.skipIf(!fs.existsSync(path.join(repo, 'apps/desktop/web/dist-mobile')))('stages the skills folder (skipped without the phone page built)', () => {
    const stage = temp();
    fs.mkdirSync(path.join(stage, 'release'));
    stageAssets(stage);
    const skills = fs.readdirSync(path.join(repo, 'packages/svalld/skills')).sort();
    expect(skills).toContain('svall-retro');
    expect(fs.readdirSync(path.join(stage, 'skills')).sort()).toEqual(skills);
  });
});

describe('the companions a controller release carries', () => {
  it('copies each companion pinned relative to the release into it, where its URL finds it, and leaves a published one out', () => {
    const dir = temp();
    const name = 'svall-companion-v1.2.3-linux-x64.tar.gz';
    fs.writeFileSync(path.join(dir, name), 'a companion');
    const carried = companionAssets({ dir, version: 'v1.2.3', urlBase: 'companions' });
    expect(carried['linux-x64'].url).toBe(`companions/${name}`);
    const stage = temp();
    carryCompanions(stage, carried, dir);
    expect(fs.readFileSync(path.join(stage, 'companions', name), 'utf8')).toBe('a companion');

    const published = temp();
    carryCompanions(published, companionAssets({ dir, version: 'v1.2.3', urlBase: 'https://example.test/r' }), dir);
    expect(fs.readdirSync(published)).toEqual([]);
  });
});

describe('the key a local build signs with', () => {
  const saved = process.env.SVALL_RELEASE_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.SVALL_RELEASE_KEY;
    else process.env.SVALL_RELEASE_KEY = saved;
  });

  /** A key made for the test, and signers that list it alone. */
  const signer = (): { key: string; signers: string } => {
    const dir = temp();
    const key = path.join(dir, 'key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'svall-release', '-f', key]);
    const signers = path.join(dir, 'allowed_signers');
    fs.writeFileSync(signers, `svall-release namespaces="svall-release" ${fs.readFileSync(`${key}.pub`, 'utf8').split(' ').slice(0, 2).join(' ')}\n`);
    return { key, signers };
  };

  it('is none without SVALL_RELEASE_KEY, so the build marks its release unsigned', () => {
    delete process.env.SVALL_RELEASE_KEY;
    expect(releaseKey()).toBeUndefined();
  });

  it('is either key the signers list, so a second key can take over from the first', () => {
    const [first, second] = [signer(), signer()];
    fs.appendFileSync(first.signers, fs.readFileSync(second.signers));
    for (const { key } of [first, second]) {
      process.env.SVALL_RELEASE_KEY = key;
      expect(releaseKey(first.signers)).toBe(key);
    }
  });

  it('refuses a key the signers do not list, the committed ones included, before anything is built', () => {
    const [listed, other] = [signer(), signer()];
    process.env.SVALL_RELEASE_KEY = other.key;
    expect(() => releaseKey(listed.signers)).toThrow(`the public half of SVALL_RELEASE_KEY ${other.key} is not in ${listed.signers}`);
    expect(() => releaseKey()).toThrow(/is not in \S+\/scripts\/release\/allowed_signers/);
  });

  it('refuses a file that is no key', () => {
    process.env.SVALL_RELEASE_KEY = path.join(temp(), 'missing');
    expect(() => releaseKey()).toThrow(`SVALL_RELEASE_KEY ${process.env.SVALL_RELEASE_KEY} cannot sign`);
  });
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
