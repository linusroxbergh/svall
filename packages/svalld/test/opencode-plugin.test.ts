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

let home: string;
let got: SocketEvent[];
let receiver: { close(): Promise<void> };
const listen = async () => {
  receiver = await startHookReceiver(path.join(home, 'hooks.sock'), (e) => {
    got.push(e);
    if (!('hook' in e)) return undefined;
    return e.hook.name === 'SessionStart' ? 'BRIEF' : undefined;
  }, silentLogger);
};
const names = () => got.flatMap((e) => ('hook' in e ? [e.hook.name] : ['status']));
const client = (parents: Record<string, string> = {}) => ({
  session: {
    get: vi.fn(async ({ path: p }: { path: { id: string } }) => ({ data: { id: p.id, parentID: parents[p.id] } })),
    promptAsync: vi.fn(async () => ({})),
  },
});
const load = async (c = client()) => (await import(PLUGIN)).SvallPlugin({ client: c, directory: '/repo' });
const event = (type: string, properties: Record<string, unknown>) => ({ event: { id: 'e', type, properties } });

beforeEach(async () => {
  home = makeHome();
  got = [];
  vi.stubEnv('SVALL_HOME', home);
  vi.stubEnv('SVALL_CHAR_ID', 'c_1');
  await listen();
});
afterEach(async () => { await receiver.close(); vi.unstubAllEnvs(); cleanHomes(); });

describe('the OpenCode plugin', () => {
  it('exports one function, as OpenCode requires of a plugin file', async () => {
    const mod = await import(PLUGIN);
    expect(Object.keys(mod)).toEqual(['SvallPlugin']);
    expect(typeof mod.SvallPlugin).toBe('function');
  });

  it('does nothing outside a character, or for the other build\'s fleet', async () => {
    vi.stubEnv('SVALL_CHAR_ID', '');
    expect(await load()).toEqual({});
    vi.stubEnv('SVALL_CHAR_ID', 'c_1');
    vi.stubEnv('SVALL_HOME', '/u/.svall');
    expect(await load()).toEqual({});
  });

  it('reports a turn, gives the agent its brief, reads its context and logs the session', async () => {
    const h = await load();
    await h.event(event('session.created', { sessionID: SID, info: { id: SID, directory: '/repo' } }));
    await h['chat.message']({ sessionID: SID, messageID: 'msg_u1', model: { providerID: 'opencode', modelID: 'big-pickle' } },
      { message: { id: 'msg_u1' }, parts: [{ type: 'text', text: 'fix the flaky test' }] });
    const system: string[] = [];
    await h['experimental.chat.system.transform']({ sessionID: SID, model: { limit: { context: 200_000 } } }, { system });
    expect(system).toEqual(['BRIEF']);
    await h['tool.execute.before']({ tool: 'bash', sessionID: SID, callID: 'c1' }, { args: { command: 'pnpm test', workdir: '/repo/wt' } });
    await h['tool.execute.after']({ tool: 'bash', sessionID: SID, callID: 'c1', args: { command: 'pnpm test' } }, { title: '', output: 'ok', metadata: {} });
    await h.event(event('message.updated', { sessionID: SID, info: { id: 'msg_a1', sessionID: SID, role: 'assistant', modelID: 'big-pickle', tokens: { input: 19_000, output: 1000, reasoning: 0, cache: { read: 0, write: 0 } } } }));
    await h.event(event('message.part.updated', { part: { id: 'prt_1', sessionID: SID, messageID: 'msg_a1', type: 'text', text: 'fixed', time: { start: 1, end: 2 } } }));
    await h.event(event('session.status', { sessionID: SID, status: { type: 'idle' } }));
    await waitFor(() => names().includes('Stop'));
    expect(names()).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'status', 'Stop']);
    const [start, prompt, tool] = got as { hook: Record<string, unknown> }[];
    expect(start.hook).toMatchObject({ backend: 'opencode', sessionId: SID, cwd: '/repo', transcriptPath: path.join(home, 'transcripts/opencode', `${SID}.jsonl`) });
    expect(prompt.hook).toMatchObject({ prompt: { id: 'msg_u1', text: 'fix the flaky test' }, model: 'big-pickle' });
    expect(tool.hook).toMatchObject({ toolName: 'bash', cwd: '/repo/wt' });
    expect(got[4]).toEqual({ status: { charId: 'c_1', sessionId: SID, contextPct: 10, model: 'big-pickle' } });
    expect(condenseTurnsOpencode(fs.readFileSync(path.join(home, 'transcripts/opencode', `${SID}.jsonl`), 'utf8'), 10))
      .toBe('USER: fix the flaky test\nAGENT: [tool: bash] fixed');
  });

  it('starts a resumed session from its -s, brief in hand before the first request, and submits the prompt left for it', async () => {
    fs.writeFileSync(path.join(home, 'c_1.prompt'), 'wake up');
    const argv = process.argv;
    process.argv = [...argv, '-s', SID];
    const c = client();
    try {
      const h = await load(c);
      await waitFor(() => c.session.promptAsync.mock.calls.length === 1);
      expect(c.session.promptAsync).toHaveBeenCalledWith({ path: { id: SID }, body: { parts: [{ type: 'text', text: 'wake up' }] } });
      expect(fs.existsSync(path.join(home, 'c_1.prompt'))).toBe(false);
      const system: string[] = [];
      await h['experimental.chat.system.transform']({ sessionID: SID, model: { limit: { context: 1 } } }, { system });
      expect(system).toEqual(['BRIEF']);
      expect(names()).toEqual(['SessionStart']);
    } finally {
      process.argv = argv;
    }
  });

  it("reads -s off the command line ps prints, as OpenCode's worker has an argv of its own", async () => {
    fs.writeFileSync(path.join(home, 'c_1.prompt'), 'wake up');
    const script = `process.argv = process.argv.slice(0, 1);
      setTimeout(() => process.exit(1), 4000);
      const { SvallPlugin } = await import(${JSON.stringify(PLUGIN)});
      await SvallPlugin({ directory: '/repo', client: { session: {
        get: async () => ({ data: {} }), promptAsync: async (o) => { console.log(JSON.stringify(o)); process.exit(0); } } } });`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, '--', '-s', SID], { env: process.env });
    expect(JSON.parse(stdout)).toEqual({ path: { id: SID }, body: { parts: [{ type: 'text', text: 'wake up' }] } });
    expect(names()).toEqual(['SessionStart']);
  });

  it("lets a subagent's questions block the character, under the top-level session, and nothing else of it", async () => {
    const h = await load(client({ [CHILD]: SID }));
    await h.event(event('session.created', { sessionID: SID, info: { id: SID } }));
    await h.event(event('session.created', { sessionID: CHILD, info: { id: CHILD, parentID: SID } }));
    await h['chat.message']({ sessionID: CHILD }, { message: { id: 'm' }, parts: [{ type: 'text', text: 'explore' }] });
    await h.event(event('permission.asked', { id: 'per_1', sessionID: CHILD, permission: 'bash', patterns: ['rm -rf build'], metadata: { command: 'rm -rf build' } }));
    await h.event(event('permission.replied', { sessionID: CHILD, requestID: 'per_1', reply: 'once' }));
    await h.event(event('session.status', { sessionID: CHILD, status: { type: 'idle' } }));
    await waitFor(() => names().length >= 3);
    await new Promise((r) => setTimeout(r, 100));
    expect(names()).toEqual(['SessionStart', 'PermissionRequest', 'PreToolUse']);
    expect((got[1] as { hook: Record<string, unknown> }).hook).toMatchObject({ sessionId: SID, message: 'rm -rf build', toolName: 'bash' });
  });

  it('ends a turn an Esc stopped with Interrupt, and one an error stopped with StopFailure', async () => {
    const h = await load();
    const turn = async (error: unknown) => {
      await h['chat.message']({ sessionID: SID }, { message: { id: 'm' }, parts: [{ type: 'text', text: 'go' }] });
      await h.event(event('session.error', { sessionID: SID, error }));
      await h.event(event('session.status', { sessionID: SID, status: { type: 'idle' } }));
    };
    await turn({ name: 'MessageAbortedError', data: { message: 'aborted' } });
    await turn({ name: 'APIError', data: { message: 'overloaded' } });
    await waitFor(() => names().includes('StopFailure'));
    expect(names()).toEqual(['SessionStart', 'UserPromptSubmit', 'Interrupt', 'UserPromptSubmit', 'StopFailure']);
    expect((got[4] as { hook: Record<string, unknown> }).hook).toMatchObject({ message: 'overloaded' });
  });

  it('reaches a daemon that restarted, on the next event', async () => {
    const h = await load();
    await h.event(event('session.created', { sessionID: SID, info: { id: SID } }));
    await waitFor(() => names().length === 1);
    await receiver.close();
    await listen();
    // an event sent before the plugin sees the old connection close is lost with it; a later one lands
    await waitFor(async () => {
      await h['tool.execute.before']({ tool: 'read', sessionID: SID, callID: 'c' }, { args: {} });
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
      const h = await load();
      const OTHER = 'ses_0f3a5b7c9d20AbCdEfGhIjKlMn';
      await h.event(event('session.created', { sessionID: SID, info: { id: SID } }));
      await h.event(event('session.created', { sessionID: OTHER, info: { id: OTHER } }));
      const system: string[] = [];
      await h['experimental.chat.system.transform']({ sessionID: OTHER, model: { limit: { context: 1 } } }, { system });
      expect(system).toEqual(['BRIEF']);
    } finally {
      server.close();
      await listen();
    }
  });

  it('ends the session when OpenCode disposes of the plugin', async () => {
    const h = await load();
    await h.event(event('session.created', { sessionID: SID, info: { id: SID } }));
    await h.dispose();
    await waitFor(() => names().includes('SessionEnd'));
  });
});
