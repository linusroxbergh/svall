// What the integration drivers share: the command line, the run log, docker, the two machines and each step's checks.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function flags(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`bad argument ${argv[i]}`);
    const k = argv[i].slice(2);
    o[k] = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i];
  }
  return o;
}

export const lines = (text) => text.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const brief = (v) => JSON.stringify(v)?.slice(0, 600);

/**
 * One run writing to `out`: what it says goes to stdout and run.log, and every docker command with its output to
 * run.log. A step collects the checks that fail in it and throws once it ends with any.
 */
export function harness(out) {
  fs.mkdirSync(out, { recursive: true });
  // written synchronously: spawnSync holds the event loop, so a stream would flush only when the run ends
  const RUN_LOG = path.join(out, 'run.log');
  fs.writeFileSync(RUN_LOG, '');
  const log = (text) => fs.appendFileSync(RUN_LOG, text);

  const t0 = Date.now();
  const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
  const say = (line) => { process.stdout.write(`${stamp()} ${line}\n`); log(`${stamp()} ${line}\n`); };

  function docker(args, opts = {}) {
    const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts });
    log(`$ docker ${args.map((a) => (a.length > 200 ? `${a.slice(0, 200)}…` : a)).join(' ')}\n${r.stdout ?? ''}${r.stderr ?? ''}[exit ${r.status}]\n`);
    if (r.error) throw r.error;
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  let failures = [];
  function check(label, ok, detail) {
    if (!ok) failures.push(`${label}: ${typeof detail === 'function' ? detail() : detail}`);
    return ok;
  }

  function step(name, fn) {
    say(`== ${name}`);
    failures = [];
    const value = fn();
    if (failures.length) {
      for (const f of failures) say(`   FAIL ${f}`);
      throw new Error(`${name}: ${failures.length} check(s) failed`);
    }
    say('   PASS');
    return value;
  }

  /** Waits for a container's systemd to finish booting, which takes minutes on an emulated machine. */
  function booted(machine) {
    for (let i = 0; ; i++) {
      const state = docker(['exec', machine, 'systemctl', 'is-system-running']).stdout.trim();
      if (state === 'running') return;
      if (i > 600) throw new Error(`${machine}: systemd is ${state}, not running: ${docker(['exec', machine, 'systemctl', '--failed', '--no-legend']).stdout}`);
      spawnSync('sleep', ['0.5']);
    }
  }

  return { log, say, docker, check, step, booted };
}

/**
 * The two machines a run named `prefix` makes, their network, and their accounts' homes: local's where a Mac's is, remote's
 * where Linux's is. `sh` is a login shell on one, as svall unless `root`; it throws on a nonzero exit unless `ok: false`.
 */
export function machines(prefix, docker) {
  const L = `${prefix}-local`;
  const R = `${prefix}-remote`;
  const HOMES = { [L]: '/Users/svall', [R]: '/home/svall' };
  const userEnv = (machine) => [`HOME=${HOMES[machine]}`, 'USER=svall', 'LOGNAME=svall', 'XDG_RUNTIME_DIR=/run/user/1000',
    'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus', 'LANG=C.UTF-8'].flatMap((e) => ['-e', e]);
  function sh(machine, script, opts = {}) {
    const who = opts.root ? [] : ['-u', 'svall', '-w', HOMES[machine], ...userEnv(machine)];
    const r = docker(['exec', '-i', ...who, machine, 'bash', '-lc', script], { input: opts.input ?? '' });
    if (opts.ok !== false && r.code !== 0) throw new Error(`${machine}: ${script.slice(0, 120)} exited ${r.code}: ${r.stderr.trim().slice(-800)}`);
    return r;
  }
  return { L, R, NET: `${prefix}-it`, HOMES, sh };
}
