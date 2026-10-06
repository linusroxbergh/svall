// The in-machine half of the fleet handover integration run, run inside each container with the release's own node:
//
//   snap [--gateway <fleetId>]            one JSON document: this machine's view of the fleet, its repos, sessions,
//                                         terminals, agent processes and OpenCode servers (and, on the gateway, its record)
//   drive <host|local> [--fault kill|drop --at begin|transfer|ready|commit|activate] --log <file> [--cap <s>]
//                                         runs `svall handover <host|local> --json`, injects the fault at that boundary,
//                                         and prints what happened as one JSON document
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
const MOCK = '/opt/it/claude.mjs';
const OPENCODE = '/opt/it/opencode.mjs';
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

/** Each process whose command line holds `needle`, with its arguments and working folder. */
function processes(needle) {
  const out = [];
  for (const pid of fs.readdirSync('/proc').filter((f) => /^\d+$/.test(f))) {
    let args;
    try { args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { continue; }
    if (!args.some((a) => a.includes(needle))) continue;
    let cwd = null;
    try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { /* gone */ }
    out.push({ pid: Number(pid), args, cwd });
  }
  return out;
}

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
  const listed = run('tmux', ['-S', path.join(FLEET, 'tmux.sock'), 'list-windows', '-a', '-F', '#{window_name}|#{pane_pid}|#{pane_current_command}']);
  // a machine that let the fleet go runs no tmux server for it at all
  const windows = (/^ERROR \d+: no server running/.test(listed) ? '' : listed)
    .split('\n').filter(Boolean).map((l) => { const [name, pid, command] = l.split('|'); return { name, pid: Number(pid), command }; });
  const controller = path.join(FLEET, 'controller', 'handover.json');
  const fleet = JSON.parse(fs.readFileSync(path.join(FLEET, 'fleet.json'), 'utf8'));
  const out = {
    machineId: info.machineId ?? null,
    info,
    ownership: await settled(() => rpc('ownership.get')),
    handover: await settled(() => rpc('handover.status')),
    fleet: { id: fleet.id, gatewayMachineId: fleet.gatewayMachineId, handoverEnabled: fleet.handover?.enabled },
    characters: state.characters ? Object.values(state.characters).map((c) => ({
      id: c.id, name: c.name, cwd: c.cwd, islandId: c.islandId, tmux: c.tmux ?? null, revive: c.revive ?? null,
      agent: c.agent ? { kind: c.agent.kind, sessionId: c.agent.sessionId, status: c.agent.status, pid: c.agent.pid ?? null } : null,
    })).sort((a, b) => a.id.localeCompare(b.id)) : state,
    windows,
    agents: [
      ...processes(MOCK).filter((p) => !p.args.includes('--version') && !p.args.includes('auth')).map((p) => ({ kind: 'claude', ...p })),
      ...processes(OPENCODE).filter((p) => !['serve', 'session', 'auth', 'run', '--version', '--help'].includes(p.args[2])).map((p) => ({ kind: 'opencode', ...p })),
    ],
    servers: processes(OPENCODE).filter((p) => p.args[2] === 'serve').map((p) => ({ ...p, ppid: ppidOf(p.pid) })),
    controllerJournal: fs.existsSync(controller) ? JSON.parse(fs.readFileSync(controller, 'utf8')) : null,
    git: Object.fromEntries(REPOS.map((r) => [r, gitOf(path.join(HOME, r))])),
    trees: Object.fromEntries(REPOS.map((r) => [r, walk(path.join(HOME, r), new Set(['.git']))])),
    sessions: sessions(),
    opencode: opencodeSessions(),
  };
  if (o.gateway) {
    const said = run(path.join(HOME, '.local', 'bin', 'svall'), ['gateway', 'owner', 'get', '--fleet', o.gateway]).trim().split('\n').at(-1);
    try { out.gateway = JSON.parse(said); } catch { out.gateway = { error: said }; }
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

/** The process table of one session: each process's pid and arguments. */
function session(sid) {
  const out = [];
  for (const pid of fs.readdirSync('/proc').filter((f) => /^\d+$/.test(f))) {
    let stat;
    try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { continue; }
    // the fields after the command name, which may itself hold spaces and parentheses
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(rest[3]) !== sid) continue;
    let args;
    try { args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { continue; }
    out.push({ pid: Number(pid), args });
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
 * a kill during the transfer takes its whole session, rsync and ssh with it, as a crash of the machine would.
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
      const hit = session(child.pid).find((p) => MARKS[at](p.args));
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
      process.kill(at === 'transfer' ? -child.pid : child.pid, 'SIGKILL');
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
if (cmd === 'snap') await snap(o);
else if (cmd === 'drive') await drive(o);
else if (cmd === 'link') serveLink(o._[0] ?? 7070);
else { process.stderr.write(`unknown command ${cmd}\n`); process.exit(2); }
