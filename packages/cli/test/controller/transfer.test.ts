import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Blocker, TransferFile } from '@svall/protocol';
import { DEFAULT_EXCLUDES, excludeMatcher, rootMatcher } from '@svall/svalld/handover/inventory';
import { scanPath } from '../../../svalld/src/handover/manifest.js';
import { runProcess } from '../../src/controller/process.js';
import { ProgressJournal, transactionDir, type EntryProgress } from '../../src/controller/progress.js';
import { bundledRsync, filterRules, probeRsync, rsyncArgv, runRsync, type RunRsync } from '../../src/controller/rsync.js';
import { SshMaster } from '../../src/controller/ssh.js';
import { transfer, type Master, type Roles, type RootEntry, type SessionEntry, type TransferOptions } from '../../src/controller/transfer.js';
import { installFakeSsh, type FakeSsh } from './fake-ssh.js';

const RSYNC = process.env.SVALL_TEST_RSYNC ?? bundledRsync();
const probe = await probeRsync(RSYNC);
const noRsync = probe.ok ? undefined : `no rsync 3 at ${RSYNC}: build it with scripts/build-controller.mjs or set SVALL_TEST_RSYNC`;
// CI sets SVALL_REQUIRE_RSYNC, and there a missing rsync fails the file instead of skipping what needs it
if (noRsync && process.env.SVALL_REQUIRE_RSYNC) throw new Error(noRsync);

const PUSH: Roles = { source: 'local', destination: 'remote' };
const PULL: Roles = { source: 'remote', destination: 'local' };
const EXCLUDES = [...DEFAULT_EXCLUDES];

const temps: string[] = [];
const tmp = (prefix = 'svall-xfer-'): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};
afterEach(() => { for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function tree(root: string, files: Record<string, string>): string {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const scan = async (at: string, excludes: readonly string[] = EXCLUDES): Promise<TransferFile[]> =>
  (await scanPath(at, excludeMatcher(excludes)))?.files ?? [];

// what a copy has to reproduce: content, mode and link text, whatever the clock says
const content = (files: readonly TransferFile[]) => files.map((f) => (f.type === 'file' ? { path: f.path, sha256: f.sha256, mode: f.mode } : f));

/** A root as Task 27 hands it over: the manifest's scan of `scanned`, and an ok claim at `claimed`. */
async function root(o: { id?: string; source: string; claimed: string; scanned?: string; excludes?: string[] }): Promise<RootEntry> {
  const excludes = o.excludes ?? EXCLUDES;
  return {
    kind: 'root', id: o.id ?? 'r_app', rootKind: 'repo', entry: 'dir', path: o.source,
    claim: { excludes, check: { ok: true, path: o.claimed, kind: 'replica' } },
    files: await scan(o.scanned ?? o.source, excludes),
  };
}

/** A session as Task 27 hands it over: the files under `home` the manifest scanned, each by its path there, to go into `stage`. */
async function session(o: { id?: string; home: string; stage: string; files: string[] }): Promise<SessionEntry> {
  const files: TransferFile[] = [];
  for (const p of o.files) files.push(...(await scan(path.join(o.home, p), [])).map((f) => ({ ...f, path: p })));
  return { kind: 'session', id: o.id ?? 's0', sourceHome: o.home, stage: o.stage, files };
}

type Answer = { lines?: string[]; code?: number; stderr?: string; hang?: boolean };

/** An rsync that answers from a script: `dry` for the verification compare, `real` for a copy. */
function fakeRsync(answer: (argv: string[], n: { real: number; dry: number }) => Answer = () => ({})) {
  const calls: string[][] = [];
  const n = { real: 0, dry: 0 };
  const run: RunRsync = async (_exe, argv, o) => {
    calls.push(argv);
    if (argv.includes('--dry-run')) n.dry++; else n.real++;
    const a = answer(argv, n);
    for (const line of a.lines ?? []) o.onLine(line);
    if (a.hang) {
      await new Promise<void>((resolve) => {
        if (o.signal?.aborted) resolve();
        o.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { code: null, signal: 'SIGTERM', stderr: '' };
    }
    return { code: a.code ?? 0, signal: null, stderr: a.stderr ?? '' };
  };
  return { run, calls, real: () => calls.filter((c) => !c.includes('--dry-run')), dry: () => calls.filter((c) => c.includes('--dry-run')) };
}

const readJournal = (stateDir: string, tx = 'tx-1') =>
  JSON.parse(fs.readFileSync(path.join(transactionDir(tx, stateDir), 'progress.json'), 'utf8')) as { entries: Record<string, EntryProgress> };

const RSYNC_327 = 'rsync  version 3.2.7  protocol version 31\n';

/** A master that answers the far `rsync --version`, and says whether it is still up. */
function fakeMaster(o: { answer?: { code: number; stdout?: string; stderr?: string }; up?: boolean } = {}): Master & { calls: string[][] } {
  const calls: string[][] = [];
  const answer = o.answer ?? { code: 0, stdout: RSYNC_327 };
  return {
    socket: '/tmp/svall-test/sock',
    calls,
    run: async (argv) => {
      calls.push(argv);
      return { code: answer.code, signal: null, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', truncated: false };
    },
    check: async () => o.up ?? true,
  };
}

const options = (o: Partial<TransferOptions> & Pick<TransferOptions, 'entries' | 'stateDir'>): TransferOptions => ({
  transactionId: 'tx-1', roles: PUSH, master: fakeMaster(), rsync: '/opt/rsync', ...o,
});

const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

describe('transfer with a scripted rsync', () => {
  it('writes a root only where its claim says, with --delete and its claim\'s excludes, and a session\'s listed files with neither', async () => {
    const src = tree(tmp(), { 'a.txt': 'a', 'node_modules/x.js': 'x' });
    const home = tree(tmp(), { 'projects/-app/s.jsonl': '{}', 'projects/-app/s/subagents/a.jsonl': '{}', 'projects/-app/other.jsonl': 'not this one' });
    const state = tmp();
    const excludes = [...EXCLUDES, '*.log'];
    const rsync = fakeRsync();
    const master = fakeMaster();
    const app = await root({ source: src, claimed: '/far/claimed/app', excludes });
    const s0 = await session({ home, stage: '/far/stage/0', files: ['projects/-app/s.jsonl', 'projects/-app/s/subagents/a.jsonl'] });
    const r = await transfer(options({ entries: [app, s0], master, stateDir: state, deps: { run: rsync.run } }));

    // each entry comes back with what landed: here the source as the manifest scanned it
    expect(r).toEqual({
      status: 'verified', blockers: [],
      entries: [{ id: 'r_app', status: 'verified', passes: 1, files: app.files }, { id: 's0', status: 'verified', passes: 1, files: s0.files }],
    });
    // the far rsync is asked for its version once, whatever the number of entries
    expect(master.calls).toEqual([['rsync', '--version']]);
    // one copy and one checksum compare a session, whatever its number of files
    expect(rsync.real()).toHaveLength(2);
    const [rootCopy, sessionCopy] = rsync.real();
    expect(rootCopy.slice(-2)).toEqual([`${src}/`, 'svall-remote.invalid:/far/claimed/app/']);
    expect(rootCopy).toContain('--delete');
    const filter = rootCopy.find((a) => a.startsWith('--exclude-from='))?.slice('--exclude-from='.length) as string;
    expect(path.dirname(path.dirname(filter))).toBe(transactionDir('tx-1', state));
    expect(fs.readFileSync(filter, 'utf8')).toBe(filterRules(excludes));
    expect(fs.statSync(filter).mode & 0o777).toBe(0o600);
    expect(sessionCopy.slice(-2)).toEqual([`${home}/`, 'svall-remote.invalid:/far/stage/0/']);
    expect(sessionCopy).toContain('--mkpath');
    expect(sessionCopy).toContain('--from0');
    const list = sessionCopy.find((a) => a.startsWith('--files-from='))?.slice('--files-from='.length) as string;
    expect(fs.readFileSync(list, 'utf8')).toBe('projects/-app/s.jsonl\0projects/-app/s/subagents/a.jsonl\0');
    expect(sessionCopy.some((a) => a.startsWith('--delete') || a.startsWith('--exclude'))).toBe(false);
    for (const call of rsync.calls) {
      expect(call).not.toContain('--delete-excluded');
    }
    // each copy is verified with the same arguments, as a checksum dry run
    expect(rsync.dry().map((c) => c.filter((a) => a !== '--dry-run' && a !== '--checksum'))).toEqual(rsync.real().map((c) => c.filter((a) => a !== '--info=progress2')));
    // what a claim asked again takes: a root's verified files, and nothing of a session's
    const journal = new ProgressJournal('tx-1', transactionDir('tx-1', state));
    expect([journal.verified('r_app'), journal.verified('s0')]).toEqual([app.files, undefined]);
  });

  it('keeps Git\'s own entries in a Git directory carried on its own, in its filter and in what it reads, whatever the excludes say', async () => {
    const gitdir = tree(tmp(), { HEAD: 'ref: refs/heads/main\n', 'logs/HEAD': 'log', 'objects/ab/cd': 'o', 'build/out.o': 'built' });
    const state = tmp();
    const excludes = [...EXCLUDES, 'logs/'];
    const rsync = fakeRsync();
    const files = (await scanPath(gitdir, rootMatcher('gitdir', excludes)))!.files;
    expect(files.map((f) => f.path).sort()).toEqual(['HEAD', 'logs/HEAD', 'objects/ab/cd']);
    const entry: RootEntry = {
      kind: 'root', id: 'r_git', rootKind: 'gitdir', entry: 'dir', path: gitdir,
      claim: { excludes, check: { ok: true, path: '/far/app.git', kind: 'absent' } }, files,
    };
    const r = await transfer(options({ entries: [entry], stateDir: state, deps: { run: rsync.run } }));
    expect(r.entries).toEqual([{ id: 'r_git', status: 'verified', passes: 1, files }]);
    const filter = rsync.real()[0].find((a) => a.startsWith('--exclude-from='))!.slice('--exclude-from='.length);
    expect(fs.readFileSync(filter, 'utf8')).toBe(filterRules(excludes, 'gitdir'));
  });

  it('pulls into the claimed local copy, and reads that copy against the manifest', async () => {
    const copy = tree(tmp(), { 'a.txt': 'a' });
    const state = tmp();
    const rsync = fakeRsync();
    const entry = await root({ source: '/far/app [1]', claimed: copy, scanned: copy });
    const r = await transfer(options({ roles: PULL, entries: [entry], stateDir: state, deps: { run: rsync.run } }));
    expect(r.status).toBe('verified');
    expect(rsync.real()[0].slice(-2)).toEqual(['svall-remote.invalid:/far/app \\[1]/', `${copy}/`]);
  });

  it('never writes a root the destination did not claim, and goes on with the rest', async () => {
    const src = tree(tmp(), { 'a.txt': 'a' });
    const state = tmp();
    const rsync = fakeRsync();
    const blocker: Blocker = { code: 'destination_occupied', message: '/far/app already exists and no handover left it there', entity: { kind: 'root', id: 'r_app' } };
    const refused: RootEntry = { ...(await root({ source: src, claimed: '/far/app' })), claim: { excludes: EXCLUDES, check: { ok: false, path: '/far/app', blocker } } };
    const other = await root({ id: 'r_other', source: src, claimed: '/far/other' });
    const r = await transfer(options({ entries: [refused, other], stateDir: state, deps: { run: rsync.run } }));
    expect(r).toMatchObject({ status: 'blocked', blockers: [blocker], entries: [{ id: 'r_app', status: 'blocked', blocker }, { id: 'r_other', status: 'verified' }] });
    expect(rsync.calls.every((c) => !c.join(' ').includes('/far/app'))).toBe(true);
    expect(readJournal(state).entries.r_app).toMatchObject({ state: 'blocked' });
  });

  it('refuses a far path rsync would expand when nothing may be there yet, and a path that is not plain', async () => {
    const home = tree(tmp(), { 's.jsonl': '{}' });
    const state = tmp();
    const rsync = fakeRsync();
    const entries = [
      await session({ id: 's0', home, stage: '/far/stage[1]/0', files: ['s.jsonl'] }),
      await session({ id: 's1', home, stage: '/far/../etc/1', files: ['s.jsonl'] }),
    ];
    const r = await transfer(options({ entries, stateDir: state, deps: { run: rsync.run } }));
    expect(r.entries).toEqual([
      { id: 's0', status: 'failed', reason: 'refused', code: null, error: expect.stringMatching(/stage\[1\].*wildcard/) },
      { id: 's1', status: 'failed', reason: 'refused', code: null, error: expect.stringMatching(/not a plain absolute path/) },
    ]);
    expect(rsync.calls).toEqual([]);
  });

  it('refuses a session file whose name climbs out of its agent home on a pull, before a path is built from it', async () => {
    const stage = tmp();
    const state = tmp();
    const rsync = fakeRsync();
    const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
    const climb: SessionEntry = {
      kind: 'session', id: 's0', sourceHome: '/far/home/.claude', stage,
      files: [{ type: 'file', path: '../../../../.zshrc', mode: 0o644, size: 1, mtimeMs: 0, sha256: sha('x') }],
    };
    const r = await transfer(options({ roles: PULL, entries: [climb], stateDir: state, deps: { run: rsync.run } }));
    expect(r).toMatchObject({ status: 'failed', entries: [{ id: 's0', status: 'failed', reason: 'refused', error: expect.stringContaining('"../../../../.zshrc" is not a plain relative path') }] });
    expect(rsync.calls).toEqual([]);
  });

  it('tells a watcher of each new state and of an entry\'s counts at most once a second, and never of an item line alone', async () => {
    const src = tree(tmp(), { 'a.txt': 'a' });
    let now = 0;
    const events: EntryProgress[] = [];
    // a second passes every ten lines
    const run: RunRsync = async (_exe, argv, o) => {
      if (!argv.includes('--dry-run')) {
        for (let i = 0; i < 1000; i++) o.onLine(`<f+++++++++ f${i}.txt`);
        for (let i = 1; i <= 30; i++) { now += 100; o.onLine(`          ${i}  50%    0.00kB/s    0:00:00 (xfr#${i}, to-chk=${30 - i}/30)`); }
      }
      return { code: 0, signal: null, stderr: '' };
    };
    const r = await transfer(options({ entries: [await root({ source: src, claimed: '/far/app' })], stateDir: tmp(), onProgress: (p) => events.push(p), deps: { run, now: () => now } }));
    expect(r.status).toBe('verified');
    expect(events.map((e) => e.state)).toEqual(['transferring', 'transferring', 'transferring', 'transferring', 'verifying', 'verified']);
    expect(events.filter((e) => e.state === 'transferring').map((e) => e.bytes)).toEqual([0, 10, 20, 30]);
  });

  it('tells a watcher of a 50,000-file copy as often as of a one-file copy: once per state and second', async () => {
    const src = tree(tmp(), { 'a.txt': 'a' });
    let now = 0;
    const events: EntryProgress[] = [];
    const FILES = 50_000;
    // five seconds of an rsync that itemizes and reports every file
    const run: RunRsync = async (_exe, argv, o) => {
      if (!argv.includes('--dry-run')) {
        for (let i = 1; i <= FILES; i++) {
          o.onLine(`<f+++++++++ src/f${i}.ts`);
          o.onLine(`        ${i * 1000}  50%    1.00MB/s    0:00:01 (xfr#${i}, to-chk=${FILES - i}/${FILES})`);
          now += 5000 / FILES;
        }
      }
      return { code: 0, signal: null, stderr: '' };
    };
    const r = await transfer(options({ entries: [await root({ source: src, claimed: '/far/app' })], stateDir: tmp(), onProgress: (p) => events.push(p), deps: { run, now: () => now } }));
    expect(r.status).toBe('verified');
    expect(events.length).toBeLessThanOrEqual(3 + 6);
  });

  it('refuses a far rsync that is missing, too old or openrsync before it copies anything', async () => {
    const src = tree(tmp(), { 'a.txt': 'a' });
    const entries = [await root({ source: src, claimed: '/far/app' }), await root({ id: 'r_next', source: src, claimed: '/far/next' })];
    const cases = [
      [{ code: 127, stderr: 'sh: 1: rsync: not found\n' }, /no rsync.*3\.2\.3 or newer/],
      [{ code: 0, stdout: 'rsync  version 3.1.3  protocol version 31\n' }, /3\.1\.3.*3\.2\.3 or newer/],
      [{ code: 0, stdout: 'openrsync: protocol version 29\nrsync version 2.6.9 compatible\n' }, /openrsync/],
    ] as const;
    for (const [answer, message] of cases) {
      const rsync = fakeRsync();
      const r = await transfer(options({ entries, master: fakeMaster({ answer }), stateDir: tmp(), deps: { run: rsync.run } }));
      expect(r).toEqual({
        status: 'blocked',
        blockers: [{ code: 'rsync_unsupported', message: expect.stringMatching(message) }],
        entries: [{ id: 'r_app', status: 'pending' }, { id: 'r_next', status: 'pending' }],
      });
      expect(rsync.calls).toEqual([]);
    }
  });

  it('stops before copying when the far rsync cannot be asked over a dead link', async () => {
    const src = tree(tmp(), { 'a.txt': 'a' });
    const rsync = fakeRsync();
    const master = fakeMaster({ answer: { code: 255, stderr: 'Control socket connect(/tmp/svall-test/sock): No such file or directory\n' }, up: false });
    const r = await transfer(options({ entries: [await root({ source: src, claimed: '/far/app' })], master, stateDir: tmp(), deps: { run: rsync.run } }));
    expect(r).toEqual({
      status: 'failed', blockers: [], entries: [{ id: 'r_app', status: 'pending' }],
      failure: { reason: 'disconnected', code: 255, error: expect.stringContaining('No such file or directory') },
    });
    expect(rsync.calls).toEqual([]);
  });

  it('fails on a partial exit, and keeps its code and progress for a resume', async () => {
    const src = tree(tmp(), { 'a.txt': 'a', 'b.txt': 'b' });
    const state = tmp();
    const rsync = fakeRsync((_argv, n) => (n.real === 1
      ? { lines: ['<f+++++++++ a.txt', '          1  50%    0.00kB/s    0:00:00 (xfr#1, to-chk=1/3)'], code: 23, stderr: 'rsync: [sender] send_files failed to open "b.txt": Permission denied (13)\nrsync error: some files/attrs were not transferred (code 23)\n' }
      : {}));
    const entries = [await root({ source: src, claimed: '/far/app' }), await root({ id: 'r_next', source: src, claimed: '/far/next' })];
    const r = await transfer(options({ entries, stateDir: state, deps: { run: rsync.run } }));
    expect(r.status).toBe('failed');
    expect(r.entries).toEqual([
      { id: 'r_app', status: 'failed', reason: 'rsync', code: 23, error: expect.stringContaining('Permission denied') },
      { id: 'r_next', status: 'pending' },
    ]);
    // a warning-only exit is not a finished copy: nothing was verified
    expect(rsync.dry()).toEqual([]);
    const journal = readJournal(state);
    expect(journal.entries.r_app).toMatchObject({ state: 'failed', pass: 1, exitCode: 23, items: 1, bytes: 1, done: 2, total: 3 });
    expect(journal.entries.r_app.verifiedKey).toBeUndefined();
    expect(journal.entries.r_next).toBeUndefined();
    expect(fs.statSync(path.join(transactionDir('tx-1', state), 'progress.json')).mode & 0o777).toBe(0o600);
  });

  it('does not take a clean exit for a finished copy until the checksum compare agrees', async () => {
    const src = tree(tmp(), { 'a.txt': 'a' });
    const state = tmp();
    const rsync = fakeRsync((argv, n) => (argv.includes('--dry-run') && n.dry === 1 ? { lines: ['>fcs....... a.txt'] } : { stderr: 'rsync: some warning\n' }));
    const r = await transfer(options({ entries: [await root({ source: src, claimed: '/far/app' })], stateDir: state, deps: { run: rsync.run } }));
    expect(r.entries).toMatchObject([{ id: 'r_app', status: 'verified', passes: 2 }]);
    // size and whole seconds decide the first copy; a copy the compare found wanting is redone by content
    expect(rsync.real().map((c) => c.includes('--checksum'))).toEqual([false, true]);
  });

  it('never takes a checksum compare that failed, having itemized nothing, for agreement', async () => {
    const src = tree(tmp(), { 'a.txt': 'a' });
    for (const code of [12, 23]) {
      const state = tmp();
      const rsync = fakeRsync((argv) => (argv.includes('--dry-run') ? { code, stderr: `rsync error: code ${code}\n` } : {}));
      const r = await transfer(options({ entries: [await root({ source: src, claimed: '/far/app' })], master: fakeMaster({ up: true }), stateDir: state, deps: { run: rsync.run } }));
      expect(r.entries).toEqual([{ id: 'r_app', status: 'failed', reason: 'rsync', code, error: expect.stringContaining(`code ${code}`) }]);
      expect(readJournal(state).entries.r_app.verifiedKey).toBeUndefined();
    }
  });

  it('reads an exit of 12 or 255 as a lost link only when the master is gone, and a resume copies again', async () => {
    const src = tree(tmp(), { 'a.txt': 'a' });
    const entries = [await root({ source: src, claimed: '/far/app' }), await root({ id: 'r_next', source: src, claimed: '/far/next' })];
    const closed = { code: 12, stderr: 'rsync: connection unexpectedly closed (0 bytes received so far) [sender]\n' };
    // the master still answers: whatever closed the stream, it was not the link
    const up = await transfer(options({ entries, master: fakeMaster({ up: true }), stateDir: tmp(), deps: { run: fakeRsync(() => closed).run } }));
    expect(up.entries).toEqual([
      { id: 'r_app', status: 'failed', reason: 'rsync', code: 12, error: expect.stringContaining('connection unexpectedly closed') },
      { id: 'r_next', status: 'pending' },
    ]);

    const state = tmp();
    const down = await transfer(options({ entries, master: fakeMaster({ up: false }), stateDir: state, deps: { run: fakeRsync(() => ({ ...closed, code: 255 })).run } }));
    expect(down.entries).toEqual([
      { id: 'r_app', status: 'failed', reason: 'disconnected', code: 255, error: expect.stringContaining('connection unexpectedly closed') },
      { id: 'r_next', status: 'pending' },
    ]);
    const again = fakeRsync();
    const second = await transfer(options({ entries, stateDir: state, deps: { run: again.run } }));
    expect(second.status).toBe('verified');
    expect(again.real()).toHaveLength(2);
  });

  it('on resume skips the copy only for a root whose verification still holds', async () => {
    const src = tree(tmp(), { 'a.txt': 'a' });
    const state = tmp();
    const entries = [await root({ source: src, claimed: '/far/app' }), await root({ id: 'r_moved', source: src, claimed: '/far/moved' }), await root({ id: 'r_changed', source: src, claimed: '/far/changed' })];
    await transfer(options({ entries, stateDir: state, deps: { run: fakeRsync().run } }));

    // the destination claimed r_moved somewhere else this time, and r_changed no longer matches its copy
    const resumed = [entries[0], { ...entries[1], claim: { ...entries[1].claim, check: { ok: true as const, path: '/far/elsewhere', kind: 'resume' as const } } }, entries[2]];
    const rsync = fakeRsync((argv, n) => (argv.includes('--dry-run') && argv.at(-1) === 'svall-remote.invalid:/far/changed/' && n.dry === 3 ? { lines: ['>fcs....... a.txt'] } : {}));
    const r = await transfer(options({ entries: resumed, stateDir: state, deps: { run: rsync.run } }));
    expect(r.entries).toMatchObject([
      { id: 'r_app', status: 'verified', passes: 0 },
      { id: 'r_moved', status: 'verified', passes: 1 },
      { id: 'r_changed', status: 'verified', passes: 1 },
    ]);
    expect(rsync.real().map((c) => c.at(-1))).toEqual(['svall-remote.invalid:/far/elsewhere/', 'svall-remote.invalid:/far/changed/']);
  });

  it('verifies on the next pass once a source edited during the first is left alone, and returns what landed', async () => {
    const src = tree(tmp(), { 'a.txt': 'a', 'notes.md': 'v0' });
    const entry = await root({ source: src, claimed: '/far/app' });
    const rsync = fakeRsync((argv, n) => {
      if (!argv.includes('--dry-run') && n.real === 1) fs.writeFileSync(path.join(src, 'notes.md'), 'v1');
      return {};
    });
    const r = await transfer(options({ entries: [entry], stateDir: tmp(), deps: { run: rsync.run } }));
    expect(r.status).toBe('verified');
    expect(rsync.real()).toHaveLength(2);
    const [verified] = r.entries as unknown as [{ passes: number; files: TransferFile[] }];
    expect(verified.passes).toBe(2);
    // the scan that landed, not the manifest frozen before the edit
    expect(verified.files.find((f) => f.path === 'notes.md')).toMatchObject({ sha256: sha('v1') });
    expect(entry.files.find((f) => f.path === 'notes.md')).toMatchObject({ sha256: sha('v0') });
  });

  it('passes again while the source keeps changing, and after three unstable passes names it', async () => {
    const src = tree(tmp(), { 'a.txt': 'a', 'notes.md': 'v0' });
    const state = tmp();
    const entry = await root({ source: src, claimed: '/far/app' });
    let edits = 0;
    const rsync = fakeRsync((argv) => {
      if (!argv.includes('--dry-run')) fs.writeFileSync(path.join(src, 'notes.md'), `v${++edits}`);
      return {};
    });
    const r = await transfer(options({ entries: [entry], stateDir: state, deps: { run: rsync.run } }));
    expect(rsync.real()).toHaveLength(3);
    expect(r).toEqual({
      status: 'blocked',
      entries: [{ id: 'r_app', status: 'blocked', blocker: r.blockers[0] }],
      blockers: [{
        code: 'external_writer', entity: { kind: 'root', id: 'r_app' },
        message: `the source ${src} kept changing through 3 passes (notes.md); close whatever writes there, then resume, archiving the destination's copy, which no pass verified`,
      }],
    });
  });

  it('asks only for a resume once a session\'s files keep changing, since no claim reads its stage', async () => {
    const home = tree(tmp(), { 'projects/-app/s.jsonl': '{}' });
    let edits = 0;
    const rsync = fakeRsync((argv) => {
      if (!argv.includes('--dry-run')) fs.writeFileSync(path.join(home, 'projects/-app/s.jsonl'), `{"n":${++edits}}`);
      return {};
    });
    const s0 = await session({ home, stage: '/far/stage/0', files: ['projects/-app/s.jsonl'] });
    const r = await transfer(options({ entries: [s0], stateDir: tmp(), deps: { run: rsync.run } }));
    expect(r.blockers).toEqual([{
      code: 'external_writer', entity: { kind: 'session', id: 's0' },
      message: `the source ${home} kept changing through 3 passes (projects/-app/s.jsonl); close whatever writes there, then resume`,
    }]);
  });

  it('names the far copy when the source holds still and the copy keeps differing', async () => {
    const src = tree(tmp(), { 'a.txt': 'a' });
    const rsync = fakeRsync((argv) => (argv.includes('--dry-run') ? { lines: ['>fcst...... a.txt'] } : {}));
    const r = await transfer(options({ entries: [await root({ source: src, claimed: '/far/app' })], stateDir: tmp(), deps: { run: rsync.run } }));
    expect(r.blockers).toEqual([expect.objectContaining({ code: 'external_writer', message: expect.stringMatching(/^the far copy \/far\/app kept changing through 3 passes \(a\.txt\)/) })]);
    expect(rsync.real()).toHaveLength(3);
  });

  it('verifies once a passing writer settles, and counts a vanished file as a changing source', async () => {
    const src = tree(tmp(), { 'a.txt': 'a' });
    const state = tmp();
    const swap = path.join(src, '.a.txt.swp');
    const rsync = fakeRsync((argv, n) => {
      if (argv.includes('--dry-run')) return {};
      if (n.real === 1) { fs.writeFileSync(swap, 'swap'); return {}; }
      if (n.real === 2) { fs.rmSync(swap); return { code: 24, stderr: `file has vanished: "${swap}"\n` }; }
      return {};
    });
    const r = await transfer(options({ entries: [await root({ source: src, claimed: '/far/app' })], stateDir: state, deps: { run: rsync.run } }));
    expect(r.entries).toMatchObject([{ id: 'r_app', status: 'verified', passes: 3 }]);
  });

  it('verifies a link whose only difference the compare itemizes is its mode, which Linux cannot set on a link', async () => {
    const src = tree(tmp(), { 'a.txt': 'a' });
    fs.symlinkSync('a.txt', path.join(src, 'link'));
    const rsync = fakeRsync((argv) => (argv.includes('--dry-run') ? { lines: ['.L...p..... link -> a.txt'] } : {}));
    const r = await transfer(options({ entries: [await root({ source: src, claimed: '/far/app' })], stateDir: tmp(), deps: { run: rsync.run } }));
    expect(r.entries).toMatchObject([{ id: 'r_app', status: 'verified', passes: 1 }]);
  });

  it('still counts a link whose target or times the compare itemizes as changed', async () => {
    const src = tree(tmp(), { 'a.txt': 'a' });
    fs.symlinkSync('a.txt', path.join(src, 'link'));
    for (const change of ['cLc.t...... link -> a.txt', '.L..tp..... link -> a.txt', '>f.st...... a.txt']) {
      const rsync = fakeRsync((argv) => (argv.includes('--dry-run') ? { lines: [change] } : {}));
      const r = await transfer(options({ entries: [await root({ source: src, claimed: '/far/app' })], stateDir: tmp(), deps: { run: rsync.run } }));
      expect(r.blockers).toEqual([expect.objectContaining({ code: 'external_writer' })]);
    }
  });

  it('names the far source when a pulled copy that holds still keeps differing from it', async () => {
    const copy = tree(tmp(), { 'a.txt': 'a' });
    const state = tmp();
    const rsync = fakeRsync((argv) => (argv.includes('--dry-run') ? { lines: ['>fcst...... a.txt'] } : {}));
    const r = await transfer(options({ roles: PULL, entries: [await root({ source: '/far/app', claimed: copy, scanned: copy })], stateDir: state, deps: { run: rsync.run } }));
    expect(r.blockers).toEqual([expect.objectContaining({ code: 'external_writer', message: expect.stringMatching(/^the source \/far\/app kept changing through 3 passes \(a\.txt\)/) })]);
    expect(rsync.real()).toHaveLength(3);
  });

  it('names the local copy when something writes into it while it is compared', async () => {
    const copy = tree(tmp(), { 'a.txt': 'a' });
    let writes = 0;
    const rsync = fakeRsync((argv) => {
      if (!argv.includes('--dry-run')) return {};
      fs.writeFileSync(path.join(copy, `w${++writes}.tmp`), 'local writer');
      return { lines: [`*deleting   w${writes}.tmp`] };
    });
    const r = await transfer(options({ roles: PULL, entries: [await root({ source: '/far/app', claimed: copy, scanned: copy })], stateDir: tmp(), deps: { run: rsync.run } }));
    expect(r.blockers).toEqual([expect.objectContaining({ code: 'external_writer', message: expect.stringContaining(`the local copy ${copy} kept changing through 3 passes (w3.tmp`) })]);
  });

  it('cancels the running rsync and leaves its progress to resume from', async () => {
    const src = tree(tmp(), { 'a.txt': 'a' });
    const state = tmp();
    const abort = new AbortController();
    const rsync = fakeRsync(() => ({ lines: ['<f+++++++++ a.txt'], hang: true }));
    const entries = [await root({ source: src, claimed: '/far/app' }), await root({ id: 'r_next', source: src, claimed: '/far/next' })];
    const running = transfer(options({ entries, stateDir: state, signal: abort.signal, deps: { run: rsync.run } }));
    await new Promise((r) => setTimeout(r, 20));
    abort.abort();
    expect(await running).toEqual({ status: 'cancelled', blockers: [], entries: [{ id: 'r_app', status: 'cancelled' }, { id: 'r_next', status: 'pending' }] });
    expect(rsync.calls).toHaveLength(1);
    expect(readJournal(state).entries.r_app).toMatchObject({ state: 'cancelled', pass: 1, items: 1, signal: 'SIGTERM' });
  });

  it('keeps tokens and .env values out of everything it records', async () => {
    const src = tree(tmp(), { '.env': 'export API_KEY="sk-live-0123456789"\nPORT=8080\n', 'a.txt': 'a' });
    const state = tmp();
    const rsync = fakeRsync(() => ({ code: 23, stderr: 'far shell said token=tok-abcdef123456 and sk-live-0123456789 on port 8080\n' }));
    const events: EntryProgress[] = [];
    const r = await transfer(options({
      entries: [await root({ source: src, claimed: '/far/app' })], stateDir: state, secrets: ['tok-abcdef123456'],
      onProgress: (p) => events.push(p), deps: { run: rsync.run },
    }));
    const recorded = JSON.stringify([r, events, fs.readFileSync(path.join(transactionDir('tx-1', state), 'progress.json'), 'utf8')]);
    expect(recorded).toContain('token=[redacted] and [redacted] on port 8080');
    expect(recorded).not.toContain('tok-abcdef123456');
    expect(recorded).not.toContain('sk-live-0123456789');
  });

  it('leaves the folders a claim keeps out of the copy, its filter and what it reads', async () => {
    const copy = tree(tmp(), { 'a.txt': 'a', '.git/HEAD': 'ref: refs/heads/main\n', '.git/worktrees/stay/HEAD': 'ref: refs/heads/stay\n' });
    const scanned = tree(tmp(), { 'a.txt': 'a', '.git/HEAD': 'ref: refs/heads/main\n' });
    const state = tmp();
    const rsync = fakeRsync();
    const entry = await root({ source: '/far/app', claimed: copy, scanned });
    const keep = ['.git/worktrees/stay'];
    const r = await transfer(options({ roles: PULL, entries: [{ ...entry, claim: { ...entry.claim, keep } }], stateDir: state, deps: { run: rsync.run } }));
    expect(r.entries).toMatchObject([{ id: 'r_app', status: 'verified', passes: 1 }]);
    const [verified] = r.entries as unknown as [{ files: TransferFile[] }];
    expect(verified.files.map((f) => f.path).sort()).toEqual(['.git/HEAD', 'a.txt']);
    const filter = rsync.real()[0].find((a) => a.startsWith('--exclude-from='))!.slice('--exclude-from='.length);
    expect(fs.readFileSync(filter, 'utf8')).toBe(filterRules(EXCLUDES, 'repo', keep));
    expect(filterRules(EXCLUDES, 'repo', keep).split('\n')[0]).toBe('- /.git/worktrees/stay/');
    expect(() => filterRules(EXCLUDES, 'repo', ['../escape'])).toThrow(/escape/);
  });

  it('refuses two entries with one id', async () => {
    const src = tree(tmp(), { 'a.txt': 'a' });
    const entry = await root({ source: src, claimed: '/far/app' });
    await expect(transfer(options({ entries: [entry, entry], stateDir: tmp(), deps: { run: fakeRsync().run } }))).rejects.toThrow(/r_app/);
  });
});

/** Every process still running whose arguments hold `marker`. */
const running = (marker: string): string[] =>
  execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(marker) && !l.includes('ps -axo'));

describe.skipIf(noRsync)('transfer with rsync 3 over the ssh master', { timeout: 60_000 }, () => {
  let ssh: FakeSsh;
  let master: SshMaster;
  beforeEach(async () => {
    ssh = installFakeSsh();
    ssh.execute({ rsync: RSYNC });
    master = await SshMaster.open({ destination: 'trift', socketDir: ssh.socketDir });
  }, 30_000);
  afterEach(async () => {
    await master.close();
    ssh.clean();
  }, 30_000);

  const hostile = {
    'a.txt': 'a',
    'sp ace/ö dir/smörgås 🍞.txt': 'unicode',
    '-rf': 'dash',
    '--delete': 'long dash',
    '$(touch pwned)': 'subst',
    "it's \"q\"; x": 'quotes',
    'glob[1]*?.txt': 'glob',
    'back\\slash': 'bs',
    '.git/refs/heads/build/x': 'ref',
    'node_modules/pkg/index.js': 'cache',
    'dist/out.js': 'build output',
  };

  it('mirrors a root with spaces, unicode and hostile names to the far side and back', async () => {
    const base = tmp();
    const src = tree(path.join(base, "app $(x) 'q' [1]"), hostile);
    fs.symlinkSync('../-rf', path.join(src, 'sp ace', 'link'));
    const far = tmp();
    const claimed = path.join(far, "app $(x) 'q' [1]");
    const decoy = path.join(far, "app $(x) 'q' 1");
    // the far copy is a replica: its own caches stay, and what the source no longer has goes
    tree(claimed, { 'node_modules/far-only.js': 'built there', 'stale.txt': 'gone from the source' });
    fs.mkdirSync(decoy);
    const state = tmp();

    const pushed = await transfer({ transactionId: 'tx-push', roles: PUSH, master, rsync: RSYNC, stateDir: state, entries: [await root({ source: src, claimed })] });
    // one pass: the checksum compare finds nothing left to change, directory times included
    expect(pushed.entries).toMatchObject([{ id: 'r_app', status: 'verified', passes: 1 }]);
    expect(content(await scan(claimed))).toEqual(content(await scan(src)));
    expect(fs.readFileSync(path.join(claimed, 'node_modules/far-only.js'), 'utf8')).toBe('built there');
    expect(fs.existsSync(path.join(claimed, 'node_modules/pkg'))).toBe(false);
    expect(fs.existsSync(path.join(claimed, 'stale.txt'))).toBe(false);
    expect(fs.existsSync(path.join(claimed, '.git/refs/heads/build/x'))).toBe(true);
    expect(fs.readdirSync(decoy)).toEqual([]);
    expect(fs.existsSync(path.join(process.cwd(), 'pwned'))).toBe(false);
    // no path crossed the far shell; every one went through rsync's protocol
    for (const words of ssh.remoteCalls()) expect(words.join(' ')).not.toContain(far);

    const back = path.join(tmp(), 'back [1]');
    fs.mkdirSync(back);
    const pulled = await transfer({ transactionId: 'tx-pull', roles: PULL, master, rsync: RSYNC, stateDir: state, entries: [await root({ source: claimed, claimed: back, scanned: src })] });
    expect(pulled.entries).toMatchObject([{ id: 'r_app', status: 'verified', passes: 1 }]);
    expect(content(await scan(back))).toEqual(content(await scan(src)));
    expect(fs.readlinkSync(path.join(back, 'sp ace', 'link'))).toBe('../-rf');
  });

  it('carries empty folders and each folder\'s mode, which the manifest does not list, and checks them in its compare', async () => {
    const src = tree(tmp(), { 'a.txt': 'a' });
    fs.mkdirSync(path.join(src, 'empty', 'deeper'), { recursive: true });
    fs.mkdirSync(path.join(src, 'private'));
    fs.chmodSync(path.join(src, 'private'), 0o700);
    const claimed = path.join(tmp(), 'app');
    const entry = await root({ source: src, claimed });
    expect(entry.files.map((f) => f.path)).toEqual(['a.txt']);
    const r = await transfer({ transactionId: 'tx-d', roles: PUSH, master, rsync: RSYNC, stateDir: tmp(), entries: [entry] });
    expect(r.entries).toMatchObject([{ id: 'r_app', status: 'verified', passes: 1 }]);
    expect(fs.statSync(path.join(claimed, 'empty', 'deeper')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(claimed, 'private')).mode & 0o777).toBe(0o700);
    // the checksum compare itemizes a folder's mode as it does a file's, so a copy that differs there does not verify
    const lines: string[] = [];
    fs.chmodSync(path.join(claimed, 'private'), 0o755);
    await runRsync(RSYNC, rsyncArgv({ source: `${src}/`, target: `${claimed}/`, rsh: 'ssh', dryRun: true, delete: true, mkpath: false }), { onLine: (l) => lines.push(l) });
    expect(lines).toContainEqual(expect.stringMatching(/^\.d\.\.\.p\.{5} private\/$/));
  });

  it('leaves a folder the claim keeps as the far side has it, where --delete removes what the source no longer has', async () => {
    const src = tree(tmp(), { 'a.txt': 'a', '.git/HEAD': 'ref: refs/heads/main\n', '.git/worktrees/wt/HEAD': 'ref: refs/heads/wt\n' });
    const claimed = tree(path.join(tmp(), 'app'), { 'stale.txt': 'gone from the source', '.git/worktrees/stay/HEAD': 'ref: refs/heads/stay\n', '.git/worktrees/stay/index': 'idx' });
    const entry = await root({ source: src, claimed });
    const r = await transfer({ transactionId: 'tx-k', roles: PUSH, master, rsync: RSYNC, stateDir: tmp(), entries: [{ ...entry, claim: { ...entry.claim, keep: ['.git/worktrees/stay'] } }] });
    expect(r.entries).toMatchObject([{ id: 'r_app', status: 'verified', passes: 1 }]);
    expect(fs.existsSync(path.join(claimed, 'stale.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(claimed, '.git/worktrees/wt/HEAD'), 'utf8')).toBe('ref: refs/heads/wt\n');
    expect(fs.readFileSync(path.join(claimed, '.git/worktrees/stay/HEAD'), 'utf8')).toBe('ref: refs/heads/stay\n');
    expect(fs.readFileSync(path.join(claimed, '.git/worktrees/stay/index'), 'utf8')).toBe('idx');
  });

  it('carries a Git directory on its own whole, where an exclude names one of Git\'s entries', async () => {
    const gitdir = tree(tmp(), { HEAD: 'ref: refs/heads/main\n', 'logs/HEAD': 'log', 'objects/ab/cd': 'o', 'build/out.o': 'built' });
    const excludes = [...EXCLUDES, 'logs/'];
    const claimed = path.join(tmp(), 'app.git');
    const files = (await scanPath(gitdir, rootMatcher('gitdir', excludes)))!.files;
    const entry: RootEntry = {
      kind: 'root', id: 'r_git', rootKind: 'gitdir', entry: 'dir', path: gitdir,
      claim: { excludes, check: { ok: true, path: claimed, kind: 'absent' } }, files,
    };
    const r = await transfer({ transactionId: 'tx-g', roles: PUSH, master, rsync: RSYNC, stateDir: tmp(), entries: [entry] });
    expect(r.entries).toMatchObject([{ id: 'r_git', status: 'verified', passes: 1 }]);
    expect(fs.readFileSync(path.join(claimed, 'logs/HEAD'), 'utf8')).toBe('log');
    expect(fs.existsSync(path.join(claimed, 'build'))).toBe(false);
  });

  it('copies a session\'s listed files into a stage that is not there yet, and nothing beside them, and never deletes there', async () => {
    const home = tree(tmp(), { 'sessions/2026/rollout ö [1].jsonl': '{"a":1}\n', 'sessions/2026/other.jsonl': 'another session', '-rf': 'dash' });
    const far = tree(tmp(), { 'stage/0/keep.jsonl': 'already there' });
    const stage = path.join(far, 'stage', '0');
    const entry = await session({ home, stage, files: ['sessions/2026/rollout ö [1].jsonl', '-rf'] });
    const r = await transfer({ transactionId: 'tx-s', roles: PUSH, master, rsync: RSYNC, stateDir: tmp(), entries: [entry] });
    expect(r.entries).toMatchObject([{ id: 's0', status: 'verified', passes: 1 }]);
    expect(fs.readFileSync(path.join(stage, 'sessions/2026/rollout ö [1].jsonl'), 'utf8')).toBe('{"a":1}\n');
    expect(fs.readFileSync(path.join(stage, '-rf'), 'utf8')).toBe('dash');
    expect(fs.existsSync(path.join(stage, 'sessions/2026/other.jsonl'))).toBe(false);
    expect(fs.readFileSync(path.join(stage, 'keep.jsonl'), 'utf8')).toBe('already there');

    const fresh = path.join(tmp(), 'new stage', '1');
    const pulled = await transfer({ transactionId: 'tx-p', roles: PULL, master, rsync: RSYNC, stateDir: tmp(), entries: [{ ...entry, id: 's1', stage: fresh }] });
    expect(pulled.entries).toMatchObject([{ id: 's1', status: 'verified', passes: 1 }]);
    expect(fs.readFileSync(path.join(fresh, 'sessions/2026/rollout ö [1].jsonl'), 'utf8')).toBe('{"a":1}\n');
  });

  it('keeps a dropped link\'s partial copy, and a resume on a new master finishes it', async () => {
    const src = tmp();
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(src, `f${String(i).padStart(2, '0')}.bin`), crypto.randomBytes(512 * 1024));
    const claimed = tmp();
    const state = tmp();
    const entry = await root({ source: src, claimed });

    ssh.execute({ rsync: RSYNC, cutAfterBytes: 2 * 1024 * 1024 });
    const cut = await transfer({ transactionId: 'tx-cut', roles: PUSH, master, rsync: RSYNC, stateDir: state, entries: [entry] });
    expect(cut.entries).toEqual([{ id: 'r_app', status: 'failed', reason: 'disconnected', code: expect.any(Number), error: expect.any(String) }]);
    const partial = readJournal(state, 'tx-cut').entries.r_app;
    expect(partial).toMatchObject({ state: 'failed', pass: 1 });
    expect(partial.bytes).toBeGreaterThan(0);
    // a receiver killed mid-file leaves its temp; the resume's --delete takes it
    const landed = fs.readdirSync(claimed).filter((n) => !n.startsWith('.')).length;
    expect(landed).toBeLessThan(12);

    ssh.execute({ rsync: RSYNC });
    await master.close();
    master = await SshMaster.open({ destination: 'trift', socketDir: ssh.socketDir });
    const resumed = await transfer({ transactionId: 'tx-cut', roles: PUSH, master, rsync: RSYNC, stateDir: state, entries: [entry] });
    expect(resumed.status).toBe('verified');
    expect(content(await scan(claimed, []))).toEqual(content(entry.files));
    // what the first pass finished was not sent again
    const sent = readJournal(state, 'tx-cut').entries.r_app.bytes;
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(12 * 512 * 1024);
  });

  it('stops a real rsync and its ssh on cancel, and a resume finishes the copy', async () => {
    const src = tmp('svall-cancel-');
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(src, `f${i}.bin`), crypto.randomBytes(256 * 1024));
    const claimed = tmp();
    const state = tmp();
    const entry = await root({ source: src, claimed });
    const abort = new AbortController();
    const cancelled = await transfer({
      transactionId: 'tx-c', roles: PUSH, master, rsync: RSYNC, stateDir: state, entries: [entry], signal: abort.signal,
      // stopped as the copy reports its first file
      deps: { run: (exe, argv, o) => runRsync(exe, argv, { ...o, onLine: (line) => { o.onLine(line); if (!argv.includes('--dry-run')) abort.abort(); } }) },
    });
    expect(cancelled.entries).toEqual([{ id: 'r_app', status: 'cancelled' }]);
    // the local rsync names the source; the ssh it ran names the master's socket, and is no master itself
    const left = () => [...running(src), ...running(master.socket).filter((l) => !l.includes(' -M '))];
    for (let i = 0; i < 30 && left().length; i++) await new Promise((r) => setTimeout(r, 100));
    expect(left()).toEqual([]);

    const resumed = await transfer({ transactionId: 'tx-c', roles: PUSH, master, rsync: RSYNC, stateDir: state, entries: [entry] });
    expect(resumed.status).toBe('verified');
  });

  it('refuses a far rsync too old for protected arguments before it copies anything', async () => {
    const old = path.join(tmp(), 'rsync');
    fs.writeFileSync(old, '#!/bin/sh\necho "rsync  version 3.1.3  protocol version 31"\n', { mode: 0o755 });
    ssh.execute({ rsync: old });
    const src = tree(tmp(), { 'a.txt': 'a' });
    const claimed = tmp();
    const r = await transfer({ transactionId: 'tx-old', roles: PUSH, master, rsync: RSYNC, stateDir: tmp(), entries: [await root({ source: src, claimed })] });
    expect(r).toMatchObject({ status: 'blocked', blockers: [{ code: 'rsync_unsupported', message: expect.stringMatching(/3\.1\.3/) }] });
    expect(fs.readdirSync(claimed)).toEqual([]);
  });

  it('lands a source edited once during the first pass on the second, and hands back that scan', async () => {
    const src = tree(tmp(), { 'a.txt': 'a', 'notes.md': 'v0' });
    const claimed = tmp();
    let edited = false;
    const run: RunRsync = async (exe, argv, o) => {
      const r = await runRsync(exe, argv, o);
      if (!argv.includes('--dry-run') && !edited) { fs.writeFileSync(path.join(src, 'notes.md'), 'v1'); edited = true; }
      return r;
    };
    const r = await transfer({ transactionId: 'tx-e', roles: PUSH, master, rsync: RSYNC, stateDir: tmp(), entries: [await root({ source: src, claimed })], deps: { run } });
    expect(r.entries).toMatchObject([{ id: 'r_app', status: 'verified', passes: 2 }]);
    expect(fs.readFileSync(path.join(claimed, 'notes.md'), 'utf8')).toBe('v1');
    const landed = (r.entries[0] as { files: TransferFile[] }).files;
    expect(content(landed)).toEqual(content(await scan(claimed)));
  });

  it('stops after three passes of a source an outside writer keeps changing', async () => {
    const src = tree(tmp(), { 'a.txt': 'a', 'notes.md': 'v0' });
    const claimed = tmp();
    let edits = 0;
    const run: RunRsync = async (exe, argv, o) => {
      const r = await runRsync(exe, argv, o);
      if (!argv.includes('--dry-run')) fs.writeFileSync(path.join(src, 'notes.md'), `v${++edits}`);
      return r;
    };
    const r = await transfer({ transactionId: 'tx-w', roles: PUSH, master, rsync: RSYNC, stateDir: tmp(), entries: [await root({ source: src, claimed })], deps: { run } });
    expect(edits).toBe(3);
    expect(r.blockers).toEqual([expect.objectContaining({ code: 'external_writer', entity: { kind: 'root', id: 'r_app' } })]);
  });
});

const live = process.env.SVALL_TEST_SSH;

describe.skipIf(!live || noRsync)('transfer with a real Linux rsync (set SVALL_TEST_SSH=<destination> to run)', { timeout: 120_000 }, () => {
  let socketDir = '';
  let socket = '';
  let farBase = '';
  // a master of the test's own, which never writes known_hosts
  const sshArgs = () => ['-S', socket, '-o', 'BatchMode=yes', '-o', 'UpdateHostKeys=no', '-o', 'StrictHostKeyChecking=yes'];
  const far = (...command: string[]): string => execFileSync('ssh', [...sshArgs(), '--', live as string, ...command], { encoding: 'utf8' }).trim();
  const master = (): Master => ({
    socket,
    run: (argv) => runProcess('ssh', [...sshArgs(), '--', live as string, ...argv], { timeoutMs: 30_000 }),
    check: async () => (await runProcess('ssh', [...sshArgs(), '-O', 'check', '--', live as string], { timeoutMs: 10_000 })).code === 0,
  });

  beforeEach(() => {
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-live-'));
    socket = path.join(socketDir, 'm');
    execFileSync('ssh', [...sshArgs(), '-M', '-f', '-N', '-o', 'ControlPersist=60', '--', live as string]);
    farBase = far('mktemp', '-d', '/tmp/svall-rsync-XXXXXX');
    expect(farBase).toMatch(/^\/tmp\/svall-rsync-[A-Za-z0-9]+$/);
  }, 30_000);
  afterEach(() => {
    if (/^\/tmp\/svall-rsync-[A-Za-z0-9]+$/.test(farBase)) far('rm', '-rf', `'${farBase}'`);
    execFileSync('ssh', [...sshArgs(), '-O', 'exit', '--', live as string], { stdio: 'ignore' });
    fs.rmSync(socketDir, { recursive: true, force: true });
  }, 30_000);

  it('mirrors a hostile tree to the Linux rsync and back, with its excludes read the same', async () => {
    const src = tree(tmp(), {
      'a.txt': 'a', 'sp ace/ö dir/smörgås 🍞.txt': 'unicode', '-rf': 'dash', '$(touch pwned)': 'subst', "it's \"q\"; x": 'quotes',
      'glob[1]*?.txt': 'glob', '.git/refs/heads/build/x': 'ref', '.git/worktrees/dist/HEAD': 'wt', 'node_modules/pkg/index.js': 'cache',
      'app/build/o.js': 'out', 'logs/a.log': 'a', 'logs/deep/b.log': 'b', 'x.tsbuildinfo': 'ts', 'root-only.txt': 'r', 'nested/root-only.txt': 'n',
    });
    const claimedFar = `${farBase}/app [1] $(x)`;
    far('mkdir', `'${claimedFar}'`);
    const state = tmp();
    // everything goes out, so the Linux rsync, sending it back, is the one reading the excludes
    const everything = await root({ source: src, claimed: claimedFar, excludes: [] });
    const out = await transfer({ transactionId: 'tx-live-out', roles: PUSH, master: master(), rsync: RSYNC, stateDir: state, entries: [everything] });
    expect(out.status).toBe('verified');

    const excludes = [...EXCLUDES, '/root-only.txt', 'logs/**/*.log'];
    const back = tmp();
    const entry = await root({ source: claimedFar, claimed: back, scanned: src, excludes });
    const home = await transfer({ transactionId: 'tx-live-back', roles: PULL, master: master(), rsync: RSYNC, stateDir: state, entries: [entry] });
    expect(home.status).toBe('verified');
    // what arrived, read with no excludes at all, is what the manifest scan kept
    expect(content(await scan(back, []))).toEqual(content(await scan(src, excludes)));
  });
});
