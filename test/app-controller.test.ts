import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeVersion } from '../scripts/release-stage.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const temp = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'svall-app-controller-')));
  dirs.push(dir);
  return dir;
};

/** A folder of commands that each log how they were called, put first on the PATH. */
function stubs(dir: string, names: string[], first: Record<string, string> = {}): { env: NodeJS.ProcessEnv; log: () => string[] } {
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'log');
  fs.mkdirSync(bin);
  for (const name of names) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${first[name] ?? ''}\necho "${name} $*" >> "${log}"\n`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete env.SVALL_RELEASE_NAME;
  return { env, log: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

describe('the controller release build.sh carries', () => {
  const build = read('apps/desktop/mac/build.sh');
  const from = '"$APP/Contents/Resources/web/"\nfi\n';
  const block = build.slice(build.indexOf(from) + from.length, build.indexOf('# the commit count'));

  // build.sh's controller block, with node and rsync logging what they are asked; the release name still comes from git
  // SCAN_EXIT in `env` is what release-scan exits with
  function carry(config: string, variant: string, env: Record<string, string> = {}, status = 0) {
    const mac = temp();
    fs.mkdirSync(path.join(mac, 'build.noindex'));
    const s = stubs(mac, ['node', 'rsync'], {
      node: `[ "$1" = -e ] && exec "${process.execPath}" "$@"\n[ "\${1##*/}" = release-scan.mjs ] && [ -n "\${SCAN_EXIT:-}" ] && exit "$SCAN_EXIT"`,
    });
    const r = spawnSync('sh', ['-c', `set -eu\nMAC="${mac}"\nROOT="${ROOT}"\nAPP="${mac}/Svall.app"\nCONFIG=${config}\nVARIANT=${variant}\n${block}`], {
      env: { ...s.env, ...env }, encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(status);
    return { mac, calls: s.log() };
  }

  it('is carried only by a release build of Svall.app, never by Svall Dev', () => {
    expect(block).toContain('build-controller.mjs');
    expect(carry('release', 'dev').calls).toEqual([]);
    expect(carry('debug', 'release').calls).toEqual([]);
    expect(carry('release', 'release').calls.join('\n')).toContain('/Contents/Resources/release/');
  });

  it('pins the companion it carries by a path inside the release, never by one on the builder\'s disk', () => {
    const { mac, calls } = carry('release', 'release');
    const controller = calls.find((c) => c.includes('build-controller.mjs'));
    expect(controller).toContain(' --companion-url-base companions ');
    expect(controller).toContain(` --companions ${mac}/build.noindex/companions`);
    expect(calls.join('\n')).not.toContain('file:');
  });

  it('scans the release tree and the companion archive before it copies them into the app, and stops on a finding', () => {
    const { mac, calls } = carry('release', 'release');
    const scan = calls.findIndex((c) => c.includes('release-scan.mjs'));
    expect(calls[scan]).toBe(`node ${ROOT}/scripts/release-scan.mjs ${mac}/build.noindex/release/releases/*/ ${mac}/build.noindex/companions/*.tar.gz`);
    expect(scan).toBeLessThan(calls.findIndex((c) => c.startsWith('rsync ')));
    expect(carry('release', 'release', { SCAN_EXIT: '1' }, 1).calls.filter((c) => c.startsWith('rsync '))).toEqual([]);
  });

  it('is named what pnpm release tags, or what git describes for any other build', () => {
    const named = carry('release', 'release', { SVALL_RELEASE_NAME: 'v9.9.9' }).calls.filter((c) => c.startsWith('node ') && !c.includes('release-scan.mjs'));
    expect(named).toHaveLength(2);
    for (const c of named) expect(c).toContain(' --version v9.9.9');
    const described = carry('release', 'release').calls.filter((c) => c.startsWith('node ') && !c.includes('release-scan.mjs'));
    for (const c of described) expect(c).toContain(` --version ${describeVersion()}`);

    const release = read('scripts/release.sh');
    expect(release).toMatch(/^SVALL_RELEASE_NAME="v\$VERSION" pnpm app:build$/m);
    expect(release).toMatch(/^git tag "v\$VERSION"$/m);
  });
});

describe('signing Svall.app', () => {
  const MAC = path.join(ROOT, 'apps/desktop/mac');

  function sign(carried: boolean): string[] {
    const dir = temp();
    const app = path.join(dir, 'Svall.app');
    for (const f of carried ? ['bin/rsync', 'node/bin/node'] : []) {
      fs.mkdirSync(path.dirname(path.join(app, 'Contents/Resources/release', f)), { recursive: true });
      fs.writeFileSync(path.join(app, 'Contents/Resources/release', f), '');
    }
    const s = stubs(dir, ['codesign']);
    const r = spawnSync(path.join(ROOT, 'scripts/sign.sh'), [app, 'Developer ID Application: Test'], { env: s.env, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return s.log().map((c) => c.replaceAll(app, 'APP').replaceAll(MAC, 'MAC'));
  }

  it('signs the carried controller\'s rsync and node for notarization before the app that seals them', () => {
    const calls = sign(true);
    const app = calls.indexOf('codesign --force --options runtime --timestamp --sign Developer ID Application: Test --entitlements MAC/app.entitlements APP');
    const rsync = calls.indexOf('codesign --force --options runtime --timestamp --sign Developer ID Application: Test APP/Contents/Resources/release/bin/rsync');
    const node = calls.indexOf('codesign --force --options runtime --timestamp --sign Developer ID Application: Test --entitlements MAC/node.entitlements APP/Contents/Resources/release/node/bin/node');
    expect(app, calls.join('\n')).toBeGreaterThan(-1);
    expect(rsync, calls.join('\n')).toBeGreaterThan(-1);
    expect(node, calls.join('\n')).toBeGreaterThan(-1);
    expect(Math.max(rsync, node)).toBeLessThan(app);
  });

  it('still signs an app that carries no controller', () => {
    const calls = sign(false);
    expect(calls.some((c) => c.endsWith('--entitlements MAC/app.entitlements APP'))).toBe(true);
    expect(calls.join('\n')).not.toContain('Resources/release');
  });
});
