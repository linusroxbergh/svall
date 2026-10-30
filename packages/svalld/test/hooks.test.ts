import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hookCommand, mergeStatusLine, statusWrapper } from '../src/agent-hooks.js';
import { codexHookCommand } from '../src/codex/install.js';
import { normalizeHook, normalizeStatus, startHookReceiver, type SocketEvent } from '../src/hooks/receiver.js';
import { silentLogger } from '../src/log.js';
import { hookHelperSources } from '../src/runtime.js';
import { cleanHomes, makeHome, waitFor } from './helpers.js';

const SID = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
const hooks = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(hooks, '../hooks/agent-hook.mjs');
const statusScript = path.resolve(hooks, '../hooks/claude-status.mjs');

afterEach(cleanHomes);

describe('normalizeHook', () => {
  it("maps OpenCode's events, its ses_ ids and its log", () => {
    const OSID = 'ses_0f3a5b7c9d1eAbCdEfGhIjKlMn';
    const oc = (hook: Record<string, unknown>) => normalizeHook({ robotId: 'c_1', backend: 'opencode', pid: 42, hook: { session_id: OSID, ...hook } });
    expect(oc({ hook_event_name: 'SessionStart', transcript_path: '/h/transcripts/opencode/x.jsonl', cwd: '/r' }))
      .toEqual({ robotId: 'c_1', backend: 'opencode', name: 'SessionStart', sessionId: OSID, transcriptPath: '/h/transcripts/opencode/x.jsonl', cwd: '/r', pid: 42 });
    expect(oc({ hook_event_name: 'UserPromptSubmit', prompt: 'go', prompt_id: 'msg_1' })?.prompt).toEqual({ id: 'msg_1', text: 'go' });
    expect(oc({ hook_event_name: 'StopFailure', message: 'rate limited' })).toMatchObject({ name: 'StopFailure', message: 'rate limited' });
    expect(oc({ hook_event_name: 'Notification' })).toBeUndefined();
    expect(oc({ hook_event_name: 'SubagentStart', agent_id: 'ses_0f3a5b7c9d1fAbCdEfGhIjKlMn' })).toMatchObject({ name: 'SubagentStart', agentId: 'ses_0f3a5b7c9d1fAbCdEfGhIjKlMn' });
    expect(oc({ hook_event_name: 'SubagentStop', agent_id: 'ses_0f3a5b7c9d1fAbCdEfGhIjKlMn' })).toMatchObject({ name: 'SubagentStop', agentId: 'ses_0f3a5b7c9d1fAbCdEfGhIjKlMn' });
    // a subagent's question and its answer, and nothing else of it
    expect(oc({ hook_event_name: 'PermissionRequest', agent_id: 'ses_0f3a5b7c9d1fAbCdEfGhIjKlMn' })).toMatchObject({ name: 'PermissionRequest', agentId: 'ses_0f3a5b7c9d1fAbCdEfGhIjKlMn' });
    expect(oc({ hook_event_name: 'PreToolUse', agent_id: 'ses_0f3a5b7c9d1fAbCdEfGhIjKlMn' })).toMatchObject({ name: 'PreToolUse', agentId: 'ses_0f3a5b7c9d1fAbCdEfGhIjKlMn' });
    expect(oc({ hook_event_name: 'PostToolUse', agent_id: 'ses_0f3a5b7c9d1fAbCdEfGhIjKlMn' })).toBeUndefined();
  });

  it('reads the charId an OpenCode plugin loaded by an older svalld sends as the robot id', () => {
    expect(normalizeHook({ charId: 'c_1', backend: 'opencode', hook: { hook_event_name: 'SessionStart', session_id: 'ses_0f3a5b7c9d1eAbCdEfGhIjKlMn' } })?.robotId).toBe('c_1');
    expect(normalizeStatus({ charId: 'c_1', status: { contextPct: 5 } })?.robotId).toBe('c_1');
  });
  it('maps SessionStart with ids', () => {
    expect(normalizeHook({ robotId: 'c_1', hook: { hook_event_name: 'SessionStart', session_id: SID, transcript_path: '/t.jsonl' } }))
      .toEqual({ robotId: 'c_1', backend: 'claude', name: 'SessionStart', sessionId: SID, transcriptPath: '/t.jsonl' });
  });
  it('keeps the backend the hook script reported, and its model', () => {
    const e = normalizeHook({ robotId: 'c_1', backend: 'codex', hook: { hook_event_name: 'SessionStart', session_id: SID, model: 'gpt-5.1-codex-max' } });
    expect(e).toMatchObject({ backend: 'codex', model: 'gpt-5.1-codex-max' });
  });
  it('takes a script that names no backend for Claude Code, and refuses a backend it does not know', () => {
    expect(normalizeHook({ robotId: 'c_1', hook: { hook_event_name: 'Stop' } })?.backend).toBe('claude');
    expect(normalizeHook({ robotId: 'c_1', backend: 'cursor', hook: { hook_event_name: 'Stop' } })).toBeUndefined();
  });
  it('pairs a codex prompt by the turn it opened', () => {
    const e = normalizeHook({ robotId: 'c_1', backend: 'codex', hook: { hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 't1' } });
    expect(e?.prompt).toEqual({ id: 't1', text: 'go' });
  });
  it('lets a codex subagent work, ask for permission, start and stop, named by the subagent, and nothing else of a subagent', () => {
    const codex = (hook: Record<string, unknown>) => normalizeHook({ robotId: 'c_1', backend: 'codex', hook: { session_id: SID, agent_id: 'a1', ...hook } });
    expect(codex({ hook_event_name: 'PermissionRequest', message: 'remove the build folder', tool_name: 'Bash' }))
      .toMatchObject({ name: 'PermissionRequest', agentId: 'a1', message: 'remove the build folder', toolName: 'Bash' });
    expect(codex({ hook_event_name: 'PreToolUse' })).toMatchObject({ name: 'PreToolUse', agentId: 'a1' });
    expect(codex({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })).toMatchObject({ name: 'PostToolUse', agentId: 'a1', toolName: 'Bash' });
    expect(codex({ hook_event_name: 'PreToolUse', agent_id: 'a 1' })).toBeUndefined();
    expect(codex({ hook_event_name: 'SubagentStart' })).toMatchObject({ name: 'SubagentStart', agentId: 'a1', sessionId: SID });
    expect(codex({ hook_event_name: 'SubagentStop' })).toMatchObject({ name: 'SubagentStop', agentId: 'a1' });
    expect(codex({ hook_event_name: 'UserPromptSubmit', prompt: 'p', turn_id: 't' })).toBeUndefined();
  });
  it("leaves a subagent's own transcript out, which codex names on its events", () => {
    const hook = (h: Record<string, unknown>) => normalizeHook({ robotId: 'c_1', backend: 'codex', hook: { session_id: SID, transcript_path: '/sub.jsonl', ...h } });
    expect(hook({ hook_event_name: 'PreToolUse', agent_id: 'a1' })?.transcriptPath).toBeUndefined();
    expect(hook({ hook_event_name: 'SubagentStart', agent_id: 'a1' })?.transcriptPath).toBeUndefined();
    expect(hook({ hook_event_name: 'PreToolUse' })?.transcriptPath).toBe('/sub.jsonl');
  });
  it("keeps a claude subagent's tool calls, questions and stop, named by the subagent, and nothing else of it", () => {
    const sub = (hook: Record<string, unknown>) => normalizeHook({ robotId: 'c_1', hook: { session_id: SID, agent_id: 'a95af83797c89a762', ...hook } });
    expect(sub({ hook_event_name: 'PreToolUse' })).toMatchObject({ name: 'PreToolUse', agentId: 'a95af83797c89a762' });
    expect(sub({ hook_event_name: 'PermissionRequest' })).toMatchObject({ name: 'PermissionRequest', agentId: 'a95af83797c89a762' });
    expect(sub({ hook_event_name: 'SubagentStart' })).toMatchObject({ name: 'SubagentStart', agentId: 'a95af83797c89a762' });
    expect(sub({ hook_event_name: 'SubagentStop' })).toMatchObject({ name: 'SubagentStop', agentId: 'a95af83797c89a762' });
    expect(sub({ hook_event_name: 'Stop' })).toBeUndefined();
    expect(sub({ hook_event_name: 'StopFailure' })).toBeUndefined();
    expect(sub({ hook_event_name: 'PostToolUse' })).toBeUndefined();
    expect(sub({ hook_event_name: 'UserPromptSubmit', prompt: 'p', prompt_id: 'p1' })).toBeUndefined();
    expect(sub({ hook_event_name: 'PreToolUse', agent_id: 'x'.repeat(300) })).toBeUndefined();
  });
  it('names no subagent on a main-thread event', () => {
    expect(normalizeHook({ robotId: 'c_1', hook: { hook_event_name: 'PermissionRequest' } })?.agentId).toBeUndefined();
    expect(normalizeHook({ robotId: 'c_1', backend: 'codex', hook: { hook_event_name: 'PreToolUse' } })?.agentId).toBeUndefined();
  });
  it('knows no event a backend does not send', () => {
    expect(normalizeHook({ robotId: 'c_1', backend: 'codex', hook: { hook_event_name: 'Notification' } })).toBeUndefined();
    expect(normalizeHook({ robotId: 'c_1', backend: 'codex', hook: { hook_event_name: 'PostToolUseFailure' } })).toBeUndefined();
    expect(normalizeHook({ robotId: 'c_1', hook: { hook_event_name: 'PostToolUse', tool_name: 'Bash' } })).toMatchObject({ name: 'PostToolUse', toolName: 'Bash' });
    expect(normalizeHook({ robotId: 'c_1', hook: { hook_event_name: 'PostToolUseFailure' } })?.name).toBe('PostToolUseFailure');
    expect(normalizeHook({ robotId: 'c_1', hook: { hook_event_name: 'Interrupt' } })).toBeUndefined();
    expect(normalizeHook({ robotId: 'c_1', backend: 'codex', hook: { hook_event_name: 'StopFailure' } })).toBeUndefined();
    expect(normalizeHook({ robotId: 'c_1', hook: { hook_event_name: 'StopFailure', message: 'x' } })).toMatchObject({ name: 'StopFailure', message: 'x' });
    expect(normalizeHook({ robotId: 'c_1', backend: 'codex', hook: { hook_event_name: 'Interrupt', session_id: SID } })).toMatchObject({ name: 'Interrupt', sessionId: SID });
  });
  it('drops a session id that is not a UUID', () => {
    expect(normalizeHook({ robotId: 'c_1', hook: { hook_event_name: 'SessionStart', session_id: 'x; rm -rf ~' } })?.sessionId).toBeUndefined();
    expect(normalizeStatus({ robotId: 'c_1', status: { sessionId: '$(touch /tmp/p)', contextPct: 1 } })?.sessionId).toBeUndefined();
  });
  it('ignores a transcript path that is not an absolute jsonl file', () => {
    const hook = (transcript_path: string) =>
      normalizeHook({ robotId: 'c_1', hook: { hook_event_name: 'SessionStart', session_id: SID, transcript_path } });
    expect(hook('/Users/me/.ssh/id_rsa')?.transcriptPath).toBeUndefined();
    expect(hook('relative.jsonl')?.transcriptPath).toBeUndefined();
  });
  it('ignores a transcript path longer than a path can be', () => {
    const hook = (transcript_path: string) =>
      normalizeHook({ robotId: 'c_1', hook: { hook_event_name: 'SessionStart', session_id: SID, transcript_path } });
    expect(hook(`/${'x'.repeat(1000)}.jsonl`)?.transcriptPath).toBe(`/${'x'.repeat(1000)}.jsonl`);
    expect(hook(`/${'x'.repeat(5000)}.jsonl`)?.transcriptPath).toBeUndefined();
  });
  it("names a resumed Claude session's transcript where it is when its SessionStart names the project of the folder it resumed in", () => {
    const projects = path.join(makeHome(), '.claude', 'projects');
    const kept = path.join(projects, '-src-alpha', `${SID}.jsonl`);
    fs.mkdirSync(path.dirname(kept), { recursive: true });
    fs.writeFileSync(kept, '{}\n');
    fs.mkdirSync(path.join(projects, '-src-beta'));
    const hook = (name: string, session_id: string, transcript_path: string) =>
      normalizeHook({ robotId: 'c_1', hook: { hook_event_name: name, session_id, transcript_path } })?.transcriptPath;
    const moved = path.join(projects, '-src-alpha--wt-react-boilerplate', `${SID}.jsonl`);
    expect(hook('SessionStart', SID, moved)).toBe(kept);
    // a move between homes resumes it from the same folder under another home, whose project holds nothing either
    expect(hook('SessionStart', SID, path.join(projects, '-home-me-src-alpha', `${SID}.jsonl`))).toBe(kept);
    expect(hook('Stop', SID, kept)).toBe(kept);
    // only a session's start is looked up: its later hooks name the file it writes
    expect(hook('Stop', SID, moved)).toBe(moved);
    // of two copies of the session, the one Claude still writes is the newer, whichever folder a listing gives first
    for (const old of ['-a-old', '-z-old']) {
      const stale = path.join(projects, old, `${SID}.jsonl`);
      fs.mkdirSync(path.dirname(stale));
      fs.writeFileSync(stale, '{}\n');
      fs.utimesSync(stale, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    }
    expect(hook('SessionStart', SID, moved)).toBe(kept);
    // a new session has written nothing yet, and Claude writes it where it says
    const fresh = '7c1e4a2b-9d3f-4b6a-8e5c-2f1a0b9c8d7e';
    expect(hook('SessionStart', fresh, path.join(projects, '-src-beta', `${fresh}.jsonl`))).toBe(path.join(projects, '-src-beta', `${fresh}.jsonl`));
  });
  it('keeps an absolute cwd only', () => {
    const hook = (cwd: string) => normalizeHook({ robotId: 'c_1', hook: { hook_event_name: 'PreToolUse', cwd } });
    expect(hook('/repo/.claude/worktrees/x')?.cwd).toBe('/repo/.claude/worktrees/x');
    expect(hook('relative')?.cwd).toBeUndefined();
  });
  it('keeps the submitted prompt with its id, and only on UserPromptSubmit', () => {
    const hook = (h: Record<string, unknown>) => normalizeHook({ robotId: 'c_1', hook: h })?.prompt;
    expect(hook({ hook_event_name: 'UserPromptSubmit', prompt: ' hoist the sail ', prompt_id: 'p1' })).toEqual({ id: 'p1', text: 'hoist the sail' });
    expect(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'x'.repeat(9000), prompt_id: 'p1' })?.text).toHaveLength(4000);
    expect(hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hoist' })).toBeUndefined();
    expect(hook({ hook_event_name: 'UserPromptSubmit', prompt: '   ', prompt_id: 'p1' })).toBeUndefined();
    expect(hook({ hook_event_name: 'Stop', prompt: 'hoist', prompt_id: 'p1' })).toBeUndefined();
  });
  it('leaves out a turn the harness opened by itself', () => {
    const hook = (p: string) => normalizeHook({ robotId: 'c_1', hook: { hook_event_name: 'UserPromptSubmit', prompt: p, prompt_id: 'p1' } })?.prompt;
    expect(hook('<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>')).toBeUndefined();
    expect(hook('Another Claude session sent a message:\n<agent-message from="a1">done</agent-message>')).toBeUndefined();
    expect(hook('<agent-message from="a1">\n[Subagent hand-back] done\n</agent-message>')).toBeUndefined();
    expect(hook('<cross-session-message from="uds:/tmp/s.sock">done</cross-session-message>')).toBeUndefined();
    expect(hook('Your claude.ai usage limit has reset. Continue.')).toBeUndefined();
    expect(hook('read the <task-notification> tag')).toEqual({ id: 'p1', text: 'read the <task-notification> tag' });
  });
  it('keeps the notification type', () => {
    expect(normalizeHook({ robotId: 'c_1', hook: { hook_event_name: 'Notification', notification_type: 'permission_prompt' } })?.notificationType)
      .toBe('permission_prompt');
  });
  it('keeps the notification message, cut to 500 characters', () => {
    const h = normalizeHook({ robotId: 'c_1', hook: { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x'.repeat(600) } });
    expect(h?.message).toHaveLength(500);
    expect(normalizeHook({ robotId: 'c_1', hook: { hook_event_name: 'Notification', message: '' } })?.message).toBeUndefined();
  });
  it('counts the background agents and shells still running at Stop, not monitors', () => {
    const stop = (background_tasks: unknown) => normalizeHook({ robotId: 'c_1', hook: { hook_event_name: 'Stop', background_tasks } });
    expect(stop([
      { id: 'a1', type: 'subagent', status: 'running' },
      { id: 'w1', type: 'workflow', status: 'pending' },
      { id: 'b1', type: 'shell', status: 'running' },
      { id: 'm1', type: 'monitor', status: 'running' },
    ])).toMatchObject({ backgroundTasks: 3, backgroundAgents: 2, backgroundAgentIds: ['a1', 'w1'] });
    // a list with only monitors in it says none is left
    expect(stop([{ id: 'm1', type: 'monitor', status: 'running' }])?.backgroundTasks).toBe(0);
    expect(stop([])).toMatchObject({ backgroundTasks: 0, backgroundAgentIds: [] });
    expect(stop('junk')?.backgroundTasks).toBeUndefined();
    expect(stop('junk')?.backgroundAgentIds).toBeUndefined();
  });
  it("names the background shells at Stop, and the task a Monitor started, which Claude Code lists as a shell", () => {
    const stop = normalizeHook({ robotId: 'c_1', hook: { hook_event_name: 'Stop', background_tasks: [{ id: 'a1', type: 'subagent' }, { id: 'b1', type: 'shell' }, { type: 'shell' }] } });
    expect(stop).toMatchObject({ backgroundTasks: 3, backgroundShells: ['b1'] });
    const started = (hook_event_name: string, tool_name: string) => normalizeHook({ robotId: 'c_1', hook: { hook_event_name, tool_name, task_id: 'b1' } })?.monitor;
    expect(started('PostToolUse', 'Monitor')).toBe('b1');
    expect(started('PostToolUse', 'Bash')).toBeUndefined();
    expect(started('PreToolUse', 'Monitor')).toBeUndefined();
    expect(started('PostToolUse', 'shell')).toBeUndefined();
    const opencode = (tool_name: string) => normalizeHook({ robotId: 'c_1', backend: 'opencode', hook: { hook_event_name: 'PostToolUse', tool_name, task_id: 'sh_1' } })?.monitor;
    expect(opencode('shell')).toBe('sh_1');
    expect(opencode('read')).toBeUndefined();
  });
  it('drops subagent events, unknown events and malformed input', () => {
    expect(normalizeHook({ robotId: 'c_1', hook: { hook_event_name: 'Stop', agent_id: 'sub' } })).toBeUndefined();
    expect(normalizeHook({ robotId: 'c_1', hook: { hook_event_name: 'SubagentStop' } })).toBeUndefined();
    expect(normalizeHook({ robotId: 'c_1', backend: 'codex', hook: { hook_event_name: 'SubagentStart' } })).toBeUndefined();
    expect(normalizeHook({ robotId: 'c_1', backend: 'codex', hook: { hook_event_name: 'SubagentStart', agent_id: 'a 1' } })).toBeUndefined();
    expect(normalizeHook({ robotId: 'c_1', hook: { hook_event_name: 'Bogus', agent_id: 'a1' } })).toBeUndefined();
    expect(normalizeHook({ hook: { hook_event_name: 'Stop' } })).toBeUndefined();
    expect(normalizeHook('junk')).toBeUndefined();
  });
  it('keeps term 2 and nothing else as the terminal', () => {
    const hook = { hook_event_name: 'Stop' };
    expect(normalizeHook({ robotId: 'c_a', term: 2, hook })).toEqual({ robotId: 'c_a', backend: 'claude', name: 'Stop', term: 2 });
    expect(normalizeHook({ robotId: 'c_a', term: 1, hook })).toEqual({ robotId: 'c_a', backend: 'claude', name: 'Stop' });
    expect(normalizeHook({ robotId: 'c_a', term: '2', hook })).toEqual({ robotId: 'c_a', backend: 'claude', name: 'Stop' });
  });
  it('keeps the pid of the agent that ran the hook, when it is one', () => {
    const hook = { hook_event_name: 'SessionStart', session_id: SID };
    expect(normalizeHook({ robotId: 'c_a', pid: 4242, hook })?.pid).toBe(4242);
    for (const pid of [0, -1, 1.5, '4242', null]) expect(normalizeHook({ robotId: 'c_a', pid, hook })?.pid).toBeUndefined();
  });
});

describe('normalizeStatus', () => {
  it('reads the context window Claude Code hands its statusline', () => {
    expect(normalizeStatus({ robotId: 'c_1', status: { sessionId: SID, contextPct: 9.4, model: 'claude-opus-5' } }))
      .toEqual({ robotId: 'c_1', contextPct: 9.4, sessionId: SID, model: 'claude-opus-5' });
  });
  it('clamps the percentage and drops a reading without one', () => {
    expect(normalizeStatus({ robotId: 'c_1', status: { contextPct: 140 } })?.contextPct).toBe(100);
    expect(normalizeStatus({ robotId: 'c_1', status: { model: 'x' } })).toBeUndefined();
    expect(normalizeStatus({ status: { contextPct: 5 } })).toBeUndefined();
  });
  it('keeps term 2 as the terminal', () => {
    expect(normalizeStatus({ robotId: 'c_a', term: 2, status: { contextPct: 40 } })).toEqual({ robotId: 'c_a', contextPct: 40, term: 2 });
    expect(normalizeStatus({ robotId: 'c_a', status: { contextPct: 40 } })).toEqual({ robotId: 'c_a', contextPct: 40 });
  });
});


describe('hook receiver', () => {
  it('reclaims a socket left by a crashed daemon', async () => {
    const sock = path.join(makeHome(), 'hooks.sock');
    const child = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(sock)}, () => process.stdout.write('ready'))`]);
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve());
        child.once('error', reject);
        child.once('exit', () => reject(new Error('socket owner exited before listening')));
      });
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      expect(fs.existsSync(sock)).toBe(true);
      const receiver = await startHookReceiver(sock, () => undefined, silentLogger);
      try { expect(fs.existsSync(sock)).toBe(true); }
      finally { await receiver.close(); }
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('refuses to replace an active receiver', async () => {
    const sock = path.join(makeHome(), 'hooks.sock');
    const events: SocketEvent[] = [];
    const first = await startHookReceiver(sock, (e) => { events.push(e); }, silentLogger);
    try {
      await expect(startHookReceiver(sock, () => undefined, silentLogger)).rejects.toThrow(/already running/);
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(sock);
        socket.once('error', reject);
        socket.once('connect', () => socket.end(JSON.stringify({ robotId: 'c_9', hook: {
          hook_event_name: 'Stop', session_id: SID,
        } }) + '\n', resolve));
      });
      await waitFor(() => events.length === 1);
    } finally {
      await first.close();
    }
  });

  it('drops a line over the cap, says so, and reads the one after it', async () => {
    const sock = path.join(makeHome(), 'hooks.sock');
    const events: SocketEvent[] = [];
    const said: string[] = [];
    const r = await startHookReceiver(sock, (e) => { events.push(e); }, { info() {}, error: (m) => said.push(m) });
    const good = JSON.stringify({ robotId: 'c_9', hook: { hook_event_name: 'Stop', session_id: SID } });
    await new Promise<void>((resolve) => {
      const c = net.createConnection(sock, () => {
        c.write(JSON.stringify({ robotId: 'c_9', hook: { hook_event_name: 'Stop', message: 'x'.repeat(400_000) } }) + '\n');
        c.end(good + '\n', resolve);
      });
    });
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ hook: { robotId: 'c_9', backend: 'claude', name: 'Stop', sessionId: SID } });
    expect(said).toEqual(['hook line dropped: over the 262144 byte cap']);
    await r.close();
  });

  it('says once that a line was dropped, however many chunks the rest of it arrives in', async () => {
    const sock = path.join(makeHome(), 'hooks.sock');
    const events: SocketEvent[] = [];
    const said: string[] = [];
    const r = await startHookReceiver(sock, (e) => { events.push(e); }, { info() {}, error: (m) => said.push(m) });
    const good = JSON.stringify({ robotId: 'c_9', hook: { hook_event_name: 'Stop', session_id: SID } });
    const c = net.createConnection(sock);
    await new Promise<void>((resolve) => c.on('connect', () => resolve()));
    c.write('x'.repeat(300_000));
    await waitFor(() => said.length === 1);
    // the tail of the same line, still with no newline to end it
    c.write('x'.repeat(300_000));
    await new Promise((resolve) => setTimeout(resolve, 50));
    c.end('\n' + good + '\n');
    await waitFor(() => events.length === 1);
    expect(said).toEqual(['hook line dropped: over the 262144 byte cap']);
    await r.close();
  });

  it('answers a hook that waits on a reply when the event throws, or its promise fails', async () => {
    const sock = path.join(makeHome(), 'hooks.sock');
    const said: string[] = [];
    const r = await startHookReceiver(sock, (e) => {
      if ('status' in e) throw new Error('no');
      if (e.hook.name === 'SessionStart') throw new Error('boom');
      return Promise.reject(new Error('later'));
    }, { info() {}, error: (m) => said.push(m) });
    const ask = (line: object) => new Promise<string>((resolve) => {
      let buf = '';
      const c = net.createConnection(sock, () => c.write(JSON.stringify(line) + '\n'));
      c.on('data', (d: Buffer) => { buf += d.toString(); if (buf.includes('\n')) { c.end(); resolve(buf); } });
    });
    expect(await ask({ robotId: 'c_9', hook: { hook_event_name: 'SessionStart', session_id: SID } })).toBe('{"additionalContext":""}\n');
    expect(await ask({ robotId: 'c_9', hook: { hook_event_name: 'UserPromptSubmit', session_id: SID } })).toBe('{"additionalContext":""}\n');
    expect(said).toEqual(['hook line ignored: Error: boom', 'hook line ignored: Error: later']);
    await r.close();
  });

  it('writes the reply an event promises once it resolves', async () => {
    const sock = path.join(makeHome(), 'hooks.sock');
    const r = await startHookReceiver(sock, async () => { await new Promise((res) => setTimeout(res, 20)); return 'brief'; }, silentLogger);
    const reply = await new Promise<string>((resolve) => {
      let buf = '';
      const c = net.createConnection(sock, () => c.write(JSON.stringify({ robotId: 'c_9', hook: { hook_event_name: 'UserPromptSubmit', session_id: SID } }) + '\n'));
      c.on('data', (d: Buffer) => { buf += d.toString(); if (buf.includes('\n')) { c.end(); resolve(buf); } });
    });
    expect(reply).toBe('{"additionalContext":"brief"}\n');
    await r.close();
  });

  it('closes while a hook connection is still open', async () => {
    const sock = path.join(makeHome(), 'hooks.sock');
    const r = await startHookReceiver(sock, () => undefined, silentLogger);
    const c = net.createConnection(sock);
    await new Promise<void>((resolve) => c.on('connect', () => resolve()));
    const t0 = Date.now();
    await r.close();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('ignores garbage lines', async () => {
    const sock = path.join(makeHome(), 'hooks.sock');
    const events: SocketEvent[] = [];
    const r = await startHookReceiver(sock, (e) => { events.push(e); }, silentLogger);
    await new Promise<void>((resolve) => { const c = net.createConnection(sock, () => c.end('not json\n', resolve)); });
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toEqual([]);
    await r.close();
  });
});

// what the installed commands run: the scripts on node, or the compiled helper svalld puts beside them
const helperDir = fs.mkdtempSync('/tmp/svall-hook-');
const helper = path.join(helperDir, 'svall-hook');
type Run = [string, string[]];
type Runner = { name: string; dir: string; files: string[]; hook: (dir: string, ...args: string[]) => Run; status: (dir: string, ...args: string[]) => Run };
const runners: Runner[] = [{
  name: 'the node scripts', dir: path.dirname(script), files: [script, statusScript],
  hook: (dir, ...args) => ['node', [path.join(dir, 'agent-hook.mjs'), ...args]],
  status: (dir, ...args) => ['node', [path.join(dir, 'claude-status.mjs'), ...args]],
}, {
  name: 'the compiled helper', dir: helperDir, files: [helper],
  hook: (dir, ...args) => [path.join(dir, 'svall-hook'), args],
  status: (dir, ...args) => [path.join(dir, 'svall-hook'), ['status', ...args]],
}];

beforeAll(() => { execFileSync('swiftc', ['-O', '-wmo', '-o', helper, ...hookHelperSources().filter((f) => f.endsWith('.swift'))]); }, 180_000);
afterAll(() => fs.rmSync(helperDir, { recursive: true, force: true }));

describe.each(runners)('$name', (run) => {
  const hook = (...args: string[]): Run => run.hook(run.dir, ...args);
  const status = (...args: string[]): Run => run.status(run.dir, ...args);

  it('delivers the events it is handed', async () => {
    const home = makeHome();
    const sock = path.join(home, 'hooks.sock');
    const events: SocketEvent[] = [];
    const r = await startHookReceiver(sock, (e) => { events.push(e); }, silentLogger);
    await new Promise<void>((resolve, reject) => {
      const p = execFile(...hook(), { env: { ...process.env, SVALL_HOME: home, SVALL_ROBOT_ID: 'c_9' } }, (err) => (err ? reject(err) : resolve()));
      p.stdin!.end(JSON.stringify({ hook_event_name: 'Stop', session_id: SID, transcript_path: '/t1.jsonl' }));
    });
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ hook: { robotId: 'c_9', backend: 'claude', name: 'Stop', sessionId: SID, transcriptPath: '/t1.jsonl' } });
    await r.close();
  });

  it('forwards through the installed commands every field the daemon reads, and the pid of the agent running them', async () => {
    const home = makeHome();
    const lines: { backend: string }[] = [];
    const server = net.createServer((c) => {
      let buf = '';
      c.setEncoding('utf8');
      c.on('data', (d) => { buf += d; });
      c.on('end', () => lines.push(JSON.parse(buf)));
    });
    await new Promise<void>((r) => server.listen(path.join(home, 'hooks.sock'), r));
    const kept = {
      hook_event_name: 'Notification', agent_id: 'a1', session_id: SID, transcript_path: '/t1.jsonl', notification_type: 'permission_prompt', message: 'may I',
      background_tasks: [{ type: 'subagent' }], cwd: '/r', model: 'opus', prompt: 'go', prompt_id: 'p1', turn_id: 't1', tool_name: 'Bash',
    };
    // the helper's folder holds no script, so the commands only forward anything there by running it
    const installed = path.join(run.dir, 'agent-hook.mjs');
    // the shell a hook command runs in is the agent's child, so its $PPID is the agent: here, this test
    for (const command of [hookCommand(process.execPath, installed, 'claude'), codexHookCommand(installed)]) {
      await new Promise<void>((resolve, reject) => {
        const p = execFile('/bin/sh', ['-c', command], { env: { ...process.env, SVALL_HOME: home, SVALL_ROBOT_ID: 'c_9' } }, (err) => (err ? reject(err) : resolve()));
        p.stdin!.end(JSON.stringify({ ...kept, tool_input: { command: 'ls' }, permission_mode: 'default' }));
      });
    }
    await waitFor(() => lines.length === 2);
    expect(lines.sort((a, b) => a.backend.localeCompare(b.backend))).toEqual([
      { robotId: 'c_9', backend: 'claude', pid: process.pid, hook: kept },
      { robotId: 'c_9', backend: 'codex', pid: process.pid, hook: kept },
    ]);
    server.close();
  });

  it('forwards none of a payload that is not JSON, even where it breaks in a field the daemon never reads', async () => {
    const home = makeHome();
    const lines: unknown[] = [];
    const server = net.createServer((c) => {
      let buf = '';
      c.setEncoding('utf8');
      c.on('data', (d) => { buf += d; });
      c.on('end', () => lines.push(JSON.parse(buf)));
    });
    await new Promise<void>((r) => server.listen(path.join(home, 'hooks.sock'), r));
    const broken = [
      `{"hook_event_name":"PostToolUse","session_id":"${SID}","tool_name":"Monitor","tool_response":{"taskId":"b9x","x":[1,]}}`,
      `{"hook_event_name":"PreToolUse","session_id":"${SID}","tool_name":"Write","tool_input":{"content":"a\u0001b"}}`,
    ];
    for (const payload of broken) {
      await new Promise<void>((resolve, reject) => {
        const p = execFile(...hook(), { env: { ...process.env, SVALL_HOME: home, SVALL_ROBOT_ID: 'c_9' } }, (err) => (err ? reject(err) : resolve()));
        p.stdin!.end(payload);
      });
    }
    await waitFor(() => lines.length === 2);
    expect(lines).toEqual([{ robotId: 'c_9', backend: 'claude', hook: {} }, { robotId: 'c_9', backend: 'claude', hook: {} }]);
    server.close();
  });

  it('delivers a large PreToolUse whole, carrying only the fields the daemon reads', async () => {
    const home = makeHome();
    const events: SocketEvent[] = [];
    const r = await startHookReceiver(path.join(home, 'hooks.sock'), (e) => { events.push(e); }, silentLogger);
    await new Promise<void>((resolve, reject) => {
      const p = execFile(...hook(), { env: { ...process.env, SVALL_HOME: home, SVALL_ROBOT_ID: 'c_9' } }, (err) => (err ? reject(err) : resolve()));
      p.stdin!.end(JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: SID, transcript_path: '/t1.jsonl', tool_name: 'Write',
        tool_input: { content: 'x'.repeat(64 * 1024) },
      }));
    });
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ hook: { robotId: 'c_9', backend: 'claude', name: 'PreToolUse', sessionId: SID, transcriptPath: '/t1.jsonl', toolName: 'Write' } });
    await r.close();
  });

  it('says what codex asks permission for, which its payload keeps inside tool_input', async () => {
    const home = makeHome();
    const events: SocketEvent[] = [];
    const r = await startHookReceiver(path.join(home, 'hooks.sock'), (e) => { events.push(e); }, silentLogger);
    await new Promise<void>((resolve, reject) => {
      const p = execFile(...hook('codex'), { env: { ...process.env, SVALL_HOME: home, SVALL_ROBOT_ID: 'c_9' } }, (err) => (err ? reject(err) : resolve()));
      p.stdin!.end(JSON.stringify({
        hook_event_name: 'PermissionRequest', session_id: SID, tool_name: 'Bash',
        tool_input: { command: 'rm -rf build', description: 'remove the build folder' },
      }));
    });
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ hook: { robotId: 'c_9', backend: 'codex', name: 'PermissionRequest', sessionId: SID, message: 'remove the build folder', toolName: 'Bash' } });
    await r.close();
  });

  it("says what codex's own question asks, which its tool's input holds", async () => {
    const home = makeHome();
    const events: SocketEvent[] = [];
    const r = await startHookReceiver(path.join(home, 'hooks.sock'), (e) => { events.push(e); }, silentLogger);
    await new Promise<void>((resolve, reject) => {
      const p = execFile(...hook('codex'), { env: { ...process.env, SVALL_HOME: home, SVALL_ROBOT_ID: 'c_9' } }, (err) => (err ? reject(err) : resolve()));
      p.stdin!.end(JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'request_user_input',
        tool_input: { questions: [{ id: 'ship', header: 'Ship', question: 'Ship it now?', options: [{ label: 'Yes', description: 'Go.' }] }] },
      }));
    });
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ hook: { robotId: 'c_9', backend: 'codex', name: 'PreToolUse', sessionId: SID, message: 'Ship it now?', toolName: 'request_user_input' } });
    await r.close();
  });

  it('hands on the task a Monitor started, which its payload keeps inside tool_response', async () => {
    const home = makeHome();
    const events: SocketEvent[] = [];
    const r = await startHookReceiver(path.join(home, 'hooks.sock'), (e) => { events.push(e); }, silentLogger);
    await new Promise<void>((resolve, reject) => {
      const p = execFile(...hook(), { env: { ...process.env, SVALL_HOME: home, SVALL_ROBOT_ID: 'c_9' } }, (err) => (err ? reject(err) : resolve()));
      p.stdin!.end(JSON.stringify({
        hook_event_name: 'PostToolUse', session_id: SID, tool_name: 'Monitor',
        tool_input: { command: 'tail -f log', description: 'log' }, tool_response: { taskId: 'b9x', timeoutMs: 0, persistent: true },
      }));
    });
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ hook: { robotId: 'c_9', backend: 'claude', name: 'PostToolUse', sessionId: SID, toolName: 'Monitor', monitor: 'b9x' } });
    await r.close();
  });

  it("says why an API error ended a claude turn, from the text Claude Code showed or else the error's name", async () => {
    const home = makeHome();
    const events: SocketEvent[] = [];
    const r = await startHookReceiver(path.join(home, 'hooks.sock'), (e) => { events.push(e); }, silentLogger);
    for (const payload of [
      { hook_event_name: 'StopFailure', session_id: SID, error: 'rate_limit', last_assistant_message: "You've hit your limit · resets 5pm" },
      { hook_event_name: 'StopFailure', session_id: SID, error: 'overloaded' },
    ]) {
      await new Promise<void>((resolve, reject) => {
        const p = execFile(...hook(), { env: { ...process.env, SVALL_HOME: home, SVALL_ROBOT_ID: 'c_9' } }, (err) => (err ? reject(err) : resolve()));
        p.stdin!.end(JSON.stringify(payload));
      });
    }
    await waitFor(() => events.length === 2);
    expect(events.map((e) => ('hook' in e ? e.hook.message : undefined))).toEqual(["You've hit your limit · resets 5pm", 'overloaded']);
    await r.close();
  });

  it('holds an event for a daemon that is restarting, and hands it over once the socket is back', async () => {
    const home = makeHome();
    const events: SocketEvent[] = [];
    const ran = new Promise<void>((resolve, reject) => {
      const p = execFile(...hook(), { env: { ...process.env, SVALL_HOME: home, SVALL_ROBOT_ID: 'c_9' } }, (err) => (err ? reject(err) : resolve()));
      p.stdin!.end(JSON.stringify({ hook_event_name: 'Stop', session_id: SID }));
    });
    await new Promise((res) => setTimeout(res, 600));
    const r = await startHookReceiver(path.join(home, 'hooks.sock'), (e) => { events.push(e); }, silentLogger);
    await ran;
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ hook: { robotId: 'c_9', backend: 'claude', name: 'Stop', sessionId: SID } });
    await r.close();
  });

  // an unclipped paste would run past the receiver's line limit, which drops the whole event
  it('clips a huge pasted prompt to a line the receiver still takes', async () => {
    const home = makeHome();
    const events: SocketEvent[] = [];
    const r = await startHookReceiver(path.join(home, 'hooks.sock'), (e) => { events.push(e); return ''; }, silentLogger);
    await new Promise<void>((resolve, reject) => {
      const p = execFile(...hook(), { env: { ...process.env, SVALL_HOME: home, SVALL_ROBOT_ID: 'c_9' } }, (err) => (err ? reject(err) : resolve()));
      p.stdin!.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: 'x'.repeat(1024 * 1024), prompt_id: 'p1' }));
    });
    await waitFor(() => events.length === 1);
    expect((events[0] as { hook: { prompt?: { id: string; text: string } } }).hook.prompt).toEqual({ id: 'p1', text: 'x'.repeat(4000) });
    await r.close();
  });

  it('exits 0 without a robot id or without a socket, giving up on the socket within a few seconds', async () => {
    const home = makeHome();
    for (const env of [{ SVALL_HOME: home }, { SVALL_HOME: home, SVALL_ROBOT_ID: 'c_1' }]) {
      const t0 = Date.now();
      const code = await new Promise<number | null>((resolve) => {
        const p = execFile(...hook(), { env: { ...process.env, ...env } }, () => {});
        p.on('exit', resolve);
        p.stdin!.end('{}');
      });
      expect(code).toBe(0);
      expect(Date.now() - t0).toBeLessThan(3500);
    }
    expect(fs.existsSync(path.join(home, 'hooks.down'))).toBe(true);
  });

  it('gives up at once for a minute after an event gave up on the socket, so a daemon that stays down holds up one hook', async () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'hooks.down'), '');
    const t0 = Date.now();
    await new Promise<void>((resolve) => {
      const p = execFile(...hook(), { env: { ...process.env, SVALL_HOME: home, SVALL_ROBOT_ID: 'c_1' } }, () => resolve());
      p.stdin!.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SID }));
    });
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('gives a tool call up at once without a socket, as the next one says the same', async () => {
    for (const name of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      const home = makeHome();
      const t0 = Date.now();
      await new Promise<void>((resolve) => {
        const p = execFile(...hook(), { env: { ...process.env, SVALL_HOME: home, SVALL_ROBOT_ID: 'c_1' } }, () => resolve());
        p.stdin!.end(JSON.stringify({ hook_event_name: name, session_id: SID }));
      });
      expect(Date.now() - t0).toBeLessThan(1500);
    }
  });

  it('exits 0 within 1.5 s when its input never ends', async () => {
    const t0 = Date.now();
    const code = await new Promise<number | null>((resolve) => {
      const p = execFile(...hook(), { env: { ...process.env, SVALL_HOME: makeHome(), SVALL_ROBOT_ID: 'c_1' } }, () => {});
      p.on('exit', resolve);
    });
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('reports the context window and passes the wrapped statusline through', async () => {
    const home = makeHome();
    const sock = path.join(home, 'hooks.sock');
    const events: SocketEvent[] = [];
    const r = await startHookReceiver(sock, (e) => { events.push(e); }, silentLogger);
    const out = await new Promise<string>((resolve, reject) => {
      const p = execFile(...status('echo inner'), { env: { ...process.env, SVALL_HOME: home, SVALL_ROBOT_ID: 'c_9' } },
        (err, stdout) => (err ? reject(err) : resolve(stdout)));
      p.stdin!.end(JSON.stringify({
        session_id: SID, model: { id: 'claude-opus-5' },
        context_window: { used_percentage: 9.4, context_window_size: 1_000_000 },
      }));
    });
    expect(out.trim()).toBe('inner');
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ status: { robotId: 'c_9', sessionId: SID, contextPct: 9.4, model: 'claude-opus-5' } });
    await r.close();
  });

  it('passes the wrapped statusline exit code on', async () => {
    const home = makeHome();
    const code = await new Promise<number | null>((resolve) => {
      const p = execFile(...status('exit 7'), { env: { ...process.env, SVALL_HOME: home } }, () => {});
      p.on('exit', resolve);
      p.stdin!.end('{}');
    });
    expect(code).toBe(7);
  });

  it('reports without waiting for a wrapped statusline that never reads its input', async () => {
    const home = makeHome();
    const sock = path.join(home, 'hooks.sock');
    const events: SocketEvent[] = [];
    const r = await startHookReceiver(sock, (e) => { events.push(e); }, silentLogger);
    let exited = false;
    const done = new Promise<void>((resolve) => {
      const p = execFile(...status('sleep 2'), { env: { ...process.env, SVALL_HOME: home, SVALL_ROBOT_ID: 'c_9' } }, () => {});
      p.on('exit', () => { exited = true; resolve(); });
      // more than a pipe holds, so a write to the command blocks until it exits
      p.stdin!.end(JSON.stringify({ context_window: { used_percentage: 9 }, pad: 'x'.repeat(200_000) }));
    });
    await waitFor(() => events.length === 1);
    expect(exited).toBe(false);
    await done;
    await r.close();
  });

  it('prints the receiver reply as additionalContext for SessionStart and stays silent otherwise', async () => {
    const home = makeHome();
    const sock = path.join(home, 'hooks.sock');
    const r = await startHookReceiver(sock, (e) => ('hook' in e && e.hook.name === 'SessionStart' ? 'the brief' : undefined), silentLogger);
    const send = (payload: Record<string, unknown>) => new Promise<string>((resolve, reject) => {
      const p = execFile(...hook(), { env: { ...process.env, SVALL_HOME: home, SVALL_ROBOT_ID: 'c_9' } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
      p.stdin!.end(JSON.stringify({ session_id: SID, transcript_path: '/t1.jsonl', ...payload }));
    });
    expect(JSON.parse(await send({ hook_event_name: 'SessionStart' })))
      .toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'the brief' } });
    const t0 = Date.now();
    expect(await send({ hook_event_name: 'UserPromptSubmit' })).toBe('');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await send({ hook_event_name: 'Stop' })).toBe('');
    await r.close();
  });

  it('does not truncate a large reply piped through stdout', async () => {
    const home = makeHome();
    const sock = path.join(home, 'hooks.sock');
    const big = 'x'.repeat(200_000);
    const r = await startHookReceiver(sock, (e) => ('hook' in e && e.hook.name === 'SessionStart' ? big : undefined), silentLogger);
    const out = await new Promise<string>((resolve, reject) => {
      const p = execFile(...hook(), { env: { ...process.env, SVALL_HOME: home, SVALL_ROBOT_ID: 'c_9' }, maxBuffer: 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)));
      p.stdin!.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: SID, transcript_path: '/t1.jsonl' }));
    });
    expect(JSON.parse(out)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: big } });
    await r.close();
  });

  it('exits 0 with no output when the receiver never answers a SessionStart', async () => {
    const home = makeHome();
    const sock = path.join(home, 'hooks.sock');
    const server = net.createServer(() => {});
    await new Promise<void>((res) => server.listen(sock, res));
    const t0 = Date.now();
    const { code, out } = await new Promise<{ code: number | null; out: string }>((resolve) => {
      let out = '';
      const p = execFile(...hook(), { env: { ...process.env, SVALL_HOME: home, SVALL_ROBOT_ID: 'c_1' } }, () => {});
      p.stdout!.on('data', (d) => (out += d));
      p.on('exit', (code) => resolve({ code, out }));
      p.stdin!.end(JSON.stringify({ hook_event_name: 'SessionStart' }));
    });
    expect(code).toBe(0);
    expect(out).toBe('');
    expect(Date.now() - t0).toBeLessThan(2500);
    server.close();
  });
});

describe('the compiled helper', () => {
  // the same input through each, against a socket that keeps every byte and answers a waiting hook with `reply`
  async function both(run: (r: Runner) => Run, input: string | Buffer, env: Record<string, string> = {}, reply = '') {
    const home = makeHome();
    const got: Buffer[] = [];
    let opened = 0;
    const server = net.createServer((c) => {
      opened++;
      const chunks: Buffer[] = [];
      c.on('data', (d) => { chunks.push(d); if (reply && Buffer.concat(chunks).includes(10)) c.write(reply); });
      c.on('end', () => { got.push(Buffer.concat(chunks)); c.end(); });
    });
    await new Promise<void>((r) => server.listen(path.join(home, 'hooks.sock'), r));
    const results = [];
    for (const r of runners) {
      got.length = 0;
      opened = 0;
      const { code, stdout } = await new Promise<{ code: number | null; stdout: Buffer }>((resolve) => {
        const p = execFile(...run(r), { env: { ...process.env, SVALL_HOME: home, SVALL_ROBOT_ID: 'c_9', ...env }, encoding: 'buffer' }, (_, stdout) => resolve({ code: p.exitCode, stdout }));
        p.stdin!.end(input);
      });
      // a connection the process made can reach the server after it exits
      await new Promise((r) => setTimeout(r, 50));
      await waitFor(() => got.length === opened);
      results.push({ code, stdout: stdout.toString('hex'), sock: Buffer.concat(got).toString('hex') });
    }
    server.close();
    return results;
  }
  const same = async (...args: Parameters<typeof both>) => {
    const [node, helper] = await both(...args);
    expect(helper).toEqual(node);
  };
  const hook = (...args: string[]) => (r: Runner): Run => r.hook(r.dir, ...args);
  const status = (...args: string[]) => (r: Runner): Run => r.status(r.dir, ...args);

  it('writes the bytes the hook script writes', async () => {
    const payloads: (string | Buffer)[] = [
      JSON.stringify({ hook_event_name: 'Stop', agent_id: 'a1', session_id: SID, cwd: 'åäö 中文 😀  \x7f', model: 'opus', background_tasks: [{ type: 'subagent', n: [true, null, {}] }], tool_input: { a: 1 } }),
      // keys repeated, out of order and integer-like; numbers JS lays out its own way
      '{"turn_id":"t","hook_event_name":"Stop","cwd":"/a","cwd":"/b","background_tasks":{"b":1,"2":2,"a":3,"1":4,"4294967295":5,"4294967294":6,"01":7,"x":[0,-0,1.50,1E21,1e-7,0.000001,1e400,5e-324,123e-20,-12.5e3,0.1,9007199254740993]}}',
      '{"hook_event_name":"Stop","cwd":"\\u0000\\u001f\\b\\f\\n\\r\\t\\"\\\\\\/\\ud800\\udbff\\uDFFF\\uD83D\\uDE00x","message":"\\ud83d"}',
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'x'.repeat(3999) + '😀tail', prompt_id: 'p' }),
      Buffer.concat([Buffer.from('{"hook_event_name":"Stop","cwd":"a'), Buffer.from([0xff, 0xc3, 0x28, 0xe2, 0x82, 0xf0, 0x9f, 0x98, 0xed, 0xa0, 0x80, 0xe2, 0x82]), Buffer.from('"}')]),
      JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { description: null, command: ['bash', '-lc', null, 3.5, [1, null, [2]], { a: 1 }] } }),
      JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', message: '', tool_input: 'str' }),
      JSON.stringify({ hook_event_name: 'PermissionRequest', message: 0, tool_input: { command: 'y'.repeat(499) + '😀' } }),
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'request_user_input', tool_input: { questions: [{ question: 'q'.repeat(499) + '😀' }, { question: 'two' }] } }),
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'request_user_input', tool_input: { questions: { 0: { question: ['a', null, 2] } } } }),
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'request_user_input', tool_input: { questions: [] } }),
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'request_user_input', message: 'kept', tool_input: { questions: 'abc' } }),
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { questions: [{ question: 'not asked' }] } }),
      JSON.stringify({ hook_event_name: 'StopFailure', last_assistant_message: '', error: 'z'.repeat(600) }),
      JSON.stringify({ hook_event_name: 'StopFailure', last_assistant_message: 7, error: 'overloaded' }),
      ' \t\n{ "hook_event_name" : "Stop" , "cwd" : [ 1 , 2 ] }\r\n ', '', 'not json', '{"a":01}', '﻿{}', '[]', '"x"', '5',
    ];
    for (const p of payloads) await same(hook('claude', '42'), p, { SVALL_TERM: '2' });
    await same(hook('codex'), payloads[0], { SVALL_ROBOT_ID: 'c_é😀' });
  });

  it("prints the daemon's answer as the hook script prints it", async () => {
    for (const reply of [JSON.stringify({ additionalContext: 'the brief é 😀 \n"quoted" \u0001' }), '{"additionalContext":{"a":[1]}}', '{"additionalContext":""}', 'null', 'garbage']) {
      await same(hook(), JSON.stringify({ hook_event_name: 'SessionStart', session_id: SID }), {}, `${reply}\n`);
    }
  });

  it('writes the bytes the statusline script writes, and runs the command it wraps alike', async () => {
    for (const input of [
      JSON.stringify({ session_id: SID, model: { id: 'claude-opus-5' }, context_window: { used_percentage: 9.4 } }),
      JSON.stringify({ session_id: 5, model: 'x', context_window: { used_percentage: 1e-7 } }),
      JSON.stringify({ context_window: { used_percentage: '12' } }), 'null', '{}',
    ]) await same(status('wc -c; echo "$#:$0"'), input, { SVALL_TERM: '2' });
    await same(status('kill -9 $$'), '{}');
    await same(status(), '{}');
  });
});

describe.each(runners)('$name of the other variant', (run) => {
  // runs a copy installed under <root>/<scriptHome>/hooks against a listening socket in <root>/<fleet>;
  // with `target`, <root>/<scriptHome> is a symlink to <root>/<target>
  async function lines(kind: 'hook' | 'status', scriptHome: string, fleet: string, stdin: string, target?: string): Promise<{ got: string[]; code: number | null }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-'));
    if (target) {
      fs.mkdirSync(path.join(root, target));
      fs.symlinkSync(path.join(root, target), path.join(root, scriptHome));
    }
    const dir = path.join(root, scriptHome, 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of run.files) fs.copyFileSync(f, path.join(dir, path.basename(f)));
    const home = path.join(root, fleet);
    fs.mkdirSync(home, { recursive: true });
    const got: string[] = [];
    const server = net.createServer((s) => s.on('data', (d) => got.push(String(d)))).listen(path.join(home, 'hooks.sock'));
    await new Promise<void>((r) => server.once('listening', r));
    const code = await new Promise<number | null>((resolve) => {
      const p = execFile(...(kind === 'hook' ? run.hook(dir) : run.status(dir, 'cat >/dev/null')), { env: { ...process.env, SVALL_HOME: home, SVALL_ROBOT_ID: 'c_9' } }, () => {});
      p.on('exit', resolve);
      p.stdin!.end(stdin);
    });
    await new Promise((r) => setTimeout(r, 100));
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
    return { got, code };
  }
  const hook = JSON.stringify({ hook_event_name: 'Stop' });
  const status = JSON.stringify({ session_id: 's', context_window: { used_percentage: 12 } });

  it('forwards nothing for a home of the other variant', async () => {
    expect((await lines('hook', '.svall-dev', '.svall', hook)).got).toEqual([]);
  });
  it('forwards for a home of its own variant', async () => {
    expect((await lines('hook', '.svall', '.svall', hook)).got).toHaveLength(1);
  });
  it('forwards for a home of its own variant that is a symlink', async () => {
    expect((await lines('hook', '.svall', '.svall', hook, 'svall-data')).got).toHaveLength(1);
    expect((await lines('status', '.svall', '.svall', status, 'svall-data')).got).toHaveLength(1);
  });
  it("leaves a test fleet to Svall Dev's script only", async () => {
    expect((await lines('hook', '.svall', 'fleet', hook)).got).toEqual([]);
    expect((await lines('hook', '.svall-dev', 'fleet', hook)).got).toHaveLength(1);
  });

  it('reports no status for a home of the other variant, and still runs the wrapped command', async () => {
    const r = await lines('status', '.svall-dev', '.svall', status);
    expect(r).toEqual({ got: [], code: 0 });
  });
  it('reports status for a home of its own variant', async () => {
    expect((await lines('status', '.svall', '.svall', status)).got).toHaveLength(1);
  });
  it("leaves a test fleet's status to Svall Dev's script only", async () => {
    expect((await lines('status', '.svall', 'fleet', status)).got).toEqual([]);
    expect((await lines('status', '.svall-dev', 'fleet', status)).got).toHaveLength(1);
  });

  it("reports each event once, to the fleet's own variant, through both variants' installed commands", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-'));
    const homes = ['.svall', '.svall-dev'].map((h) => path.join(root, h));
    const got = new Map<string, string[]>();
    const servers: net.Server[] = [];
    let statusLine: Record<string, unknown> = { statusLine: { type: 'command', command: 'echo mine' } };
    const hooks: string[] = [];
    for (const home of homes) {
      const dir = path.join(home, 'hooks');
      fs.mkdirSync(dir, { recursive: true });
      for (const f of run.files) fs.copyFileSync(f, path.join(dir, path.basename(f)));
      got.set(home, []);
      servers.push(net.createServer((s) => s.on('data', (d) => got.get(home)!.push(String(d)))).listen(path.join(home, 'hooks.sock')));
      statusLine = mergeStatusLine(statusLine, statusWrapper(process.execPath, path.join(dir, 'claude-status.mjs')), path.join(dir, 'claude-status.mjs'));
      hooks.push(hookCommand(process.execPath, path.join(dir, 'agent-hook.mjs'), 'claude'));
    }
    const sh = (command: string, home: string, stdin: string) => new Promise<string>((resolve, reject) => {
      const p = execFile('/bin/sh', ['-c', command], { env: { ...process.env, SVALL_HOME: home, SVALL_ROBOT_ID: 'c_9' } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
      p.stdin!.end(stdin);
    });
    for (const home of homes) {
      expect(await sh((statusLine.statusLine as { command: string }).command, home, status)).toBe('mine\n');
      for (const command of hooks) await sh(command, home, hook);
    }
    await new Promise((r) => setTimeout(r, 100));
    for (const s of servers) s.close();
    fs.rmSync(root, { recursive: true, force: true });
    for (const home of homes) expect(got.get(home)!.map((l) => Object.keys(JSON.parse(l)).pop())).toEqual(['status', 'hook']);
  });
});
