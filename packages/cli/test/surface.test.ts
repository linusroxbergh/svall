import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command, CommanderError } from 'commander';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, STATE_SCHEMA_VERSION, type FleetState, type Island, type Robot } from '@svall/protocol';
import { buildProgram } from '../src/program.js';
import { setupCommand } from '../src/definitions/setup.js';

// the commands that only talk to a daemon, or refuse on a Mac, before anything changes
const DAEMON = ['status', 'island', 'robot', 'scribe', 'browser', 'app', 'mobile', 'retro', 'host limits', 'fleet limits', 'fleet home'];

const tree = (c: Command, at: string[] = []): { at: string[]; c: Command }[] => [{ at, c }, ...c.commands.flatMap((s) => tree(s, [...at, s.name()]))];

// what `svall <argv>` prints and exits with, as main.ts ends it
async function run(argv: string[], home: string, program = buildProgram()): Promise<string> {
  let out = '';
  const write = (s: string | Uint8Array) => { out += String(s); return true; };
  for (const { c } of tree(program)) c.exitOverride().configureOutput({ writeOut: write, writeErr: write });
  vi.spyOn(process.stdout, 'write').mockImplementation(write);
  vi.spyOn(process.stderr, 'write').mockImplementation(write);
  let code: number;
  try {
    await program.parseAsync(argv, { from: 'user' });
    code = Number(process.exitCode ?? 0);
  } catch (e) {
    code = e instanceof CommanderError ? e.exitCode : 1;
    if (!(e instanceof CommanderError)) out += `svall: ${(e as Error).message}\n`;
  } finally {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  }
  return `$ svall ${argv.join(' ')}\n${out.replaceAll(home, '<home>').replaceAll(process.cwd(), '<cwd>')}[exit ${code}]\n`;
}

// a placeholder for each argument and required option, so the action runs as far as the daemon
const filled = (c: Command): string[] => [
  ...c.registeredArguments.filter((a) => a.required).map(() => 'x'),
  ...c.options.filter((o) => o.mandatory).flatMap((o) => [o.long!, 'x']),
];

const island: Island = { id: 'x', name: 'x', description: '', instructions: '', context: [], position: { x: 0, y: 0 }, size: { w: 4, h: 3 }, seed: 0 };
const robot: Robot = {
  id: 'x', islandId: 'x', cell: { x: 0, y: 0 }, name: 'x', portrait: 'fox', note: '', instructions: '', cwd: '/x', context: [],
  tmux: { windowId: '@1', paneId: '%1' }, shell: { lastOutputAt: 0 }, unread: false,
};

// a daemon whose fleet holds island x and robot x, refusing every other call by its method and params, so each case
// shows the call its action makes
async function daemon(home: string): Promise<{ wss: WebSocketServer; port: number }> {
  const state: FleetState = {
    version: STATE_SCHEMA_VERSION, islands: { x: island }, robots: { x: robot }, home: { cwd: '~', command: 'x', actions: [] }, defaultCwd: '~', columns: [{ id: 'x', name: 'x' }],
  };
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (ws) => ws.once('message', () => {
    ws.send(JSON.stringify({ id: 0, result: { ok: true, protocol: PROTOCOL_VERSION } }));
    ws.on('message', (raw) => {
      const { id, method, params } = JSON.parse(raw.toString()) as { id: number; method: string; params: unknown };
      ws.send(JSON.stringify(method === 'state.get' ? { id, result: state } : { id, error: { code: 'stub', message: `${method} ${JSON.stringify(params)}` } }));
    });
  }));
  const { port } = wss.address() as { port: number };
  fs.writeFileSync(path.join(home, 'port'), String(port));
  fs.writeFileSync(path.join(home, 'token'), 't');
  return { wss, port };
}

describe('svall command surface', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  // setup and doctor read the platform for their options
  it.runIf(process.platform === 'darwin')('prints the same help, refusals, errors and exit codes for every command', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-surface-'));
    vi.stubEnv('SVALL_HOME', home);
    // the robot the browser commands and robot send act as
    vi.stubEnv('SVALL_ROBOT_ID', 'x');
    const { wss, port } = await daemon(home);
    let all = '';
    for (const { at, c } of tree(buildProgram())) {
      all += await run([...at, '--help'], home);
      all += await run([...at, '--no-such-flag'], home);
      if (c.commands.length === 0 && DAEMON.some((p) => `${at.join(' ')} `.startsWith(`${p} `))) {
        all += await run([...at, ...filled(c)], home);
        all += await run(['--json', ...at, ...filled(c)], home);
      }
    }
    const linux = () => new Command('svall').addCommand(setupCommand(() => ({ name: 'x', home, managed: false }), () => false, 'linux'));
    all += await run(['setup', '--help'], home, linux());
    all += await run(['setup', '--no-such-flag'], home, linux());
    wss.close();
    fs.rmSync(home, { recursive: true, force: true });
    await expect(all.replaceAll(`port ${port} `, 'port <port> ')).toMatchFileSnapshot('./surface.snap.txt');
  });
});
