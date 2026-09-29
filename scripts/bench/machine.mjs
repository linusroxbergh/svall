// The in-machine half of the fleet handover benchmark, run inside each container with the release's own node:
//
//   repo <small|large|many> <dir> [--files <n>] [--large-mib <n>]
//                                     makes a Git repository of that shape at <dir>
//   touch <dir> <n>                   changes n tracked files and adds one, as a little work between handovers would
//   run <host|local> --log <file>     runs `svall handover <host|local> --json` and prints what it measured as one JSON line
//   daemon reset|read                 resets or reads the peak RSS of this machine's fleet daemon, and sizes its replica records
//   info                              prints what this machine's fleet daemon answers to system.info
//   watch <stop file>                 until the stop file appears, keeps the peak RSS of each rsync, ssh and sshd process here
//   flood <character id> [--seconds <n>]
//                                     opens a viewer on a character's terminal that reads nothing while the terminal
//                                     prints as fast as it can, and samples the daemon's RSS and the output it was sent
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const HOME = os.homedir();
const FLEET = path.join(HOME, '.svall');
const SVALL = path.join(HOME, '.local', 'bin', 'svall');
const UNIT = 'svall-svalld@private.service';
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function flags(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
    else o._.push(argv[i]);
  }
  return o;
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

/** A deterministic body of `size` bytes for file `i`, so a rerun makes the same repository. */
const body = (i, size) => {
  const seed = crypto.createHash('sha256').update(String(i)).digest('hex');
  return `// ${i}\n${seed.repeat(Math.ceil(size / seed.length))}`.slice(0, size);
};

/**
 * small: 200 tracked files, as a small project; large: that plus `--large-mib` of ignored data in four files, as
 * datasets or media a project keeps beside its code; many: `--files` tracked files, 100 to a folder, packed.
 */
function repo(kind, dir, o) {
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists`);
  fs.mkdirSync(dir, { recursive: true });
  const count = kind === 'many' ? Number(o.files ?? 50_000) : 200;
  for (let i = 0; i < count; i++) {
    const folder = path.join(dir, 'src', `pkg${Math.floor(i / 5000)}`, `mod${Math.floor(i / 100)}`);
    if (i % 100 === 0) fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `f${i}.ts`), body(i, 200 + ((i * 7919) % 1800)));
  }
  fs.writeFileSync(path.join(dir, '.gitignore'), 'data/\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, '-c', 'gc.auto=0', 'commit', '-qm', `${kind} fixture`);
  // loose objects would double the files a many-file repository carries; a clone keeps them packed
  git(dir, 'gc', '-q');
  if (kind === 'large') {
    const mib = Number(o['large-mib'] ?? 1024);
    fs.mkdirSync(path.join(dir, 'data'));
    const chunk = crypto.randomBytes(1024 * 1024);
    for (let f = 0; f < 4; f++) {
      const fd = fs.openSync(path.join(dir, 'data', `blob-${f}.bin`), 'w');
      // each MiB differs, so rsync's delta and any compression see data as incompressible as a real blob
      for (let m = 0; m < mib / 4; m++) { chunk.writeUInt32LE(f * 1_000_000 + m, 0); fs.writeSync(fd, chunk); }
      fs.closeSync(fd);
    }
  }
  const files = git(dir, 'ls-files').toString().split('\n').filter(Boolean).length;
  process.stdout.write(`${JSON.stringify({ kind, dir, tracked: files })}\n`);
}

function touch(dir, n) {
  const tracked = git(dir, 'ls-files', 'src').toString().split('\n').filter(Boolean);
  const step = Math.max(1, Math.floor(tracked.length / n));
  const changed = [];
  for (let i = 0; i < n && i * step < tracked.length; i++) {
    const f = path.join(dir, tracked[i * step]);
    fs.appendFileSync(f, `// touched ${Date.now()}\n`);
    changed.push(tracked[i * step]);
  }
  fs.writeFileSync(path.join(dir, `added-${Date.now()}.txt`), 'added between handovers\n');
  process.stdout.write(`${JSON.stringify({ changed: changed.length, added: 1 })}\n`);
}

/** Name and peak RSS in KiB of a process, from /proc. */
function status(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const field = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0);
    return { name: /^Name:\s+(.*)$/m.exec(text)?.[1] ?? '?', hwm: field('VmHWM'), rss: field('VmRSS') };
  } catch { return undefined; }
}

const pids = () => fs.readdirSync('/proc').filter((f) => /^\d+$/.test(f)).map(Number);

function sessionOf(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3]);
  } catch { return undefined; }
}

const daemonPid = () => Number(execFileSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', UNIT], { encoding: 'utf8' }).trim());

function daemon(what) {
  const pid = daemonPid();
  // writing 5 to clear_refs resets the peak RSS the kernel keeps for the process
  if (what === 'reset') fs.writeFileSync(`/proc/${pid}/clear_refs`, '5');
  const s = status(pid);
  const dir = path.join(FLEET, 'replicas');
  const records = [];
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) for (const r of fs.readdirSync(path.join(dir, f))) records.push(fs.statSync(path.join(dir, f, r)).size);
  process.stdout.write(`${JSON.stringify({ pid, hwmKiB: s?.hwm, rssKiB: s?.rss, replicaRecords: records.length, largestRecord: Math.max(0, ...records) })}\n`);
}

async function watch(stop) {
  const peaks = {};
  while (!fs.existsSync(stop)) {
    for (const pid of pids()) {
      const s = status(pid);
      if (!s || !['rsync', 'ssh', 'sshd'].includes(s.name)) continue;
      peaks[s.name] = Math.max(peaks[s.name] ?? 0, s.hwm);
    }
    await sleep(100);
  }
  fs.writeFileSync(`${stop}.json`, `${JSON.stringify(peaks)}\n`);
}

/** The JSON a file holds, as long as it is on the wire: without the indentation the controller keeps it with. */
function compactBytes(file) {
  try { return Buffer.byteLength(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')))); } catch { return undefined; }
}

/** Seconds some task on this machine (the VM under docker) waited on IO and on memory, from pressure stall information. */
function stalls() {
  const some = (what) => { try { return Number(/^some .*total=(\d+)/m.exec(fs.readFileSync(`/proc/pressure/${what}`, 'utf8'))?.[1] ?? 0) / 1e6; } catch { return 0; } };
  return { io: some('io'), memory: some('memory') };
}

async function run(o) {
  const to = o._[0];
  const stalled = stalls();
  const t0 = Date.now();
  const child = spawn(SVALL, ['handover', to, '--json'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(o.log);
  child.stderr.pipe(fs.createWriteStream(`${o.log}.stderr`));
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  const events = { count: 0, bytes: 0, maxLine: 0, byType: {} };
  const phases = [];
  let result = null;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    log.write(`${line}\n`);
    const bytes = Buffer.byteLength(line) + 1;
    events.count++;
    events.bytes += bytes;
    events.maxLine = Math.max(events.maxLine, bytes);
    let e;
    try { e = JSON.parse(line); } catch { return; }
    events.byType[e.event] = (events.byType[e.event] ?? 0) + 1;
    if (e.event === 'handover.preflight') phases.push({ phase: 'preflight-done', ms: Date.now() - t0 });
    if (e.event === 'handover.changed' && phases.at(-1)?.phase !== e.data.phase) phases.push({ phase: e.data.phase, ms: Date.now() - t0 });
    if (e.event === 'handover.result') result = e.data;
  });

  // the controller's session: node itself, the local rsync and the ssh under it
  const peaks = {};
  const kept = {};
  const txRoot = path.join(FLEET, 'controller', 'handover');
  let done = false;
  void exited.then(() => { done = true; });
  while (!done) {
    for (const pid of pids()) {
      if (sessionOf(pid) !== child.pid) continue;
      const s = status(pid);
      if (s) peaks[s.name] = Math.max(peaks[s.name] ?? 0, s.hwm);
    }
    // the files the controller keeps of the manifest and of what landed, read once each as they appear
    if (fs.existsSync(txRoot)) {
      for (const tx of fs.readdirSync(txRoot)) {
        for (const name of ['manifest.json', 'landed.json']) {
          const file = path.join(txRoot, tx, name);
          if (kept[name] || !fs.existsSync(file)) continue;
          kept[name] = { bytes: fs.statSync(file).size, wire: compactBytes(file) };
        }
      }
    }
    await sleep(100);
  }
  const exit = await exited;
  log.end();
  const ms = Date.now() - t0;
  const now = stalls();
  const stall = { ioS: +(now.io - stalled.io).toFixed(1), memoryS: +(now.memory - stalled.memory).toFixed(1) };
  const span = {};
  phases.forEach((p, i) => { span[p.phase] = (phases[i + 1]?.ms ?? ms) - p.ms; });
  span.preflight = phases.find((p) => p.phase === 'preflight-done')?.ms ?? null;
  delete span['preflight-done'];
  const manifest = kept['manifest.json']?.wire;
  const landed = kept['landed.json']?.wire;
  // a request's envelope around its params, and the base64 parts one larger than PART_BYTES goes in
  const PART = 4 * 1024 * 1024;
  const partFrame = Math.ceil(PART / 3) * 4 + 80;
  const messages = manifest === undefined ? null : {
    freezeAnswer: manifest + 30,
    claim: manifest + 200,
    prepare: manifest + (landed ?? 0) + 260,
  };
  const frames = messages && { largest: Math.max(messages.freezeAnswer, messages.prepare > PART ? partFrame : messages.prepare), prepareParts: Math.ceil(messages.prepare / PART) };
  process.stdout.write(`${JSON.stringify({ to, ms, exit, status: result?.status, error: result?.error, blockers: result?.blockers, span, events, controller: peaks, kept, messages, frames, stall })}\n`);
}

/** One call over a socket this function opens, as the CLI's client makes one, and the socket, still open. */
async function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error(`no daemon on ${port}`)); });
  ws.send(JSON.stringify({ token }));
  await new Promise((resolve) => { ws.onmessage = resolve; });
  return ws;
}

async function info() {
  const port = Number(fs.readFileSync(path.join(FLEET, 'port'), 'utf8'));
  const ws = await connect(port, fs.readFileSync(path.join(FLEET, 'token'), 'utf8').trim());
  ws.send(JSON.stringify({ id: 1, method: 'system.info', params: {} }));
  const answer = await new Promise((resolve) => { ws.onmessage = (m) => resolve(JSON.parse(m.data)); });
  ws.close();
  process.stdout.write(`${JSON.stringify(answer.result)}\n`);
}

/**
 * A viewer that opens a character's terminal and then reads nothing, as a phone on a link slower than the terminal
 * prints. The terminal prints without end; the daemon's RSS and what it queued for the viewer are sampled.
 */
async function flood(o) {
  const id = o._[0];
  const seconds = Number(o.seconds ?? 20);
  const port = Number(fs.readFileSync(path.join(FLEET, 'port'), 'utf8'));
  const token = fs.readFileSync(path.join(FLEET, 'token'), 'utf8').trim();
  // a raw socket under the viewer, so its reads can stop the way a slow link stops them
  let fromDaemon;
  const server = net.createServer((s) => {
    const up = net.connect(port, '127.0.0.1');
    fromDaemon = up;
    s.pipe(up);
    up.pipe(s);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ws = await connect(server.address().port, token);
  ws.send(JSON.stringify({ id: 1, method: 'term.open', params: { id, cols: 120, rows: 40, lines: 100 } }));
  await new Promise((resolve) => { ws.onmessage = (m) => { if (JSON.parse(m.data).id === 1) resolve(); }; });
  let received = 0;
  ws.onmessage = (m) => { received += m.data.length; };
  execFileSync(SVALL, ['char', 'run', id, 'yes "$(head -c 200 /dev/zero | tr "\\0" x)"']);
  await sleep(1000);
  const before = received;
  fromDaemon.pause();
  const pid = daemonPid();
  const samples = [];
  const start = status(pid).rss;
  for (let t = 0; t < seconds * 4; t++) {
    await sleep(250);
    samples.push(status(pid).rss);
  }
  fromDaemon.resume();
  const tmux = (...args) => execFileSync('tmux', ['-S', path.join(FLEET, 'tmux.sock'), ...args], { encoding: 'utf8' });
  const pane = tmux('list-panes', '-a', '-F', '#{window_name} #{pane_id}').split('\n').find((l) => l.startsWith(`${id} `))?.split(' ')[1];
  if (pane) tmux('send-keys', '-t', pane, 'C-c');
  await sleep(2000);
  process.stdout.write(`${JSON.stringify({ seconds, startKiB: start, peakKiB: Math.max(...samples), endKiB: samples.at(-1), receivedBeforePause: before, receivedAfter: received - before, samples: samples.filter((_, i) => i % 4 === 3) })}\n`);
  ws.close();
  server.close();
}

const [cmd, ...rest] = process.argv.slice(2);
const o = flags(rest);
if (cmd === 'repo') repo(o._[0], o._[1], o);
else if (cmd === 'touch') touch(o._[0], Number(o._[1] ?? 10));
else if (cmd === 'run') await run(o);
else if (cmd === 'daemon') daemon(o._[0]);
else if (cmd === 'info') await info();
else if (cmd === 'watch') await watch(o._[0]);
else if (cmd === 'flood') await flood(o);
else { process.stderr.write(`unknown command ${cmd}\n`); process.exit(2); }
