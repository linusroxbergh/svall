import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { condenseTurnsOpencode } from '../src/agent/opencode-transcript.js';
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

type Hook = (e: Record<string, unknown>) => Promise<void> | void;
// the plugin context OpenCode hands setup: its hooks are kept by name, and emit resolves once the plugin has taken the event
const fakeContext = (parents: Record<string, string> = {}) => {
  const hooks: Record<string, Hook> = {};
  const register = (domain: string) => vi.fn(async (name: string, cb: Hook) => { hooks[`${domain}.${name}`] = cb; return { dispose: async () => {} }; });
  let pull: ((r: IteratorResult<unknown>) => void) | undefined;
  let taken: (() => void) | undefined;
  const ctx = {
    location: { directory: '/repo' },
    session: {
      hook: register('session'),
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: parents[sessionID] })),
      prompt: vi.fn(async () => ({})),
      command: vi.fn(async () => ({})),
    },
    tool: { hook: register('tool') },
    command: { list: vi.fn(async () => ({ data: [{ name: 'svall-status' }] })) },
    model: { list: vi.fn(async () => ({ data: [{ ...MODEL, limit: { context: 200_000 } }] })) },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => { taken?.(); taken = undefined; return new Promise<IteratorResult<unknown>>((r) => { pull = r; }); },
          return: async () => ({ done: true, value: undefined }),
        }),
      }),
    },
  };
  const emit = async (type: string, properties: Record<string, unknown>) => {
    await waitFor(() => !!pull);
    await new Promise<void>((r) => { taken = r; const p = pull!; pull = undefined; p({ done: false, value: { type, data: properties } }); });
  };
  return { ctx, hooks, emit };
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
  vi.stubEnv('SVALL_CHAR_ID', 'c_1');
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

  it('does nothing outside a character, for the other build\'s fleet, or in the shared background service', async () => {
    vi.stubEnv('SVALL_CHAR_ID', '');
    expect((await load()).hooks).toEqual({});
    vi.stubEnv('SVALL_CHAR_ID', 'c_1');
    vi.stubEnv('SVALL_HOME', '/u/.svall');
    expect((await load()).hooks).toEqual({});
    vi.stubEnv('SVALL_HOME', home);
    const argv = process.argv;
    process.argv = [...argv, 'serve', '--service'];
    try { expect((await load()).hooks).toEqual({}); } finally { process.argv = argv; }
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
    expect(got[4]).toEqual({ status: { charId: 'c_1', sessionId: SID, contextPct: 10, model: 'big-pickle' } });
    expect(condenseTurnsOpencode(fs.readFileSync(path.join(home, 'transcripts/opencode', `${SID}.jsonl`), 'utf8'), 10))
      .toBe('USER: fix the flaky test\nAGENT: [tool: shell] fixed');
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
      await plugin.setup({ location: { directory: '/repo' }, tool: on, event: { subscribe: () => [] },
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

  it("shows the question OpenCode's TUI shows, and keeps the character blocked while one is open", async () => {
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

  it('leaves the character working through a question OpenCode answers at once, as with --auto, and a refusal that answers several', async () => {
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

  it("lets a subagent's questions block the character, under the top-level session, and nothing else of it", async () => {
    const { hooks: h, emit } = await load(fakeContext({ [CHILD]: SID }));
    await emit('session.created', { sessionID: SID });
    await emit('session.created', { sessionID: CHILD, parentID: SID });
    await prompt(h, CHILD, 'explore');
    await emit('session.execution.started', { sessionID: CHILD });
    await emit('permission.asked', { id: 'per_1', sessionID: CHILD, action: 'shell', resources: ['rm -rf build'] });
    await shown();
    await emit('permission.replied', { sessionID: CHILD, requestID: 'per_1', reply: 'once' });
    await emit('session.execution.succeeded', { sessionID: CHILD });
    await waitFor(() => names().length >= 3);
    await new Promise((r) => setTimeout(r, 100));
    expect(names()).toEqual(['SessionStart', 'PermissionRequest', 'PreToolUse']);
    expect((got[1] as { hook: Record<string, unknown> }).hook).toMatchObject({ sessionId: SID, message: 'rm -rf build', toolName: 'shell' });
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

  it('says nothing when OpenCode unloads the plugin', async () => {
    const { emit, cleanup } = await load();
    await emit('session.created', { sessionID: SID });
    cleanup();
    await new Promise((r) => setTimeout(r, 100));
    expect(names()).toEqual(['SessionStart']);
  });
});
