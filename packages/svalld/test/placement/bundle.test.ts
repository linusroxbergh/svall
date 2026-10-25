import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handoverGit, type GitRunner } from '../../src/links/git.js';
import { applyBundle, BUNDLE_MAX, buildBundle, fingerprintOf, trackedCredentials, verifyBundle } from '../../src/placement/bundle.js';
import { git, hasGit } from '../handover/git-fixture.js';
import { cleanHomes, makeHome } from '../helpers.js';

afterEach(cleanHomes);

// a real folder whose repositories the fixture's git reads with an empty global configuration
function scratch(): { at: (name: string) => string; g: (cwd: string, ...args: string[]) => string } {
  const base = fs.realpathSync(makeHome());
  fs.writeFileSync(path.join(base, 'gitconfig'), '');
  return { at: (name) => path.join(base, name), g: (cwd, ...args) => git(base, cwd, ...args) };
}

const put = (root: string, rel: string, data: string | Buffer, mode?: number): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), data);
  if (mode !== undefined) fs.chmodSync(path.join(root, rel), mode);
};
const perms = (p: string): number => fs.lstatSync(p).mode & 0o777;

describe.skipIf(!hasGit)('bundle', () => {
  it('round-trips staged, unstaged, untracked, modes, a symlink and a binary, and the fingerprint matches', async () => {
    const { at, g } = scratch();
    const src = at('src');
    g(at(''), 'init', '-q', src);
    put(src, 'a.txt', 'one\ntwo\n');
    put(src, 'gone.txt', 'bye\n');
    put(src, 'tool.sh', 'echo hi\n');
    put(src, 'pic.bin', crypto.randomBytes(4096));
    put(src, 'serve.sh', 'echo serve\n');
    put(src, 'map.bin', crypto.randomBytes(4096));
    put(src, '.gitignore', 'build/\n');
    g(src, 'add', '.');
    g(src, 'commit', '-qm', 'base');
    const head = g(src, 'rev-parse', 'HEAD');
    const [dst, lost] = [at('dst'), at('lost')];
    g(at(''), 'clone', '-q', src, dst);
    g(at(''), 'clone', '-q', src, lost);

    put(src, 'a.txt', 'one\ntwo\nstaged\n');
    put(src, 'pic.bin', crypto.randomBytes(4096));
    put(src, 'new.txt', 'new\n');
    fs.chmodSync(path.join(src, 'tool.sh'), 0o755);
    g(src, 'add', 'a.txt', 'pic.bin', 'new.txt', 'tool.sh');
    put(src, 'a.txt', 'one\ntwo\nstaged\nunstaged\n');
    fs.rmSync(path.join(src, 'gone.txt'));
    fs.chmodSync(path.join(src, 'serve.sh'), 0o755);
    put(src, 'map.bin', crypto.randomBytes(4096));
    put(src, 'notes/run.sh', '#!/bin/sh\n', 0o755);
    put(src, 'notes/blob.dat', crypto.randomBytes(1024), 0o660);
    fs.symlinkSync('../a.txt', path.join(src, 'notes/link'));
    put(src, 'build/out.o', 'ignored\n');

    const into = at('bundle');
    const manifest = await buildBundle(src, { git: handoverGit, into, have: [head], carry: [] });
    expect(manifest).toMatchObject({ base: head, branch: 'main', commits: undefined, credentialFiles: [] });
    expect(manifest.untracked.map((u) => u.path)).toEqual(['notes/blob.dat', 'notes/link', 'notes/run.sh']);
    expect(fs.readdirSync(into).sort()).toEqual(['manifest.json', 'staged.patch', 'unstaged.patch', 'untracked.tar']);
    expect(JSON.parse(fs.readFileSync(path.join(into, 'manifest.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(manifest)));
    await verifyBundle(into, manifest);

    await applyBundle(dst, into, manifest, handoverGit);
    expect(g(dst, 'diff', '--cached', '--name-status')).toBe(g(src, 'diff', '--cached', '--name-status'));
    expect(g(dst, 'diff', '--name-status')).toBe(g(src, 'diff', '--name-status'));
    expect(g(dst, 'show', ':a.txt')).toBe('one\ntwo\nstaged');
    expect(fs.readFileSync(path.join(dst, 'a.txt'), 'utf8')).toBe('one\ntwo\nstaged\nunstaged\n');
    expect(g(dst, 'ls-files', '-s', 'tool.sh')).toMatch(/^100755 /);
    expect(perms(path.join(dst, 'tool.sh'))).toBe(0o755);
    expect(fs.readFileSync(path.join(dst, 'pic.bin'))).toEqual(fs.readFileSync(path.join(src, 'pic.bin')));
    expect(fs.existsSync(path.join(dst, 'gone.txt'))).toBe(false);
    // a mode and a binary changed in the working tree alone, as the unstaged patch carries them
    expect(g(dst, 'ls-files', '-s', 'serve.sh')).toMatch(/^100644 /);
    expect(perms(path.join(dst, 'serve.sh'))).toBe(0o755);
    expect(g(dst, 'diff', '--cached', '--name-only', 'map.bin')).toBe('');
    expect(fs.readFileSync(path.join(dst, 'map.bin'))).toEqual(fs.readFileSync(path.join(src, 'map.bin')));
    expect(perms(path.join(dst, 'notes/run.sh'))).toBe(0o755);
    expect(perms(path.join(dst, 'notes/blob.dat'))).toBe(0o660);
    expect(fs.readFileSync(path.join(dst, 'notes/blob.dat'))).toEqual(fs.readFileSync(path.join(src, 'notes/blob.dat')));
    expect(fs.readlinkSync(path.join(dst, 'notes/link'))).toBe('../a.txt');
    expect(fs.existsSync(path.join(dst, 'build'))).toBe(false);
    expect(await fingerprintOf(dst, handoverGit)).toBe(manifest.fingerprint);
    expect(await fingerprintOf(src, handoverGit)).toBe(manifest.fingerprint);
    // a machine whose config names a diff.orderFile lists the same changes in another order
    fs.writeFileSync(at('order'), 'tool.sh\npic.bin\nnew.txt\ngone.txt\na.txt\n');
    const ordered: GitRunner = (args, cwd) => handoverGit(['-c', `diff.orderFile=${at('order')}`, ...args], cwd);
    expect(await fingerprintOf(src, ordered)).toBe(manifest.fingerprint);

    const noExec = manifest.untracked.map((u) => (u.path === 'notes/run.sh' ? { ...u, mode: u.mode & ~0o111 } : u));
    await expect(applyBundle(lost, into, { ...manifest, untracked: noExec }, handoverGit)).rejects.toThrow(/notes\/run\.sh.*mode/);

    put(dst, 'notes/blob.dat', 'changed on the worker');
    expect(await fingerprintOf(dst, handoverGit)).not.toBe(manifest.fingerprint);
    fs.appendFileSync(path.join(into, 'staged.patch'), '\n');
    await expect(verifyBundle(into, manifest)).rejects.toThrow(/staged\.patch/);
  });

  it('restores a file added with intent to add without `git apply -N`, which empties the rest of the index on older git', async () => {
    const { at, g } = scratch();
    const src = at('src');
    g(at(''), 'init', '-q', src);
    put(src, 'a.txt', 'one\n');
    g(src, 'add', '.');
    g(src, 'commit', '-qm', 'base');
    const dst = at('dst');
    g(at(''), 'clone', '-q', src, dst);
    put(src, 'a.txt', 'one\nstaged\n');
    g(src, 'add', 'a.txt');
    put(src, 'b [x].txt', 'meant\n');
    g(src, 'add', '-N', 'b [x].txt');

    const into = at('bundle');
    const manifest = await buildBundle(src, { git: handoverGit, into, have: [g(src, 'rev-parse', 'HEAD')], carry: [] });
    const older: GitRunner = (args, cwd) => (args[0] === 'apply' && args.includes('--intent-to-add')
      ? Promise.resolve({ code: 1, stdout: '', stderr: 'git 2.43 would empty the index here' }) : handoverGit(args, cwd));
    await applyBundle(dst, into, manifest, older);
    expect(g(dst, 'status', '--porcelain')).toBe(g(src, 'status', '--porcelain'));
  });

  it('a branch with no upstream bundles against the shas the worker has', async () => {
    const { at, g } = scratch();
    const seed = at('seed');
    g(at(''), 'init', '-q', seed);
    put(seed, 'a.txt', 'a\n');
    g(seed, 'add', '.');
    g(seed, 'commit', '-qm', 'one');
    const shared = g(seed, 'rev-parse', 'HEAD');
    g(at(''), 'clone', '-q', '--bare', seed, at('up.git'));
    const [mac, worker] = [at('mac'), at('worker')];
    g(at(''), 'clone', '-q', at('up.git'), mac);
    g(at(''), 'clone', '-q', at('up.git'), worker);
    put(worker, 'w.txt', 'only on the worker\n');
    g(worker, 'add', '.');
    g(worker, 'commit', '-qm', 'worker only');

    g(mac, 'checkout', '-q', '-b', 'feat/kanban');
    put(mac, 'b.txt', 'b\n');
    g(mac, 'add', '.');
    g(mac, 'commit', '-qm', 'two');
    put(mac, 'c.txt', 'c\n');
    g(mac, 'add', '.');
    g(mac, 'commit', '-qm', 'three');
    const tip = g(mac, 'rev-parse', 'HEAD');
    expect(() => g(mac, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow();

    const have = g(worker, 'for-each-ref', '--format=%(objectname)').split('\n');
    expect(have).toContain(shared);
    const manifest = await buildBundle(mac, { git: handoverGit, into: at('b1'), have, carry: [] });
    expect(manifest).toMatchObject({ base: tip, branch: 'feat/kanban', commits: { count: 2, prerequisites: [shared] } });
    expect(g(worker, 'bundle', 'verify', at('b1/commits.bundle'))).toContain('requires');

    g(worker, 'worktree', 'add', '-q', '--detach', at('wt'), shared);
    await applyBundle(at('wt'), at('b1'), manifest, handoverGit);
    expect(g(at('wt'), 'rev-parse', 'HEAD')).toBe(tip);
    expect(g(at('wt'), 'symbolic-ref', '--short', 'HEAD')).toBe('feat/kanban');
    expect(fs.readFileSync(path.join(at('wt'), 'c.txt'), 'utf8')).toBe('c\n');

    // none of the worker's shas known here: the merge base with origin's default branch bounds it
    const workerOnly = g(worker, 'rev-parse', 'main');
    const fallback = await buildBundle(mac, { git: handoverGit, into: at('b2'), have: [workerOnly], carry: [] });
    expect(fallback.commits).toEqual({ count: 2, prerequisites: [shared] });

    g(mac, 'remote', 'remove', 'origin');
    const whole = await buildBundle(mac, { git: handoverGit, into: at('b3'), have: [], carry: [] });
    expect(whole.commits).toEqual({ count: 3, prerequisites: [] });
  });

  it('an unticked .env stays behind and is named; a ticked one travels; a tracked changed .env is reported by trackedCredentials', async () => {
    const { at, g } = scratch();
    const src = at('src');
    g(at(''), 'init', '-q', src);
    put(src, '.gitignore', '*.pem\nnode_modules/\n');
    put(src, '.env.example', 'KEY=\n');
    put(src, 'app.txt', 'app\n');
    g(src, 'add', '.');
    g(src, 'commit', '-qm', 'base');
    const base = g(src, 'rev-parse', 'HEAD');
    const dst = at('dst');
    g(at(''), 'clone', '-q', src, dst);
    put(src, 'id_rsa.pub', 'ssh-ed25519 AAAA\n');
    g(src, 'add', 'id_rsa.pub');
    g(src, 'commit', '-qm', 'a key');

    put(src, '.env', 'SECRET=1\n');
    put(src, 'deploy.pem', 'PEM\n');
    put(src, 'stays.pem', 'PEM 2\n');
    put(src, 'node_modules/pkg/test.key', 'fixture\n');
    put(src, 'notes.txt', 'notes\n');
    put(src, '.env.example', 'KEY=value\n');

    const into = at('bundle');
    const manifest = await buildBundle(src, { git: handoverGit, into, have: [base], carry: ['deploy.pem'] });
    expect(manifest.credentialFiles).toEqual(['.env', 'deploy.pem', 'stays.pem']);
    expect(manifest.untracked.map((u) => u.path)).toEqual(['deploy.pem', 'notes.txt']);
    expect(manifest.commits).toEqual({ count: 1, prerequisites: [base] });

    await applyBundle(dst, into, manifest, handoverGit);
    expect(fs.existsSync(path.join(dst, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(dst, 'stays.pem'))).toBe(false);
    expect(fs.readFileSync(path.join(dst, 'deploy.pem'), 'utf8')).toBe('PEM\n');
    expect(fs.existsSync(path.join(dst, 'node_modules'))).toBe(false);

    expect(await trackedCredentials(src, handoverGit, manifest)).toEqual(['.env.example', 'id_rsa.pub']);
  });

  it('refuses an untracked path or link target ustar cannot hold, which bsdtar would leave out, before packing', async () => {
    const { at, g } = scratch();
    const src = at('src');
    g(at(''), 'init', '-q', src);
    put(src, 'a.txt', 'a\n');
    g(src, 'add', '.');
    g(src, 'commit', '-qm', 'base');
    // 155 bytes of folders before the last slash and 100 after is the most ustar holds
    put(src, `${'d'.repeat(153)}/${'f'.repeat(100)}`, 'fits\n');
    fs.symlinkSync('t'.repeat(100), path.join(src, 'fits'));
    put(src, `${'d'.repeat(154)}/${'f'.repeat(100)}`, 'too long\n');
    await expect(buildBundle(src, { git: handoverGit, into: at('bundle'), have: [], carry: [] })).rejects.toThrow(`${'d'.repeat(154)}/${'f'.repeat(100)} has a path too long`);
    expect(fs.existsSync(path.join(at('bundle'), 'untracked.tar'))).toBe(false);
    fs.rmSync(path.join(src, 'd'.repeat(154)), { recursive: true });
    fs.symlinkSync('t'.repeat(101), path.join(src, 'far'));
    await expect(buildBundle(src, { git: handoverGit, into: at('bundle'), have: [], carry: [] })).rejects.toThrow('far links to a target too long');
    fs.rmSync(path.join(src, 'far'));
    const manifest = await buildBundle(src, { git: handoverGit, into: at('bundle'), have: [], carry: [] });
    expect(manifest.untracked.map((u) => u.path)).toEqual([`${'d'.repeat(153)}/${'f'.repeat(100)}`, 'fits']);
    expect(execFileSync('tar', ['-tf', path.join(at('bundle'), 'untracked.tar')], { encoding: 'utf8' }).trim().split('\n')).toHaveLength(2);
  });

  it('refuses past BUNDLE_MAX with the size', async () => {
    const { at, g } = scratch();
    const src = at('src');
    g(at(''), 'init', '-q', src);
    put(src, 'a.txt', 'a\n');
    g(src, 'add', '.');
    g(src, 'commit', '-qm', 'base');
    // sparse, so the test writes almost nothing to disk
    const big = fs.openSync(path.join(src, 'big.bin'), 'w');
    fs.ftruncateSync(big, BUNDLE_MAX + 1024 * 1024);
    fs.closeSync(big);

    await expect(buildBundle(src, { git: handoverGit, into: at('bundle'), have: [], carry: [] })).rejects.toThrow('101.0 MB');
    expect(fs.existsSync(path.join(at('bundle'), 'untracked.tar'))).toBe(false);
  });
});
