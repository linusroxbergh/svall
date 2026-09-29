import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyState, FleetConfig, MAX_MANIFEST_BYTES, type Character, type FleetState, type GitCheckout, type GitGraph, type MachineId, type Warning } from '@svall/protocol';
import { gitIndexDigest } from '../../src/handover/git-graph.js';
import { canonicalDigest, canonicalJson, hashStream } from '../../src/handover/hash.js';
import { buildInventory, DEFAULT_EXCLUDES, GIT_DIR_KEEP_RULES, GIT_KEEP_RULES, type Inventory, type MachineMaps } from '../../src/handover/inventory.js';
import { buildManifest, landingFolder, manifestDigest, readManifest, realScanFs, scanPath, spaceNeed, summarize, writeManifest, type ScanFs } from '../../src/handover/manifest.js';

const made: string[] = [];
const tmp = (): string => { const d = fs.realpathSync(fs.mkdtempSync('/tmp/svall-t-')); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const MAC = '9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const TRIFT = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const FLEET = FleetConfig.parse({ id: '5e1f0b1c-2d3e-4f50-8617-9a0b1c2d3e4f', home: { cwd: '~/.svall/home' } });
const SESSION = '11111111-1111-4111-8111-111111111111';
const LINE = (cwd: string): string => `${JSON.stringify({ type: 'user', cwd, sessionId: SESSION, version: '2.1.280', message: { role: 'user', content: 'hi' } })}\n`;
const ROLLOUT = 'sessions/2026/09/21/rollout-2026-09-21T19-28-46-01a0aaaa-bbbb-7ccc-8ddd-eeeeffff0000.jsonl';
const sha = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');
const has = (bin: string, arg: string): boolean => { try { execFileSync(bin, [arg], { stdio: 'ignore' }); return true; } catch { return false; } };
const hasGit = has('git', '--version');
const hasRsync = has('rsync', '--version');
// CI sets SVALL_REQUIRE_RSYNC, and there a missing rsync fails the file instead of skipping what needs it
if (!hasRsync && process.env.SVALL_REQUIRE_RSYNC) throw new Error('no rsync on PATH');
const git = (cwd: string, ...args: string[]): string => execFileSync('git', [
  '-c', 'user.name=Probe', '-c', 'user.email=probe@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args,
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe('canonical json', () => {
  it('sorts every object key and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x', { d: 2, c: 1 }] })).toBe('{"a":[true,null,"x",{"c":1,"d":2}],"b":1}');
  });

  it('gives one digest whatever order the keys were inserted in', () => {
    const one = { roots: [{ id: 'r', files: [] }], fleet: { id: 'f', home: { cwd: '~' } } };
    const two = { fleet: { home: { cwd: '~' }, id: 'f' }, roots: [{ files: [], id: 'r' }] };
    expect(canonicalDigest(one)).toBe(canonicalDigest(two));
    expect(canonicalDigest(one)).toBe(sha(canonicalJson(two)));
  });

  it('leaves out an absent optional field and refuses what JSON cannot say', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: new Date(0) })).toThrow();
    expect(() => canonicalJson([undefined])).toThrow();
  });
});

describe('hashStream', () => {
  it('hashes a stream a chunk at a time to the digest of the whole', async () => {
    async function* chunks() { yield Buffer.from('hello '); yield Buffer.from('world'); }
    expect(await hashStream(chunks())).toEqual({ sha256: sha('hello world'), size: 11 });
  });
});

// a repository with a nested worktree, a plain folder, and a transcript for one agent
function seed() {
  const base = tmp();
  const mac = path.join(base, 'mac');
  const repo = path.join(mac, 'app');
  const nested = path.join(repo, '.claude/worktrees/w1');
  const transcript = path.join(mac, `.claude/projects/app/${SESSION}.jsonl`);
  for (const d of [nested, path.join(repo, 'node_modules/x'), path.join(repo, 'src'), path.dirname(transcript), path.join(mac, '.svall/home')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/index.ts'), 'export {};\n');
  fs.writeFileSync(path.join(repo, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(repo, 'tsconfig.tsbuildinfo'), '{}');
  fs.writeFileSync(path.join(repo, 'node_modules/x/index.js'), '');
  fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=1\n');
  fs.writeFileSync(path.join(nested, 'wt.txt'), 'worktree');
  fs.writeFileSync(transcript, LINE(nested));
  fs.symlinkSync('src/index.ts', path.join(repo, 'entry'));
  fs.symlinkSync('/nowhere/at/all', path.join(repo, 'dangling'));
  fs.writeFileSync(path.join(mac, '.svall/.env'), 'ANTHROPIC_API_KEY=x\n');
  const maps: MachineMaps = {
    source: { machineId: MAC, home: mac, fleetHome: path.join(mac, '.svall') },
    destination: { machineId: TRIFT, home: mac, fleetHome: path.join(mac, '.svall'), agentHomes: { claude: path.join(mac, '.claude'), codex: path.join(mac, '.codex') } },
  };
  const state = emptyState();
  state.characters = {
    main: char('main', { cwd: repo, repo: { root: repo, mainRoot: repo, branch: 'main', isWorktree: false } }),
    w1: char('w1', {
      cwd: nested, repo: { root: nested, mainRoot: repo, branch: 'w1', isWorktree: true },
      agent: { kind: 'claude', sessionId: SESSION, transcriptPath: transcript, status: 'idle', lastActivityAt: 0 },
    }),
  };
  return { base, mac, repo, nested, transcript, maps, state };
}

const inventory = (s: ReturnType<typeof seed>, fleet: FleetConfig = FLEET): Inventory => buildInventory(s.state, { fleet }, s.maps);
const HEADER = { transactionId: 't1', generation: 4 };

describe('buildManifest', () => {
  it('lists each carried file once with its mode, size, mtime and hash, and a link as its text', async () => {
    const s = seed();
    const { manifest, blockers } = await buildManifest(inventory(s), HEADER);
    expect(blockers).toEqual([]);
    const repo = manifest.roots.find((r) => r.path === s.repo)!;
    expect(repo).toMatchObject({ kind: 'repo', entry: 'dir' });
    expect(repo.files.map((f) => f.path)).toEqual(['.claude/worktrees/w1/wt.txt', '.env', 'dangling', 'entry', 'run.sh', 'src/index.ts']);
    const run = fs.statSync(path.join(s.repo, 'run.sh'));
    expect(repo.files.find((f) => f.path === 'run.sh')).toEqual({
      type: 'file', path: 'run.sh', mode: 0o755, size: 10, mtimeMs: Math.trunc(run.mtimeMs), sha256: sha('#!/bin/sh\n'),
    });
    expect(repo.files.find((f) => f.path === 'entry')).toEqual({ type: 'symlink', path: 'entry', target: 'src/index.ts' });
    expect(repo.files.find((f) => f.path === 'dangling')).toEqual({ type: 'symlink', path: 'dangling', target: '/nowhere/at/all' });
    // the nested worktree is carried inside its main checkout and still listed for the Git import to check
    expect(manifest.roots.find((r) => r.path === s.nested)).toEqual({
      id: expect.any(String), kind: 'worktree', entry: 'dir', path: s.nested, foldedInto: repo.id, files: [],
    });
    // the transcript lands where it was, under the same agent home
    expect(manifest.sessions).toEqual([{
      characterId: 'w1', agent: 'claude', sessionId: SESSION, sourcePath: s.transcript, adapter: 1,
      sourceHome: path.join(s.mac, '.claude'), destinationHome: path.join(s.mac, '.claude'), destinationPath: s.transcript,
      files: [expect.objectContaining({ type: 'file', path: `projects/app/${SESSION}.jsonl`, sha256: sha(LINE(s.nested)) })],
    }]);
    expect(manifest).toMatchObject({ version: 1, transactionId: 't1', generation: 4, fromMachineId: MAC, toMachineId: TRIFT, home: s.mac, fleet: FLEET });
  });

  it('warns that repository and fleet .env files travel, and carries the fleet one only when asked', async () => {
    const s = seed();
    const without = await buildManifest(inventory(s), HEADER);
    expect(without.warnings).toEqual([expect.objectContaining({ code: 'env_file', entity: { kind: 'root', id: without.manifest.roots.find((r) => r.kind === 'repo')!.id } })]);
    expect(without.manifest.roots.some((r) => r.kind === 'env')).toBe(false);
    const fleet = { ...FLEET, handover: { ...FLEET.handover, transferFleetEnv: true } };
    const withEnv = await buildManifest(inventory(s, fleet), HEADER);
    expect(withEnv.warnings.map((w) => w.code)).toEqual(['env_file', 'env_file']);
    expect(withEnv.manifest.roots.find((r) => r.kind === 'env')).toMatchObject({
      entry: 'file', path: path.join(s.mac, '.svall/.env'), files: [expect.objectContaining({ path: '', sha256: sha('ANTHROPIC_API_KEY=x\n') })],
    });
  });

  it('warns that the logins other tools keep in plain text travel with a folder that holds them', async () => {
    const s = seed();
    const dotfiles = path.join(s.mac, 'dotfiles');
    const held = ['.netrc', '.git-credentials', '.config/gh/hosts.yml', '.aws/credentials', '.docker/config.json'];
    for (const rel of held) {
      fs.mkdirSync(path.dirname(path.join(dotfiles, rel)), { recursive: true });
      fs.writeFileSync(path.join(dotfiles, rel), 'secret\n');
    }
    fs.writeFileSync(path.join(s.mac, '.netrc'), 'machine example.com password x\n');
    s.state.characters.dots = char('dots', { cwd: dotfiles, context: [{ kind: 'file', ref: path.join(s.mac, '.netrc'), label: '', source: 'manual' }] });
    const { manifest, warnings } = await buildManifest(inventory(s), HEADER);
    const idOf = (p: string): string => manifest.roots.find((r) => r.path === p)!.id;
    expect(warnings.filter((w) => w.code === 'credential_file')).toEqual([
      { code: 'credential_file', message: expect.stringContaining(`${dotfiles} holds ${[...held].sort().slice(0, 3).join('; ')}; and 2 more`), entity: { kind: 'root', id: idOf(dotfiles) } },
      { code: 'credential_file', message: expect.stringContaining(`${path.join(s.mac, '.netrc')} is`), entity: { kind: 'root', id: idOf(path.join(s.mac, '.netrc')) } },
    ].sort((a, b) => (a.entity.id < b.entity.id ? -1 : 1)));
  });

  it('holds no fleet key, and no secret a carried .env holds, even with the fleet .env carried', async () => {
    const s = seed();
    const home = path.join(s.mac, '.svall');
    const secrets = { token: 'tok-9f8e7d6c5b4a', 'mobile-key': 'phone-0f1e2d3c4b', 'vapid.json': '{"privateKey":"vapid-5a6b7c8d9e"}' };
    for (const [name, text] of Object.entries(secrets)) fs.writeFileSync(path.join(home, name), text);
    fs.writeFileSync(path.join(home, '.env'), 'ANTHROPIC_API_KEY=sk-ant-fleet-7e6d5c4b3a\n');
    fs.writeFileSync(path.join(s.repo, '.env'), 'TOKEN=repo-env-2b3c4d5e6f\n');
    const fleet = { ...FLEET, handover: { ...FLEET.handover, transferFleetEnv: true } };
    const { manifest } = await buildManifest(inventory(s, fleet), HEADER);
    const text = canonicalJson(manifest);
    for (const value of ['tok-9f8e7d6c5b4a', 'phone-0f1e2d3c4b', 'vapid-5a6b7c8d9e', 'sk-ant-fleet-7e6d5c4b3a', 'repo-env-2b3c4d5e6f']) expect(text).not.toContain(value);
    for (const name of Object.keys(secrets)) expect(text).not.toContain(path.join(home, name));
  });

  it('blocks a file name with a control character and leaves the file out', async () => {
    const s = seed();
    fs.writeFileSync(path.join(s.repo, 'src/a\nb.ts'), '');
    const { manifest, blockers } = await buildManifest(inventory(s), HEADER);
    expect(blockers).toEqual([expect.objectContaining({ code: 'path_unsupported', message: expect.stringContaining('"src/a\\nb.ts"') })]);
    expect(manifest.roots.find((r) => r.kind === 'repo')!.files.map((f) => f.path)).not.toContain('src/a\nb.ts');
  });

  it('blocks a name that is not UTF-8, and a file it cannot read, and skips one that vanished', async () => {
    const s = seed();
    const fail = (code: string) => Object.assign(new Error(code), { code });
    const fake: ScanFs = {
      ...realScanFs,
      readdir: async (p) => (p === path.join(s.repo, 'src') ? [...await realScanFs.readdir(p), Buffer.from([0x66, 0xff])] : realScanFs.readdir(p)),
      lstat: (p) => (p === path.join(s.repo, 'run.sh') ? Promise.reject(fail('ENOENT')) : realScanFs.lstat(p)),
      read: (p) => (p === path.join(s.repo, 'src/index.ts') ? { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(fail('EACCES')) }) } : realScanFs.read(p)),
    };
    const { manifest, blockers } = await buildManifest(inventory(s), HEADER, fake);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ code: 'path_unsupported', message: expect.stringMatching(/2 paths.*not valid UTF-8.*EACCES/) });
    expect(manifest.roots.find((r) => r.kind === 'repo')!.files.map((f) => f.path)).toEqual(['.claude/worktrees/w1/wt.txt', '.env', 'dangling', 'entry']);
  });

  it('blocks a link whose text holds a control character and leaves the link out', async () => {
    const s = seed();
    fs.symlinkSync('src/a\tb.ts', path.join(s.repo, 'tabbed'));
    const { manifest, blockers } = await buildManifest(inventory(s), HEADER);
    expect(blockers).toEqual([expect.objectContaining({ code: 'path_unsupported', message: expect.stringContaining('"tabbed"') })]);
    expect(manifest.roots.find((r) => r.kind === 'repo')!.files.map((f) => f.path)).not.toContain('tabbed');
  });

  it('blocks a transcript that is gone and a repository that is gone, and drops a missing context file', async () => {
    const s = seed();
    fs.rmSync(s.transcript);
    s.state.characters.main.context = [{ kind: 'file', ref: path.join(s.base, 'mac/gone.md'), label: '', source: 'manual' }];
    const other = path.join(s.mac, 'other');
    s.state.characters.gone = char('gone', { cwd: other, repo: { root: other, mainRoot: other, branch: 'main', isWorktree: false } });
    const { manifest, blockers } = await buildManifest(inventory(s), HEADER);
    expect(blockers.map((b) => b.code)).toEqual(['transcript_missing', 'worktree_unresolved']);
    expect(manifest.sessions).toEqual([]);
    expect(manifest.roots.map((r) => r.kind).sort()).toEqual(['home', 'repo', 'worktree']);
  });

  it('comes to one digest whatever order the state was built or the disk was read in', async () => {
    const s = seed();
    const rollout = path.join(s.mac, '.codex', ROLLOUT);
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.copyFileSync(path.join(import.meta.dirname, '../fixtures/handover/codex/rollout.jsonl'), rollout);
    s.state.characters.main.agent = { kind: 'codex', sessionId: '01a0aaaa-bbbb-7ccc-8ddd-eeeeffff0000', transcriptPath: rollout, status: 'idle', lastActivityAt: 0 };
    const first = await buildManifest(inventory(s), HEADER);
    expect(first.manifest.sessions).toHaveLength(2);
    const reversed: FleetState = { ...s.state, characters: Object.fromEntries(Object.entries(s.state.characters).reverse()) };
    const backwards: ScanFs = { ...realScanFs, readdir: async (p) => (await realScanFs.readdir(p)).reverse() };
    const second = await buildManifest(buildInventory(reversed, { fleet: FLEET }, s.maps), HEADER, backwards);
    expect(second.digest).toBe(first.digest);
    expect(manifestDigest(JSON.parse(JSON.stringify(second.manifest)))).toBe(first.digest);
  });

  it('hashes several files at once, never more than eight, and lists them in path order whatever order the reads end in', async () => {
    const dir = tmp();
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(2, '0')}`), `file ${i}\n`);
    let open = 0;
    let most = 0;
    const slow: ScanFs = {
      ...realScanFs,
      read: (p) => (async function* () {
        most = Math.max(most, ++open);
        try {
          // later names finish first
          await new Promise((r) => { setTimeout(r, 40 - Number(path.basename(p).slice(1))); });
          yield* realScanFs.read(p);
        } finally { open--; }
      })(),
    };
    const scan = await scanPath(dir, () => false, slow);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(8);
    expect(scan!.files.map((f) => f.path)).toEqual([...Array(40).keys()].map((i) => `f${String(i).padStart(2, '0')}`));
    expect(scan!.files.every((f, i) => f.type === 'file' && f.sha256 === sha(`file ${i}\n`))).toBe(true);
  });

  it('reads a session file a chunk at a time, and keeps none of its chunks once read', async () => {
    const s = seed();
    // a reader that refills one buffer for each chunk: a scan that held a chunk would see it change under it
    const shared = Buffer.alloc(4);
    const reused: ScanFs = {
      ...realScanFs,
      read: (p) => (p === s.transcript ? (async function* () { for (const word of ['one ', 'two ', 'six ']) { shared.write(word); yield shared; } })() : realScanFs.read(p)),
    };
    const { manifest } = await buildManifest(inventory(s), HEADER, reused);
    expect(manifest.sessions[0].files).toEqual([expect.objectContaining({ path: `projects/app/${SESSION}.jsonl`, size: 12, sha256: sha('one two six ') })]);
  });

  it('changes its digest when a file does, and when it names a transaction', async () => {
    const s = seed();
    const before = await buildManifest(inventory(s), HEADER);
    fs.writeFileSync(path.join(s.repo, 'src/index.ts'), 'export const x = 1;\n');
    expect((await buildManifest(inventory(s), HEADER)).digest).not.toBe(before.digest);
    const preflight = await buildManifest(inventory(s), { generation: 4 });
    expect(preflight.manifest.transactionId).toBeUndefined();
    expect(preflight.digest).not.toBe((await buildManifest(inventory(s), HEADER)).digest);
  });
});

// a real repository with a branch and a worktree both named like a default exclude
function seedGit() {
  const base = tmp();
  const mac = path.join(base, 'mac');
  const repo = path.join(mac, 'app');
  const worktree = path.join(mac, 'build');
  fs.mkdirSync(path.join(repo, 'build'), { recursive: true });
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  fs.writeFileSync(path.join(repo, 'build/out.js'), 'built');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'branch', 'build/x');
  git(repo, 'worktree', 'add', '-q', worktree, '-b', 'wt');
  const maps: MachineMaps = {
    source: { machineId: MAC, home: mac, fleetHome: path.join(mac, '.svall') },
    destination: { machineId: TRIFT, home: mac, fleetHome: path.join(mac, '.svall') },
  };
  const state = emptyState();
  state.characters = {
    main: char('main', { cwd: repo, repo: { root: repo, mainRoot: repo, branch: 'main', isWorktree: false } }),
    wt: char('wt', { cwd: worktree, repo: { root: worktree, mainRoot: repo, branch: 'wt', isWorktree: true } }),
  };
  return { base, repo, worktree, maps, state };
}

describe('a Git repository', () => {
  it.skipIf(!hasGit)('keeps every ref and worktree record under .git, whatever the excludes match (needs git)', async () => {
    const g = seedGit();
    const { manifest, blockers } = await buildManifest(buildInventory(g.state, { fleet: FLEET }, g.maps), HEADER);
    expect(blockers).toEqual([]);
    const paths = manifest.roots.find((r) => r.path === g.repo)!.files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['.git/refs/heads/build/x', '.git/worktrees/build/HEAD', '.git/worktrees/build/index', '.git/worktrees/build/gitdir']));
    // the working tree's own build output is still a cache
    expect(paths).not.toContain('build/out.js');
    expect(manifest.roots.find((r) => r.path === g.worktree)!.files.map((f) => f.path)).toContain('.git');
  });

  it.skipIf(!hasGit || !hasRsync)('lists exactly what rsync copies with the git keep rules ahead of the excludes (needs git and rsync)', async () => {
    const g = seedGit();
    const { manifest } = await buildManifest(buildInventory(g.state, { fleet: FLEET }, g.maps), HEADER);
    const rules = path.join(g.base, 'rules');
    fs.writeFileSync(rules, [...GIT_KEEP_RULES, ...DEFAULT_EXCLUDES].join('\n') + '\n');
    const copied = execFileSync('rsync', ['-a', '--dry-run', '--out-format=%n', `--exclude-from=${rules}`, `${g.repo}/`, path.join(g.base, 'dst/')], { encoding: 'utf8' })
      .split('\n').filter((l) => l && !l.endsWith('/'));
    expect(copied.sort()).toEqual(manifest.roots.find((r) => r.path === g.repo)!.files.map((f) => f.path).sort());
  });
});

describe('the discovered Git graphs', () => {
  const checkout = (p: string, gitDir: string): GitCheckout =>
    ({ path: p, gitDir, head: 'a'.repeat(40), branch: 'refs/heads/main', status: [], index: 'b'.repeat(64), characters: [] });

  // a bare repository whose refs and worktree records carry names like the default excludes
  function bare(s: ReturnType<typeof seed>) {
    const dir = path.join(s.mac, 'tool.git');
    const wt = path.join(s.mac, 'tool-wt');
    for (const f of ['HEAD', 'refs/heads/build/x', 'worktrees/dist/HEAD', 'objects/node_modules/ab']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), f);
    }
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(dir, 'worktrees/dist')}\n`);
    s.state.characters.tool = char('tool', { cwd: wt });
    const graph: GitGraph = { id: 'g_tool', commonDir: dir, worktrees: [checkout(wt, path.join(dir, 'worktrees/dist'))], unused: [], stash: [] };
    const warning: Warning = { code: 'worktree_unused', message: 'an unused worktree', entity: { kind: 'git', id: 'g_tool' } };
    return { dir, wt, discovery: { graphs: [graph], blockers: [], warnings: [warning] } };
  }

  it('carries each graph and what discovery warned of, and reads no exclude inside a Git directory carried on its own', async () => {
    const s = seed();
    const b = bare(s);
    const { manifest, warnings } = await buildManifest(buildInventory(s.state, { fleet: FLEET }, s.maps, b.discovery), HEADER);
    expect(manifest.git).toEqual(b.discovery.graphs);
    expect(warnings).toContainEqual(b.discovery.warnings[0]);
    const root = manifest.roots.find((r) => r.path === b.dir)!;
    expect(root).toMatchObject({ kind: 'gitdir', path: b.dir });
    expect(root.files.map((f) => f.path)).toEqual(['HEAD', 'objects/node_modules/ab', 'refs/heads/build/x', 'worktrees/dist/HEAD']);
  });

  // the layout some keep: a bare repository with its checkout inside it
  function holding(s: ReturnType<typeof seed>) {
    const dir = path.join(s.mac, 'proj.git');
    const main = path.join(dir, 'main');
    for (const f of ['HEAD', 'config', 'refs/heads/build/x', 'logs/refs/heads/build/x', 'worktrees/main/HEAD', 'worktrees/main/index',
      'main/src.ts', 'main/node_modules/x/native.node', 'main/dist/out.js', 'main/app.tsbuildinfo']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), f);
    }
    fs.writeFileSync(path.join(main, '.git'), `gitdir: ${path.join(dir, 'worktrees/main')}\n`);
    s.state.characters.proj = char('proj', { cwd: main });
    const graph: GitGraph = { id: 'g_proj', commonDir: dir, worktrees: [checkout(main, path.join(dir, 'worktrees/main'))], unused: [], stash: [] };
    return { dir, main, discovery: { graphs: [graph], blockers: [], warnings: [] } };
  }

  it('carries a checkout inside a bare repository once, its caches left out and all of Git\'s own entries kept', async () => {
    const s = seed();
    const h = holding(s);
    const { manifest, blockers } = await buildManifest(buildInventory(s.state, { fleet: FLEET }, s.maps, h.discovery), HEADER);
    expect(blockers).toEqual([]);
    const root = manifest.roots.find((r) => r.path === h.dir)!;
    expect(manifest.roots.find((r) => r.path === h.main)).toMatchObject({ kind: 'worktree', foldedInto: root.id, files: [] });
    expect(root.files.map((f) => f.path)).toEqual([
      'HEAD', 'config', 'logs/refs/heads/build/x', 'main/.git', 'main/src.ts', 'refs/heads/build/x', 'worktrees/main/HEAD', 'worktrees/main/index',
    ]);
  });

  it.skipIf(!hasRsync)('lists exactly what rsync copies of a bare repository with its keep rules ahead of the excludes (needs rsync)', async () => {
    const s = seed();
    const h = holding(s);
    const { manifest } = await buildManifest(buildInventory(s.state, { fleet: FLEET }, s.maps, h.discovery), HEADER);
    const rules = path.join(s.base, 'rules');
    fs.writeFileSync(rules, [...GIT_KEEP_RULES, ...GIT_DIR_KEEP_RULES, ...DEFAULT_EXCLUDES].join('\n') + '\n');
    const copied = execFileSync('rsync', ['-a', '--dry-run', '--out-format=%n', `--exclude-from=${rules}`, `${h.dir}/`, path.join(s.base, 'dst/')], { encoding: 'utf8' })
      .split('\n').filter((l) => l && !l.endsWith('/'));
    expect(copied.sort()).toEqual(manifest.roots.find((r) => r.path === h.dir)!.files.map((f) => f.path).sort());
  });

  it('blocks a Git directory carried on its own that is gone', async () => {
    const s = seed();
    const b = bare(s);
    const inventory = buildInventory(s.state, { fleet: FLEET }, s.maps, b.discovery);
    fs.rmSync(b.dir, { recursive: true });
    const { blockers } = await buildManifest(inventory, HEADER);
    expect(blockers).toContainEqual({ code: 'worktree_unresolved', message: `${b.dir} no longer exists`, entity: { kind: 'root', id: inventory.roots.find((r) => r.kind === 'gitdir')!.id } });
  });

  it.skipIf(!hasGit)('names a Git index by its staged entries as well as its bytes (needs git)', async () => {
    const g = seedGit();
    const { manifest } = await buildManifest(buildInventory(g.state, { fleet: FLEET }, g.maps), HEADER);
    const files = manifest.roots.find((r) => r.path === g.repo)!.files;
    const index = files.find((f) => f.path === '.git/index');
    expect(index).toMatchObject({ gitIndex: gitIndexDigest(fs.readFileSync(path.join(g.repo, '.git/index'))) });
    expect(files.find((f) => f.path === '.git/worktrees/build/index')).toHaveProperty('gitIndex');
    expect(files.find((f) => f.path === 'a.txt')).not.toHaveProperty('gitIndex');
  });
});

describe('what a manifest adds up to', () => {
  it('counts the carried roots, files and bytes, and rounds each file up to a block for space', async () => {
    const s = seed();
    const { manifest, digest } = await buildManifest(inventory(s), HEADER);
    const carried = manifest.roots.filter((r) => !r.foldedInto);
    const files = [...carried.flatMap((r) => r.files), ...manifest.sessions.flatMap((x) => x.files)];
    const bytes = files.reduce((n, f) => n + (f.type === 'file' ? f.size : 0), 0);
    expect(summarize(manifest)).toEqual({ digest, roots: carried.length, files: files.length, bytes, sessions: 1 });
    const blocks = files.filter((f) => f.type === 'file' && f.size > 0).length;
    expect(spaceNeed(manifest)).toEqual({ [s.mac]: blocks * 4096 });
  });

  it('lists a file the scanner reads in under 160 bytes beyond its path, so the cap carries 128 MiB / (160 B + path) files', async () => {
    const dir = tmp();
    // paths as long as a deep monorepo's
    const rel = (i: number) => `packages/service-${i % 7}/src/components/widget-${String(i).padStart(6, '0')}.tsx`;
    for (let i = 0; i < 300; i++) {
      fs.mkdirSync(path.dirname(path.join(dir, rel(i))), { recursive: true });
      fs.writeFileSync(path.join(dir, rel(i)), `export const w${i} = ${i};\n`, { mode: 0o755 });
    }
    const { files } = (await scanPath(dir, () => false))!;
    expect(files).toHaveLength(300);
    // each number at its widest: every mode bit and a terabyte
    const widest = files.map((f) => (f.type === 'file' ? { ...f, mode: 0o7777, size: 2 ** 40 } : f));
    const paths = widest.reduce((n, f) => n + Buffer.byteLength(JSON.stringify(f.path)), 0);
    expect((Buffer.byteLength(JSON.stringify(widest)) - paths) / widest.length).toBeLessThan(160);
    expect(MAX_MANIFEST_BYTES / (160 + 100)).toBeGreaterThan(500_000);
  });

  it('counts a root outside the home against the folder it lands in, and a session against its agent home\'s', async () => {
    const s = seed();
    const { manifest } = await buildManifest(inventory(s), HEADER);
    const block = (n: number) => ({ type: 'file' as const, path: `f${n}`, mode: 0o644, size: 1, mtimeMs: 0, sha256: 'a'.repeat(64) });
    const outside = { ...manifest, roots: [{ id: 'r_x', kind: 'cwd' as const, entry: 'dir' as const, path: '/Volumes/work/x', files: [block(1), block(2)] }],
      sessions: manifest.sessions.map((x) => ({ ...x, destinationHome: '/opt/claude' })) };
    expect(landingFolder('/Volumes/work/x', s.mac)).toBe('/Volumes/work');
    expect(landingFolder(path.join(s.mac, 'deep/down/x'), s.mac)).toBe(s.mac);
    expect(spaceNeed(outside)).toEqual({ '/Volumes/work': 2 * 4096, '/opt': 4096 });
  });
});

describe('a manifest on disk', () => {
  it('is its canonical text at mode 0600, so the file hashes to its digest', async () => {
    const s = seed();
    const { manifest, digest } = await buildManifest(inventory(s), HEADER);
    const file = path.join(s.base, 'handover/manifest-t1.json');
    expect(writeManifest(file, manifest)).toBe(digest);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(sha(fs.readFileSync(file))).toBe(digest);
    expect(readManifest(file)).toEqual({ manifest, digest });
  });

  it('is never replaced by another manifest, and writing the same one again changes nothing', async () => {
    const s = seed();
    const { manifest } = await buildManifest(inventory(s), HEADER);
    const file = path.join(s.base, 'manifest.json');
    writeManifest(file, manifest);
    const before = fs.readFileSync(file);
    expect(() => writeManifest(file, manifest)).not.toThrow();
    expect(() => writeManifest(file, { ...manifest, generation: 5 })).toThrow(/already holds/);
    expect(fs.readFileSync(file)).toEqual(before);
  });
});

function char(id: string, o: Partial<Character>): Character {
  return {
    id, islandId: 'i1', cell: { x: 0, y: 0 }, name: id, note: '', portrait: 'fox', instructions: '', cwd: '/',
    context: [], shell: { lastOutputAt: 0 }, unread: false, ...o,
  };
}
