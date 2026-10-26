import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { condenseTurnsOpencode } from '../src/agent/opencode-transcript.js';
import { applyHook, type Slot } from '../src/agent/reducer.js';
import { startHookReceiver, type SocketEvent } from '../src/hooks/receiver.js';
import { silentLogger } from '../src/log.js';
import { cleanHomes, makeHome, waitFor } from './helpers.js';

const PLUGIN = path.resolve(import.meta.dirname, '../hooks/opencode-plugin.js');
const SID = 'ses_0f3a5b7c9d1eAbCdEfGhIjKlMn';
const CHILD = 'ses_0f3a5b7c9d1fZyXwVuTsRqPoNm';
const MODEL = { providerID: 'opencode', id: 'big-pickle' };

let home: string;
let got: SocketEvent[];
let receiver: { close(): Promise<void> };
// what svalld answers SessionStart and each prompt with, for an agent that holds the brief as system text
let brief: string;
const listen = async () => {
  receiver = await startHookReceiver(path.join(home, 'hooks.sock'), (e) => {
    got.push(e);
    if (!('hook' in e)) return undefined;
    return e.hook.name === 'SessionStart' || e.hook.name === 'UserPromptSubmit' ? brief : undefined;
  }, silentLogger);
};
const names = () => got.flatMap((e) => ('hook' in e ? [e.hook.name] : ['status']));
// the robot's card once svalld has taken every hook the plugin sent
const card = () => got.reduce<Slot>((c, e) => ('hook' in e ? applyHook(c, e.hook, Date.now()) : c), { unread: false }).agent;

type Hook = (e: Record<string, unknown>) => Promise<void> | void;
// the plugin context OpenCode hands setup: its hooks are kept by name, and emit resolves once the plugin has taken the event
const fakeContext = (parents: Record<string, string> = {}) => {
  const hooks: Record<string, Hook> = {};
  const register = (domain: string) => vi.fn(async (name: string, cb: Hook) => { hooks[`${domain}.${name}`] = cb; return { dispose: async () => {} }; });
  let pull: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: Error) => void } | undefined;
  let taken: (() => void) | undefined;
  // the tools a transform takes away
  const removed: string[] = [];
  const ctx = {
    location: { directory: '/repo' },
    session: {
      hook: register('session'),
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: parents[sessionID] })),
      prompt: vi.fn(async () => ({})),
      command: vi.fn(async () => ({})),
      // resolves once the session is idle
      wait: vi.fn(async (_: { sessionID: string }) => {}),
    },
    tool: {
      hook: register('tool'),
      transform: vi.fn(async (edit: (t: { remove: (id: string) => void }) => void) => { edit({ remove: (id) => removed.push(id) }); return { dispose: async () => {} }; }),
    },
    permission: { list: vi.fn(async (_: { sessionID: string }): Promise<unknown[]> => []) },
    command: { list: vi.fn(async () => ({ data: [{ name: 'svall-status' }] })) },
    model: { list: vi.fn(async () => ({ data: [{ ...MODEL, limit: { context: 200_000 } }] })) },
    event: {
      subscribe: vi.fn(({ signal }: { signal: AbortSignal }) => {
        signal.addEventListener('abort', () => pull?.resolve({ done: true, value: undefined }));
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => { taken?.(); taken = undefined; return new Promise<IteratorResult<unknown>>((resolve, reject) => { pull = { resolve, reject }; }); },
            return: async () => ({ done: true, value: undefined }),
          }),
        };
      }),
    },
  };
  const emit = async (type: string, properties: Record<string, unknown>) => {
    await waitFor(() => !!pull);
    await new Promise<void>((r) => { taken = r; const p = pull!; pull = undefined; p.resolve({ done: false, value: { type, data: properties } }); });
  };
  // OpenCode fails the stream when it can't encode an event
  const fail = async () => {
    await waitFor(() => !!pull);
    const p = pull!;
    pull = undefined;
    p.reject(new Error('encode'));
  };
  return { ctx, hooks, emit, fail, removed };
};
const load = async (f = fakeContext()) => ({ ...f, cleanup: await (await import(PLUGIN)).default.setup(f.ctx) });
const prompt = (h: Record<string, Hook>, sessionID: string, text = 'go') => h['session.prompt']({ sessionID, messageID: 'msg_u1', prompt: { text } });
const system = async (h: Record<string, Hook>, sessionID: string) => {
  const e = { sessionID, system: [] as { text: string }[] };
  await h['session.context'](e);
  return e.system.map((s) => s.text);
};
// the plugin shows a question on the card half a second after it changes
const shown = () => new Promise((r) => setTimeout(r, 700));

beforeEach(async () => {
  home = makeHome();
  got = [];
  brief = 'BRIEF';
  vi.stubEnv('SVALL_HOME', home);
  vi.stubEnv('SVALL_ROBOT_ID', 'c_1');
  await listen();
});
afterEach(async () => { await receiver.close(); vi.unstubAllEnvs(); cleanHomes(); });

describe('the OpenCode plugin', () => {
  it('exports a default definition with an id and a setup, as OpenCode 2 requires of a plugin file, each build its own id', async () => {
    const mod = await import(PLUGIN);
    expect(Object.keys(mod)).toEqual(['default']);
    expect(mod.default.id).toBe('svall-dev');
    expect(typeof mod.default.setup).toBe('function');
    const release = path.join(home, 'svall.js');
    fs.copyFileSync(PLUGIN, release);
    expect((await import(release)).default.id).toBe('svall');
  });

  it('does nothing outside a robot, for the other build\'s fleet, or in the shared background service', async () => {
    vi.stubEnv('SVALL_ROBOT_ID', '');
    expect((await load()).hooks).toEqual({});
    vi.stubEnv('SVALL_ROBOT_ID', 'c_1');
    vi.stubEnv('SVALL_HOME', '/u/.svall');
    expect((await load()).hooks).toEqual({});
    vi.stubEnv('SVALL_HOME', home);
    const argv = process.argv;
    process.argv = [...argv, 'serve', '--service'];
    try { expect((await load()).hooks).toEqual({}); } finally { process.argv = argv; }
  });

  it("takes OpenCode's worktree_create from a robot's agent, so its worktrees are made inside the repository", async () => {
    expect((await load()).removed).toEqual(['opencode_worktree_create']);
    vi.stubEnv('SVALL_ROBOT_ID', '');
    expect((await load()).removed).toEqual([]);
  });

  it('still reports turns and gives the brief when OpenCode refuses to take worktree_create away', async () => {
    for (const [transform, why] of [[async () => { throw new Error('no such tool'); }, 'no such tool'], [() => { throw new TypeError('transform is not a function'); }, 'transform is not a function']] as const) {
      got = [];
      const f = fakeContext();
      f.ctx.tool.transform = vi.fn(transform);
      const said = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { hooks: h } = await load(f);
        expect(said.mock.calls.map(([line]) => line)).toEqual([`svall: OpenCode kept opencode_worktree_create for this robot's agent: ${why}\n`]);
        await prompt(h, SID, 'go');
        await waitFor(() => names().includes('UserPromptSubmit'));
        expect(await system(h, SID)).toEqual(['BRIEF']);
      } finally {
        said.mockRestore();
      }
    }
  });

  it('reports a turn, gives the agent its brief, reads its context and logs the session', async () => {
    const { hooks: h, emit } = await load();
    await emit('session.created', { sessionID: SID, model: MODEL });
    await prompt(h, SID, 'fix the flaky test');
    await emit('session.execution.started', { sessionID: SID });
    expect(await system(h, SID)).toEqual(['BRIEF']);
    await h['tool.execute.before']({ tool: 'shell', sessionID: SID, input: { command: 'pnpm test', workdir: '/repo/wt' } });
    await h['tool.execute.after']({ tool: 'shell', sessionID: SID, input: { command: 'pnpm test' }, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } });
    await emit('session.step.started', { sessionID: SID, model: { ...MODEL, variant: 'default' } });
    await emit('session.step.ended', { sessionID: SID, tokens: { input: 19_000, output: 1000, reasoning: 0, cache: { read: 0, write: 0 } } });
    await emit('session.text.ended', { sessionID: SID, text: 'fixed' });
    await emit('session.execution.succeeded', { sessionID: SID });
    await waitFor(() => names().includes('Stop'));
    expect(names()).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'status', 'Stop']);
    const [start, submitted, tool] = got as { hook: Record<string, unknown> }[];
    expect(start.hook).toMatchObject({ backend: 'opencode', pid: process.ppid, sessionId: SID, cwd: '/repo', model: 'big-pickle', transcriptPath: path.join(home, 'transcripts/opencode', `${SID}.jsonl`) });
    expect(submitted.hook).toMatchObject({ prompt: { id: 'msg_u1', text: 'fix the flaky test' }, model: 'big-pickle' });
    expect(tool.hook).toMatchObject({ toolName: 'shell', cwd: '/repo/wt' });
    expect(got[4]).toEqual({ status: { robotId: 'c_1', sessionId: SID, contextPct: 10, model: 'big-pickle' } });
    expect(condenseTurnsOpencode(fs.readFileSync(path.join(home, 'transcripts/opencode', `${SID}.jsonl`), 'utf8'), 10))
      .toBe('USER: fix the flaky test\nAGENT: [tool: shell] fixed');
  });

  it('reports the folder a session moved to, as the instance it left still ends its turn, and not one a subagent moved to', async () => {
    const { hooks: h, emit } = await load(fakeContext({ [CHILD]: SID }));
    await emit('session.created', { sessionID: SID });
    await prompt(h, SID);
    await emit('session.moved', { sessionID: SID, location: { directory: '/repo/.claude/worktrees/x' }, projectID: 'p' });
    await emit('session.moved', { sessionID: CHILD, location: { directory: '/elsewhere' }, projectID: 'p' });
    await emit('session.execution.succeeded', { sessionID: SID });
    await waitFor(() => names().includes('Stop'));
    expect((got.at(-1) as { hook: Record<string, unknown> }).hook).toMatchObject({ name: 'Stop', cwd: '/repo/.claude/worktrees/x' });
  });

  it("reports a shell sent to the background as a monitor, listed at each turn's end until it exits, whichever instance hears what", async () => {
    const { hooks: h, emit } = await load(fakeContext({ [CHILD]: SID }));
    // the instance set up for the folder a session moved to
    const { hooks: moved, emit: emitMoved } = await load(fakeContext({ [CHILD]: SID }));
    const after = (hooks: Record<string, Hook>, sessionID: string, metadata: Record<string, unknown>) =>
      hooks['tool.execute.after']({ tool: 'shell', sessionID, input: { command: 'until [ -f flag ]; do sleep 1; done' }, status: 'completed', result: { content: [], metadata } });
    const turnEnd = async (n: number) => {
      await emit('session.execution.succeeded', { sessionID: SID });
      await waitFor(() => names().filter((x) => x === 'Stop').length === n);
      return (got.at(-1) as { hook: Record<string, unknown> }).hook;
    };
    await emit('session.created', { sessionID: SID });
    await after(moved, SID, { status: 'running', shellID: 'sh_1' });
    await after(h, CHILD, { status: 'running', shellID: 'sh_2' });
    await after(h, SID, { status: 'completed', exit: 0 });
    await waitFor(() => names().filter((x) => x === 'PostToolUse').length === 3);
    expect(got.flatMap((e) => ('hook' in e && e.hook.name === 'PostToolUse' ? [e.hook.monitor] : [])).sort()).toEqual(['sh_1', 'sh_2', undefined]);
    const first = await turnEnd(1);
    expect(first.backgroundTasks).toBe(2);
    expect((first.backgroundShells as string[]).sort()).toEqual(['sh_1', 'sh_2']);
    await emitMoved('shell.exited', { id: 'sh_1', exit: 0, status: 'exited' });
    await emit('shell.deleted', { id: 'sh_2' });
    expect(await turnEnd(2)).toMatchObject({ backgroundTasks: 0, backgroundShells: [] });
  });

  it("lists the shells at the end of a subagent's run too, whose shell wakes it and not the top-level session, and never one that exited first", async () => {
    const { hooks: h, emit } = await load(fakeContext({ [CHILD]: SID }));
    await emit('session.created', { sessionID: SID });
    await emit('session.created', { sessionID: CHILD, parentID: SID });
    await emit('shell.exited', { id: 'sh_3', exit: 1, status: 'exited' });
    for (const [sessionID, shellID] of [[SID, 'sh_3'], [CHILD, 'sh_4']]) {
      await h['tool.execute.after']({ tool: 'shell', sessionID, input: {}, status: 'completed', result: { content: [], metadata: { status: 'running', shellID } } });
    }
    await emit('session.execution.started', { sessionID: CHILD });
    await emit('session.execution.succeeded', { sessionID: CHILD });
    await waitFor(() => names().includes('SubagentStop'));
    expect(got.flatMap((e) => ('hook' in e && e.hook.name === 'PostToolUse' ? [e.hook.monitor] : []))).toEqual([undefined, 'sh_4']);
    expect((got.at(-1) as { hook: Record<string, unknown> }).hook).toMatchObject({ name: 'SubagentStop', backgroundShells: ['sh_4'] });
    await emit('shell.exited', { id: 'sh_4', exit: 0, status: 'exited' });
  });

  it('lists no shell once the event stream has failed, as one may have exited unheard', async () => {
    const { hooks: h, emit, fail } = await load();
    await emit('session.created', { sessionID: SID });
    await h['tool.execute.after']({ tool: 'shell', sessionID: SID, input: {}, status: 'completed', result: { content: [], metadata: { status: 'running', shellID: 'sh_5' } } });
    await prompt(h, SID);
    await fail();
    await waitFor(() => names().includes('Stop'));
    expect((got.at(-1) as { hook: Record<string, unknown> }).hook).toMatchObject({ name: 'Stop', backgroundShells: [] });
  });

  it("reads the models again for one missing from the list, as one from a provider signed in to since", async () => {
    const f = fakeContext();
    f.ctx.model.list.mockResolvedValueOnce({ data: [] });
    const { emit } = await load(f);
    await emit('session.created', { sessionID: SID, model: MODEL });
    const step = () => emit('session.step.ended', { sessionID: SID, tokens: { input: 19_000, output: 1000, reasoning: 0, cache: { read: 0, write: 0 } } });
    await step();
    await step();
    await waitFor(() => names().includes('status'));
    expect(f.ctx.model.list).toHaveBeenCalledTimes(2);
  });

  it('starts a resumed session from its -s, brief in hand before the first request, and submits the prompt left for it', async () => {
    fs.writeFileSync(path.join(home, 'c_1.prompt'), 'wake up');
    const argv = process.argv;
    process.argv = [...argv, '-s', SID];
    try {
      const { ctx, hooks: h } = await load();
      await waitFor(() => ctx.session.prompt.mock.calls.length === 1);
      expect(ctx.session.prompt).toHaveBeenCalledWith({ sessionID: SID, text: 'wake up' });
      expect(fs.existsSync(path.join(home, 'c_1.prompt'))).toBe(false);
      expect(await system(h, SID)).toEqual(['BRIEF']);
      expect(names()).toEqual(['SessionStart']);
    } finally {
      process.argv = argv;
    }
  });

  it("reads -s off the TUI's command line, as the plugin runs in its private server", async () => {
    fs.writeFileSync(path.join(home, 'c_1.prompt'), 'wake up');
    const child = `setTimeout(() => process.exit(1), 4000);
      const { default: plugin } = await import(${JSON.stringify(PLUGIN)});
      const on = { hook: async () => {} };
      await plugin.setup({ location: { directory: '/repo' }, tool: { ...on, transform: async () => ({}) }, event: { subscribe: () => [] },
        session: { ...on, get: async () => ({}), prompt: async (o) => { console.log(JSON.stringify(o)); process.exit(0); } } });`;
    // the TUI starts its server as a child, which takes none of its arguments
    const tui = `const c = require('node:child_process').spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(child)}], { stdio: 'inherit' });
      c.on('exit', (code) => process.exit(code));`;
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', tui, '--', '--standalone', '-s', SID], { env: process.env });
    expect(JSON.parse(stdout)).toEqual({ sessionID: SID, text: 'wake up' });
    expect(names()).toEqual(['SessionStart']);
  });

  it('runs a /command left for it as that command, as the TUI does with one typed', async () => {
    fs.writeFileSync(path.join(home, 'c_1.prompt'), '/svall-status now');
    const argv = process.argv;
    process.argv = [...argv, '-s', SID];
    try {
      const { ctx } = await load();
      await waitFor(() => ctx.session.command.mock.calls.length === 1);
      expect(ctx.session.command).toHaveBeenCalledWith({ sessionID: SID, name: 'svall-status', text: 'now' });
      expect(ctx.session.prompt).not.toHaveBeenCalled();
    } finally {
      process.argv = argv;
    }
  });

  it('takes -s only for a session id ahead of the prompt', async () => {
    const argv = process.argv;
    process.argv = [...argv, '--prompt', 'run', 'ls', '-s', '../x'];
    try {
      await load();
      await new Promise((r) => setTimeout(r, 100));
      expect(names()).toEqual([]);
      expect(fs.existsSync(path.join(home, 'transcripts', 'x.jsonl'))).toBe(false);
    } finally {
      process.argv = argv;
    }
  });

  it('reads a resumed session given as --session=<id>', async () => {
    fs.writeFileSync(path.join(home, 'c_1.prompt'), 'wake up');
    const argv = process.argv;
    process.argv = [...argv, `--session=${SID}`];
    try {
      const { ctx } = await load();
      await waitFor(() => ctx.session.prompt.mock.calls.length === 1);
      expect(names()).toEqual(['SessionStart']);
    } finally {
      process.argv = argv;
    }
  });

  it("shows the question OpenCode's TUI shows, and keeps the robot blocked while one is open", async () => {
    const OTHER = 'ses_0f3a5b7c9d20AbCdEfGhIjKlMn';
    const { hooks: h, emit } = await load(fakeContext({ [CHILD]: SID, [OTHER]: SID }));
    await emit('session.created', { sessionID: SID });
    // the TUI shows permissions before questions, an older session's first
    await emit('form.created', { form: { id: 'frm_1', sessionID: OTHER, title: 'Questions', metadata: { kind: 'question' }, fields: [{ key: 'q0', type: 'string', title: 'File', description: 'which file?' }] } });
    await emit('permission.asked', { id: 'per_2', sessionID: OTHER, action: 'shell', resources: ['ls'] });
    await emit('permission.asked', { id: 'per_1', sessionID: CHILD, action: 'external_directory', resources: ['/etc/*'] });
    await shown();
    await h['tool.execute.before']({ tool: 'grep', sessionID: OTHER, input: {} });
    await h['tool.execute.after']({ tool: 'grep', sessionID: OTHER, input: {}, status: 'completed', result: { content: [] } });
    await emit('permission.replied', { sessionID: CHILD, requestID: 'per_1', reply: 'once' });
    await shown();
    await emit('permission.replied', { sessionID: OTHER, requestID: 'per_2', reply: 'once' });
    await shown();
    await emit('form.cancelled', { id: 'frm_1', sessionID: OTHER });
    await waitFor(() => names().length >= 5);
    expect(names()).toEqual(['SessionStart', 'PermissionRequest', 'PermissionRequest', 'PermissionRequest', 'PreToolUse']);
    expect(got.slice(1, 4).map((e) => (e as { hook: { sessionId: string; message: string } }).hook))
      .toMatchObject([{ sessionId: SID, message: '/etc/*', toolName: 'external_directory' }, { sessionId: SID, message: 'ls' }, { sessionId: SID, message: 'which file?' }]);
  });

  it('leaves the robot working through a question OpenCode answers at once, as with --auto, and a refusal that answers several', async () => {
    const { emit } = await load();
    await emit('session.created', { sessionID: SID });
    await emit('permission.asked', { id: 'per_1', sessionID: SID, action: 'external_directory', resources: ['/etc/*'] });
    await emit('permission.replied', { sessionID: SID, requestID: 'per_1', reply: 'once' });
    await emit('permission.asked', { id: 'per_2', sessionID: SID, action: 'shell', resources: ['ls'] });
    await emit('permission.asked', { id: 'per_3', sessionID: SID, action: 'shell', resources: ['pwd'] });
    await shown();
    // a refusal turns down the session's other questions too, each with a reply of its own
    await emit('permission.replied', { sessionID: SID, requestID: 'per_2', reply: 'reject' });
    await emit('permission.replied', { sessionID: SID, requestID: 'per_3', reply: 'reject' });
    await waitFor(() => names().length >= 3);
    await shown();
    expect(names()).toEqual(['SessionStart', 'PermissionRequest', 'PreToolUse']);
  });

  it('blocks the robot on the web search picker until it is answered', async () => {
    const { emit } = await load();
    await emit('session.created', { sessionID: SID });
    await emit('form.created', { form: { id: 'frm_1', sessionID: SID, title: 'Web Search', metadata: { kind: 'websearch.provider' }, fields: [{ key: 'choice', type: 'string', description: 'Allow OpenCode to search the web?' }] } });
    await shown();
    await emit('form.replied', { id: 'frm_1', sessionID: SID, answer: { choice: 'allow' } });
    await waitFor(() => names().length >= 3);
    expect(names()).toEqual(['SessionStart', 'PermissionRequest', 'PreToolUse']);
    expect((got[1] as { hook: { message: string } }).hook.message).toBe('Allow OpenCode to search the web?');
  });

  it("blocks the robot on an MCP server's form, which names no session, under the session running a turn, else the last one started", async () => {
    const OTHER = 'ses_0f3a5b7c9d20AbCdEfGhIjKlMn';
    const { hooks: h, emit } = await load();
    const form = (id: string) => emit('form.created', { form: { id, sessionID: 'global', title: 'github is requesting input', metadata: { kind: 'mcp-elicitation', server: 'github', message: 'Which repository?' }, fields: [{ key: 'repo', type: 'string', title: 'Repository' }] } });
    await emit('session.created', { sessionID: SID });
    await emit('session.created', { sessionID: OTHER });
    await prompt(h, SID);
    await emit('session.execution.started', { sessionID: SID });
    await form('frm_1');
    await shown();
    expect(card()).toMatchObject({ sessionId: SID, status: 'blocked', prompt: 'Which repository?' });
    await emit('form.replied', { id: 'frm_1', sessionID: 'global', answer: { repo: 'svall' } });
    await shown();
    await emit('session.execution.succeeded', { sessionID: SID });
    await form('frm_2');
    await shown();
    await emit('form.cancelled', { id: 'frm_2', sessionID: 'global' });
    await shown();
    expect(names()).toEqual(['SessionStart', 'SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PreToolUse', 'Stop', 'PermissionRequest', 'PreToolUse']);
    expect(got.flatMap((e) => ('hook' in e && e.hook.name === 'PermissionRequest' ? [e.hook.sessionId] : []))).toEqual([SID, OTHER]);
  });

  it("lets a subagent's questions block the robot, under the top-level session, and nothing else of its turn", async () => {
    const { hooks: h, emit } = await load(fakeContext({ [CHILD]: SID }));
    await emit('session.created', { sessionID: SID });
    await emit('session.created', { sessionID: CHILD, parentID: SID });
    await prompt(h, CHILD, 'explore');
    await emit('session.execution.started', { sessionID: CHILD });
    await emit('permission.asked', { id: 'per_1', sessionID: CHILD, action: 'shell', resources: ['rm -rf build'] });
    await shown();
    await emit('permission.replied', { sessionID: CHILD, requestID: 'per_1', reply: 'once' });
    await emit('session.execution.succeeded', { sessionID: CHILD });
    await waitFor(() => names().length >= 5);
    await new Promise((r) => setTimeout(r, 100));
    expect(names()).toEqual(['SessionStart', 'SubagentStart', 'PermissionRequest', 'SubagentStop', 'PreToolUse']);
    expect((got[2] as { hook: Record<string, unknown> }).hook).toMatchObject({ sessionId: SID, message: 'rm -rf build', toolName: 'shell' });
  });

  it("reports each run of a child session as its subagent's, under the top-level session, however it ends", async () => {
    const { emit } = await load(fakeContext({ [CHILD]: SID }));
    await emit('session.created', { sessionID: SID });
    await emit('session.created', { sessionID: CHILD, parentID: SID, agent: 'explore' });
    for (const end of ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted']) {
      await emit('session.execution.started', { sessionID: CHILD });
      await emit(end, { sessionID: CHILD });
    }
    // the parent's own runs are its turns
    await emit('session.execution.started', { sessionID: SID });
    await waitFor(() => names().length >= 8);
    await new Promise((r) => setTimeout(r, 100));
    expect(names()).toEqual(['SessionStart', 'SubagentStart', 'SubagentStop', 'SubagentStart', 'SubagentStop', 'SubagentStart', 'SubagentStop', 'PreToolUse']);
    for (const e of got.slice(1, -1)) expect((e as { hook: Record<string, unknown> }).hook).toMatchObject({ sessionId: SID, agentId: CHILD });
  });

  it("drops a subagent's open question when its run ends or its session is deleted, which OpenCode answers with nothing", async () => {
    const { hooks: h, emit } = await load(fakeContext({ [CHILD]: SID }));
    await emit('session.created', { sessionID: SID });
    await emit('session.created', { sessionID: CHILD, parentID: SID });
    await prompt(h, SID);
    await emit('permission.asked', { id: 'per_1', sessionID: CHILD, action: 'shell', resources: ['ls'] });
    await shown();
    await emit('session.execution.interrupted', { sessionID: CHILD, reason: 'user' });
    await shown();
    await emit('form.created', { form: { id: 'frm_1', sessionID: CHILD, metadata: { kind: 'question' }, fields: [{ description: 'which file?' }] } });
    await shown();
    await emit('session.deleted', { sessionID: CHILD });
    await waitFor(() => names().length >= 7);
    expect(names()).toEqual(['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'SubagentStop', 'PreToolUse', 'PermissionRequest', 'PreToolUse']);
  });

  it("keeps a background subagent's question up when its parent's turn ends, and drops only the parent's own", async () => {
    const { hooks: h, emit } = await load(fakeContext({ [CHILD]: SID }));
    await emit('session.created', { sessionID: SID });
    await emit('session.created', { sessionID: CHILD, parentID: SID });
    await prompt(h, SID);
    await emit('permission.asked', { id: 'per_1', sessionID: SID, action: 'external_directory', resources: ['/etc/*'] });
    await shown();
    await emit('session.execution.interrupted', { sessionID: SID, reason: 'user' });
    await shown();
    expect(card()).toMatchObject({ status: 'idle' });
    await prompt(h, SID);
    await emit('session.execution.started', { sessionID: SID });
    await emit('session.execution.started', { sessionID: CHILD });
    await emit('permission.asked', { id: 'per_2', sessionID: CHILD, action: 'shell', resources: ['rm -rf build'] });
    await shown();
    await emit('session.execution.succeeded', { sessionID: SID });
    await shown();
    expect(names()).toEqual(['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Interrupt', 'UserPromptSubmit', 'SubagentStart', 'PermissionRequest', 'Stop', 'PermissionRequest']);
    expect(card()).toMatchObject({ status: 'blocked', prompt: 'rm -rf build' });
  });

  it("lists a subagent still running at its parent's turn end, so the robot works on until it is done", async () => {
    const { hooks: h, emit } = await load(fakeContext({ [CHILD]: SID }));
    await emit('session.created', { sessionID: SID });
    await emit('session.created', { sessionID: CHILD, parentID: SID });
    await prompt(h, SID);
    await emit('session.execution.started', { sessionID: SID });
    await emit('session.execution.started', { sessionID: CHILD });
    await emit('session.execution.succeeded', { sessionID: SID });
    await waitFor(() => names().includes('Stop'));
    expect((got.at(-1) as { hook: Record<string, unknown> }).hook).toMatchObject({ name: 'Stop', backgroundTasks: 1, backgroundAgentIds: [CHILD] });
    expect(card()).toMatchObject({ status: 'working', background: true });
    await emit('session.execution.succeeded', { sessionID: CHILD });
    // the subagent's end wakes its parent
    await emit('session.execution.started', { sessionID: SID });
    await emit('session.execution.succeeded', { sessionID: SID });
    await waitFor(() => names().filter((x) => x === 'Stop').length === 2);
    expect((got.at(-1) as { hook: Record<string, unknown> }).hook).toMatchObject({ name: 'Stop', backgroundTasks: 0 });
    expect(card()).toMatchObject({ status: 'done' });
  });

  it('lets go of a subagent whose run ended while the event stream was down', async () => {
    const OTHER = 'ses_0f3a5b7c9d20AbCdEfGhIjKlMn';
    const f = fakeContext({ [CHILD]: SID, [OTHER]: SID });
    f.ctx.session.wait.mockImplementation(({ sessionID }) => (sessionID === OTHER ? new Promise<void>(() => {}) : Promise.resolve()));
    const { hooks: h, emit, fail } = await load(f);
    await emit('session.created', { sessionID: SID });
    await prompt(h, SID);
    await emit('session.execution.started', { sessionID: CHILD });
    await emit('session.execution.started', { sessionID: OTHER });
    await fail();
    await waitFor(() => names().includes('Stop'));
    expect((got.at(-1) as { hook: Record<string, unknown> }).hook).toMatchObject({ name: 'Stop', backgroundTasks: 1, backgroundAgentIds: [OTHER] });
  });

  it('reports a run OpenCode starts by itself, as when a background shell exits, which passes no prompt', async () => {
    const { hooks: h, emit, fail } = await load();
    await emit('session.created', { sessionID: SID });
    await prompt(h, SID, 'watch the build');
    await emit('session.execution.started', { sessionID: SID });
    await emit('session.execution.succeeded', { sessionID: SID });
    await emit('session.execution.started', { sessionID: SID });
    await shown();
    expect(names()).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'PreToolUse']);
    expect(card()).toMatchObject({ status: 'working', lastPrompt: { text: 'watch the build' } });
    // it is a turn like a prompted one, which a resync ends
    await fail();
    await waitFor(() => names().length === 5);
    expect(names().at(-1)).toBe('Stop');
    expect(card()).toMatchObject({ status: 'done' });
  });

  it('holds the brief each prompt is answered with, an empty one included, and keeps it through a lost answer', async () => {
    const { hooks: h, emit } = await load();
    await emit('session.created', { sessionID: SID });
    await receiver.close();
    await prompt(h, SID);
    expect(await system(h, SID)).toEqual(['BRIEF']);
    await listen();
    brief = '';
    // a line sent as the old connection closes is lost with it; a later one lands
    await waitFor(async () => { await prompt(h, SID); return names().includes('UserPromptSubmit'); });
    expect(await system(h, SID)).toEqual([]);
  });

  it('ends a turn an Esc or a refusal stopped with Interrupt, and one an error stopped with StopFailure', async () => {
    const { hooks: h, emit } = await load();
    const turn = async (type: string, fields: Record<string, unknown> = {}) => {
      await prompt(h, SID);
      await emit('session.execution.started', { sessionID: SID });
      await emit(type, { sessionID: SID, ...fields });
    };
    await turn('session.execution.interrupted', { reason: 'user' });
    await turn('session.execution.failed', { error: { type: 'provider.auth', message: 'not available in your country' } });
    // a refused permission interrupts with no reason given, which OpenCode reports as shutdown
    await turn('session.execution.interrupted', { reason: 'shutdown' });
    await waitFor(() => names().length === 7);
    expect(names()).toEqual(['SessionStart', 'UserPromptSubmit', 'Interrupt', 'UserPromptSubmit', 'StopFailure', 'UserPromptSubmit', 'Interrupt']);
    expect((got[4] as { hook: Record<string, unknown> }).hook).toMatchObject({ message: 'not available in your country' });
  });

  it('picks up a turn under way that it never saw start, as after OpenCode reloads it, brief and all', async () => {
    const { hooks: h, emit } = await load();
    expect(await system(h, SID)).toEqual(['BRIEF']);
    await emit('session.execution.succeeded', { sessionID: SID });
    await waitFor(() => names().includes('Stop'));
    expect(names()).toEqual(['SessionStart', 'Stop']);
  });

  it('reaches a daemon that restarted, on the next event', async () => {
    const { hooks: h, emit } = await load();
    await emit('session.created', { sessionID: SID });
    await waitFor(() => names().length === 1);
    await receiver.close();
    await listen();
    // an event sent before the plugin sees the old connection close is lost with it; a later one lands
    await waitFor(async () => {
      await h['tool.execute.before']({ tool: 'read', sessionID: SID, input: {} });
      return names().includes('PreToolUse');
    });
  });

  it('starts the connection over when an answer never comes, so later answers pair with their own lines', async () => {
    await receiver.close();
    // the first connection answers nothing, as svalld does a line it refuses; later ones answer every line
    let conns = 0;
    const server = net.createServer((c) => {
      const answers = ++conns > 1;
      c.setEncoding('utf8');
      c.on('data', (d: string) => { if (answers) for (const _ of d.trim().split('\n')) c.write('{"additionalContext":"BRIEF"}\n'); });
    });
    await new Promise<void>((r) => server.listen(path.join(home, 'hooks.sock'), r));
    try {
      const { hooks: h, emit } = await load();
      const OTHER = 'ses_0f3a5b7c9d20AbCdEfGhIjKlMn';
      await emit('session.created', { sessionID: SID });
      await emit('session.created', { sessionID: OTHER });
      expect(await system(h, OTHER)).toEqual(['BRIEF']);
    } finally {
      server.close();
      await listen();
    }
  });

  it("hears what follows when OpenCode fails its event stream, and ends the turn that ended meanwhile", async () => {
    const { ctx, hooks: h, emit, fail } = await load();
    await emit('session.created', { sessionID: SID });
    await prompt(h, SID);
    await fail();
    await waitFor(() => names().includes('Stop'));
    expect(ctx.event.subscribe).toHaveBeenCalledTimes(2);
    expect(ctx.session.wait).toHaveBeenCalledWith({ sessionID: SID });
    await prompt(h, SID);
    await emit('session.execution.succeeded', { sessionID: SID });
    await waitFor(() => names().length >= 5);
    expect(names()).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'UserPromptSubmit', 'Stop']);
  });

  it('reads back the permissions asked and answered while the stream was down, and leaves a running turn to the stream', async () => {
    const f = fakeContext({ [CHILD]: SID });
    let idle = () => {};
    f.ctx.session.wait.mockImplementation(() => new Promise<void>((r) => { idle = r; }));
    const { hooks: h, emit, fail } = await load(f);
    await emit('session.created', { sessionID: SID });
    await emit('session.created', { sessionID: CHILD, parentID: SID });
    await prompt(h, SID);
    await emit('permission.asked', { id: 'per_1', sessionID: SID, action: 'shell', resources: ['ls'] });
    await shown();
    // meanwhile per_1 was answered and the subagent asked another
    f.ctx.permission.list.mockImplementation(async ({ sessionID }) => (sessionID === CHILD ? [{ id: 'per_2', sessionID: CHILD, action: 'shell', resources: ['rm -rf build'] }] : []));
    await fail();
    await waitFor(() => names().length >= 4);
    // OpenCode may say the session is idle before the stream says the turn ended
    idle();
    await emit('session.execution.succeeded', { sessionID: SID });
    await waitFor(() => names().includes('Stop'));
    await shown();
    expect(names()).toEqual(['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PermissionRequest', 'Stop', 'PermissionRequest']);
    expect((got[3] as { hook: Record<string, unknown> }).hook).toMatchObject({ sessionId: SID, message: 'rm -rf build' });
  });

  it('leaves a turn prompted during a resync running, though the session read idle before it', async () => {
    const f = fakeContext();
    const { hooks: h, emit, fail } = await load(f);
    await emit('session.created', { sessionID: SID });
    await prompt(h, SID);
    await fail();
    await waitFor(() => f.ctx.session.wait.mock.calls.length === 1);
    await prompt(h, SID, 'next');
    await shown();
    expect(names()).toEqual(['SessionStart', 'UserPromptSubmit', 'UserPromptSubmit']);
  });

  it("doesn't let the permission list a resync reads undo what the stream said meanwhile", async () => {
    const f = fakeContext();
    f.ctx.session.wait.mockImplementation(() => new Promise<void>(() => {}));
    const { hooks: h, emit, fail } = await load(f);
    await emit('session.created', { sessionID: SID });
    await prompt(h, SID);
    await emit('permission.asked', { id: 'per_1', sessionID: SID, action: 'shell', resources: ['ls'] });
    await shown();
    let answer = (_: unknown[]) => {};
    f.ctx.permission.list.mockImplementation(() => new Promise((r) => { answer = r; }));
    await fail();
    await waitFor(() => f.ctx.permission.list.mock.calls.length === 1);
    // per_1 answered and per_2 asked after the list was read
    await emit('permission.replied', { sessionID: SID, requestID: 'per_1', reply: 'once' });
    await emit('permission.asked', { id: 'per_2', sessionID: SID, action: 'shell', resources: ['pwd'] });
    answer([{ id: 'per_1', sessionID: SID, action: 'shell', resources: ['ls'] }]);
    await shown();
    expect(names()).toEqual(['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PermissionRequest']);
    expect((got[3] as { hook: Record<string, unknown> }).hook).toMatchObject({ message: 'pwd' });
  });

  it('says nothing once unloaded during a resync', async () => {
    const f = fakeContext();
    const { hooks: h, emit, fail, cleanup } = await load(f);
    await emit('session.created', { sessionID: SID });
    await prompt(h, SID);
    let answer = (_: unknown[]) => {};
    f.ctx.permission.list.mockImplementation(() => new Promise((r) => { answer = r; }));
    await fail();
    await waitFor(() => f.ctx.permission.list.mock.calls.length === 1);
    cleanup();
    answer([{ id: 'per_1', sessionID: SID, action: 'shell', resources: ['ls'] }]);
    await shown();
    expect(names()).toEqual(['SessionStart', 'UserPromptSubmit']);
  });

  it('subscribes again a second after a failure, and twice as long after one that heard nothing', async () => {
    const f = fakeContext();
    const { emit, fail } = await load(f);
    const resubscribed = async (n: number) => {
      const t = Date.now();
      await waitFor(() => f.ctx.event.subscribe.mock.calls.length === n);
      return Date.now() - t;
    };
    await fail();
    expect(await resubscribed(2)).toBeLessThan(1500);
    await fail();
    expect(await resubscribed(3)).toBeGreaterThan(1500);
    await emit('session.created', { sessionID: SID });
    await fail();
    expect(await resubscribed(4)).toBeLessThan(1500);
  }, 10_000);

  it('says nothing when OpenCode unloads the plugin, nor subscribes again', async () => {
    const { ctx, emit, cleanup } = await load();
    await emit('session.created', { sessionID: SID });
    cleanup();
    await new Promise((r) => setTimeout(r, 1200));
    expect(names()).toEqual(['SessionStart']);
    expect(ctx.event.subscribe).toHaveBeenCalledTimes(1);
  });
});
