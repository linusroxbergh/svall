// The fleet handover benchmark, driven from the host through docker on the two containers the integration run left:
//
//   node scripts/bench/handover.mjs --out <dir> [--repos small,large,many] [--files <n>] [--large-mib <n>] [--keep] [--flood]
//                                   [--prefix <name>]
//
// For each repository it makes the repository on the machine that owns the fleet with a shell character in it, hands
// the fleet over (first), changes ten files and adds one on the new owner and hands it back (incremental), does that
// again (incremental), then closes the character and hands the fleet back with only the integration fixture
// (fixture). Each handover records its wall time and phases, the controller's event stream, the peak RSS of the
// controller, both daemons and every rsync, the messages the manifest travels in, and the Mac's power state.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flags, harness } from '../integration/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const o = flags(process.argv.slice(2));
// apart from an integration run's machines, which are svall-local and svall-remote
const prefix = o.prefix ?? 'svall-bench';
const L = `${prefix}-local`;
const R = `${prefix}-remote`;
const NET = `${prefix}-it`;
const HOME = '/home/svall';
const NODE = '/opt/it/node/bin/node';
const BENCH = '/opt/it/bench.mjs';
const USER_ENV = ['HOME=/home/svall', 'USER=svall', 'LOGNAME=svall', 'XDG_RUNTIME_DIR=/run/user/1000',
  'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus', 'LANG=C.UTF-8'].flatMap((e) => ['-e', e]);

if (!o.out) throw new Error('--out <dir> is required');
const out = path.resolve(o.out);
const repos = o.repos === 'none' ? [] : String(o.repos ?? 'small,large,many').split(',');
const { say, docker } = harness(out);

function sh(machine, script, opts = {}) {
  const who = opts.root ? [] : ['-u', 'svall', '-w', HOME, ...USER_ENV];
  const r = docker(['exec', '-i', ...who, machine, 'bash', '-lc', script], { input: '' });
  if (opts.ok !== false && r.code !== 0) throw new Error(`${machine}: ${script.slice(0, 120)} exited ${r.code}: ${r.stderr.trim().slice(-800)}`);
  return r;
}
// the last line of NDJSON, or a whole document `svall --json` prints indented
const json = (machine, script) => {
  const text = sh(machine, script).stdout.trim();
  try { return JSON.parse(text); } catch { return JSON.parse(text.split('\n').at(-1)); }
};
const bench = (machine, args) => json(machine, `${NODE} ${BENCH} ${args}`);

/** The Mac's charge and thermal state, which says whether a run may have been throttled; nothing elsewhere. */
function power() {
  if (process.platform !== 'darwin') return null;
  const read = (what) => spawnSync('pmset', ['-g', what], { encoding: 'utf8' }).stdout.trim().replace(/\s+/g, ' ');
  return { batt: read('batt'), therm: read('therm'), load: spawnSync('sysctl', ['-n', 'vm.loadavg'], { encoding: 'utf8' }).stdout.trim() };
}

const ids = {};
const other = (m) => (m === L ? R : L);
const hostOf = (m) => (m === L ? 'local' : 'remote');

function owner() {
  const own = json(L, `${NODE} /opt/it/machine.mjs snap`).ownership.ownerMachineId;
  return own === ids[L] ? L : R;
}

const rows = [];

/** One handover from `from`, measured on both machines. */
function measure(from, label, kind, run) {
  const to = other(from);
  const stop = `/tmp/bench/stop-${label}`;
  const start = {};
  for (const m of [L, R]) {
    sh(m, 'mkdir -p /tmp/bench');
    start[m] = bench(m, 'daemon reset').rssKiB;
    if (docker(['exec', '-d', '-u', 'svall', ...USER_ENV, m, NODE, BENCH, 'watch', stop]).code !== 0) throw new Error(`the watch on ${m} did not start`);
  }
  const before = power();
  const r = bench(L, `run ${hostOf(to)} --log /tmp/bench/${label}.ndjson`);
  const after = power();
  const far = {};
  const daemons = {};
  for (const m of [L, R]) {
    sh(m, `touch ${stop} && for i in $(seq 50); do [ -s ${stop}.json ] && break; sleep 0.2; done`);
    far[m] = JSON.parse(sh(m, `cat ${stop}.json`).stdout);
    daemons[m] = { ...bench(m, 'daemon read'), startKiB: start[m] };
  }
  fs.writeFileSync(path.join(out, `${label}.ndjson`), sh(L, `cat /tmp/bench/${label}.ndjson`).stdout);
  const row = { label, kind, run, from: hostOf(from), to: hostOf(to), ...r, source: daemons[from], destination: daemons[to], rsync: { [hostOf(L)]: far[L], [hostOf(R)]: far[R] }, power: { before, after } };
  rows.push(row);
  fs.writeFileSync(path.join(out, 'bench.json'), `${JSON.stringify(rows, null, 1)}\n`);
  say(`   ${label}: ${r.status} in ${(r.ms / 1000).toFixed(1)} s; controller ${mib(nodeOf(r.controller))}, source daemon ${mib(row.source.hwmKiB)}, destination daemon ${mib(row.destination.hwmKiB)}; ${r.events.count} events, ${kb(r.events.bytes)}; prepare ${r.messages ? mb(r.messages.prepare) : '-'}`);
  if (r.status !== 'complete') throw new Error(`${label} ended ${r.status}: ${r.error ?? JSON.stringify(r.blockers)?.slice(0, 600)}`);
  return to;
}

// node 24 names its main thread, which is what /proc reports for the process
const nodeOf = (peaks) => Math.max(peaks.MainThread ?? 0, peaks.node ?? 0);
// a daemon's peak, and how far above what it held when the handover began
const grew = (d) => `${(d.hwmKiB / 1024).toFixed(0)} (+${((d.hwmKiB - (d.startKiB ?? d.hwmKiB)) / 1024).toFixed(0)})`;
// the charge, power source, thermal state and one-minute load of the Mac at a run's start
const quiet = (therm) => /No thermal warning level has been recorded/.test(therm) && /No performance warning level has been recorded/.test(therm);
const charge = (p) => (p ? `${/(\d+)%/.exec(p.batt)?.[1] ?? '?'}% ${p.batt.includes('AC Power') ? 'AC' : 'battery'}${quiet(p.therm) ? '' : ', thermal or performance warning'}, load ${/[\d.]+/.exec(p.load ?? '')?.[0] ?? '?'}` : '-');
const mib = (kib) => (kib === undefined ? '-' : `${(kib / 1024).toFixed(0)} MiB`);
const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
const kb = (b) => `${(b / 1e3).toFixed(1)} kB`;

function island() {
  const listed = json(L, 'svall --json island list');
  const found = listed.find((i) => i.name === 'bench');
  return found?.id ?? json(L, 'svall --json island create bench').id;
}

function repoRun(kind, isl) {
  let at = owner();
  const dir = `${HOME}/bench/${kind}`;
  const made = bench(at, `repo ${kind} ${dir}${o.files ? ` --files ${o.files}` : ''}${o['large-mib'] ? ` --large-mib ${o['large-mib']}` : ''}`);
  say(`   ${kind}: ${made.tracked} tracked files at ${dir} on ${hostOf(at)}`);
  const id = json(L, `svall --json char new --island ${isl} --cwd ${dir} --name bench-${kind}`).id;
  sh(L, 'sleep 2');
  at = measure(at, `${kind}-1-first`, kind, 'first');
  bench(at, `touch ${dir} 10`);
  at = measure(at, `${kind}-2-incremental`, kind, 'incremental');
  bench(at, `touch ${dir} 10`);
  at = measure(at, `${kind}-3-incremental`, kind, 'incremental');
  sh(L, `svall char close ${id}`);
  measure(at, `${kind}-4-fixture`, kind, 'fixture');
}

function flood(isl) {
  const at = owner();
  const id = json(L, `svall --json char new --island ${isl} --cwd ${HOME} --name bench-flood`).id;
  sh(L, 'sleep 2');
  const r = bench(at, `flood ${id} --seconds ${o.seconds ?? 20}`);
  sh(L, `svall char close ${id}`);
  fs.writeFileSync(path.join(out, 'flood.json'), `${JSON.stringify({ ...r, machine: hostOf(at), power: power() }, null, 1)}\n`);
  say(`   flood on ${hostOf(at)}: daemon RSS ${mib(r.startKiB)} -> peak ${mib(r.peakKiB)} over ${r.seconds} s; the viewer read ${mb(r.receivedBeforePause)} in the second before it stopped, and ${mb(r.receivedAfter)} after`);
}

function table() {
  const head = ['run', 'wall s', 'preflight s', 'freeze s', 'transfer s', 'prepare s', 'activate s', 'controller MiB', 'source MiB', 'destination MiB',
    'rsync MiB (local/remote)', 'events', 'event kB', 'manifest MB', 'prepare MB', 'largest frame MB', 'largest record MB', 'IO stall s', 'Mac'];
  const s = (ms) => (ms === undefined || ms === null ? '-' : (ms / 1000).toFixed(1));
  const body = rows.map((r) => [
    `${r.label} ${r.from}→${r.to}`, s(r.ms), s(r.span.preflight), s(r.span.freeze), s(r.span.transfer), s(r.span.prepare), s(r.span.activate),
    (nodeOf(r.controller) / 1024).toFixed(0), grew(r.source), grew(r.destination),
    `${((r.rsync.local?.rsync ?? 0) / 1024).toFixed(0)}/${((r.rsync.remote?.rsync ?? 0) / 1024).toFixed(0)}`,
    r.events.count, (r.events.bytes / 1e3).toFixed(1), r.messages ? (r.messages.freezeAnswer / 1e6).toFixed(1) : '-',
    r.messages ? (r.messages.prepare / 1e6).toFixed(1) : '-', r.frames ? (r.frames.largest / 1e6).toFixed(1) : '-', (r.destination.largestRecord / 1e6).toFixed(1),
    r.stall?.ioS ?? '-', charge(r.power.before),
  ]);
  return [head, head.map(() => '---'), ...body].map((cells) => `| ${cells.join(' | ')} |`).join('\n');
}

let code = 0;
try {
  say(`logs in ${out}`);
  const [cpus, memory, arch] = docker(['info', '--format', '{{.NCPU}} {{.MemTotal}} {{.Architecture}}']).stdout.trim().split(' ');
  say(`   docker: ${cpus} CPUs and ${(Number(memory) / 2 ** 30).toFixed(1)} GiB for both machines, ${arch}`);
  const heapLimit = {};
  for (const m of [L, R]) {
    if (docker(['cp', path.join(HERE, 'machine.mjs'), `${m}:${BENCH}`]).code !== 0) throw new Error(`${m} is not running; run without --reuse first`);
    sh(m, `chmod a+r ${BENCH}`, { root: true });
    ids[m] = json(m, 'svall version --json').machineId;
    heapLimit[hostOf(m)] = bench(m, 'info').heapLimit;
  }
  // as the source's preflight bounds it: half the smaller daemon heap at 8 KiB a file
  const mostFiles = Math.floor(Math.min(...Object.values(heapLimit)) / 2 / 8192);
  fs.writeFileSync(path.join(out, 'host.json'), `${JSON.stringify({ dockerCpus: Number(cpus), dockerMemory: Number(memory), arch, heapLimit, mostFiles, power: power() }, null, 1)}\n`);
  say(`   daemon heaps: local ${mib(heapLimit.local / 1024)}, remote ${mib(heapLimit.remote / 1024)}; a handover carries at most ${mostFiles} files`);
  const isl = island();
  for (const kind of repos) {
    say(`== ${kind}`);
    repoRun(kind, isl);
  }
  if (o.flood) {
    say('== flood');
    flood(isl);
  }
  fs.writeFileSync(path.join(out, 'bench.md'), `${table()}\n`);
  say(`\n${table()}`);
} catch (e) {
  say(`FAILED: ${e.message}`);
  code = 1;
} finally {
  if (!o.keep) {
    for (const m of [L, R]) docker(['rm', '-f', m]);
    docker(['network', 'rm', NET]);
  }
}
process.exitCode = code;
