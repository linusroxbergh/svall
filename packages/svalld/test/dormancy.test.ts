import { describe, expect, it } from 'vitest';
import type { Agent, Character } from '@svall/protocol';
import { drowsy, reviveCommand, runsInBackground, startFlags } from '../src/dormancy.js';

const SID = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
const HOUR = 3_600_000;
const agent = (over: Partial<Agent> = {}): Agent => ({ kind: 'claude', sessionId: SID, status: 'idle', lastActivityAt: 0, ...over });
const char = (over: Partial<Character> = {}): Character => ({
  id: 'c_a', islandId: 'i_1', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: '/repo', context: [],
  tmux: { windowId: '@1', paneId: '%1' }, shell: { lastOutputAt: 0 }, unread: false, agent: agent(), ...over,
});

describe('drowsy', () => {
  it('takes an idle or done agent once it has rested the whole limit', () => {
    expect(drowsy(char(), 12 * HOUR, 12 * HOUR)).toBe(true);
    expect(drowsy(char({ agent: agent({ status: 'done' }) }), 12 * HOUR, 12 * HOUR)).toBe(true);
    expect(drowsy(char(), 12 * HOUR - 1, 12 * HOUR)).toBe(false);
  });

  it('counts the rest from the last look the user took, if later', () => {
    expect(drowsy(char(), 12 * HOUR, 12 * HOUR, HOUR)).toBe(false);
    expect(drowsy(char(), 13 * HOUR, 12 * HOUR, HOUR)).toBe(true);
  });

  it('leaves an agent at work, waiting on the user, with news the user has not seen, or on a failed turn', () => {
    const late = 100 * HOUR;
    expect(drowsy(char({ agent: agent({ status: 'working' }) }), late, HOUR)).toBe(false);
    expect(drowsy(char({ agent: agent({ status: 'blocked' }) }), late, HOUR)).toBe(false);
    expect(drowsy(char({ agent: agent({ status: 'done', background: true }) }), late, HOUR)).toBe(false);
    expect(drowsy(char({ unread: true }), late, HOUR)).toBe(false);
    expect(drowsy(char({ agent: agent({ status: 'idle', prompt: "You've hit your limit · resets 9pm" }) }), late, HOUR)).toBe(false);
  });

  it('leaves a plain shell, a dormant character, and a session no resume could name', () => {
    const late = 100 * HOUR;
    expect(drowsy(char({ agent: undefined }), late, HOUR)).toBe(false);
    expect(drowsy(char({ tmux: undefined }), late, HOUR)).toBe(false);
    expect(drowsy(char({ agent: agent({ sessionId: 'x; rm -rf ~' }) }), late, HOUR)).toBe(false);
  });
});

describe('startFlags', () => {
  it("keeps what a claude resume does not restore, quoted, and leaves it the model and mode it had", () => {
    expect(startFlags('claude --model claude-opus-5-5[1m] --effort xhigh --dangerously-skip-permissions', 'claude'))
      .toEqual(['--effort', "'xhigh'", '--dangerously-skip-permissions']);
    expect(startFlags('claude --permission-mode=plan --agent reviewer', 'claude')).toEqual([]);
    expect(startFlags('claude --permission-mode bypassPermissions', 'claude')).toEqual(['--permission-mode', "'bypassPermissions'"]);
  });

  it('drops what described the start: a worktree to make, a session to resume, dirs and the prompt', () => {
    expect(startFlags('claude -w inbox --effort high --add-dir /x --resume 1234 -- look at --model haiku', 'claude'))
      .toEqual(['--effort', "'high'"]);
    expect(startFlags('claude -w --effort high', 'claude')).toEqual(['--effort', "'high'"]);
    expect(startFlags(`claude -r ${SID} --effort high`, 'claude')).toEqual(['--effort', "'high'"]);
    expect(startFlags('claude --continue --verbose', 'claude')).toEqual([]);
    expect(startFlags('claude', 'claude')).toEqual([]);
  });

  it('ends nothing whose launch the resume would change: a flag it does not know, or a value it cannot carry', () => {
    expect(startFlags('claude --dangerously-skip-permissions --disallowedTools Bash', 'claude')).toBeUndefined();
    expect(startFlags('claude --settings /x/deny.json', 'claude')).toBeUndefined();
    expect(startFlags("claude --effort a'b", 'claude')).toBeUndefined();
    expect(startFlags('claude --effort --dangerously-skip-permissions', 'claude')).toBeUndefined();
  });

  it('reads no flag out of a prompt, whose words ps prints unquoted', () => {
    expect(startFlags('claude fix it', 'claude')).toEqual([]);
    expect(startFlags('claude --dangerously-skip-permissions -- look at --model haiku', 'claude')).toEqual(['--dangerously-skip-permissions']);
    // past a bare word, a prompt and a value cut at its space look the same
    expect(startFlags('claude explain --dangerously-skip-permissions', 'claude')).toBeUndefined();
    expect(startFlags('claude --add-dir /My Docs --dangerously-skip-permissions', 'claude')).toBeUndefined();
    expect(startFlags('codex check git log -p output', 'codex')).toBeUndefined();
  });

  it("keeps a codex agent's model, profile, sandbox, approval, provider and hook-trust flags", () => {
    expect(startFlags('/opt/codex/codex -m gpt-5.5 -s workspace-write -a never --dangerously-bypass-approvals-and-sandbox -c x=y', 'codex'))
      .toEqual(['-m', "'gpt-5.5'", '-s', "'workspace-write'", '-a', "'never'", '--dangerously-bypass-approvals-and-sandbox']);
    expect(startFlags('codex --oss --local-provider ollama -m gpt-oss:20b --approve-for-me', 'codex'))
      .toEqual(['--oss', '--local-provider', "'ollama'", '-m', "'gpt-oss:20b'", '--approve-for-me']);
    expect(startFlags('codex -C /repo --add-dir /x --yolo --dangerously-bypass-hook-trust -m gpt-5.5', 'codex'))
      .toEqual(['--yolo', '--dangerously-bypass-hook-trust', '-m', "'gpt-5.5'"]);
  });

  it('keeps the flags of an agent already resumed, so they last through every sleep', () => {
    expect(startFlags(`codex resume -c tui.resume_cwd=session -m gpt-5.5 ${SID}`, 'codex')).toEqual(['-m', "'gpt-5.5'"]);
    expect(startFlags(`claude --effort high --resume ${SID} --add-dir /x`, 'claude')).toEqual(['--effort', "'high'"]);
    // woken with a prompt, or with the island's folders
    expect(startFlags(`codex resume -c tui.resume_cwd=session -m gpt-5.5 ${SID} -- look at --model haiku`, 'codex')).toEqual(['-m', "'gpt-5.5'"]);
    expect(startFlags(`codex resume -c tui.resume_cwd=session ${SID} --add-dir /x`, 'codex')).toEqual([]);
  });

  it('reads an agent run by node, and nothing from a process that is not the agent', () => {
    expect(startFlags('node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js --effort high', 'claude')).toEqual(['--effort', "'high'"]);
    expect(startFlags('node /Users/x/.nvm/versions/node/v24.18.0/bin/claude --effort high', 'claude')).toEqual(['--effort', "'high'"]);
    expect(startFlags('vim --model x', 'claude')).toBeUndefined();
    expect(startFlags('node /Users/x/.claude/plugins/helper/claude.js --model x', 'claude')).toBeUndefined();
    expect(startFlags('claude --model opus', 'codex')).toBeUndefined();
  });
});

describe('runsInBackground', () => {
  const proc = (pid: number, ppid: number, pgid: number) => ({ pid, ppid, pgid, args: '' });

  it('is true while a descendant runs outside the agent\'s process group, as the Bash tool starts it', () => {
    const agentTree = [proc(10, 1, 10), proc(11, 10, 10), proc(12, 11, 10)];
    expect(runsInBackground(10, agentTree)).toBe(false);
    expect(runsInBackground(10, [...agentTree, proc(20, 10, 20), proc(21, 20, 20)])).toBe(true);
    expect(runsInBackground(10, [...agentTree, proc(30, 12, 30)])).toBe(true);
    expect(runsInBackground(10, [...agentTree, proc(40, 1, 40)])).toBe(false);
  });
});

describe('reviveCommand', () => {
  it('resumes with the flags the agent was started with', () => {
    expect(reviveCommand(char(), ['--effort', "'high'"])).toBe(`claude --effort 'high' --resume ${SID}`);
    expect(reviveCommand(char({ agent: agent({ kind: 'codex' }) }), ['-m', "'gpt-5.5'"]))
      .toBe(`codex resume -c tui.resume_cwd=session -m 'gpt-5.5' ${SID}`);
    expect(reviveCommand(char())).toBe(`claude --resume ${SID}`);
  });
});
