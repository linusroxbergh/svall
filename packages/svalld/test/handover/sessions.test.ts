import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyState, FleetConfig, type AgentKind, type Character, type MachineId, type ResumeFolder, type TransferSession } from '@svall/protocol';
import { applyHook } from '../../src/agent/reducer.js';
import { buildInventory, type MachineMaps } from '../../src/handover/inventory.js';
import { realStages } from '../../src/handover/durable.js';
import { buildManifest } from '../../src/handover/manifest.js';
import { importState } from '../../src/handover/validate.js';
import { claudeAdapter } from '../../src/handover/sessions/claude.js';
import { codexAdapter } from '../../src/handover/sessions/codex.js';
import { opencodeAdapter } from '../../src/handover/sessions/opencode.js';
import {
  HANDOVER_KINDS, adapterFor, agentAdapters, agentBlockers, cliRunner, installSession, placeTranscripts, probeAgent, realInstallFs,
  type AgentProbe, type AgentRun, type InstallFs,
} from '../../src/handover/sessions/registry.js';
import { repairBrief } from '../../src/handover/sessions/repair.js';
import { SessionError, type CliRun, type SessionFs } from '../../src/handover/sessions/types.js';
import { mergeCodexHooks, mergeHooks, mergeStatusLine, statusWrapper } from '../../src/agent-hooks.js';
import { codexHookCommand } from '../../src/codex/install.js';
import { opencodePaths } from '../../src/opencode/install.js';
import { resolvePaths } from '../../src/paths.js';
import { PRIVATE, profileHome } from '../../src/profile.js';
import { shq } from '../../src/text.js';
import { fakeEnv, held, hold, type Exported } from './fake-opencode.js';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/handover');
const made: string[] = [];
const tmp = (): string => { const d = fs.realpathSync(fs.mkdtempSync('/tmp/svall-s-')); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const fsOf: SessionFs = {
  lstat: (p) => fs.promises.lstat(p),
  readdir: (p) => fs.promises.readdir(p, { encoding: 'buffer' }),
};
const lines = (data: Buffer | string): string[] => data.toString().split('\n').filter(Boolean);
const rows = (data: Buffer | string): Record<string, any>[] => lines(data).map((l) => JSON.parse(l));
const sha = (data: Buffer | string): string => crypto.createHash('sha256').update(data).digest('hex');

/** Copies a fixture folder into a fresh agent home and returns that home. */
function home(fixture: string, name = '.claude'): string {
  const dir = path.join(tmp(), name);
  fs.cpSync(path.join(FIXTURES, fixture), dir, { recursive: true });
  return dir;
}

// the real sessions each release wrote, sanitized
const CLAUDE = [
  { version: '2.1.280', id: 'bf480ea6-5572-4554-8016-2dc5590f5bba', slug: '-Users-source-work-demo', agent: 'agent-a4906877eb9919cf5' },
  { version: '2.1.251', id: '1fb0d1a7-29a9-4159-a932-5ffd2da8faba', slug: '-home-source-work-demo', agent: 'agent-aec6de8cd1d2df280' },
] as const;
const CODEX = [
  { version: '0.155.1', file: 'sessions/2026/09/23/rollout-2026-09-23T08-44-38-01a0cd02-5930-73f0-ad55-add2b1effa04.jsonl', id: '01a0cd02-5930-73f0-ad55-add2b1effa04' },
  { version: '0.156.1', file: 'sessions/2026/09/23/rollout-2026-09-23T08-44-52-01a0cd02-8ea0-75c1-89b3-89718ecbd91f.jsonl', id: '01a0cd02-8ea0-75c1-89b3-89718ecbd91f' },
] as const;

describe('the adapter registry', () => {
  it('reads every Claude Code and Codex release from its adapter\'s minimum on, and none before', () => {
    for (const v of ['2.1.251', '2.1.280', '2.1.283', '2.2.0', '3.0.0', '2.1.300-beta.1']) expect(adapterFor('claude', v), v).toBe(claudeAdapter);
    for (const v of ['0.155.0', '0.156.1', '0.157.0', '1.0.0', '0.160.0-alpha.1']) expect(adapterFor('codex', v), v).toBe(codexAdapter);
    for (const v of ['2.1.250', '2.1.251-beta.1', '2.0.0']) expect(adapterFor('claude', v), v).toBeUndefined();
    for (const v of ['0.142.0-alpha.6', '0.142.0', '0.155.0-alpha.3']) expect(adapterFor('codex', v), v).toBeUndefined();
    for (const v of ['2.0.22', '2.1.0', '3.0.0']) expect(adapterFor('opencode', v), v).toBe(opencodeAdapter);
    for (const v of ['2.0.21', '1.14.0', '2.0.22-beta.1']) expect(adapterFor('opencode', v), v).toBeUndefined();
    expect(HANDOVER_KINDS).toEqual(['claude', 'codex', 'opencode']);
  });

  it('reports each installed CLI with the adapter that reads its sessions, 0 for none, and its login and hooks', () => {
    const probes: AgentProbe[] = [
      { kind: 'claude', version: '2.1.280', home: '/h/.claude', loggedIn: true, hooks: true },
      { kind: 'codex', version: '0.142.0', home: '/h/.codex', loggedIn: false, hooks: true },
    ];
    expect(agentAdapters(probes)).toEqual([
      { kind: 'claude', version: '2.1.280', adapter: 1, home: '/h/.claude', loggedIn: true, hooks: true },
      { kind: 'codex', version: '0.142.0', adapter: 0, home: '/h/.codex', loggedIn: false, hooks: true },
    ]);
  });
});

describe('Claude Code sessions', () => {
  it('finds a session from the exact transcript it recorded, in whatever config folder it ran with', async () => {
    const h = home('claude/2.1.280', '.claude-work');
    const { id, slug, agent } = CLAUDE[0];
    const project = path.join(h, 'projects', slug);
    // what belongs to this session, and what does not: file history stays, as its backups name machine-local files
    fs.mkdirSync(path.join(project, id, 'tool-results'), { recursive: true });
    fs.writeFileSync(path.join(project, id, 'tool-results', 'b1.txt'), 'a long tool result');
    fs.writeFileSync(path.join(project, id, 'tool-results', 'toolu_01AbC.json'), '{"items":[]}');
    fs.mkdirSync(path.join(h, 'file-history', id), { recursive: true });
    fs.writeFileSync(path.join(h, 'file-history', id, 'abc@v1'), 'alpha\n');
    fs.writeFileSync(path.join(project, '99999999-2222-4333-8444-555555555555.jsonl'), '{}\n');
    fs.writeFileSync(path.join(project, 'sessions-index.json'), '{}');
    fs.mkdirSync(path.join(h, 'session-env', id), { recursive: true });
    fs.writeFileSync(path.join(h, 'session-env', id, 'env'), 'SECRET=1');
    fs.mkdirSync(path.join(h, 'tasks', id), { recursive: true });
    fs.writeFileSync(path.join(h, '.credentials.json'), '{}');

    const found = await claudeAdapter.discover(path.join(project, `${id}.jsonl`), id, fsOf);
    expect(found).toEqual({
      home: h,
      transcript: `projects/${slug}/${id}.jsonl`,
      files: [
        `projects/${slug}/${id}.jsonl`,
        `projects/${slug}/${id}/subagents/${agent}.jsonl`,
        `projects/${slug}/${id}/subagents/${agent}.meta.json`,
        `projects/${slug}/${id}/tool-results/b1.txt`,
        `projects/${slug}/${id}/tool-results/toolu_01AbC.json`,
      ],
    });
  });

  it('finds every file of the session\'s own folder, whatever kind a release writes there', async () => {
    const h = home('claude/2.1.280');
    const { id, slug } = CLAUDE[0];
    const strays = ['auto-mode-classifier-error.txt', 'notes/plan.md', 'subagents/agent-a1.json', 'tool-results/p1/page-1.jpg'];
    for (const stray of strays) {
      const file = path.join(h, 'projects', slug, id, stray);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'x');
    }
    const { files } = await claudeAdapter.discover(path.join(h, 'projects', slug, `${id}.jsonl`), id, fsOf);
    for (const stray of strays) expect(files, stray).toContain(`projects/${slug}/${id}/${stray}`);
  });

  it('refuses a transcript that is missing, another session, outside a projects folder, or a link', async () => {
    const h = home('claude/2.1.280');
    const { id, slug } = CLAUDE[0];
    const transcript = path.join(h, 'projects', slug, `${id}.jsonl`);
    const refusal = (p: string, sid: string = id) => claudeAdapter.discover(p, sid, fsOf).then(() => undefined, (e: SessionError) => e.code);
    expect(await refusal(path.join(h, 'projects', slug, '22222222-2222-4333-8444-555555555555.jsonl'), '22222222-2222-4333-8444-555555555555')).toBe('transcript_missing');
    expect(await refusal(transcript, '22222222-2222-4333-8444-555555555555')).toBe('transcript_missing');
    const loose = path.join(h, `${id}.jsonl`);
    fs.copyFileSync(transcript, loose);
    expect(await refusal(loose)).toBe('incompatible_adapter');
    const other = path.join(h, 'projects', 'elsewhere');
    fs.mkdirSync(other);
    fs.symlinkSync(transcript, path.join(other, `${id}.jsonl`));
    expect(await refusal(path.join(other, `${id}.jsonl`))).toBe('incompatible_adapter');
    fs.symlinkSync('/etc', path.join(h, 'projects', slug, id, 'escape'));
    expect(await refusal(transcript)).toBe('incompatible_adapter');
    fs.rmSync(path.join(h, 'projects', slug, id, 'escape'));
    // a sidecar folder this user cannot read is a blocker, not a crash
    const sealed = path.join(h, 'projects', slug, id, 'subagents');
    fs.chmodSync(sealed, 0o000);
    try { expect(await refusal(transcript)).toBe('path_unsupported'); } finally { fs.chmodSync(sealed, 0o755); }
  });
});

describe('Claude Code folder trust', () => {
  const T = { hasTrustDialogAccepted: true };
  // a folder with no repository, a repository with a folder in it, a worktree of it inside it, and a link to the plain folder
  function layout() {
    const base = tmp();
    const at = (p: string) => path.join(base, p);
    for (const d of ['plain/a/b', 'repo/sub/deep', 'repo/.claude/worktrees/x/inner']) fs.mkdirSync(at(d), { recursive: true });
    fs.symlinkSync(at('plain/a'), at('link'));
    return { base, at, repo: at('repo'), wt: at('repo/.claude/worktrees/x') };
  }
  const write = (file: string, projects: Record<string, object>) => fs.writeFileSync(file, JSON.stringify({ hasCompletedOnboarding: true, projects }));

  it('trusts a folder where Claude 2.1.283 resumes without asking, by the projects its config marks trusted', () => {
    const { base, at, repo, wt } = layout();
    // a config folder other than ~/.claude keeps .claude.json inside it, as CLAUDE_CONFIG_DIR does
    const home = at('cfg');
    fs.mkdirSync(home);
    const inRepo = (cwd: string) => ({ cwd, repo, root: repo });
    const inWt = (cwd: string) => ({ cwd, repo, root: wt });
    // each as the real binary answered it in a scratch HOME: false where it opened on its "Yes, I trust this folder" prompt
    const cases: [string, Omit<ResumeFolder, 'kind'>, string[], boolean][] = [
      ['nothing trusted', { cwd: at('plain/a/b') }, [], false],
      ['the folder itself', { cwd: at('plain/a/b') }, [at('plain/a/b')], true],
      ['a folder above, outside any repository', { cwd: at('plain/a/b') }, [at('plain')], true],
      ['any folder further up', { cwd: at('plain/a/b') }, [base], true],
      ['/ itself', { cwd: at('plain/a/b') }, ['/'], true],
      ['only a folder below', { cwd: at('plain/a') }, [at('plain/a/b')], false],
      ['the folder with a slash after it', { cwd: at('plain/a/b') }, [`${at('plain/a/b')}/`], false],
      ['the repository, for a folder in it', inRepo(at('repo/sub/deep')), [repo], true],
      ['a folder between it and the top of its checkout', inRepo(at('repo/sub/deep')), [at('repo/sub')], true],
      ['only a folder above the repository', inRepo(at('repo/sub')), [base], false],
      ['the main checkout, for a worktree', inWt(wt), [repo], true],
      ['the main checkout, for a folder in a worktree', inWt(at('repo/.claude/worktrees/x/inner')), [repo], true],
      ['the worktree, for a folder in it', inWt(at('repo/.claude/worktrees/x/inner')), [wt], true],
      ['a folder between the worktree and the main checkout', inWt(wt), [at('repo/.claude')], false],
      ['only a worktree, for the main checkout', inRepo(repo), [wt], false],
      ['the real path, for a folder reached through a link', { cwd: at('link/b') }, [at('plain/a')], true],
      ['only the link', { cwd: at('link/b') }, [at('link')], false],
    ];
    for (const [name, folder, trusted, expected] of cases) {
      write(path.join(home, '.claude.json'), Object.fromEntries(trusted.map((p) => [p, T])));
      expect(claudeAdapter.trusts!(home, folder), name).toBe(expected);
    }
    write(path.join(home, '.claude.json'), { [at('plain/a/b')]: { hasTrustDialogAccepted: false } });
    expect(claudeAdapter.trusts!(home, { cwd: at('plain/a/b') }), 'marked untrusted').toBe(false);
    fs.writeFileSync(path.join(home, '.claude.json'), '{not json');
    expect(claudeAdapter.trusts!(home, { cwd: at('plain/a/b') }), 'a config that does not parse').toBe(false);
    fs.rmSync(path.join(home, '.claude.json'));
    expect(claudeAdapter.trusts!(home, { cwd: at('plain/a/b') }), 'no config').toBe(false);
  });

  it('reads its config again only once the file has changed, however often it is asked', () => {
    const { at } = layout();
    const home = at('cfg');
    fs.mkdirSync(home);
    const config = path.join(home, '.claude.json');
    write(config, {});
    const reads = vi.spyOn(fs, 'readFileSync');
    const read = () => reads.mock.calls.filter(([f]) => f === config).length;
    try {
      for (let i = 0; i < 3; i++) expect(claudeAdapter.trusts!(home, { cwd: at('plain/a/b') })).toBe(false);
      expect(claudeAdapter.acceptsBypass!(home, { cwd: at('plain/a/b') })).toBe(false);
      expect(read()).toBe(1);
      write(config, { [at('plain/a/b')]: T });
      expect(claudeAdapter.trusts!(home, { cwd: at('plain/a/b') })).toBe(true);
      expect(read()).toBe(2);
    } finally {
      reads.mockRestore();
    }
  });

  it('trusts a folder whose name is stored decomposed by the composed key Claude 2.1.283 looks it up by', () => {
    const base = tmp();
    const home = path.join(base, 'cfg');
    fs.mkdirSync(home);
    // "Skår/Bäck" as Finder and HFS+ store it, with the marks apart from their letters
    const decomposed = path.join(base, 'Skår', 'Bäck');
    const composed = decomposed.normalize('NFC');
    fs.mkdirSync(decomposed, { recursive: true });
    expect(composed).not.toBe(decomposed);
    for (const [name, folder, key] of [
      ['the folder itself', { cwd: decomposed }, composed],
      ['a folder above it', { cwd: decomposed }, path.dirname(composed)],
      ["its repository's main checkout", { cwd: decomposed, repo: path.dirname(decomposed), root: path.dirname(decomposed) }, path.dirname(composed)],
    ] as const) {
      write(path.join(home, '.claude.json'), { [key]: T });
      expect(claudeAdapter.trusts!(home, folder), name).toBe(true);
    }
  });

  it('reads ~/.claude.json for the ~/.claude config folder, and a legacy .config.json in a config folder before anything else', () => {
    const { at } = layout();
    const cwd = at('plain/a/b');
    // a HOME of its own, whichever runner starts the test
    vi.stubEnv('HOME', at('home'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    const home = path.join(os.homedir(), '.claude');
    fs.mkdirSync(home, { recursive: true });
    const beside = path.join(os.homedir(), '.claude.json');
    try {
      write(path.join(home, '.claude.json'), { [cwd]: T });
      expect(claudeAdapter.trusts!(home, { cwd })).toBe(false);
      write(beside, { [cwd]: T });
      expect(claudeAdapter.trusts!(home, { cwd })).toBe(true);
      write(path.join(home, '.config.json'), {});
      expect(claudeAdapter.trusts!(home, { cwd })).toBe(false);
      const elsewhere = at('cfg');
      fs.mkdirSync(elsewhere);
      write(path.join(elsewhere, '.claude.json'), { [cwd]: T });
      write(path.join(elsewhere, '.config.json'), {});
      expect(claudeAdapter.trusts!(elsewhere, { cwd })).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('Claude Code bypass mode', () => {
  const skip = { skipDangerousModePermissionPrompt: true };
  const write = (file: string, o: object) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(o)); };

  it('knows a resume that starts Claude in bypass mode by the launch flags a revive keeps', () => {
    const id = CLAUDE[0].id;
    for (const flags of ['--dangerously-skip-permissions', "--allow-dangerously-skip-permissions --effort 'high'", "--permission-mode 'bypassPermissions'"]) {
      expect(claudeAdapter.asksBypass!(`claude ${flags} --resume ${id}`), flags).toBe(true);
    }
    for (const flags of ['', "--effort 'high'", "--effort 'dangerously-skip-permissions'"]) expect(claudeAdapter.asksBypass!(`claude ${flags} --resume ${id}`), flags).toBe(false);
    expect(codexAdapter.asksBypass).toBeUndefined();
  });

  it('counts bypass mode accepted where Claude 2.1.283 starts in it without its warning, by its settings and config', () => {
    const base = tmp();
    const at = (p: string) => path.join(base, p);
    // a config folder other than ~/.claude, as CLAUDE_CONFIG_DIR names one
    const home = at('cfg');
    const plain = { cwd: at('plain/a/b') };
    const inRepo = { cwd: at('repo/sub/deep'), repo: at('repo'), root: at('repo') };
    const inWt = { cwd: at('repo/.claude/worktrees/x/inner'), repo: at('repo'), root: at('repo/.claude/worktrees/x') };
    // each as the real binary answered it in a scratch HOME: false where it opened on its Bypass Permissions warning
    const cases: [string, Omit<ResumeFolder, 'kind'>, [string, object][], boolean][] = [
      ['nothing accepted', plain, [], false],
      ['its settings skip the warning', plain, [['cfg/settings.json', skip]], true],
      ['its settings do not', plain, [['cfg/settings.json', { skipDangerousModePermissionPrompt: false }]], false],
      ['its config accepted bypass mode', plain, [['cfg/.claude.json', { bypassPermissionsModeAccepted: true }]], true],
      ['its config did not', plain, [['cfg/.claude.json', { bypassPermissionsModeAccepted: false }]], false],
      ["the folder's local settings skip it", plain, [['plain/a/b/.claude/settings.local.json', skip]], true],
      ["the folder's shared settings", plain, [['plain/a/b/.claude/settings.json', skip]], false],
      ["a folder above's local settings, outside any repository", plain, [['plain/a/.claude/settings.local.json', skip]], false],
      ["the repository's local settings, for a folder in it", inRepo, [['repo/.claude/settings.local.json', skip]], true],
      ['those of a folder between it and the top of its checkout', inRepo, [['repo/sub/.claude/settings.local.json', skip]], false],
      ["the main checkout's, for a folder in a worktree", inWt, [['repo/.claude/settings.local.json', skip]], true],
      ["the worktree's own, for a folder in it", inWt, [['repo/.claude/worktrees/x/.claude/settings.local.json', skip]], false],
    ];
    for (const [name, folder, files, expected] of cases) {
      for (const f of ['cfg', 'plain', 'repo']) fs.rmSync(at(f), { recursive: true, force: true });
      fs.mkdirSync(home);
      for (const [file, o] of files) write(at(file), o);
      expect(claudeAdapter.acceptsBypass!(home, folder), name).toBe(expected);
    }
  });

  it('reads ~/.claude.json for the ~/.claude config folder', () => {
    const base = tmp();
    vi.stubEnv('HOME', base);
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    try {
      const home = path.join(os.homedir(), '.claude');
      write(path.join(home, '.claude.json'), { bypassPermissionsModeAccepted: true });
      expect(claudeAdapter.acceptsBypass!(home, { cwd: base })).toBe(false);
      write(path.join(os.homedir(), '.claude.json'), { bypassPermissionsModeAccepted: true });
      expect(claudeAdapter.acceptsBypass!(home, { cwd: base })).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('Codex sessions', () => {
  it('finds a rollout from the exact path it recorded, in whatever CODEX_HOME it ran with', async () => {
    const h = home('codex/0.156.1', 'codex-elsewhere');
    const { file, id } = CODEX[1];
    fs.writeFileSync(path.join(h, 'history.jsonl'), '{}\n');
    fs.writeFileSync(path.join(h, 'session_index.jsonl'), `{"id":"${id}","thread_name":"x"}\n`);
    fs.writeFileSync(path.join(h, 'auth.json'), '{}');
    expect(await codexAdapter.discover(path.join(h, file), id, fsOf)).toEqual({ home: h, transcript: file, files: [file] });
  });

  it('refuses a rollout that is missing, another session, archived, loose, or a link', async () => {
    const h = home('codex/0.156.1', '.codex');
    const { file, id } = CODEX[1];
    const refusal = (p: string, sid: string = id) => codexAdapter.discover(p, sid, fsOf).then(() => undefined, (e: SessionError) => e.code);
    expect(await refusal(path.join(h, file.replace('08-44-52', '08-44-53')))).toBe('transcript_missing');
    expect(await refusal(path.join(h, file), '01a0cd02-0000-7000-8000-000000000000')).toBe('transcript_missing');
    for (const where of ['archived_sessions/2026/09/23', 'sessions']) {
      const p = path.join(h, where, path.basename(file));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.copyFileSync(path.join(h, file), p);
      expect(await refusal(p)).toBe('incompatible_adapter');
    }
    const link = path.join(h, 'sessions/2026/09/24', path.basename(file));
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(h, file), link);
    expect(await refusal(link)).toBe('incompatible_adapter');
  });
});

const MAC = '9b4d0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const TRIFT = '42aa0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' as MachineId;
const FLEET = FleetConfig.parse({ id: '5e1f0b1c-2d3e-4f50-8617-9a0b1c2d3e4f' });

function char(id: string, o: Partial<Character>): Character {
  return {
    id, islandId: 'i1', cell: { x: 0, y: 0 }, name: id, note: '', portrait: 'fox', instructions: '', cwd: '/',
    context: [], shell: { lastOutputAt: 0 }, unread: false, ...o,
  };
}

/**
 * A source machine whose home is a temp folder: one character running the real 2.1.280 Claude session in its
 * first terminal and the real 0.155.1 Codex rollout in its second, both made under a home of `/Users/source`.
 */
function machines(homes?: MachineMaps['destination']['agentHomes']) {
  const base = tmp();
  const mac = path.join(base, 'Users/source');
  const work = path.join(mac, 'work/demo');
  fs.mkdirSync(work, { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'claude/2.1.280'), path.join(mac, '.claude'), { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'codex/0.155.1'), path.join(mac, '.codex'), { recursive: true });
  const agentHomes = homes ?? { claude: path.join(mac, '.claude'), codex: path.join(mac, '.codex') };
  const maps: MachineMaps = {
    source: { machineId: MAC, home: mac, fleetHome: path.join(mac, '.svall') },
    destination: { machineId: TRIFT, home: mac, fleetHome: path.join(mac, '.svall'), agentHomes },
  };
  const state = emptyState();
  state.characters.c1 = char('c1', {
    cwd: work,
    agent: { kind: 'claude', sessionId: CLAUDE[0].id, transcriptPath: path.join(mac, '.claude/projects', CLAUDE[0].slug, `${CLAUDE[0].id}.jsonl`), status: 'idle', lastActivityAt: 0 },
    second: { cwd: work, unread: false, agent: { kind: 'codex', sessionId: CODEX[0].id, transcriptPath: path.join(mac, '.codex', CODEX[0].file), status: 'idle', lastActivityAt: 0 } },
  });
  return { base, mac, work, maps, state };
}

describe('sessions in the transfer manifest', () => {
  it('lists every file of each session apart from the roots, and lands each transcript where it was', async () => {
    const m = machines();
    const { manifest, blockers } = await buildManifest(buildInventory(m.state, { fleet: FLEET }, m.maps), { generation: 1 });
    expect(blockers).toEqual([]);
    const [claude, codex] = manifest.sessions;
    const { id, slug, agent } = CLAUDE[0];
    expect(claude).toMatchObject({
      characterId: 'c1', agent: 'claude', sessionId: id, adapter: 1,
      sourceHome: path.join(m.mac, '.claude'), destinationHome: path.join(m.mac, '.claude'), destinationPath: claude.sourcePath,
    });
    expect(claude.files.map((f) => f.path)).toEqual([
      `projects/${slug}/${id}.jsonl`, `projects/${slug}/${id}/subagents/${agent}.jsonl`, `projects/${slug}/${id}/subagents/${agent}.meta.json`,
    ]);
    const transcript = fs.readFileSync(claude.sourcePath);
    expect(claude.files[0]).toMatchObject({ type: 'file', size: transcript.length, sha256: sha(transcript) });
    expect(codex).toMatchObject({
      characterId: 'c1', term: 2, agent: 'codex', adapter: 1, sourceHome: path.join(m.mac, '.codex'),
      destinationPath: path.join(m.mac, '.codex', CODEX[0].file), files: [expect.objectContaining({ path: CODEX[0].file })],
    });
    // no session file becomes a root, and nothing under an agent home is mirrored
    expect(manifest.roots.map((r) => r.path)).toEqual([m.work]);
  });

  it('carries a session a CLI newer than every fixture wrote, whatever its records hold', async () => {
    const m = machines();
    const transcript = m.state.characters.c1.agent!.transcriptPath!;
    const rollout = m.state.characters.c1.second!.agent!.transcriptPath!;
    fs.writeFileSync(transcript, `${fs.readFileSync(transcript, 'utf8').replaceAll('"version":"2.1.280"', '"version":"2.9.0"')}{"type":"holodeck","version":"2.9.0","attachment":{"type":"telepathy"},"scratchDir":"/Users/source/w"}\n`);
    fs.writeFileSync(rollout, `${fs.readFileSync(rollout, 'utf8').replaceAll('"cli_version":"0.155.1"', '"cli_version":"0.170.0"')}{"timestamp":"t","type":"hologram","payload":{"scratch_root":"/Users/source/w/.x"}}\n`);
    const { manifest, blockers } = await buildManifest(buildInventory(m.state, { fleet: FLEET }, m.maps), { generation: 1 });
    expect(blockers).toEqual([]);
    expect(manifest.sessions.map((s) => s.files[0])).toEqual([transcript, rollout].map((f) => expect.objectContaining({ sha256: sha(fs.readFileSync(f)) })));
  });

  it('blocks a session the destination has no agent home for', async () => {
    const m = machines({ codex: '/Users/target/.codex' });
    const { manifest, blockers } = await buildManifest(buildInventory(m.state, { fleet: FLEET }, m.maps), { generation: 1 });
    expect(blockers).toEqual([expect.objectContaining({ code: 'agent_cli_missing', entity: { kind: 'character', id: 'c1' } })]);
    expect(manifest.sessions.find((s) => s.agent === 'claude')?.destinationPath).toBeUndefined();
  });

  it('blocks a transcript that is gone', async () => {
    const m = machines();
    fs.rmSync(m.state.characters.c1.second!.agent!.transcriptPath!);
    const { blockers } = await buildManifest(buildInventory(m.state, { fleet: FLEET }, m.maps), { generation: 1 });
    expect(blockers).toEqual([expect.objectContaining({ code: 'transcript_missing', entity: { kind: 'character', id: 'c1' } })]);
  });
});

// each fixture session, where its CLI keeps it under the agent home
const FIXTURE_SESSIONS = [
  ...CLAUDE.map((c) => ({ kind: 'claude' as AgentKind, version: c.version, id: c.id, agentHome: '.claude', transcript: `projects/${c.slug}/${c.id}.jsonl`, newer: '2.1.283' })),
  ...CODEX.map((c) => ({ kind: 'codex' as AgentKind, version: c.version, id: c.id, agentHome: '.codex', transcript: c.file, newer: '0.157.0' })),
];

describe.each(FIXTURE_SESSIONS)('a $kind session as $version wrote it', ({ kind, version, id, agentHome, transcript, newer }) => {
  it('arrives byte for byte at the transcript path its terminal recorded, for a newer CLI there to resume', async () => {
    const base = tmp();
    const mac = path.join(base, 'Users/source');
    const agents = path.join(mac, agentHome);
    fs.cpSync(path.join(FIXTURES, kind, version), agents, { recursive: true });
    const transcriptPath = path.join(agents, transcript);
    const state = emptyState();
    state.characters.c1 = char('c1', { cwd: mac, agent: { kind, sessionId: id, transcriptPath, status: 'idle', lastActivityAt: 0 } });
    const at = { home: mac, fleetHome: path.join(mac, '.svall') };
    const { manifest, blockers } = await buildManifest(buildInventory(state, { fleet: FLEET }, {
      source: { machineId: MAC, ...at }, destination: { machineId: TRIFT, ...at, agentHomes: { [kind]: agents } },
    }), { generation: 1 });
    expect(blockers).toEqual([]);
    const probe = (v: string): AgentProbe => ({ kind, version: v, home: agents, loggedIn: true, hooks: true });
    expect(agentBlockers({ kinds: [kind], source: [probe(version)], destination: [probe(newer)] })).toEqual([]);

    // the source's tree set aside, as the other machine never had it, and its session staged as rsync stages it
    const parked = path.join(base, 'parked');
    fs.renameSync(mac, parked);
    const staged = path.join(parked, agentHome);
    const [session] = manifest.sessions;
    expect(installSession(session, staged)).toEqual({ transcriptPath });
    for (const f of session.files) expect(fs.readFileSync(path.join(agents, f.path)), f.path).toEqual(fs.readFileSync(path.join(staged, f.path)));
    expect(placeTranscripts(manifest.snapshot, manifest.sessions).characters.c1.agent!.transcriptPath).toBe(transcriptPath);
  });
});

describe('a session arriving on the destination', () => {
  // the manifest the source built, the source's bytes staged at their manifest paths, and a destination home
  async function arrival(before?: (m: ReturnType<typeof machines>) => void) {
    const m = machines({ claude: path.join(tmp(), 'dest/.claude'), codex: path.join(tmp(), 'dest/.codex') });
    before?.(m);
    const { manifest } = await buildManifest(buildInventory(m.state, { fleet: FLEET }, m.maps), { generation: 1 });
    const stage = (s: TransferSession): string => {
      const dir = path.join(tmp(), 'staged');
      for (const f of s.files) fs.cpSync(path.join(s.sourceHome!, f.path), path.join(dir, f.path));
      return dir;
    };
    return { m, manifest, stage, claude: manifest.sessions[0], codex: manifest.sessions[1] };
  }

  it('lands under the destination agent home at the place it had under the source\'s, byte for byte', async () => {
    const { m, claude, codex, stage } = await arrival((source) => {
      // a record naming a folder under the source's agent home, which the destination keeps elsewhere
      const t = source.state.characters.c1.agent!.transcriptPath!;
      fs.appendFileSync(t, `${JSON.stringify({ type: 'user', cwd: path.join(source.mac, '.claude/plans'), version: '2.1.280', message: {} })}\n`);
    });
    const { id, slug } = CLAUDE[0];
    const staged = stage(claude);
    expect(installSession(claude, staged)).toEqual({ transcriptPath: claude.destinationPath });
    const project = path.join(claude.destinationHome!, 'projects', slug);
    expect(claude.destinationPath).toBe(path.join(project, `${id}.jsonl`));
    for (const f of claude.files) expect(fs.readFileSync(path.join(claude.destinationHome!, f.path)), f.path).toEqual(fs.readFileSync(path.join(staged, f.path)));
    expect(rows(fs.readFileSync(claude.destinationPath!)).at(-1)!.cwd).toBe(path.join(m.mac, '.claude/plans'));
    expect(fs.statSync(path.join(project, `${id}.jsonl`)).mode & 0o777).toBe(0o600);
    expect(installSession(codex, stage(codex))).toEqual({ transcriptPath: `${codex.destinationHome}/${CODEX[0].file}` });
    expect(fs.readFileSync(codex.destinationPath!)).toEqual(fs.readFileSync(codex.sourcePath));
  });

  it('carries a file of a kind no release so far wrote in the session\'s folder, byte for byte', async () => {
    const { id, slug } = CLAUDE[0];
    const stray = `projects/${slug}/${id}/auto-mode-classifier-error.txt`;
    const { claude, stage } = await arrival((m) => { fs.writeFileSync(path.join(m.mac, '.claude', stray), 'classifier said no'); });
    expect(claude.files.map((f) => f.path)).toContain(stray);
    installSession(claude, stage(claude));
    expect(fs.readFileSync(path.join(claude.destinationHome!, stray), 'utf8')).toBe('classifier said no');
  });

  it('keeps a copy already there when it is the same, and replaces one the incoming session only adds to', async () => {
    const { claude, stage } = await arrival();
    const staged = stage(claude);
    installSession(claude, staged);
    const placed = claude.destinationPath!;
    const full = fs.readFileSync(placed);
    installSession(claude, staged);
    expect(fs.readFileSync(placed)).toEqual(full);
    // a round trip: the destination still holds the older copy it handed away, which the session has since grown past
    fs.writeFileSync(placed, full.subarray(0, full.indexOf('\n', full.length / 2) + 1));
    installSession(claude, staged);
    expect(fs.readFileSync(placed)).toEqual(full);
  });

  it('refuses a copy the destination continued on its own, and writes nothing', async () => {
    const { claude, stage } = await arrival();
    const staged = stage(claude);
    installSession(claude, staged);
    const placed = claude.destinationPath!;
    fs.appendFileSync(placed, '{"type":"user","version":"2.1.280","message":{"content":"a turn taken here"}}\n');
    const meta = path.join(path.dirname(placed), CLAUDE[0].id, 'subagents', `${CLAUDE[0].agent}.meta.json`);
    fs.rmSync(meta);
    const before = fs.readFileSync(placed);
    expect(() => installSession(claude, staged)).toThrow(expect.objectContaining({ code: 'destination_diverged' }));
    expect(fs.readFileSync(placed)).toEqual(before);
    expect(fs.existsSync(meta)).toBe(false);
  });

  it('refuses staged bytes that are not the ones the manifest names', async () => {
    const { codex, stage } = await arrival();
    const staged = stage(codex);
    fs.appendFileSync(path.join(staged, codex.files[0].path), '\n');
    expect(() => installSession(codex, staged)).toThrow(/manifest/);
    expect(fs.existsSync(codex.destinationPath!)).toBe(false);
  });

  it('refuses a manifest that names a file outside the agent home', async () => {
    const { codex, stage } = await arrival();
    const staged = stage(codex);
    expect(() => installSession({ ...codex, files: [{ ...codex.files[0], path: '../../escape.jsonl' }] }, staged))
      .toThrow(expect.objectContaining({ code: 'path_unsupported' }));
    expect(() => installSession({ ...codex, destinationPath: '/elsewhere/rollout.jsonl' }, staged))
      .toThrow(expect.objectContaining({ code: 'path_unsupported' }));
    expect(fs.existsSync(codex.destinationPath!)).toBe(false);
  });

  it("writes nothing when a manifest names a file outside its session's own layout", async () => {
    const { claude, codex, stage } = await arrival();
    const { id, slug } = CLAUDE[0];
    // a file of the manifest's choosing, staged with the bytes its entry names
    const naming = (s: TransferSession, staged: string, rel: string): TransferSession => {
      const data = Buffer.from('{"note":"not a session file"}\n');
      fs.mkdirSync(path.dirname(path.join(staged, rel)), { recursive: true });
      fs.writeFileSync(path.join(staged, rel), data);
      return { ...s, files: [...s.files, { type: 'file', path: rel, mode: 0o600, size: data.length, mtimeMs: 0, sha256: sha(data) }] };
    };
    const refused = (s: TransferSession, staged: string) => expect(() => installSession(s, staged)).toThrow(expect.objectContaining({ code: 'path_unsupported' }));
    const claudeStaged = stage(claude);
    for (const rel of [
      'CLAUDE.md', 'skills/x/SKILL.md', 'settings.json', `file-history/${id}/abc@v1`, `projects/${slug}/99999999-2222-4333-8444-555555555555.jsonl`,
      `projects/-elsewhere/${id}/tool-results/b1.txt`,
    ]) refused(naming(claude, claudeStaged, rel), claudeStaged);
    refused({ ...claude, destinationPath: path.join(claude.destinationHome!, 'CLAUDE.md') }, claudeStaged);
    refused({ ...claude, destinationPath: path.join(claude.destinationHome!, `projects/${slug}/99999999-2222-4333-8444-555555555555.jsonl`) }, claudeStaged);
    refused({ ...claude, destinationPath: path.join(claude.destinationHome!, `projects/-elsewhere/${id}.jsonl`) }, claudeStaged);
    const codexStaged = stage(codex);
    const another = 'sessions/2026/09/23/rollout-2026-09-23T08-44-38-99999999-2222-4333-8444-555555555555.jsonl';
    for (const rel of ['hooks.json', 'config.toml', another]) refused(naming(codex, codexStaged, rel), codexStaged);
    for (const rel of ['hooks.json', another]) refused({ ...codex, destinationPath: path.join(codex.destinationHome!, rel) }, codexStaged);
    expect(fs.existsSync(claude.destinationHome!)).toBe(false);
    expect(fs.existsSync(codex.destinationHome!)).toBe(false);
  });

  it('places the transcript last, so a retry after its write failed finishes the job', async () => {
    const { claude, stage } = await arrival();
    const staged = stage(claude);
    const placed = claude.destinationPath!;
    const { id, agent } = CLAUDE[0];
    const sidecars = ['jsonl', 'meta.json'].map((ext) => path.join(path.dirname(placed), id, 'subagents', `${agent}.${ext}`));
    const full = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    const failing: InstallFs = {
      ...realInstallFs,
      stages: { open: (file, mode) => { if (file.startsWith(`${placed}.durable-`)) throw full; return realStages.open(file, mode); } },
    };
    expect(() => installSession(claude, staged, failing)).toThrow(full);
    expect(sidecars.every((f) => fs.existsSync(f))).toBe(true);
    expect(fs.readdirSync(path.dirname(placed))).toEqual([id]);

    const written: string[] = [];
    const retry: InstallFs = { ...realInstallFs, stages: { rename: (from, to) => { written.push(to); fs.renameSync(from, to); } } };
    expect(installSession(claude, staged, retry)).toEqual({ transcriptPath: placed });
    // the sidecars already there were the same, so only the transcript was written
    expect(written).toEqual([placed]);
    for (const f of claude.files) expect(fs.readFileSync(path.join(claude.destinationHome!, f.path)), f.path).toEqual(fs.readFileSync(path.join(staged, f.path)));
    expect(fs.readdirSync(path.dirname(placed)).sort()).toEqual([`${id}.jsonl`, id].sort());
  });

  it('points each imported agent at its placed transcript before anything starts', async () => {
    const { m, manifest } = await arrival();
    const placed = placeTranscripts(manifest.snapshot, manifest.sessions);
    expect(placed.characters.c1.agent!.transcriptPath).toBe(manifest.sessions[0].destinationPath);
    expect(placed.characters.c1.second!.agent!.transcriptPath).toBe(manifest.sessions[1].destinationPath);
    expect(manifest.snapshot.characters.c1.agent!.transcriptPath).toBe(m.state.characters.c1.agent!.transcriptPath);
    expect(() => placeTranscripts(manifest.snapshot, manifest.sessions.slice(1))).toThrow(/c1/);
  });
});

describe('OpenCode sessions', () => {
  const ID = 'ses_0f3a5b7c9d1eAbCdEfGhIjKlMn';
  const session = (directory: string, texts: string[]): Exported => ({ info: { id: ID, location: { directory } }, messages: texts.map((text, i) => ({ id: `msg_${i}`, text })) });
  const turn = (text: string): string => `${JSON.stringify({ kind: 'user', text })}\n`;
  // as prepare reads a session in: any copy here is kept aside and goes first, then the incoming one is imported
  const readIn = async (file: string, cwd: string, run: CliRun): Promise<void> => {
    const keep = path.join(tmp(), 'kept.json');
    await opencodeAdapter.dropSession!(ID, file, cwd, run, keep);
    await opencodeAdapter.importSession!(ID, file, cwd, run);
  };

  /** One machine: its OpenCode, keeping sessions in a database of its own, and the folder Svall's plugin logs each session in. */
  function side(base: string, name: string): { env: NodeJS.ProcessEnv; run: CliRun; logs: string } {
    const env = fakeEnv(path.join(base, `${name}-opencode`));
    const logs = path.join(base, name, '.svall/transcripts/opencode');
    fs.mkdirSync(logs, { recursive: true });
    return { env, run: cliRunner(env), logs };
  }

  /** The session leaving `from` for `to`: written out of `from`'s OpenCode, read into a manifest and staged as rsync stages it. */
  async function leaving(from: ReturnType<typeof side>, to: ReturnType<typeof side>, work: string, transcriptPath: string) {
    await opencodeAdapter.exportSession!(ID, path.join(from.logs, opencodeAdapter.exportFile!(ID)), from.run, work);
    const state = emptyState();
    state.characters.c1 = char('c1', { cwd: work, agent: { kind: 'opencode', sessionId: ID, transcriptPath, status: 'idle', lastActivityAt: 0 } });
    const at = { home: work, fleetHome: path.dirname(path.dirname(from.logs)) };
    const { manifest, blockers } = await buildManifest(buildInventory(state, { fleet: FLEET }, {
      source: { machineId: MAC, ...at }, destination: { machineId: TRIFT, ...at, agentHomes: { opencode: to.logs } },
    }), { generation: 1 });
    expect(blockers).toEqual([]);
    const [s] = manifest.sessions;
    const stage = tmp();
    for (const f of s.files) fs.cpSync(path.join(s.sourceHome!, f.path), path.join(stage, f.path));
    return { manifest, session: s, stage, exported: path.join(stage, opencodeAdapter.exportFile!(ID)) };
  }

  it("finds a session by the log Svall's plugin keeps of it, with the export a handover writes beside it", async () => {
    const logs = path.join(tmp(), '.svall/transcripts/opencode');
    fs.mkdirSync(logs, { recursive: true });
    const log = path.join(logs, `${ID}.jsonl`);
    fs.writeFileSync(log, turn('hi'));
    expect(await opencodeAdapter.discover(log, ID, fsOf)).toEqual({ home: logs, transcript: `${ID}.jsonl`, files: [`${ID}.jsonl`, `exports/${ID}.json`] });
    const refused = (file: string, id = ID) => opencodeAdapter.discover(file, id, fsOf).then(() => undefined, (e: SessionError) => e.code);
    expect(await refused(log, 'ses_111111111111AbCdEfGhIjKlMn')).toBe('transcript_missing');
    expect(await refused(path.join(logs, 'ses_111111111111AbCdEfGhIjKlMn.jsonl'), 'ses_111111111111AbCdEfGhIjKlMn')).toBe('transcript_missing');
    fs.mkdirSync(path.join(logs, '../elsewhere'));
    fs.writeFileSync(path.join(logs, '../elsewhere', `${ID}.jsonl`), turn('hi'));
    expect(await refused(path.join(logs, '../elsewhere', `${ID}.jsonl`))).toBe('incompatible_adapter');
    expect(opencodeAdapter.carries(`${ID}.jsonl`, `${ID}.jsonl`, ID)).toBe(true);
    expect(opencodeAdapter.carries(`exports/${ID}.json`, `${ID}.jsonl`, ID)).toBe(true);
    for (const f of ['opencode.db', `exports/ses_111111111111AbCdEfGhIjKlMn.json`, `../${ID}.jsonl`]) expect(opencodeAdapter.carries(f, `${ID}.jsonl`, ID), f).toBe(false);
  });

  it('writes a session out of the database its machine keeps by XDG_DATA_HOME, and finds a session it does not hold missing', async () => {
    const base = tmp();
    const [mac, other] = [side(base, 'mac'), side(base, 'other')];
    hold(mac.env, session('/w', ['remember PELICAN-42']));
    const file = path.join(mac.logs, opencodeAdapter.exportFile!(ID));
    await opencodeAdapter.exportSession!(ID, file, mac.run, base);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(session('/w', ['remember PELICAN-42']));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    await expect(opencodeAdapter.exportSession!(ID, path.join(other.logs, opencodeAdapter.exportFile!(ID)), other.run, base))
      .rejects.toMatchObject({ code: 'transcript_missing', message: expect.stringContaining('Session not found') });
  });

  it('hands a session to another machine and back, each time in the folder its terminal resumes in, over the stale copy left there', async () => {
    const base = tmp();
    const [mac, linux] = [side(base, 'mac'), side(base, 'linux')];
    const work = path.join(base, 'work');
    fs.mkdirSync(work);
    hold(mac.env, session('/elsewhere', ['remember PELICAN-42']));
    const macLog = path.join(mac.logs, `${ID}.jsonl`);
    fs.writeFileSync(macLog, turn('remember PELICAN-42'));

    const away = await leaving(mac, linux, work, macLog);
    expect(away.session.files.map((f) => f.path)).toEqual([`${ID}.jsonl`, `exports/${ID}.json`]);
    expect(installSession(away.session, away.stage)).toEqual({ transcriptPath: path.join(linux.logs, `${ID}.jsonl`) });
    // the export is read back in, never placed
    expect(fs.readdirSync(linux.logs)).toEqual([`${ID}.jsonl`]);
    await readIn(away.exported, work, linux.run);
    expect(held(linux.env)[ID]).toEqual(session(work, ['remember PELICAN-42']));

    // the session goes on there, and comes back to a Mac that still holds the copy it handed away
    hold(linux.env, session(work, ['remember PELICAN-42', 'what was the codeword?']));
    fs.appendFileSync(path.join(linux.logs, `${ID}.jsonl`), turn('what was the codeword?'));
    const back = await leaving(linux, mac, work, path.join(linux.logs, `${ID}.jsonl`));
    expect(installSession(back.session, back.stage)).toEqual({ transcriptPath: macLog });
    expect(fs.readFileSync(macLog, 'utf8')).toBe(turn('remember PELICAN-42') + turn('what was the codeword?'));
    await readIn(back.exported, work, mac.run);
    expect(held(mac.env)[ID]).toEqual(session(work, ['remember PELICAN-42', 'what was the codeword?']));
    // and again, as a retried prepare would
    await readIn(back.exported, work, mac.run);
    expect(Object.keys(held(mac.env))).toEqual([ID]);
  });

  it('refuses an import OpenCode answers with "Session already exists", which it exits 0 on, and one it cannot make', async () => {
    const base = tmp();
    const [mac, linux] = [side(base, 'mac'), side(base, 'linux')];
    const work = path.join(base, 'work');
    fs.mkdirSync(work);
    hold(mac.env, session(work, ['one', 'two']));
    fs.writeFileSync(path.join(mac.logs, `${ID}.jsonl`), turn('one'));
    const { exported } = await leaving(mac, linux, work, path.join(mac.logs, `${ID}.jsonl`));
    hold(linux.env, session(work, ['one']));
    const keeping: CliRun = (cmd, args, o) => (args[1] === 'delete' ? Promise.resolve({ code: 0, stdout: '', stderr: '' }) : linux.run(cmd, args, o));
    await expect(readIn(exported, work, keeping))
      .rejects.toMatchObject({ code: 'transcript_missing', message: expect.stringContaining('Session already exists') });
    expect(held(linux.env)[ID]).toEqual(session(work, ['one']));
    await expect(opencodeAdapter.importSession!(ID, exported, path.join(base, 'gone'), linux.run)).rejects.toMatchObject({ code: 'transcript_missing' });
  });

  it('refuses to replace a copy this machine went on with outside Svall, and keeps it', async () => {
    const base = tmp();
    const [mac, linux] = [side(base, 'mac'), side(base, 'linux')];
    const work = path.join(base, 'work');
    fs.mkdirSync(work);
    hold(mac.env, session(work, ['one', 'two']));
    fs.writeFileSync(path.join(mac.logs, `${ID}.jsonl`), turn('one'));
    const { exported } = await leaving(mac, linux, work, path.join(mac.logs, `${ID}.jsonl`));
    // resumed there with a plain `opencode -s`, which Svall's log never saw
    const went = { ...session(work, ['one']), messages: [{ id: 'msg_0', text: 'one' }, { id: 'msg_x', text: 'asked by hand' }] };
    hold(linux.env, went);
    await expect(opencodeAdapter.checkSession!(ID, exported, work, linux.run)).rejects.toMatchObject({ code: 'destination_diverged' });
    await expect(readIn(exported, work, linux.run)).rejects.toMatchObject({ code: 'destination_diverged' });
    expect(held(linux.env)[ID]).toEqual(went);
  });

  it('names an OpenCode it cannot run apart from a session it does not hold', async () => {
    const run = cliRunner({ PATH: '/nonexistent' });
    await expect(opencodeAdapter.exportSession!(ID, os.devNull, run, tmp())).rejects.toMatchObject({ code: 'agent_cli_missing' });
    await expect(opencodeAdapter.importSession!(ID, os.devNull, tmp(), run)).rejects.toMatchObject({ code: 'agent_cli_missing' });
  });

  it('runs the CLI where it is told, or in the home, never the daemon\'s folder, and without the variables that make Svall\'s hooks act', async () => {
    const env = { ...process.env, SVALL_CHAR_ID: 'c_ada', SVALL_TERM: '2', KEPT: 'yes' };
    const printed = (await cliRunner(env)('env', [])).stdout;
    expect(printed).toContain('KEPT=yes');
    expect(printed).not.toMatch(/^SVALL_(CHAR_ID|TERM)=/m);
    const dir = tmp();
    expect((await cliRunner(env)('pwd', [], { cwd: dir })).stdout.trim()).toBe(dir);
    expect(fs.realpathSync((await cliRunner(env)('pwd', [])).stdout.trim())).toBe(fs.realpathSync(os.homedir()));
  });

  it('refuses a session that came without its export, and writes nothing', async () => {
    const base = tmp();
    const [mac, linux] = [side(base, 'mac'), side(base, 'linux')];
    hold(mac.env, session(base, ['one']));
    fs.writeFileSync(path.join(mac.logs, `${ID}.jsonl`), turn('one'));
    const { session: s, stage } = await leaving(mac, linux, base, path.join(mac.logs, `${ID}.jsonl`));
    expect(() => installSession({ ...s, files: s.files.slice(0, 1) }, stage)).toThrow(expect.objectContaining({ code: 'transcript_missing' }));
    expect(fs.readdirSync(linux.logs)).toEqual([]);
  });
});

describe('the resume a carried terminal keeps', () => {
  const SID = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
  const record = (cwd: string, text: string): string =>
    `${JSON.stringify({ type: 'user', cwd, sessionId: SID, version: '2.1.280', message: { role: 'user', content: text } })}\n`;

  it('keeps the resume a terminal went dormant with, flags and all, in either terminal, whether this handover rested it or not', async () => {
    const home = path.join(tmp(), 'home');
    const claude = path.join(home, '.claude');
    const cwd = path.join(home, 'code/gamma');
    fs.mkdirSync(cwd, { recursive: true });
    const SID2 = '7c1d9e2f-3a4b-4c5d-8e6f-0a1b2c3d4e5f';
    const agent = (sessionId: string): Character['agent'] => {
      const transcriptPath = path.join(claude, 'projects', '-home-code-gamma', `${sessionId}.jsonl`);
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, record(cwd, 'one'));
      return { kind: 'claude', sessionId, transcriptPath, status: 'idle', lastActivityAt: 0 };
    };
    const closed = (sessionId: string) => `claude --dangerously-skip-permissions --effort high --resume ${sessionId}`;
    const imported = async (restedBy?: string, secondAgent = true) => {
      const state = emptyState();
      state.characters.c1 = char('c1', {
        cwd, agent: agent(SID), revive: { command: closed(SID) }, restedBy,
        second: { cwd, unread: false, ...(secondAgent && { agent: agent(SID2) }), revive: { command: closed(SID2) }, restedBy },
      });
      const inventory = buildInventory(state, { fleet: FLEET }, {
        source: { machineId: MAC, home, fleetHome: path.join(home, '.svall') },
        destination: { machineId: TRIFT, home, fleetHome: path.join(home, '.svall'), agentHomes: { claude } },
      });
      const { manifest } = await buildManifest(inventory, { generation: 1 });
      const c = importState({ ...manifest, transactionId: 't1' }).state.characters.c1;
      return [c.revive, c.second?.revive];
    };
    expect(await imported()).toEqual([{ command: closed(SID) }, { command: closed(SID2) }]);
    expect(await imported('t1')).toEqual([{ command: closed(SID) }, { command: closed(SID2) }]);
    // a second terminal whose agent is gone carries no session, so it opens as a plain shell
    expect(await imported(undefined, false)).toEqual([{ command: closed(SID) }, { command: '' }]);
  });

  it('takes the new session a resumed agent starts, whatever process on the destination holds the pid its source recorded', async () => {
    const home = path.join(tmp(), 'home');
    const claude = path.join(home, '.claude');
    const cwd = path.join(home, 'code/gamma');
    const transcriptPath = path.join(claude, 'projects', '-home-code-gamma', `${SID}.jsonl`);
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(transcriptPath, record(cwd, 'one'));
    // the source's agents ran as pids that name a live process here, this test's own
    const agent = { kind: 'claude' as const, sessionId: SID, transcriptPath, status: 'idle' as const, lastActivityAt: 0, pid: process.pid };
    const state = emptyState();
    state.characters.c1 = char('c1', { cwd, agent, revive: { command: `claude --resume ${SID}` }, second: { cwd, unread: false, agent, revive: { command: `claude --resume ${SID}` } } });
    const inventory = buildInventory(state, { fleet: FLEET }, {
      source: { machineId: MAC, home, fleetHome: path.join(home, '.svall') },
      destination: { machineId: TRIFT, home, fleetHome: path.join(home, '.svall'), agentHomes: { claude } },
    });
    const { manifest } = await buildManifest(inventory, { generation: 1 });
    const c = importState({ ...manifest, transactionId: 't1' }).state.characters.c1;
    const NEW = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    for (const [slot, term] of [[c, undefined], [c.second!, 2]] as const) {
      const next = applyHook(slot, { charId: 'c1', backend: 'claude', name: 'SessionStart', sessionId: NEW, pid: 999_999, ...(term && { term }) }, 5);
      expect(next.agent).toMatchObject({ sessionId: NEW, pid: 999_999 });
    }
  });

  it('leaves behind the codex flags that name the source machine\'s own config: a profile and a local provider', () => {
    const state = emptyState();
    const codex = (command: string): Partial<Character> => ({
      agent: { kind: 'codex', sessionId: SID, transcriptPath: '/h/.codex/r.jsonl', status: 'idle', lastActivityAt: 0 }, revive: { command },
    });
    state.characters.c1 = char('c1', { cwd: '/h', ...codex(`codex resume -c tui.resume_cwd=session --yolo -m 'gpt-6-astra' -p 'work' --local-provider 'ollama' -s 'workspace-write' ${SID}`) });
    state.characters.c2 = char('c2', { cwd: '/h', ...codex(`codex resume -c tui.resume_cwd=session --profile 'work' ${SID}`) });
    state.characters.c3 = char('c3', { cwd: '/h', agent: { kind: 'claude', sessionId: SID, transcriptPath: '/h/.claude/r.jsonl', status: 'idle', lastActivityAt: 0 }, revive: { command: `claude --effort 'high' --resume ${SID}` } });
    const { characters } = importState({
      version: 1, transactionId: 't1', generation: 1, fromMachineId: MAC, toMachineId: TRIFT, home: '/h',
      fleet: FLEET, snapshot: state, excludes: [], roots: [], sessions: [],
    }).state;
    expect(characters.c1.revive).toEqual({ command: `codex resume -c tui.resume_cwd=session --yolo -m 'gpt-6-astra' -s 'workspace-write' ${SID}` });
    expect(characters.c2.revive).toEqual({ command: `codex resume -c tui.resume_cwd=session ${SID}` });
    expect(characters.c3.revive).toEqual({ command: `claude --effort 'high' --resume ${SID}` });
  });

  it('keeps a resume a crash left interrupted, and marks none the handover rested', () => {
    const state = emptyState();
    const agent = (status: 'idle' | 'working'): Character['agent'] => ({ kind: 'claude', sessionId: SID, transcriptPath: '/h/.claude/r.jsonl', status, lastActivityAt: 0 });
    state.characters.c1 = char('c1', { cwd: '/h', agent: agent('idle'), revive: { command: `claude --resume ${SID}`, interrupted: true } });
    state.characters.c2 = char('c2', { cwd: '/h', agent: agent('working') });
    const { characters } = importState({
      version: 1, transactionId: 't1', generation: 1, fromMachineId: MAC, toMachineId: TRIFT, home: '/h',
      fleet: FLEET, snapshot: state, excludes: [], roots: [], sessions: [],
    }).state;
    expect(characters.c1.revive).toEqual({ command: `claude --resume ${SID}`, interrupted: true });
    expect(characters.c2.revive).toEqual({ command: `claude --resume ${SID}` });
  });
});

describe('agent preflight', () => {
  // setup points the hooks at the private fleet's scripts
  const { hookScript, statusScript } = resolvePaths('/home/t/.svall');
  const claudeSettings = JSON.stringify(mergeStatusLine(mergeHooks({}, `node ${shq(hookScript)} claude`, hookScript), statusWrapper('node', statusScript), statusScript));
  const codexHooks = JSON.stringify(mergeCodexHooks({}, codexHookCommand(hookScript), hookScript));
  const missing = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  const runner = (answers: Record<string, { code?: number; stdout: string }>): AgentRun => async (cmd, args) => {
    const a = answers[[cmd, ...args].join(' ')];
    if (!a) throw missing;
    return { code: a.code ?? 0, stdout: a.stdout };
  };

  it('reads the version, login, home and hooks each CLI reports, honouring CLAUDE_CONFIG_DIR and CODEX_HOME', async () => {
    const files: Record<string, string> = { '/cfg/claude/settings.json': claudeSettings, '/cfg/codex/hooks.json': codexHooks };
    const deps = {
      run: runner({
        'claude --version': { stdout: '2.1.280 (Claude Code)\n' },
        'claude auth status': { stdout: JSON.stringify({ loggedIn: true, configDirectory: '/cfg/claude' }) },
        'codex --version': { stdout: 'codex-cli 0.156.1\n' },
        'codex login status': { stdout: 'Logged in using ChatGPT\n' },
      }),
      read: async (f: string) => files[f],
      env: { CLAUDE_CONFIG_DIR: '/cfg/claude', CODEX_HOME: '/cfg/codex' },
      homedir: '/home/t',
    };
    expect(await probeAgent('claude', deps)).toEqual({ kind: 'claude', version: '2.1.280', home: '/cfg/claude', loggedIn: true, hooks: true });
    expect(await probeAgent('codex', deps)).toEqual({ kind: 'codex', version: '0.156.1', home: '/cfg/codex', loggedIn: true, hooks: true });
  });

  it("reads OpenCode's version, its login as auth list --standalone answers, and its plugin where XDG_CONFIG_HOME puts it, and places its sessions in the private fleet's logs", async () => {
    const env = { XDG_CONFIG_HOME: '/cfg' };
    const plugin = opencodePaths(env, '/home/t').plugin;
    const logs = path.join(profileHome(PRIVATE, '/home/t'), 'transcripts/opencode');
    const deps = (login: number, files: Record<string, string>) => ({
      run: runner({ 'opencode --version': { stdout: '2.0.22\n' }, 'opencode auth list --standalone': { code: login, stdout: '' } }),
      read: async (f: string) => files[f], env, homedir: '/home/t',
    });
    expect(await probeAgent('opencode', deps(0, { [plugin]: '// svall' }))).toEqual({ kind: 'opencode', version: '2.0.22', home: logs, loggedIn: true, hooks: true });
    expect(await probeAgent('opencode', deps(1, {}))).toEqual({ kind: 'opencode', version: '2.0.22', home: logs, loggedIn: false, hooks: false });
    expect(await probeAgent('opencode', { ...deps(0, {}), run: runner({}) })).toEqual({ kind: 'opencode', home: logs, loggedIn: false, hooks: false });
  });

  it('sees a CLI that is missing, logged out or without hooks', async () => {
    const deps = {
      run: runner({
        'claude --version': { stdout: '2.1.280 (Claude Code)' },
        'claude auth status': { code: 1, stdout: JSON.stringify({ loggedIn: false }) },
      }),
      read: async () => undefined, env: {}, homedir: '/home/t',
    };
    expect(await probeAgent('claude', deps)).toEqual({ kind: 'claude', version: '2.1.280', home: '/home/t/.claude', loggedIn: false, hooks: false });
    expect(await probeAgent('codex', deps)).toEqual({ kind: 'codex', home: '/home/t/.codex', loggedIn: false, hooks: false });
  });

  it('blocks on the destination CLI, either release, login and hooks, only for the agents the fleet runs', () => {
    const ok = (kind: 'claude' | 'codex', o: Partial<AgentProbe> = {}): AgentProbe =>
      ({ kind, version: kind === 'claude' ? '2.1.280' : '0.156.1', home: `/h/.${kind}`, loggedIn: true, hooks: true, ...o });
    const codes = (source: AgentProbe[], destination: AgentProbe[], kinds: ('claude' | 'codex')[] = ['claude']) =>
      agentBlockers({ kinds, source, destination }).map((b) => b.code);
    expect(codes([ok('claude')], [ok('claude')])).toEqual([]);
    expect(codes([ok('claude')], [ok('claude', { version: '2.1.251' })])).toEqual([]);
    expect(codes([ok('claude')], [])).toEqual(['agent_cli_missing']);
    expect(codes([ok('claude')], [ok('claude', { version: undefined })])).toEqual(['agent_cli_missing']);
    // the Mac's own release, and one newer than any adapter has seen
    expect(codes([ok('claude', { version: '2.1.283' })], [ok('claude', { version: '2.1.283' })])).toEqual([]);
    expect(codes([ok('claude')], [ok('claude', { version: '2.4.0' })])).toEqual([]);
    expect(codes([ok('claude')], [ok('claude', { version: '2.1.250' })])).toEqual(['incompatible_adapter']);
    expect(codes([ok('claude', { version: '2.1.200' })], [ok('claude')])).toEqual(['incompatible_adapter']);
    expect(agentBlockers({ kinds: ['claude'], source: [ok('claude', { version: '2.1.200' })], destination: [ok('claude', { version: '2.1.250' })] })[0].message)
      .toBe("a handover carries claude sessions from 2.1.251 on; update this machine's claude 2.1.200 and the destination's claude 2.1.250");
    expect(codes([ok('claude')], [ok('claude', { loggedIn: false })])).toEqual(['agent_logged_out']);
    expect(codes([ok('claude')], [ok('claude', { hooks: false })])).toEqual(['agent_hooks_missing']);
    // a fleet running no Codex does not care how Codex is on either machine
    expect(codes([ok('claude')], [ok('claude'), ok('codex', { version: '0.1.0', loggedIn: false })])).toEqual([]);
    expect(codes([ok('claude'), ok('codex')], [ok('claude'), ok('codex', { loggedIn: false })], ['claude', 'codex'])).toEqual(['agent_logged_out']);
    const oc = (o: Partial<AgentProbe> = {}): AgentProbe => ({ kind: 'opencode', version: '2.0.22', home: '/h/.svall/transcripts/opencode', loggedIn: true, hooks: true, ...o });
    const fleet = (destination: AgentProbe) => agentBlockers({ kinds: ['claude', 'opencode'], source: [ok('claude'), oc()], destination: [ok('claude'), destination] }).map((b) => b.code);
    expect(fleet(oc())).toEqual([]);
    expect(fleet(oc({ version: '2.0.21' }))).toEqual(['incompatible_adapter']);
    expect(fleet(oc({ loggedIn: false }))).toEqual(['agent_logged_out']);
    expect(fleet(oc({ hooks: false }))).toEqual(['agent_hooks_missing']);
    expect(agentBlockers({ kinds: ['opencode'], source: [oc()], destination: [oc({ hooks: false })] })[0].message)
      .toBe(`Svall's plugin is not installed for OpenCode on the destination (${opencodePaths({}, '~').plugin}, or under its XDG_CONFIG_HOME): run svall setup there`);
  });
});

describe('the repair brief', () => {
  it('starts a new conversation from a summary of the old one, and says so', () => {
    const { version, id, slug } = CLAUDE[0];
    const file = path.join(FIXTURES, 'claude', version, 'projects', slug, `${id}.jsonl`);
    const before = fs.readFileSync(file);
    const brief = repairBrief('claude', before.toString(), { sessionId: id });
    expect(brief).toMatch(/^This is a new Claude Code session./);
    expect(brief).toContain(id);
    expect(brief).toContain('MARBLE-mac');
    expect(brief).not.toMatch(/resum(ed|ing) (the|this) (same )?conversation/i);
    expect(fs.readFileSync(file)).toEqual(before);
  });
});
