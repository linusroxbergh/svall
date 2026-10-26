import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import type { Robot } from '@svall/protocol';
import { claudeAdapter } from '../../src/handover/sessions/claude.js';
import { codexAdapter } from '../../src/handover/sessions/codex.js';
import { opencodeAdapter } from '../../src/handover/sessions/opencode.js';
import { silentLogger } from '../../src/log.js';
import { wake, type MoveJournal } from '../../src/placement/move.js';
import { answerTrustPrompt, seedTrust } from '../../src/placement/trust.js';
import type { Screen } from '../../src/tmux/tmux.js';
import { cleanHomes, makeHome } from '../helpers.js';

afterEach(cleanHomes);

// a worker's Claude config folder as CLAUDE_CONFIG_DIR names it, and a clone beside it
function worker() {
  const base = fs.realpathSync(makeHome());
  const agentHome = path.join(base, 'cfg', 'claude');
  const clone = path.join(base, 'code', 'app');
  fs.mkdirSync(agentHome, { recursive: true });
  fs.mkdirSync(path.join(clone, '.claude', 'worktrees', 'kanban'), { recursive: true });
  return { base, agentHome, clone, worktree: path.join(clone, '.claude', 'worktrees', 'kanban') };
}

describe('seedTrust', () => {
  it('seeds the clone root in .claude.json keeping unrelated keys, and skips while a claude process runs', async () => {
    const w = worker();
    const file = path.join(w.agentHome, '.claude.json');
    const before = {
      numStartups: 41, oauthAccount: { emailAddress: 'ada@example.com' }, hasCompletedOnboarding: true,
      projects: { '/home/ada/other': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] }, [w.clone]: { lastCost: 2 } },
    };
    fs.writeFileSync(file, JSON.stringify(before), { mode: 0o600 });
    const folder = { cwd: w.worktree, repo: w.clone, root: w.worktree };
    expect(claudeAdapter.trusts!(w.agentHome, folder)).toBe(false);

    expect(await seedTrust('claude', w.clone, { agentHome: w.agentHome, agentRunning: async () => false })).toBe('seeded');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after).toEqual({ ...before, projects: { ...before.projects, [w.clone]: { lastCost: 2, hasTrustDialogAccepted: true } } });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(claudeAdapter.trusts!(w.agentHome, folder)).toBe(true);

    const other = path.join(w.base, 'code', 'svall');
    const held = fs.readFileSync(file);
    expect(await seedTrust('claude', other, { agentHome: w.agentHome, agentRunning: async () => true })).toBe('skipped');
    expect(fs.readFileSync(file)).toEqual(held);
  });

  it('appends the clone to Codex\'s config.toml once, leaving the rest of the file as it was, and an entry already there alone', async () => {
    const w = worker();
    const file = path.join(w.agentHome, 'config.toml');
    const before = 'model = "gpt-6-sol"\n\n[projects."/home/ada/other"]\ntrust_level = "trusted"\n';
    fs.writeFileSync(file, before);

    expect(await seedTrust('codex', w.clone, { agentHome: w.agentHome, agentRunning: async () => false })).toBe('seeded');
    expect(await seedTrust('codex', w.clone, { agentHome: w.agentHome, agentRunning: async () => false })).toBe('seeded');
    const text = fs.readFileSync(file, 'utf8');
    expect(text.startsWith(before)).toBe(true);
    expect((parseToml(text) as { projects: Record<string, unknown> }).projects).toEqual({
      '/home/ada/other': { trust_level: 'trusted' }, [w.clone]: { trust_level: 'trusted' },
    });
    expect(codexAdapter.trusts!(w.agentHome, { cwd: w.worktree, repo: w.clone })).toBe(true);

    // a folder the user chose not to trust stays so
    const distrusted = path.join(w.base, 'code', 'svall');
    fs.appendFileSync(file, `\n[projects."${distrusted}"]\ntrust_level = "untrusted"\n`);
    const held = fs.readFileSync(file);
    expect(await seedTrust('codex', distrusted, { agentHome: w.agentHome, agentRunning: async () => false })).toBe('skipped');
    expect(fs.readFileSync(file)).toEqual(held);
  });
});

const TRUST_DIALOG = [
  ' Do you trust the files in this folder?', '', ' /home/ada/code/app/.claude/worktrees/kanban', '',
  ' ❯ 1. No, exit', '   2. Yes, I trust this folder', '', ' Enter to confirm · Esc to exit',
];
const CODEX_DIALOG = [
  '  Folder access', '  /home/ada/code/app/.claude/worktrees/kanban', '',
  '  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.', '',
  '› 1. Trust and continue', '  2. Quit', '', '  enter continue · esc quit',
];

// a pane that shows `later` once it has been read `after` times, and the keys typed into it
function pane(after: number, later: string[]) {
  const typed: string[] = [];
  let reads = 0;
  const tmux = {
    screen: async (): Promise<Screen> => ({ rows: reads++ >= after ? later : ['$ claude --resume x', ''], cursor: 0, shown: true, command: 'claude' }),
    sendBytes: async (_paneId: string, bytes: Buffer) => { typed.push(bytes.toString('latin1')); },
  };
  return { tmux, typed, reads: () => reads };
}

describe('answerTrustPrompt', () => {
  it('types the trust answer\'s number when the pane shows the prompt within forMs', async () => {
    const p = pane(2, TRUST_DIALOG);
    expect(await answerTrustPrompt(p.tmux, '%1', claudeAdapter, { forMs: 5000 })).toBe('answered');
    // the answer's number, then Enter, once
    expect(p.typed).toEqual(['2', '\r']);
    expect(p.reads()).toBe(3);

    // a dialog that numbers no choice is walked down from the pointer
    const bare = pane(0, TRUST_DIALOG.map((r) => r.replace(/\d\. /, '')));
    expect(await answerTrustPrompt(bare.tmux, '%1', claudeAdapter, { forMs: 5000 })).toBe('answered');
    expect(bare.typed).toEqual(['\x1b[B', '\r']);

    const never = pane(Infinity, TRUST_DIALOG);
    expect(await answerTrustPrompt(never.tmux, '%1', claudeAdapter, { forMs: 1200 })).toBe('none');
    expect(never.typed).toEqual([]);
    // a CLI with no answer to give is never looked at
    expect(await answerTrustPrompt(never.tmux, '%1', opencodeAdapter, { forMs: 1200 })).toBe('none');
    expect(never.reads()).toBe(3);

    const codex = pane(1, CODEX_DIALOG);
    expect(await answerTrustPrompt(codex.tmux, '%1', codexAdapter, { forMs: 5000 })).toBe('answered');
    expect(codex.typed).toEqual(['1', '\r']);
  });
});

describe('wake', () => {
  it('counts a Codex robot up once its window opens, which reports no session until its first turn, and answers its trust question after', async () => {
    const robot = { id: 'c_1', name: 'kanban', revive: { command: 'codex resume x' }, agent: { kind: 'codex', sessionId: 'x', status: 'idle', lastActivityAt: 0 } } as unknown as Robot;
    const store = { state: { robots: { c_1: robot } }, subscribe: () => () => {} };
    const fleet = {
      reviveRobot: async () => { robot.tmux = { windowId: '@1', paneId: '%1' }; },
      openSecond: async () => {},
      onSessionStart: () => () => {},
    };
    let shown = false;
    const typed: string[] = [];
    const tmux = {
      screen: async () => ({ rows: shown ? CODEX_DIALOG : [], cursor: 0, shown: true, command: 'codex' }),
      sendBytes: async (_paneId: string, bytes: Buffer) => { typed.push(bytes.toString('latin1')); },
    };
    const began = Date.now();
    const j = { id: 'mv_0123456789', robotId: 'c_1' } as MoveJournal;
    expect(await wake({ store, fleet, tmux, log: silentLogger, watchMs: 5000 } as unknown as Parameters<typeof wake>[0], j)).toBeUndefined();
    expect(Date.now() - began).toBeLessThan(1000);
    shown = true;
    await vi.waitFor(() => expect(typed).toEqual(['1', '\r']), { timeout: 3000 });
  });
});
