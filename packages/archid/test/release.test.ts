import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { entriesOf, manifestDigest, signManifest, sshVerify, verifyRelease, writeManifest, type Entry } from '../../../scripts/release-manifest.mjs';
import { allowedSigners, installRelease } from '../../../scripts/install-release.mjs';
import { companionAssets, shimText, stageRelease } from '../../../scripts/release-stage.mjs';
import { hooksDir, homeTemplateDir, isRelease, mobileDistDir, releaseRoot, releaseVersion, repoRoot } from '../src/release.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(() => { delete process.env.ARCHI_RELEASE_ROOT; cleanHomes(); });

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('release root on the repository layout', () => {
  it('is the checkout, and the assets keep their package paths', () => {
    expect(isRelease()).toBe(false);
    expect(releaseRoot()).toBe(checkout);
    expect(repoRoot()).toBe(checkout);
    expect(hooksDir()).toBe(path.join(checkout, 'packages/archid/hooks'));
    expect(homeTemplateDir()).toBe(path.join(checkout, 'packages/archid/home'));
    expect(mobileDistDir()).toBe(path.join(checkout, 'apps/desktop/web/dist-mobile'));
  });

  it('points at hooks and templates that are really there', () => {
    expect(fs.existsSync(path.join(hooksDir(), 'agent-hook.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(homeTemplateDir(), 'CLAUDE.md'))).toBe(true);
  });

  it('has no release version of its own', () => {
    expect(releaseVersion()).toBe('dev');
  });
});

describe('release root on an installed release', () => {
  it('takes every asset directly from ARCHI_RELEASE_ROOT', () => {
    const root = makeHome();
    process.env.ARCHI_RELEASE_ROOT = root;
    expect(isRelease()).toBe(true);
    expect(releaseRoot()).toBe(root);
    expect(hooksDir()).toBe(path.join(root, 'hooks'));
    expect(homeTemplateDir()).toBe(path.join(root, 'home'));
    expect(mobileDistDir()).toBe(path.join(root, 'web-mobile'));
  });

  it('has no checkout to reach for', () => {
    process.env.ARCHI_RELEASE_ROOT = makeHome();
    expect(() => repoRoot()).toThrow(/release/);
  });

  it('reads its version from release.json', () => {
    const root = makeHome();
    fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify({ version: '1.2.3' }));
    process.env.ARCHI_RELEASE_ROOT = root;
    expect(releaseVersion()).toBe('1.2.3');
  });

  it('falls back to dev when release.json is missing or unreadable', () => {
    const root = makeHome();
    process.env.ARCHI_RELEASE_ROOT = root;
    expect(releaseVersion()).toBe('dev');
    fs.writeFileSync(path.join(root, 'release.json'), '{ not json');
    expect(releaseVersion()).toBe('dev');
  });
});

/** A miniature release: a bundle, a runtime with a symlink into it, and an executable shim. */
function fixture(o: { version?: string } = {}): string {
  const dir = makeHome();
  const stage = path.join(dir, 'releases', o.version ?? '1.0.0');
  fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'node/bin'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'lib/archi.mjs'), 'process.stdout.write("hello\\n");\n');
  fs.writeFileSync(path.join(stage, 'bin/archi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(stage, 'node/bin/node'), 'binary\n', { mode: 0o755 });
  fs.symlinkSync('../lib/archi.mjs', path.join(stage, 'node/bin/npx'));
  writeManifest(stage, { version: o.version ?? '1.0.0', platform: 'linux-x64' });
  return stage;
}

/** An ed25519 key that lives only for this test, so no real signing key is ever needed. */
function ephemeralSigner(): { key: string; verify: (dir: string, signer: string) => void } {
  const dir = makeHome();
  const key = path.join(dir, 'key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'archipelago-release', '-f', key]);
  const allowedSigners = path.join(dir, 'allowed_signers');
  const pub = fs.readFileSync(`${key}.pub`, 'utf8').split(' ').slice(0, 2).join(' ');
  fs.writeFileSync(allowedSigners, `archipelago-release namespaces="archipelago-release" ${pub}\n`);
  return { key, verify: sshVerify({ allowedSigners }) };
}

const at = (entries: Entry[], p: string): Entry => entries.find((e) => e.path === p)!;

describe('the signers a release trusts', () => {
  it('sits inside the release once one is installed, and in the checkout otherwise', () => {
    expect(allowedSigners()).toBe(path.join(checkout, 'scripts/release/allowed_signers'));
    process.env.ARCHI_RELEASE_ROOT = '/opt/archi';
    expect(allowedSigners()).toBe('/opt/archi/release/allowed_signers');
  });

  // an all-zero ed25519 key is a small-order point: ssh-keygen -Y verify takes forged signatures for it
  it('commits no placeholder key', () => {
    const committed = fs.readFileSync(path.join(checkout, 'scripts/release/allowed_signers'), 'utf8');
    const keys = committed.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    for (const line of keys) {
      const blob = Buffer.from(line.split(/\s+/).at(-1) ?? '', 'base64');
      const point = blob.subarray(blob.length - 32);
      expect(point.length).toBe(32);
      expect(point.every((b) => b === 0), line).toBe(false);
    }
  });

  it('refuses every signed release while no release key is committed', () => {
    const committed = path.join(checkout, 'scripts/release/allowed_signers');
    if (fs.readFileSync(committed, 'utf8').split('\n').some((l) => l.trim() && !l.trim().startsWith('#'))) return;
    const stage = fixture();
    signManifest(stage, ephemeralSigner().key);
    expect(() => verifyRelease(stage, { verify: sshVerify({ allowedSigners: committed }) })).toThrow(/not signed by archipelago-release/);
  });
});

describe('the bin shim', () => {
  it('exports the release it lives in, not the current symlink pointing at it', () => {
    const root = makeHome();
    const release = path.join(root, 'share/archipelago/releases/1.0.0');
    fs.mkdirSync(path.join(release, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(release, 'node/bin'), { recursive: true });
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(release, 'bin/archi'), shimText('archi'), { mode: 0o755 });
    // stands in for the release's own node: it only has to report the root the shim exported
    fs.writeFileSync(path.join(release, 'node/bin/node'), '#!/bin/sh\nprintf %s "$ARCHI_RELEASE_ROOT"\n', { mode: 0o755 });
    fs.symlinkSync('releases/1.0.0', path.join(root, 'share/archipelago/current'));
    fs.symlinkSync('../share/archipelago/current/bin/archi', path.join(root, 'bin/archi'));

    const out = execFileSync(path.join(root, 'bin/archi'), ['version'], { encoding: 'utf8' });
    expect(out).toBe(fs.realpathSync(release));
    expect(out).not.toContain('/current');
  });
});

describe('the manifest walk', () => {
  it('records the type, mode and link target of everything in the tree', () => {
    const stage = fixture();
    const entries = entriesOf(stage);
    expect(at(entries, 'bin').type).toBe('dir');
    expect(at(entries, 'bin/archi')).toMatchObject({ type: 'file', mode: '755' });
    expect(at(entries, 'lib/archi.mjs')).toMatchObject({ type: 'file', mode: '644', size: 33 });
    expect(at(entries, 'node/bin/npx')).toEqual({ path: 'node/bin/npx', type: 'symlink', mode: '755', target: '../lib/archi.mjs' });
    expect(entries.map((e) => e.path)).not.toContain('SHA256SUMS');
    expect(entries.map((e) => e.path)).not.toContain('release.json');
  });

  it('digests the entries whatever order they came back in', () => {
    const entries = entriesOf(fixture());
    const shuffled = [...entries].reverse();
    expect(manifestDigest(shuffled)).toBe(manifestDigest(entries));
    expect(manifestDigest([...entries, { path: 'extra', type: 'file', mode: '644', size: 0, sha256: 'x' }]))
      .not.toBe(manifestDigest(entries));
  });

  it('is the same list and the same modes for two builds of one tree', () => {
    const a = entriesOf(fixture());
    const b = entriesOf(fixture({ version: '1.0.1' }));
    expect(b.map((e) => `${e.path} ${e.type} ${e.mode}`)).toEqual(a.map((e) => `${e.path} ${e.type} ${e.mode}`));
    expect(manifestDigest(b)).toBe(manifestDigest(a));
  });
});

describe('verifying a release', () => {
  it('accepts an unsigned tree only when it is asked to', () => {
    const stage = fixture();
    expect(() => verifyRelease(stage)).toThrow(/SHA256SUMS.sig/);
    expect(verifyRelease(stage, { allowUnsigned: true }).signed).toBe(false);
  });

  it('accepts a signature from the release identity and refuses one from anybody else', () => {
    const stage = fixture();
    const signer = ephemeralSigner();
    signManifest(stage, signer.key);
    expect(verifyRelease(stage, { verify: signer.verify }).signed).toBe(true);
    expect(() => verifyRelease(stage, { verify: signer.verify, signer: 'someone-else' })).toThrow(/not signed by someone-else/);
  });
});

describe('installing a release', () => {
  const install = (source: string, prefix: string, o: Record<string, unknown> = {}) =>
    installRelease({ source, prefix, allowUnsigned: true, ...o });

  it('renames the verified tree into releases and swaps current atomically, keeping the one before', () => {
    const prefix = makeHome();
    const first = install(fixture(), prefix);
    expect(first.version).toBe('1.0.0');
    expect(fs.readlinkSync(path.join(prefix, 'current'))).toBe(first.release);
    expect(first.rollbackTo).toBeNull();
    expect(fs.existsSync(path.join(prefix, 'current', 'bin', 'archi'))).toBe(true);

    const second = install(fixture({ version: '1.0.1' }), prefix);
    expect(fs.readlinkSync(path.join(prefix, 'current'))).toBe(second.release);
    expect(second.rollbackTo).toBe(first.release);
    expect(second.releasesKept).toEqual(['1.0.0', '1.0.1']);
    expect(fs.readdirSync(prefix).filter((f) => f.startsWith('.staging'))).toEqual([]);
  });

  it('replaces a release of the same name with the tree that was just verified', () => {
    const prefix = makeHome();
    install(fixture(), prefix);
    const again = fixture();
    fs.writeFileSync(path.join(again, 'lib/archi.mjs'), 'process.stdout.write("again\\n");\n');
    writeManifest(again, { version: '1.0.0', platform: 'linux-x64' });
    const second = install(again, prefix);
    expect(second.replaced).toBe(true);
    expect(second.releasesKept).toEqual(['1.0.0']);
    expect(fs.readFileSync(path.join(prefix, 'current', 'lib/archi.mjs'), 'utf8')).toContain('again');
    expect(fs.readdirSync(path.join(prefix, 'releases'))).toEqual(['1.0.0']);
  });

  it('refuses a file whose content was changed after the manifest was written', () => {
    const stage = fixture();
    fs.appendFileSync(path.join(stage, 'lib/archi.mjs'), 'x');
    expect(() => install(stage, makeHome())).toThrow(/lib\/archi\.mjs: expected/);
  });

  it('refuses a file the release carries and the manifest does not list', () => {
    const stage = fixture();
    fs.writeFileSync(path.join(stage, 'lib/extra.mjs'), 'smuggled');
    expect(() => install(stage, makeHome())).toThrow(/lib\/extra\.mjs is in the release but not in release\.json/);
  });

  it('refuses a symlink repointed after the manifest was written', () => {
    const stage = fixture();
    fs.rmSync(path.join(stage, 'node/bin/npx'));
    fs.symlinkSync('/etc/hosts', path.join(stage, 'node/bin/npx'));
    expect(() => install(stage, makeHome())).toThrow(/node\/bin\/npx is not what release\.json describes/);
  });

  it('refuses an unsigned release unless it is allowed', () => {
    const prefix = makeHome();
    expect(() => installRelease({ source: fixture(), prefix })).toThrow(/carries no SHA256SUMS\.sig/);
    expect(fs.existsSync(path.join(prefix, 'current'))).toBe(false);
    expect(fs.existsSync(path.join(prefix, 'releases'))).toBe(false);
  });

  it('refuses a version token that would reach outside releases/', () => {
    const stage = fixture({ version: '..' });
    expect(() => install(stage, makeHome())).toThrow(/names an unusable release directory: ".."/);
  });

  it('refuses a SHA256SUMS line naming a path outside the release', () => {
    const stage = fixture();
    fs.appendFileSync(path.join(stage, 'SHA256SUMS'), `${'0'.repeat(64)}  ../../../etc/hosts\n`);
    expect(() => install(stage, makeHome())).toThrow(/names a path outside the release/);
  });

  it('leaves the prefix untouched after every refusal', () => {
    const prefix = makeHome();
    const stage = fixture();
    fs.appendFileSync(path.join(stage, 'lib/archi.mjs'), 'x');
    expect(() => install(stage, prefix)).toThrow();
    expect(fs.readdirSync(prefix)).toEqual([]);
  });
});

describe('the companions a desktop release manifest names', () => {
  it('names each archive it finds beside it, with the digest it was published with', () => {
    const dir = makeHome();
    const names = ['archipelago-companion-1.2.3-linux-x64.tar.gz', 'archipelago-companion-1.2.3-linux-arm64.tar.gz'];
    for (const n of names) fs.writeFileSync(path.join(dir, n), n);
    const companions = companionAssets({ dir, version: '1.2.3', urlBase: 'https://example.test/r/' });
    expect(Object.keys(companions).sort()).toEqual(['linux-arm64', 'linux-x64']);
    expect(companions['linux-x64'].url).toBe(`https://example.test/r/${names[0]}`);
    expect(companions['linux-x64'].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses to name a companion it has not been handed', () => {
    expect(() => companionAssets({ dir: makeHome(), version: '1.2.3', urlBase: 'https://example.test/r' }))
      .toThrow(/no companion archive/);
  });
});

// the whole build, done for real, but only where its inputs are already on disk: a unit test may
// not reach nodejs.org, and the phone page is built by the desktop build rather than by vitest
const cached = (): string | undefined => {
  const pins = JSON.parse(fs.readFileSync(path.join(checkout, 'scripts/release/pins.json'), 'utf8'));
  const tarball = path.join(checkout, 'vendor/node', `node-${pins.node.version}-darwin-${process.arch}.tar.xz`);
  const sums = path.join(checkout, 'vendor/node', `SHASUMS256-${pins.node.version}.txt`);
  if (process.platform !== 'darwin') return `this is ${process.platform}, not a controller host`;
  if (!fs.existsSync(tarball)) return `no cached ${path.basename(tarball)}`;
  if (!fs.existsSync(sums)) return `no cached ${path.basename(sums)}`;
  if (!fs.existsSync(path.join(checkout, 'apps/desktop/web/dist-mobile'))) return 'no dist-mobile: pnpm --filter @archipelago/desktop-web build:mobile';
  return undefined;
};

const why = cached();
describe('a release built by the build scripts', () => {
  (why ? it.skip : it)(`answers archi version --json from the installed tree${why ? ` (skipped: ${why})` : ''}`, async () => {
    const pins = JSON.parse(fs.readFileSync(path.join(checkout, 'scripts/release/pins.json'), 'utf8'));
    const out = makeHome();
    const { stage, meta } = await stageRelease({
      out, version: '0.0.0-test', platform: `darwin-${process.arch}`,
      shasums: path.join(checkout, 'vendor/node', `SHASUMS256-${pins.node.version}.txt`),
    });
    writeManifest(stage, { ...meta, unsigned: true });

    const prefix = makeHome();
    const installed = installRelease({ source: stage, prefix, allowUnsigned: true });
    const out2 = execFileSync(path.join(installed.current, 'bin', 'archi'), ['version', '--json'], { encoding: 'utf8' });
    expect(JSON.parse(out2)).toMatchObject({
      release: '0.0.0-test',
      protocol: meta.protocol,
      runtime: { node: pins.node.version, platform: 'darwin', arch: process.arch },
    });

    // the signers a signed release is checked against travel with it
    expect(fs.existsSync(path.join(installed.release, 'release/allowed_signers'))).toBe(true);
    // as do the assets the daemon reads at runtime, the agent profiles a fleet is seeded with among them
    for (const dir of ['hooks', 'home', 'systemd', 'agent-profiles']) {
      expect(fs.readdirSync(path.join(installed.release, dir)).sort(), dir).toEqual(fs.readdirSync(path.join(checkout, 'packages/archid', dir)).sort());
    }
    // and so does the dialog the app's first ssh to a new machine asks through
    expect(fs.statSync(path.join(installed.release, 'bin/archi-askpass')).mode & 0o111).not.toBe(0);
    // and nothing in the release names the machine it was built on
    const manifest = fs.readFileSync(path.join(installed.release, 'release.json'), 'utf8');
    expect(manifest).not.toContain(checkout);
    expect(manifest).toContain('https://nodejs.org/dist/');
  }, 180_000);
});
