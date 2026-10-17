#!/usr/bin/env node
// A stand-in for ssh: it logs its argv, answers the control commands out of a state directory and
// proxies a forward for real, so a test can watch exactly what the controller spawns.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const state = process.env.SVALL_FAKE_SSH_STATE ?? '/tmp';
const log = process.env.SVALL_FAKE_SSH_LOG;
const info = process.env.SVALL_FAKE_SSH_INFO;
const remoteLog = process.env.SVALL_FAKE_SSH_REMOTE_LOG;
const replies = process.env.SVALL_FAKE_SSH_REPLIES;
const exec = process.env.SVALL_FAKE_SSH_EXEC;
const cutAfter = Number(process.env.SVALL_FAKE_SSH_CUT_AFTER || 0);

const TAKES_VALUE = new Set(['-S', '-o', '-O', '-L', '-l', '-p', '-i', '-b', '-c', '-e', '-m', '-w']);
const FLAGS = new Set(['-M', '-N', '-T', '-t', '-tt', '-q', '-v', '-n', '-f', '-g', '-x', '-A', '-4', '-6']);

const FAIL = {
  'refused.test': 'ssh: connect to host refused.test port 22: Connection refused',
  'denied.test': 'linus@denied.test: Permission denied (publickey).',
  'hostkey.test': 'Host key verification failed.',
  // a master that dies without a word, as one whose link dropped mid-handshake does
  'vanish.test': '',
};

// ssh reads options, takes the destination, and reads options once more only when no `--` ended the
// first pass (ssh.c `opt_terminated`); whatever is left is the remote command, verbatim
function parse(argv) {
  const opts = { o: [] };
  let i = 0;
  let terminated = false;
  const options = () => {
    for (; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--') { i++; terminated = true; return; }
      if (TAKES_VALUE.has(a)) {
        const v = argv[++i];
        if (a === '-o') opts.o.push(v); else opts[a.slice(1)] = v;
        continue;
      }
      // an option can carry its value against it, which is how -oProxyCommand=… gets in
      if (a.length > 2 && TAKES_VALUE.has(a.slice(0, 2))) {
        if (a[1] === 'o') opts.o.push(a.slice(2)); else opts[a[1]] = a.slice(2);
        continue;
      }
      if (FLAGS.has(a)) { opts[a.slice(1)] = true; continue; }
      return;
    }
  };
  options();
  if (i < argv.length) {
    opts.destination = argv[i++];
    if (!terminated) options();
  }
  return { ...opts, command: argv.slice(i) };
}

const marker = (opts, kind) => path.join(state, `${path.basename(opts.S ?? 'none')}.${kind}`);

function proxy(localPort, remotePort) {
  const server = net.createServer((from) => {
    const to = net.connect(remotePort, '127.0.0.1');
    from.pipe(to); to.pipe(from);
    from.on('error', () => to.destroy());
    to.on('error', () => from.destroy());
  });
  process.stdout.on('error', () => { /* the ssh that started it has exited */ });
  server.listen(localPort, '127.0.0.1', () => process.stdout.write('ready\n'));
  setTimeout(() => process.exit(0), 30_000);
}

function master(opts) {
  const file = marker(opts, 'master');
  fs.writeFileSync(file, String(process.pid));
  const drop = () => { try { fs.rmSync(file, { force: true }); } catch { /* gone already */ } process.exit(0); };
  process.on('SIGTERM', drop);
  process.on('SIGINT', drop);
  setInterval(() => {}, 1 << 30);
}

function control(opts) {
  const file = marker(opts, 'master');
  if (opts.O === 'check') {
    if (!fs.existsSync(file)) die(`Control socket connect(${opts.S}): No such file or directory`);
    process.stderr.write(`Master running (pid=${fs.readFileSync(file, 'utf8')})\n`);
    return;
  }
  if (opts.O === 'exit') {
    stopProxy(opts);
    if (fs.existsSync(file)) { try { process.kill(Number(fs.readFileSync(file, 'utf8')), 'SIGTERM'); } catch { /* already gone */ } }
    fs.rmSync(file, { force: true });
    return;
  }
  if (opts.O === 'forward') {
    if (!fs.existsSync(file)) die(`Control socket connect(${opts.S}): No such file or directory`);
    const [, local, , remote] = opts.L.split(':');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--proxy', local, remote], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    child.unref();
    fs.writeFileSync(marker(opts, 'proxy'), String(child.pid));
    // ssh only answers a forward once it is listening
    child.stdout.once('data', () => process.exit(0));
    return;
  }
  if (opts.O === 'cancel') { stopProxy(opts); return; }
  die(`unknown control command ${opts.O}`);
}

function stopProxy(opts) {
  const file = marker(opts, 'proxy');
  if (!fs.existsSync(file)) return;
  try { process.kill(Number(fs.readFileSync(file, 'utf8')), 'SIGTERM'); } catch { /* already gone */ }
  fs.rmSync(file, { force: true });
}

// ssh joins the remote argv into one line and a login shell splits it again: these are the words
// that shell is left holding
function shellWords(line) {
  try {
    return execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${line}`], { encoding: 'utf8' }).split('\0').slice(0, -1);
  } catch {
    return die('sh: syntax error near unexpected token');
  }
}

// what a test scripted this far side to answer: the first entry whose `match` words all appear
function scripted(words) {
  if (!replies || !fs.existsSync(replies)) return undefined;
  const lines = fs.readFileSync(replies, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return lines.find((r) => r.match.every((m) => words.includes(m)));
}

function remote(opts) {
  // a mux client whose master has gone connects on its own, to whatever its destination names
  if (opts.S && !fs.existsSync(marker(opts, 'master')) && opts.destination?.endsWith('.invalid')) {
    die(`ssh: Could not resolve hostname ${opts.destination}: nodename nor servname provided, or not known`);
  }
  const words = shellWords(opts.command.join(' '));
  if (remoteLog) fs.appendFileSync(remoteLog, `${JSON.stringify(words)}\n`);
  const reply = scripted(words);
  if (reply) {
    const answer = () => {
      if (reply.stdout) process.stdout.write(reply.stdout);
      if (reply.stderr) process.stderr.write(reply.stderr);
      process.exit(reply.code ?? 0);
    };
    if (reply.delayMs) { setTimeout(answer, reply.delayMs); return; }
    answer();
  }
  if (exec) { execute(opts); return; }
  if (!words.includes('connection-info')) die(`sh: ${words[0]}: command not found`, 127);
  if (!info) { process.stderr.write('svall: svalld is not running\n'); process.exit(1); }
  process.stdout.write(fs.readFileSync(info, 'utf8'));
}

// runs the far command on this machine through a login shell, as a mux client does over its master,
// and dies with the master; a cut drops the whole link once that many bytes have crossed it
function execute(opts) {
  const master = marker(opts, 'master');
  // the master is the only way through: its host name resolves nowhere
  if (!fs.existsSync(master)) die(`ssh: Could not resolve hostname ${opts.destination}: nodename nor servname provided, or not known`);
  const farPath = process.env.SVALL_FAKE_SSH_FAR_PATH;
  const env = farPath ? { ...process.env, PATH: farPath } : process.env;
  const child = spawn('/bin/sh', ['-c', opts.command.join(' ')], { stdio: ['pipe', 'pipe', 'inherit'], env });
  let crossed = 0;
  const drop = () => {
    try { process.kill(Number(fs.readFileSync(master, 'utf8')), 'SIGTERM'); } catch { /* already gone */ }
    fs.rmSync(master, { force: true });
    child.kill('SIGKILL');
    process.exit(255);
  };
  const cross = (n) => { crossed += n; if (cutAfter && crossed >= cutAfter) drop(); };
  const watch = setInterval(() => { if (!fs.existsSync(master)) drop(); }, 50);
  child.stdin.on('error', () => { /* the far command exited first */ });
  process.stdin.on('data', (chunk) => { cross(chunk.length); child.stdin.write(chunk); });
  process.stdin.on('end', () => child.stdin.end());
  child.stdout.on('data', (chunk) => { cross(chunk.length); process.stdout.write(chunk); });
  child.on('close', (code) => {
    clearInterval(watch);
    process.stdin.destroy();
    process.stdout.write('', () => process.exit(code ?? 255));
  });
}

function die(message, code = 255) {
  if (message) process.stderr.write(`${message}\n`);
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv[0] === '--proxy') {
  proxy(Number(argv[1]), Number(argv[2]));
} else {
  if (log) fs.appendFileSync(log, `${JSON.stringify(argv)}\n`);
  const opts = parse(argv);
  if (Object.hasOwn(FAIL, opts.destination ?? '') && !opts.O) die(FAIL[opts.destination]);
  if (opts.M) master(opts);
  else if (opts.O) control(opts);
  else remote(opts);
}
