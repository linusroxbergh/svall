// A fresh install of the Linux companion, provisioned as a user does it, driven from the host through docker:
//
//   node scripts/integration/fresh-install.mjs --release <dir> --upgrade <dir> --arch x64|arm64
//                                              [--image <tag>] [--out <dir>] [--keep]
//
// Each folder holds one release as scripts/release-build.sh writes it: the controller tree the app carries, packed, and
// the companion archives its manifest pins. The controller runs here, on this host, from that tree, with a home of its
// own; the machine is a clean Ubuntu 24.04 container with systemd and sshd, an account at the controller's home path
// and no Node. The run adds the machine with the first release (`svall host add`), turns lingering on as host add
// asks, gives it a second fleet (`svall host enable`), checks the units run that release and nothing else, upgrades to
// the second release (`svall host upgrade`), then goes back with `svall setup --rollback` on the machine, checking the
// units each time. A release that pins its companion on this host's loopback is served from its folder and downloaded,
// as the app does; any other is named by path with --release.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brief, flags, harness, lines } from './harness.mjs';

const M = 'svall-fresh';
const USER = 'svall';
const FLEET = 'work';
// host add starts the private fleet's daemon and the gateway; host enable adds the second fleet's
const ADDED = ['svall-svalld@private.service', 'svall-gateway.service'];
const UNITS = [...ADDED, `svall-svalld@${FLEET}.service`];
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+\//;

const o = flags(process.argv.slice(2));
if (!o.release || !o.upgrade || !['x64', 'arm64'].includes(o.arch)) throw new Error('--release <dir>, --upgrade <dir> and --arch x64|arm64 are required');
const image = o.image ?? 'svall-it:machine';
const out = o.out ? path.resolve(o.out) : fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-install-'));
const { log, say, docker, check, step, booted } = harness(out);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-fresh-'));
// the controller's own home, which the machine's account shares: short, as the gateway's socket lives under it and a
// unix socket's path holds at most 108 bytes, and not under /tmp, which the machine empties when it starts again
const HOME = fs.mkdtempSync('/var/tmp/h');
const PREFIX = `${HOME}/.local/share/svall`;
const SSH_DIR = path.join(work, 'ssh');
const BIN = path.join(work, 'bin');

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function one(dir, re) {
  const found = fs.readdirSync(dir).filter((f) => re.test(f));
  if (found.length !== 1) throw new Error(`${dir} holds ${found.length} files like ${re}, not one`);
  return path.join(dir, found[0]);
}

/**
 * One release: its companion for this machine, and the controller tree unpacked as the app carries it. A tree built for
 * this host runs through its own shim and Node; one that is not (the Mac's, on a Linux runner) runs its bundled `svall`
 * on this process's Node.
 */
function release(dir, name) {
  const packed = one(dir, /^svall-controller-.+\.tar\.gz$/);
  const unpacked = path.join(work, name);
  fs.mkdirSync(unpacked);
  spawnSync('tar', ['-xzf', packed, '-C', unpacked], { stdio: 'inherit' });
  const [version] = fs.readdirSync(path.join(unpacked, 'releases'));
  const root = path.join(unpacked, 'releases', version);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
  const companion = one(dir, new RegExp(`^svall-companion-${version.replace(/[.+]/g, '\\$&')}-linux-${o.arch}\\.tar\\.gz$`));
  const url = manifest.companions?.[`linux-${o.arch}`]?.url;
  return {
    name, version, root, manifest, companion, packed, url,
    served: typeof url === 'string' && LOOPBACK.test(url),
    native: manifest.platform === `${process.platform}-${process.arch}`,
    unsigned: manifest.unsigned === true,
  };
}

const ENV = {
  HOME, USER: process.env.USER ?? 'builder', LOGNAME: process.env.USER ?? 'builder', LANG: 'C.UTF-8',
  PATH: `${BIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
};

function spawnLogged(label, exe, args, env = ENV) {
  const r = spawnSync(exe, args, { env, encoding: 'utf8', timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  log(`$ ${label} ${args.join(' ')}\n${r.stdout ?? ''}${r.stderr ?? ''}[exit ${r.status ?? r.signal}]\n`);
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** `svall` from a release's controller tree, as the app runs it, in the controller's home. */
function svall(rel, ...args) {
  return rel.native
    ? spawnLogged(`${rel.name} svall`, path.join(rel.root, 'bin', 'svall'), args)
    : spawnLogged(`${rel.name} svall`, process.execPath, [path.join(rel.root, 'lib', 'svall.mjs'), ...args], { ...ENV, SVALL_RELEASE_ROOT: rel.root });
}

/** A command on the machine as its user runs it over ssh. */
const ssh = (...args) => spawnLogged('ssh fresh', path.join(BIN, 'ssh'), ['fresh', '--', ...args]);

/** A shell on the machine, as root or, with `uid`, as the account beside its user manager, with no login of its own. */
function root(script, opts = {}) {
  const as = opts.uid ? ['-u', USER, '-w', HOME, '-e', `HOME=${HOME}`, '-e', `XDG_RUNTIME_DIR=/run/user/${opts.uid}`] : [];
  const r = docker(['exec', '-i', ...as, M, 'bash', '-c', script], { input: opts.input ?? '' });
  if (opts.ok !== false && r.code !== 0) throw new Error(`${M}: ${script.slice(0, 120)} exited ${r.code}: ${r.stderr.trim().slice(-800)}`);
  return r;
}

const save = (name, text) => fs.writeFileSync(path.join(out, name), text);

const SERVER = `
const fs = require('node:fs');
const routes = JSON.parse(process.argv[1]);
require('node:http').createServer((req, res) => {
  const file = routes[req.url];
  fs.appendFileSync(process.argv[3], req.method + ' ' + req.url + ' ' + (file ? 200 : 404) + '\\n');
  if (!file) return res.writeHead(404).end();
  res.writeHead(200, { 'content-length': fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
}).listen(Number(process.argv[2]), '127.0.0.1', () => process.stdout.write('listening\\n'));
`;

/** Serves each companion a release pins on this host's loopback, from a child process, as this one blocks in spawnSync. */
async function serve(rels) {
  const served = rels.filter((r) => r.served);
  if (!served.length) return undefined;
  const ports = [...new Set(served.map((r) => new URL(r.url).port))];
  if (ports.length !== 1) throw new Error(`the releases pin their companions on ${ports.length} loopback ports, not one`);
  const routes = Object.fromEntries(served.map((r) => [new URL(r.url).pathname, r.companion]));
  const child = spawn(process.execPath, ['-e', SERVER, JSON.stringify(routes), ports[0], path.join(out, 'served.log')], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('exit', (c) => reject(new Error(`the server for ${served.map((r) => r.url).join(', ')} exited ${c}`)));
  });
  for (const r of served) say(`   serving ${r.url}`);
  return child;
}

// what printResult prints, indented over many lines
const json = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
let uid;

// ---------------------------------------------------------------------------------------------- the machine

function controller(rels) {
  for (const rel of rels) {
    const pinned = rel.manifest.companions?.[`linux-${o.arch}`];
    check(`${rel.name} pins the companion`, pinned?.sha256 === sha256(rel.companion) && pinned.url.endsWith(`/${path.basename(rel.companion)}`),
      () => `${brief(pinned)} for ${path.basename(rel.companion)} ${sha256(rel.companion)}`);
    say(`   ${rel.name}: ${rel.version} (${rel.manifest.platform}${rel.unsigned ? ', unsigned' : ', signed'}), ${rel.native ? 'its own shim and Node' : `its svall.mjs on this host's Node ${process.version}`}`);
  }
  check('two releases', rels[0].version !== rels[1].version, 'the upgrade has the same version');
}

function machine() {
  docker(['rm', '-f', M]);
  const r = docker(['run', '-d', '--name', M, '--hostname', M, '--privileged', '--cgroupns=private', '--tmpfs', '/run', '--tmpfs', '/run/lock',
    '-p', '127.0.0.1::22', image]);
  if (r.code !== 0) throw new Error(`${M} did not start: ${r.stderr}`);
  booted(M);
  const uname = root('uname -m').stdout.trim();
  check('architecture', { aarch64: 'arm64', x86_64: 'x64' }[uname] === o.arch, `${uname} is not ${o.arch}`);

  // the account a user makes for a fleet: its home is the controller's, and it logs in with a key
  fs.mkdirSync(SSH_DIR, { mode: 0o700 });
  fs.mkdirSync(BIN);
  fs.chmodSync(HOME, 0o700);
  spawnLogged('ssh-keygen', 'ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'fresh-install', '-f', path.join(SSH_DIR, 'id_ed25519')]);
  root(`mkdir -p "$(dirname '${HOME}')" && useradd -m -d '${HOME}' -s /bin/bash ${USER} && usermod -p '*' ${USER}
    install -d -m 700 -o ${USER} -g ${USER} '${HOME}/.ssh' && install -m 600 -o ${USER} -g ${USER} /dev/stdin '${HOME}/.ssh/authorized_keys'`,
  { input: fs.readFileSync(path.join(SSH_DIR, 'id_ed25519.pub'), 'utf8') });

  uid = root(`id -u ${USER}`).stdout.trim();
  const clean = `${root('find / -xdev -type f -name node 2>/dev/null; ls /var/lib/systemd/linger 2>/dev/null; true').stdout}${
    root('bash -lc "command -v node svall"; ls -A ~', { uid, ok: false }).stdout}`;
  check('clean machine', clean.trim().split('\n').sort().join(' ') === '.bash_logout .bashrc .profile .ssh', () => clean);
  reach();
  check('ssh', ssh('true').code === 0, 'the key login failed');
}

/** ssh from this host to the port docker published, reading nothing of the user's own ssh setup, only this run's files. */
function reach() {
  const port = /:(\d+)\s*$/m.exec(docker(['port', M, '22/tcp']).stdout)?.[1];
  if (!port) throw new Error('docker published no port for sshd');
  fs.writeFileSync(path.join(SSH_DIR, 'config'), [
    'Host fresh', '  HostName 127.0.0.1', `  Port ${port}`, `  User ${USER}`, `  IdentityFile ${SSH_DIR}/id_ed25519`, '  IdentitiesOnly yes',
    '  IdentityAgent none', `  UserKnownHostsFile ${SSH_DIR}/known_hosts`, '  GlobalKnownHostsFile /dev/null', '  StrictHostKeyChecking yes',
    '  CheckHostIP no', '  UpdateHostKeys no', '  BatchMode yes', '  LogLevel ERROR', '',
  ].join('\n'));
  const real = spawnSync('sh', ['-c', 'command -v ssh'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(BIN, 'ssh'), `#!/bin/sh\nexec '${real}' -F '${SSH_DIR}/config' "$@"\n`, { mode: 0o755 });
  for (let i = 0; ; i++) {
    const scan = spawnLogged('ssh-keyscan', 'ssh-keyscan', ['-p', port, '-t', 'ed25519', '127.0.0.1']);
    if (scan.stdout.includes('ssh-ed25519')) { fs.writeFileSync(path.join(SSH_DIR, 'known_hosts'), scan.stdout); break; }
    if (i > 60) throw new Error(`sshd on 127.0.0.1:${port} gave no host key`);
    spawnSync('sleep', ['1']);
  }
}

/** The machine starts again, and nobody logs in. */
function reboot() {
  if (docker(['restart', M]).code !== 0) throw new Error(`${M} did not restart`);
  booted(M);
  reach();
}

/** The release `current` names, where the shim leads, lingering, and what each unit runs. */
function inspect() {
  const said = root(`echo "linger	$(loginctl show-user ${USER} -p Linger --value)"
    echo "node	$(find / -xdev -type f -name node -not -path '${PREFIX}/releases/*' 2>/dev/null | tr '\\n' ' ')"
    echo "checkout	$(find / -xdev -name pnpm-workspace.yaml 2>/dev/null | tr '\\n' ' ')"`, { ok: false }).stdout
    + root(`echo "current	$(readlink '${PREFIX}/current')"
    echo "shim	$(readlink -f ~/.local/bin/svall)"
    echo "releases	$(ls '${PREFIX}/releases' | tr '\\n' ' ')"
    for u in ${UNITS.join(' ')}; do
      show() { systemctl --user show -p "$1" --value "$u"; }
      pid=$(show MainPID)
      echo "$u	$(show ActiveState)	$(show UnitFileState)	$pid	$(readlink /proc/$pid/exe)	$(tr '\\0' '\\n' < /proc/$pid/environ 2>/dev/null | sed -n 's/^SVALL_RELEASE_ROOT=//p')"
    done`, { uid, ok: false }).stdout;
  const kv = Object.fromEntries(said.split('\n').filter(Boolean).map((l) => { const [k, ...v] = l.split('\t'); return [k, v]; }));
  return {
    current: kv.current?.[0], shim: kv.shim?.[0], releases: kv.releases?.[0]?.trim().split(' ').filter(Boolean).sort(),
    linger: kv.linger?.[0], node: kv.node?.[0]?.trim(), checkout: kv.checkout?.[0]?.trim(),
    units: Object.fromEntries(UNITS.map((u) => [u, { active: kv[u]?.[0], enabled: kv[u]?.[1], pid: Number(kv[u]?.[2]), exe: kv[u]?.[3], root: kv[u]?.[4] }])),
  };
}

/** Both units up and enabled, each on `version`'s own Node and tree, and nothing else the machine could run instead. */
function runs(label, rel, releases) {
  const want = `${PREFIX}/releases/${rel.version}`;
  let s = inspect();
  // a restarted unit's process is replaced at once, but under emulation its tree takes a moment to come up
  for (let i = 0; i < 60 && UNITS.some((u) => s.units[u].active !== 'active' || !s.units[u].exe); i++) { spawnSync('sleep', ['1']); s = inspect(); }
  save(`${label}.machine.json`, `${JSON.stringify(s, null, 2)}\n`);
  check(`${label} current`, s.current === want, () => `${s.current}, not ${want}`);
  check(`${label} shim`, s.shim === `${want}/bin/svall`, () => s.shim);
  check(`${label} releases kept`, JSON.stringify(s.releases) === JSON.stringify([...releases].sort()), () => brief(s.releases));
  check(`${label} linger`, s.linger === 'yes', () => s.linger);
  check(`${label} no other node`, s.node === '', () => s.node);
  check(`${label} no checkout`, s.checkout === '', () => s.checkout);
  for (const u of UNITS) {
    const unit = s.units[u];
    check(`${label} ${u}`, unit.active === 'active' && unit.enabled === 'enabled' && unit.pid > 0, () => brief(unit));
    check(`${label} ${u} runs ${rel.version}`, unit.exe === `${want}/node/bin/node` && unit.root === want, () => brief(unit));
  }
}

// ---------------------------------------------------------------------------------------------- the provisioning

const ADVICE = new Set(['tmux', 'claude', 'codex', 'linger', 'service']);
const ADD_STEPS = ['name', 'ssh', 'master', 'os', 'home', 'tools', 'tmux', 'rsync', 'space', 'linger', 'release', 'upload', 'install', 'service',
  'identity', 'claude', 'codex', 'probe', 'registry'];

// with no --release the controller downloads the companion its manifest pins, checks its digest and caches it
const named = (rel) => (rel.served ? [] : ['--release', rel.companion, ...(rel.unsigned ? ['--allow-unsigned'] : [])]);
const from = (rel) => `${rel.version} for linux-${o.arch} from ${rel.served ? rel.url : 'the archive you named'}${rel.unsigned ? ' (unsigned)' : ''}`;

function downloaded(rel, label) {
  if (!rel.served) return;
  const file = path.join(HOME, '.local/share/svall/companions', path.basename(new URL(rel.url).pathname));
  check(`${label} downloaded`, fs.existsSync(file) && sha256(file) === sha256(rel.companion), () => `${file} is not the pinned companion`);
}

function hostAdd(a) {
  const r = svall(a, 'host', 'add', 'fresh', '--ssh', 'fresh', ...named(a), '--json');
  save('host-add.ndjson', r.stdout);
  const events = lines(r.stdout);
  const steps = events.filter((e) => e.step && e.status !== 'start');
  // a fresh machine has no agents yet, lingering off and Ubuntu's tmux 3.4: each is something to go and do
  for (const s of steps) check(`host add ${s.step}`, s.status === 'ok' || (s.status === 'warn' && ADVICE.has(s.step)), () => `${s.status}: ${s.detail ?? ''} ${s.action ?? ''}`);
  check('host add steps', JSON.stringify(steps.map((s) => s.step)) === JSON.stringify(ADD_STEPS), () => brief(steps.map((s) => s.step)));
  const at = (name) => steps.find((s) => s.step === name);
  const lingerOn = `ssh fresh, then loginctl enable-linger ${USER}`;
  check('host add linger', at('linger')?.status === 'warn' && at('linger').action === lingerOn, () => brief(at('linger')));
  // the units run, and the service step warns only that they stop at logout
  check('host add service', at('service')?.action === lingerOn && ADDED.every((u) => at('service').detail?.includes(`${u}: loaded, active (running), enabled`)),
    () => brief(at('service')));
  check('host add release', at('release')?.detail === from(a), () => brief(at('release')));
  downloaded(a, 'host add');
  check('host add home', at('home')?.detail === `${HOME} for ${USER}`, () => brief(at('home')));
  const result = events.at(-1);
  check('host add result', result?.result === 'actions'
    && JSON.stringify(result.actions) === JSON.stringify([lingerOn, 'ssh fresh, then install Claude Code', 'ssh fresh, then install Codex']), () => brief(result));
}

function linger() {
  // the action host add named, as the user takes it on the machine
  root(`loginctl enable-linger ${USER}`);
}

/** A second fleet whose gateway the machine is, as a handover moves one: its own daemon's unit on the machine. */
function enable(a) {
  const home = path.join(HOME, `.svall-${FLEET}`);
  fs.mkdirSync(home, { mode: 0o700 });
  fs.writeFileSync(path.join(home, 'fleet.json'), `${JSON.stringify({ id: crypto.randomUUID() })}\n`);
  const r = svall(a, 'host', 'enable', 'fresh', '--fleet', FLEET, '--json');
  save('host-enable.ndjson', r.stdout);
  const events = lines(r.stdout);
  const fleet = events.find((e) => e.step === 'fleet' && e.status !== 'start');
  check('host enable result', events.at(-1)?.result === 'ready' && r.code === 0, () => brief(events.at(-1)));
  check('host enable fleet', fleet?.status === 'ok' && fleet.detail?.includes(`under ${UNITS[2]}`), () => brief(fleet));
}

function doctor(rel, label) {
  const r = svall(rel, 'host', 'doctor', 'fresh', '--json');
  save(`${label}.doctor.json`, r.stdout);
  const report = json(r.stdout) ?? {};
  const checks = Object.fromEntries((report.checks ?? []).map((c) => [c.name, c]));
  check(`${label} doctor fails nothing`, (report.checks ?? []).length > 0 && !report.checks.some((c) => c.status === 'fail'), () => brief(report));
  for (const name of ['systemd', 'gateway', 'linger', 'svalld', 'release', 'home']) {
    check(`${label} doctor ${name}`, checks[name]?.status === 'ok', () => brief(checks[name]));
  }
  check(`${label} doctor release`, checks.release?.detail?.startsWith(`${rel.version}, protocol`), () => brief(checks.release));
}

function upgrade(b) {
  const r = svall(b, 'host', 'upgrade', 'fresh', ...named(b), '--json');
  save('host-upgrade.ndjson', r.stdout);
  const events = lines(r.stdout);
  const steps = events.filter((e) => e.step && e.status !== 'start');
  for (const s of steps) check(`host upgrade ${s.step}`, s.status === 'ok', () => `${s.status}: ${s.detail ?? ''} ${s.action ?? ''}`);
  check('host upgrade steps', JSON.stringify(steps.map((s) => s.step)) === JSON.stringify(['machine', 'master', 'release', 'upload', 'install', 'probe']),
    () => brief(steps.map((s) => s.step)));
  check('host upgrade result', events.at(-1)?.result === 'ready' && r.code === 0, () => brief(events.at(-1)));
  check('host upgrade release', steps.find((s) => s.step === 'release')?.detail === from(b), () => brief(steps.find((s) => s.step === 'release')));
  downloaded(b, 'host upgrade');
}

function rollback(a) {
  const r = ssh('.local/bin/svall', 'setup', '--rollback', '--json');
  save('rollback.json', r.stdout);
  const done = json(r.stdout)?.done ?? [];
  check('rollback exit', r.code === 0, () => `${r.code}: ${r.stderr.trim().slice(-400)}`);
  check('rollback current', done.includes(`current -> ${PREFIX}/releases/${a.version}`), () => brief(done));
  check('rollback restarts', UNITS.every((u) => done.includes(`systemctl --user restart ${u}`)), () => brief(done));
}

let code = 0;
let server;
try {
  const [a, b] = step('the controller the app carries', () => {
    const rels = [release(path.resolve(o.release), 'release'), release(path.resolve(o.upgrade), 'upgrade')];
    controller(rels);
    return rels;
  });
  server = await serve([a, b]);
  say(`   logs in ${out}; controller home ${HOME}`);
  step(`a clean Ubuntu 24.04 ${o.arch} machine, an account at the controller's home path`, machine);
  step(`host add from ${a.version}${a.served ? ', downloaded' : ', by path'}`, () => hostAdd(a));
  step(`lingering on, as host add asks, and host enable --fleet ${FLEET}`, () => {
    linger();
    enable(a);
  });
  step('after a restart with no login, both fleets and the gateway run the release', () => {
    reboot();
    runs('added', a, [a.version]);
    doctor(a, 'added');
  });
  step(`host upgrade to ${b.version}${b.served ? ', downloaded' : ', by path'}`, () => {
    upgrade(b);
    runs('upgraded', b, [a.version, b.version]);
    doctor(b, 'upgraded');
  });
  step(`setup --rollback on the machine, back to ${a.version}`, () => {
    rollback(a);
    runs('rolled back', a, [a.version, b.version]);
    doctor(a, 'rolled back');
  });
  say('ALL PASS');
} catch (e) {
  say(`FAILED: ${e.message}`);
  code = 1;
} finally {
  server?.kill();
  save('machine.log', root(`tail -n 300 '${PREFIX}'/log/*.log 2>/dev/null; journalctl -b --no-pager -n 200 2>/dev/null`, { ok: false }).stdout);
  if (!o.keep) {
    docker(['rm', '-f', M]);
    for (const dir of [work, HOME]) fs.rmSync(dir, { recursive: true, force: true });
  } else {
    say(`   kept ${M}, ${work} and ${HOME}; ssh with ${BIN}/ssh fresh`);
  }
}
process.exitCode = code;
