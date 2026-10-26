import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResumeFolder, Warning } from '@svall/protocol';
import { claudeAdapter } from '../../src/sessions/claude.js';
import { codexAdapter } from '../../src/sessions/codex.js';
import { opencodeAdapter } from '../../src/sessions/opencode.js';
import {
  HANDOVER_KINDS, adapterFor, agentAdapters, agentBlockers, cliRunner, probeAgent, realProbeDeps, type AgentProbe, type AgentRun,
} from '../../src/sessions/registry.js';
import { repairBrief } from '../../src/sessions/repair.js';
import { SessionError, type CliRun, type SessionFs } from '../../src/sessions/types.js';
import { mergeCodexHooks, mergeHooks, mergeStatusLine, statusWrapper } from '../../src/agent-hooks.js';
import { codexHookCommand } from '../../src/codex/install.js';
import { BWRAP_PROFILE, USERNS_RESTRICTED } from '../../src/codex/install.js';
import { opencodePaths } from '../../src/opencode/install.js';
import { resolvePaths } from '../../src/paths.js';
import { PRIVATE, profileHome } from '../../src/profile.js';
import { shq } from '../../src/text.js';
import { fakeEnv, hold, type Exported } from './fake-opencode.js';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/handover');
const made: string[] = [];
const tmp = (): string => { const d = fs.realpathSync(fs.mkdtempSync('/tmp/svall-s-')); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const fsOf: SessionFs = {
  lstat: (p) => fs.promises.lstat(p),
  readdir: (p) => fs.promises.readdir(p, { encoding: 'buffer' }),
};

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
  { version: '2.1.306', id: 'e6b13e68-3d40-4759-91a3-5c1cde740f9d', slug: '-Users-source-work-demo', agent: 'agent-a1774cad8a601f106' },
] as const;
const CODEX = [
  // written before the oldest Codex Svall runs, so the CLI that carries it has been updated since
  { version: '0.155.1', cli: '0.156.0', file: 'sessions/2026/09/23/rollout-2026-09-23T08-44-38-01a0cd02-5930-73f0-ad55-add2b1effa04.jsonl', id: '01a0cd02-5930-73f0-ad55-add2b1effa04' },
  { version: '0.156.1', file: 'sessions/2026/09/23/rollout-2026-09-23T08-44-52-01a0cd02-8ea0-75c1-89b3-89718ecbd91f.jsonl', id: '01a0cd02-8ea0-75c1-89b3-89718ecbd91f' },
  { version: '0.162.1', file: 'sessions/2026/10/21/rollout-2026-10-21T20-28-35-01a15fb8-ddb3-7720-9bbc-6558d68e05f4.jsonl', id: '01a15fb8-ddb3-7720-9bbc-6558d68e05f4' },
] as const;
// the real `session export --standalone` each release wrote, sanitized
const OPENCODE = [{ version: '2.1.1', id: 'ses_ea0466195ffe4ecU6vYSCBwDEd' }] as const;

describe('the adapter registry', () => {
  it('reads every Claude Code and Codex release from its adapter\'s minimum on, and none before', () => {
    for (const v of ['2.1.251', '2.1.280', '2.1.283', '2.2.0', '3.0.0', '2.1.300-beta.1']) expect(adapterFor('claude', v), v).toBe(claudeAdapter);
    for (const v of ['0.156.0', '0.156.1', '0.157.0', '1.0.0', '0.160.0-alpha.1']) expect(adapterFor('codex', v), v).toBe(codexAdapter);
    for (const v of ['2.1.250', '2.1.251-beta.1', '2.0.0']) expect(adapterFor('claude', v), v).toBeUndefined();
    for (const v of ['0.142.0-alpha.6', '0.142.0', '0.155.1', '0.156.0-alpha.3']) expect(adapterFor('codex', v), v).toBeUndefined();
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

describe.each(OPENCODE)('an OpenCode export as $version wrote it', ({ version, id }) => {
  const kept = path.join(FIXTURES, 'opencode', version, `${id}.json`);
  const real = (): Exported => JSON.parse(fs.readFileSync(kept, 'utf8'));

  it('is written out with no undo pending, and refused with one', async () => {
    const base = tmp();
    const env = fakeEnv(path.join(base, 'oc'));
    hold(env, real());
    const file = path.join(base, 'out.json');
    await opencodeAdapter.exportSession!(id, file, cliRunner(env), base);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(real());
    const undone = real();
    undone.info.revert = { messageID: undone.messages[1].id };
    hold(env, undone);
    await expect(opencodeAdapter.exportSession!(id, file, cliRunner(env), base))
      .rejects.toMatchObject({ code: 'transcript_missing', message: expect.stringContaining('has an undo pending') });
  });

  it('is told apart by its message ids from a copy here that went on another way', async () => {
    const base = tmp();
    const env = fakeEnv(path.join(base, 'oc'));
    hold(env, real());
    await expect(opencodeAdapter.checkSession!(id, kept, base, cliRunner(env))).resolves.toBeUndefined();
    const went = real();
    went.messages.splice(-1, 1, { ...went.messages.at(-1)!, id: 'msg_15fb9c51300168SRdmut5Yo4Lt' });
    hold(env, went);
    await expect(opencodeAdapter.checkSession!(id, kept, base, cliRunner(env))).rejects.toMatchObject({ code: 'destination_diverged' });
  });

  it('is taken back into the folder it ran in', async () => {
    const asked: string[][] = [];
    const run: CliRun = async (_cmd, args) => { asked.push(args); return { code: 0, stdout: `Imported session: ${id}\n`, stderr: '' }; };
    await opencodeAdapter.restoreSession!(id, kept, run);
    expect(asked).toEqual([['session', 'import', '--standalone', '--directory', '/Users/source/work/demo', kept]]);
  });
});

describe('OpenCode sessions', () => {
  const ID = 'ses_0f3a5b7c9d1eAbCdEfGhIjKlMn';
  const session = (directory: string, texts: string[]): Exported => ({ info: { id: ID, location: { directory } }, messages: texts.map((text, i) => ({ id: `msg_${i}`, text })) });
  const turn = (text: string): string => `${JSON.stringify({ kind: 'user', text })}\n`;

  /** One machine: its OpenCode, keeping sessions in a database of its own, and the folder Svall's plugin logs each session in. */
  function side(base: string, name: string): { env: NodeJS.ProcessEnv; run: CliRun; logs: string } {
    const env = fakeEnv(path.join(base, `${name}-opencode`));
    const logs = path.join(base, name, '.svall/transcripts/opencode');
    fs.mkdirSync(logs, { recursive: true });
    return { env, run: cliRunner(env), logs };
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

  it("refuses a session id that is not OpenCode's own, as one a peer's manifest names", async () => {
    const logs = path.join(tmp(), '.svall/transcripts/opencode');
    fs.mkdirSync(logs, { recursive: true });
    for (const id of ['-x', 'x', 'ses_short']) {
      fs.writeFileSync(path.join(logs, `${id}.jsonl`), turn('hi'));
      await expect(opencodeAdapter.discover(path.join(logs, `${id}.jsonl`), id, fsOf), id).rejects.toMatchObject({ code: 'transcript_missing' });
    }
    for (const id of ['../x', '-x', 'x']) {
      for (const f of [`${id}.jsonl`, `exports/${id}.json`]) expect(opencodeAdapter.carries(f, `${id}.jsonl`, id), f).toBe(false);
    }
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

  it('names an OpenCode it cannot run apart from a session it does not hold', async () => {
    const run = cliRunner({ PATH: '/nonexistent' });
    await expect(opencodeAdapter.exportSession!(ID, os.devNull, run, tmp())).rejects.toMatchObject({ code: 'agent_cli_missing' });
    await expect(opencodeAdapter.importSession!(ID, os.devNull, tmp(), run)).rejects.toMatchObject({ code: 'agent_cli_missing' });
  });

  it('names an export file it cannot write as that, not as an OpenCode it cannot run', async () => {
    const dir = tmp();
    const sealed = path.join(dir, 'sealed');
    fs.mkdirSync(sealed, { mode: 0o500 });
    await expect(opencodeAdapter.exportSession!(ID, path.join(sealed, 'out.json'), cliRunner(fakeEnv(path.join(dir, 'oc'))), dir))
      .rejects.toMatchObject({ code: 'transcript_missing', message: expect.stringContaining('EACCES') });
  });

  it('gives up on an OpenCode still running at its deadline, saying so, and kills it soon after though it ignores SIGTERM', async () => {
    const dir = tmp();
    const bin = path.join(dir, 'bin');
    const pidFile = path.join(dir, 'pid');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'opencode'), `#!/bin/sh\ntrap '' TERM\necho $$ > ${shq(pidFile)}\nexec sleep 20\n`, { mode: 0o755 });
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const pid = (): number => Number(fs.readFileSync(pidFile, 'utf8'));
    const started = Date.now();
    try {
      await expect(opencodeAdapter.exportSession!(ID, path.join(dir, 'out.json'), cliRunner({ ...process.env, PATH: `${bin}:${process.env.PATH}` }, 2000), dir))
        .rejects.toMatchObject({ code: 'transcript_missing', message: expect.stringContaining('did not finish within 2 s') });
      expect(Date.now() - started).toBeLessThan(3500);
      expect(alive(pid())).toBe(true);
      await vi.waitFor(() => expect(alive(pid())).toBe(false), { timeout: 5000, interval: 100 });
    } finally {
      try { process.kill(pid(), 'SIGKILL'); } catch { /* gone */ }
    }
  }, 15_000);

  it('runs the CLI where it is told, or in the home, never the daemon\'s folder, and without the variables that make Svall\'s hooks act', async () => {
    const env = { ...process.env, SVALL_ROBOT_ID: 'c_ada', SVALL_TERM: '2', KEPT: 'yes' };
    const printed = (await cliRunner(env)('env', [])).stdout;
    expect(printed).toContain('KEPT=yes');
    expect(printed).not.toMatch(/^SVALL_(ROBOT_ID|TERM)=/m);
    const dir = tmp();
    expect((await cliRunner(env)('pwd', [], { cwd: dir })).stdout.trim()).toBe(dir);
    expect(fs.realpathSync((await cliRunner(env)('pwd', [])).stdout.trim())).toBe(fs.realpathSync(os.homedir()));
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

  it("reads OpenCode's version, its login as a model provider auth list --standalone names, and its plugin where XDG_CONFIG_HOME puts it, and places its sessions in the private fleet's logs", async () => {
    const env = { XDG_CONFIG_HOME: '/cfg' };
    const plugin = opencodePaths(env, '/home/t').plugin;
    const logs = path.join(profileHome(PRIVATE, '/home/t'), 'transcripts/opencode');
    // as OpenCode 2.0.22 to 2.1.1 print it: an MCP server's login is an integration too
    const mcp = { id: 'mcp_27245be96d0b1111', name: 'linear', connections: [{ type: 'credential', label: 'linear' }] };
    const openai = { id: 'openai', name: 'OpenAI', connections: [{ type: 'credential', label: 'OpenAI' }] };
    const deps = (login: number, listed: unknown[], files: Record<string, string>) => ({
      run: runner({ 'opencode --version': { stdout: '2.0.22\n' }, 'opencode auth list --standalone --format json': { code: login, stdout: JSON.stringify(listed) } }),
      read: async (f: string) => files[f], env, homedir: '/home/t',
    });
    expect(await probeAgent('opencode', deps(0, [mcp, openai], { [plugin]: '// svall' }))).toEqual({ kind: 'opencode', version: '2.0.22', home: logs, loggedIn: true, hooks: true });
    expect(await probeAgent('opencode', deps(0, [mcp], {}))).toEqual({ kind: 'opencode', version: '2.0.22', home: logs, loggedIn: false, hooks: false });
    expect(await probeAgent('opencode', deps(0, [], {}))).toEqual({ kind: 'opencode', version: '2.0.22', home: logs, loggedIn: false, hooks: false });
    expect(await probeAgent('opencode', deps(1, [openai], {}))).toEqual({ kind: 'opencode', version: '2.0.22', home: logs, loggedIn: false, hooks: false });
    expect(await probeAgent('opencode', { ...deps(0, [], {}), run: runner({}) })).toEqual({ kind: 'opencode', home: logs, loggedIn: false, hooks: false });
  });

  it("asks an agent's login with the fleet's .env keys, as a resumed robot has them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-probe-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // an OpenCode that lists the provider whose key its environment holds
    fs.writeFileSync(path.join(bin, 'opencode'), '#!/bin/sh\n[ "$1" = --version ] && { echo 2.0.22; exit 0; }\n[ -n "$ANTHROPIC_API_KEY" ] && echo \'[{"id":"anthropic"}]\' || echo \'[]\'\n', { mode: 0o755 });
    const envFile = path.join(dir, '.env');
    const PATH = process.env.PATH;
    process.env.PATH = `${bin}:${PATH}`;
    try {
      expect((await probeAgent('opencode', realProbeDeps(envFile))).loggedIn).toBe(false);
      fs.writeFileSync(envFile, 'ANTHROPIC_API_KEY=sk-ant-test\n');
      expect((await probeAgent('opencode', realProbeDeps(envFile))).loggedIn).toBe(true);
    } finally {
      process.env.PATH = PATH;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says when AppArmor keeps Codex from sandboxing its commands, as only Linux's restriction of user namespaces can", async () => {
    const codexHooksAt = { '/home/t/.codex/hooks.json': codexHooks };
    const denied = 'bwrap: setting up uid map: Permission denied\nbwrap: No permissions to create new namespace';
    const deps = (restricted: string | undefined, sandbox: number, stderr = denied) => ({
      run: async (cmd: string, args: string[]) => ([cmd, ...args].join(' ') === 'codex sandbox -- true'
        ? { code: sandbox, stdout: '', stderr } : runner({ 'codex --version': { stdout: 'codex-cli 0.156.1\n' }, 'codex login status': { stdout: 'Logged in\n' } })(cmd, args)),
      read: async (f: string) => (f === USERNS_RESTRICTED ? restricted : codexHooksAt[f as keyof typeof codexHooksAt]), env: {}, homedir: '/home/t',
    });
    expect((await probeAgent('codex', deps('1\n', 1))).sandbox).toBe(`AppArmor keeps bwrap from making the user namespace Codex runs commands in, so a Codex robot asks before each one: ${BWRAP_PROFILE}`);
    // any other failure is named as it is
    expect((await probeAgent('codex', deps('1\n', 2, 'error: unknown subcommand'))).sandbox).toBe('codex sandbox -- true fails there (error: unknown subcommand): run it there to see why');
    expect(await probeAgent('codex', deps('1\n', 0))).toEqual({ kind: 'codex', version: '0.156.1', home: '/home/t/.codex', loggedIn: true, hooks: true });
    expect((await probeAgent('codex', deps('0\n', 1))).sandbox).toBeUndefined();
    expect((await probeAgent('codex', deps(undefined, 1))).sandbox).toBeUndefined();
    expect(agentAdapters([{ kind: 'codex', version: '0.156.1', home: '/h', loggedIn: true, hooks: true, sandbox: 'no' }])[0].sandbox).toBe('no');
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
    // a destination older than the source may not read what the source's release wrote; a newer one does
    expect(codes([ok('claude')], [ok('claude', { version: '2.1.251' })])).toEqual(['incompatible_adapter']);
    expect(agentBlockers({ kinds: ['claude'], source: [ok('claude')], destination: [ok('claude', { version: '2.1.251' })] })[0].message)
      .toBe("the destination's claude 2.1.251 is older than this machine's 2.1.280, which writes sessions it may not read; update claude on the destination");
    expect(codes([ok('claude', { version: '2.1.251' })], [ok('claude')])).toEqual([]);
    // the same prerelease on both, or a later one there, reads what this machine wrote
    expect(codes([ok('claude', { version: '2.1.290-beta.1' })], [ok('claude', { version: '2.1.290-beta.1' })])).toEqual([]);
    expect(codes([ok('claude', { version: '2.1.290-beta.1' })], [ok('claude', { version: '2.1.290-beta.2' })])).toEqual([]);
    expect(codes([ok('claude', { version: '2.1.290-beta.1' })], [ok('claude', { version: '2.1.290' })])).toEqual([]);
    expect(codes([ok('claude', { version: '2.1.290' })], [ok('claude', { version: '2.1.290-beta.2' })])).toEqual(['incompatible_adapter']);
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
    // an OpenCode that answers here with no provider's login, as on OpenCode Zen's free models, only warns of none there
    const zen = (source: AgentProbe, opencodeAnswered: boolean) => {
      const warnings: Warning[] = [];
      const blockers = agentBlockers({ kinds: ['opencode'], source: [source], destination: [oc({ loggedIn: false })], opencodeAnswered }, warnings);
      return { blockers: blockers.map((b) => b.code), warnings };
    };
    expect(zen(oc({ loggedIn: false }), true)).toEqual({ blockers: [], warnings: [{
      code: 'agent_logged_out',
      message: "opencode is not logged in on the destination, nor here, where its agent answers without a login, as on OpenCode Zen's free models; for a provider's model, run opencode auth login there",
    }] });
    expect(zen(oc({ loggedIn: false }), false)).toEqual({ blockers: ['agent_logged_out'], warnings: [] });
    expect(zen(oc(), true)).toEqual({ blockers: ['agent_logged_out'], warnings: [] });
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
