import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FleetId, TransferFile } from '@svall/protocol';
import { resolvePaths } from '../../src/paths.js';
import { realStages } from '../../src/durable.js';
import { DEFAULT_EXCLUDES, excludeMatcher } from '../../src/handover/inventory.js';
import { realScanFs, scanPath, type ScanFs } from '../../src/handover/manifest.js';
import { ReplicaRecord, ReplicaStore, realReplicaFs, replicaRoots, type ReplicaOptions, type ReplicaRoot } from '../../src/handover/replicas.js';

const made: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync('/tmp/svall-t-'); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const FLEET = '5e1f0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as FleetId;
const TX = 'tx-1';
const TX2 = 'tx-2';
const DIGEST = 'd'.repeat(64);
const EXCLUDES = [...DEFAULT_EXCLUDES];
const NOW = Date.UTC(2026, 8, 23, 14, 5, 9);
const STAMP = '2026-09-23T140509Z';
const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
const real = (p: string): string => fs.realpathSync.native(p);
const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// a fleet home and a folder for roots under /tmp, which macOS reaches through the /private/tmp symlink
function world() {
  const base = tmp();
  const home = path.join(base, 'fleet');
  const work = path.join(base, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(work);
  const paths = resolvePaths(home);
  const store = (opts: Partial<ReplicaOptions> = {}): ReplicaStore => new ReplicaStore({ fleetId: FLEET, paths, now: () => NOW, ...opts });
  const recordFile = (p: string): string => paths.replicaRecord(FLEET, real(path.dirname(p)) + '/' + path.basename(p));
  const record = (p: string): ReplicaRecord | undefined => {
    try { return ReplicaRecord.parse(JSON.parse(fs.readFileSync(recordFile(p), 'utf8'))); } catch { return undefined; }
  };
  return { base, home, work, paths, store, recordFile, record };
}

const dir = (p: string, id = 'r_app'): ReplicaRoot => ({ id, kind: 'repo', entry: 'dir', path: p });
const write = (base: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
  fs.writeFileSync(path.join(base, rel), text);
};
const tree = (base: string, files: Record<string, string>): string => {
  for (const [rel, text] of Object.entries(files)) write(base, rel, text);
  return base;
};
const content = async (p: string): Promise<TransferFile[]> => (await scanPath(p, excludeMatcher(EXCLUDES)))?.files ?? [];
const claimFor = (transactionId: string, incoming: TransferFile[] = []) => ({ transactionId, excludes: EXCLUDES, incoming });
const sealAs = (transactionId: string, files: TransferFile[]) => ({ transactionId, generation: 5, manifestDigest: DIGEST, files });

describe('replica records', () => {
  it('keeps each record under the fleet home, keyed by fleet id and the hash of the canonical path, at mode 0600', async () => {
    expect(resolvePaths('/x').replicaRecord(FLEET, '/srv/app')).toBe(`/x/replicas/${FLEET}/${sha('/srv/app')}.json`);
    const w = world();
    const app = path.join(w.work, 'app');
    const check = await w.store().claim(dir(app), claimFor(TX));
    const canonical = path.join(real(w.work), 'app');
    expect(check).toEqual({ ok: true, path: canonical, kind: 'absent' });
    expect(w.recordFile(app)).toBe(path.join(w.home, 'replicas', FLEET, `${sha(canonical)}.json`));
    expect(fs.statSync(w.recordFile(app)).mode & 0o777).toBe(0o600);
    expect(w.record(app)).toMatchObject({ state: 'receiving', transactionId: TX, path: canonical, fleetId: FLEET });
    expect(fs.readdirSync(app)).toEqual([]);
  });

  it('are kept for the roots a manifest carries, at the path each has on both machines', () => {
    const root = { kind: 'repo' as const, entry: 'dir' as const, files: [] };
    const roots = [
      { ...root, id: 'r_app', path: '/Users/linus/app' },
      { ...root, kind: 'worktree' as const, id: 'r_wt', path: '/Users/linus/app/wt', foldedInto: 'r_app' },
    ];
    expect(replicaRoots({ roots })).toEqual([{ id: 'r_app', kind: 'repo', entry: 'dir', path: '/Users/linus/app' }]);
  });

  it('refuses a record this machine cannot read', async () => {
    const w = world();
    const app = tree(path.join(w.work, 'app'), { 'a.txt': 'a' });
    write(path.dirname(w.recordFile(app)), path.basename(w.recordFile(app)), '{"not":"a record"}');
    const check = await w.store().inspect(dir(app), { excludes: EXCLUDES });
    expect(check).toMatchObject({ ok: false, blocker: { code: 'destination_occupied', message: expect.stringMatching(/record/) } });
  });
});

describe('reserving an absent root', () => {
  it('writes the exclusive record before it creates the root', async () => {
    const w = world();
    const app = path.join(w.work, 'deep/app');
    const seen: (string | undefined)[] = [];
    const store = w.store({
      fs: {
        mkdir: (p, recursive) => {
          if (!recursive) seen.push(w.record(app)?.state);
          realReplicaFs.mkdir(p, recursive);
        },
      },
    });
    expect(await store.claim(dir(app), claimFor(TX))).toMatchObject({ ok: true, kind: 'absent' });
    expect(seen).toEqual(['reserved']);
    expect(w.record(app)).toMatchObject({ state: 'receiving', transactionId: TX, baseline: [] });
  });

  it('lets exactly one of two concurrent claims reserve it', async () => {
    const w = world();
    const app = path.join(w.work, 'app');
    const store = w.store();
    const [a, b] = await Promise.allSettled([store.claim(dir(app), claimFor(TX)), store.claim(dir(app), claimFor(TX2))]);
    expect(a).toMatchObject({ status: 'fulfilled', value: { ok: true } });
    expect(b).toMatchObject({ status: 'rejected', reason: { code: 'conflict' } });
    expect(w.record(app)).toMatchObject({ transactionId: TX });
  });

  it('refuses when a record is created between its check and its own', async () => {
    const w = world();
    const app = path.join(w.work, 'app');
    const store = w.store({
      stages: {
        link: (from, to) => {
          fs.writeFileSync(to, 'someone else');
          realStages.link(from, to);
        },
      },
    });
    await expect(store.claim(dir(app), claimFor(TX))).rejects.toMatchObject({ code: 'conflict' });
    expect(fs.existsSync(app)).toBe(false);
  });

  it('gives the reservation back when the root appears before it is created', async () => {
    const w = world();
    const app = path.join(w.work, 'app');
    const store = w.store({
      fs: {
        mkdir: (p, recursive) => {
          if (!recursive) tree(p, { 'theirs.txt': 'mine' });
          realReplicaFs.mkdir(p, recursive);
        },
      },
    });
    expect(await store.claim(dir(app), claimFor(TX))).toMatchObject({ ok: false, blocker: { code: 'destination_occupied' } });
    expect(fs.existsSync(w.recordFile(app))).toBe(false);
    expect(fs.readFileSync(path.join(app, 'theirs.txt'), 'utf8')).toBe('mine');
  });

  it('creates an absent file root as an empty file it alone could have made', async () => {
    const w = world();
    const note = path.join(w.work, 'notes/todo.md');
    const root: ReplicaRoot = { id: 'r_note', kind: 'context', entry: 'file', path: note };
    expect(await w.store().claim(root, claimFor(TX))).toMatchObject({ ok: true, kind: 'absent' });
    expect(fs.statSync(note).size).toBe(0);
  });

  it('finishes a reservation a crash cut short, and refuses one whose root filled up meanwhile', async () => {
    const w = world();
    const app = path.join(w.work, 'app');
    const crashOnCreate = w.store({ fs: { mkdir: (p, recursive) => { if (!recursive) throw new Error('crash'); realReplicaFs.mkdir(p, recursive); } } });
    await expect(crashOnCreate.claim(dir(app), claimFor(TX))).rejects.toThrow('crash');
    expect(w.record(app)).toMatchObject({ state: 'reserved', transactionId: TX });
    expect(await w.store().claim(dir(app), claimFor(TX))).toMatchObject({ ok: true, kind: 'absent' });
    expect(w.record(app)).toMatchObject({ state: 'receiving', transactionId: TX });

    const other = path.join(w.work, 'other');
    const crashOnMark = w.store({ stages: { rename: () => { throw new Error('crash'); } } });
    await expect(crashOnMark.claim(dir(other, 'r_other'), claimFor(TX))).rejects.toThrow('crash');
    expect(w.record(other)).toMatchObject({ state: 'reserved' });
    expect(fs.readdirSync(other)).toEqual([]);
    expect(await w.store().claim(dir(other, 'r_other'), claimFor(TX))).toMatchObject({ ok: true, kind: 'absent' });

    const third = path.join(w.work, 'third');
    await expect(crashOnMark.claim(dir(third, 'r_third'), claimFor(TX))).rejects.toThrow('crash');
    write(third, 'theirs.txt', 'mine');
    expect(await w.store().claim(dir(third, 'r_third'), claimFor(TX))).toMatchObject({ ok: false, blocker: { code: 'destination_occupied' } });
  });
});

describe('an existing root', () => {
  it('is refused when no handover left it there and it holds anything but exactly what the handover brings', async () => {
    const source = { '.git/HEAD': 'ref: refs/heads/main\n', '.git/config': '[core]\n', 'a.txt': 'a' };
    const edits: ((app: string) => void)[] = [
      (app) => write(app, 'mine.txt', 'written here'),
      (app) => write(app, 'a.txt', 'b'),
      (app) => fs.rmSync(path.join(app, 'a.txt')),
      (app) => { fs.rmSync(path.join(app, 'a.txt')); fs.symlinkSync('.git/config', path.join(app, 'a.txt')); },
    ];
    for (const edit of edits) {
      const w = world();
      const mac = tree(path.join(w.base, 'mac/app'), source);
      const app = path.join(w.work, 'app');
      fs.cpSync(mac, app, { recursive: true });
      edit(app);
      const incoming = await content(mac);
      const store = w.store();
      for (const check of [await store.inspect(dir(app), { excludes: EXCLUDES, incoming }), await store.claim(dir(app), claimFor(TX, incoming))]) {
        expect(check).toMatchObject({ ok: false, blocker: { code: 'destination_occupied', entity: { kind: 'root', id: 'r_app' } } });
      }
      expect(fs.existsSync(w.recordFile(app))).toBe(false);
    }
  });

  it('is a replica when it holds exactly what the handover brings, as setup\'s own mission control does, and is claimed only while it still does', async () => {
    const w = world();
    const mac = tree(path.join(w.base, 'mac/home'), { 'CLAUDE.md': 'mission control\n', '.claude/skills/go/SKILL.md': 'go\n', 'node_modules/x.js': 'a cache' });
    const home = path.join(w.work, 'home');
    fs.cpSync(mac, home, { recursive: true });
    fs.chmodSync(path.join(home, 'CLAUDE.md'), 0o600);
    // what the excludes leave out is each machine's own
    write(home, 'node_modules/x.js', 'another cache');
    const incoming = await content(mac);
    const store = w.store();
    expect(await store.inspect(dir(home, 'r_home'), { excludes: EXCLUDES, incoming })).toMatchObject({ ok: true, kind: 'replica' });
    // an inspect that does not say what the handover brings has nothing to find it equal to
    expect(await store.inspect(dir(home, 'r_home'), { excludes: EXCLUDES })).toMatchObject({ ok: false, blocker: { code: 'destination_occupied' } });

    // edited after preflight: the claim finds it no longer equal, and takes nothing
    write(home, 'CLAUDE.md', 'mine now\n');
    expect(await store.claim(dir(home, 'r_home'), claimFor(TX, incoming))).toMatchObject({ ok: false, blocker: { code: 'destination_occupied' } });
    expect(w.record(home)).toBeUndefined();

    write(home, 'CLAUDE.md', 'mission control\n');
    expect(await store.claim(dir(home, 'r_home'), claimFor(TX, incoming))).toMatchObject({ ok: true, kind: 'replica' });
    const record = w.record(home);
    expect(record).toMatchObject({ state: 'receiving', transactionId: TX });
    expect(record?.state === 'receiving' && record.baseline.map((f) => [f.path, f.type === 'file' && f.sha256])).toEqual(incoming.map((f) => [f.path, f.type === 'file' && f.sha256]));
  });

  it('is resumed by the transaction that claimed it while it holds only what that claim knew, rsync\'s partial files aside', async () => {
    const w = world();
    const app = path.join(w.work, 'app');
    const source = tree(path.join(w.base, 'source'), { 'a.txt': 'a', 'b.txt': 'b' });
    const incoming = await content(source);
    await w.store().claim(dir(app), claimFor(TX, incoming));
    write(app, 'a.txt', 'a');
    write(app, '.b.txt.Qx81Zk', 'half of b');
    expect(await w.store().claim(dir(app), claimFor(TX, incoming))).toMatchObject({ ok: true, kind: 'resume' });
    // written here while the copy was paused: never deleted by the resumed mirror
    write(app, 'mine.txt', 'written here');
    expect(await w.store().claim(dir(app), claimFor(TX, incoming))).toMatchObject({
      ok: false, blocker: { code: 'destination_diverged' }, divergence: { added: { preview: ['mine.txt'] } },
    });
    expect(w.record(app)).toMatchObject({ state: 'receiving', transactionId: TX });
  });

  it('is not resumed over a file that only looks like rsync\'s partial copy of one the claim does not bring', async () => {
    const w = world();
    const app = path.join(w.work, 'app');
    const source = tree(path.join(w.base, 'source'), { 'a.txt': 'a', 'sub/c.txt': 'c' });
    const incoming = await content(source);
    await w.store().claim(dir(app), claimFor(TX, incoming));
    write(app, '.a.txt.Qx81Zk', 'half of a');
    write(app, 'sub/.c.txt.Ab12Cd', 'half of c');
    expect(await w.store().claim(dir(app), claimFor(TX, incoming))).toMatchObject({ ok: true, kind: 'resume' });
    // written here while the copy was paused, each named as a partial copy of a file the claim does not bring there
    write(app, '.env.backup', 'mine');
    write(app, 'sub/.a.txt.Qx81Zk', 'mine too');
    expect(await w.store().claim(dir(app), claimFor(TX, incoming))).toMatchObject({
      ok: false, blocker: { code: 'destination_diverged' }, divergence: { added: { count: 2, preview: ['.env.backup', 'sub/.a.txt.Qx81Zk'] } },
    });
  });
});

describe('sealing', () => {
  it('seals a destination root only for the transaction that claimed it, and once', async () => {
    const w = world();
    const app = path.join(w.work, 'app');
    const store = w.store();
    await store.claim(dir(app), claimFor(TX));
    tree(app, { 'a.txt': 'a' });
    const files = await content(app);
    expect(() => store.seal(dir(app), sealAs(TX2, files), 'destination')).toThrow(expect.objectContaining({ code: 'not_claimed' }));
    store.seal(dir(app), sealAs(TX, files), 'destination');
    const sealed = w.record(app);
    expect(sealed).toEqual({ version: 1, fleetId: FLEET, path: path.join(real(w.work), 'app'), state: 'sealed', sealedBy: TX, generation: 5, manifestDigest: DIGEST, baseline: files });
    const bytes = fs.readFileSync(w.recordFile(app));
    store.seal(dir(app), sealAs(TX, files), 'destination');
    expect(fs.readFileSync(w.recordFile(app)).equals(bytes)).toBe(true);

    const stray = tree(path.join(w.work, 'stray'), { 'b.txt': 'b' });
    expect(() => store.seal(dir(stray, 'r_stray'), sealAs(TX, []), 'destination')).toThrow(expect.objectContaining({ code: 'not_claimed' }));
  });

  it('records the copy the source leaves behind as a replica its next handover can prove', async () => {
    const w = world();
    const app = tree(path.join(w.work, 'app'), { 'a.txt': 'a', 'node_modules/x.js': '' });
    const store = w.store();
    store.seal(dir(app), sealAs(TX, await content(app)), 'source');
    expect(w.record(app)).toMatchObject({ state: 'sealed', sealedBy: TX, generation: 5 });
    write(app, 'node_modules/y.js', 'a destination-local cache');
    expect(await store.inspect(dir(app), { excludes: EXCLUDES })).toMatchObject({ ok: true, kind: 'replica' });
  });

  it('refuses manifest paths that could leave their root', async () => {
    const w = world();
    const app = tree(path.join(w.work, 'app'), { 'a.txt': 'a' });
    const [a] = await content(app);
    const store = w.store();
    for (const bad of ['../escape', '/abs', 'a/./b', 'a//b', '', 'bell\u0007']) {
      expect(() => store.seal(dir(app), sealAs(TX, [{ ...a, path: bad }]), 'source')).toThrow(expect.objectContaining({ code: 'invalid' }));
      expect(await store.claim(dir(path.join(w.work, 'fresh')), claimFor(TX, [{ ...a, path: bad }]))).toMatchObject({ ok: false, blocker: { code: 'path_unsupported' } });
    }
    expect(() => store.seal(dir(app), sealAs(TX, [a, a]), 'source')).toThrow(/twice/);
    expect(await store.inspect(dir(`${w.work}/x/../app`), { excludes: EXCLUDES })).toMatchObject({ ok: false, blocker: { code: 'path_unsupported' } });
    expect(fs.existsSync(path.join(w.work, 'fresh'))).toBe(false);
  });
});

describe('a sealed replica', () => {
  async function sealed() {
    const w = world();
    const app = tree(path.join(w.work, 'app'), { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    const baseline = await content(app);
    w.store().seal(dir(app), sealAs('tx-0', baseline), 'source');
    return { w, app, baseline };
  }

  it('is claimed once it proves it holds its baseline', async () => {
    const { w, app, baseline } = await sealed();
    const incoming = await content(tree(path.join(w.base, 'mac/app'), { 'a.txt': 'A', 'd.txt': 'd' }));
    const store = w.store();
    expect(await store.inspect(dir(app), { excludes: EXCLUDES })).toMatchObject({ ok: true, kind: 'replica' });
    expect(await store.claim(dir(app), claimFor(TX, incoming))).toMatchObject({ ok: true, kind: 'replica' });
    expect(w.record(app)).toMatchObject({ state: 'receiving', transactionId: TX, baseline, incoming });
  });

  it('blocks, and is left as it was, when it changed while its machine did not own the fleet', async () => {
    const { w, app } = await sealed();
    write(app, 'a.txt', 'edited');
    write(app, 'notes.md', 'new');
    fs.rmSync(path.join(app, 'c.txt'));
    const bytes = fs.readFileSync(w.recordFile(app));
    const store = w.store();
    for (const check of [await store.inspect(dir(app), { excludes: EXCLUDES }), await store.claim(dir(app), claimFor(TX))]) {
      expect(check).toMatchObject({
        ok: false,
        blocker: {
          code: 'destination_diverged', entity: { kind: 'root', id: 'r_app' },
          message: expect.stringMatching(/: 1 added \(notes\.md\); 1 removed \(c\.txt\); 1 changed \(a\.txt\)\. Recover the changes by hand, or archive it to continue$/),
        },
        divergence: { added: { preview: ['notes.md'] }, removed: { preview: ['c.txt'] }, changed: { preview: ['a.txt'] } },
      });
    }
    expect(fs.readFileSync(w.recordFile(app)).equals(bytes)).toBe(true);
  });

  it('blocks on what the handover that sealed it excluded once this transfer carries that path', async () => {
    const w = world();
    const app = tree(path.join(w.work, 'app'), { 'a.txt': 'a', 'data/built.bin': 'made on this machine' });
    const baseline = (await scanPath(app, excludeMatcher([...EXCLUDES, 'data/'])))?.files ?? [];
    w.store().seal(dir(app), sealAs('tx-0', baseline), 'source');
    const store = w.store();
    for (const check of [await store.inspect(dir(app), { excludes: EXCLUDES }), await store.claim(dir(app), claimFor(TX))]) {
      expect(check).toMatchObject({ ok: false, blocker: { code: 'destination_diverged' }, divergence: { added: { preview: ['data/built.bin'] } } });
    }
    expect(w.record(app)).toMatchObject({ state: 'sealed', sealedBy: 'tx-0' });
  });

  it('proves a Git directory carried on its own whole, and reads a fetch into it as no change', async () => {
    const w = world();
    const bare = tree(path.join(w.work, 'tool.git'), { HEAD: 'ref: refs/heads/main\n', 'refs/heads/build/x': '1111\n', 'objects/ab/cd': 'blob' });
    const root: ReplicaRoot = { id: 'r_tool', kind: 'gitdir', entry: 'dir', path: bare };
    const baseline = (await scanPath(bare, excludeMatcher([])))?.files ?? [];
    w.store().seal(root, sealAs('tx-0', baseline), 'source');
    write(bare, 'FETCH_HEAD', 'abc\n');
    write(bare, 'objects/pack/pack-1.pack', 'pack');
    expect(await w.store().inspect(root, { excludes: EXCLUDES })).toMatchObject({ ok: true, kind: 'replica' });
    write(bare, 'refs/heads/build/x', '2222\n');
    expect(await w.store().inspect(root, { excludes: EXCLUDES })).toMatchObject({ ok: false, divergence: { changed: { preview: ['refs/heads/build/x'] } } });
  });

  it.skipIf(!hasGit)('is claimed after a git status and a fetch ran in it, and blocked once a commit did (needs git)', async () => {
    const w = world();
    const app = tree(path.join(w.work, 'app'), { 'a.txt': 'a' });
    const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: app, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('add', 'a.txt');
    git('commit', '-qm', 'init');
    w.store().seal(dir(app), sealAs('tx-0', await content(app)), 'source');
    const index = fs.readFileSync(path.join(app, '.git/index'));
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(app, 'a.txt'), later, later);
    git('update-index', '--really-refresh');
    expect(fs.readFileSync(path.join(app, '.git/index')).equals(index)).toBe(false);
    write(app, '.git/FETCH_HEAD', `${git('rev-parse', 'HEAD')}\t\tbranch 'main' of origin\n`);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('hash-object', '-w', '--stdin', '--path', 'x');
    expect(await w.store().inspect(dir(app), { excludes: EXCLUDES })).toMatchObject({ ok: true, kind: 'replica' });
    git('commit', '-q', '--allow-empty', '-m', 'made while this machine did not own the fleet');
    const check = await w.store().inspect(dir(app), { excludes: EXCLUDES });
    expect(check).toMatchObject({ ok: false, blocker: { code: 'destination_diverged' } });
    expect(check.ok ? [] : check.divergence!.changed.preview).toEqual(expect.arrayContaining(['.git/logs/HEAD', '.git/refs/heads/main']));
  }, 60_000);

  it.skipIf(!hasGit)('is claimed after a fetch into a clone and a status refresh in a bare repository\'s worktree (needs git)', async () => {
    const w = world();
    const run = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
    const upstream = tree(path.join(w.base, 'upstream'), { 'a.txt': 'a' });
    run(upstream, 'init', '-q', '-b', 'main');
    run(upstream, 'add', 'a.txt');
    run(upstream, 'commit', '-qm', 'init');
    const clone = path.join(w.work, 'clone');
    run(w.work, 'clone', '-q', upstream, clone);
    const bare = path.join(w.work, 'tool.git');
    run(w.work, 'clone', '-q', '--bare', upstream, bare);
    const wt = path.join(bare, 'wt');
    run(bare, 'worktree', 'add', '-q', wt, '-b', 'feature');
    const cloneRoot = dir(clone, 'r_clone');
    const bareRoot: ReplicaRoot = { id: 'r_tool', kind: 'gitdir', entry: 'dir', path: bare };
    w.store().seal(cloneRoot, sealAs('tx-0', await content(clone)), 'source');
    w.store().seal(bareRoot, sealAs('tx-0', (await scanPath(bare, excludeMatcher([])))?.files ?? []), 'source');

    run(upstream, 'commit', '-q', '--allow-empty', '-m', 'upstream moved on');
    run(clone, 'fetch', '-q');
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(wt, 'a.txt'), later, later);
    run(wt, 'update-index', '--really-refresh');
    expect(await w.store().inspect(cloneRoot, { excludes: EXCLUDES })).toMatchObject({ ok: true, kind: 'replica' });
    expect(await w.store().inspect(bareRoot, { excludes: EXCLUDES })).toMatchObject({ ok: true, kind: 'replica' });

    run(wt, 'commit', '-q', '--allow-empty', '-m', 'made while this machine did not own the fleet');
    expect(await w.store().inspect(bareRoot, { excludes: EXCLUDES })).toMatchObject({ ok: false, blocker: { code: 'destination_diverged' } });
  }, 60_000);

  it('is reservable again once its root is gone', async () => {
    const { w, app } = await sealed();
    fs.rmSync(app, { recursive: true });
    const store = w.store();
    expect(await store.inspect(dir(app), { excludes: EXCLUDES })).toMatchObject({ ok: true, kind: 'absent' });
    expect(await store.claim(dir(app), claimFor(TX))).toMatchObject({ ok: true, kind: 'absent' });
    expect(w.record(app)).toMatchObject({ state: 'receiving', transactionId: TX, baseline: [] });
  });

  it('refuses a claim when another call changed its record while it was being proved', async () => {
    const { w, app } = await sealed();
    let raced = false;
    const racing = {
      ...realScanFs,
      readdir: (p: string) => {
        if (!raced) { raced = true; fs.writeFileSync(w.recordFile(app), JSON.stringify({ ...w.record(app), sealedBy: 'tx-9' })); }
        return realScanFs.readdir(p);
      },
    };
    await expect(w.store({ scanFs: racing }).claim(dir(app), claimFor(TX))).rejects.toMatchObject({ code: 'conflict' });
    expect(w.record(app)).toMatchObject({ state: 'sealed', sealedBy: 'tx-9' });
  });
});

describe("an aborted transaction's partial copy", () => {
  async function partial() {
    const w = world();
    const app = tree(path.join(w.work, 'app'), { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    w.store().seal(dir(app), sealAs('tx-0', await content(app)), 'source');
    const source = tree(path.join(w.base, 'mac/app'), { 'a.txt': 'A', 'c.txt': 'c', 'd.txt': 'd' });
    await w.store().claim(dir(app), claimFor(TX, await content(source)));
    // rsync got as far as a.txt and deleted b.txt, then the transaction was aborted
    fs.copyFileSync(path.join(source, 'a.txt'), path.join(app, 'a.txt'));
    fs.rmSync(path.join(app, 'b.txt'));
    return { w, app, source };
  }

  it('is taken over by a later transaction while it holds nothing but either version', async () => {
    const { w, app, source } = await partial();
    expect(await w.store().claim(dir(app), claimFor(TX2, await content(source)))).toMatchObject({ ok: true, kind: 'replica' });
    expect(w.record(app)).toMatchObject({ state: 'receiving', transactionId: TX2, baseline: await content(app) });
  });

  it('is taken over by a later transaction that brings a file the aborted copy wrote there, and passes that one\'s preflight as its claim does', async () => {
    const { w, app, source } = await partial();
    // the aborted copy finished, with a file the source wrote while it ran
    write(source, 'e.txt', 'written on the source during the copy');
    fs.cpSync(source, app, { recursive: true });
    const store = w.store();
    expect(await store.inspect(dir(app), { excludes: EXCLUDES, incoming: await content(source) })).toMatchObject({ ok: true, kind: 'replica' });
    expect(await store.inspect(dir(app), { excludes: EXCLUDES })).toMatchObject({ ok: false, divergence: { added: { preview: ['e.txt'] } } });
    // the source moved on since, and still holds that file
    write(source, 'c.txt', 'changed on the source');
    expect(await store.inspect(dir(app), { excludes: EXCLUDES, incoming: await content(source) })).toMatchObject({ ok: true, kind: 'replica' });
    expect(await store.claim(dir(app), claimFor(TX2, await content(source)))).toMatchObject({ ok: true, kind: 'replica' });
    expect(w.record(app)).toMatchObject({ state: 'receiving', transactionId: TX2 });
  });

  it('blocks a later transaction once someone changed it', async () => {
    const { w, app } = await partial();
    write(app, 'c.txt', 'neither version');
    expect(await w.store().claim(dir(app), claimFor(TX2))).toMatchObject({
      ok: false, blocker: { code: 'destination_diverged' }, divergence: { changed: { preview: ['c.txt'] } },
    });
    expect(w.record(app)).toMatchObject({ transactionId: TX });
  });
});

describe('real paths', () => {
  it('keys a root by its real path however it is reached', async () => {
    const w = world();
    const via = path.join(w.base, 'via');
    fs.symlinkSync(w.work, via);
    await w.store().claim(dir(path.join(via, 'app')), claimFor(TX));
    expect(await w.store().inspect(dir(path.join(w.work, 'app')), { transactionId: TX, excludes: EXCLUDES })).toMatchObject({ ok: true, kind: 'resume', path: path.join(real(w.work), 'app') });
  });

  it('refuses a root that reaches the fleet home through a symlink or holds it, but not the fleet .env or mission control', async () => {
    const w = world();
    fs.symlinkSync(w.home, path.join(w.work, 'sneaky'));
    const store = w.store();
    for (const root of [dir(path.join(w.work, 'sneaky/keys')), dir(w.base), dir(path.join(w.work, 'sneaky'))]) {
      expect(await store.claim(root, claimFor(TX))).toMatchObject({ ok: false, blocker: { code: 'path_unsupported', message: expect.stringContaining(real(w.home)) } });
    }
    const env: ReplicaRoot = { id: 'r_env', kind: 'env', entry: 'file', path: path.join(w.home, '.env') };
    const mission: ReplicaRoot = { id: 'r_home', kind: 'home', entry: 'dir', path: path.join(w.home, 'home') };
    for (const root of [{ ...env, path: path.join(w.work, 'sneaky/.env') }, { ...mission, path: path.join(w.work, 'sneaky/home') }]) {
      expect(await store.claim(root, claimFor(TX))).toMatchObject({ ok: false, blocker: { code: 'path_unsupported' } });
    }
    expect(await store.claim(env, claimFor(TX))).toMatchObject({ ok: true, kind: 'absent' });
    expect(await store.claim(mission, claimFor(TX))).toMatchObject({ ok: true, kind: 'absent' });
    expect(fs.existsSync(path.join(w.home, 'keys'))).toBe(false);
  });

  it('refuses, by real path on this machine, a root that holds or lies in its ssh folder, an agent login or its Svall install', async () => {
    const w = world();
    const account = path.join(w.base, 'account');
    // this machine's ~/.ssh is a link into a folder a handover would carry
    fs.mkdirSync(path.join(w.work, 'dotfiles', 'ssh'), { recursive: true });
    fs.mkdirSync(account);
    fs.symlinkSync(path.join(w.work, 'dotfiles', 'ssh'), path.join(account, '.ssh'));
    fs.mkdirSync(path.join(account, '.local', 'share', 'svall', 'gateway'), { recursive: true });
    const local = { files: [path.join(account, '.claude', '.credentials.json')], dirs: [path.join(account, '.ssh'), path.join(account, '.local', 'share', 'svall')], worktrees: [] };
    const store = w.store({ local });
    for (const [root, held] of [
      [dir(path.join(w.work, 'dotfiles')), real(path.join(w.work, 'dotfiles', 'ssh'))],
      [dir(path.join(w.work, 'dotfiles', 'ssh', 'keys')), real(path.join(w.work, 'dotfiles', 'ssh'))],
      [dir(path.join(account, '.local')), real(path.join(account, '.local', 'share', 'svall'))],
      [dir(path.join(account, '.claude')), `${real(account)}/.claude/.credentials.json`],
    ] as const) {
      expect(await store.claim(root, claimFor(TX))).toMatchObject({ ok: false, blocker: { code: 'path_unsupported', message: expect.stringContaining(held) } });
      await expect(store.archive(root, [root.id], claimFor(TX))).rejects.toThrow(held);
    }
    expect(fs.readdirSync(path.join(w.work, 'dotfiles'))).toEqual(['ssh']);
  });

  it("claims a worktree in OpenCode's worktree folder, which holds the user's code, and nothing else of OpenCode's", async () => {
    const w = world();
    const data = path.join(w.base, 'account', '.local', 'share', 'opencode');
    fs.mkdirSync(path.join(data, 'worktree'), { recursive: true });
    const store = w.store({ local: { files: [], dirs: [data], worktrees: [path.join(data, 'worktree')] } });
    const tree: ReplicaRoot = { id: 'r_wt', kind: 'worktree', entry: 'dir', path: path.join(data, 'worktree', '752593', 'react-boilerplate') };
    expect(await store.claim(tree, claimFor(TX))).toMatchObject({ ok: true, kind: 'absent' });
    for (const root of [dir(path.join(data, 'worktree')), dir(path.join(data, 'snapshot'))]) {
      expect(await store.claim(root, claimFor(TX))).toMatchObject({ ok: false, blocker: { code: 'path_unsupported', message: expect.stringContaining(`lies in ${real(data)}`) } });
    }
  });

  it("refuses mission control's folder, the fleet .env, docs or agent profiles when a link leads them elsewhere in the fleet home", async () => {
    const w = world();
    fs.mkdirSync(path.join(w.home, 'keys'));
    fs.writeFileSync(path.join(w.home, 'token'), 'secret');
    fs.symlinkSync(path.join(w.home, 'keys'), path.join(w.home, 'home'));
    fs.symlinkSync(path.join(w.home, 'token'), path.join(w.home, '.env'));
    fs.symlinkSync(path.join(w.home, 'keys'), w.paths.docs);
    fs.symlinkSync(path.join(w.home, 'keys'), w.paths.agentProfiles);
    const store = w.store();
    const mission: ReplicaRoot = { id: 'r_home', kind: 'home', entry: 'dir', path: path.join(w.home, 'home') };
    const env: ReplicaRoot = { id: 'r_env', kind: 'env', entry: 'file', path: path.join(w.home, '.env') };
    const docs: ReplicaRoot = { id: 'r_docs', kind: 'docs', entry: 'dir', path: w.paths.docs };
    const profiles: ReplicaRoot = { id: 'r_profiles', kind: 'profiles', entry: 'dir', path: w.paths.agentProfiles };
    for (const root of [mission, env, docs, profiles]) {
      expect(await store.claim(root, claimFor(TX))).toMatchObject({ ok: false, blocker: { code: 'path_unsupported' } });
    }
    expect(fs.readFileSync(path.join(w.home, 'token'), 'utf8')).toBe('secret');
  });

  it('claims the fleet\'s docs and agent profiles at their own paths in the fleet home, and nowhere else in it', async () => {
    const w = world();
    const store = w.store();
    const docs: ReplicaRoot = { id: 'r_docs', kind: 'docs', entry: 'dir', path: w.paths.docs };
    const profiles: ReplicaRoot = { id: 'r_profiles', kind: 'profiles', entry: 'dir', path: w.paths.agentProfiles };
    for (const root of [{ ...docs, path: w.paths.handoverDir }, { ...docs, path: w.paths.agentProfiles }, { ...profiles, path: w.paths.docs }, { ...profiles, path: path.join(w.home, 'hooks') }]) {
      expect(await store.claim(root, claimFor(TX))).toMatchObject({ ok: false, blocker: { code: 'path_unsupported' } });
    }
    expect(fs.readdirSync(w.home)).toEqual([]);
    expect(await store.claim(docs, claimFor(TX))).toMatchObject({ ok: true, kind: 'absent' });
    expect(await store.claim(profiles, claimFor(TX))).toMatchObject({ ok: true, kind: 'absent' });
    expect(fs.statSync(w.paths.docs).isDirectory() && fs.statSync(w.paths.agentProfiles).isDirectory()).toBe(true);
  });
});

describe('archiving', () => {
  // more changed files than an archive moves one by one
  const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`new/${i}.txt`, 'new']));

  async function diverged() {
    const w = world();
    const app = tree(path.join(w.work, 'app'), { 'a.txt': 'a' });
    w.store().seal(dir(app), sealAs('tx-0', await content(app)), 'source');
    tree(app, { 'a.txt': 'edited', ...many });
    return { w, app, canonical: path.join(real(w.work), 'app') };
  }

  it('moves a root aside only when the choice names it, and frees its path', async () => {
    const { w, app, canonical } = await diverged();
    const store = w.store();
    await expect(store.archive(dir(app), undefined, claimFor(TX))).rejects.toThrow(expect.objectContaining({ code: 'not_approved' }));
    await expect(store.archive(dir(app), ['r_other', path.join(w.work, 'other')], claimFor(TX))).rejects.toThrow(expect.objectContaining({ code: 'not_approved' }));
    expect(fs.readFileSync(path.join(app, 'a.txt'), 'utf8')).toBe('edited');

    expect(await store.archive(dir(app), ['r_app'], claimFor(TX))).toEqual({ path: canonical, archivedTo: `${canonical}.archived-${STAMP}` });
    expect(fs.readFileSync(`${canonical}.archived-${STAMP}/a.txt`, 'utf8')).toBe('edited');
    expect(fs.existsSync(app)).toBe(false);
    expect(fs.existsSync(w.recordFile(app))).toBe(false);
    expect(await store.claim(dir(app), claimFor(TX))).toMatchObject({ ok: true, kind: 'absent' });
    expect((await store.archive(dir(app), [app], claimFor(TX))).archivedTo).toBe(`${canonical}.archived-${STAMP}-2`);
  });

  it('moves only the files that changed aside when few did, and the root it leaves is a replica of what stays', async () => {
    const w = world();
    const app = tree(path.join(w.work, 'app'), { 'a.txt': 'a', 'b.txt': 'b', 'sub/c.txt': 'c', 'd.txt': 'd', '.git/HEAD': 'ref: refs/heads/main\n' });
    const incoming = await content(app);
    w.store().seal(dir(app), sealAs('tx-0', incoming), 'source');
    tree(app, { 'a.txt': 'edited', 'sub/new.txt': 'mine', '.DS_Store': 'finder' });
    fs.rmSync(path.join(app, 'd.txt'));
    const store = w.store();
    expect(await store.claim(dir(app), claimFor(TX, incoming))).toMatchObject({ ok: false, blocker: { code: 'destination_diverged' } });
    const canonical = path.join(real(w.work), 'app');
    expect(await store.archive(dir(app), ['r_app'], claimFor(TX, incoming))).toEqual({ path: canonical, archivedTo: `${canonical}.archived-${STAMP}` });
    expect((await content(`${canonical}.archived-${STAMP}`)).map((f) => f.path)).toEqual(['README.archived.txt', 'a.txt', 'sub/new.txt']);
    expect(fs.readFileSync(`${canonical}.archived-${STAMP}/a.txt`, 'utf8')).toBe('edited');
    // what was deleted there comes back with the copy, so the archive says so
    expect(fs.readFileSync(`${canonical}.archived-${STAMP}/README.archived.txt`, 'utf8')).toBe(
      `Archived by a Svall handover from ${canonical}, which held the files here as they are. It had deleted these, which the handover's copy brings back:\n- d.txt\n`,
    );
    expect((await content(app)).map((f) => f.path)).toEqual(['.DS_Store', '.git/HEAD', 'b.txt', 'sub/c.txt']);
    expect(await store.claim(dir(app), claimFor(TX, incoming))).toMatchObject({ ok: true, kind: 'replica' });
  });

  it('moves the whole root aside when a change lies in Git\'s records, whose objects the copy would delete', async () => {
    const w = world();
    const app = tree(path.join(w.work, 'app'), { 'a.txt': 'a', '.git/HEAD': 'ref: refs/heads/main\n', [`.git/refs/heads/main`]: `${'c'.repeat(40)}\n` });
    w.store().seal(dir(app), sealAs('tx-0', await content(app)), 'source');
    // a stash made there: its ref and log, and objects only this copy holds
    tree(app, { '.git/refs/stash': `${'e'.repeat(40)}\n`, '.git/logs/refs/stash': 'stash\n', '.git/objects/ee/eeee': 'only here' });
    const { archivedTo } = await w.store().archive(dir(app), ['r_app'], claimFor(TX));
    expect(fs.existsSync(app)).toBe(false);
    expect(fs.readFileSync(path.join(archivedTo, '.git/objects/ee/eeee'), 'utf8')).toBe('only here');
  });

  it('moves the whole root aside when a change it found cannot be read', async () => {
    const w = world();
    const app = tree(path.join(w.work, 'app'), { 'a.txt': 'a', 'b.txt': 'b' });
    w.store().seal(dir(app), sealAs('tx-0', await content(app)), 'source');
    write(app, 'locked.txt', 'mine');
    fs.chmodSync(path.join(app, 'locked.txt'), 0);
    const { archivedTo } = await w.store().archive(dir(app), ['r_app'], claimFor(TX));
    expect(fs.existsSync(app)).toBe(false);
    expect(fs.readdirSync(archivedTo).sort()).toEqual(['a.txt', 'b.txt', 'locked.txt']);
    fs.chmodSync(path.join(archivedTo, 'locked.txt'), 0o600);
  });

  it('moves the whole root aside when a change it found cannot be moved alone', async () => {
    const w = world();
    const commit = 'c'.repeat(40);
    const app = tree(path.join(w.work, 'app'), { 'a.txt': 'a', '.git/HEAD': 'ref: refs/heads/main\n', '.git/packed-refs': `${commit} refs/heads/main\n` });
    w.store().seal(dir(app), sealAs('tx-0', await content(app)), 'source');
    // a branch moved inside packed-refs is a change to a ref, which is no file of its own
    write(app, '.git/packed-refs', `${'d'.repeat(40)} refs/heads/main\n`);
    const { archivedTo } = await w.store().archive(dir(app), ['r_app'], claimFor(TX));
    expect(fs.existsSync(app)).toBe(false);
    expect(fs.readFileSync(path.join(archivedTo, 'a.txt'), 'utf8')).toBe('a');
  });

  it('never replaces a sibling that holds the name already, or takes it first', async () => {
    const { w, app, canonical } = await diverged();
    tree(`${canonical}.archived-${STAMP}`, { 'older.txt': 'older' });
    write(w.work, `app.archived-${STAMP}-2`, 'a file');
    const store = w.store({
      fs: {
        mkdir: (p, recursive) => {
          if (p.endsWith('-3')) tree(p, { 'racer.txt': 'racer' });
          realReplicaFs.mkdir(p, recursive);
        },
      },
    });
    expect((await store.archive(dir(app), [canonical], claimFor(TX))).archivedTo).toBe(`${canonical}.archived-${STAMP}-4`);
    expect(fs.readFileSync(`${canonical}.archived-${STAMP}/older.txt`, 'utf8')).toBe('older');
    expect(fs.readFileSync(`${canonical}.archived-${STAMP}-2`, 'utf8')).toBe('a file');
    expect(fs.readdirSync(`${canonical}.archived-${STAMP}-3`)).toEqual(['racer.txt']);
    expect(fs.readFileSync(`${canonical}.archived-${STAMP}-4/a.txt`, 'utf8')).toBe('edited');
  });

  it('sets an archived linked worktree\'s .git file aside, so git there leaves the live worktree alone, and says which it was', async () => {
    const w = world();
    const common = path.join(real(w.work), 'main/.git');
    const commit = 'c'.repeat(40);
    tree(common, { 'worktrees/wt/HEAD': 'ref: refs/heads/feat\n', 'worktrees/wt/commondir': '../..\n', 'packed-refs': `# pack-refs with: peeled\n${commit} refs/heads/feat\n` });
    const app = tree(path.join(w.work, 'wt'), { 'a.txt': 'a', '.git': `gitdir: ${common}/worktrees/wt\n` });
    w.store().seal(dir(app), sealAs('tx-0', await content(app)), 'source');
    tree(app, { 'a.txt': 'edited', ...many });
    const { archivedTo } = await w.store().archive(dir(app), ['r_app'], claimFor(TX));
    expect(fs.readFileSync(path.join(archivedTo, '.git'), 'utf8')).toBe('gitdir: /nonexistent\n');
    expect(fs.readFileSync(path.join(archivedTo, '.git.archived'), 'utf8')).toBe(`gitdir: ${common}/worktrees/wt\n`);
    expect(fs.readFileSync(path.join(archivedTo, 'README.archived.txt'), 'utf8')).toBe(
      `Archived by a Svall handover from ${path.join(real(w.work), 'wt')}. Each .git file here that named a Git directory outside this folder is kept as .git.archived beside a .git that names no repository, so git there leaves the live repository alone:\n- . was the linked worktree on branch feat at ${commit}\n`,
    );
    expect(fs.readFileSync(path.join(common, 'worktrees/wt/HEAD'), 'utf8')).toBe('ref: refs/heads/feat\n');

    // a detached one is named by its commit, and a main checkout's own .git folder stays as it is
    fs.writeFileSync(path.join(common, 'worktrees/wt/HEAD'), `${commit}\n`);
    const again = tree(path.join(w.work, 'wt'), { '.git': 'gitdir: ../main/.git/worktrees/wt\n' });
    w.store().seal(dir(again), sealAs('tx-1', []), 'source');
    const detached = (await w.store().archive(dir(again), ['r_app'], claimFor(TX))).archivedTo;
    expect(fs.readFileSync(path.join(detached, 'README.archived.txt'), 'utf8')).toContain('\n- . was the linked worktree detached at cccc');
    const main = tree(path.join(w.work, 'main'), { 'b.txt': 'b' });
    w.store().seal(dir(main, 'r_main'), sealAs('tx-2', []), 'source');
    const kept = (await w.store().archive(dir(main, 'r_main'), ['r_main'], claimFor(TX))).archivedTo;
    expect(fs.statSync(path.join(kept, '.git')).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(kept, 'README.archived.txt'))).toBe(false);
  });

  it('leaves the .git file of a worktree a registration places in it through a link, which lies outside the archive', async () => {
    const w = world();
    const main = path.join(real(w.work), 'main');
    const outside = path.join(real(w.work), 'outside');
    const gitfile = `gitdir: ${main}/.git/worktrees/x\n`;
    tree(main, { 'a.txt': 'a', '.git/worktrees/x/gitdir': `${main}/.claude/worktrees/x/.git\n`, '.git/worktrees/x/commondir': '../..\n' });
    tree(outside, { 'worktrees/x/.git': gitfile });
    fs.symlinkSync(outside, path.join(main, '.claude'));
    w.store().seal(dir(main, 'r_main'), sealAs('tx-0', []), 'source');
    await w.store().archive(dir(main, 'r_main'), ['r_main'], claimFor(TX));
    expect(fs.readFileSync(path.join(outside, 'worktrees/x/.git'), 'utf8')).toBe(gitfile);
    expect(fs.existsSync(path.join(outside, 'worktrees/x/.git.archived'))).toBe(false);
  });

  it('looks for .git files as a scan does, past a name that is not valid UTF-8, and into no excluded folder', async () => {
    const w = world();
    const dep = 'gitdir: ../../../main/.git/modules/dep\n';
    const app = tree(path.join(w.work, 'wt'), {
      '.git': 'gitdir: ../main/.git/worktrees/wt\n', 'sub/.git': 'gitdir: ../../main/.git/worktrees/wt/modules/sub\n', 'node_modules/dep/.git': dep,
    });
    const listed: string[] = [];
    const scanFs: ScanFs = { ...realScanFs, readdir: async (p) => { listed.push(p); return [...await realScanFs.readdir(p), Buffer.from([0xff])]; } };
    const { archivedTo } = await w.store({ scanFs }).archive(dir(app), ['r_app'], claimFor(TX));
    for (const rel of ['.git', 'sub/.git']) expect(fs.readFileSync(path.join(archivedTo, rel), 'utf8')).toBe('gitdir: /nonexistent\n');
    expect(fs.readFileSync(path.join(archivedTo, 'node_modules/dep/.git'), 'utf8')).toBe(dep);
    expect(listed).toEqual([archivedTo, path.join(archivedTo, 'sub')]);
  });

  it.skipIf(process.getuid?.() === 0)('sets the .git files aside past a folder or a .git file this account cannot read, which its git cannot enter either', async () => {
    const w = world();
    const app = tree(path.join(w.work, 'wt'), { '.git': 'gitdir: ../main/.git/worktrees/wt\n', 'pgdata/base/1': 'x', 'locked/.git': 'gitdir: ../../main/.git/worktrees/wt/modules/locked\n' });
    const modes = (at: string, folder: number, file: number): void => {
      if (!fs.existsSync(at)) return;
      fs.chmodSync(path.join(at, 'pgdata'), folder);
      fs.chmodSync(path.join(at, 'locked/.git'), file);
    };
    modes(app, 0, 0);
    try {
      const { archivedTo } = await w.store().archive(dir(app), ['r_app'], claimFor(TX));
      expect(fs.readFileSync(path.join(archivedTo, '.git'), 'utf8')).toBe('gitdir: /nonexistent\n');
      expect(fs.readFileSync(path.join(archivedTo, 'README.archived.txt'), 'utf8')).toMatch(/:\n- \. was [^\n]*\n$/);
    } finally {
      for (const at of [app, `${real(w.work)}/wt.archived-${STAMP}`]) modes(at, 0o755, 0o644);
    }
  });

  it.skipIf(!hasGit)('sets aside the .git file of each linked worktree a main checkout archived whole holds, and git in any archived worktree finds no repository (needs git)', async () => {
    const w = world();
    const run = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    run(w.work, 'init', '-q', '-b', 'outer');
    const repo = tree(path.join(w.work, 'repo'), { 'a.txt': 'a' });
    run(repo, 'init', '-q', '-b', 'main');
    run(repo, 'add', 'a.txt');
    run(repo, 'commit', '-qm', 'init');
    run(repo, 'worktree', 'add', '-q', '.claude/worktrees/x', '-b', 'x');
    run(repo, 'worktree', 'add', '-q', path.join(w.work, 'wt'), '-b', 'wt');
    const commit = run(repo, 'rev-parse', 'HEAD');
    const archived = async (p: string, id: string): Promise<string> => {
      w.store().seal(dir(p, id), sealAs('tx-0', []), 'source');
      return (await w.store().archive(dir(p, id), [id], claimFor(TX))).archivedTo;
    };

    const main = await archived(repo, 'r_repo');
    const nested = path.join(main, '.claude/worktrees/x');
    expect(fs.readFileSync(path.join(nested, '.git'), 'utf8')).toBe('gitdir: /nonexistent\n');
    expect(fs.readFileSync(path.join(nested, '.git.archived'), 'utf8')).toMatch(/^gitdir: .*\/repo\/\.git\/worktrees\/x\n$/);
    expect(fs.readFileSync(path.join(main, 'README.archived.txt'), 'utf8')).toContain(`\n- .claude/worktrees/x was the linked worktree on branch x at ${commit}\n`);
    expect(fs.statSync(path.join(main, '.git')).isDirectory()).toBe(true);
    // once the copy brings the live registration back, git in the archived worktree still finds no repository
    fs.cpSync(path.join(main, '.git'), path.join(repo, '.git'), { recursive: true });
    expect(() => run(nested, 'status')).toThrow();

    const linked = await archived(path.join(w.work, 'wt'), 'r_wt');
    expect(() => run(linked, 'rev-parse', '--show-toplevel')).toThrow();
  }, 60_000);

  it.skipIf(!hasGit)('sets aside the .git file of an archived linked worktree\'s submodule, whose Git directory the live registration holds, and keeps one whose Git directory the archive holds (needs git)', async () => {
    const w = world();
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const run = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const work = real(w.work);
    const lib = tree(path.join(work, 'lib'), { 'lib.txt': 'lib' });
    run(lib, 'init', '-q', '-b', 'main');
    run(lib, 'add', 'lib.txt');
    run(lib, 'commit', '-qm', 'lib');
    const main = tree(path.join(work, 'main'), { 'a.txt': 'a' });
    run(main, 'init', '-q', '-b', 'main');
    run(main, 'add', 'a.txt');
    run(main, 'submodule', 'add', '-q', lib, 'sub');
    run(main, 'commit', '-qm', 'init');
    const wt = path.join(work, 'wt');
    run(main, 'worktree', 'add', '-q', wt, '-b', 'wt');
    run(wt, 'submodule', 'update', '-q', '--init');
    const commits = { wt: run(wt, 'rev-parse', 'HEAD'), sub: run(path.join(wt, 'sub'), 'rev-parse', 'HEAD') };
    // each root as the copy brings it back after the archive moved it aside
    const archived = async (p: string, id: string): Promise<string> => {
      const pristine = path.join(w.base, `pristine-${id}`);
      fs.cpSync(p, pristine, { recursive: true });
      w.store().seal(dir(p, id), sealAs('tx-0', []), 'source');
      const to = (await w.store().archive(dir(p, id), [id], claimFor(TX))).archivedTo;
      fs.cpSync(pristine, p, { recursive: true });
      return to;
    };

    const linked = await archived(wt, 'r_wt');
    expect(run(path.join(wt, 'sub'), 'rev-parse', '--show-toplevel')).toBe(path.join(wt, 'sub'));
    expect(() => run(path.join(linked, 'sub'), 'rev-parse', '--show-toplevel')).toThrow();
    expect(fs.readFileSync(path.join(linked, 'sub/.git'), 'utf8')).toBe('gitdir: /nonexistent\n');
    expect(fs.readFileSync(path.join(linked, 'sub/.git.archived'), 'utf8')).toBe('gitdir: ../../main/.git/worktrees/wt/modules/sub\n');
    expect(fs.readFileSync(path.join(linked, 'README.archived.txt'), 'utf8')).toBe(
      `Archived by a Svall handover from ${wt}. Each .git file here that named a Git directory outside this folder is kept as .git.archived beside a .git that names no repository, so git there leaves the live repository alone:\n`
      + `- . was the linked worktree on branch wt at ${commits.wt}\n- sub was the checkout of ${main}/.git/worktrees/wt/modules/sub, detached at ${commits.sub}\n`,
    );

    // a main checkout's submodule keeps its Git directory in the archive, which git there reads as it is
    const whole = await archived(main, 'r_main');
    expect(run(path.join(whole, 'sub'), 'rev-parse', '--show-toplevel')).toBe(path.join(whole, 'sub'));
    expect(fs.existsSync(path.join(whole, 'sub/.git.archived'))).toBe(false);
    expect(fs.existsSync(path.join(whole, 'README.archived.txt'))).toBe(false);
  }, 60_000);

  it.skipIf(!hasGit)('sets aside the .git file of a linked worktree an archived main checkout registers in a folder the handover excludes (needs git)', async () => {
    const w = world();
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const run = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const repo = tree(path.join(real(w.work), 'repo'), { 'a.txt': 'a' });
    run(repo, 'init', '-q', '-b', 'main');
    run(repo, 'add', 'a.txt');
    run(repo, 'commit', '-qm', 'init');
    run(repo, 'worktree', 'add', '-q', '.claude/worktrees/x', '-b', 'x');
    const commit = run(repo, 'rev-parse', 'HEAD');
    const pristine = path.join(w.base, 'pristine');
    fs.cpSync(repo, pristine, { recursive: true });
    w.store().seal(dir(repo, 'r_repo'), sealAs('tx-0', []), 'source');
    const { archivedTo } = await w.store().archive(dir(repo, 'r_repo'), ['r_repo'], { ...claimFor(TX), excludes: [...EXCLUDES, '.claude/worktrees/'] });
    // the copy brings the live registration back
    fs.cpSync(pristine, repo, { recursive: true });
    const x = path.join(archivedTo, '.claude/worktrees/x');
    expect(() => run(x, 'rev-parse', '--show-toplevel')).toThrow();
    expect(fs.readFileSync(path.join(x, '.git'), 'utf8')).toBe('gitdir: /nonexistent\n');
    expect(fs.readFileSync(path.join(archivedTo, 'README.archived.txt'), 'utf8')).toContain(`\n- .claude/worktrees/x was the linked worktree on branch x at ${commit}\n`);
  }, 60_000);

  it('moves a file root aside without replacing a file already there', async () => {
    const w = world();
    const note = path.join(w.work, 'todo.md');
    fs.writeFileSync(note, 'mine');
    fs.writeFileSync(`${real(w.work)}/todo.md.archived-${STAMP}`, 'older');
    const root: ReplicaRoot = { id: 'r_note', kind: 'context', entry: 'file', path: note };
    const { archivedTo } = await w.store().archive(root, ['r_note'], claimFor(TX));
    expect(archivedTo).toBe(`${real(w.work)}/todo.md.archived-${STAMP}-2`);
    expect(fs.readFileSync(archivedTo, 'utf8')).toBe('mine');
    expect(fs.readFileSync(`${real(w.work)}/todo.md.archived-${STAMP}`, 'utf8')).toBe('older');
    expect(fs.existsSync(note)).toBe(false);
  });

  it('refuses to move the fleet home or anything holding it', async () => {
    const w = world();
    await expect(w.store().archive(dir(w.base, 'r_base'), ['r_base'], claimFor(TX))).rejects.toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(fs.existsSync(w.home)).toBe(true);
  });
});
