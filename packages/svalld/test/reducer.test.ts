import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { Character } from '@svall/protocol';
import { applyHook, applyStatus, markSeen } from '../src/agent/reducer.js';
import type { HookEvent } from '../src/hooks/receiver.js';

const base = (): Character => ({
  id: 'c_a', islandId: 'i_1', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: '/r', context: [],
  shell: { lastOutputAt: 0 }, unread: false,
});
const withAgent = (status: Character['agent'] extends infer A ? (A extends { status: infer S } ? S : never) : never): Character => ({
  ...base(), agent: { kind: 'claude', sessionId: 's', transcriptPath: '/t', status, lastActivityAt: 1 },
});

describe('applyHook', () => {
  it('attaches an agent on SessionStart and ignores SessionStart without ids', () => {
    const c = applyHook(base(), { charId: 'c_a', backend: 'claude', name: 'SessionStart', sessionId: 's', transcriptPath: '/t' }, 5);
    expect(c.agent).toEqual({ kind: 'claude', sessionId: 's', transcriptPath: '/t', status: 'idle', lastActivityAt: 5 });
    expect(applyHook(base(), { charId: 'c_a', backend: 'claude', name: 'SessionStart' }, 5).agent).toBeUndefined();
  });
  it('keeps status on SessionStart for the same session (compaction)', () => {
    const c = applyHook({ ...withAgent('working'), unread: false }, { charId: 'c_a', backend: 'claude', name: 'SessionStart', sessionId: 's', transcriptPath: '/t2' }, 9);
    expect(c.agent).toMatchObject({ status: 'working', transcriptPath: '/t2', lastActivityAt: 9 });
    const fresh = applyHook(withAgent('working'), { charId: 'c_a', backend: 'claude', name: 'SessionStart', sessionId: 's2', transcriptPath: '/t' }, 9);
    expect(fresh.agent?.status).toBe('idle');
  });
  it('does not mutate its input', () => {
    const c = base();
    applyHook(c, { charId: 'c_a', backend: 'claude', name: 'SessionStart', sessionId: 's', transcriptPath: '/t' }, 5);
    expect(c.agent).toBeUndefined();
  });
  it('ignores status events for a plain shell', () => {
    expect(applyHook(base(), { charId: 'c_a', backend: 'claude', name: 'Stop' }, 5)).toEqual(base());
  });
  it('moves through working, done and unread', () => {
    const w = applyHook(withAgent('idle'), { charId: 'c_a', backend: 'claude', name: 'UserPromptSubmit' }, 7);
    expect(w.agent?.status).toBe('working');
    expect(w.agent?.lastActivityAt).toBe(7);
    const d = applyHook(w, { charId: 'c_a', backend: 'claude', name: 'Stop' }, 8);
    expect(d.agent?.status).toBe('done');
    expect(d.unread).toBe(true);
    const again = applyHook(d, { charId: 'c_a', backend: 'claude', name: 'PreToolUse' }, 9);
    expect(again.unread).toBe(false);
  });
  it('stays working when a turn ends with background agents still running', () => {
    const w = applyHook(withAgent('working'), { charId: 'c_a', backend: 'claude', name: 'Stop', backgroundTasks: 2 }, 8);
    expect(w.agent?.status).toBe('working');
    expect(w.unread).toBe(false);
  });
  it('settles once a hook lists no background agent left, as when they were killed rather than finished', () => {
    const w = applyHook(withAgent('working'), { charId: 'c_a', backend: 'claude', name: 'Stop', backgroundTasks: 1 }, 8);
    expect(w.agent).toMatchObject({ status: 'working', background: true });
    expect(applyHook(w, { charId: 'c_a', backend: 'claude', name: 'Notification', notificationType: 'idle_prompt' }, 9).agent?.background).toBe(true);
    const idle = applyHook(w, { charId: 'c_a', backend: 'claude', name: 'Notification', notificationType: 'idle_prompt', backgroundTasks: 0 }, 9);
    expect(idle.agent?.status).toBe('idle');
    expect(idle.agent?.background).toBeUndefined();
  });
  it("finishes a turn that leaves only the session's monitors running, and forgets a monitor once no Stop lists it", () => {
    const ev = (e: Partial<HookEvent>): HookEvent => ({ charId: 'c_a', backend: 'claude', name: 'Stop', ...e });
    const m = applyHook(withAgent('working'), ev({ name: 'PostToolUse', toolName: 'Monitor', monitor: 'b1' }), 7);
    expect(m.agent?.monitors).toEqual(['b1']);
    const done = applyHook(m, ev({ backgroundTasks: 1, backgroundAgents: 0, backgroundShells: ['b1'] }), 8);
    expect(done.agent).toMatchObject({ status: 'done', monitors: ['b1'] });
    expect(done.agent?.background).toBeUndefined();
    const shell = applyHook(m, ev({ backgroundTasks: 2, backgroundAgents: 0, backgroundShells: ['b1', 'b2'] }), 8);
    expect(shell.agent).toMatchObject({ status: 'working', background: true });
    expect(applyHook(shell, ev({ backgroundTasks: 0, backgroundAgents: 0, backgroundShells: [] }), 9).agent?.monitors).toBeUndefined();
  });
  it('blocks on permission prompts only', () => {
    expect(applyHook(withAgent('working'), { charId: 'c_a', backend: 'claude', name: 'Notification', notificationType: 'permission_prompt' }, 1).agent?.status).toBe('blocked');
    expect(applyHook(withAgent('working'), { charId: 'c_a', backend: 'claude', name: 'Notification', notificationType: 'worker_permission_prompt' }, 1).agent?.status).toBe('blocked');
    expect(applyHook(withAgent('working'), { charId: 'c_a', backend: 'claude', name: 'Notification', notificationType: 'elicitation_dialog' }, 1).agent?.status).toBe('blocked');
    expect(applyHook(withAgent('working'), { charId: 'c_a', backend: 'claude', name: 'Notification', notificationType: 'elicitation_url_dialog' }, 1).agent?.status).toBe('blocked');
    expect(applyHook(withAgent('working'), { charId: 'c_a', backend: 'claude', name: 'Notification', notificationType: 'auth_success' }, 1).agent?.status).toBe('working');
  });
  it('is working again once the tool asked about has run, as when a choice is picked, whether it succeeded or not', () => {
    const asked = applyHook(withAgent('working'), { charId: 'c_a', backend: 'claude', name: 'Notification', notificationType: 'permission_prompt', message: 'Claude needs your permission to use AskUserQuestion' }, 1);
    for (const name of ['PostToolUse', 'PostToolUseFailure'] as const) {
      const ran = applyHook(asked, { charId: 'c_a', backend: 'claude', name }, 2);
      expect(ran.agent).toMatchObject({ status: 'working' });
      expect(ran.agent?.promptId).toBeUndefined();
    }
  });
  it('stays blocked while another tool of the batch finishes, before or after the question shows, until the one asked about runs', () => {
    const ev = (name: HookEvent['name'], o: Partial<HookEvent> = {}): HookEvent => ({ charId: 'c_a', backend: 'claude', name, ...o });
    let c = applyHook(withAgent('working'), ev('PermissionRequest', { toolName: 'AskUserQuestion' }), 1);
    c = applyHook(c, ev('PostToolUse', { toolName: 'WebFetch' }), 2);
    c = applyHook(c, ev('Notification', { notificationType: 'permission_prompt' }), 3);
    expect(applyHook(c, ev('PostToolUse', { toolName: 'Agent' }), 4).agent?.status).toBe('blocked');
    expect(applyHook(c, ev('PostToolUseFailure', { toolName: 'Bash' }), 4).agent?.status).toBe('blocked');
    const answered = applyHook(c, ev('PostToolUse', { toolName: 'AskUserQuestion' }), 4);
    expect(answered.agent?.status).toBe('working');
    // the next question is asked afresh, so an old one's tool no longer holds it
    const next = applyHook(applyHook(answered, ev('Notification', { notificationType: 'permission_prompt' }), 5), ev('PostToolUse', { toolName: 'Agent' }), 6);
    expect(next.agent?.status).toBe('working');
  });
  it('gives each blocking question an id of its own, and drops it once the agent moves on', () => {
    const ask = (c: Character) => applyHook(c, { charId: 'c_a', backend: 'claude', name: 'Notification', notificationType: 'permission_prompt' }, 1);
    const one = ask(withAgent('working'));
    const two = ask(one);
    expect(one.agent?.promptId).toEqual(expect.any(String));
    expect(two.agent?.promptId).toEqual(expect.any(String));
    expect(two.agent?.promptId).not.toBe(one.agent?.promptId);
    expect(applyHook(two, { charId: 'c_a', backend: 'claude', name: 'PreToolUse' }, 2).agent?.promptId).toBeUndefined();
  });
  it('is done, saying why, when an API error ends the turn', () => {
    const d = applyHook(withAgent('working'), { charId: 'c_a', backend: 'claude', name: 'StopFailure', message: "You've hit your limit" }, 8);
    expect(d.agent).toMatchObject({ status: 'done', prompt: "You've hit your limit" });
    expect(d.unread).toBe(true);
    expect(applyHook(d, { charId: 'c_a', backend: 'claude', name: 'UserPromptSubmit' }, 9).agent?.prompt).toBeUndefined();
  });
  it('goes idle when Claude Code says it sits at its prompt, as after an Esc, but keeps a done unseen', () => {
    const idle = (c: Character) => applyHook(c, { charId: 'c_a', backend: 'claude', name: 'Notification', notificationType: 'idle_prompt' }, 1).agent?.status;
    expect(idle(withAgent('working'))).toBe('idle');
    expect(idle(withAgent('blocked'))).toBe('idle');
    expect(idle(withAgent('done'))).toBe('done');
    // the turn ended with background agents out; Claude Code's notice does not count them
    const waiting = applyHook(withAgent('working'), { charId: 'c_a', backend: 'claude', name: 'Stop', backgroundTasks: 1 }, 2);
    expect(idle(waiting)).toBe('working');
    // a question put while they run and dismissed in the terminal is gone, and the work goes on
    const asked = applyHook(waiting, { charId: 'c_a', backend: 'claude', name: 'Notification', notificationType: 'worker_permission_prompt', message: 'may I' }, 3);
    const dismissed = applyHook(asked, { charId: 'c_a', backend: 'claude', name: 'Notification', notificationType: 'idle_prompt' }, 4);
    expect(dismissed.agent).toMatchObject({ status: 'working', background: true });
    expect(dismissed.agent?.prompt).toBeUndefined();
    expect(dismissed.agent?.promptId).toBeUndefined();
    const reported = applyHook(waiting, { charId: 'c_a', backend: 'claude', name: 'UserPromptSubmit' }, 3);
    expect(idle(reported)).toBe('idle');
  });
  it('follows the transcript when the session moves it (entering a worktree)', () => {
    const moved = applyHook(withAgent('working'), { charId: 'c_a', backend: 'claude', name: 'PreToolUse', sessionId: 's', transcriptPath: '/wt/t' }, 2);
    expect(moved.agent?.transcriptPath).toBe('/wt/t');
    const other = applyHook(withAgent('working'), { charId: 'c_a', backend: 'claude', name: 'PreToolUse', sessionId: 's2', transcriptPath: '/x' }, 2);
    expect(other.agent?.transcriptPath).toBe('/t');
  });
  it('records the prompt a UserPromptSubmit hook carries, newest only', () => {
    const one = applyHook(withAgent('idle'), { charId: 'c_a', backend: 'claude', name: 'UserPromptSubmit', prompt: { id: 'p1', text: 'hoist' } }, 7);
    expect(one.agent?.lastPrompt).toEqual({ id: 'p1', text: 'hoist', at: 7 });
    const two = applyHook(one, { charId: 'c_a', backend: 'claude', name: 'UserPromptSubmit', sessionId: 's', prompt: { id: 'p2', text: 'furl' } }, 8);
    expect(two.agent?.lastPrompt).toEqual({ id: 'p2', text: 'furl', at: 8 });
    expect(applyHook(two, { charId: 'c_a', backend: 'claude', name: 'Stop' }, 9).agent?.lastPrompt).toEqual({ id: 'p2', text: 'furl', at: 8 });
  });
  it('ignores a prompt submitted in another session (a nested claude under the same character)', () => {
    const c = applyHook(withAgent('idle'), { charId: 'c_a', backend: 'claude', name: 'UserPromptSubmit', sessionId: 's2', prompt: { id: 'p1', text: 'hoist' } }, 7);
    expect(c.agent?.lastPrompt).toBeUndefined();
  });
  it('detaches on SessionEnd', () => {
    expect(applyHook(withAgent('idle'), { charId: 'c_a', backend: 'claude', name: 'SessionEnd' }, 1).agent).toBeUndefined();
  });
  it('carries the prompt a blocking notification brought, and drops it once the agent moves on', () => {
    const b = applyHook(withAgent('working'), { charId: 'c_a', backend: 'claude', name: 'Notification', notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, 3);
    expect(b.agent).toMatchObject({ status: 'blocked', prompt: 'Claude needs your permission to use Bash' });
    expect(applyHook(b, { charId: 'c_a', backend: 'claude', name: 'PreToolUse' }, 4).agent?.prompt).toBeUndefined();
    expect(applyHook(b, { charId: 'c_a', backend: 'claude', name: 'Stop' }, 4).agent?.prompt).toBeUndefined();
    const silent = applyHook(withAgent('working'), { charId: 'c_a', backend: 'claude', name: 'Notification', notificationType: 'permission_prompt' }, 3);
    expect(silent.agent?.status).toBe('blocked');
    expect(silent.agent?.prompt).toBeUndefined();
  });
});

describe("applyHook for a Claude subagent's question", () => {
  const ev = (o: Partial<HookEvent>): HookEvent => ({ charId: 'c_a', backend: 'claude', name: 'PreToolUse', ...o });
  const notify = ev({ name: 'Notification', notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  // the turn ended with a background subagent out, and that subagent then asked
  const asked = (by = 'a1', from = applyHook(withAgent('working'), ev({ name: 'Stop', backgroundTasks: 1, backgroundAgents: 1 }), 1)) =>
    applyHook(applyHook(from, ev({ name: 'PermissionRequest', agentId: by }), 2), notify, 3);

  it('waits on the notification before blocking, and leaves the status alone otherwise', () => {
    const requested = applyHook(withAgent('done'), ev({ name: 'PermissionRequest', agentId: 'a1' }), 2);
    expect(requested.agent?.status).toBe('done');
    expect(applyHook(withAgent('done'), ev({ agentId: 'a1' }), 2).agent?.status).toBe('done');
    expect(asked().agent).toMatchObject({ status: 'blocked', promptId: expect.any(String), background: true });
  });
  it('stays blocked through the main thread until the subagent that asked moves on', () => {
    let c = asked();
    c = applyHook(c, ev({ name: 'UserPromptSubmit' }), 4);
    c = applyHook(c, ev({}), 5);
    c = applyHook(c, ev({ name: 'Stop', backgroundTasks: 1, backgroundAgents: 1 }), 6);
    expect(c.agent).toMatchObject({ status: 'blocked', background: true });
    expect(c.unread).toBe(false);
    const moved = applyHook(c, ev({ agentId: 'a1' }), 7);
    expect(moved.agent).toMatchObject({ status: 'working', background: true });
    expect(moved.agent?.promptId).toBeUndefined();
    expect(moved.agent?.asking).toBeUndefined();
  });
  it('keeps a question the main thread passed before the notification came', () => {
    const requested = applyHook(applyHook(withAgent('working'), ev({ name: 'Stop', backgroundTasks: 1, backgroundAgents: 1 }), 1), ev({ name: 'PermissionRequest', agentId: 'a1' }), 2);
    const blocked = applyHook(applyHook(requested, ev({ name: 'UserPromptSubmit' }), 3), notify, 4);
    expect(applyHook(blocked, ev({}), 5).agent?.status).toBe('blocked');
    expect(applyHook(blocked, ev({ agentId: 'a1' }), 5).agent?.status).toBe('working');
  });
  it('leaves the character as it was on a subagent event that changes no question', () => {
    const c = withAgent('working');
    expect(applyHook(c, ev({ agentId: 'a1' }), 9)).toBe(c);
    expect(applyHook(c, ev({ name: 'SubagentStop', agentId: 'a1' }), 9)).toBe(c);
  });
  it('drops a question whose subagent is gone when the turn ends with only a shell left', () => {
    const stopped = applyHook(asked(), ev({ name: 'Stop', backgroundTasks: 1, backgroundAgents: 0 }), 4);
    expect(stopped.agent?.asking).toBeUndefined();
    expect(stopped.agent).toMatchObject({ status: 'working', background: true });
  });
  it("is not cleared by another subagent's tool call", () => {
    expect(applyHook(asked(), ev({ agentId: 'a2' }), 4).agent?.status).toBe('blocked');
  });
  it('stays blocked while a second subagent still asks', () => {
    const both = asked('a2', asked('a1'));
    const one = applyHook(both, ev({ agentId: 'a1' }), 4);
    expect(one.agent?.status).toBe('blocked');
    expect(applyHook(one, ev({ name: 'SubagentStop', agentId: 'a2' }), 5).agent?.status).toBe('working');
  });
  it('clears once the subagent that asked stops, as after a denial', () => {
    expect(applyHook(asked(), ev({ name: 'SubagentStop', agentId: 'a1' }), 4).agent).toMatchObject({ status: 'working', background: true });
  });
  it('clears every open question on a prompt the user typed', () => {
    const typed = applyHook(asked(), ev({ name: 'UserPromptSubmit', prompt: { id: 'p1', text: 'go on' } }), 4);
    expect(typed.agent?.status).toBe('working');
    expect(typed.agent?.asking).toBeUndefined();
  });
  it('forgets the questions once a turn ends with no subagent left running', () => {
    const c = applyHook(asked(), ev({ name: 'Stop' }), 4);
    expect(c.agent?.status).toBe('done');
    expect(c.agent?.asking).toBeUndefined();
  });
  it('leaves a question the main thread asked to the main thread', () => {
    const c = applyHook(applyHook(withAgent('working'), ev({ name: 'PermissionRequest' }), 1), notify, 2);
    expect(c.agent?.asking).toBeUndefined();
    expect(applyHook(c, ev({ agentId: 'a1' }), 3).agent?.status).toBe('blocked');
    expect(applyHook(c, ev({ name: 'SubagentStop', agentId: 'a1' }), 3).agent?.status).toBe('blocked');
    expect(applyHook(c, ev({}), 3).agent?.status).toBe('working');
  });
});

describe('applyHook for codex', () => {
  const ev = (o: Partial<HookEvent>): HookEvent => ({ charId: 'c_a', backend: 'codex', name: 'Stop', sessionId: 's1', ...o });
  const started = () => applyHook(base(), ev({ name: 'SessionStart' }), 100);

  it('starts a codex agent before its rollout has a path, with the model the hook names', () => {
    const c = applyHook(base(), ev({ name: 'SessionStart', model: 'gpt-5.1-codex-max' }), 100);
    expect(c.agent).toEqual({ kind: 'codex', sessionId: 's1', status: 'idle', lastActivityAt: 100, model: 'gpt-5.1-codex-max' });
  });
  it('takes the transcript path from a later event of the same session only', () => {
    expect(applyHook(started(), ev({ name: 'PreToolUse', transcriptPath: '/r.jsonl' }), 200).agent?.transcriptPath).toBe('/r.jsonl');
    expect(applyHook(started(), ev({ name: 'PreToolUse', sessionId: 's9', transcriptPath: '/x.jsonl' }), 200).agent?.transcriptPath).toBeUndefined();
  });
  it('blocks on a permission request, clears on the next tool call, and is done only at the stop', () => {
    const blocked = applyHook(started(), ev({ name: 'PermissionRequest', message: 'remove the build folder' }), 200);
    expect(blocked.agent).toMatchObject({ status: 'blocked', prompt: 'remove the build folder' });
    const working = applyHook(blocked, ev({ name: 'PreToolUse' }), 300);
    expect(working.agent?.status).toBe('working');
    expect(working.agent?.prompt).toBeUndefined();
    expect(working.unread).toBe(false);
    const done = applyHook(working, ev({ name: 'Stop' }), 400);
    expect(done.agent?.status).toBe('done');
    expect(done.unread).toBe(true);
  });
  it('is idle once an Esc ends the turn', () => {
    const blocked = applyHook(started(), ev({ name: 'PermissionRequest', message: 'remove the build folder' }), 200);
    const c = applyHook(blocked, ev({ name: 'Interrupt' }), 300);
    expect(c.agent).toMatchObject({ status: 'idle' });
    expect(c.agent?.prompt).toBeUndefined();
    expect(c.agent?.promptId).toBeUndefined();
  });
  it('is working again once the approved tool has run', () => {
    const blocked = applyHook(started(), ev({ name: 'PermissionRequest', message: 'remove the build folder' }), 200);
    const ran = applyHook(blocked, ev({ name: 'PostToolUse' }), 300);
    expect(ran.agent?.status).toBe('working');
    expect(ran.agent?.prompt).toBeUndefined();
  });
  it('ignores a session end from a session it has moved on from', () => {
    const c = applyHook(started(), ev({ name: 'SessionEnd', sessionId: 's0' }), 200);
    expect(c.agent?.sessionId).toBe('s1');
    expect(applyHook(started(), ev({ name: 'SessionEnd' }), 200).agent).toBeUndefined();
  });
});

describe('applyHook for opencode', () => {
  const ev = (o: Partial<HookEvent>): HookEvent => ({ charId: 'c_a', backend: 'opencode', name: 'Stop', sessionId: 's', ...o });
  const at = (status: Parameters<typeof withAgent>[0]) => ({ ...withAgent(status), agent: { ...withAgent(status).agent!, kind: 'opencode' as const } });

  it('blocks on a permission ask at once, with what it asked', () => {
    const c = applyHook(at('working'), ev({ name: 'PermissionRequest', message: 'rm -rf build' }), 5);
    expect(c.agent).toMatchObject({ status: 'blocked', prompt: 'rm -rf build' });
  });
  it('works again once the question is answered, and rests after an Esc', () => {
    const asked = applyHook(at('working'), ev({ name: 'PermissionRequest' }), 5);
    expect(applyHook(asked, ev({ name: 'PreToolUse' }), 6).agent?.status).toBe('working');
    expect(applyHook(at('working'), ev({ name: 'Interrupt' }), 6).agent?.status).toBe('idle');
  });
});

// a `claude -p` or `codex exec` run from inside a character inherits SVALL_CHAR_ID, so its hooks reach the same slot
describe('applyHook with a nested session', () => {
  const S1 = '11111111-1111-4111-8111-111111111111';
  const S2 = '22222222-2222-4222-8222-222222222222';
  const ev = (name: HookEvent['name'], sessionId: string, o: Partial<HookEvent> = {}): HookEvent => ({ charId: 'c_a', backend: 'claude', name, sessionId, ...o });
  const run = (steps: HookEvent[], alive: number[] = [100, 200]) =>
    steps.reduce((c, e) => applyHook(c, e, 1, (pid) => alive.includes(pid)), base());
  const outer = [ev('SessionStart', S1, { pid: 100 }), ev('UserPromptSubmit', S1, { pid: 100 }), ev('PreToolUse', S1, { pid: 100 })];

  it('keeps the agent a nested run started, ended and stopped under', () => {
    const c = run([...outer, ev('SessionStart', S2, { pid: 200 }), ev('UserPromptSubmit', S2, { pid: 200 }), ev('Stop', S2, { pid: 200 }), ev('SessionEnd', S2, { pid: 200 })]);
    expect(c.agent).toMatchObject({ sessionId: S1, status: 'working', pid: 100 });
    expect(c.unread).toBe(false);
  });
  it('keeps it through a nested codex exec too', () => {
    const codex = (name: HookEvent['name']) => ev(name, S2, { backend: 'codex', pid: 200 });
    const c = run([...outer, codex('SessionStart'), codex('PermissionRequest'), codex('Stop'), codex('SessionEnd')]);
    expect(c.agent).toMatchObject({ kind: 'claude', sessionId: S1, status: 'working' });
  });
  it('takes a new session from the process that holds the slot: clear, resume, compact', () => {
    const c = run([...outer, ev('SessionStart', S2, { pid: 100 }), ev('SessionEnd', S1, { pid: 100 }), ev('UserPromptSubmit', S2, { pid: 100 })]);
    expect(c.agent).toMatchObject({ sessionId: S2, status: 'working', pid: 100 });
  });
  it('takes a new session once the process that held the slot is gone', () => {
    const c = run([...outer, ev('SessionStart', S2, { pid: 200 })], [200]);
    expect(c.agent).toMatchObject({ sessionId: S2, status: 'idle', pid: 200 });
  });
  // a revive resumes the session on record in a new window, and the old pid may be some other process's by then
  it('binds the session on record to the process that resumes it', () => {
    const c = run([...outer, ev('SessionStart', S1, { pid: 200 }), ev('SessionStart', S2, { pid: 300 })], [100, 200, 300]);
    expect(c.agent).toMatchObject({ sessionId: S1, pid: 200 });
  });
  it('lets a start that names no process, or a slot bound to none, take the slot', () => {
    expect(run([...outer, ev('SessionStart', S2)]).agent?.sessionId).toBe(S2);
    expect(run([ev('SessionStart', S1), ev('SessionStart', S2, { pid: 200 })]).agent).toMatchObject({ sessionId: S2, pid: 200 });
  });
  it('binds a session on record to the process its own events name', () => {
    const c = run([ev('SessionStart', S1), ev('PreToolUse', S1, { pid: 100 }), ev('SessionStart', S2, { pid: 200 })]);
    expect(c.agent).toMatchObject({ sessionId: S1, pid: 100 });
  });
  // a /clear while the daemon was down: the start of the new session never came
  it('follows the process holding the slot into another session from its prompt there, and not from a late event of the one it left', () => {
    const c = run([...outer, ev('Stop', S2, { pid: 100 }), ev('UserPromptSubmit', S2, { pid: 100, prompt: { id: 'p2', text: 'go' } }), ev('Stop', S1, { pid: 100 })]);
    expect(c.agent).toEqual({ kind: 'claude', sessionId: S2, pid: 100, status: 'working', lastActivityAt: 1, lastPrompt: { id: 'p2', text: 'go', at: 1 } });
  });
  // a pid reused, a suspended agent with a new one started in its pane: the holder a start was turned away for dies later
  it('takes up a session it turned away once the process that held the slot is gone', () => {
    let alive = [100, 200];
    let c = base();
    const step = (e: HookEvent) => { c = applyHook(c, e, 1, (pid) => alive.includes(pid)); };
    [...outer, ev('SessionStart', S2, { pid: 200 }), ev('UserPromptSubmit', S2, { pid: 200 })].forEach(step);
    expect(c.agent?.sessionId).toBe(S1);
    alive = [200];
    step(ev('Stop', S2));
    expect(c.agent?.sessionId).toBe(S1);
    step(ev('UserPromptSubmit', S2, { pid: 200, transcriptPath: '/s2.jsonl', prompt: { id: 'p2', text: 'go' } }));
    expect(c.agent).toEqual({ kind: 'claude', sessionId: S2, pid: 200, status: 'working', lastActivityAt: 1, transcriptPath: '/s2.jsonl', lastPrompt: { id: 'p2', text: 'go', at: 1 } });
    // the process that took it holds it now
    step(ev('Stop', S1, { pid: 100 }));
    expect(c.agent).toMatchObject({ sessionId: S2, status: 'working' });
  });
  it('ignores the status events of a session the slot is not on', () => {
    const blocked = ev('Notification', S2, { notificationType: 'permission_prompt', message: 'may I' });
    for (const e of [ev('Stop', S2), blocked, ev('UserPromptSubmit', S2), ev('PermissionRequest', S2, { backend: 'codex' })]) {
      expect(applyHook({ ...withAgent('idle'), agent: { ...withAgent('idle').agent!, sessionId: S1 } }, e, 5).agent).toMatchObject({ sessionId: S1, status: 'idle', lastActivityAt: 1 });
    }
  });
});

describe('applyHook with no agent on record', () => {
  const S1 = '11111111-1111-4111-8111-111111111111';
  // a window the fleet took back without its SessionStart
  it('takes the agent from the next prompt submitted there', () => {
    const c = applyHook(base(), { charId: 'c_a', backend: 'codex', name: 'UserPromptSubmit', sessionId: S1, pid: 100, transcriptPath: '/r.jsonl', prompt: { id: 't1', text: 'go' } }, 7);
    expect(c.agent).toEqual({ kind: 'codex', sessionId: S1, pid: 100, status: 'working', lastActivityAt: 7, transcriptPath: '/r.jsonl', lastPrompt: { id: 't1', text: 'go', at: 7 } });
  });
  it('takes it from nothing else, nor from a prompt without a session id to resume by', () => {
    expect(applyHook(base(), { charId: 'c_a', backend: 'claude', name: 'Stop', sessionId: S1, pid: 100 }, 7).agent).toBeUndefined();
    expect(applyHook(base(), { charId: 'c_a', backend: 'claude', name: 'UserPromptSubmit', pid: 100 }, 7).agent).toBeUndefined();
  });
});

describe('the process holding a slot', () => {
  const S1 = '11111111-1111-4111-8111-111111111111';
  const S2 = '22222222-2222-4222-8222-222222222222';
  const start = (sessionId: string, pid: number): HookEvent => ({ charId: 'c_a', backend: 'claude', name: 'SessionStart', sessionId, pid });
  it('counts as running while it is, whoever it belongs to, and as gone once it has exited', () => {
    // pid 1 is launchd, which this user may not signal
    expect(applyHook(applyHook(base(), start(S1, 1), 1), start(S2, 200), 2).agent?.sessionId).toBe(S1);
    const exited = spawnSync('true').pid;
    expect(applyHook(applyHook(base(), start(S1, exited), 1), start(S2, 200), 2).agent?.sessionId).toBe(S2);
  });
});

describe('applyStatus', () => {
  it('reads the context of the session on record, and not of one the character has left', () => {
    expect(applyStatus(withAgent('idle'), { charId: 'c_a', sessionId: 's', contextPct: 40 }).agent?.contextPct).toBe(40);
    expect(applyStatus(withAgent('idle'), { charId: 'c_a', sessionId: 's2', contextPct: 40 }).agent?.contextPct).toBeUndefined();
  });
});

describe('markSeen', () => {
  it('turns done into idle and clears unread', () => {
    const c = markSeen({ ...withAgent('done'), unread: true });
    expect(c.agent?.status).toBe('idle');
    expect(c.unread).toBe(false);
  });
  it('leaves working alone', () => {
    expect(markSeen(withAgent('working')).agent?.status).toBe('working');
  });
});

describe('a second terminal', () => {
  it('runs the same reducer on its own record', () => {
    const second = { tmux: { windowId: '@2', paneId: '%2' }, unread: false };
    const started = applyHook(second, { charId: 'c_a', backend: 'claude', term: 2, name: 'SessionStart', sessionId: 's2', transcriptPath: '/t2' }, 5);
    expect(started).toEqual({ ...second, agent: { kind: 'claude', sessionId: 's2', transcriptPath: '/t2', status: 'idle', lastActivityAt: 5 } });
    const done = applyHook(started, { charId: 'c_a', backend: 'claude', term: 2, name: 'Stop' }, 6);
    expect(done).toMatchObject({ unread: true, agent: { status: 'done' } });
    expect(markSeen(done)).toMatchObject({ unread: false, agent: { status: 'idle' } });
  });
});
