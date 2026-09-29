import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '@svall/protocol';
import { silentLogger } from '../src/log.js';
import type { Viewer } from '../src/terminals.js';
import { Workspace } from '../src/workspace/workspace.js';
import { cleanHomes, makeHome, waitFor } from './helpers.js';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString();

// a repository with one commit on main: a.txt, del.txt, src/b.ts, and an ignored build/ folder
function repo(): string {
  const dir = makeHome();
  sh(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'del.txt'), 'del\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/b.ts'), 'export const b = 1;\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'build/\n');
  fs.mkdirSync(path.join(dir, 'build'));
  fs.writeFileSync(path.join(dir, 'build/out.js'), '');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

const workspace = (roots: Record<string, string>, ...refused: string[]) =>
  new Workspace((id) => { const r = roots[id]; if (!r) throw new Error(`no ${id}`); return r; }, silentLogger, () => refused);

const codeOf = async (p: () => unknown | Promise<unknown>): Promise<string | undefined> => {
  try { await p(); return undefined; } catch (e) { return (e as { code?: string }).code; }
};

describe('Workspace files', () => {
  afterEach(cleanHomes);

  it('lists a folder with folders first, without .git, and marks the ignored names', async () => {
    const ws = workspace({ c: repo() });
    expect(await ws.list('c', '')).toEqual([
      { name: 'build', kind: 'dir', ignored: true }, { name: 'src', kind: 'dir' },
      { name: '.gitignore', kind: 'file' }, { name: 'a.txt', kind: 'file' }, { name: 'del.txt', kind: 'file' },
    ]);
    expect(await ws.list('c', 'build')).toEqual([{ name: 'out.js', kind: 'file', ignored: true }]);
    expect(await ws.list('c', 'src')).toEqual([{ name: 'b.ts', kind: 'file' }]);
  });

  it('lists a folder outside git without filtering', async () => {
    const dir = makeHome();
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'x'), '');
    const ws = workspace({ c: dir });
    expect(await ws.list('c', '')).toEqual([{ name: 'node_modules', kind: 'dir' }, { name: 'x', kind: 'file' }]);
  });

  it('reads a file with its mtime and refuses large and binary ones', () => {
    const dir = repo();
    const ws = workspace({ c: dir });
    const r = ws.read('c', 'a.txt');
    expect(r.text).toBe('one\ntwo\n');
    expect(r.mtimeMs).toBe(fs.statSync(path.join(dir, 'a.txt')).mtimeMs);
    fs.writeFileSync(path.join(dir, 'big'), Buffer.alloc(2 * 1024 * 1024 + 1));
    fs.writeFileSync(path.join(dir, 'bin'), Buffer.from([0x41, 0x00, 0x42]));
    expect(() => ws.read('c', 'big')).toThrow(expect.objectContaining({ code: 'too_large' }));
    expect(() => ws.read('c', 'bin')).toThrow(expect.objectContaining({ code: 'binary' }));
    expect(() => ws.read('c', 'nope')).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => ws.read('c', 'src')).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('writes while the mtime still matches, answers conflict when it moved on or the file went, and recreates it when told it is gone', () => {
    const dir = repo();
    const ws = workspace({ c: dir });
    const { mtimeMs } = ws.read('c', 'a.txt');
    const w = ws.write('c', 'a.txt', 'three\n', mtimeMs);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('three\n');
    expect(w).toEqual({ mtimeMs: fs.statSync(path.join(dir, 'a.txt')).mtimeMs });
    expect(ws.write('c', 'a.txt', 'four\n', mtimeMs)).toEqual({ conflict: true, mtimeMs: w.mtimeMs });
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('three\n');
    fs.rmSync(path.join(dir, 'a.txt'));
    expect(ws.write('c', 'a.txt', 'five\n', w.mtimeMs)).toEqual({ conflict: true, mtimeMs: 0 });
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(false);
    ws.write('c', 'a.txt', 'five\n', 0);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('five\n');
  });

  it('writes by a rename from beside the file, keeping its mode and a link to it, and leaves nothing behind', () => {
    const dir = repo();
    const file = path.join(dir, 'a.txt');
    fs.chmodSync(file, 0o640);
    fs.symlinkSync('a.txt', path.join(dir, 'alias.txt'));
    const ws = workspace({ c: dir });
    ws.write('c', 'alias.txt', 'three\n', ws.read('c', 'alias.txt').mtimeMs);
    expect(fs.lstatSync(path.join(dir, 'alias.txt')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('three\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses to write a read-only file', async () => {
    const dir = repo();
    const file = path.join(dir, 'a.txt');
    fs.chmodSync(file, 0o444);
    const ws = workspace({ c: dir });
    expect(await codeOf(() => ws.write('c', 'a.txt', 'x', ws.read('c', 'a.txt').mtimeMs))).toBe('invalid');
    expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo\n');
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('leaves the file whole and nothing beside it when the text cannot all be written', async () => {
    const dir = repo();
    const ws = workspace({ c: dir });
    const mtimeMs = ws.read('c', 'a.txt').mtimeMs;
    const full = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); });
    try { expect(await codeOf(() => ws.write('c', 'a.txt', 'three\n', mtimeMs))).toBe('invalid'); } finally { full.mockRestore(); }
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('writes a file in place when its folder takes no new file, and one whose name is as long as a name gets', () => {
    const dir = repo();
    const long = `${'n'.repeat(251)}.txt`;
    fs.writeFileSync(path.join(dir, long), 'one\n');
    const ws = workspace({ c: dir });
    ws.write('c', long, 'two\n', ws.read('c', long).mtimeMs);
    expect(fs.readFileSync(path.join(dir, long), 'utf8')).toBe('two\n');
    fs.chmodSync(dir, 0o555);
    try { ws.write('c', 'a.txt', 'three\n', ws.read('c', 'a.txt').mtimeMs); } finally { fs.chmodSync(dir, 0o755); }
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('three\n');
  });

  it('refuses to write over a socket', async () => {
    const dir = repo();
    const sock = path.join(dir, 'hooks.sock');
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(sock, r));
    try {
      const ws = workspace({ c: dir });
      expect(await codeOf(() => ws.write('c', 'hooks.sock', 'x', fs.statSync(sock).mtimeMs))).toBe('invalid');
      expect(fs.statSync(sock).isSocket()).toBe(true);
    } finally { await new Promise((r) => server.close(r)); }
  });

  it('refuses a write into another root than the one the file was read from', async () => {
    const a = repo(), b = repo();
    fs.rmSync(path.join(b, 'a.txt'));
    const roots: Record<string, string> = { c: a };
    const ws = workspace(roots);
    const r = ws.read('c', 'a.txt');
    expect(r.root).toBe(a);
    roots.c = b;
    expect(await codeOf(() => ws.write('c', 'a.txt', 'meant for a\n', r.mtimeMs, r.root))).toBe('invalid');
    expect(fs.existsSync(path.join(b, 'a.txt'))).toBe(false);
    roots.c = a;
    ws.write('c', 'a.txt', 'meant for a\n', r.mtimeMs, r.root);
    expect(fs.readFileSync(path.join(a, 'a.txt'), 'utf8')).toBe('meant for a\n');
  });

  it('refuses a path that leaves the root, by dots or by symlink', async () => {
    const dir = repo();
    const outside = makeHome();
    fs.writeFileSync(path.join(outside, 'secret'), 's');
    fs.symlinkSync(outside, path.join(dir, 'link'));
    const ws = workspace({ c: dir });
    expect(await codeOf(() => ws.list('c', '..'))).toBe('invalid');
    expect(await codeOf(() => ws.read('c', '../' + path.basename(outside) + '/secret'))).toBe('invalid');
    expect(await codeOf(() => ws.read('c', 'link/secret'))).toBe('invalid');
    expect(await codeOf(() => ws.write('c', 'link/new', '', 0))).toBe('invalid');
    expect(await codeOf(() => ws.read('c', '/etc/hosts'))).toBe('invalid');
    expect(fs.existsSync(path.join(outside, 'new'))).toBe(false);
  });

  it('refuses to write through a symlink that leads nowhere yet', async () => {
    const dir = repo();
    const outside = makeHome();
    fs.symlinkSync(path.join(outside, 'made'), path.join(dir, 'nowhere'));
    const ws = workspace({ c: dir });
    expect(await codeOf(() => ws.write('c', 'nowhere', 'x', 0))).toBe('invalid');
    expect(await codeOf(() => ws.write('c', 'nowhere/x', 'x', 0))).toBe('invalid');
    expect(fs.existsSync(path.join(outside, 'made'))).toBe(false);
  });

  it('keeps a write that the file system refuses inside the refusal codes', async () => {
    const dir = repo();
    const ws = workspace({ c: dir });
    const mtimeMs = fs.statSync(path.join(dir, 'src')).mtimeMs;
    expect(await codeOf(() => ws.write('c', 'src', 'x', mtimeMs))).toBe('invalid');
    expect(await codeOf(() => ws.write('c', 'a.txt/under', 'x', 0))).toBe('not_found');
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses .git, which a listing does not show either, however the path spells its way there', async () => {
    const dir = repo();
    const ws = workspace({ c: dir });
    expect(await codeOf(() => ws.list('c', '.git'))).toBe('invalid');
    expect(await codeOf(() => ws.read('c', '.git/config'))).toBe('invalid');
    expect(await codeOf(() => ws.write('c', '.git/hooks/pre-commit', 'x', 0))).toBe('invalid');
    expect(await codeOf(() => ws.read('c', './.git/config'))).toBe('invalid');
    expect(await codeOf(() => ws.read('c', 'src/../.git/config'))).toBe('invalid');
    expect(await codeOf(() => ws.read('c', '.GIT/config'))).toBe('invalid');
    expect(await codeOf(() => ws.file('c', '.git/config', 'head'))).toBe('invalid');
    expect(fs.existsSync(path.join(dir, '.git/hooks/pre-commit'))).toBe(false);
    // the Changes tab reaches git through the CLI, not through these paths
    expect((await ws.status('c', 'head')).branch).toBe('main');
  });

  it('refuses a .git further down the tree, and one reached through a link', async () => {
    const dir = repo();
    fs.mkdirSync(path.join(dir, 'vendor/.git/hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'vendor/.git/config'), 'x');
    fs.symlinkSync('.git', path.join(dir, 'alias'));
    const ws = workspace({ c: dir });
    expect(await codeOf(() => ws.read('c', 'vendor/.git/config'))).toBe('invalid');
    expect(await codeOf(() => ws.write('c', 'vendor/.git/hooks/pre-commit', 'x', 0))).toBe('invalid');
    expect(await codeOf(() => ws.read('c', 'alias/config'))).toBe('invalid');
    expect(await codeOf(() => ws.write('c', 'alias/hooks/pre-commit', 'x', 0))).toBe('invalid');
    expect(fs.existsSync(path.join(dir, 'vendor/.git/hooks/pre-commit'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.git/hooks/pre-commit'))).toBe(false);
  });

  it('takes a root that ends in a separator', async () => {
    const dir = repo();
    const ws = workspace({ c: dir + path.sep });
    expect((await ws.list('c', '')).map((e) => e.name)).toContain('a.txt');
    expect(ws.read('c', 'a.txt').text).toBe('one\ntwo\n');
  });

  it('answers not_found when the root itself is gone', async () => {
    const ws = workspace({ c: path.join(makeHome(), 'gone') });
    expect(await codeOf(() => ws.list('c', ''))).toBe('not_found');
  });

  it('reads and writes through a resource root id, and refuses a path that leaves it', async () => {
    const dir = makeHome();
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'one\n');
    const ws = workspace({ [`r:${dir}`]: dir });
    const { mtimeMs } = ws.read(`r:${dir}`, 'CLAUDE.md');
    ws.write(`r:${dir}`, 'CLAUDE.md', 'two\n', mtimeMs);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('two\n');
    expect(await codeOf(() => ws.write(`r:${dir}`, '../out.md', 'x', 0))).toBe('invalid');
  });

  it('refuses the file it is told to refuse, by name and through a link, and leaves it out of the listing', async () => {
    const dir = makeHome();
    fs.writeFileSync(path.join(dir, '.claude.json'), '{"oauth":"top-secret"}');
    fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
    fs.symlinkSync(path.join(dir, '.claude.json'), path.join(dir, 'alias.json'));
    const ws = workspace({ [`r:${dir}`]: dir }, path.join(dir, '.claude.json'));
    expect(await codeOf(() => ws.read(`r:${dir}`, '.claude.json'))).toBe('invalid');
    expect(await codeOf(() => ws.write(`r:${dir}`, '.claude.json', 'x', 0))).toBe('invalid');
    expect(await codeOf(() => ws.read(`r:${dir}`, './.claude.json'))).toBe('invalid');
    expect(await codeOf(() => ws.read(`r:${dir}`, 'alias.json'))).toBe('invalid');
    expect(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).toBe('{"oauth":"top-secret"}');
    expect(ws.read(`r:${dir}`, 'settings.json').text).toBe('{}');
    expect((await ws.list(`r:${dir}`, '')).map((e) => e.name)).toEqual(['settings.json']);
  });

  it('keeps every login file out of reach, each in its own folder', async () => {
    const claudeDir = repo();
    const codexDir = repo();
    const claudeJson = path.join(claudeDir, '.claude.json');
    const auth = path.join(codexDir, 'auth.json');
    fs.writeFileSync(claudeJson, '{"oauth":"top-secret"}');
    fs.writeFileSync(auth, '{"tokens":"top-secret"}');
    fs.writeFileSync(path.join(codexDir, 'config.toml'), 'model = "x"');
    const ws = workspace({ a: claudeDir, b: codexDir }, claudeJson, auth);
    expect(await codeOf(() => ws.read('a', '.claude.json'))).toBe('invalid');
    expect(await codeOf(() => ws.read('b', 'auth.json'))).toBe('invalid');
    expect(await codeOf(() => ws.write('b', 'auth.json', 'x', 0))).toBe('invalid');
    const names = (await ws.list('b', '')).map((e) => e.name);
    expect(names).toContain('config.toml');
    expect(names).not.toContain('auth.json');
  });

  it('refuses a copy named after a refused file, wherever it lies, and leaves it out of the listing', async () => {
    const home = makeHome();
    const claudeDir = path.join(home, '.claude');
    const claudeJson = path.join(home, '.claude.json');
    fs.mkdirSync(path.join(claudeDir, 'backups'), { recursive: true });
    fs.writeFileSync(claudeJson, '{"oauth":"top-secret"}');
    fs.copyFileSync(claudeJson, path.join(home, '.claude.json.backup'));
    fs.copyFileSync(claudeJson, path.join(claudeDir, 'backups/.claude.json.backup.1758000000000'));
    fs.symlinkSync(path.join(home, '.claude.json.backup'), path.join(home, 'alias.json'));
    fs.writeFileSync(path.join(home, 'notes.txt'), 'x');
    const ws = workspace({ c: home, [`r:${claudeDir}`]: claudeDir }, claudeJson);
    expect(await codeOf(() => ws.read('c', '.claude.json.backup'))).toBe('invalid');
    expect(await codeOf(() => ws.read('c', 'alias.json'))).toBe('invalid');
    expect(await codeOf(() => ws.read(`r:${claudeDir}`, 'backups/.claude.json.backup.1758000000000'))).toBe('invalid');
    expect(await codeOf(() => ws.write('c', '.claude.json.backup', 'x', 0))).toBe('invalid');
    expect((await ws.list('c', '')).map((e) => e.name)).toEqual(['.claude', 'notes.txt']);
    expect(await ws.list(`r:${claudeDir}`, 'backups')).toEqual([]);
    expect(ws.read('c', 'notes.txt').text).toBe('x');
  });

  it('takes only a dotfile\'s name for a copy, so a repository\'s auth.json.example stays its own', async () => {
    const codexDir = makeHome(), dir = repo();
    const auth = path.join(codexDir, 'auth.json');
    fs.writeFileSync(auth, '{"tokens":"top-secret"}');
    fs.writeFileSync(path.join(dir, 'auth.json.example'), '{"tokens":"yours here"}');
    fs.mkdirSync(path.join(dir, 'config'));
    fs.writeFileSync(path.join(dir, 'config/auth.json.dist'), '{}');
    const ws = workspace({ c: dir }, auth);
    expect(ws.read('c', 'auth.json.example').text).toBe('{"tokens":"yours here"}');
    expect(ws.read('c', 'config/auth.json.dist').text).toBe('{}');
    expect((await ws.list('c', '')).map((e) => e.name)).toContain('auth.json.example');
    expect((await ws.list('c', 'config')).map((e) => e.name)).toEqual(['auth.json.dist']);
  });

  it('refuses a fleet\'s .env alone, so a repository\'s .env and .env.local stay its own', async () => {
    const fleet = makeHome(), dir = repo();
    const env = path.join(fleet, '.env');
    fs.writeFileSync(env, 'ANTHROPIC_API_KEY=secret');
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=1');
    fs.writeFileSync(path.join(dir, '.env.local'), 'PORT=2');
    const ws = workspace({ f: fleet, c: dir }, env);
    expect(await codeOf(() => ws.read('f', '.env'))).toBe('invalid');
    expect(ws.read('c', '.env').text).toBe('PORT=1');
    expect(ws.read('c', '.env.local').text).toBe('PORT=2');
    expect((await ws.list('c', '')).map((e) => e.name)).toEqual(expect.arrayContaining(['.env', '.env.local']));
  });

  it('refuses a fleet key not made yet under any case, which a folding volume would make it by', async () => {
    const fleet = makeHome();
    const ws = workspace({ f: fleet }, path.join(fleet, '.env'));
    for (const name of ['.env', '.ENV']) expect(await codeOf(() => ws.write('f', name, 'KEY=1', 0))).toBe('invalid');
    expect(fs.readdirSync(fleet)).toEqual([]);
  });

  it('asks for the refused paths on every call, so one refused after the start is kept out too', async () => {
    const dir = makeHome();
    fs.writeFileSync(path.join(dir, 'token'), 'secret');
    const refused: string[] = [];
    const ws = new Workspace(() => dir, silentLogger, () => refused);
    expect(ws.read('c', 'token').text).toBe('secret');
    refused.push(path.join(dir, 'token'));
    expect(await codeOf(() => ws.read('c', 'token'))).toBe('invalid');
    expect(await ws.list('c', '')).toEqual([]);
  });

  it('refuses the same file under another name, another case, and in the diff view', async () => {
    const dir = repo();
    const refused = path.join(dir, '.claude.json');
    fs.writeFileSync(refused, '{"oauth":"top-secret"}');
    fs.linkSync(refused, path.join(dir, 'hard.json'));
    const ws = workspace({ c: dir }, refused);
    expect(await codeOf(() => ws.read('c', 'hard.json'))).toBe('invalid');
    expect(await codeOf(() => ws.write('c', 'hard.json', 'x', 0))).toBe('invalid');
    expect(await codeOf(() => ws.file('c', '.claude.json', 'head'))).toBe('invalid');
    expect(await codeOf(() => ws.file('c', 'a.txt', 'head', '.claude.json'))).toBe('invalid');
    // a volume that folds case hands out the same file under another spelling; one that does not makes a
    // different file, which is not this one
    if (fs.existsSync(path.join(dir, '.CLAUDE.JSON'))) {
      expect(await codeOf(() => ws.read('c', '.CLAUDE.JSON'))).toBe('invalid');
      expect(await codeOf(() => ws.write('c', '.CLAUDE.JSON', 'x', 0))).toBe('invalid');
    }
    const names = (await ws.list('c', '')).map((e) => e.name);
    expect(names).not.toContain('hard.json');
    expect(names).not.toContain('.claude.json');
    expect(ws.read('c', 'a.txt').text).toBe('one\ntwo\n');
    expect(fs.readFileSync(refused, 'utf8')).toBe('{"oauth":"top-secret"}');
  });

  it('does not watch a resource root', async () => {
    const dir = makeHome();
    const ws = workspace({ [`r:${dir}`]: dir });
    const viewer = { kind: 'desktop', send: () => {}, backlog: () => 0 } as unknown as Viewer;
    expect(await codeOf(() => ws.watch(`r:${dir}`, viewer))).toBe('invalid');
  });
});

describe('Workspace git', () => {
  afterEach(cleanHomes);

  // on a branch off main: a.txt modified, src/b.ts renamed, del.txt deleted (committed), new.txt added (committed), untracked u.txt
  function branched(): string {
    const dir = repo();
    sh(dir, 'checkout', '-q', '-b', 'feat');
    fs.renameSync(path.join(dir, 'src/b.ts'), path.join(dir, 'src/c.ts'));
    fs.rmSync(path.join(dir, 'del.txt'));
    fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', 'second');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(dir, 'u.txt'), 'u\n');
    return dir;
  }

  it('lists the working tree against HEAD and against the merge-base with main', async () => {
    const dir = branched();
    const ws = workspace({ c: dir });
    const head = await ws.status('c', 'head');
    expect(head.branch).toBe('feat');
    expect(head.files).toEqual([{ path: 'a.txt', status: 'M' }, { path: 'u.txt', status: '?' }]);
    const main = await ws.status('c', 'main');
    expect(main.files).toEqual([
      { path: 'a.txt', status: 'M' }, { path: 'del.txt', status: 'D' }, { path: 'new.txt', status: 'A' },
      { path: 'src/c.ts', status: 'R', from: 'src/b.ts' }, { path: 'u.txt', status: '?' },
    ]);
  });

  it('falls back to HEAD as the base when no default branch exists', async () => {
    const dir = makeHome();
    sh(dir, 'init', '-q', '-b', 'trunk');
    fs.writeFileSync(path.join(dir, 'x'), 'x\n');
    sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'one');
    fs.writeFileSync(path.join(dir, 'x'), 'y\n');
    const ws = workspace({ c: dir });
    expect((await ws.status('c', 'main')).files).toEqual([{ path: 'x', status: 'M' }]);
  });

  it('names a detached HEAD as HEAD', async () => {
    const dir = branched();
    sh(dir, 'checkout', '-q', '--detach');
    expect((await workspace({ c: dir }).status('c', 'head')).branch).toBe('HEAD');
  });

  it('shows everything as untracked before the first commit', async () => {
    const dir = makeHome();
    sh(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'x'), 'x\n');
    const ws = workspace({ c: dir });
    expect(await ws.status('c', 'head')).toEqual({ branch: 'main', files: [{ path: 'x', status: '?' }] });
  });

  it('gives both sides of a file: modified, added, deleted, renamed, untracked, binary', async () => {
    const dir = branched();
    const ws = workspace({ c: dir });
    expect(await ws.file('c', 'a.txt', 'head')).toEqual({ before: 'one\ntwo\n', after: 'one\ntwo\nthree\n' });
    expect(await ws.file('c', 'new.txt', 'main')).toEqual({ after: 'new\n' });
    expect(await ws.file('c', 'del.txt', 'main')).toEqual({ before: 'del\n' });
    expect(await ws.file('c', 'src/c.ts', 'main', 'src/b.ts')).toEqual({ before: 'export const b = 1;\n', after: 'export const b = 1;\n' });
    expect(await ws.file('c', 'u.txt', 'head')).toEqual({ after: 'u\n' });
    fs.writeFileSync(path.join(dir, 'a.txt'), Buffer.from([0x41, 0x00]));
    expect(await ws.file('c', 'a.txt', 'head')).toEqual({ binary: true });
  });

  it('refuses a rename source that leaves the root', async () => {
    const dir = branched();
    const outside = makeHome();
    fs.writeFileSync(path.join(outside, 'secret'), 's');
    const ws = workspace({ c: dir });
    expect(await codeOf(() => ws.file('c', 'a.txt', 'head', '../' + path.basename(outside) + '/secret'))).toBe('invalid');
    expect(await codeOf(() => ws.file('c', 'a.txt', 'head', path.join(outside, 'secret')))).toBe('invalid');
  });

  it('keeps a diff the file system refuses inside the refusal codes', async () => {
    const dir = branched();
    const ws = workspace({ c: dir });
    fs.chmodSync(path.join(dir, 'a.txt'), 0);
    const unreadable = await codeOf(() => ws.file('c', 'a.txt', 'head'));
    fs.chmodSync(path.join(dir, 'a.txt'), 0o644);
    expect(unreadable).toBe('invalid');
  });

  it('refuses a side over 2 MB', async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'a.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    const ws = workspace({ c: dir });
    expect(await codeOf(() => ws.file('c', 'a.txt', 'head'))).toBe('too_large');
  });

  it('refuses status and file outside a repository, and below the top of one', async () => {
    const ws = workspace({ c: makeHome(), sub: path.join(repo(), 'src') });
    expect(await codeOf(() => ws.status('c', 'head'))).toBe('no_repo');
    expect(await codeOf(() => ws.file('c', 'x', 'head'))).toBe('no_repo');
    expect(await codeOf(() => ws.status('sub', 'head'))).toBe('no_repo');
  });
});

describe('Workspace watch', () => {
  afterEach(cleanHomes);

  const viewer = (): Viewer & { events: Event[] } => {
    const v = { kind: 'app' as const, events: [] as Event[], send: (e: Event) => { v.events.push(e); }, backlog: () => 0 };
    return v;
  };

  // a watcher that has just started may not hear yet, so a write that must be heard is made again until it is
  const heard = (v: { events: Event[] }, n: number, write: () => void): Promise<void> =>
    waitFor(() => { if (v.events.length < n) write(); return v.events.length >= n; }, 10_000);

  it('tells a watching viewer about a burst of writes, and nothing after unwatch', async () => {
    const dir = repo();
    const ws = workspace({ c: dir });
    const v = viewer();
    ws.watch('c', v);
    await heard(v, 1, () => fs.writeFileSync(path.join(dir, 'a.txt'), 'first\n'));
    expect(v.events[0]).toEqual({ event: 'repo.changed', data: { id: 'c' } });
    await new Promise((r) => setTimeout(r, 600));
    const base = v.events.length;
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x\n');
    await waitFor(() => v.events.length > base, 5000);
    // the file system may hand the writes over in more than one batch; each batch is one event at most
    await new Promise((r) => setTimeout(r, 600));
    expect(v.events.length).toBeLessThanOrEqual(base + 2);
    const before = v.events.length;
    ws.unwatch('c', v);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'z\n');
    await new Promise((r) => setTimeout(r, 600));
    expect(v.events.length).toBe(before);
    ws.close();
  });

  it('watches only the top of a folder outside git, so what churns below it stays quiet', async () => {
    const dir = makeHome();
    const deep = path.join(dir, '.claude/projects/x');
    fs.mkdirSync(deep, { recursive: true });
    const ws = workspace({ c: dir });
    const v = viewer();
    ws.watch('c', v);
    await heard(v, 1, () => fs.writeFileSync(path.join(dir, 'top.txt'), 'x\n'));
    await new Promise((r) => setTimeout(r, 600));
    const before = v.events.length;
    for (let i = 0; i < 10; i++) {
      fs.appendFileSync(path.join(deep, 's.jsonl'), '{"x":1}\n');
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 600));
    expect(v.events.length).toBe(before);
    ws.close();
  });

  it('watches all of a folder once git is set up in it', async () => {
    const dir = makeHome();
    fs.mkdirSync(path.join(dir, 'src'));
    const ws = workspace({ c: dir });
    const v = viewer();
    ws.watch('c', v);
    await heard(v, 1, () => fs.writeFileSync(path.join(dir, 'top.txt'), 'x\n'));
    sh(dir, 'init', '-q');
    await new Promise((r) => setTimeout(r, 600));
    await heard(v, v.events.length + 1, () => fs.writeFileSync(path.join(dir, 'src/a.txt'), `${Math.random()}\n`));
    ws.close();
  });

  it('drops every watch of a viewer that leaves', async () => {
    const dir = repo();
    const ws = workspace({ c: dir, d: dir });
    const v = viewer();
    ws.watch('c', v);
    ws.watch('d', v);
    ws.unwatchAll(v);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
    await new Promise((r) => setTimeout(r, 600));
    expect(v.events).toEqual([]);
    ws.close();
  });

  it('says nothing about ignored paths or git housekeeping, and hears a commit', async () => {
    const dir = repo();
    const ws = workspace({ c: dir });
    const v = viewer();
    ws.watch('c', v);
    // a file that counts first: the silence after the ignored writes is then silence, not an event still on its way
    await heard(v, 1, () => fs.writeFileSync(path.join(dir, 'a.txt'), 'seen\n'));
    await new Promise((r) => setTimeout(r, 600));
    const before = v.events.length;
    fs.writeFileSync(path.join(dir, 'build/out.js'), 'x');
    fs.writeFileSync(path.join(dir, '.git/scratch'), 'x');
    await new Promise((r) => setTimeout(r, 600));
    expect(v.events.length).toBe(before);
    sh(dir, 'commit', '-q', '--allow-empty', '-m', 'second');
    await waitFor(() => v.events.length === before + 1, 5000);
    ws.close();
  });

  it('hears a file being staged, which moves its letter in the list', async () => {
    const dir = repo();
    const ws = workspace({ c: dir });
    const v = viewer();
    ws.watch('c', v);
    await heard(v, 1, () => fs.writeFileSync(path.join(dir, 'new.txt'), 'x\n'));
    await new Promise((r) => setTimeout(r, 600));
    const before = v.events.length;
    sh(dir, 'add', 'new.txt');
    await waitFor(() => v.events.length === before + 1, 5000);
    ws.close();
  });

  it('follows a character whose root moves, and lets go of one that is gone', async () => {
    const a = repo();
    const b = repo();
    const roots: Record<string, string> = { c: a };
    const ws = workspace(roots);
    const v = viewer();
    ws.watch('c', v);
    roots.c = b;
    ws.retarget();
    expect(v.events).toEqual([{ event: 'repo.changed', data: { id: 'c' } }]);
    fs.writeFileSync(path.join(a, 'a.txt'), 'old root\n');
    await new Promise((r) => setTimeout(r, 600));
    expect(v.events.length).toBe(1);
    await heard(v, 2, () => fs.writeFileSync(path.join(b, 'a.txt'), 'new root\n'));
    await new Promise((r) => setTimeout(r, 600));
    const before = v.events.length;
    delete roots.c;
    ws.retarget();
    fs.writeFileSync(path.join(b, 'a.txt'), 'gone\n');
    await new Promise((r) => setTimeout(r, 600));
    expect(v.events.length).toBe(before);
    ws.close();
  });

  const watcherOf = (ws: Workspace, id: string): fs.FSWatcher =>
    (ws as unknown as { watches: Map<string, { watcher?: fs.FSWatcher }> }).watches.get(id)!.watcher!;

  it('takes the watch up again after the watcher fails', async () => {
    const dir = repo();
    const ws = workspace({ c: dir });
    const v = viewer();
    ws.watch('c', v);
    watcherOf(ws, 'c').emit('error', new Error('boom'));
    ws.retarget();
    expect(v.events).toEqual([{ event: 'repo.changed', data: { id: 'c' } }]);
    await heard(v, 2, () => fs.writeFileSync(path.join(dir, 'a.txt'), 'after\n'));
    ws.close();
  });

  it('keeps the viewer through a root that is not there yet, and watches it when it appears', async () => {
    const roots: Record<string, string> = { c: repo() };
    const later = path.join(makeHome(), 'later');
    const ws = workspace(roots);
    const v = viewer();
    ws.watch('c', v);
    roots.c = later;
    ws.retarget();
    expect(v.events).toEqual([]);
    fs.mkdirSync(later);
    ws.retarget();
    expect(v.events).toEqual([{ event: 'repo.changed', data: { id: 'c' } }]);
    await heard(v, 2, () => fs.writeFileSync(path.join(later, 'x.txt'), 'x\n'));
    ws.close();
  });
});

describe('Workspace docs', () => {
  afterEach(cleanHomes);

  function setup() {
    const home = makeHome();
    const docs = path.join(home, 'docs'), dir = path.join(docs, 'islands/i1'), repoDir = path.join(home, 'repo');
    fs.mkdirSync(repoDir);
    const ws = new Workspace((id) => ({ 'r:docs': dir, 'r:repo': repoDir })[id] ?? (() => { throw new Error(`no ${id}`); })(), silentLogger, () => [], [docs]);
    return { ws, dir, repoDir };
  }

  it('creates a file, making its folder on the way, and refuses one that is there', async () => {
    const { ws, dir } = setup();
    const r = ws.create('r:docs', 'plan.md', 'hello');
    expect(fs.readFileSync(path.join(dir, 'plan.md'), 'utf8')).toBe('hello');
    expect(r.mtimeMs).toBe(fs.statSync(path.join(dir, 'plan.md')).mtimeMs);
    expect(await codeOf(() => ws.create('r:docs', 'plan.md', 'again'))).toBe('exists');
    expect(fs.readFileSync(path.join(dir, 'plan.md'), 'utf8')).toBe('hello');
  });

  it('renames a file and refuses a name that is taken', async () => {
    const { ws, dir } = setup();
    ws.create('r:docs', 'a.md', 'A');
    ws.create('r:docs', 'b.md', 'B');
    expect(await codeOf(() => ws.rename('r:docs', 'a.md', 'b.md'))).toBe('exists');
    ws.rename('r:docs', 'a.md', 'c.md');
    expect(fs.readdirSync(dir).sort()).toEqual(['b.md', 'c.md']);
    expect(await codeOf(() => ws.rename('r:docs', 'gone.md', 'd.md'))).toBe('not_found');
  });

  it('deletes a file, and says when there is none', async () => {
    const { ws, dir } = setup();
    ws.create('r:docs', 'a.md', 'A');
    ws.remove('r:docs', 'a.md');
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(await codeOf(() => ws.remove('r:docs', 'a.md'))).toBe('not_found');
  });

  it('answers only for a docs folder', async () => {
    const { ws, repoDir } = setup();
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'keep');
    expect(await codeOf(() => ws.create('r:repo', 'new.md', 'x'))).toBe('invalid');
    expect(await codeOf(() => ws.rename('r:repo', 'README.md', 'x.md'))).toBe('invalid');
    expect(await codeOf(() => ws.remove('r:repo', 'README.md'))).toBe('invalid');
    expect(fs.readdirSync(repoDir)).toEqual(['README.md']);
  });

  it('answers for every tree it was given, the agent profiles as much as the docs', () => {
    const home = makeHome();
    const profiles = path.join(home, 'agent-profiles');
    const ws = new Workspace(() => profiles, silentLogger, () => [], [path.join(home, 'docs'), profiles]);
    ws.create('r:p', 'critic.md', 'You are a critic.');
    expect(fs.readFileSync(path.join(profiles, 'critic.md'), 'utf8')).toBe('You are a critic.');
    ws.rename('r:p', 'critic.md', 'judge.md');
    ws.remove('r:p', 'judge.md');
    expect(fs.readdirSync(profiles)).toEqual([]);
  });

  it('refuses a nested path, a climb, a name that is not .md and one carrying a control character', async () => {
    const { ws } = setup();
    // a newline in a name would forge a line of its own in every brief that lists the doc
    for (const rel of ['sub/a.md', '../a.md', 'a.txt', '.md', '', 'a\nb.md', 'a\u0000b.md'])
      expect(await codeOf(() => ws.create('r:docs', rel, 'x'))).toBe('invalid');
    ws.create('r:docs', 'a.md', 'A');
    expect(await codeOf(() => ws.rename('r:docs', 'a.md', 'sub/b.md'))).toBe('invalid');
    expect(await codeOf(() => ws.rename('r:docs', 'a.md', 'b\nc.md'))).toBe('invalid');
  });

  it('refuses create, rename and delete on a symlinked .md that leads outside the docs folder', async () => {
    const { ws, dir } = setup();
    const home = path.dirname(path.dirname(path.dirname(dir)));
    const outside = path.join(home, 'outside.md');
    fs.writeFileSync(outside, 'OUTSIDE');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'link.md'));
    expect(await codeOf(() => ws.create('r:docs', 'link.md', 'new'))).toBe('invalid');
    expect(await codeOf(() => ws.rename('r:docs', 'link.md', 'renamed.md'))).toBe('invalid');
    expect(await codeOf(() => ws.remove('r:docs', 'link.md'))).toBe('invalid');
    expect(fs.readFileSync(outside, 'utf8')).toBe('OUTSIDE');
  });

  it('refuses create, rename and delete through a folder that is a link out of the docs tree', async () => {
    const home = makeHome();
    const docs = path.join(home, 'docs'), outside = path.join(home, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'victim.md'), 'VICTIM');
    fs.mkdirSync(path.join(docs, 'islands'), { recursive: true });
    fs.symlinkSync(outside, path.join(docs, 'islands/link'));
    const ws = new Workspace(() => path.join(docs, 'islands/link'), silentLogger, () => [], [docs]);
    expect(await codeOf(() => ws.create('r:docs', 'new.md', 'x'))).toBe('invalid');
    expect(await codeOf(() => ws.rename('r:docs', 'victim.md', 'moved.md'))).toBe('invalid');
    expect(await codeOf(() => ws.remove('r:docs', 'victim.md'))).toBe('invalid');
    expect(fs.readdirSync(outside)).toEqual(['victim.md']);
    expect(fs.readFileSync(path.join(outside, 'victim.md'), 'utf8')).toBe('VICTIM');
  });

  it('answers for nothing when it was given no docs path', async () => {
    const dir = makeHome();
    const ws = new Workspace(() => dir, silentLogger);
    expect(await codeOf(() => ws.create('r:x', 'a.md', 'x'))).toBe('invalid');
  });
});
