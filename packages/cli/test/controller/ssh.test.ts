import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shq } from '@svall/svalld/text';
import { redact, runProcess } from '../../src/controller/process.js';
import { classifyExit, classifySsh, SshError, SshMaster } from '../../src/controller/ssh.js';
import { waitFor } from '../../../svalld/test/helpers.js';
import { installFakeSsh, type FakeSsh } from './fake-ssh.js';

const pgid = (pid: number): string => execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('runProcess', () => {
  it('hands an argument to the command rather than to a shell', async () => {
    const r = await runProcess('/bin/echo', ['$(whoami)', 'a; rm -rf /'], { timeoutMs: 5000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('$(whoami) a; rm -rf /\n');
  });

  it('bounds how much output it keeps', async () => {
    const r = await runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(5000))"], { timeoutMs: 5000, maxOutputBytes: 100 });
    expect(r.stdout.length).toBe(100);
    expect(r.truncated).toBe(true);
  });

  it('kills a command that outlives its timeout', async () => {
    const r = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 });
    expect(r.signal).toBe('SIGTERM');
  });

  it('kills a command when its caller aborts', async () => {
    const abort = new AbortController();
    const running = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 30_000, signal: abort.signal });
    abort.abort();
    expect((await running).signal).toBe('SIGTERM');
  });

  it('feeds stdin and reads it back', async () => {
    const r = await runProcess('/bin/cat', [], { timeoutMs: 5000, input: 'hello' });
    expect(r.stdout).toBe('hello');
  });

  it('runs a command in a process group of its own, which a terminal\'s Ctrl-C to this one never reaches', async () => {
    const r = await runProcess('/bin/sh', ['-c', 'ps -o pgid= -p $$'], { timeoutMs: 5000 });
    expect(r.stdout.trim()).not.toBe(pgid(process.pid));
  });
});

describe('redact', () => {
  it('keeps a secret out of a diagnostic', () => {
    expect(redact('token=s3cret-token failed', ['s3cret-token'])).toBe('token=[redacted] failed');
  });

  it('leaves a diagnostic alone when there is nothing to hide', () => {
    expect(redact('plain', ['', 'unused'])).toBe('plain');
  });
});

describe('shq, which every far command line quotes with', () => {
  it('makes one word of anything a path can hold', () => {
    expect(shq("/home/li nus/it's; touch x")).toBe("'/home/li nus/it'\\''s; touch x'");
    expect(shq('plain')).toBe("'plain'");
  });
});

describe('classifySsh', () => {
  it('names what ssh stumbled on', () => {
    expect(classifySsh('linus@h: Permission denied (publickey).')).toBe('auth');
    expect(classifySsh('Host key verification failed.')).toBe('host_key');
    expect(classifySsh('ssh: connect to host h port 22: Connection refused')).toBe('unreachable');
    expect(classifySsh('ssh: Could not resolve hostname h')).toBe('unreachable');
    expect(classifySsh('ssh: connect to host h port 22: Operation timed out')).toBe('unreachable');
    expect(classifySsh('Control socket connect(/tmp/svall-501/3309b427ec9d): No such file or directory')).toBe('unreachable');
    expect(classifySsh('Connection closed by remote host')).toBe('unreachable');
    expect(classifySsh('something else entirely')).toBe('other');
  });

  it('reads a connection the far end closed as unreachable, unless it closed during authentication', () => {
    expect(classifySsh('Connection to gate.test closed by remote host.')).toBe('unreachable');
    expect(classifySsh('Connection closed by 192.0.2.7 port 22')).toBe('unreachable');
    expect(classifySsh('Connection closed by authenticating user linus 192.0.2.7 port 22 [preauth]')).toBe('auth');
    expect(classifySsh('Connection closed by invalid user admin 192.0.2.7 port 22 [preauth]')).toBe('auth');
  });
});

describe('classifyExit', () => {
  it('reads a far command that its master or a signal cut short as unreachable', () => {
    // a mux client whose master died, or whose run was killed, exits 255 and says nothing
    expect(classifyExit({ code: 255, signal: null, stderr: '' }, 'other')).toBe('unreachable');
    expect(classifyExit({ code: null, signal: 'SIGTERM', stderr: '' }, 'other')).toBe('unreachable');
  });

  it('reads what ssh, the far shell and the command said when they said it', () => {
    expect(classifyExit({ code: 255, signal: null, stderr: 'linus@h: Permission denied (publickey).\n' }, 'other')).toBe('auth');
    expect(classifyExit({ code: 127, signal: null, stderr: 'sh: svall: not found\n' }, 'other')).toBe('version');
    expect(classifyExit({ code: 1, signal: null, stderr: 'svall: svalld is not running\n' }, 'daemon_down')).toBe('daemon_down');
  });
});

describe('SshMaster', () => {
  let ssh: FakeSsh;
  const open = (destination: string) => SshMaster.open({ destination, socketDir: ssh.socketDir });

  beforeEach(() => { ssh = installFakeSsh(); });
  afterEach(() => ssh.clean());

  it('spawns one control master that a dead link or a host that never answers ends', async () => {
    const master = await open('trift');
    // the spawn and the checks that wait for it race to the log, so only what was spawned is compared
    expect(ssh.calls().filter((c) => c.includes('-M'))).toEqual([[
      '-M', '-S', master.socket, '-N', '-o', 'BatchMode=yes', '-o', 'ControlPersist=no',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=10', '--', 'trift',
    ]]);
    expect(ssh.calls()).toContainEqual(['-S', master.socket, '-o', 'BatchMode=yes', '-O', 'check', '--', 'svall-remote.invalid']);
    expect(path.dirname(master.socket)).toBe(ssh.socketDir);
    expect(path.basename(master.socket)).toMatch(/^[0-9a-f]{12}$/);
    expect(fs.statSync(ssh.socketDir).mode & 0o777).toBe(0o700);
    await master.close();
  });

  it('shares one master between concurrent opens', async () => {
    const [a, b] = await Promise.all([open('trift'), open('trift')]);
    expect(a).toBe(b);
    expect(ssh.calls().filter((c) => c.includes('-M')).length).toBe(1);
    await a.close();
    await b.close();
  });

  it('keeps each process on a master of its own, so another one letting go ends nothing here', async () => {
    const mine = await open('trift');
    const tsx = path.join(import.meta.dirname, '../../../../node_modules/.bin/tsx');
    const theirs = execFileSync(tsx, [path.join(import.meta.dirname, '../fixtures/open-close-master.ts'), 'trift', ssh.socketDir], { encoding: 'utf8' });
    expect(theirs).not.toBe(mine.socket);
    expect(await mine.check()).toBe(true);
    await mine.close();
  });

  it('keeps its master out of a Ctrl-C the process that opened it answers itself, and ends it when that process exits', async () => {
    // a process that takes SIGINT itself, as a foreground handover does, and exits on a line of input
    const script = path.join(ssh.dir, 'hold-master.mts');
    fs.writeFileSync(script, [
      `import { SshMaster } from ${JSON.stringify(path.join(import.meta.dirname, '../../src/controller/ssh.ts'))};`,
      `const master = await SshMaster.open({ destination: 'trift', socketDir: ${JSON.stringify(ssh.socketDir)} });`,
      "process.on('SIGINT', () => process.stdout.write('interrupted\\n'));",
      "process.stdin.on('data', () => process.exit(0));",
      "process.stdout.write(master.socket + '\\n');",
    ].join('\n'));
    const root = path.resolve(import.meta.dirname, '../../../..');
    // a group of its own, as a terminal's foreground job has
    const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: root, detached: true, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    const exited = new Promise((resolve) => { child.on('close', resolve); });
    await waitFor(() => out.includes('\n'), 15_000);
    const master = ssh.masterPid(out.split('\n')[0]) as number;
    expect(alive(master)).toBe(true);

    // what a terminal's Ctrl-C does: SIGINT to every process in its foreground group
    process.kill(-(child.pid as number), 'SIGINT');
    await waitFor(() => out.includes('interrupted'));
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(master)).toBe(true);

    child.stdin.write('exit\n');
    await exited;
    await waitFor(() => !alive(master));
  });

  it('never adopts a master it did not spawn, even on the socket it would use', async () => {
    const first = await open('trift');
    await first.close();
    // something answers on that socket: a master another process left there
    const stranger = spawn('sleep', ['30']);
    fs.writeFileSync(path.join(ssh.dir, 'state', `${path.basename(first.socket)}.master`), String(stranger.pid));
    const spawns = () => ssh.calls().filter((c) => c.includes('-M')).length;
    const before = spawns();
    const second = await open('trift');
    expect(spawns()).toBe(before + 1);
    await second.close();
    stranger.kill();
  });

  it('removes a stale socket file before spawning', async () => {
    const first = await open('trift');
    await first.close();
    fs.writeFileSync(first.socket, '');
    const master = await open('trift');
    expect(master.socket).toBe(first.socket);
    expect(fs.existsSync(first.socket)).toBe(false);
    await master.close();
  });

  it('carries a hostile destination as one argument after the option terminator, to the master alone', async () => {
    for (const destination of ['evil.test; rm -rf $HOME', '-oProxyCommand=touch /tmp/pwned']) {
      const before = ssh.calls().length;
      const master = await open(destination);
      await master.close();
      const calls = ssh.calls().slice(before);
      for (const call of calls) expect(call.indexOf(call.includes('-M') ? destination : 'svall-remote.invalid')).toBe(call.indexOf('--') + 1);
      expect(calls.filter((c) => c.includes(destination))).toEqual(calls.filter((c) => c.includes('-M')));
    }
  });

  it('re-spawns a master that died under it', async () => {
    const first = await open('trift');
    const spawns = () => ssh.calls().filter((c) => c.includes('-M')).length;
    const before = spawns();
    // the master dies: its socket is left behind with nothing answering on it
    fs.rmSync(path.join(ssh.dir, 'state', `${path.basename(first.socket)}.master`), { force: true });
    fs.writeFileSync(first.socket, '');
    const second = await open('trift');
    expect(spawns()).toBe(before + 1);
    expect(await second.check()).toBe(true);
    await second.close();
  });

  it('refuses a socket directory another user could reach', async () => {
    fs.mkdirSync(ssh.socketDir, { recursive: true, mode: 0o755 });
    await expect(open('trift')).rejects.toThrow(/open to other users/);
  });

  it('refuses a socket directory that is a symlink', async () => {
    fs.symlinkSync(ssh.dir, ssh.socketDir);
    await expect(open('trift')).rejects.toThrow(/not a directory/);
  });

  it('never lets a command fall back to a connection of its own once its master has gone', async () => {
    const master = await open('trift');
    ssh.reply(['version'], { stdout: '{}\n' });
    ssh.dropMaster(master.socket);
    const r = await master.run(['svall', 'version']);
    expect(r.code).toBe(255);
    expect(r.stderr).toContain('Could not resolve hostname svall-remote.invalid');
    await master.close();
  });

  it('sends a remote command on with nothing of its own in front of it', async () => {
    const master = await open('trift');
    ssh.answer({ ok: true });
    const remote = ['/opt/svall/current/bin/svall', 'connection-info', '--json', '-p', '$(whoami)'];
    await master.run(remote);
    const call = ssh.calls().at(-1) as string[];
    // one `--`, before the destination: a second would reach the far shell as a word
    expect(call).toEqual(['-S', master.socket, '-o', 'BatchMode=yes', '--', 'svall-remote.invalid', ...remote]);
    expect(call.filter((a) => a === '--')).toHaveLength(1);
    const words = ssh.remoteCalls().at(-1) as string[];
    expect(words[0]).toBe('/opt/svall/current/bin/svall');
    expect(words).not.toContain('--');
    await master.close();
  });

  it('forwards a remote port to a local one it picked', async () => {
    const master = await open('trift');
    const forward = await master.forward(4711);
    expect(forward.localPort).toBeGreaterThan(0);
    expect(ssh.calls().at(-1)).toEqual(['-S', master.socket, '-o', 'BatchMode=yes', '-O', 'forward', '-L', `127.0.0.1:${forward.localPort}:127.0.0.1:4711`, '--', 'svall-remote.invalid']);
    await forward.cancel();
    expect(ssh.calls().at(-1)).toEqual(['-S', master.socket, '-o', 'BatchMode=yes', '-O', 'cancel', '-L', `127.0.0.1:${forward.localPort}:127.0.0.1:4711`, '--', 'svall-remote.invalid']);
    await master.close();
    expect(ssh.calls().at(-1)).toEqual(['-S', master.socket, '-o', 'BatchMode=yes', '-O', 'exit', '--', 'svall-remote.invalid']);
  });

  it('names what kept it from opening a master', async () => {
    const cases = [['refused.test', 'unreachable'], ['denied.test', 'auth'], ['hostkey.test', 'host_key'], ['vanish.test', 'unreachable']] as const;
    for (const [destination, kind] of cases) {
      const err = await open(destination).catch((e: SshError) => e);
      expect(err).toBeInstanceOf(SshError);
      expect((err as SshError).kind).toBe(kind);
    }
  });

  const live = process.env.SVALL_TEST_SSH;
  it.skipIf(!live)('opens a master against a real sshd (set SVALL_TEST_SSH=<destination> to run)', async () => {
    // the fake ssh is first on PATH for every other test in this describe; a real master needs the real one
    const fake = process.env.PATH ?? '';
    process.env.PATH = fake.split(':').filter((p) => !p.startsWith(ssh.dir)).join(':');
    try {
      const master = await SshMaster.open({ destination: live as string });
      expect(await master.check()).toBe(true);
      const r = await master.run(['echo', 'hello']);
      expect(r.stdout.trim()).toBe('hello');
      await master.close();
    } finally {
      process.env.PATH = fake;
    }
  });
});
