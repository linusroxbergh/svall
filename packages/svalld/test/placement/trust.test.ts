import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import type { Robot } from '@svall/protocol';
import { claudeAdapter } from '../../src/sessions/claude.js';
import { codexAdapter } from '../../src/sessions/codex.js';
import { opencodeAdapter } from '../../src/sessions/opencode.js';
import { silentLogger } from '../../src/log.js';
import { wake, type MoveJournal } from '../../src/placement/move-steps.js';
import { lockAgentFiles } from '../../src/kernel-lock.js';
import { answerTrustPrompt, removeOwnedTrust, seedTrust, trustRecordFile } from '../../src/placement/trust.js';
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
  it.each(['claude', 'codex'] as const)('writes %s trust through a dotfile symlink and keeps a backup and mode', async (kind) => {
    const w = worker();
    const file = path.join(w.agentHome, kind === 'claude' ? '.claude.json' : 'config.toml');
    const target = path.join(w.base, 'dotfile');
    const before = kind === 'claude' ? '{"theme":"dark"}\n' : 'model = "mine"\n';
    fs.writeFileSync(target, before, { mode: 0o640 });
    fs.symlinkSync(target, file);
    await seedTrust(kind, w.clone, { agentHome: w.agentHome, homedir: w.base, agentRunning: async () => false, waitMs: 1000 });
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toContain(w.clone);
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    const backup = fs.readdirSync(w.base).find((f) => f.startsWith('dotfile.bak-'))!;
    expect(fs.readFileSync(path.join(w.base, backup), 'utf8')).toBe(before);
  });

  it.each(['claude', 'codex'] as const)('removes only recorded mission-control trust from %s, retaining the chosen project', async (kind) => {
    const w = worker();
    const file = path.join(w.agentHome, kind === 'claude' ? '.claude.json' : 'config.toml');
    const mc = path.join(w.base, 'mission-control');
    const recordFile = trustRecordFile(w.base);
    const opts = { agentHome: w.agentHome, homedir: w.base, agentRunning: async () => false, waitMs: 1000, create: true };
    await seedTrust(kind, mc, { ...opts, recordFile });
    await seedTrust(kind, w.clone, opts);
    await removeOwnedTrust(recordFile, w.base);
    const text = fs.readFileSync(file, 'utf8');
    const config = kind === 'claude' ? JSON.parse(text) : parseToml(text);
    expect(config.projects[mc]).toBeUndefined();
    expect(config.projects[w.clone]).toEqual(kind === 'claude' ? { hasTrustDialogAccepted: true } : { trust_level: 'trusted' });
    expect(fs.existsSync(recordFile)).toBe(false);
  });

  it.each(['claude', 'codex'] as const)('preserves %s mission-control trust that predates onboarding', async (kind) => {
    const w = worker();
    const file = path.join(w.agentHome, kind === 'claude' ? '.claude.json' : 'config.toml');
    const before = kind === 'claude' ? JSON.stringify({ projects: { [w.clone]: { hasTrustDialogAccepted: true } } })
      : `[projects.${JSON.stringify(w.clone)}]\ntrust_level = "trusted"\n`;
    fs.writeFileSync(file, before);
    const recordFile = trustRecordFile(w.base);
    await seedTrust(kind, w.clone, { agentHome: w.agentHome, homedir: w.base, agentRunning: async () => false, waitMs: 1000, recordFile });
    await removeOwnedTrust(recordFile, w.base);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('restores an earlier Claude trust value while keeping later project metadata', async () => {
    const w = worker();
    const file = path.join(w.agentHome, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({ projects: { [w.clone]: { hasTrustDialogAccepted: false, lastCost: 2 } } }));
    const recordFile = trustRecordFile(w.base);
    await seedTrust('claude', w.clone, { agentHome: w.agentHome, homedir: w.base, agentRunning: async () => false, waitMs: 1000, recordFile });
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.projects[w.clone].lastCost = 4;
    fs.writeFileSync(file, JSON.stringify(config));
    await removeOwnedTrust(recordFile, w.base);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).projects[w.clone]).toEqual({ hasTrustDialogAccepted: false, lastCost: 4 });
  });

  it('keeps a Codex trust table the user has extended instead of leaving its keys under another header', async () => {
    const w = worker();
    const file = path.join(w.agentHome, 'config.toml');
    const recordFile = trustRecordFile(w.base);
    await seedTrust('codex', w.clone, { agentHome: w.agentHome, homedir: w.base, agentRunning: async () => false, waitMs: 1000, recordFile });
    fs.appendFileSync(file, 'custom = "kept"\n');
    const before = fs.readFileSync(file, 'utf8');
    await removeOwnedTrust(recordFile, w.base);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

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

    expect(await seedTrust('claude', w.clone, { agentHome: w.agentHome, homedir: w.base, agentRunning: async () => false, waitMs: 1000 })).toBe('seeded');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after).toEqual({ ...before, projects: { ...before.projects, [w.clone]: { lastCost: 2, hasTrustDialogAccepted: true } } });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(claudeAdapter.trusts!(w.agentHome, folder)).toBe(true);

    const other = path.join(w.base, 'code', 'svall');
    const held = fs.readFileSync(file);
    expect(await seedTrust('claude', other, { agentHome: w.agentHome, homedir: w.base, agentRunning: async () => true, waitMs: 1000 })).toBe('skipped');
    expect(fs.readFileSync(file)).toEqual(held);
  });

  it('appends the clone to Codex\'s config.toml once, leaving the rest of the file as it was, and an entry already there alone', async () => {
    const w = worker();
    const file = path.join(w.agentHome, 'config.toml');
    const before = 'model = "gpt-6-sol"\n\n[projects."/home/ada/other"]\ntrust_level = "trusted"\n';
    fs.writeFileSync(file, before);

    expect(await seedTrust('codex', w.clone, { agentHome: w.agentHome, homedir: w.base, agentRunning: async () => false, waitMs: 1000 })).toBe('seeded');
    expect(await seedTrust('codex', w.clone, { agentHome: w.agentHome, homedir: w.base, agentRunning: async () => false, waitMs: 1000 })).toBe('seeded');
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
    expect(await seedTrust('codex', distrusted, { agentHome: w.agentHome, homedir: w.base, agentRunning: async () => false, waitMs: 1000 })).toBe('skipped');
    expect(fs.readFileSync(file)).toEqual(held);
  });

  it('gives up after waitMs while a mirror holds the agent files, saying so and leaving the file as it was', async () => {
    const w = worker();
    const file = path.join(w.agentHome, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({ projects: {} }));
    const unlock = await lockAgentFiles(w.base);
    try {
      await expect(seedTrust('claude', w.clone, { agentHome: w.agentHome, homedir: w.base, agentRunning: async () => false, waitMs: 300 }))
        .rejects.toThrow(`a copy of the agent setup held the agent files in ${w.base} for 0.3s`);
    } finally {
      unlock();
    }
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ projects: {} });
  });
});

const TRUST_DIALOG = [
  ' Accessing workspace:', '', ' /home/ada/code/app/.claude/worktrees/kanban', '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  ' project, or work from your team). If not, take a moment to review what\'s in this folder first.', '',
  ' ❯ 1. No, exit', '   2. Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel',
];
const CODEX_DIALOG = [
  '  Folder access', '  /home/ada/code/app/.claude/worktrees/kanban', '',
  '  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.', '',
  '› 1. Trust and continue', '  2. Quit', '', '  enter continue · esc quit',
];

// Claude Code 2.1.322's trust dialog as a pane showed it after a move, rows 7 to 26
const CLAUDE_2_1_322 = [
  ' Accessing workspace:', '', ' /Users/linusroxbergh/.svall-dev-fartest/home', '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  ' project, or work from your team). If not, take a moment to review what\'s in this folder first.', '',
  ' Claude Code\'ll be able to read, edit, and execute files here.', '',
  ' ⚠ This folder pre-approves 28 tool permissions in .claude/settings.json:',
  '   Bash(svall status:*), Bash(svall robot list:*), Bash(svall robot read:*), Bash(svall robot show:*), Bash(svall robot',
  ' wait:*), Bash(svall robot move:*), Bash(svall robot update:*), Bash(svall robot send:*), and 20 more',
  ' These will apply without asking. Only proceed if you trust this configuration.', '', ' Security guide', '',
  ' ❯ No, exit', '   Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel',
];

/**
 * A pane that shows `dialog` once read `after` times, coloured, and takes keys as Claude Code 2.1.322 does: an arrow by tmux's name moves
 * the pointer, an arrow pasted as bytes moves nothing, a digit moves it only where `digits`, and Enter takes the row it marks.
 */
function pane(after: number, dialog: string[], o: { answer?: string; digits?: boolean; stuck?: boolean } = {}) {
  const answer = o.answer ?? claudeAdapter.trustAnswer!;
  const first = dialog.findIndex((r) => /^\s*[❯›>]\s/.test(r));
  const choices = dialog.slice(first).map((r) => /^\s*(?:[❯›>]\s*)?(?:(\d+)\.\s+)?(.*?)\s*$/.exec(r)!).filter((m, i, all) => m[2] && all.slice(0, i).every((x) => x[2]));
  const typed: string[] = [];
  let [reads, pointer] = [0, 0];
  let chose: string | undefined;
  const rows = () => {
    if (chose !== undefined) return chose === answer ? ['╭───', '│ ✻ Welcome back', '> '] : ['$ '];
    if (reads <= after) return ['$ claude --resume x', ''];
    // coloured as tmux captures Claude Code 2.1.322: the pointer and each word of its row
    const blue = (t: string) => `\x1b[38;5;153m${t}\x1b[39m`;
    const row = (m: RegExpExecArray, i: number) => `${m[1] ? `${m[1]}. ` : ''}${m[2]}`.split(' ').map((t) => (i === pointer ? blue(t) : t)).join(' ');
    return [...dialog.slice(0, first), ...choices.map((m, i) => (i === pointer ? ` ${blue('❯')} ${row(m, i)}` : `   ${row(m, i)}`)), ...dialog.slice(first + choices.length)];
  };
  const tmux = {
    screen: async (): Promise<Screen> => { reads++; return { rows: rows(), cursor: 0, shown: true, command: 'claude' }; },
    sendBytes: async (_paneId: string, bytes: Buffer) => {
      const k = bytes.toString('latin1');
      typed.push(k);
      if (chose !== undefined || reads <= after) return;
      if (k === '\r') chose = choices[pointer][2];
      else if (o.digits && /^\d$/.test(k)) pointer = choices.findIndex((m) => m[1] === k);
    },
    sendKey: async (_paneId: string, key: 'Up' | 'Down') => {
      typed.push(key);
      if (chose === undefined && !o.stuck) pointer = Math.max(0, Math.min(choices.length - 1, pointer + (key === 'Down' ? 1 : -1)));
    },
  };
  return { tmux, typed, reads: () => reads, chose: () => chose };
}

describe('answerTrustPrompt', () => {
  it('answers Claude Code 2.1.322\'s dialog, whose rows carry no number, by stepping its pointer onto the answer and only then Enter', async () => {
    const p = pane(1, CLAUDE_2_1_322);
    expect(await answerTrustPrompt(p.tmux, '%1', claudeAdapter, { forMs: 5000 })).toBe('answered');
    expect(p.chose()).toBe('Yes, I trust this folder');
    expect(p.typed).toEqual(['Down', '\r']);
  });

  it('picks a numbered answer by its number, confirming it once the pointer is on it, and Enter alone where the pointer starts on it', async () => {
    const p = pane(2, TRUST_DIALOG, { digits: true });
    expect(await answerTrustPrompt(p.tmux, '%1', claudeAdapter, { forMs: 5000 })).toBe('answered');
    expect([p.chose(), p.typed]).toEqual(['Yes, I trust this folder', ['2', '\r']]);
    // a number the dialog does not take leaves the pointer to be stepped
    const deaf = pane(0, TRUST_DIALOG);
    expect(await answerTrustPrompt(deaf.tmux, '%1', claudeAdapter, { forMs: 5000 })).toBe('answered');
    expect([deaf.chose(), deaf.typed]).toEqual(['Yes, I trust this folder', ['2', 'Down', '\r']]);
    const codex = pane(1, CODEX_DIALOG, { answer: codexAdapter.trustAnswer });
    expect(await answerTrustPrompt(codex.tmux, '%1', codexAdapter, { forMs: 5000 })).toBe('answered');
    expect([codex.chose(), codex.typed]).toEqual(['Trust and continue', ['\r']]);
  });

  it('leaves to the person a dialog it cannot read, or whose pointer does not come onto the answer, and confirms nothing', async () => {
    const unread = pane(0, CLAUDE_2_1_322.map((r) => r.replace('Yes, I trust this folder', 'Yes, trust it')));
    expect(await answerTrustPrompt(unread.tmux, '%1', claudeAdapter, { forMs: 1500 })).toBe('unread');
    expect(unread.typed).toEqual([]);
    const stuck = pane(0, CLAUDE_2_1_322, { stuck: true });
    expect(await answerTrustPrompt(stuck.tmux, '%1', claudeAdapter, { forMs: 3000 })).toBe('unread');
    expect([stuck.chose(), stuck.typed.includes('\r')]).toEqual([undefined, false]);
  });

  it('answers nothing it never sees, nor for a CLI with no answer to give', async () => {
    const never = pane(Infinity, TRUST_DIALOG);
    expect(await answerTrustPrompt(never.tmux, '%1', claudeAdapter, { forMs: 1200 })).toBe('none');
    expect(never.typed).toEqual([]);
    expect(await answerTrustPrompt(never.tmux, '%1', opencodeAdapter, { forMs: 1200 })).toBe('none');
    expect(never.reads()).toBe(3);
  });

  it('types nothing into a conversation that only speaks of the question or its answer', async () => {
    const conversations = [
      ['› Which one did you pick at the folder prompt?', '', '• I picked "1. Trust and continue".', '', '  1. Trust and continue', '', '› '],
      ['• Codex asks "Trust this folder?" the first time; choose 1. Trust and continue there.', '', '› '],
      ['  1. Trust and continue', '  Trust this folder? was asked on the Mac', '› '],
    ];
    for (const rows of conversations) {
      const p = pane(0, rows);
      expect(await answerTrustPrompt(p.tmux, '%1', codexAdapter, { forMs: 1200 })).toBe('none');
      expect(p.typed).toEqual([]);
    }
  });
});

// a Codex robot to wake, the keys typed into its pane, and its first turn's SessionStart to report
function codexToWake() {
  const robot = { id: 'c_1', name: 'kanban', revive: { command: 'codex resume x' }, agent: { kind: 'codex', sessionId: 'x', status: 'idle', lastActivityAt: 0 } } as unknown as Robot;
  const store = { state: { robots: { c_1: robot } }, subscribe: () => () => {} };
  const heard = new Set<(robotId: string, term: 2 | undefined, sessionId: string) => void>();
  const fleet = {
    reviveRobot: async () => { robot.tmux = { windowId: '@1', paneId: '%1' }; },
    openSecond: async () => {},
    onSessionStart: (fn: (robotId: string, term: 2 | undefined, sessionId: string) => void) => { heard.add(fn); return () => { heard.delete(fn); }; },
  };
  const o = { shown: false, reads: 0 };
  const typed: string[] = [];
  const tmux = {
    screen: async () => { o.reads++; return { rows: o.shown ? CODEX_DIALOG : [], cursor: 0, shown: true, command: 'codex' }; },
    // Enter takes the choice the pointer marks, Trust and continue, and the dialog goes
    sendBytes: async (_paneId: string, bytes: Buffer) => { typed.push(bytes.toString('latin1')); if (bytes.toString() === '\r') o.shown = false; },
  };
  const j = { id: 'mv_0123456789', robotId: 'c_1' } as MoveJournal;
  const run = (trust: boolean) => wake({ store, fleet, tmux, log: silentLogger, watchMs: 5000, trust } as unknown as Parameters<typeof wake>[0], j);
  return { o, typed, heard, run, started: () => { for (const fn of heard) fn('c_1', undefined, 'x'); } };
}

// a Claude robot to wake whose pane shows `rows`, which reports its session as it starts
function claudeToWake(rows: string[]) {
  const robot = { id: 'c_1', name: 'crew', revive: { command: 'claude --resume x' }, agent: { kind: 'claude', sessionId: 'x', status: 'idle', lastActivityAt: 0 } } as unknown as Robot;
  const store = { state: { robots: { c_1: robot } }, subscribe: () => () => {} };
  const fleet = {
    reviveRobot: async () => { robot.tmux = { windowId: '@1', paneId: '%1' }; },
    openSecond: async () => {},
    onSessionStart: () => () => {},
  };
  const tmux = { screen: async () => ({ rows, cursor: 0, shown: true, command: 'claude' }), sendBytes: async () => {} };
  const j = { id: 'mv_0123456789', robotId: 'c_1' } as MoveJournal;
  return () => wake({ store, fleet, tmux, log: silentLogger, watchMs: 5000, trust: true } as unknown as Parameters<typeof wake>[0], j);
}

describe('wake', () => {
  it("waits on no question of the agent's own, as its first run asks, which a person answers in its terminal; the trust question it waits on", async () => {
    const began = Date.now();
    expect(await claudeToWake(['Claude in Chrome extension detected', '', '❯ 1. Yes, use it', '  2. No'])()).toBeUndefined();
    expect(Date.now() - began).toBeLessThan(2000);
    const trusting = claudeToWake([claudeAdapter.trustQuestion!, '', '❯ 1. Yes, proceed', '  2. No, exit']);
    const still = await Promise.race([trusting().then(() => 'ended'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 1500))]);
    expect(still).toBe('waiting');
    // a past prompt of a resumed conversation is no question
    const resumed = claudeToWake(['> 1. Fix the login bug', '', '⏺ Fixed it.']);
    expect(await Promise.race([resumed().then(() => 'ended'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 1500))])).toBe('waiting');
  });

  it('a trust question it cannot answer is said once the wake ends, however late its last read', async () => {
    const robot = { id: 'c_1', name: 'crew', revive: { command: 'claude --resume x' }, agent: { kind: 'claude', sessionId: 'x', status: 'idle', lastActivityAt: 0 } } as unknown as Robot;
    const fleet = { reviveRobot: async () => { robot.tmux = { windowId: '@1', paneId: '%1' }; }, openSecond: async () => {}, onSessionStart: () => () => {} };
    const rows = CLAUDE_2_1_322.map((r) => r.replace('Yes, I trust this folder', 'Yes, trust it'));
    const tmux = { screen: async () => { await new Promise((r) => setTimeout(r, 700)); return { rows, cursor: 0, shown: true, command: 'claude' }; }, sendBytes: async () => {}, sendKey: async () => {} };
    let asks = false;
    const j = { id: 'mv_0123456789', robotId: 'c_1' } as MoveJournal;
    const w = { store: { state: { robots: { c_1: robot } }, subscribe: () => () => {} }, fleet, tmux, log: silentLogger, watchMs: 1500, trust: true, asks: () => { asks = true; } };
    expect(await wake(w as unknown as Parameters<typeof wake>[0], j)).toBeUndefined();
    expect(asks).toBe(true);
  });

  it('counts a Codex robot up once its window opens, which reports no session until its first turn, and answers its trust question after', async () => {
    const w = codexToWake();
    const began = Date.now();
    expect(await w.run(true)).toBeUndefined();
    expect(Date.now() - began).toBeLessThan(1000);
    w.o.shown = true;
    await vi.waitFor(() => expect(w.typed).toEqual(['\r']), { timeout: 3000 });
    await vi.waitFor(() => expect(w.heard.size).toBe(0), { timeout: 3000 });
  });

  it('never looks for a trust question a seed answered, and stops looking once the robot\'s first turn reports its session', async () => {
    const seeded = codexToWake();
    seeded.o.shown = true;
    expect(await seeded.run(false)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(seeded.o.reads).toBe(0);
    expect(seeded.typed).toEqual([]);

    const turned = codexToWake();
    expect(await turned.run(true)).toBeUndefined();
    turned.started();
    await vi.waitFor(() => expect(turned.heard.size).toBe(0), { timeout: 3000 });
    turned.o.shown = true;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(turned.typed).toEqual([]);
  });
});
