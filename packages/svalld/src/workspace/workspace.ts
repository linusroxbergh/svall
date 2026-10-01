import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChangedFile, DiffBase, Event, FsEntry } from '@svall/protocol';
import type { Logger } from '../log.js';
import type { Viewer } from '../terminals.js';
import { WorkspaceError } from './errors.js';
import { baseRef, branchOf, changedFiles, fileAt, ignoredNames, isTop, sizeAt } from './git.js';
import { inside, realOf, within } from './paths.js';

const MAX_FILE = 2 * 1024 * 1024;
const PROBE = 8 * 1024;
const DEBOUNCE_MS = 200;
const DOC_FILE = /^[^/\\\x00-\x1f]+\.md$/;

const isBinary = (buf: Buffer): boolean => buf.subarray(0, PROBE).includes(0);

const byKindThenName = (a: FsEntry, b: FsEntry): number =>
  a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1;

// root is what rootOf answered when the watch began, '' while it has no watcher; deep says the watch reaches below the top;
// touched holds the burst's paths, '' for one that always counts
type Watch = { root: string; watcher?: fs.FSWatcher; deep?: boolean; viewers: Set<Viewer>; touched: Set<string>; timer?: NodeJS.Timeout };

type Status = { branch?: string; files: ChangedFile[] };

const REFLOG = path.join('.git', 'logs', 'HEAD');
const INDEX = path.join('.git', 'index');

// an errno has no place in the refusal contract: a path that is not there is not_found, anything else invalid
const refuse = (rel: string, verb: string, e: unknown): WorkspaceError => {
  const errno = (e as { code?: string }).code;
  return errno === 'ENOENT' || errno === 'ENOTDIR'
    ? new WorkspaceError('not_found', `${rel} is not there`)
    : new WorkspaceError('invalid', `${rel} cannot ${verb}`);
};

// throwIfNoEntry covers a path that is not there; a folder on the way that cannot be searched still throws
const statOf = (rel: string, abs: string): fs.Stats | undefined => {
  try { return fs.statSync(abs, { throwIfNoEntry: false }); } catch (e) { throw refuse(rel, 'be used', e); }
};

const changed = (id: string): Event => ({ event: 'repo.changed', data: { id } });

// what another name, case or link of a file shares with it
const idOf = (p: string): string | undefined => {
  try { const s = fs.statSync(p, { throwIfNoEntry: false }); return s && `${s.dev}:${s.ino}`; } catch { return undefined; }
};

export class Workspace {
  /** `refused` answers the absolute paths the fleet never reaches, whatever root they lie in: the files Claude Code and Codex keep a login in, and every fleet's own keys. `trees` are the docs tree and the agent profiles, whose folders take new, renamed and deleted files. */
  constructor(private rootOf: (id: string) => string, private log: Logger, private refused: () => string[] = () => [], private trees: string[] = []) {}

  // another name, another case on a folding volume, a symlink, a hard link: only identity tells them apart.
  // The spelling is compared first, for a path that is not on disk yet
  private sameFile(a: string, b: string): boolean {
    if (a === b) return true;
    try { const x = fs.statSync(a), y = fs.statSync(b); return x.dev === y.dev && x.ino === y.ino; } catch { return false; }
  }

  // a copy of a refused dotfile keeps its name in front: .claude.json.backup, backups/.claude.json.backup.<ts>.
  // A plain name like auth.json or .env is too common for that: a repository's auth.json.example or .env.local is its own
  private isCopy(name: string, refused: string[]): boolean {
    const n = name.toLowerCase();
    return refused.some((r) => { const b = path.basename(r).toLowerCase(); return b.startsWith('.') && path.extname(b) !== '' && n.startsWith(`${b}.`); });
  }

  // the refused paths once a call, each on disk by its identity; one not on disk yet is matched by its folder and
  // its name in any case, since a folding volume would create it under another spelling
  private refusal(): { refused: string[]; is: (abs: string) => boolean } {
    const refused = this.refused();
    const ids = new Set(refused.map(idOf).filter((i) => i !== undefined));
    const is = (abs: string): boolean => {
      if ([abs, realOf(abs) ?? abs].some((p) => this.isCopy(path.basename(p), refused))) return true;
      const own = idOf(abs);
      if (own !== undefined) return ids.has(own);
      const name = path.basename(abs).toLowerCase();
      return refused.some((r) => path.basename(r).toLowerCase() === name && this.sameFile(path.dirname(abs), path.dirname(r)));
    };
    return { refused, is };
  }

  private at(id: string, rel: string, refusal = this.refusal()): string {
    const abs = inside(this.rootOf(id), rel);
    if (refusal.is(abs)) throw new WorkspaceError('invalid', `${rel} is not the fleet's to open`);
    return abs;
  }

  async list(id: string, rel: string): Promise<FsEntry[]> {
    const refusal = this.refusal();
    const abs = this.at(id, rel, refusal);
    let dirents: fs.Dirent[];
    try { dirents = fs.readdirSync(abs, { withFileTypes: true }); }
    catch { throw new WorkspaceError('not_found', `${rel || '.'} is not a folder`); }
    // only a folder that holds a refused file pays for the identity test, and only over its own entries
    const holder = refusal.refused.some((r) => this.sameFile(abs, path.dirname(r)));
    const named = dirents.filter((d) => d.name !== '.git' && !this.isCopy(d.name, refusal.refused) && !(holder && refusal.is(path.join(abs, d.name))));
    const ignored = await ignoredNames(abs, named.map((d) => d.name));
    // a name git ignores is still the user's to open, so the listing marks it rather than dropping it
    return named
      .map((d): FsEntry => ({ name: d.name, kind: d.isDirectory() ? 'dir' : 'file', ...(ignored.has(d.name) && { ignored: true }) }))
      .sort(byKindThenName);
  }

  read(id: string, rel: string): { text: string; mtimeMs: number; root: string } {
    const abs = this.at(id, rel);
    const st = statOf(rel, abs);
    if (!st?.isFile()) throw new WorkspaceError('not_found', `${rel} is not a file`);
    if (st.size > MAX_FILE) throw new WorkspaceError('too_large', `${rel} is over 2 MB`);
    let buf: Buffer;
    try { buf = fs.readFileSync(abs); } catch (e) { throw refuse(rel, 'be read', e); }
    if (isBinary(buf)) throw new WorkspaceError('binary', `${rel} is not text`);
    return { text: buf.toString('utf8'), mtimeMs: st.mtimeMs, root: this.rootOf(id) };
  }

  // root is the one the file was read under: the text never lands in another checkout the character has moved to since
  write(id: string, rel: string, text: string, mtimeMs: number, root?: string): { mtimeMs: number; conflict?: true } {
    const now = this.rootOf(id);
    if (root !== undefined && root !== now) throw new WorkspaceError('invalid', `${rel} was opened in ${root}; the character is now in ${now}`);
    const abs = this.at(id, rel);
    const st = statOf(rel, abs);
    // a rename would put a file in place of a socket or a pipe
    if (st && !st.isFile()) throw new WorkspaceError('invalid', `${rel} cannot be written`);
    // mtime 0 says there was no file to read, so one gone since it was read is a conflict too
    if (st ? st.mtimeMs !== mtimeMs : mtimeMs !== 0) return { conflict: true, mtimeMs: st?.mtimeMs ?? 0 };
    try {
      // the text goes to a file beside the target and one rename swaps it in, so a write cut short leaves the old text whole;
      // a link stays a link, the mode stays, and a read-only file stays refused
      const dest = st ? fs.realpathSync(abs) : abs;
      if (st) fs.accessSync(dest, fs.constants.W_OK);
      const tmp = path.join(path.dirname(dest), `.svall-${crypto.randomBytes(6).toString('hex')}.tmp`);
      let fd: number;
      try { fd = fs.openSync(tmp, 'wx', st ? st.mode & 0o777 : 0o666); }
      catch (e) {
        // a folder the user cannot write can still hold a file they can, and that one is written in place
        if (!st || !['EACCES', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
        fs.writeFileSync(dest, text);
        return { mtimeMs: fs.statSync(abs).mtimeMs };
      }
      try {
        try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        if (st) fs.chmodSync(tmp, st.mode & 0o7777);
        fs.renameSync(tmp, dest);
      } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
      return { mtimeMs: fs.statSync(abs).mtimeMs };
    } catch (e) { throw refuse(rel, 'be written', e); }
  }

  // a folder of a tree by its spelling and by where it really is: the spelling keeps out a sibling of a tree
  // that is not on disk yet, the real path a folder that is a link away
  private isDocs(root: string): boolean {
    return this.trees.some((tree) => {
      if (!within(path.resolve(root), path.resolve(tree))) return false;
      const real = realOf(root), realTree = realOf(tree);
      return real !== undefined && realTree !== undefined && within(real, realTree);
    });
  }

  // a doc's path under a docs folder; every other root stays read-and-write only, and a nested doc would never be listed
  private docAt(id: string, rel: string, make = false): string {
    const root = this.rootOf(id);
    if (!this.isDocs(root)) throw new WorkspaceError('invalid', 'files can only be created, renamed or deleted in a docs or agent profiles folder');
    if (!DOC_FILE.test(rel)) throw new WorkspaceError('invalid', `${rel || 'that'} is not a .md file directly in the folder`);
    if (make) fs.mkdirSync(root, { recursive: true });
    return this.at(id, rel);
  }

  create(id: string, rel: string, text: string): { mtimeMs: number } {
    const abs = this.docAt(id, rel, true);
    try { fs.writeFileSync(abs, text, { flag: 'wx' }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkspaceError('exists', `${rel} is already there`);
      throw refuse(rel, 'be written', e);
    }
    return { mtimeMs: fs.statSync(abs).mtimeMs };
  }

  rename(id: string, rel: string, to: string): void {
    const from = this.docAt(id, rel), dest = this.docAt(id, to);
    if (!statOf(rel, from)?.isFile()) throw new WorkspaceError('not_found', `${rel} is not a file`);
    // a change of case names the same file on a folding volume, and is a rename like any other
    if (fs.existsSync(dest) && !this.sameFile(from, dest)) throw new WorkspaceError('exists', `${to} is already there`);
    try { fs.renameSync(from, dest); } catch (e) { throw refuse(rel, 'be renamed', e); }
  }

  remove(id: string, rel: string): void {
    const abs = this.docAt(id, rel);
    try { fs.unlinkSync(abs); } catch (e) { throw refuse(rel, 'be deleted', e); }
  }

  private async repoRoot(id: string): Promise<string> {
    const root = inside(this.rootOf(id), '');
    if (!(await isTop(root))) throw new WorkspaceError('no_repo', `${root} is not a git working tree`);
    return root;
  }

  // one status per root and base runs at a time, and the calls made during it share the run after it:
  // a burst of changes on a loaded machine never stacks diffs that each run into the timeout
  private queued = new Map<string, Promise<Status>>();
  private running = new Map<string, Promise<Status>>();

  async status(id: string, base: DiffBase): Promise<Status> {
    const key = `${base}\0${inside(this.rootOf(id), '')}`;
    const queued = this.queued.get(key);
    if (queued) return queued;
    const run: Promise<Status> = (this.running.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      this.queued.delete(key);
      this.running.set(key, run);
      const root = await this.repoRoot(id);
      const [branch, files] = await Promise.all([branchOf(root), changedFiles(root, await baseRef(root, base))]);
      return { branch, files };
    }).finally(() => { if (this.running.get(key) === run) this.running.delete(key); });
    this.queued.set(key, run);
    return run;
  }

  async file(id: string, rel: string, base: DiffBase, from?: string): Promise<{ before?: string; after?: string; binary?: true }> {
    const root = await this.repoRoot(id);
    const abs = this.at(id, rel);
    if (from) this.at(id, from);
    const ref = await baseRef(root, base);
    const was = from ?? rel;
    const st = statOf(rel, abs);
    // sizes first: neither side is read into memory only to be refused
    const sizes = [await sizeAt(root, ref, was), st?.isFile() ? st.size : undefined];
    if (sizes.some((n) => n !== undefined && n > MAX_FILE)) throw new WorkspaceError('too_large', `${rel} is over 2 MB`);
    const before = sizes[0] === undefined ? undefined : await fileAt(root, ref, was);
    let after: Buffer | undefined;
    try { after = st?.isFile() ? fs.readFileSync(abs) : undefined; } catch (e) { throw refuse(rel, 'be read', e); }
    if ([before, after].some((side) => side && isBinary(side))) return { binary: true };
    return { ...(before && { before: before.toString('utf8') }), ...(after && { after: after.toString('utf8') }) };
  }

  private watches = new Map<string, Watch>();

  watch(id: string, viewer: Viewer): void {
    // ~/.claude holds every session's transcript: a recursive watch there never rests
    if (id.startsWith('r:')) throw new WorkspaceError('invalid', 'a resource root is not watched');
    let w = this.watches.get(id);
    if (!w) {
      w = { root: '', viewers: new Set(), touched: new Set() };
      this.watches.set(id, w);
      this.startWatch(id, w);
    }
    w.viewers.add(viewer);
  }

  /** After the fleet changed: a watch follows its character to a new root, and ends with a character that is gone. */
  retarget(): void {
    for (const [id, w] of [...this.watches]) {
      let root: string | undefined;
      try { root = this.rootOf(id); } catch { /* the character is gone */ }
      if (root === undefined) { this.stopWatch(id); continue; }
      if (root === w.root) continue;
      this.parkWatch(w);
      this.startWatch(id, w);
      if (!w.watcher) continue;
      for (const v of w.viewers) v.send(changed(id));
    }
  }

  private startWatch(id: string, w: Watch): void {
    let root = '';
    try {
      root = this.rootOf(id);
      const top = inside(root, '');
      // outside git nothing quiets what churns below, ~/.claude's transcripts above all, so only the top is watched
      w.deep = fs.existsSync(path.join(top, '.git'));
      w.watcher = fs.watch(top, { recursive: w.deep }, (_ev, file) => this.touch(id, file));
      w.root = root;
      w.watcher.on('error', (e) => { this.log.error(`watch ${root}: ${String(e)}`); this.parkWatch(w); });
    } catch (e) {
      this.log.error(`watch ${root || id}: ${String(e)}`);
      this.parkWatch(w);
    }
  }

  // a watch whose root it cannot reach keeps its viewers and waits, root '', for the next retarget to try again
  private parkWatch(w: Watch): void {
    clearTimeout(w.timer);
    w.timer = undefined;
    w.watcher?.close();
    w.watcher = undefined;
    w.root = '';
  }

  unwatch(id: string, viewer: Viewer): void {
    const w = this.watches.get(id);
    if (!w) return;
    w.viewers.delete(viewer);
    if (w.viewers.size === 0) this.stopWatch(id);
  }

  unwatchAll(viewer: Viewer): void {
    for (const id of [...this.watches.keys()]) this.unwatch(id, viewer);
  }

  close(): void {
    for (const id of [...this.watches.keys()]) this.stopWatch(id);
  }

  // one event per burst: the first change starts the clock, everything within it rides along.
  // .git churns with every git command; only its reflog says the history moved, and its index that something was staged
  private touch(id: string, file: string | null): void {
    const w = this.watches.get(id);
    if (!w) return;
    // a git init or a removed .git changes how deep the watch goes, and whether Changes has a repository
    if (file === '.git' && w.deep !== fs.existsSync(path.join(w.root, '.git'))) { this.parkWatch(w); this.startWatch(id, w); file = null; }
    const inGit = file !== null && (file === '.git' || file.startsWith(`.git${path.sep}`));
    if (inGit && file !== REFLOG && file !== INDEX) return;
    w.touched.add(inGit || file === null ? '' : file);
    w.timer ??= setTimeout(() => { void this.flush(id, w); }, DEBOUNCE_MS);
  }

  // a burst of nothing but ignored paths (node_modules, build output) is no news
  private async flush(id: string, w: Watch): Promise<void> {
    w.timer = undefined;
    const root = w.root;
    const touched = [...w.touched];
    w.touched.clear();
    const counts = touched.includes('');
    // a git that cannot run ignores nothing
    const ignored = counts ? 0 : (await ignoredNames(root, touched).catch(() => new Set<string>())).size;
    if (!counts && ignored === touched.length) return;
    if (this.watches.get(id) !== w) return;
    for (const v of w.viewers) v.send(changed(id));
  }

  private stopWatch(id: string): void {
    const w = this.watches.get(id);
    if (!w) return;
    clearTimeout(w.timer);
    w.watcher?.close();
    this.watches.delete(id);
  }
}
