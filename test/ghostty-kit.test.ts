import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';

const SCRIPT = path.join(import.meta.dirname, '../scripts/ghostty-kit.sh');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const REV = /^REV=(\S+)$/m.exec(fs.readFileSync(SCRIPT, 'utf8'))![1];
/** What a kit's `version` stamp holds when built from Ghostty `commit` at kit revision `rev`. */
const version = (commit: string, rev = REV): string => `${commit}-r${rev}`;
// the developer's git config may sign commits or run hooks; these throwaway repositories use none of it
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-ghostty-kit-'));
  dirs.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const write = (root: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

/** A repository whose HEAD records Ghostty at `commit` with no submodule checkout, like a fresh clone. */
function repo(commit = A): string {
  const root = tmp();
  git(root, 'init', '-q');
  write(root, 'scripts/ghostty-kit.sh', fs.readFileSync(SCRIPT, 'utf8'));
  git(root, 'add', 'scripts');
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${commit},vendor/ghostty`);
  git(root, 'commit', '-qm', 'init');
  return root;
}

const bump = (root: string, commit: string): void => {
  git(root, 'update-index', '--cacheinfo', `160000,${commit},vendor/ghostty`);
  git(root, 'commit', '-qm', 'bump Ghostty');
};

/** Gives `root` a vendor/ghostty checkout of two commits, at the second, and has HEAD record the first. */
function checkout(root: string): [string, string] {
  const g = path.join(root, 'vendor/ghostty');
  fs.mkdirSync(g, { recursive: true });
  git(g, 'init', '-q');
  git(g, 'commit', '-q', '--allow-empty', '-m', 'one');
  const first = git(g, 'rev-parse', 'HEAD');
  git(g, 'commit', '-q', '--allow-empty', '-m', 'two');
  bump(root, first);
  return [first, git(g, 'rev-parse', 'HEAD')];
}

const run = (root: string, args: string[], extra: Record<string, string> = {}) =>
  spawnSync('sh', [path.join(root, 'scripts/ghostty-kit.sh'), ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' });

const kitVersion = (root: string): string | undefined => {
  try { return fs.readFileSync(path.join(root, 'vendor/ghostty-kit/version'), 'utf8').trim(); } catch { return undefined; }
};

/** Doubles for the tools fetch calls, first on PATH, and only the system's own after them. The release serves `zip` when it is set. */
function fakes(o: { zip?: string; arm64?: string } = {}): { PATH: string; log: string } {
  const bin = tmp();
  const log = path.join(bin, 'calls.log');
  const tool = (name: string, body: string): void =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\n${body}\n`, { mode: 0o755 });
  tool('sysctl', `echo ${o.arm64 ?? '1'}`);
  tool('curl', `while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; esac; shift; done\n${
    o.zip ? `cp '${o.zip}' "$out"` : 'echo "curl: (22) The requested URL returned error: 404" >&2; exit 22'}`);
  fs.writeFileSync(log, '');
  return { PATH: `${bin}:/usr/bin:/bin`, log };
}

/** Pins `zip` in `root`'s script as the kit published for `stamp`, as a maintainer does after publishing it. */
function pin(root: string, zip: string, stamp = version(A)): void {
  const file = path.join(root, 'scripts/ghostty-kit.sh');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^PINNED=.*$/m, `PINNED=${stamp}`).replace(/^SHA256=.*$/m, `SHA256=${sha}`));
}

/** A kit zip laid out as publish makes it, stamped `stamp`; `drop` leaves one part out; `slice` names the library's. */
function kitZip(stamp: string, drop?: 'lib' | 'terminfo' | 'shell-integration', slice = 'macos-arm64'): string {
  const d = tmp();
  write(d, 'kit/version', `${stamp}\n`);
  if (drop !== 'lib') write(d, `kit/GhosttyKit.xcframework/${slice}/libghostty-fat.a`, 'lib');
  if (drop !== 'terminfo') write(d, 'kit/share/terminfo/78/xterm-ghostty', 'terminfo');
  if (drop !== 'shell-integration') write(d, 'kit/share/ghostty/shell-integration/zsh/ghostty-integration', 'zsh');
  write(d, 'kit/share/ghostty/themes/Svall', 'theme');
  execFileSync('ditto', ['-c', '-k', path.join(d, 'kit'), path.join(d, 'kit.zip')]);
  return path.join(d, 'kit.zip');
}

test('current fails without a kit and passes once the kit matches the recorded Ghostty commit', () => {
  const root = repo();
  expect(run(root, ['current']).status).toBe(1);
  write(root, 'vendor/ghostty-kit/version', `${version(A)}\n`);
  const r = run(root, ['current']);
  expect(r.status).toBe(0);
  expect(r.stdout + r.stderr).toBe('');
});

test('current fails after a pull that bumps Ghostty', () => {
  const root = repo();
  write(root, 'vendor/ghostty-kit/version', `${version(A)}\n`);
  bump(root, B);
  expect(run(root, ['current']).status).toBe(1);
});

test('current fails for a kit of an earlier kit revision', () => {
  const root = repo();
  write(root, 'vendor/ghostty-kit/version', `${version(A, '0')}\n`);
  expect(run(root, ['current']).status).toBe(1);
});

test('ahead passes for a kit built from a Ghostty bump not yet committed', () => {
  const root = repo();
  const [, second] = checkout(root);
  write(root, 'vendor/ghostty-kit/version', `${version(second)}\n`);
  expect(run(root, ['current']).status).toBe(1);
  expect(run(root, ['ahead']).status).toBe(0);
});

test('ahead fails for a checkout behind the commit HEAD records, as after a pull', () => {
  const root = repo();
  const [first, second] = checkout(root);
  bump(root, second);
  git(path.join(root, 'vendor/ghostty'), 'checkout', '-q', first);
  write(root, 'vendor/ghostty-kit/version', `${version(first)}\n`);
  expect(run(root, ['ahead']).status).toBe(1);
});

test('ahead fails without a Ghostty checkout, as in a fresh clone', () => {
  const root = repo();
  fs.mkdirSync(path.join(root, 'vendor/ghostty'), { recursive: true });
  // git in the empty submodule folder would answer for the outer repository
  write(root, 'vendor/ghostty-kit/version', `${version(git(root, 'rev-parse', 'HEAD'))}\n`);
  expect(run(root, ['ahead']).status).toBe(1);
});

test('fetch installs the kit for the recorded Ghostty commit from the public release', () => {
  const root = repo();
  const zip = kitZip(version(A));
  pin(root, zip);
  const f = fakes({ zip });
  const r = run(root, ['fetch'], { PATH: f.PATH });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  expect(kitVersion(root)).toBe(version(A));
  expect(fs.existsSync(path.join(root, 'vendor/ghostty-kit/share/terminfo/78/xterm-ghostty'))).toBe(true);
  expect(fs.existsSync(path.join(root, 'vendor/ghostty-kit/GhosttyKit.xcframework/macos-arm64/libghostty-fat.a'))).toBe(true);
  expect(fs.readFileSync(f.log, 'utf8')).toContain(`https://github.com/linusroxbergh/svall/releases/download/ghostty-kit/GhosttyKit-${version(A)}-arm64.zip`);
  expect(run(root, ['current']).status).toBe(0);
});

test('fetch replaces the kit of an older Ghostty commit entirely', () => {
  const root = repo();
  write(root, 'vendor/ghostty-kit/version', `${version(B)}\n`);
  write(root, 'vendor/ghostty-kit/stale', 'old');
  const zip = kitZip(version(A));
  pin(root, zip);
  expect(run(root, ['fetch'], { PATH: fakes({ zip }).PATH }).status).toBe(0);
  expect(kitVersion(root)).toBe(version(A));
  expect(fs.existsSync(path.join(root, 'vendor/ghostty-kit/stale'))).toBe(false);
});

test('fetch passes on why nothing could be downloaded and keeps the old kit', () => {
  const root = repo();
  write(root, 'vendor/ghostty-kit/version', `${version(B)}\n`);
  pin(root, kitZip(version(A)));
  const r = run(root, ['fetch'], { PATH: fakes().PATH });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('The requested URL returned error: 404');
  expect(r.stderr).toContain(`no GhosttyKit could be downloaded for Ghostty ${A}`);
  expect(kitVersion(root)).toBe(version(B));
});

test('fetch downloads nothing for a Ghostty commit or kit revision with no pinned sha256', () => {
  for (const stamp of [version(C), version(A, '0')]) {
    const root = repo();
    const zip = kitZip(version(A));
    pin(root, zip, stamp);
    const f = fakes({ zip });
    const r = run(root, ['fetch'], { PATH: f.PATH });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`no GhosttyKit is pinned for Ghostty ${A} at r${REV}`);
    expect(fs.readFileSync(f.log, 'utf8')).not.toMatch(/^curl /m);
    expect(kitVersion(root)).toBeUndefined();
  }
});

test('fetch refuses a download that is not the pinned kit and keeps the old one', () => {
  const root = repo();
  write(root, 'vendor/ghostty-kit/version', `${version(B)}\n`);
  pin(root, kitZip(version(A)));
  const r = run(root, ['fetch'], { PATH: fakes({ zip: kitZip(version(A), 'terminfo') }).PATH });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain(`the downloaded GhosttyKit for Ghostty ${A} does not match its pinned sha256`);
  expect(kitVersion(root)).toBe(version(B));
});

test.each([
  ['a kit built for another Ghostty commit', () => kitZip(version(C))],
  ['a kit of an earlier kit revision', () => kitZip(version(A, '0'))],
  ['a kit without the library', () => kitZip(version(A), 'lib')],
  ['a kit without the terminfo', () => kitZip(version(A), 'terminfo')],
  ['a kit without the shell integration', () => kitZip(version(A), 'shell-integration')],
  ['a kit built for Intel Macs', () => kitZip(version(A), undefined, 'macos-x86_64')],
  ['a download that is not a zip', () => {
    const f = path.join(tmp(), 'bad.zip');
    fs.writeFileSync(f, '<html>Not Found</html>');
    return f;
  }],
])('fetch rejects %s and keeps the old kit', (_, kit) => {
  const root = repo();
  write(root, 'vendor/ghostty-kit/version', `${version(B)}\n`);
  // pinned, as a kit published broken is still the one its sha256 names
  const zip = kit();
  pin(root, zip);
  const r = run(root, ['fetch'], { PATH: fakes({ zip }).PATH });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain(`the downloaded GhosttyKit for Ghostty ${A} is incomplete`);
  expect(kitVersion(root)).toBe(version(B));
});

test('fetch downloads nothing on an Intel Mac', () => {
  const root = repo();
  const f = fakes({ zip: kitZip(version(A)), arm64: '0' });
  const r = run(root, ['fetch'], { PATH: f.PATH });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('prebuilt GhosttyKit is for Apple Silicon only');
  expect(fs.readFileSync(f.log, 'utf8')).not.toMatch(/^curl /m);
  expect(kitVersion(root)).toBeUndefined();
});
