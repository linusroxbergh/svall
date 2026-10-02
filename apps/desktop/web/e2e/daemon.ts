import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
// the specs' page has a port and an address of its own, so a dev server already up on 5173 never answers them
export const WEB_PORT = 5183;
export const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
export type DaemonInfo = { home: string; port: number; token: string; pid: number };

export const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
});

export function newHome(port: number): string {
  const home = `/tmp/svall-e2e-${crypto.randomBytes(3).toString('hex')}`;
  fs.mkdirSync(path.join(home, 'home'), { recursive: true });
  const fakeClaude = `node ${path.join(ROOT, 'packages/svalld/test/fixtures/fake-claude.mjs')}`;
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    port, shell: '/bin/sh', mobile: { origins: [WEB_ORIGIN] },
    home: { cwd: path.join(home, 'mc'), command: fakeClaude, actions: [{ label: 'organise', prompt: '/svall-organise' }, { label: 'rename', prompt: '/svall-rename' }] },
  }));
  // what the resources shelf lists and edits: never the real ~/.claude
  const claude = path.join(home, 'claude');
  fs.mkdirSync(path.join(claude, 'skills/ship-it'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'CLAUDE.md'), '# e2e\n');
  fs.writeFileSync(path.join(claude, 'skills/ship-it/SKILL.md'), '---\nname: ship-it\ndescription: Commit, PR and merge\n---\n# Ship it\n');
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }], PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }] },
  }, null, 2));
  return home;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startDaemon(home: string): Promise<DaemonInfo> {
  const portFile = path.join(home, 'port');
  fs.rmSync(portFile, { force: true });
  const log = fs.openSync(path.join(home, 'e2e-svalld.log'), 'a');
  // node itself runs svalld, so the pid stopDaemon signals is the daemon's own and not a launcher's
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'packages/svalld/src/bin.ts')], {
    // a fake `claude` first on PATH and a HOME of its own: nothing svalld spawns may reach the real account or files
    env: {
      ...process.env, HOME: path.join(home, 'home'), SVALL_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex'),
      // the node running this, which a version manager's shim could not find from the HOME above
      PATH: `${path.join(ROOT, 'packages/svalld/test/fixtures/bin')}:${path.dirname(process.execPath)}:${process.env.PATH}`,
    },
    stdio: ['ignore', log, log],
  });
  // the teardown knows only a daemon that started, so a failed start leaves nothing running behind it
  const fail = (why: string): never => { child.kill(); killTmux(home); throw new Error(why); };
  const end = Date.now() + 20_000;
  while (!fs.existsSync(portFile)) {
    if (child.exitCode !== null) fail(`svalld exited with ${child.exitCode}; see ${home}/e2e-svalld.log`);
    if (Date.now() > end) fail('svalld did not write its port file');
    await sleep(100);
  }
  const info: DaemonInfo = {
    home, pid: child.pid!,
    port: Number(fs.readFileSync(portFile, 'utf8')),
    token: fs.readFileSync(path.join(home, 'token'), 'utf8').trim(),
  };
  fs.writeFileSync(path.join(home, 'e2e.json'), JSON.stringify(info));
  return info;
}

export const readInfo = (home: string): DaemonInfo => JSON.parse(fs.readFileSync(path.join(home, 'e2e.json'), 'utf8'));

export async function stopDaemon(home: string): Promise<void> {
  const { pid } = readInfo(home);
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const portFile = path.join(home, 'port');
  const end = Date.now() + 10_000;
  while (fs.existsSync(portFile) && Date.now() < end) await sleep(50);
  if (fs.existsSync(portFile)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(portFile, { force: true });
    await sleep(200);
  }
}

export function killTmux(home: string): void {
  try { execFileSync('tmux', ['-S', path.join(home, 'tmux.sock'), 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ }
}
