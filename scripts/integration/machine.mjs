// The in-machine half of the fleet handover and robot placement integration runs, run inside each container with the
// release's own node:
//
//   snap [--gateway <fleetId>] [--light]  one JSON document: this machine's view of the fleet, its repos, sessions,
//                                         terminals, agent processes and OpenCode servers, worktree locks, move
//                                         journals and outbox (and, on the gateway, its record); --light leaves out
//                                         repos, trees and sessions
//   machines                              the links the fleet's state holds, by machine id
//   drive <host|local> [--fault kill|drop --at begin|transfer|ready|commit|activate] --log <file> [--cap <s>]
//                                         runs `svall handover <host|local> --json`, injects the fault at that boundary,
//                                         and prints what happened as one JSON document
//   drive move|return <robot> [--machine <name>] [--fault kill|drop --at rest|bundle|prepare|commit|activate|release] [--cap <s>]
//                                         on the home: runs `svall robot move <robot> --machine <name|local> --json`,
//                                         injects the fault at that phase of the move, and prints what happened as one JSON document
//   watch <robot> --out <file> [--for <s>]
//                                         appends to <file> the robot's agent as the daemon's API shows it at connect and
//                                         after each change, waiting for the daemon to answer first
//   link <port>                           (root, on the remote) drops and restores the sshd port on request
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const HOME = os.homedir();
const FLEET = path.join(HOME, '.svall');
// the tmux the release carries, which serves the fleet's socket; Ubuntu's older client cannot talk to it
const TMUX = path.join(HOME, '.local/share/svall/current/bin/tmux');
const MOCK = '/opt/it/claude.mjs';
const REPOS = ['src/app', 'src/app-wt'];
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function flags(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
    else o._.push(argv[i]);
  }
  return o;
}

/** One call to this machine's fleet daemon, through its port and token files as the CLI's client makes it. */
async function rpc(method, params = {}) {
  const port = Number(fs.readFileSync(path.join(FLEET, 'port'), 'utf8'));
  const token = fs.readFileSync(path.join(FLEET, 'token'), 'utf8').trim();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 20_000);
      let open = false;
      ws.onerror = () => { clearTimeout(timer); reject(new Error(`the daemon on ${port} did not answer`)); };
      ws.onopen = () => ws.send(JSON.stringify({ token }));
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (!open) {
          open = true;
          if (!msg.result?.ok) { clearTimeout(timer); reject(new Error('token refused')); return; }
          ws.send(JSON.stringify({ id: 1, method, params }));
          return;
        }
        if (msg.id !== 1) return;
        clearTimeout(timer);
        if (msg.error) reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
        else resolve(msg.result);
      };
    });
  } finally {
    ws.close();
  }
}

const settled = async (fn) => { try { return await fn(); } catch (e) { return { error: e.message, ...(e.code && { code: e.code }) }; } };

function run(exe, args, o = {}) {
  try {
    return execFileSync(exe, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...o });
  } catch (e) {
    return `ERROR ${e.status}: ${String(e.stderr ?? e.message).trim()}`;
  }
}

/** Every file, link and folder under `dir`, hashed; `skip` names folders not descended into. */
function walk(dir, skip = new Set()) {
  const out = {};
  const visit = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (skip.has(r)) continue;
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) out[r] = { t: 'l', to: fs.readlinkSync(p) };
      else if (st.isDirectory()) { out[r] = { t: 'd', mode }; visit(p, r); }
      else if (st.isFile()) out[r] = { t: 'f', mode, size: st.size, sha: sha(fs.readFileSync(p)) };
      else out[r] = { t: 'other' };
    }
  };
  if (fs.existsSync(dir)) visit(dir, '');
  else return null;
  return out;
}

function gitOf(dir) {
  if (!fs.existsSync(dir)) return null;
  const git = (...args) => run('git', ['--no-optional-locks', ...args], { cwd: dir });
  return {
    head: git('rev-parse', 'HEAD').trim(),
    branch: git('symbolic-ref', '-q', 'HEAD').trim(),
    status: git('status', '--porcelain=v2', '--branch', '--untracked-files=all'),
    index: git('ls-files', '--stage'),
    stash: git('stash', 'list', '--format=%gd %H %s'),
    worktrees: git('worktree', 'list', '--porcelain'),
    refs: git('for-each-ref', '--format=%(refname) %(objectname)'),
    fsck: git('fsck', '--no-progress', '--no-dangling'),
  };
}

/** Each process whose command line holds `needle`, with its arguments, working folder and the robot its terminal names. */
function processes(needle) {
  const out = [];
  for (const pid of fs.readdirSync('/proc').filter((f) => /^\d+$/.test(f))) {
    let args;
    try { args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { continue; }
    if (!args.some((a) => a.includes(needle))) continue;
    let cwd = null;
    try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { /* gone */ }
    let robotId = null;
    try { robotId = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((e) => e.startsWith('SVALL_ROBOT_ID='))?.slice(15) ?? null; } catch { /* gone */ }
    out.push({ pid: Number(pid), args, cwd, robotId });
  }
  return out;
}

// the repos the handover run makes, and every worktree of src/app, by their paths under the home
function repos() {
  const listed = run('git', ['worktree', 'list', '--porcelain'], { cwd: path.join(HOME, 'src/app') });
  const worktrees = listed.startsWith('ERROR') ? [] : listed.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => path.relative(HOME, l.slice(9)));
  return [...new Set([...REPOS, ...worktrees])].filter((r) => r && !r.startsWith('..'));
}

/** Each worktree of src/app with the reason it is locked for, or null. */
function locks() {
  const listed = run('git', ['worktree', 'list', '--porcelain'], { cwd: path.join(HOME, 'src/app') });
  if (listed.startsWith('ERROR')) return {};
  return Object.fromEntries(listed.split('\n\n').filter(Boolean).map((e) => {
    const ls = e.split('\n');
    const locked = ls.find((l) => l === 'locked' || l.startsWith('locked '));
    return [path.relative(HOME, ls[0].slice(9)), locked === undefined ? null : locked.slice(7)];
  }));
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** A worker's outbox: the last seq and the one the home acknowledged, and each entry yet to be, with the agent it reports. */
function outbox() {
  const file = path.join(FLEET, 'journal', 'outbox.ndjson');
  const entries = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const acked = Number((fs.existsSync(path.join(FLEET, 'journal', 'acked')) ? fs.readFileSync(path.join(FLEET, 'journal', 'acked'), 'utf8') : '0').trim());
  return {
    acked,
    last: entries.at(-1)?.seq ?? acked,
    entries: entries.map((e) => ({ seq: e.seq, kind: e.kind, robotId: e.data?.robotId, ...(e.data?.fields && { agent: agentOf(e.data.fields) }) })),
  };
}

// the agent fields a status change shows
const agentOf = (c) => (c?.agent ? { status: c.agent.status, contextPct: c.agent.contextPct ?? null, prompt: c.agent.lastPrompt?.text ?? null } : null);

/** This machine's journal of each move: its robot, ends and phase. */
function moves() {
  const dir = path.join(FLEET, 'journal', 'moves');
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir).filter((f) => /^mv_[0-9a-z]{10}\.json$/.test(f)).map((f) => {
    const j = readJson(path.join(dir, f));
    return [f.slice(0, -5), j && { robotId: j.robotId, from: j.from, to: j.to, phase: j.phase, ...(j.error && { error: j.error }) }];
  }));
}

// the mocked OpenCode retitles itself, so its command line is one string of the words the native binary's would hold
const opencodes = () => processes('opencode').map((p) => ({ ...p, args: p.args.join(' ').split(' ') })).filter((p) => p.args[0] === 'opencode');

/** The sessions the mocked OpenCode holds, where the real one keeps its database: messages and folder, by id. */
function opencodeSessions() {
  const root = path.join(HOME, '.local', 'share', 'opencode', 'mock-sessions');
  if (!fs.existsSync(root)) return {};
  return Object.fromEntries(fs.readdirSync(root).filter((n) => n.endsWith('.json')).map((f) => {
    const s = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
    return [s.info.id, { messages: s.messages.length, sha: sha(JSON.stringify(s.messages)), directory: s.info.location.directory }];
  }));
}

function sessions() {
  const root = path.join(HOME, '.claude', 'projects');
  const out = {};
  if (!fs.existsSync(root)) return out;
  for (const dir of fs.readdirSync(root)) {
    for (const f of fs.readdirSync(path.join(root, dir)).filter((n) => n.endsWith('.jsonl'))) {
      const text = fs.readFileSync(path.join(root, dir, f), 'utf8');
      out[`${dir}/${f}`] = { lines: text.split('\n').filter(Boolean).length, sha: sha(text) };
    }
  }
  return out;
}

async function snap(o) {
  const info = await settled(() => rpc('system.info'));
  const state = await settled(() => rpc('state.get'));
  const listed = run(TMUX, ['-S', path.join(FLEET, 'tmux.sock'), 'list-windows', '-a', '-F', '#{window_name}|#{pane_pid}|#{pane_current_command}']);
  // a machine that let the fleet go runs no tmux server for it at all
  const windows = (/^ERROR \d+: no server running/.test(listed) ? '' : listed)
    .split('\n').filter(Boolean).map((l) => { const [name, pid, command] = l.split('|'); return { name, pid: Number(pid), command }; });
  const controller = path.join(FLEET, 'controller', 'handover.json');
  const fleet = JSON.parse(fs.readFileSync(path.join(FLEET, 'fleet.json'), 'utf8'));
  const out = {
    machineId: info.machineId ?? null,
    home: HOME,
    info,
    ownership: await settled(() => rpc('ownership.get')),
    handover: await settled(() => rpc('handover.status')),
    fleet: { id: fleet.id, gatewayMachineId: fleet.gatewayMachineId, handoverEnabled: fleet.handover?.enabled },
    robots: state.robots ? Object.values(state.robots).map((c) => ({
      id: c.id, name: c.name, cwd: c.cwd, islandId: c.islandId, tmux: c.tmux ?? null, revive: c.revive ?? null,
      agent: c.agent ? { kind: c.agent.kind, sessionId: c.agent.sessionId, status: c.agent.status, pid: c.agent.pid ?? null, contextPct: c.agent.contextPct ?? null, prompt: c.agent.lastPrompt?.text ?? null } : null,
      machine: c.machine ?? null, placement: c.placement ?? null, moving: c.moving ?? null, left: c.left ?? null, branch: c.repo?.branch ?? null, root: c.repo?.root ?? null, note: c.note,
    })).sort((a, b) => a.id.localeCompare(b.id)) : state,
    machines: state.machines ?? {},
    windows,
    agents: [
      ...processes(MOCK).filter((p) => !p.args.includes('--version') && !p.args.includes('auth') && !p.args.includes('-p')).map((p) => ({ kind: 'claude', ...p })),
      ...opencodes().filter((p) => !['serve', 'session', 'auth', 'run', '--version', '--help'].includes(p.args[1])).map((p) => ({ kind: 'opencode', ...p })),
    ],
    servers: opencodes().filter((p) => p.args[1] === 'serve').map((p) => ({ ...p, ppid: ppidOf(p.pid) })),
    controllerJournal: fs.existsSync(controller) ? JSON.parse(fs.readFileSync(controller, 'utf8')) : null,
    ...(!o.light && {
      git: Object.fromEntries(repos().map((r) => [r, gitOf(path.join(HOME, r))])),
      trees: Object.fromEntries(repos().map((r) => [r, walk(path.join(HOME, r), new Set(['.git', '.claude']))])),
      sessions: sessions(),
    }),
    opencode: opencodeSessions(),
    worker: (({ token, ...w }) => w)(readJson(path.join(FLEET, 'worker.json')) ?? {}),
    locks: locks(),
    outbox: outbox(),
    moves: moves(),
  };
  if (o.gateway) {
    const said = run(path.join(HOME, '.local', 'bin', 'svall'), ['gateway', 'owner', 'get', '--fleet', o.gateway]).trim().split('\n').at(-1);
    try { out.gateway = JSON.parse(said); } catch { out.gateway = { error: said }; }
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

/** Each process descended from `root`, which runs its ssh and rsync in sessions of their own: pid and arguments. */
function descendants(root) {
  const children = new Map();
  for (const pid of fs.readdirSync('/proc').filter((f) => /^\d+$/.test(f))) {
    let stat;
    try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { continue; }
    // the fields after the command name, which may itself hold spaces and parentheses
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    children.set(ppid, [...(children.get(ppid) ?? []), Number(pid)]);
  }
  const out = [];
  for (const queue = [...(children.get(root) ?? [])]; queue.length;) {
    const pid = queue.shift();
    queue.push(...(children.get(pid) ?? []));
    try { out.push({ pid, args: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) }); } catch { /* gone */ }
  }
  return out;
}

function ppidOf(pid) {
  try { const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]); } catch { return null; }
}

const alive = (pid) => fs.existsSync(`/proc/${pid}`);

// the process that marks each boundary: the ssh that carries one gateway operation, or the rsync that copies a root
const MARKS = {
  begin: (a) => a.includes('gateway') && a.includes('owner') && a.includes("'begin'"),
  ready: (a) => a.includes('gateway') && a.includes('owner') && a.includes("'ready'"),
  commit: (a) => a.includes('gateway') && a.includes('owner') && a.includes("'commit'"),
  transfer: (a) => path.basename(a[0] ?? '') === 'rsync' && a.includes('--info=progress2'),
};

async function link(cmd) {
  const [host, port] = (process.env.IT_LINK ?? 'svall-remote:7070').split(':');
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port: Number(port) }, () => sock.write(`${cmd}\n`));
    let said = '';
    sock.on('data', (d) => { said += d; if (said.includes('\n')) { sock.end(); resolve(said.trim()); } });
    sock.on('error', reject);
  });
}

/**
 * One handover, with a controller kill or a dropped ssh link at a boundary. A kill at a gateway operation takes the
 * controller alone, so the ssh already carrying that operation still lands it, as a helper killed mid-call leaves it;
 * a kill during the transfer takes it and everything it started, rsync and ssh with it, as a crash of the machine would.
 */
async function drive(o) {
  const to = o._[0];
  const at = o.at;
  const fault = o.fault ?? 'none';
  if (fault !== 'none' && !['begin', 'transfer', 'ready', 'commit', 'activate'].includes(at)) throw new Error(`bad --at ${at}`);
  const log = fs.createWriteStream(o.log);
  const t0 = Date.now();
  const child = spawn(path.join(HOME, '.local', 'bin', 'svall'), ['handover', to, '--json'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.pipe(fs.createWriteStream(`${o.log}.stderr`));
  // `close` waits for the controller's output to be read to its end; nothing it spawns inherits that pipe
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  const events = [];
  let result = null;
  let fire;
  const fired = new Promise((resolve) => { fire = resolve; });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    log.write(`${line}\n`);
    let e;
    try { e = JSON.parse(line); } catch { return; }
    events.push({ ms: Date.now() - t0, event: e.event, phase: e.data?.phase });
    if (e.event === 'handover.result') result = e.data;
    if (at === 'activate' && e.event === 'handover.changed' && e.data?.phase === 'activate') fire({ by: 'handover.changed activate' });
  });

  let watching = fault !== 'none' && MARKS[at];
  const watch = async () => {
    while (watching) {
      const hit = descendants(child.pid).find((p) => MARKS[at](p.args));
      if (hit) { fire({ by: hit.args.join(' ').slice(0, 300), pid: hit.pid }); return; }
      if (!alive(child.pid)) return;
      await sleep(2);
    }
  };
  if (watching) void watch();

  const summary = { to, fault, at: at ?? null };
  if (fault !== 'none') {
    const hit = await Promise.race([fired, exited.then(() => null)]);
    watching = false;
    summary.trigger = hit ? { ...hit, ms: Date.now() - t0 } : null;
    if (hit && fault === 'kill') {
      const doomed = [child.pid, ...(at === 'transfer' ? descendants(child.pid).map((p) => p.pid) : [])];
      for (const pid of doomed) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      // the operation already on its way lands before anyone looks
      if (hit.pid) for (const end = Date.now() + 60_000; alive(hit.pid) && Date.now() < end;) await sleep(20);
    }
    if (hit && fault === 'drop') {
      summary.drop = await link('drop');
      const cap = Number(o.cap ?? 300) * 1000;
      let timer;
      const ended = await Promise.race([exited.then(() => true), new Promise((r) => { timer = setTimeout(() => r(false), cap); })]);
      clearTimeout(timer);
      if (!ended) { summary.capped = true; process.kill(child.pid, 'SIGKILL'); }
      summary.restore = await link('restore');
    }
  }
  summary.exit = await exited;
  summary.ms = Date.now() - t0;
  summary.result = result;
  summary.phases = events.filter((e) => e.event === 'handover.changed').map((e) => `${e.phase}@${e.ms}`);
  summary.retries = events.filter((e) => e.event === 'handover.retry').length;
  log.end();
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

const UNIT = 'svall-svalld@private.service';
const MOVE_PHASES = ['rest', 'bundle', 'prepare', 'commit', 'activate', 'release'];

/**
 * One move of a robot, with the home's daemon killed or the link dropped at a phase. Each write of the move's journal
 * stops the daemon until the phase is read, so the fault lands at that phase; a kill takes the daemon alone, as a crash
 * does, and systemd starts it again. A move refused while the worker catches up is asked again.
 */
async function driveMove(o) {
  const [kind, robot] = o._;
  const machine = kind === 'return' ? 'local' : o.machine;
  const { fault = 'none', at } = o;
  if (fault !== 'none' && !MOVE_PHASES.includes(at)) throw new Error(`bad --at ${at}`);
  const dir = path.join(FLEET, 'journal', 'moves');
  fs.mkdirSync(dir, { recursive: true });
  const before = new Set(fs.readdirSync(dir));
  const pid = Number(execFileSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', UNIT], { encoding: 'utf8' }).trim());
  const t0 = Date.now();
  const summary = { kind, robot, fault, at: at ?? null, moveId: null, trigger: null, phases: [] };
  let busy = false;
  const watcher = fs.watch(dir, (_e, name) => {
    if (busy || summary.trigger || !name || !/^mv_[0-9a-z]{10}\.json$/.test(name) || before.has(name)) return;
    busy = true;
    const armed = fault !== 'none';
    if (armed) try { process.kill(pid, 'SIGSTOP'); } catch { /* gone */ }
    const phase = readJson(path.join(dir, name))?.phase;
    summary.moveId = name.slice(0, -5);
    if (phase && summary.phases.at(-1) !== phase) summary.phases.push(phase);
    const reached = armed && MOVE_PHASES.indexOf(phase) >= MOVE_PHASES.indexOf(at);
    const land = async () => {
      if (reached) {
        summary.trigger = { phase, ms: Date.now() - t0 };
        if (fault === 'kill') process.kill(pid, 'SIGKILL');
        else summary.drop = await link('drop');
      }
      if (armed && !(reached && fault === 'kill')) try { process.kill(pid, 'SIGCONT'); } catch { /* gone */ }
      busy = false;
    };
    void land();
  });
  let r;
  for (let tries = 0; ; tries++) {
    r = await new Promise((resolve) => {
      const child = spawn(path.join(HOME, '.local', 'bin', 'svall'), ['robot', 'move', robot, '--machine', machine, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      let timer;
      if (fault === 'drop') timer = setTimeout(() => { summary.capped = true; child.kill('SIGKILL'); }, Number(o.cap ?? 300) * 1000);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    if (summary.moveId || !/catching up/.test(r.stderr) || tries >= 30) break;
    await sleep(1000);
  }
  // a fault that is landing finishes before the move is read back
  while (busy) await sleep(10);
  watcher.close();
  if (summary.drop) summary.restore = await link('restore');
  Object.assign(summary, { exit: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim(), ms: Date.now() - t0 });
  const phase = summary.moveId && readJson(path.join(dir, `${summary.moveId}.json`))?.phase;
  if (phase && summary.phases.at(-1) !== phase) summary.phases.push(phase);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

// RFC 6902 add, replace and remove, which are the ops the daemon's state patches hold
function applyOp(doc, op) {
  const keys = op.path.split('/').slice(1).map((k) => k.replaceAll('~1', '/').replaceAll('~0', '~'));
  const key = keys.pop();
  let parent = doc;
  for (const k of keys) { parent = parent?.[k]; if (parent === undefined || parent === null) return; }
  if (op.op === 'remove' && Array.isArray(parent)) parent.splice(Number(key), 1);
  else if (op.op === 'remove') delete parent[key];
  else if (op.op === 'add' && Array.isArray(parent)) parent.splice(key === '-' ? parent.length : Number(key), 0, op.value);
  else if (op.op === 'add' || op.op === 'replace') parent[key] = op.value;
}

/** The robot's agent as the daemon's API shows it: once at connect, then after each change to it, one JSON line each. */
async function watch(o) {
  const id = o._[0];
  const end = Date.now() + Number(o.for ?? 120) * 1000;
  const say = (v) => fs.appendFileSync(o.out, `${JSON.stringify({ ms: Date.now(), ...v })}\n`);
  while (Date.now() < end) {
    let port;
    let token;
    try { port = Number(fs.readFileSync(path.join(FLEET, 'port'), 'utf8')); token = fs.readFileSync(path.join(FLEET, 'token'), 'utf8').trim(); } catch { await sleep(10); continue; }
    const closed = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const doc = { robots: {} };
      let state = 'hello';
      let last;
      const show = () => {
        const now = JSON.stringify(agentOf(doc.robots[id]));
        if (now !== last) { last = now; say({ agent: JSON.parse(now) }); }
      };
      const timer = setTimeout(() => ws.close(), Math.max(0, end - Date.now()));
      ws.onerror = () => {};
      ws.onclose = () => { clearTimeout(timer); resolve(state); };
      ws.onopen = () => ws.send(JSON.stringify({ token }));
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (state === 'hello') { state = 'asked'; ws.send(JSON.stringify({ id: 1, method: 'state.get', params: {} })); return; }
        if (state === 'asked' && msg.id === 1) { doc.robots[id] = msg.result?.robots?.[id] ?? null; state = 'live'; say({ connected: true }); show(); return; }
        if (state === 'live' && msg.event === 'state.patch') {
          for (const op of msg.data.ops) if (op.path === `/robots/${id}` || op.path.startsWith(`/robots/${id}/`)) applyOp(doc, op);
          show();
        }
      };
    });
    if (closed === 'live') say({ disconnected: true });
    else await sleep(10);
  }
}

/** Root on the remote: `drop` stops every packet to and from sshd's port, `restore` lets them through again. */
function serveLink(port) {
  const rules = [['INPUT', '--dport'], ['OUTPUT', '--sport']];
  const apply = (op) => { for (const [chain, dir] of rules) run('iptables', [op, chain, '-p', 'tcp', dir, '22', '-j', 'DROP']); };
  net.createServer((sock) => {
    readline.createInterface({ input: sock }).once('line', (cmd) => {
      if (cmd === 'drop') apply('-I');
      else if (cmd === 'restore') { for (let i = 0; i < 4; i++) apply('-D'); }
      sock.end(`${cmd} ${run('iptables', ['-S']).split('\n').filter((l) => l.includes('DROP')).length}\n`);
    });
  }).listen(Number(port), '0.0.0.0');
}

const [cmd, ...rest] = process.argv.slice(2);
const o = flags(rest);
if (cmd === 'machines') process.stdout.write(`${JSON.stringify((await settled(() => rpc('state.get'))).machines ?? {})}\n`);
else if (cmd === 'snap') await snap(o);
else if (cmd === 'drive' && ['move', 'return'].includes(o._[0])) await driveMove(o);
else if (cmd === 'drive') await drive(o);
else if (cmd === 'watch') await watch(o);
else if (cmd === 'link') serveLink(o._[0] ?? 7070);
else { process.stderr.write(`unknown command ${cmd}\n`); process.exit(2); }
