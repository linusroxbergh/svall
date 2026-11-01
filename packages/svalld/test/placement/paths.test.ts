import { describe, expect, it } from 'vitest';
import { destinationPaths, sessionLanding, type Homes } from '../../src/placement/paths.js';
import type { SessionFs } from '../../src/sessions/types.js';
import { robot } from './world.js';

const HOMES: Homes = {
  user: { from: '/Users/ada', to: '/home/ada' },
  agent: {
    claude: { from: '/Users/ada/.claude', to: '/home/ada/.cfg/claude' },
    codex: { from: '/Users/ada/.codex', to: '/home/ada/.codex' },
    opencode: { from: '/Users/ada/.local/share/opencode', to: '/home/ada/.opencode' },
  },
};
const MAIN = '/Users/ada/code/app';
const CLONE = '/home/ada/code/app';
const WT = `${MAIN}/.claude/worktrees/kb`;

const robotAt = (root: string, o: Partial<ReturnType<typeof robot>> & { mainRoot?: string; cwd?: string } = {}) => {
  const { mainRoot = MAIN, cwd = root, ...rest } = o;
  return robot({ id: 'c_1', cwd, repo: { root, mainRoot, branch: 'kb', isWorktree: root !== mainRoot }, ...rest });
};

describe('destinationPaths', () => {
  it('a worktree under the main checkout lands under the clone at the same relative path', () => {
    const p = destinationPaths(robotAt(WT), CLONE, HOMES);
    expect(p.root).toBe(`${CLONE}/.claude/worktrees/kb`);
    expect(p.repo).toEqual({ root: p.root, mainRoot: CLONE, branch: 'kb', isWorktree: true });
  });

  it('a cwd inside the worktree stays inside it', () => {
    const p = destinationPaths(robotAt(WT, { cwd: `${WT}/packages/cli`, second: { cwd: `${WT}/docs`, unread: false } as never }), CLONE, HOMES);
    expect(p.cwd).toBe(`${CLONE}/.claude/worktrees/kb/packages/cli`);
    expect(p.second).toBe(`${CLONE}/.claude/worktrees/kb/docs`);
  });

  it('a cwd outside the worktree is relocated between user homes', () => {
    const p = destinationPaths(robotAt(WT, { cwd: '/Users/ada/notes', panePath: '/tmp/x' }), CLONE, HOMES);
    expect(p.cwd).toBe('/home/ada/notes');
    expect(p.panePath).toBe('/tmp/x');
  });

  it('a worktree outside the main checkout is relocated between user homes', () => {
    const p = destinationPaths(robotAt('/Users/ada/wt/kb'), CLONE, HOMES);
    expect(p.root).toBe('/home/ada/wt/kb');
    expect(p.repo?.mainRoot).toBe(CLONE);
  });

  it('a robot on main lands on the clone itself, trailing slash or not', () => {
    const p = destinationPaths(robotAt(MAIN, { cwd: `${MAIN}/src/` }), `${CLONE}/`, HOMES);
    expect(p.root).toBe(CLONE);
    expect(p.cwd).toBe(`${CLONE}/src`);
    expect(p.repo?.isWorktree).toBe(false);
  });

  it('a Claude transcript lands under the worker\'s CLAUDE_CONFIG_DIR at the same relative path', () => {
    const t = '/Users/ada/.claude/projects/-Users-ada-code-app/s.jsonl';
    const p = destinationPaths(robotAt(WT, { agent: { kind: 'claude', sessionId: 's', transcriptPath: t } as never }), CLONE, HOMES);
    expect(p.transcriptPath).toBe('/home/ada/.cfg/claude/projects/-Users-ada-code-app/s.jsonl');
  });

  it('a Codex transcript follows the Codex home, and a shell robot has none', () => {
    const t = '/Users/ada/.codex/sessions/2026/10/rollout-s.jsonl';
    const p = destinationPaths(robotAt(WT, { agent: { kind: 'codex', sessionId: 's', transcriptPath: t } as never }), CLONE, HOMES);
    expect(p.transcriptPath).toBe('/home/ada/.codex/sessions/2026/10/rollout-s.jsonl');
    expect(destinationPaths(robotAt(WT), CLONE, HOMES).transcriptPath).toBeUndefined();
  });
});

describe('destinationPaths edge cases', () => {
  it('a robot in no repository is relocated between user homes and gets no repo', () => {
    const p = destinationPaths(robot({ id: 'c_1', cwd: '/Users/ada/notes' }), CLONE, HOMES);
    expect(p).toEqual({ root: '/home/ada/notes', cwd: '/home/ada/notes' });
  });

  it('a worktree whose path only shares a prefix with the main checkout is relocated, not put under the clone', () => {
    const p = destinationPaths(robotAt('/Users/ada/code/app2'), CLONE, HOMES);
    expect(p.root).toBe('/home/ada/code/app2');
  });

  it('an OpenCode transcript follows the OpenCode home', () => {
    const t = '/Users/ada/.local/share/opencode/transcripts/opencode/ses_x.jsonl';
    const p = destinationPaths(robotAt(WT, { agent: { kind: 'opencode', sessionId: 'ses_x', transcriptPath: t } as never }), CLONE, HOMES);
    expect(p.transcriptPath).toBe('/home/ada/.opencode/transcripts/opencode/ses_x.jsonl');
  });

  it('the second terminal\'s own agent transcript follows its kind', () => {
    const t = '/Users/ada/.codex/sessions/2026/10/rollout-s.jsonl';
    const second = { cwd: WT, unread: false, agent: { kind: 'codex', sessionId: 's', transcriptPath: t } } as never;
    const p = destinationPaths(robotAt(WT, { second }), CLONE, HOMES);
    expect(p.secondTranscriptPath).toBe('/home/ada/.codex/sessions/2026/10/rollout-s.jsonl');
    expect(p.transcriptPath).toBeUndefined();
  });
});

describe('sessionLanding', () => {
  const ID = '0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0';
  const entry = (dir: boolean) => ({ isFile: () => !dir, isDirectory: () => dir, isSymbolicLink: () => false });
  const fs: SessionFs = {
    lstat: async (p) => entry(!p.endsWith('.jsonl')),
    readdir: async () => [],
  };

  it('reports the source agent home and the session files relative to it', async () => {
    const t = `/Users/ada/.claude/projects/-p/${ID}.jsonl`;
    const r = robotAt(WT, { agent: { kind: 'claude', sessionId: ID, transcriptPath: t } as never });
    expect(await sessionLanding(r, fs)).toEqual({ sourceHome: '/Users/ada/.claude', files: [`projects/-p/${ID}.jsonl`] });
  });

  it('finds a Codex rollout under its home', async () => {
    const t = '/Users/ada/.codex/sessions/2026/10/25/rollout-2026-10-25T10-00-00-' + ID + '.jsonl';
    const r = robotAt(WT, { agent: { kind: 'codex', sessionId: ID, transcriptPath: t } as never });
    expect(await sessionLanding(r, fs)).toEqual({ sourceHome: '/Users/ada/.codex', files: [t.slice('/Users/ada/.codex/'.length)] });
  });

  it('finds an OpenCode log and its export', async () => {
    const sid = 'ses_0123456789abAbCdEfGhIjKlMn';
    const t = `/Users/ada/.svall/transcripts/opencode/${sid}.jsonl`;
    const r = robotAt(WT, { agent: { kind: 'opencode', sessionId: sid, transcriptPath: t } as never });
    expect(await sessionLanding(r, fs)).toEqual({ sourceHome: '/Users/ada/.svall/transcripts/opencode', files: [`${sid}.jsonl`, `exports/${sid}.json`] });
  });

  it('a robot with no transcript has no files', async () => {
    expect(await sessionLanding(robotAt(WT), fs)).toEqual({ sourceHome: '', files: [] });
  });

  it('a Claude session never prompted, which wrote no transcript yet, has no files; any other missing transcript refuses', async () => {
    const none: SessionFs = { ...fs, lstat: async (p) => { throw Object.assign(new Error(`${p} is not there`), { code: 'ENOENT' }); } };
    const t = `/Users/ada/.claude/projects/-p/${ID}.jsonl`;
    expect(await sessionLanding(robotAt(WT, { agent: { kind: 'claude', sessionId: ID, transcriptPath: t } as never }), none)).toEqual({ sourceHome: '', files: [] });
    const rollout = `/Users/ada/.codex/sessions/2026/10/25/rollout-2026-10-25T10-00-00-${ID}.jsonl`;
    await expect(sessionLanding(robotAt(WT, { agent: { kind: 'codex', sessionId: ID, transcriptPath: rollout } as never }), none)).rejects.toThrow('is not there');
  });
});
