// The robot placement integration run, driven from the host through docker:
//
//   node scripts/integration/robot-placement.mjs [--archive <companion.tar.gz>] [--image <tag>] [--out <dir>]
//                                                [--steps all|<n>,...] [--scenarios all|none|kill|drop|<fault>@<phase>,...]
//                                                [--points <regex>] [--keep] [--prefix <name>]
//
// Two Ubuntu 24.04 containers: `svall-local`, the home, set up from the companion built from this checkout, and
// `svall-remote`, made its worker by `svall host add`; their accounts have different homes, as a Mac's and a Linux
// machine's do. Three Claude robots (`agent`, `kanban`, `faults`) are moved between them through the STEPS below.
// With no `--archive` the companion is built for the docker host's architecture, with no `--image` the Dockerfile here.
// `--steps` picks steps by number (the fixture always runs); `--prefix` replaces `svall` in the machines' and network's
// names. Every failed check is printed; the run exits 1 on the first step that has one.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brief, flags, harness, lines, machines, same } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const o = flags(process.argv.slice(2));
const UNIT = 'svall-svalld@private.service';
const PHASES = ['rest', 'bundle', 'prepare', 'commit', 'activate', 'release'];
// pre-commit phases abort back to the source; from the commit on the move runs on onto the destination
const PRE = new Set(['rest', 'bundle', 'prepare']);

if (o.archive && !fs.existsSync(o.archive)) throw new Error(`no archive ${o.archive}`);
const image = o.image ?? 'svall-it:latest';
const companions = o.archive ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'robot-placement-companion-'));
const archive = built();
const out = o.out ? path.resolve(o.out) : fs.mkdtempSync(path.join(os.tmpdir(), 'robot-placement-'));
const { say, docker, check, step, booted } = harness(out);
const { L, R, NET, HOMES, sh } = machines(o.prefix ?? 'svall', docker);
// step 19's third machine, a server of no fleet yet
const S = `${o.prefix ?? 'svall'}-server`;
const B = `${o.prefix ?? 'svall'}-box`;

// ---------------------------------------------------------------------------------------------- machines

/** The companion archive and the machine image the run takes, each built when the command line names none. */
function built() {
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status ?? r.error?.message}`);
    return r.stdout;
  };
  if (!o.image) run('docker', ['build', '-q', '-t', image, HERE]);
  if (o.archive) return path.resolve(o.archive);
  // the machines run on the docker host's own architecture: under user-mode emulation every process reads as qemu
  const platform = run('docker', ['info', '--format', '{{.Architecture}}']).trim();
  const arch = { aarch64: 'arm64', arm64: 'arm64', x86_64: 'x64', amd64: 'x64' }[platform];
  if (!arch) throw new Error(`no companion is built for ${platform}`);
  if (!fs.existsSync(path.join(REPO, 'apps/desktop/web/dist-mobile'))) run('pnpm', ['--filter', '@svall/desktop-web', 'build:mobile']);
  run(process.execPath, [path.join(REPO, 'scripts/build-companion.mjs'), '--out', companions, '--arch', arch]);
  return path.join(companions, fs.readdirSync(companions).find((f) => f.endsWith(`-linux-${arch}.tar.gz`)));
}

// a machine booted, with the release under test and what the run's checks take from /opt/it
function provision(m) {
  booted(m);
  sh(m, 'mkdir -p /opt/it', { root: true });
  for (const f of [archive, path.join(HERE, 'claude.mjs'), path.join(HERE, 'opencode.mjs'), path.join(HERE, 'machine.mjs')]) {
    if (docker(['cp', f, `${m}:/opt/it/`]).code !== 0) throw new Error(`docker cp ${f} to ${m} failed`);
  }
  // the harness's own node, from the release under test: the mocked agent and the in-machine checks run on it
  sh(m, 'cd /opt/it && tar -xzf svall-companion-*.tar.gz --wildcards "releases/*/node" && mv releases/*/node node && rm -rf releases && chmod -R a+rX /opt/it', { root: true });
}

function up() {
  for (const m of [L, R, S, B]) docker(['rm', '-f', m]);
  docker(['network', 'rm', NET]);
  if (docker(['network', 'create', NET]).code !== 0) throw new Error('docker network create failed');
  for (const m of [L, R]) {
    // the image's account lives in /home/svall; local's moves to its own home before systemd starts
    const home = HOMES[m] === '/home/svall' ? [] : ['bash', '-c', `mkdir -p ${path.posix.dirname(HOMES[m])} && usermod -d ${HOMES[m]} -m svall && exec /sbin/init`];
    const r = docker(['run', '-d', '--name', m, '--hostname', m, '--network', NET, '--privileged', '--cgroupns=private',
      '--tmpfs', '/run', '--tmpfs', '/run/lock', image, ...home]);
    if (r.code !== 0) throw new Error(`${m} did not start: ${r.stderr}`);
  }
  for (const m of [L, R]) {
    provision(m);
    // local's a wrapper that execs node on the mock, so ps shows `node …/claude.mjs` as the rest classifier reads a Claude;
    // remote's where npm puts it under nvm, a script whose env node is the release's, on a PATH only ~/.bashrc sets
    sh(m, m === L ? 'mkdir -p ~/.local/bin && printf \'#!/bin/sh\\nexec /opt/it/node/bin/node /opt/it/claude.mjs "$@"\\n\' > ~/.local/bin/claude && chmod 755 ~/.local/bin/claude' : NVM);
    sh(m, 'mkdir -p ~/.local/bin && printf \'#!/bin/bash\\nexec -a opencode /opt/it/node/bin/node /opt/it/opencode.mjs "$@"\\n\' > ~/.local/bin/opencode && chmod 755 ~/.local/bin/opencode');
  }
  // a login shell that is not interactive, as an ssh command's, stops at ~/.bashrc's guard before nvm's lines, as on Ubuntu
  sh(R, '! command -v claude');
  sh(L, 'mkdir -m 700 -p ~/.ssh && ssh-keygen -q -t ed25519 -N "" -f ~/.ssh/id_ed25519');
  // remote logs in to itself too, as its clone fetches from the bare repository it holds
  sh(R, 'mkdir -m 700 -p ~/.ssh && ssh-keygen -q -t ed25519 -N "" -f ~/.ssh/id_ed25519 && cp ~/.ssh/id_ed25519.pub ~/.ssh/authorized_keys');
  sh(R, 'cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys', { input: sh(L, 'cat ~/.ssh/id_ed25519.pub').stdout });
  for (const m of [L, R]) {
    sh(m, `ssh-keyscan -t ed25519 ${R} 2>/dev/null > ~/.ssh/known_hosts && test -s ~/.ssh/known_hosts`);
    sh(m, `ssh -o BatchMode=yes svall@${R} true`);
  }
  if (docker(['exec', '-d', R, '/opt/it/node/bin/node', '/opt/it/machine.mjs', 'link', '7070']).code !== 0) throw new Error('the link agent did not start');
}

// what nvm's installer and `npm i -g @anthropic-ai/claude-code` leave, nvm.sh standing in for `nvm use default`
const NVM_BIN = '~/.nvm/versions/node/v22.11.0/bin';
const NVM = [
  'pkg=~/.nvm/versions/node/v22.11.0/lib/node_modules/@anthropic-ai/claude-code && mkdir -p $pkg ' + NVM_BIN,
  'printf \'#!/usr/bin/env node\\nimport("/opt/it/claude.mjs");\\n\' > $pkg/cli.js && chmod 755 $pkg/cli.js',
  `ln -s ../lib/node_modules/@anthropic-ai/claude-code/cli.js ${NVM_BIN}/claude && ln -s /opt/it/node/bin/node ${NVM_BIN}/node`,
  'printf \'export PATH="$NVM_DIR/versions/node/v22.11.0/bin:$PATH"\\n\' > ~/.nvm/nvm.sh',
  'printf \'\\nexport NVM_DIR="$HOME/.nvm"\\n[ -s "$NVM_DIR/nvm.sh" ] && \\\\. "$NVM_DIR/nvm.sh"\\n\' >> ~/.bashrc',
].join(' && ');

function install() {
  const setup = sh(L, 'rm -rf /tmp/it-release && mkdir /tmp/it-release && tar -xzf /opt/it/svall-companion-*.tar.gz -C /tmp/it-release'
    + ' && /tmp/it-release/releases/*/bin/svall setup --release /opt/it/svall-companion-*.tar.gz --allow-unsigned --json');
  const done = JSON.parse(setup.stdout).done.join('\n');
  check('setup', new RegExp(`enable --now ${UNIT.replace('.', '\\.')}`).test(done), `setup did not start the daemon unit: ${done}`);
  sh(L, `systemctl --user is-active ${UNIT}`);

  const add = sh(L, `svall host add remote --ssh svall@${R} --release /opt/it/svall-companion-*.tar.gz --allow-unsigned --json </dev/null`, { ok: false });
  const events = lines(add.stdout);
  const steps = events.filter((e) => e.step && e.status !== 'start');
  // there is no Codex or gh on the machine, a mirror not yet checked, and no limit with no one to ask, which are advice, not failures
  const isAdvice = (s) => s.status === 'warn' && (/codex/i.test(`${s.step} ${s.detail ?? ''}`) || ((s.step === 'gh' || s.step === 'limits') && !s.action) || s.step === 'mirror:unchecked');
  for (const s of steps) {
    check(`host add ${s.step}`, s.status === 'ok' || s.status === 'skip' || isAdvice(s), `${s.status}: ${s.detail ?? ''} ${s.action ?? ''}`);
  }
  for (const want of ['os', 'home', 'tools', 'linger', 'release', 'upload', 'install', 'service', 'identity', 'enrol', 'limits', 'probe', 'registry']) {
    check(`host add ${want}`, steps.some((s) => s.step === want), 'step missing');
  }
  const advised = new Set(steps.filter(isAdvice).map((s) => s.action));
  const result = events.at(-1);
  check('host add exit', add.code === 0 || (result?.result === 'actions' && !result.stopped && result.actions.every((a) => advised.has(a))),
    () => `exit ${add.code}: ${add.stdout.trim().split('\n').at(-1)}`);
  const ids = {
    fleet: JSON.parse(sh(L, 'cat ~/.svall/fleet.json').stdout).id,
    local: JSON.parse(sh(L, 'svall version --json').stdout).machineId,
    remote: JSON.parse(sh(R, 'svall version --json').stdout).machineId,
  };
  const worker = JSON.parse(sh(R, 'cat ~/.svall/worker.json').stdout);
  check('worker.json', worker.homeMachineId === ids.local && worker.fleetId === ids.fleet, () => brief({ ...worker, token: undefined }));
  check('worker unit', /--worker/.test(sh(R, `systemctl --user cat ${UNIT}`).stdout), 'the fleet unit on remote does not run svalld --worker');
  // nvm's folder after the release's node and bin, as the login shell found claude there
  const unitPath = (/(?:^|\s)PATH=(\S+)/.exec(sh(R, `systemctl --user show -p Environment --value ${UNIT}`).stdout)?.[1] ?? '').split(':');
  check('worker unit PATH', unitPath[0].endsWith('/current/node/bin') && unitPath.indexOf(NVM_BIN.replace('~', HOMES[R])) > 1, unitPath.join(':'));
  check('host add claude under nvm', steps.findLast((s) => s.step === 'claude')?.status === 'ok', () => brief(steps.findLast((s) => s.step === 'claude')));
  for (const m of [L, R]) {
    const oom = sh(m, `systemctl --user show -p OOMPolicy --value ${UNIT}`).stdout.trim();
    check(`${m} OOMPolicy`, oom === 'continue', oom);
  }
  linked(ids);
  return ids;
}

const linksOf = () => JSON.parse(sh(L, '/opt/it/node/bin/node /opt/it/machine.mjs machines', { ok: false }).stdout || '{}');

/** Waits until the home's link to remote is up, and came up after `since` when given, as its state's machines say. */
function linked(ids, since = 0, seconds = 120) {
  for (let i = 0; i < seconds * 2; i++) {
    const m = linksOf()[ids.remote];
    if (m?.reachable && m.since > since) return;
    sh(L, 'sleep 0.5');
  }
  throw new Error(`the home did not link remote within ${seconds} s`);
}

// origin is a bare repository on remote; the checkouts hold every kind of change a move has to carry or leave
const GIT_FIXTURE = String.raw`set -eu
git config --global user.name Integration
git config --global user.email integration@example.invalid
git config --global init.defaultBranch main
mkdir -p ~/src && cd ~/src && git init -q app && cd app
printf 'one\n' > a.txt && printf 'two\n' > b.txt && mkdir lib && printf 'three\n' > lib/c.txt
printf 'node_modules/\n' > .gitignore
git add -A && git commit -qm 'first commit'
git remote add origin svall@REMOTE:git/app.git && git push -q -u origin main && git remote set-head origin main
printf 'stashed\n' >> a.txt && git stash push -q -m 'fixture stash'
git worktree add -q -b feature ../app-wt
git worktree add -q -b faults ../app-faults
printf 'staged\n' >> a.txt && git add a.txt
printf 'unstaged\n' >> b.txt
printf 'untracked\n' > untracked.txt
mkdir -p node_modules/pkg && printf 'module.exports = 1;\n' > node_modules/pkg/index.js
cd ../app-wt
printf 'wt staged\n' >> lib/c.txt && git add lib/c.txt
printf 'wt unstaged\n' >> a.txt
printf 'wt untracked\n' > wt-untracked.txt
printf 'SECRET=integration\n' > .env
printf 'KEY\n' > Deploy.KEY
cd ../app-faults
printf 'fault\n' > f.txt && git add f.txt && git commit -qm 'a commit not on origin'
printf 'fault untracked\n' > f-untracked.txt
`;

function fixture(ids) {
  sh(R, 'git init -q --bare --initial-branch=main ~/git/app.git');
  sh(L, GIT_FIXTURE.replace('REMOTE', R));
  const island = JSON.parse(sh(L, 'svall --json island create integration').stdout).id;
  const fx = { island };
  for (const [key, dir] of [['agent', 'src/app-wt'], ['kanban', 'src/app'], ['faults', 'src/app-faults']]) {
    fx[key] = JSON.parse(sh(L, `svall --json robot new --island ${island} --cwd ~/${dir} --name ${key} --claude`).stdout).id;
  }
  for (const key of ['agent', 'kanban', 'faults']) sh(L, `svall robot wait ${fx[key]} --until idle --timeout 60`);
  for (const key of ['agent', 'kanban', 'faults']) turn(ids, fx, key, 'first turn on local');
  return fx;
}

// ---------------------------------------------------------------------------------------------- snapshots

// `light` leaves out the repos, their files and the sessions
function snap(machine, light = false) {
  return JSON.parse(sh(machine, `/opt/it/node/bin/node /opt/it/machine.mjs snap${light ? ' --light' : ''}`).stdout);
}

const robotIn = (s, id) => s.robots.find?.((c) => c.id === id);
const agentsOf = (s, id) => s.agents.filter((p) => p.robotId === id);
const transcriptOf = (s, sessionId) => Object.entries(s.sessions).find(([k]) => k.endsWith(`/${sessionId}.jsonl`))?.[1];

/** One prompt to a robot through the home's `svall`, which reaches whichever machine runs it, and the two records its session gains there. */
function turn(ids, fx, key, text) {
  const id = fx[key];
  const where = (s) => (robotIn(s, id)?.machine === ids.remote ? R : L);
  const home = snap(L);
  const m = where(home);
  const before = snap(m);
  const sessionId = robotIn(home, id)?.agent?.sessionId;
  sh(L, `svall robot run ${id} '${text}' && svall robot wait ${id} --until done,idle --timeout 60`);
  const after = snap(m);
  const [b, a] = [transcriptOf(before, sessionId)?.lines ?? 0, transcriptOf(after, sessionId)?.lines];
  check(`${key} turn`, a === b + 2, () => `${key}'s session ${sessionId} on ${m}: ${b} -> ${a} records`);
  return { machine: m, lines: a };
}

/** Polls a machine until `fn(snap)` holds, and answers that snapshot; the last one when it never does. */
function until(machine, fn, seconds = 120, light = true) {
  let s;
  for (let i = 0; i < seconds * 2; i++) {
    s = snap(machine, light);
    if (fn(s)) return s;
    sh(machine, 'sleep 0.5');
  }
  return s;
}

/** A turn typed into a robot's pane on remote, as someone at that machine would, waited on until the worker records it done. */
function turnOn(id, text) {
  const pane = robotIn(snap(R, true), id)?.tmux?.paneId;
  sh(R, `T=~/.local/share/svall/current/bin/tmux; $T -S ~/.svall/tmux.sock send-keys -t '${pane}' -l '${text}' && $T -S ~/.svall/tmux.sock send-keys -t '${pane}' Enter`);
  const s = until(R, (x) => robotIn(x, id)?.agent?.prompt === text && robotIn(x, id).agent.status === 'done', 60);
  check(`worker took "${text}"`, robotIn(s, id)?.agent?.prompt === text, () => brief(robotIn(s, id)?.agent));
}

/** One call to a machine's daemon through machine.mjs: its answer, or `{ error, code }`. */
const call = (machine, method, params = {}) => JSON.parse(sh(machine, `/opt/it/node/bin/node /opt/it/machine.mjs call ${method} '${JSON.stringify(params)}'`).stdout);

// ---------------------------------------------------------------------------------------------- assertions

// a repo's state as both machines' git shows it, its untracked credential files left out, which never travel
const credential = /(^|\/)(\.env[^/]*|[^/]*\.pem|id_(rsa|ed25519|ecdsa|dsa)[^/]*|[^/]*\.tfvars|[^/]*\.key|\.netrc)$/i;
const statusOf = (g) => g?.status.split('\n').filter((l) => l && !l.startsWith('# ') && !(l.startsWith('? ') && credential.test(l.slice(2))));
// a checkout writes files by its daemon's umask, so a file's mode is compared by its executable bits, as git keeps it
const treeOf = (t) => t && Object.fromEntries(Object.entries(t).filter(([k]) => !credential.test(k))
  .map(([k, v]) => [k, v.t === 'd' ? { t: 'd' } : v.t === 'f' ? { ...v, mode: (parseInt(v.mode, 8) & 0o111).toString(8) } : v]));
// a main checkout with nothing staged, changed or untracked but the worktrees inside it
const cleanMain = (g) => statusOf(g)?.every((l) => /^\? \.claude\/worktrees\//.test(l));

/** The worktree `rel` holds on `s` what it holds on `base`: branch, head, index, status and files, credentials aside. */
function sameWork(label, s, base, rel) {
  const [a, b] = [s.git[rel], base.git[rel]];
  check(`${label} branch`, a && a.branch === b.branch && a.head === b.head, () => `${a?.branch} ${a?.head} vs ${b.branch} ${b.head}`);
  check(`${label} index`, a?.index === b.index, () => `${brief(a?.index)} vs ${brief(b.index)}`);
  check(`${label} status`, same(statusOf(a), statusOf(b)), () => `${brief(statusOf(a))} vs ${brief(statusOf(b))}`);
  check(`${label} files`, same(treeOf(s.trees[rel]), treeOf(base.trees[rel])), () => treeDiff(treeOf(s.trees[rel]), treeOf(base.trees[rel])));
  check(`${label} fsck`, a?.fsck === '', () => a?.fsck);
}

function treeDiff(a = {}, b = {}) {
  const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];
  return keys.filter((k) => !same(a?.[k], b?.[k])).slice(0, 8).map((k) => `${k}: ${brief(a?.[k])} vs ${brief(b?.[k])}`).join('; ');
}

/**
 * The robot runs on `machine` alone, by both records, its one agent process and its window. That process resumes the
 * session, or is `pid` when the move never stopped it.
 */
function runsOn(label, ids, l, w, id, machine, sessionId, pid) {
  const [here, there] = machine === 'remote' ? [w, l] : [l, w];
  const c = robotIn(l, id);
  check(`${label} home record`, (c?.machine ?? 'local') === (machine === 'remote' ? ids.remote : 'local') && !c.moving, () => brief(c));
  const wc = robotIn(w, id);
  check(`${label} worker record`, machine === 'remote' ? wc?.machine === ids.remote : wc?.machine !== ids.remote, () => brief(wc));
  const procs = agentsOf(here, id);
  check(`${label} one agent`, procs.length === 1 && agentsOf(there, id).length === 0, () => `here ${brief(procs)}, there ${brief(agentsOf(there, id))}`);
  const p = procs[0];
  const resumes = p?.args.at(-2) === '--resume';
  // a killed daemon loses the state it had not written yet, the agent's pid among it, until the agent's next hook
  check(`${label} session`, p && (c?.agent?.pid ?? p.pid) === p.pid && (resumes ? p.args.at(-1) === sessionId : p.pid === pid), () => `${brief(p?.args)} pid ${p?.pid}, the home holds ${c?.agent?.pid}`);
  check(`${label} window`, here.windows.some((x) => x.name === id) && !there.windows.some((x) => x.name === id), () => `${brief(here.windows)} / ${brief(there.windows)}`);
  check(`${label} agent up`, ['idle', 'done'].includes(c?.agent?.status) && (!sessionId || c.agent.sessionId === sessionId), () => brief(c?.agent));
}

// the bare repository both machines fetch from, which a move never pushes to
const originRefs = () => sh(R, 'git -C ~/git/app.git for-each-ref').stdout;
const originUntouched = () => check('origin untouched', originRefs() === ctx.origin, () => `${originRefs()} vs ${ctx.origin}`);

function move(id, to) {
  const r = sh(L, `svall robot move ${id} --machine ${to} --json </dev/null`, { ok: false });
  let res;
  try { res = JSON.parse(r.stdout); } catch { res = null; }
  return { code: r.code, res, stderr: r.stderr };
}

// ---------------------------------------------------------------------------------------------- steps

function moveDirty(ids, fx) {
  const id = fx.agent;
  const base = snap(L);
  const sessionId = robotIn(base, id).agent.sessionId;
  const m = move(id, 'remote');
  check('moved', m.code === 0 && m.res?.ok && m.res.moveId, () => `exit ${m.code}: ${m.stderr.trim()} ${brief(m.res)}`);
  check('sheet', m.res?.sheet?.stays?.includes('.env stays here') && m.res.sheet.clone === 'clone' && m.res.sheet.changedFiles === 2 && m.res.sheet.untrackedFiles === 1,
    () => brief(m.res?.sheet));
  const [l, w] = [snap(L), snap(R)];
  const c = robotIn(l, id);
  check('placed', c?.machine === ids.remote && c.placement?.generation === 1 && c.cwd === `${HOMES[R]}/src/app-wt`, () => brief(c));
  check('left', c?.left?.machine === ids.local && c.left.path === `${HOMES[L]}/src/app-wt` && c.left.branch === 'feature' && c.left.moveId === m.res?.moveId, () => brief(c?.left));
  const listed = JSON.parse(sh(L, 'svall --json robot list').stdout).find((r) => r.id === id);
  check('robot list', listed?.machine === ids.remote, () => brief(listed));
  check('journals', l.moves[m.res?.moveId]?.phase === 'done' && w.moves[m.res?.moveId]?.phase === 'done', () => brief([l.moves, w.moves]));
  check('mac worktree locked', l.locks['src/app-wt'] === `moved to remote ${m.res?.moveId}`, () => brief(l.locks));
  check('mac worktree kept', same(l.git['src/app-wt'].status, base.git['src/app-wt'].status) && same(l.trees['src/app-wt'], base.trees['src/app-wt']),
    () => treeDiff(l.trees['src/app-wt'], base.trees['src/app-wt']));
  check('stash stays', l.git['src/app'].stash === base.git['src/app'].stash && w.git['src/app'].stash === '', () => `${l.git['src/app'].stash} / ${w.git['src/app'].stash}`);
  sameWork('worker worktree', w, base, 'src/app-wt');
  check('no credentials on worker', ['.env', 'Deploy.KEY'].every((k) => !Object.hasOwn(w.trees['src/app-wt'] ?? {}, k) && Object.hasOwn(l.trees['src/app-wt'], k)),
    () => brief(Object.keys(w.trees['src/app-wt'] ?? {})));
  runsOn('worker', ids, l, w, id, 'remote', sessionId);
  check('agent folder', agentsOf(w, id)[0]?.cwd === `${HOMES[R]}/src/app-wt`, () => brief(agentsOf(w, id)));
  // the agent on the worker posts its hooks there, and the home's state shows them
  const t = turn(ids, fx, 'agent', 'a turn on remote');
  const a = robotIn(snap(L), id)?.agent;
  check('hook reached home', a?.prompt === 'a turn on remote' && ['done', 'idle'].includes(a.status) && a.contextPct === t.lines, () => `${brief(a)}, ${t.lines} records`);
  const read = sh(L, `svall robot read ${id} --transcript --lines 1`).stdout;
  check('transcript read', read.includes('did: a turn on remote'), () => read.slice(-300));
  originUntouched();
}

function moveMain(ids, fx) {
  const id = fx.kanban;
  const wt = 'src/app/.claude/worktrees/kanban';
  const base = snap(L);
  const sessionId = robotIn(base, id).agent.sessionId;
  const m = move(id, 'remote');
  check('moved', m.code === 0 && m.res?.ok, () => `exit ${m.code}: ${m.stderr.trim()} ${brief(m.res)}`);
  check('sheet', same(m.res?.sheet?.converts, { main: `${HOMES[L]}/src/app`, branch: 'kanban', changed: 3 }) && m.res.sheet.stays.includes('node_modules is not carried'),
    () => brief(m.res?.sheet));
  const [l, w] = [snap(L), snap(R)];
  // main's changes are the new worktree's, staged and unstaged apart, and main is clean on its branch with its stash
  check('mac worktree', l.git[wt]?.branch === 'refs/heads/kanban' && l.git[wt].head === base.git['src/app'].head && l.git[wt].index === base.git['src/app'].index
    && same(statusOf(l.git[wt]), statusOf(base.git['src/app'])), () => `${brief(l.git[wt])} vs ${brief(base.git['src/app'])}`);
  check('mac worktree locked', l.locks[wt] === `moved to remote ${m.res?.moveId}`, () => brief(l.locks));
  check('mac main clean', cleanMain(l.git['src/app']) && l.git['src/app'].branch === 'refs/heads/main' && l.git['src/app'].head === base.git['src/app'].head,
    () => brief(l.git['src/app']));
  check('stash unchanged', l.git['src/app'].stash === base.git['src/app'].stash, () => `${l.git['src/app'].stash} vs ${base.git['src/app'].stash}`);
  check('ignored stay', Object.hasOwn(l.trees['src/app'], 'node_modules/pkg/index.js'), () => brief(Object.keys(l.trees['src/app'])));
  check('ignored never travel', [l, w].every((x) => !Object.keys(x.trees[wt] ?? {}).some((k) => k.startsWith('node_modules'))), () => brief([Object.keys(l.trees[wt] ?? {}), Object.keys(w.trees[wt] ?? {})]));
  sameWork('worker worktree', w, l, wt);
  check('worker main clean', cleanMain(w.git['src/app']) && w.git['src/app'].branch === 'refs/heads/main', () => brief(w.git['src/app']));
  const c = robotIn(l, id);
  check('placed', c?.machine === ids.remote && c.branch === 'kanban' && c.cwd === `${HOMES[R]}/${wt}`, () => brief(c));
  runsOn('worker', ids, l, w, id, 'remote', sessionId);
  check('agent folder', agentsOf(w, id)[0]?.cwd === `${HOMES[R]}/${wt}`, () => brief(agentsOf(w, id)));
  turn(ids, fx, 'kanban', 'a turn on remote');
  originUntouched();
}

function workerRestart(ids, fx) {
  const placed = [fx.agent, fx.kanban];
  const before = snap(R);
  const since = linksOf()[ids.remote]?.since;
  sh(R, `systemctl --user restart ${UNIT}`);
  linked(ids, since);
  // a restart leaves the fleet's tmux, so each robot keeps its agent
  const kept = snap(R);
  for (const id of placed) check(`${id} kept`, same(agentsOf(kept, id).map((p) => p.pid), agentsOf(before, id).map((p) => p.pid)) && agentsOf(kept, id).length === 1, () => brief(agentsOf(kept, id)));
  // a reboot ends tmux and every agent in it: the robots, inside the idle limit, resume there on their own
  const since2 = linksOf()[ids.remote]?.since;
  sh(R, `systemctl --user stop ${UNIT} && ~/.local/share/svall/current/bin/tmux -S ~/.svall/tmux.sock kill-server; sleep 1; systemctl --user start ${UNIT}`);
  linked(ids, since2);
  until(L, (s) => placed.every((id) => robotIn(s, id)?.tmux), 60);
  for (const id of placed) sh(L, `svall robot wait ${id} --until idle,done --timeout 60`);
  until(R, (s) => placed.every((id) => agentsOf(s, id).length === 1), 60);
  const [l2, w2] = [snap(L), snap(R)];
  for (const id of placed) {
    check(`${id} agent restarted`, !same(agentsOf(w2, id).map((p) => p.pid), agentsOf(before, id).map((p) => p.pid)), 'an agent survived the reboot');
    runsOn(`${id} resumed`, ids, l2, w2, id, 'remote', robotIn(before, id)?.agent?.sessionId);
  }
  turn(ids, fx, 'agent', 'a turn after the reboot');
}

function homeDown(ids, fx) {
  const id = fx.agent;
  const was = robotIn(snap(L), id)?.agent;
  sh(L, `systemctl --user stop ${UNIT}`);
  const texts = ['first turn while the home is down', 'second turn while the home is down'];
  for (const text of texts) turnOn(id, text);
  const down = snap(R);
  const wa = robotIn(down, id)?.agent;
  const queued = down.outbox.entries.filter((e) => e.robotId === id && e.agent);
  check('outbox holds the turns', down.outbox.last > down.outbox.acked && queued.some((e) => e.agent.prompt === texts[1]), () => brief(down.outbox));
  // the home comes back, watched from its first answer: each change its replay makes to the robot's agent, in order
  sh(L, 'rm -f /tmp/it-watch.ndjson');
  if (docker(['exec', '-d', '-u', 'svall', '-e', `HOME=${HOMES[L]}`, L, '/opt/it/node/bin/node', '/opt/it/machine.mjs', 'watch', id, '--out', '/tmp/it-watch.ndjson', '--for', '120']).code !== 0) throw new Error('the watcher did not start');
  sh(L, `sleep 0.5 && systemctl --user start ${UNIT}`);
  const up = until(R, (x) => x.outbox.acked === down.outbox.last, 120);
  check('outbox replayed', up.outbox.acked === down.outbox.last && up.outbox.entries.length === 0, () => brief(up.outbox));
  const l = until(L, (x) => robotIn(x, id)?.agent?.prompt === texts[1], 30);
  sh(L, 'pkill -f "^/opt/it/node/bin/node /opt/it/machine.mjs watch" || true');
  const seen = lines(sh(L, 'cat /tmp/it-watch.ndjson').stdout);
  fs.writeFileSync(path.join(out, 'home-down.watch.ndjson'), seen.map((x) => JSON.stringify(x)).join('\n'));
  const collapse = (xs) => xs.map((x) => JSON.stringify(x)).filter((x, i, a) => i === 0 || x !== a[i - 1]);
  const agentLine = (a) => ({ status: a?.status, contextPct: a?.contextPct ?? null, prompt: a?.prompt ?? null });
  const want = collapse([agentLine(was), ...queued.map((e) => agentLine(e.agent))]);
  const got = collapse(seen.filter((x) => x.agent).map((x) => agentLine(x.agent)));
  check('watched from the start', got[0] === want[0], () => `first seen ${got[0]}, the home had ${want[0]}`);
  check('in order, once', same(got, want), () => `seen ${got.join(' ')}\n      outbox ${want.join(' ')}`);
  const a = robotIn(l, id)?.agent;
  check('home state', a?.status === wa.status && a.contextPct === wa.contextPct && a.prompt === texts[1], () => `${brief(a)} vs worker ${brief(wa)}`);
}

function returnDirty(ids, fx) {
  const id = fx.agent;
  const head = snap(L).git['src/app-wt'].head;
  // the robot's work on the worker
  sh(R, String.raw`set -eu
cd ~/src/app-wt
printf 'worker commit
' > w.txt && git add w.txt && git -c user.name=Integration -c user.email=integration@example.invalid commit -qm 'a commit on the worker' -- w.txt
printf 'worker staged
' >> lib/c.txt && git add lib/c.txt
printf 'worker unstaged
' >> a.txt
printf 'meant
' > w-meant.txt && git add -N w-meant.txt
printf 'worker untracked
' > w-untracked.txt
`);
  const w0 = snap(R);
  const sessionId = robotIn(w0, id)?.agent?.sessionId;
  sh(L, 'printf "edited on the Mac\\n" >> ~/src/app-wt/b.txt');
  const refused = sh(L, `svall robot move ${id} --machine local </dev/null`, { ok: false });
  check('refused', refused.code === 2 && refused.stderr === `refused: Changes on ${L} in ${HOMES[L]}/src/app-wt since the move\n  → Stash or commit them\n`,
    () => `exit ${refused.code}: ${JSON.stringify(refused.stderr)}`);
  check('still on worker', robotIn(snap(L), id)?.machine === ids.remote && agentsOf(snap(R), id).length === 1, 'the refused return moved it');
  // the edit is undone; what the robot left there before it moved stays as it was
  sh(L, 'cd ~/src/app-wt && git checkout -- b.txt');
  const m = move(id, 'local');
  check('returned', m.code === 0 && m.res?.ok, () => `exit ${m.code}: ${m.stderr.trim()} ${brief(m.res)}`);
  const [l, w] = [snap(L), snap(R)];
  check('branch sha', l.git['src/app-wt'].head === w0.git['src/app-wt'].head && l.git['src/app-wt'].head !== head && l.git['src/app-wt'].branch === 'refs/heads/feature',
    () => `${l.git['src/app-wt'].head} vs the worker's ${w0.git['src/app-wt'].head}, before the move ${head}`);
  sameWork('mac worktree', l, w0, 'src/app-wt');
  check('credentials kept', ['.env', 'Deploy.KEY'].every((k) => Object.hasOwn(l.trees['src/app-wt'], k)), () => brief(Object.keys(l.trees['src/app-wt'])));
  check('mac unlocked', l.locks['src/app-wt'] === null, () => brief(l.locks));
  check('worker locked', /^moved to .+ mv_[0-9a-z]{10}$/.test(w.locks['src/app-wt'] ?? '') && w.locks['src/app-wt'].endsWith(m.res?.moveId), () => brief(w.locks));
  const c = robotIn(l, id);
  check('home record', !c?.machine && c?.left?.machine === ids.remote && c.left.path === `${HOMES[R]}/src/app-wt` && c.cwd === `${HOMES[L]}/src/app-wt`, () => brief(c));
  check('journals', l.moves[m.res?.moveId]?.phase === 'done' && w.moves[m.res?.moveId]?.phase === 'done', () => brief([l.moves[m.res?.moveId], w.moves[m.res?.moveId]]));
  runsOn('mac', ids, l, w, id, 'local', sessionId);
  check('session back', transcriptOf(l, sessionId)?.sha === transcriptOf(w0, sessionId)?.sha, () => `${brief(transcriptOf(l, sessionId))} vs ${brief(transcriptOf(w0, sessionId))}`);
  turn(ids, fx, 'agent', 'a turn back on the Mac');
  originUntouched();
}

// ---------------------------------------------------------------------------------------------- apart

// the home here is a Linux machine, which its worker calls by name
const SLEPT = `started on remote while ${L} was away`;
const listOn = (machine) => JSON.parse(sh(machine, 'svall --json robot list').stdout);

function reviewerAsleep(ids, fx) {
  const id = fx.kanban;
  sh(R, 'git -C ~/src/app worktree add -q -b review .claude/worktrees/review');
  const count = listOn(L).length;
  sh(L, `systemctl --user stop ${UNIT}`);
  const away = until(R, (s) => s.machines[ids.local]?.reachable === false, 60);
  check('worker sees the Mac away', away.machines[ids.local]?.reachable === false, () => brief(away.machines));
  // what kanban's agent would do on the worker: a turn, a reviewer in its own worktree, four on main, a sixth
  const texts = ['a turn while the Mac sleeps', 'a turn after the reviewer started'];
  turnOn(id, texts[0]);
  const made = [JSON.parse(sh(R, `svall --json robot new --island ${fx.island} --cwd ${HOMES[R]}/src/app/.claude/worktrees/review --name reviewer --claude --run 'review it'`).stdout).id];
  for (let i = 0; i < 4; i++) made.push(JSON.parse(sh(R, `svall --json robot new --island ${fx.island} --cwd ~/src/app --claude`).stdout).id);
  const sixth = sh(R, `svall robot new --island ${fx.island} --cwd ~/src/app --claude`, { ok: false });
  check('sixth refused', sixth.code !== 0 && sixth.stderr.includes(`remote has started 5 robots since ${L} last answered; wait for it`), () => `exit ${sixth.code}: ${JSON.stringify(sixth.stderr)}`);
  turnOn(id, texts[1]);
  const read = sh(R, `svall robot read ${id} --transcript --lines 1`).stdout;
  check('transcript read', read.includes(texts[1]), () => read.slice(-300));
  const listed = listOn(R).map((c) => c.id);
  check('worker lists them', [id, ...made].every((x) => listed.includes(x)), () => brief(listed));
  // the creates in the order they were made, and kanban's two turns as one report after them
  const down = snap(R);
  const creates = down.outbox.entries.filter((e) => e.kind === 'mutation');
  check('creates journaled', same(creates.map((e) => [e.method, e.robotId]), made.map((m) => ['robot.create', m])), () => brief(down.outbox.entries));
  const reports = down.outbox.entries.filter((e) => e.kind === 'robot.sync' && e.robotId === id);
  check('one report after them', reports.length === 1 && reports[0].seq > Math.max(...creates.map((e) => e.seq)) && reports[0].agent?.prompt === texts[1],
    () => brief(down.outbox.entries));

  sh(L, `systemctl --user start ${UNIT}`);
  const up = until(R, (x) => x.outbox.acked >= down.outbox.last && x.outbox.entries.length === 0, 120);
  check('outbox replayed', up.outbox.acked >= down.outbox.last && up.outbox.entries.length === 0, () => brief(up.outbox));
  const l = until(L, (s) => made.slice(1).every((m) => robotIn(s, m)?.note.includes('shares branch main with ')), 60);
  const home = listOn(L);
  const of = (m) => home.find((c) => c.id === m);
  check('kanban prompt', robotIn(l, id)?.agent?.prompt === texts[1], () => brief(robotIn(l, id)?.agent));
  for (const m of made) check(`${m} placed`, of(m)?.machine === ids.remote && of(m).islandId === fx.island && of(m).note.includes(SLEPT), () => brief(of(m)));
  const cells = home.filter((c) => c.islandId === fx.island).map((c) => `${c.cell.x},${c.cell.y}`);
  check('distinct cells', new Set(cells).size === cells.length, () => brief(cells));
  for (const m of made.slice(1)) check(`${m} shares main`, of(m)?.note.includes('shares branch main with '), () => brief(of(m)?.note));
  check('reviewer shares nothing', !of(made[0])?.note.includes('shares branch'), () => brief(of(made[0])?.note));
  const w = snap(R, true);
  const applied = w.applied.filter((a) => made.includes(a.changed?.robotId));
  check('applied in seq order', same(applied.map((a) => [a.method, a.changed.robotId]), made.map((m) => ['robot.create', m])) && applied.every((a, i) => i === 0 || a.seq > applied[i - 1].seq),
    () => brief(w.applied));
  const replayed = linksOf()[ids.remote]?.replayed;
  check('replayed mark', replayed?.epoch === w.outbox.epoch && replayed.seq >= down.outbox.last, () => `${brief(replayed)} vs epoch ${w.outbox.epoch}, last ${down.outbox.last}`);

  // a second start replays nothing again
  const since = linksOf()[ids.remote]?.since;
  sh(L, `systemctl --user restart ${UNIT}`);
  linked(ids, since);
  until(R, (s) => s.machines[ids.local]?.reachable, 60);
  for (const [m, list] of [[L, listOn(L)], [R, listOn(R)]]) {
    check(`${m} holds each once`, list.length === count + 5 && made.every((x) => list.filter((c) => c.id === x).length === 1), () => brief(list.map((c) => [c.id, c.name])));
  }
  ctx.slept = { reviewer: made[0], notes: Object.fromEntries(made.map((m) => [m, of(m)?.note])) };
}

function scribeFar(ids, fx) {
  const id = fx.kanban;
  // a robot at rest is due a pass of its own, which could write the note before the sweep that should say so
  turn(ids, fx, 'kanban', 'a turn before the sweep');
  const on = call(L, 'scribe.set', { enabled: true });
  check('scribe on', !on.error, () => brief(on));
  const swept = sh(L, 'svall scribe sweep').stdout;
  check('swept', swept.split('\n').includes(`kanban  note: noted on ${R}`), () => swept.slice(-600));
  const home = listOn(L);
  check('kanban note', home.find((c) => c.id === id)?.note === `noted on ${R}`, () => brief(home.find((c) => c.id === id)?.note));
  for (const [m, note] of Object.entries(ctx.slept.notes)) check(`${m} keeps its note`, home.find((c) => c.id === m)?.note === note, () => brief(home.find((c) => c.id === m)?.note));
}

/** What `file` holds on `machine` once it holds the line `text`, or after `seconds`. */
const textOn = (machine, file, text, seconds = 60) =>
  sh(machine, `for i in $(seq ${seconds * 2}); do [ "$(cat ${file} 2>/dev/null)" = '${text}' ] && break; sleep 0.5; done; cat ${file} 2>/dev/null`, { ok: false }).stdout;

function docsConflict(ids, fx) {
  const id = fx.kanban;
  const rel = `robots/${id}/notes.md`;
  const [here, there] = [`~/.svall/docs/${rel}`, `~/.svall/cache/docs/${rel}`];
  const texts = { first: 'notes written on the Mac', mac: 'notes the Mac changed while apart', remote: 'notes remote changed while apart' };
  sh(L, `mkdir -p "$(dirname ${here})" && printf '%s\\n' '${texts.first}' > ${here}`);
  check('worker took the notes', textOn(R, there, texts.first) === `${texts.first}\n`, 'they did not reach cache/docs on remote');
  sh(L, `systemctl --user stop ${UNIT}`);
  until(R, (s) => s.machines[ids.local]?.reachable === false, 60);
  sh(L, `printf '%s\\n' '${texts.mac}' > ${here}`);
  sh(R, `printf '%s\\n' '${texts.remote}' > ${there}`);
  const down = until(R, (s) => s.outbox.entries.some((e) => e.kind === 'docs.write'), 30);
  check('worker journaled its change', down.outbox.entries.some((e) => e.kind === 'docs.write'), () => brief(down.outbox.entries));
  sh(L, `systemctl --user start ${UNIT}`);
  const kept = new RegExp(`^robots/${id}/notes\\.remote\\.mu_[0-9a-z]{10}\\.conflict\\.md$`);
  const copies = (s) => Object.entries(s.conflicts).filter(([f]) => kept.test(f));
  const [l, w] = [until(L, (s) => copies(s).length > 0, 120), until(R, (s) => copies(s).length > 0, 120)];
  for (const [m, s, file] of [[L, l, here], [R, w, there]]) {
    check(`${m} keeps the Mac's text`, textOn(m, file, texts.mac) === `${texts.mac}\n`, () => sh(m, `cat ${file}`, { ok: false }).stdout);
    check(`${m} holds the copy`, same(copies(s), [[copies(l)[0]?.[0], `${texts.remote}\n`]]), () => brief(s.conflicts));
  }
  const name = path.posix.basename(copies(l)[0]?.[0] ?? '');
  const note = robotIn(snap(L, true), id)?.note ?? '';
  check('kanban note', note.includes(`${rel} changed on both remote and ${L}; remote's version is kept as ${name}`), () => brief(note));
}

function filesFar(ids, fx) {
  const id = fx.kanban;
  const wt = `${HOMES[R]}/src/app/.claude/worktrees/kanban`;
  const status = call(L, 'repo.status', { id });
  const git = sh(R, `git -C ${wt} status --porcelain --untracked-files=all`).stdout.split('\n').filter(Boolean).map((l) => l.slice(3)).sort();
  check('branch', status.branch === 'kanban', () => brief(status));
  check('changed files', git.length > 0 && same(status.files?.map((f) => f.path).sort(), git), () => `${brief(status.files)} vs ${brief(git)}`);
  const read = call(L, 'fs.read', { id, path: 'b.txt' });
  const text = sh(R, `cat ${wt}/b.txt`).stdout;
  check('fs.read', read.text === text, () => `${brief(read)} vs ${brief(text)}`);
  const write = call(L, 'fs.write', { id, path: 'b.txt', text: 'written from the Mac\n', mtimeMs: read.mtimeMs, root: read.root });
  check('fs.write', write.code === 'read_only' && sh(R, `cat ${wt}/b.txt`).stdout === text, () => brief(write));
}

function deleteWorkerDown(ids, fx) {
  const { reviewer } = ctx.slept;
  // the screen a phone shows of kanban while the worker is down: the last one the worker sent after its last hook
  const text = 'a turn before the worker stops';
  turn(ids, fx, 'kanban', text);
  let last;
  for (let i = 0; i < 60 && !last?.text?.includes(`did: ${text}`); i++) { if (i) sh(L, 'sleep 0.5'); last = call(L, 'term.lastScreen', { id: fx.kanban }); }
  check('last screen', last?.text?.includes(`did: ${text}`) && last.at > 0, () => brief(last));
  const since = linksOf()[ids.remote]?.since;
  sh(R, `systemctl --user stop ${UNIT}`);
  for (let i = 0; i < 120 && linksOf()[ids.remote]?.reachable !== false; i++) sh(L, 'sleep 0.5');
  check('remote away', linksOf()[ids.remote]?.reachable === false, () => brief(linksOf()[ids.remote]));
  const frozen = call(L, 'term.lastScreen', { id: fx.kanban });
  check('frozen screen', same(frozen, last), () => `${brief(frozen)} vs ${brief(last)}`);
  sh(L, `svall robot close ${reviewer}`);
  check('home lets go', !robotIn(snap(L, true), reviewer), 'the home still holds the reviewer');
  sh(R, `systemctl --user start ${UNIT}`);
  linked(ids, since);
  const w = until(R, (s) => !robotIn(s, reviewer) && !s.windows.some((x) => x.name === reviewer), 60);
  check('window gone', !w.windows.some((x) => x.name === reviewer), () => brief(w.windows));
  check('neither state holds it', !robotIn(w, reviewer) && !robotIn(snap(L, true), reviewer), () => brief(robotIn(w, reviewer)));
  check('worktree locked', w.locks['src/app/.claude/worktrees/review'] === `closed robot ${reviewer}`, () => brief(w.locks));
}

/** A robot started on remote in a worktree of its own there comes home into a new worktree of the Mac's clone, with all it holds. */
const TMUX_R = '~/.local/share/svall/current/bin/tmux -S ~/.svall/tmux.sock';
const cgroupOf = (m, file) => sh(m, `cat "/sys/fs/cgroup$(systemctl --user show -p ControlGroup --value ${UNIT})/${file}"`, { ok: false }).stdout.trim();
const farLimits = (flags = '') => {
  const r = sh(L, `svall --json host limits remote ${flags}`, { ok: false });
  return { ...r, report: r.code === 0 ? JSON.parse(r.stdout) : undefined };
};

/** Remote's unit holds what its node.json says: the same quota and memory in its cgroup, on a daemon that was not restarted for it. */
function limitsHold(when) {
  const { limits } = JSON.parse(sh(R, 'svall --json fleet limits').stdout);
  check(`limits ${when}: saved`, limits.cpus > 0 && limits.memoryMb > 0, () => brief(limits));
  check(`limits ${when}: memory.max`, cgroupOf(R, 'memory.max') === String(limits.memoryMb * 1024 * 1024), () => cgroupOf(R, 'memory.max'));
  check(`limits ${when}: no swap`, cgroupOf(R, 'memory.swap.max') === '0', () => cgroupOf(R, 'memory.swap.max'));
  check(`limits ${when}: cpu.max`, cgroupOf(R, 'cpu.max') === `${limits.cpus * 100000} 100000`, () => cgroupOf(R, 'cpu.max'));
}

function limits(ids, fx) {
  const main = () => sh(R, `systemctl --user show -p MainPID --value ${UNIT}`).stdout.trim();
  const none = farLimits();
  check('no limit after host add', none.report?.state === 'none' && cgroupOf(R, 'memory.max') === 'max', () => `${brief(none.report)} ${none.stderr}`);
  const [daemon, tmux] = [main(), sh(R, `${TMUX_R} display -p '#{pid}'`).stdout.trim()];
  const over = farLimits(`--cpus ${none.report.size.cores + 1}`);
  check('more cores than it has', over.code !== 0 && /this machine has \d+ cores/.test(over.stderr), () => over.stderr);
  const set = farLimits('--cpus 1 --memory 1G');
  check('limit set', set.report?.state === 'applied' && set.report.limits.memoryMb === 1024, () => `${brief(set.report)} ${set.stderr}`);
  check('memory.max', cgroupOf(R, 'memory.max') === String(1024 * 1024 * 1024), () => cgroupOf(R, 'memory.max'));
  check('cpu.max', cgroupOf(R, 'cpu.max') === '100000 100000', () => cgroupOf(R, 'cpu.max'));
  check('no swap', cgroupOf(R, 'memory.swap.max') === '0', () => cgroupOf(R, 'memory.swap.max'));
  check('nothing restarted', main() === daemon, () => `${daemon} -> ${main()}`);
  check('unit text', /OOMPolicy=continue\nCPUQuota=100%\nMemoryMax=1024M\nMemorySwapMax=0\n/.test(sh(R, `cat ~/.config/systemd/user/${UNIT}`).stdout), 'the unit file lacks the limit lines');

  // a robot's process that takes more than the fleet may is stopped; the daemon, tmux and the fleet's other robots run on
  const id = JSON.parse(sh(R, `svall --json robot new --island ${fx.island} --cwd ${HOMES[R]} --name hog --command bash`).stdout).id;
  const paneId = until(R, (x) => robotIn(x, id)?.tmux?.paneId, 30) && robotIn(snap(R, true), id)?.tmux?.paneId;
  check('hog pane', Boolean(paneId), () => brief(robotIn(snap(R, true), id)));
  const panePid = sh(R, `${TMUX_R} display -p -t '${paneId}' '#{pane_pid}'`).stdout.trim();
  check('pane marked', sh(R, `cat /proc/${panePid}/oom_score_adj`).stdout.trim() === '500', () => sh(R, `cat /proc/${panePid}/oom_score_adj`, { ok: false }).stdout);
  check('daemon and tmux not marked', [daemon, tmux].every((p) => Number(sh(R, `cat /proc/${p}/oom_score_adj`).stdout) < 500), 'the daemon or tmux carries the pane mark');
  const before = sh(R, `${TMUX_R} list-panes -a -F '#{pane_pid}' | sort`).stdout;
  // a window on the home, which hears of the hit as it happens
  sh(L, 'rm -f /tmp/it-limit.ndjson');
  if (docker(['exec', '-d', '-u', 'svall', '-e', `HOME=${HOMES[L]}`, L, '/opt/it/node/bin/node', '/opt/it/machine.mjs', 'watch', id, '--out', '/tmp/it-limit.ndjson', '--for', '240']).code !== 0) throw new Error('the watcher did not start');
  for (let i = 0; i < 40 && !/connected/.test(sh(L, 'cat /tmp/it-limit.ndjson', { ok: false }).stdout); i++) sh(L, 'sleep 0.5');
  sh(R, `${TMUX_R} send-keys -t '${paneId}' -l "/opt/it/node/bin/node -e 'const a=[];for(;;)a.push(Buffer.alloc(32<<20,1))'; echo hog-ended-\\$?" && ${TMUX_R} send-keys -t '${paneId}' Enter`);
  let ended = '';
  for (let i = 0; i < 180 && !/hog-ended-\d+/.test(ended); i++) { sh(R, 'sleep 1'); ended = sh(R, `${TMUX_R} capture-pane -p -t '${paneId}'`, { ok: false }).stdout; }
  check('hog killed', /hog-ended-137/.test(ended), () => ended.trim().split('\n').slice(-4).join(' | '));
  check('daemon runs on', main() === daemon && sh(R, `systemctl --user is-active ${UNIT}`).stdout.trim() === 'active', () => `${daemon} -> ${main()}`);
  check('tmux and every pane run on', sh(R, `${TMUX_R} display -p '#{pid}'`).stdout.trim() === tmux && sh(R, `${TMUX_R} list-panes -a -F '#{pane_pid}' | sort`).stdout === before, 'a pane or the tmux server is gone');
  let hits = 0;
  for (let i = 0; i < 20 && !hits; i++) { sh(R, 'sleep 1'); hits = farLimits().report?.hits ?? 0; }
  check('hit counted', hits >= 1, () => brief(farLimits().report));
  const told = sh(L, 'cat /tmp/it-limit.ndjson').stdout.trim().split('\n').map((l) => JSON.parse(l).limitHit).filter(Boolean);
  check('the window heard', told.length === 1 && told[0].machine === ids.remote && told[0].name === 'remote' && told[0].hits === 1 && told[0].at > 0, () => brief(told));
  sh(L, 'pkill -f "^/opt/it/node/bin/node /opt/it/machine.mjs watch" || true');
  check('doctor warns', /limits .*reached its memory limit/.test(sh(R, 'svall doctor', { ok: false }).stdout), 'svall doctor on remote does not say the limit was reached');
  sh(L, `svall robot close ${id}`, { ok: false });
  // each daemon answers for its own machine: the worker asked there, and the home, a Linux machine too
  const own = sh(R, 'svall --json host limits remote', { ok: false });
  check('the worker answers for itself', own.code === 0 && JSON.parse(own.stdout).hits >= 1, () => `${own.stdout} ${own.stderr}`);
  const homeName = JSON.parse(sh(L, 'svall --json host list').stdout).find((r) => r.id === ids.local)?.name;
  const home = sh(L, `svall --json host limits ${homeName}`, { ok: false });
  check('the home answers for itself', home.code === 0 && JSON.parse(home.stdout).state === 'none', () => `${homeName}: ${home.stdout} ${home.stderr}`);

  // the default, which adding the machine again keeps: its setup and its enrolment write the unit anew, and it is shown its limit, not asked
  const dflt = farLimits(`--cpus ${none.report.suggested.cpus} --memory ${none.report.suggested.memoryMb}M`);
  check('default set', dflt.report?.state === 'applied', () => `${brief(dflt.report)} ${dflt.stderr}`);
  const [at, was] = [Date.now(), main()];
  const again = sh(L, `svall host add remote --ssh svall@${R} --release /opt/it/svall-companion-*.tar.gz --allow-unsigned --json </dev/null`, { ok: false });
  const shown = again.stdout.trim().split('\n').map((l) => JSON.parse(l)).findLast((e) => e.step === 'limits');
  check('add again shows the limit', shown?.status === 'ok' && shown.detail.startsWith(`this fleet may use ${none.report.suggested.cpus} of ${none.report.size.cores} cores`), () => brief(shown));
  if (main() !== was) linked(ids, at);
  limitsHold('after adding it again');
  check('worker unit after adding it again', /--worker/.test(sh(R, `systemctl --user cat ${UNIT}`).stdout), 'the unit lost --worker');
  ctx.limited = true;
}

// box holds 1 core and 1 GB in its node.json, its unit and the unit's cgroup, and `svall fleet limits` there says it holds
function oneAndOne(when) {
  const saved = JSON.parse(sh(B, 'cat ~/.svall/node.json').stdout).limits;
  check(`${when}: node.json`, saved?.cpus === 1 && saved.memoryMb === 1024, () => brief(saved));
  check(`${when}: unit text`, /OOMPolicy=continue\nCPUQuota=100%\nMemoryMax=1024M\nMemorySwapMax=0\n/.test(sh(B, `cat ~/.config/systemd/user/${UNIT}`).stdout), 'the unit file lacks the limit lines');
  check(`${when}: memory.max`, cgroupOf(B, 'memory.max') === String(1024 * 1024 * 1024), () => cgroupOf(B, 'memory.max'));
  check(`${when}: no swap`, cgroupOf(B, 'memory.swap.max') === '0', () => cgroupOf(B, 'memory.swap.max'));
  check(`${when}: cpu.max`, cgroupOf(B, 'cpu.max') === '100000 100000', () => cgroupOf(B, 'cpu.max'));
  const there = JSON.parse(sh(B, 'svall --json fleet limits').stdout);
  check(`${when}: fleet limits there`, there.state === 'applied' && there.limits.cpus === 1 && there.limits.memoryMb === 1024, () => brief(there));
}

function addedLimited() {
  boxUp();
  letIn(L);
  const add = sh(L, `svall --json host add limited --ssh svall@${B} --limits 1,1G --release /opt/it/svall-companion-*.tar.gz --allow-unsigned </dev/null`, { ok: false });
  const steps = carriedSteps(add);
  check('the add ran', steps.some((e) => e.step === 'registry' && e.status === 'ok') && !steps.some((e) => e.status === 'fail'), () => `${add.code}: ${brief(steps.filter((e) => e.status === 'fail'))} ${add.stderr.slice(0, 400)}`);
  const set = steps.findLast((e) => e.step === 'limits');
  check('its limits step set them', set?.status === 'ok' && /^this fleet may use 1 of \d+ cores and 1 GB of /.test(set.detail), () => brief(set));
  oneAndOne('added');
  const up = sh(L, 'svall --json host upgrade limited --release /opt/it/svall-companion-*.tar.gz --allow-unsigned </dev/null', { ok: false });
  const upSteps = carriedSteps(up);
  check('the upgrade ran', upSteps.some((e) => e.step === 'probe' && e.status === 'ok') && !upSteps.some((e) => e.status === 'fail'), () => `${up.code}: ${brief(upSteps.filter((e) => e.status !== 'ok'))} ${up.stderr.slice(0, 400)}`);
  oneAndOne('upgraded');
  // step 21 makes box anew
  sh(L, 'svall host remove limited --forget --json </dev/null');
  docker(['rm', '-f', B]);
}

function bornOnWorker(ids, fx) {
  const rel = 'src/app/.claude/worktrees/scout';
  sh(R, 'git -C ~/src/app worktree add -q -b scout .claude/worktrees/scout');
  const id = JSON.parse(sh(R, `svall --json robot new --island ${fx.island} --cwd ${HOMES[R]}/${rel} --name scout --claude`).stdout).id;
  sh(L, `svall robot wait ${id} --until idle --timeout 60`);
  turn(ids, { scout: id }, 'scout', 'a turn on remote');
  // its work there
  sh(R, String.raw`set -eu
cd ~/src/app/.claude/worktrees/scout
printf 'scout commit
' > s.txt && git add s.txt && git -c user.name=Integration -c user.email=integration@example.invalid commit -qm 'a commit on the worker' -- s.txt
printf 'scout staged
' >> lib/c.txt && git add lib/c.txt
printf 'scout unstaged
' >> a.txt
printf 'scout untracked
' > s-untracked.txt
`);
  const w0 = snap(R);
  const sessionId = robotIn(w0, id)?.agent?.sessionId;
  const m = move(id, 'local');
  check('returned', m.code === 0 && m.res?.ok, () => `exit ${m.code}: ${m.stderr.trim()} ${brief(m.res)}`);
  const [l, w] = [snap(L), snap(R)];
  sameWork('mac worktree', l, w0, rel);
  check('mac unlocked', l.locks[rel] === null, () => brief(l.locks));
  check('worker locked', /^moved to .+ mv_[0-9a-z]{10}$/.test(w.locks[rel] ?? '') && w.locks[rel].endsWith(m.res?.moveId), () => brief(w.locks));
  check('mac main on its branch', l.git['src/app'].branch === 'refs/heads/main', () => brief(l.git['src/app']));
  const c = robotIn(l, id);
  check('home record', !c?.machine && c?.left?.machine === ids.remote && c.left.path === `${HOMES[R]}/${rel}` && c.cwd === `${HOMES[L]}/${rel}`, () => brief(c));
  check('journals', l.moves[m.res?.moveId]?.phase === 'done' && w.moves[m.res?.moveId]?.phase === 'done', () => brief([l.moves[m.res?.moveId], w.moves[m.res?.moveId]]));
  runsOn('mac', ids, l, w, id, 'local', sessionId);
  check('session back', transcriptOf(l, sessionId)?.sha === transcriptOf(w0, sessionId)?.sha, () => `${brief(transcriptOf(l, sessionId))} vs ${brief(transcriptOf(w0, sessionId))}`);
  turn(ids, { scout: id }, 'scout', 'a turn back on the Mac');
  originUntouched();
}

// ---------------------------------------------------------------------------------------------- a dial-out worker

// what a connect to a unix socket on local meets: open, or the error's code
const knock = (sock) => sh(L, `/opt/it/node/bin/node -e 'require("net").connect(process.argv[1]).on("connect", function () { console.log("open"); this.destroy(); }).on("error", (e) => console.log(e.code))' ${sock}`).stdout.trim();
const inode = (sock) => sh(L, `stat -c %i ${sock} 2>/dev/null || echo none`).stdout.trim();
const waitOn = (what, fn, seconds = 90) => {
  for (let i = 0; i < seconds * 2; i++) { if (fn()) return; sh(L, 'sleep 0.5'); }
  throw new Error(`${what} within ${seconds} s`);
};
// the ssh master remote's daemon holds to local
const MASTER = `pkill -9 -f '^ssh -M -S .* svall@${L}$'`;

// a call on a daemon's own API from its machine, as a window makes it
const windowCall = (m, method, params) => {
  const source = `
    import fs from 'node:fs';
    const home = process.env.HOME + '/.svall';
    const ws = new WebSocket('ws://127.0.0.1:' + fs.readFileSync(home + '/port', 'utf8').trim());
    ws.onopen = () => ws.send(JSON.stringify({ token: fs.readFileSync(home + '/token', 'utf8').trim() }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id === 0) ws.send(JSON.stringify({ id: 1, method: process.argv[1], params: JSON.parse(process.argv[2]) }));
      if (m.id === 1) { console.log(JSON.stringify(m)); process.exit(0); }
    };
  `;
  const shq = (text) => `'${text.replaceAll("'", `'\\''`)}'`;
  return JSON.parse(sh(m, `/opt/it/node/bin/node --input-type=module -e ${shq(source)} ${shq(method)} ${shq(JSON.stringify(params))}`).stdout);
};
const RULE = '~/.claude/rules/it-dial.md';
const readRule = (m) => sh(m, `cat ${RULE}`, { ok: false }).stdout;
const putRule = (m, text) => sh(m, `mkdir -p ~/.claude/rules && printf '%s\n' ${JSON.stringify(text)} > ${RULE}`);

// the mirror's guards on a worker that dials, whose first push since it began to dial is the one a Mac takes: what it replaces is kept
function dialedSetup(ids) {
  waitOn("remote takes the home's rule", () => readRule(R) === 'from the home\n');
  const folders = () => sh(R, 'ls ~/.svall/mirror-backup', { ok: false }).stdout.trim().split('\n').filter(Boolean);
  const [day] = folders();
  const kept = `~/.svall/mirror-backup/${day}/.claude/rules/it-dial.md`;
  check('the first push kept what it replaced', sh(R, `cat ${kept}`, { ok: false }).stdout === 'my own\n', () => `folders ${brief(folders())}`);
  check("the backup is its owner's alone", /^drwx------/.test(sh(R, `ls -ld ~/.svall/mirror-backup/${day}`).stdout) && /^-rw-------/.test(sh(R, `ls -l ${kept}`).stdout), () => sh(R, `ls -l ${kept}`).stdout);
  check('a file only the worker has stays', sh(R, 'cat ~/.claude/rules/it-only-here.md', { ok: false }).stdout === 'only here\n', () => 'it went');
  // Files reaches Claude's folder here and not the backup, by the path as by a link into it
  const home = sh(R, 'echo ~').stdout.trim();
  const files = (path) => windowCall(R, 'fs.read', { id: `r:${home}/.claude`, path });
  const plain = files('rules/it-only-here.md');
  check('Files reads the agent setup', plain.result?.text === 'only here\n', () => brief(plain));
  const sealed = files(`${home}/.svall/mirror-backup/${day}/.claude/rules/it-dial.md`);
  check('and the backup is sealed from it', /not the fleet's to open/.test(sealed.error?.message ?? ''), () => brief(sealed));

  // a tick answers once its push is applied
  putRule(L, 'changed on the home');
  const pushed = windowCall(L, 'machines.consent', { machine: ids.remote, item: 'it:none', fields: [], on: false });
  check('a second push lands', !pushed.error && readRule(R) === 'changed on the home\n', () => `${brief(pushed.error)} ${readRule(R)}`);
  check('and keeps no copy', folders().length === 1 && sh(R, `cat ${kept}`, { ok: false }).stdout === 'my own\n', () => `folders ${brief(folders())}`);

  const stranger = windowCall(L, 'machines.copySetupFrom', { machine: 'dddddddd-0000-4000-8000-000000000000' });
  check('a copy names a machine of the fleet', stranger.error?.code === 'not_found', () => brief(stranger));
  putRule(R, 'copied from the worker');
  const copied = windowCall(L, 'machines.copySetupFrom', { machine: ids.remote });
  check('the copy answers', copied.result?.sent > 0, () => brief(copied));
  check('the copy lands on the home', readRule(L) === 'copied from the worker\n', () => readRule(L));
  check('the home keeps what it replaced', !!copied.result?.backup && sh(L, `cat ${copied.result.backup}/.claude/rules/it-dial.md`, { ok: false }).stdout === 'changed on the home\n', () => brief(copied.result));

  // a server a Copy brings reads its variable from the home's .env, in a robot the home starts after it
  sh(R, `/opt/it/node/bin/node -e '${ADD_SERVERS}'`, { input: JSON.stringify({ itcopy: { command: 'npx', args: ['-y', 'it-copy-mcp'], env: { IT_COPY_KEY: '${IT_COPY_KEY}' } } }) });
  sh(L, "printf 'IT_COPY_KEY=xyz\\n' >> ~/.svall/.env");
  const brought = windowCall(L, 'machines.copySetupFrom', { machine: ids.remote });
  check('the copy brings the server', !brought.error && serversOn(L).itcopy?.env?.IT_COPY_KEY === '${IT_COPY_KEY}', () => `${brief(brought)} ${brief(serversOn(L).itcopy)}`);
  const reader = JSON.parse(sh(L, `svall --json robot new --island ${ctx.fx.island} --cwd ~/src/app --name itcopy --claude`).stdout).id;
  const started = until(L, (s) => agentsOf(s, reader).length === 1, 60);
  check("the home's robot has the variable", agentsOf(started, reader)[0]?.env?.includes('IT_COPY_KEY'), () => brief(agentsOf(started, reader)));
  sh(L, `svall robot close ${reader}`);

  // a push that fails here is told to this machine's window, until one lands
  const toml = sh(R, 'cat ~/.codex/config.toml', { ok: false }).stdout;
  sh(R, "mkdir -p ~/.codex && printf 'not toml [' > ~/.codex/config.toml");
  const refused = windowCall(L, 'machines.consent', { machine: ids.remote, item: 'it:none', fields: [], on: false });
  const told = windowCall(R, 'home.setup', {});
  check('a failed push is told', !!refused.error && /cannot be parsed/.test(told.result?.pushFailed ?? ''), () => `${brief(refused)} ${brief(told.result?.pushFailed)}`);
  sh(R, 'cat > ~/.codex/config.toml', { input: toml });
  const landed = windowCall(L, 'machines.consent', { machine: ids.remote, item: 'it:none', fields: [], on: false });
  const cleared = windowCall(R, 'home.setup', {});
  check('and cleared by the next that lands', !landed.error && cleared.result?.pushFailed === undefined, () => `${brief(landed)} ${brief(cleared.result?.pushFailed)}`);

  for (const m of [L, R]) sh(m, `rm -f ${RULE} ~/.claude/rules/it-only-here.md`);
}
// a window on a machine: its daemon's API and, over the forward that daemon makes, the home's
const shq = (text) => `'${text.replaceAll("'", `'\\''`)}'`;
const window = (m, source) => JSON.parse(sh(m, `/opt/it/node/bin/node --input-type=module -e ${shq(source)}`).stdout);
const opens = `
  import fs from 'node:fs';
  const home = process.env.HOME + '/.svall';
  const open = (port, token) => new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    const waiting = new Map();
    let n = 1;
    const call = (method, params = {}) => new Promise((ok) => { const id = n++; waiting.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
    ws.onopen = () => ws.send(JSON.stringify({ token }));
    ws.onerror = () => reject(new Error('no socket on ' + port));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 0) return resolve({ call, ws, protocol: m.result.protocol });
      if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    };
  });
  const here = await open(fs.readFileSync(home + '/port', 'utf8').trim(), fs.readFileSync(home + '/token', 'utf8').trim());`;

function dialOut(ids) {
  const ip = (m) => sh(m, `getent hosts ${m} | cut -d' ' -f1`).stdout.trim();
  const blockLocal = `-p tcp -d ${ip(R)} --dport 22 -j DROP`;
  sh(L, `iptables -I OUTPUT ${blockLocal}`, { root: true });
  try {
    check('local cannot reach remote over ssh', sh(L, `timeout 15 ssh -o BatchMode=yes -o ConnectTimeout=5 svall@${R} true`, { ok: false }).code !== 0, 'local still reaches remote');
    sh(L, 'cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys', { input: sh(R, 'cat ~/.ssh/id_ed25519.pub').stdout });
    sh(R, `ssh-keyscan -t ed25519 ${L} 2>/dev/null >> ~/.ssh/known_hosts && ssh -o BatchMode=yes svall@${L} true`);
    const record = JSON.parse(sh(L, 'cat ~/.config/svall/machines.json').stdout).machines[ids.remote];
    const since = linksOf()[ids.remote]?.since ?? 0;
    putRule(L, 'from the home');
    putRule(R, 'my own');
    sh(R, "printf 'only here\\n' > ~/.claude/rules/it-only-here.md");
    // the home's half over remote's own ssh, its token on stdout into the worker's half on stdin, as a join does it; the
    // worker's half reads the agents' folders from $SHELL, which docker exec leaves unset and a terminal or ssh sets
    const enrol = sh(R, String.raw`set -eu
umask 077
ssh -o BatchMode=yes svall@${L} '~/.local/bin/svall' --json fleet enroll-worker ${ids.remote} --name remote --platform linux --arch ${record.arch} --home ${HOMES[R]} --svall-base ${record.svallBase} > ~/enrol.json
/opt/it/node/bin/node -e '
const fs = require("fs");
const a = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
fs.rmSync(process.argv[1]);
require("child_process").execFileSync("svall", ["worker", "enroll", "--home-machine", a.homeMachineId, "--home-name", a.homeName, "--fleet-id", a.fleetId,
  "--home-ssh", process.argv[2], "--home-socket", a.socket, "--home-svall-base", a.homeSvallBase, "--home-platform", a.homePlatform, "--home-arch", a.homeArch, "--home-path", a.homePath], { input: a.token, stdio: ["pipe", "ignore", "inherit"], env: { ...process.env, SHELL: "/bin/bash" } });
console.log(a.socket);
' ~/enrol.json svall@${L}`);
    const socket = enrol.stdout.trim().split('\n').at(-1);
    const now = JSON.parse(sh(L, 'cat ~/.config/svall/machines.json').stdout).machines[ids.remote];
    check('the record dials in', now.dial === 'worker' && now.ssh === undefined, () => brief(now));
    const worker = JSON.parse(sh(R, 'cat ~/.svall/worker.json').stdout);
    check('worker.json dials local', worker.homeSsh === `svall@${L}` && worker.homeSocket === socket && worker.homeMachineId === ids.local, () => brief({ ...worker, token: undefined }));
    linked(ids, since);
    check('the socket', /^srw-------/.test(sh(L, `ls -l ${socket}`).stdout) && socket.startsWith(`${HOMES[L]}/.svall/w/`), () => sh(L, `ls -la ${socket}`, { ok: false }).stdout);

    dialedSetup(ids);

    if (ctx.at === 'remote') reposition(ids, 'local');
    reposition(ids, 'remote');
    const status = JSON.parse(sh(L, 'svall --json status').stdout);
    check("status shows remote's robot", status.robots[ctx.fx.faults]?.machine === ids.remote, () => brief(status.robots[ctx.fx.faults]));

    // a window on remote: what its daemon says of the home, then the home's own API over the forward it makes
    const ask = `${opens}
      const first = await here.call('fleet.home');
      const a = (await here.call('home.connection', { retry: true })).result;
      const far = a.port ? await open(a.port, a.token) : undefined;
      const seen = far && await far.call('fleet.home');
      const list = far && await far.call('machines.list');
      console.log(JSON.stringify({ first: first.result, state: a.state, ssh: a.ssh, controlSocket: a.controlSocket, hasToken: !!a.token, protocol: far?.protocol, seen: seen?.result, roles: list?.result.machines.map((r) => [r.id, r.role]) }));
      process.exit(0);`;
    const seen = window(R, ask);
    check('the daemon names its home and how to reach it', seen.first.mine === false && seen.first.machine === ids.local && seen.first.me === ids.remote && seen.state === 'connected' && seen.ssh === `svall@${L}` && seen.hasToken, () => brief(seen));
    check("the home's API answers over the forward", seen.seen?.mine === true && seen.seen?.machine === ids.local, () => brief(seen));
    check('the home lists each role', seen.roles?.[0]?.[0] === ids.local && seen.roles[0][1] === 'home' && seen.roles.some(([id, role]) => id === ids.remote && role === 'worker'), () => brief(seen));
    check('no token in a log', !sh(R, `grep -c ${shq(JSON.parse(sh(L, 'svall connection-info --json').stdout).token)} ~/.svall/svalld.log`, { ok: false }).stdout.trim().match(/^[1-9]/), () => "the home's token is in the worker's log");

    // the home's screens reach the worker's own daemon, which answers them for a window that loses the home
    const onHome = JSON.parse(sh(L, `svall --json robot new --island ${ctx.fx.island} --cwd ~/src/app --name onhome --claude`).stdout).id;
    sh(L, `svall robot wait ${onHome} --until idle --timeout 60`);
    const text = 'a turn on the home';
    turn(ids, { onhome: onHome }, 'onhome', text);
    let screen;
    for (let i = 0; i < 60 && !screen?.text?.includes(`did: ${text}`); i++) { if (i) sh(L, 'sleep 0.5'); screen = call(R, 'term.lastScreen', { id: onHome }); }
    check("remote holds the home's last screen", screen?.text?.includes(`did: ${text}`) && screen.at > 0, () => brief(screen));

    // a first start holds no screen until the home sends one as the link comes up, with no hook since
    const restarted = linksOf()[ids.remote]?.since;
    sh(R, `systemctl --user restart ${UNIT}`);
    linked(ids, restarted);
    let fresh;
    for (let i = 0; i < 60 && !fresh?.text?.includes(`did: ${text}`); i++) { if (i) sh(L, 'sleep 0.5'); fresh = call(R, 'term.lastScreen', { id: onHome }); }
    check('a worker just started holds the last screen', fresh?.text?.includes(`did: ${text}`), () => brief(fresh));

    // a robot started on the home while the worker was away: only the snapshot tells the worker of it, and its screen has to come after
    const beforeAway = linksOf()[ids.remote]?.since;
    sh(R, `systemctl --user stop ${UNIT}`);
    const whileAway = JSON.parse(sh(L, `svall --json robot new --island ${ctx.fx.island} --cwd ~/src/app --name whileaway --claude`).stdout).id;
    sh(L, `svall robot wait ${whileAway} --until idle --timeout 60`);
    const awayText = 'a turn while the worker was away';
    turn(ids, { whileaway: whileAway }, 'whileaway', awayText);
    sh(R, `systemctl --user start ${UNIT}`);
    linked(ids, beforeAway);
    let startedAway;
    for (let i = 0; i < 60 && !startedAway?.text?.includes(`did: ${awayText}`); i++) { if (i) sh(L, 'sleep 0.5'); startedAway = call(R, 'term.lastScreen', { id: whileAway }); }
    check('a worker holds the last screen of a robot started while it was away', startedAway?.text?.includes(`did: ${awayText}`), () => brief(startedAway));
    sh(L, `svall robot close ${whileAway}`);
    check('the worker answers its own diagnostics', call(R, 'feedback.preview').text?.length > 0, 'no diagnostics on the worker');

    // the home killed with its port file left: ssh still takes the forward's connection, and only a greeting tells
    const asked = `${opens}
      const a = (await here.call('home.connection', { retry: true })).result;
      console.log(JSON.stringify({ state: a.state, detail: a.detail, hasToken: !!a.token }));
      process.exit(0);`;
    const up = linksOf()[ids.remote]?.since;
    sh(L, `systemctl --user kill -s KILL --kill-whom=main ${UNIT}; systemctl --user stop ${UNIT}`, { ok: false });
    check('the port file stays behind', sh(L, 'test -f ~/.svall/port', { ok: false }).code === 0, 'the port file went with the daemon');
    const dead = window(R, asked);
    check('a home that does not greet reads unreachable', dead.state === 'unreachable' && !dead.hasToken, () => brief(dead));
    const lastly = call(R, 'term.lastScreen', { id: onHome });
    check('the last screen stands while it is away', lastly?.text?.includes(`did: ${text}`), () => brief(lastly));
    sh(L, `systemctl --user start ${UNIT}`);
    linked(ids, up);
    const back = window(R, asked);
    check('a home back reads connected', back.state === 'connected' && back.hasToken, () => brief(back));
    sh(L, `svall robot close ${onHome}`);

    const dials = () => Number(sh(R, "grep -c 'dialed ' ~/.svall/svalld.log", { ok: false }).stdout.trim());
    for (const m of [R, L]) {
      const before = linksOf()[ids.remote]?.since;
      const dialed = dials();
      sh(m, `systemctl --user restart ${UNIT}`);
      linked(ids, before);
      say(`   relinked after ${m}'s daemon restarted`);
      // the link is lost over a tunnel that stays whole, which needs no new bind
      if (m === L) {
        sh(L, 'sleep 2');
        check("local's restart takes no new dial", dials() === dialed, () => `${dials()} dials, ${dialed} before`);
      }
    }

    // the dial cut and its tunnel killed: the home loses remote, and links again once remote can dial
    const blockRemote = `-p tcp -d ${ip(L)} --dport 22 -j DROP`;
    sh(R, `iptables -I OUTPUT ${blockRemote}`, { root: true });
    const cut = linksOf()[ids.remote]?.since;
    sh(R, MASTER, { ok: false });
    waitOn('local marks remote unreachable', () => linksOf()[ids.remote]?.reachable === false);
    sh(R, `iptables -D OUTPUT ${blockRemote}`, { root: true });
    linked(ids, cut);

    // a master frozen, which ssh alone feels, keeps sshd's old listener, which takes the home's next stream, and no hello
    // answers it; the socket remote binds as it wakes ends that wait, which would otherwise last until the stream's ping fails
    const newDials = `-p tcp --syn -d ${ip(L)} --dport 22 -j DROP`;
    const asleep = linksOf()[ids.remote]?.since;
    sh(R, `iptables -I OUTPUT ${newDials}`, { root: true });
    const frozen = sh(R, `pgrep -f '^ssh -M -S .* svall@${L}$'`).stdout.trim();
    sh(R, `kill -STOP ${frozen}`);
    waitOn('local marks remote unreachable', () => linksOf()[ids.remote]?.reachable === false);
    sh(L, 'sleep 3');
    check('the old listener still takes a stream', knock(socket) === 'open', () => knock(socket));
    const dialedBefore = dials();
    sh(R, `iptables -D OUTPUT ${newDials}`, { root: true });
    waitOn('remote dials again', () => dials() > dialedBefore);
    const dialedAt = Date.now();
    linked(ids, asleep);
    const relink = Date.now() - dialedAt;
    sh(R, `kill -9 ${frozen}`, { ok: false });
    check('a wake onto a stream no hello answered links at once', relink < 5000, `${relink} ms after the dial`);

    // a tunnel gone without its cancel leaves a socket that refuses; with no home to remove it, remote's dial replaces it
    const down = linksOf()[ids.remote]?.since;
    sh(L, `systemctl --user stop ${UNIT}`);
    waitOn('the tunnel answers', () => knock(socket) === 'open');
    // a socket lost with the link down and the master up: only remote's beat, over that master, can tell
    sh(L, `rm -f ${socket}`);
    waitOn('remote binds its lost socket again', () => knock(socket) === 'open', 45);
    const was = inode(socket);
    sh(R, MASTER, { ok: false });
    waitOn('the dead tunnel refuses', () => knock(socket) === 'ECONNREFUSED', 20);
    check('the dead socket stays', inode(socket) === was, () => `${inode(socket)} vs ${was}`);
    // sshd binds no path that is there and nothing on local removes it, so only remote's clear and dial reopen it; the new
    // socket may get the old one's inode number
    waitOn('remote binds the path again', () => knock(socket) === 'open');
    sh(L, `systemctl --user start ${UNIT}`);
    linked(ids, down);

    reposition(ids, 'local');
  } finally {
    sh(L, `iptables -D OUTPUT ${blockLocal}`, { root: true, ok: false });
  }
  // a worker its home dials again, as the steps after this one take it
  sh(L, 'svall host remove remote --forget --json </dev/null');
  const again = sh(L, `svall host add remote --ssh svall@${R} --release /opt/it/svall-companion-*.tar.gz --allow-unsigned --json </dev/null`, { ok: false });
  const failed = lines(again.stdout).filter((e) => e.step && e.status === 'fail');
  check('remote goes back to the home dialing it', !failed.length && JSON.parse(sh(R, 'cat ~/.svall/worker.json').stdout).homeSsh === undefined, () => brief(failed));
  linked(ids);
}

// ---------------------------------------------------------------------------------------------- the agent setup mirror

/** The user-scope MCP servers `~/.claude.json` holds on `machine`. */
const serversOn = (machine) => JSON.parse(sh(machine, 'cat ~/.claude.json 2>/dev/null || echo {}').stdout).mcpServers ?? {};

const doctor = () => JSON.parse(sh(L, 'svall host doctor remote --json', { ok: false }).stdout).checks;
const mirrorRows = (checks) => Object.fromEntries(checks.filter((c) => c.name.startsWith('mirror:')).map((c) => [c.name.slice(7), c]));

const consent = (item, state) => Object.fromEntries(JSON.parse(sh(L, `svall host consent remote ${item} ${state} --json`).stdout).map((r) => [r.key, r]));

// a server's command the mocked agent never starts
const ECHO = { command: 'node', args: ['/opt/it/mcp-echo.mjs'] };
const SERVERS = {
  alpha: { ...ECHO, env: { ALPHA_KEY: 'secret-alpha-0001' } },
  beta: { ...ECHO, env: { BETA_KEY: 'secret-beta-0002' } },
  gamma: { ...ECHO, env: { GAMMA_TOKEN: '${GAMMA_TOKEN}' } },
};
// adds the servers on stdin to `~/.claude.json`'s user scope
const ADD_SERVERS = 'const fs = require("fs"); const f = process.env.HOME + "/.claude.json"; let j = {}; try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}'
  + ' j.mcpServers = { ...j.mcpServers, ...JSON.parse(fs.readFileSync(0, "utf8")) }; fs.writeFileSync(f, JSON.stringify(j, null, 2));';

function agentSetup(ids, fx) {
  const id = fx.agent;
  sh(L, `/opt/it/node/bin/node -e '${ADD_SERVERS}'`, { input: JSON.stringify(SERVERS) });
  const mac = serversOn(L);
  check('servers on the Mac', Object.entries(SERVERS).every(([k, v]) => same(mac[k], v)), () => brief(mac));

  const checks = doctor();
  // the unit holds the PATH the login shell there finds the agents on, nvm's claude among them
  const unitPath = checks.find((c) => c.name === 'daemon path');
  check('worker daemon path', unitPath?.status === 'ok', () => brief(unitPath));
  const rows = mirrorRows(checks);
  const unticked = (k) => rows[k]?.status === 'warn' && rows[k].tick?.on === false;
  const gamma = rows['var:GAMMA_TOKEN'];
  // every warning says what to do; beyond the agent setup's three, only the machine's advice: gh, and svall on a shell's PATH
  const todo = checks.filter((c) => c.status === 'warn' && c.action);
  const said = ['path', 'gh', 'mirror:claude:mcp:alpha', 'mirror:claude:mcp:beta', 'mirror:var:GAMMA_TOKEN'];
  check('unticked rows', unticked('claude:mcp:alpha') && unticked('claude:mcp:beta') && gamma?.status === 'warn' && gamma.run === 'svall worker env GAMMA_TOKEN'
    && same(todo.map((c) => c.name).sort(), said.sort()),
    () => `${brief(rows)}; to do ${brief(todo.map((c) => c.name))}`);

  const ticked = consent('claude:mcp:alpha', 'on');
  const after = serversOn(R);
  check('alpha ticked', after.alpha?.env?.ALPHA_KEY === 'secret-alpha-0001' && after.beta?.env?.BETA_KEY === '${BETA_KEY}'
    && ticked['claude:mcp:alpha']?.status === 'ok' && same(ticked['claude:mcp:alpha'].tick?.preview, ['env.ALPHA_KEY sec…01']),
  () => `${brief({ alpha: after.alpha, beta: after.beta })} ${brief(ticked['claude:mcp:alpha'])}`);
  // the files on remote that hold a value, under its home or in /tmp
  const holding = (value) => sh(R, `grep -rIl -D skip -- ${value} ~ /tmp 2>/dev/null`, { ok: false }).stdout.trim();
  const beta = holding('secret-beta-0002');
  const copied = holding('secret-alpha-0001');
  check('beta key nowhere there', beta === '' && copied.includes('/.claude.json'), () => `beta in ${brief(beta)}; alpha in ${brief(copied)}`);

  // the agent starts on remote after the variable is set there, so its environment holds it
  sh(R, "printf 'xyz' | svall worker env GAMMA_TOKEN");
  const set = mirrorRows(doctor())['var:GAMMA_TOKEN'];
  const moved = (r) => r.code === 0 && r.res?.ok;
  const back = robotIn(snap(L, true), id)?.machine === ids.remote ? move(id, 'local') : undefined;
  const m = move(id, 'remote');
  const w = until(R, (s) => agentsOf(s, id).length === 1, 60);
  const env = agentsOf(w, id)[0]?.env ?? [];
  check('GAMMA_TOKEN set there', set?.status === 'ok' && (!back || moved(back)) && moved(m) && env.includes('GAMMA_TOKEN'),
    () => `${brief(set)}; ${[back, m].filter(Boolean).map((r) => `move exit ${r.code}: ${r.stderr.trim()}`).join('; ')}; the agent's variables ${brief(env)}`);

  const pid = agentsOf(w, id)[0]?.pid;
  consent('claude:mcp:alpha', 'off');
  const alpha = serversOn(R).alpha;
  check('alpha unticked', alpha?.env?.ALPHA_KEY === '${ALPHA_KEY}' && pid && agentsOf(snap(R, true), id)[0]?.pid === pid,
    () => `${brief(alpha)}; agent ${pid} then ${brief(agentsOf(snap(R, true), id))}`);
  const left = holding('secret-alpha-0001');
  check('alpha key nowhere there', left === '', () => left);
}

// ---------------------------------------------------------------------------------------------- the user's ssh config

// the options a terminal's ssh to a robot on a worker runs with, as SurfaceManager.swift's AttachCommand builds it
const ATTACH = '-o ControlMaster=no -o BatchMode=yes -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes -o RemoteCommand=none -tt';
const AGENT = 'echo "agent=${SSH_AUTH_SOCK:-none}"';
// the port the config forwards for remote, and one its `Host *` forwards that a listener on local already holds
const FORWARDED = 47201;
const HELD = 47203;
const PROBE = `bash -c ': </dev/tcp/127.0.0.1/${FORWARDED}' 2>/dev/null && echo bound || echo free`;
const bound = () => sh(L, PROBE, { ok: false }).stdout.trim();

function sshConfig(ids, fx) {
  const app = fs.readFileSync(path.join(REPO, 'apps/desktop/mac/Sources/Svall/SurfaceManager.swift'), 'utf8');
  check('the app attaches so', app.includes(ATTACH), 'SurfaceManager.swift no longer builds the attach with ATTACH');
  const placed = snap(L, true).robots.find((c) => c.machine === ids.remote)?.id ?? fx.agent;
  if (robotIn(snap(L, true), placed)?.machine !== ids.remote) {
    const m = move(placed, 'remote');
    check('placed', m.code === 0 && m.res?.ok, () => `move exit ${m.code}: ${m.stderr.trim()}`);
  }
  // the config forwards an agent of local's, forwards ports on local and runs a command at every login
  if (docker(['exec', '-d', '-u', 'svall', L, '/opt/it/node/bin/node', '-e', `require('net').createServer().listen(${HELD}, '127.0.0.1')`]).code !== 0) throw new Error('the listener did not start');
  sh(L, `for i in $(seq 100); do bash -c ': </dev/tcp/127.0.0.1/${HELD}' 2>/dev/null && exit 0; sleep 0.1; done; exit 1`);
  sh(L, `ssh-agent -a /tmp/it-agent.sock >/dev/null && printf 'Host ${R}\\n  ForwardAgent /tmp/it-agent.sock\\n  LocalForward 127.0.0.1:${FORWARDED} 127.0.0.1:22\\n`
    + `  RemoteCommand echo the-config-ran\\nHost *\\n  LocalForward 127.0.0.1:${HELD} 127.0.0.1:22\\n  RemoteCommand echo every-host\\n' > ~/.ssh/config`);
  try {
    const since = linksOf()[ids.remote]?.since;
    sh(L, `systemctl --user restart ${UNIT}`);
    linked(ids, since);
    check('the master binds nothing', bound() === 'free', `127.0.0.1:${FORWARDED} is bound on local`);
    const attach = call(L, 'term.attach', { id: placed });
    const { ssh: dest, controlSocket } = attach.via ?? {};
    check('via', dest && controlSocket, () => brief(attach));
    const mux = sh(L, `ssh -S ${controlSocket} ${ATTACH} -- ${dest} '${AGENT}'`, { ok: false });
    check('attach', mux.code === 0 && mux.stdout.includes('agent=none'), () => `exit ${mux.code}: ${mux.stdout.trim()} ${mux.stderr.trim()}`);
    // a session that asks for the agent, as one through the user's config does
    const asks = sh(L, `ssh -S ${controlSocket} -o ControlMaster=no -o BatchMode=yes -o RemoteCommand=none -o ClearAllForwardings=yes -- ${dest} '${AGENT}'`, { ok: false });
    check('the master forwards no agent', asks.code === 0 && asks.stdout.includes('agent=none'), () => `exit ${asks.code}: ${asks.stdout.trim()} ${asks.stderr.trim()}`);
    // past the master's MaxSessions ssh logs in on its own, as it does here with no master on the socket; checked while it runs
    const own = sh(L, `ssh -S /tmp/it-no-master.sock ${ATTACH} -- ${dest} 'sleep 2; ${AGENT}' >/tmp/it-own.out 2>&1 & p=$!; sleep 1`
      + `; ${PROBE}; wait $p; echo "exit=$?"; cat /tmp/it-own.out`, { ok: false }).stdout;
    check('a login of its own', /^free\nexit=0\n/.test(own) && own.includes('agent=none'), () => own.trim());
    check('the attaches bind nothing', bound() === 'free', `127.0.0.1:${FORWARDED} is bound on local`);
    // host add again runs its first ssh, a master of its own and its probe over a forward on that master, past the held port
    const again = lines(sh(L, `svall host add remote --ssh svall@${R} --release /opt/it/svall-companion-*.tar.gz --allow-unsigned --json </dev/null`, { ok: false }).stdout);
    const failed = again.filter((e) => e.step && e.status === 'fail');
    const probe = again.find((e) => e.step === 'probe' && e.status !== 'start');
    check('host add again', failed.length === 0 && probe?.status === 'ok', () => brief(failed.length ? failed : probe));
  } finally {
    sh(L, 'rm -f ~/.ssh/config; pkill -f "^ssh-agent -a /tmp/it-agent.sock"; pkill -f "^/opt/it/node/bin/node -e require"', { ok: false });
    const since = linksOf()[ids.remote]?.since;
    sh(L, `systemctl --user restart ${UNIT}`);
    linked(ids, since);
  }
}

// ---------------------------------------------------------------------------------------------- the fault matrix

// a drop lands only where the move needs the link: on the way back the prepare is this Mac's own, and the move runs on
const settlesDone = (fault, at, dir) => !PRE.has(at) || (fault === 'drop' && dir === 'back' && at === 'prepare');

let n = 0;
/** One move of `faults` from the home's driver, out to remote or back, with a fault at a phase. */
function drive(dir, fault, at) {
  const label = `${String(++n).padStart(2, '0')}-${fault ?? 'clean'}${at ? `-${at}` : ''}-${dir}`;
  const f = fault ? ` --fault ${fault} --at ${at}` : '';
  const r = sh(L, `IT_LINK=${R}:7070 /opt/it/node/bin/node /opt/it/machine.mjs drive ${dir === 'out' ? 'move' : 'return'} ${ctx.fx.faults} --machine remote${f}`);
  const summary = JSON.parse(r.stdout.trim().split('\n').at(-1));
  fs.writeFileSync(path.join(out, `${label}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
  return { label, summary };
}

const ctx = { fx: undefined, at: 'local', origin: undefined, slept: undefined };

/** Waits for the move to end: after the restart a kill brings, once a dropped link is back, or, when it stalls, after `--retry` or a restart. */
function settle(ids, moveId, fault) {
  const ended = (s) => ['done', 'aborted'].includes(s.moves[moveId]?.phase);
  let how = { kill: 'after the restart', drop: 'once the link was back' }[fault] ?? 'on its own';
  let s = until(L, (x) => ended(x) && x.machines[ids.remote]?.reachable, 150);
  if (!ended(s)) {
    const c = robotIn(snap(L), ctx.fx.faults);
    if (c?.moving?.error) {
      how = 'after --retry';
      sh(L, `svall robot move ${ctx.fx.faults} --retry </dev/null`, { ok: false });
    } else {
      how = 'after a restart';
      sh(L, `systemctl --user restart ${UNIT}`);
    }
    s = until(L, (x) => ended(x) && x.machines[ids.remote]?.reachable, 150);
  }
  return { s, how };
}

function reposition(ids, to) {
  const sessionId = robotIn(snap(L, true), ctx.fx.faults)?.agent?.sessionId;
  const d = drive(to === 'remote' ? 'out' : 'back');
  check('moved', d.summary.exit === 0, () => brief(d.summary));
  const { s } = settle(ids, d.summary.moveId);
  check('done', s.moves[d.summary.moveId]?.phase === 'done', () => brief(s.moves[d.summary.moveId]));
  runsOn('moved', ids, s, snap(R, true), ctx.fx.faults, to, sessionId);
  ctx.at = to;
}

function scenario(ids, fault, at, dir) {
  const id = ctx.fx.faults;
  const want = settlesDone(fault, at, dir) ? 'done' : 'aborted';
  const [src, dst] = dir === 'out' ? ['local', 'remote'] : ['remote', 'local'];
  const before = { local: snap(L), remote: snap(R) };
  const sessionId = robotIn(before.local, id)?.agent?.sessionId;
  const pid = agentsOf(before[src], id)[0]?.pid;
  const d = drive(dir, fault, at);
  const { summary } = d;
  check('fault landed', summary.trigger?.phase === at, () => `wanted ${at}: ${brief({ trigger: summary.trigger, phases: summary.phases, exit: summary.exit, stderr: summary.stderr })}`);
  const { s, how } = settle(ids, summary.moveId, fault);
  const phase = s.moves[summary.moveId]?.phase;
  const after = { local: snap(L), remote: snap(R) };
  const where = phase === 'done' ? dst : src;
  ctx.at = where;
  check('journal ended', phase === want, () => `${phase}, wanted ${want}: ${brief(s.moves[summary.moveId])}`);
  check('worker journal', !after.remote.moves[summary.moveId] || after.remote.moves[summary.moveId].phase === phase, () => brief(after.remote.moves[summary.moveId]));
  runsOn('after', ids, after.local, after.remote, id, where, sessionId, phase === 'aborted' ? pid : undefined);
  if (phase === 'aborted') {
    // the robot's worktree is its own again as it was, and the destination keeps no worktree the move made
    check('source unlocked', after[src].locks['src/app-faults'] === null, () => brief(after[src].locks));
    sameWork('source worktree', after[src], before[src], 'src/app-faults');
    check('no stray worktree', same(after[dst].locks, before[dst].locks), () => `${brief(after[dst].locks)} vs ${brief(before[dst].locks)}`);
  }
  originUntouched();
  say(`   ${fault} at ${at}, ${dir === 'out' ? 'local -> remote' : 'remote -> local'}: landed at ${summary.trigger?.phase ?? 'none'} in ${summary.trigger?.ms ?? '-'} ms; ${phase} ${how}, runs on ${where}`);
}

const ORDER = PHASES.flatMap((at) => [['kill', at, 'out'], ['drop', at, 'out'], ['kill', at, 'back'], ['drop', at, 'back']]);

function chosen(spec = 'all') {
  if (spec === 'none') return [];
  if (spec === 'all') return ORDER;
  const want = spec.split(',');
  const known = new Set(['kill', 'drop', ...ORDER.map(([f, at]) => `${f}@${at}`)]);
  const odd = want.filter((w) => !known.has(w));
  if (odd.length) throw new Error(`unknown scenario ${odd.join(', ')}: use all, none, kill, drop or <kill|drop>@<${PHASES.join('|')}>`);
  return ORDER.filter(([f, at]) => want.includes(f) || want.includes(`${f}@${at}`));
}

function faults(ids, list) {
  for (const [fault, at, dir] of list) {
    const from = dir === 'out' ? 'local' : 'remote';
    if (ctx.at !== from) step(`reposition -> ${from}`, () => reposition(ids, from));
    step(`${fault} at ${at}, ${dir === 'out' ? 'local -> remote' : 'remote -> local'} (${PRE.has(at) ? 'pre' : 'post'}-commit)`, () => scenario(ids, fault, at, dir));
  }
}

// ---------------------------------------------------------------------------------------------- the home moves

const homeOf = (m) => JSON.parse(sh(m, 'svall --json fleet home').stdout);
const moveSteps = (text) => lines(text).filter((e) => e.step);
const windows = (m) => sh(m, "tmux -S ~/.svall/tmux.sock list-windows -a -F '#{window_id} #{pane_pid}' | sort", { ok: false }).stdout;
const FAULT = '~/.svall/home-fault';
const ipOf = (m) => sh(m, `getent hosts ${m} | cut -d' ' -f1`).stdout.trim();
const blockSsh = (from) => `-p tcp -s ${ipOf(from)} --dport 22 -j DROP`;

// exactly one daemon runs as the home, the other as its worker, and each answers
function oneHome(home, ids) {
  const [a, b] = [homeOf(home), homeOf(home === L ? R : L)];
  check('one home', a.mine === true && b.mine === false, () => brief({ [home]: a, other: b }));
  check('the worker names it', b.machine === (home === L ? ids.local : ids.remote), () => brief(b));
}

function setHome(on, target, label = target) {
  const r = sh(on, `svall --json fleet home set ${target} </dev/null`, { ok: false });
  const steps = moveSteps(r.stdout);
  for (const e of steps.filter((x) => x.status === 'fail')) check(`${label}: ${e.step}`, false, `${e.detail ?? ''} ${e.action ?? ''}`);
  check(`${label} exit`, r.code === 0, () => `${r.code}: ${r.stderr.slice(0, 400)}`);
  return steps;
}

// a key of the fleet.json on a machine; none, and it goes
const fleetKey = (m, key, value) => sh(m, `/opt/it/node/bin/node -e 'const fs = require("fs"); const f = process.env.HOME + "/.svall/fleet.json"; const j = JSON.parse(fs.readFileSync(f, "utf8")); j[process.argv[1]] = process.argv[2] && JSON.parse(process.argv[2]); fs.writeFileSync(f, JSON.stringify(j, null, 2));' ${key} ${value === undefined ? '' : shq(JSON.stringify(value))}`);
// two paths under the account a home leaves, one the machine taking the fleet has and one it does not; the check goes by that machine's answer
const namePaths = (m, nowhere) => {
  fleetKey(m, 'defaultCwd', `${HOMES[m]}/${nowhere}`);
  fleetKey(m, 'onboarding', { firstProject: `${HOMES[m]}/src`, scribe: false });
};
const dropPaths = (m) => { fleetKey(m, 'defaultCwd'); fleetKey(m, 'onboarding'); };
function saysLacking(label, steps, nowhere, name) {
  const said = steps.find((e) => e.step === 'check' && e.status === 'ok')?.detail ?? '';
  check(`${label}: the check says what the far machine lacks, and passes`, said.includes(`new robots' folder becomes ~/${nowhere}, which ${name} does not have yet`) && !said.includes('first project folder'), said);
}
// the folder a repo's notes lie in on a home at `home`, by the path of its main checkout there
const NOTE = 'it-note.md';
const repoNotes = (home) => `~/.svall/docs/repos/app-${crypto.createHash('sha256').update(`${home}/src/app`).digest('hex').slice(0, 8)}`;

function homeMoves(ids, fx) {
  if (ctx.at !== 'remote') reposition(ids, 'remote');
  // the robot that goes each way once the home has moved runs here as that move comes
  if (robotIn(snap(L, true), fx.agent)?.machine === ids.remote) {
    const m = move(fx.agent, 'local');
    check('agent runs on local', m.code === 0 && m.res?.ok, () => `exit ${m.code}: ${m.stderr.trim()}`);
  }
  ctx.generation = robotIn(snap(L, true), fx.agent)?.placement?.generation ?? 0;
  // nothing on remote can reach local from here on, so what links them after is local's own dial
  sh(L, `iptables -I INPUT ${blockSsh(R)}`, { root: true });
  ctx.blocked = true;
  // a fleet past what a move carries stops at the check, whichever way it would go
  sh(L, 'mkdir -p ~/.svall/retro && truncate -s 200M ~/.svall/retro/it-big');
  const big = sh(L, 'svall --json fleet home set remote </dev/null', { ok: false });
  const bigFailed = moveSteps(big.stdout).find((e) => e.status === 'fail');
  check('a fleet too big to carry is refused at the check', big.code !== 0 && bigFailed?.step === 'check' && /^The fleet's files are 2\d\d MB; a move carries \d+ MB$/.test(bigFailed.detail), () => `${big.code}: ${brief(bigFailed)}`);
  sh(L, 'rm -f ~/.svall/retro/it-big');
  check('and the home goes on, with nothing of a move', homeOf(L).mine === true && call(L, 'fleet.homeMove', { op: 'status' }).moving === undefined && !moveLeft(L), () => moveLeft(L));
  // mission control's robot, which goes first with the move engine, and the phone, which travels as what it was
  const crew = JSON.parse(sh(L, 'svall --json robot new --island home --cwd ~/.svall/home --name crew --claude').stdout).id;
  sh(L, `svall robot wait ${crew} --until idle --timeout 60`);
  const phone = call(L, 'mobile.set', { enabled: true });
  check('the phone serves on local', phone.serving === true, () => brief(phone));
  call(L, 'push.subscribe', { endpoint: 'https://push.example/phone', keys: { p256dh: 'p256dh', auth: 'auth' }, statuses: ['done'] });
  check('a push subscription to carry', sh(L, 'cat ~/.svall/push.json', { ok: false }).stdout.includes('push.example'), 'push.json holds none');
  const before = { L: windows(L), R: windows(R), push: sh(L, 'cat ~/.svall/push.json', { ok: false }).stdout, pass: sh(L, 'cat ~/.svall/mobile-pass').stdout };
  const robots = snap(L, true).robots.map((r) => r.id);
  // a Copy this home takes before it leaves: its record must not read as a push's on the first it takes as a worker
  sh(L, 'mkdir -p ~/.claude/rules && echo only here > ~/.claude/rules/it-only-here.md');
  putRule(R, 'copied onto the old home');
  const taken = windowCall(L, 'machines.copySetupFrom', { machine: ids.remote });
  check('the home takes a copy before it moves', !taken.error && readRule(L) === 'copied onto the old home\n', () => `${brief(taken)} ${readRule(L)}`);
  // a repo's notes, which take the name its path has on the new home
  sh(L, `mkdir -p ${repoNotes(HOMES[L])} && echo notes of the repo > ${repoNotes(HOMES[L])}/${NOTE}`);
  ctx.noted = true;
  namePaths(L, 'it-nowhere');
  const steps = setHome(L, 'remote');
  check('the steps ran in order', ['check', 'mission', 'pause', 'copy', 'mark', 'adopt', 'join', 'probe'].every((want) => steps.some((e) => e.step === want && e.status !== 'fail')), () => brief(steps));
  oneHome(R, ids);
  saysLacking('going out', steps, 'it-nowhere', 'remote');
  check('the paths went in as ~/…', JSON.parse(sh(R, 'cat ~/.svall/fleet.json').stdout).defaultCwd === '~/it-nowhere', () => sh(R, 'cat ~/.svall/fleet.json').stdout);
  for (const m of [L, R]) dropPaths(m);
  check("the repo's notes go by its path there", sh(R, `cat ${repoNotes(HOMES[R])}/${NOTE}`, { ok: false }).stdout === 'notes of the repo\n', () => sh(R, 'ls ~/.svall/docs/repos', { ok: false }).stdout);
  const kept = (was, is) => was.split('\n').filter(Boolean).every((w) => is.includes(w));
  check("local's windows stay, but for the crew's", windows(L).split('\n').filter(Boolean).every((w) => before.L.includes(w)), () => `${windows(L)} vs ${before.L}`);
  check("remote's windows stay", kept(before.R, windows(R)), () => `${windows(R)} vs ${before.R}`);
  const far = JSON.parse(sh(R, 'svall --json status').stdout);
  check('mission control moved first and runs on the home', far.robots[crew]?.machine === undefined && far.robots[crew]?.tmux !== undefined, () => brief(far.robots[crew]));
  let served;
  // the new home's daemon turns it on once it has seen the commit
  for (let i = 0; i < 40 && !served?.serving; i++) { if (i) sh(R, 'sleep 0.5'); served = call(R, 'mobile.get'); }
  check('remote serves the phone, under the same pass', served.serving === true && served.logins.includes('svall@integration'), () => brief({ serving: served.serving, logins: served.logins }));
  check('one origin at a time: local no longer serves', call(L, 'home.fallback', { on: false }) !== undefined && sh(L, 'test -f ~/.tailscale-double.json', { ok: false }).code !== 0, 'local still serves');
  check('what was staged is gone from local, keys and all', sh(L, 'ls -d ~/.svall/adopt-* 2>/dev/null', { ok: false }).stdout === '', 'an adopt folder stays');
  for (const id of robots) check(`${id} in the fleet on remote`, far.robots[id] !== undefined, () => id);
  const hosted = JSON.parse(sh(L, 'svall --host remote --json status', { ok: false }).stdout || '{}');
  check('svall --host remote on local lists every robot', robots.every((id) => hosted.robots?.[id]), () => brief(Object.keys(hosted.robots ?? {})));
  check('a robot here runs on local', far.robots[fx.agent]?.machine === ids.local || far.robots[fx.agent]?.machine === undefined, () => brief(far.robots[fx.agent]));
  const worker = JSON.parse(sh(L, 'cat ~/.svall/worker.json').stdout);
  check('local dials remote', worker.homeMachineId === ids.remote && worker.homeSsh === `svall@${R}`, () => brief({ ...worker, token: undefined }));
  check('push.json and the pass came along', sh(R, 'cat ~/.svall/push.json', { ok: false }).stdout === before.push && sh(R, 'cat ~/.svall/mobile-pass').stdout === before.pass, 'they differ');
  check('nothing staged stays', sh(R, 'ls -d ~/.svall/adopt-* 2>/dev/null', { ok: false }).stdout === '', 'adopt folder left');
  check("local keeps the old files", sh(L, 'ls -d ~/.svall/state.json.home-* ~/.svall/docs.home-*', { ok: false }).code === 0, 'no copy kept');
  // what the new home knows of local, over local's own dial
  let seen;
  for (let i = 0; i < 120 && !seen?.reachable; i++) { if (i) sh(R, 'sleep 1'); seen = call(R, 'machines.list').machines.find((m) => m.id === ids.local); }
  check('the new home reaches local, with its robots', seen?.reachable === true && seen.robots > 0, () => brief(seen));
  ctx.home = 'remote';
  movedSetup(ids);
  cloneAcross(ids, fx);
}

// a robot in a clone, each way with the home moved, as decision 1 has it: it went through the relabel as local's, and each move runs over local's dial
function cloneAcross(ids, fx) {
  const id = fx.agent;
  const rel = 'src/app-wt';
  const relabelled = robotIn(snap(R, true), id);
  check("its record names local, at the generation it had", relabelled?.machine === ids.local && relabelled.placement?.generation === ctx.generation, () => brief(relabelled));
  let generation = ctx.generation;
  const across = (to) => {
    const [dest, src] = to === 'remote' ? [R, L] : [L, R];
    const base = snap(src);
    const sessionId = robotIn(snap(R), id)?.agent?.sessionId;
    // from the home, whose own machine is `local` to it
    const r = sh(R, `svall robot move ${id} --machine ${to === 'remote' ? 'local' : ids.local} --json </dev/null`, { ok: false });
    const moved = (() => { try { return JSON.parse(r.stdout); } catch { return undefined; } })();
    check(`${to}: moved`, r.code === 0 && moved?.ok, () => `exit ${r.code}: ${r.stderr.trim()} ${r.stdout.slice(0, 300)}`);
    const [home, there, left] = [snap(R), snap(dest), snap(src)];
    const c = robotIn(home, id);
    check(`${to}: the home's record`, (c?.machine ?? 'remote') === (to === 'remote' ? 'remote' : ids.local) && !c.moving && c.cwd === `${HOMES[dest]}/${rel}`, () => brief(c));
    check(`${to}: the next generation`, c?.placement?.generation === ++generation, () => `${brief(c?.placement)}, wanted ${generation}`);
    check(`${to}: where it left`, c?.left?.machine === (to === 'remote' ? ids.local : ids.remote) && c.left.path === `${HOMES[src]}/${rel}` && c.left.moveId === moved?.moveId, () => brief(c?.left));
    check(`${to}: journals`, there.moves[moved?.moveId]?.phase === 'done' && left.moves[moved?.moveId]?.phase === 'done', () => brief([there.moves[moved?.moveId], left.moves[moved?.moveId]]));
    sameWork(`${to}: worktree`, there, base, rel);
    const procs = agentsOf(there, id);
    check(`${to}: one agent, on its session`, procs.length === 1 && agentsOf(left, id).length === 0 && procs[0].args.at(-2) === '--resume' && procs[0].args.at(-1) === sessionId, () => `${brief(procs)} ${brief(agentsOf(left, id))}`);
    check(`${to}: its window`, there.windows.some((x) => x.name === id) && !left.windows.some((x) => x.name === id), () => `${brief(there.windows)} / ${brief(left.windows)}`);
    // through the home, which reaches whichever machine runs it
    const text = `a turn on ${to} with the home moved`;
    sh(R, `svall robot run ${id} '${text}' && svall robot wait ${id} --until done,idle --timeout 60`);
    const read = sh(R, `svall robot read ${id} --transcript --lines 1`).stdout;
    check(`${to}: the turn reached the home`, read.includes(`did: ${text}`) && robotIn(snap(R, true), id)?.agent?.prompt === text, () => read.slice(-300));
    originUntouched();
  };
  across('remote');
  across('local');
}

// every copy kept of the rule, an earlier step's among them, as a second of one name goes beside the first
const kept = (m) => sh(m, 'cat ~/.svall/mirror-backup/*/.claude/rules/it-dial.md*', { ok: false }).stdout;
// a person's press, as a window sends it: a tick answers once its push is applied, which waits for a link a move's end closed
const pushed = (home, worker) => waitOn(`${worker} takes a push`, () => !windowCall(home, 'machines.consent', { machine: worker, item: 'it:none', fields: [], on: false }).error);

// the new home is the source and a change there lands on this machine, past a copy of what it held; the Copy goes on its own
function movedSetup(ids) {
  waitOn('the first push lands on local', () => kept(L).includes('copied onto the old home'));
  check('what a Copy wrote on the old home is copied before a push takes it', kept(L).includes('copied onto the old home'), () => kept(L));
  putRule(R, 'changed on the new home');
  pushed(R, ids.local);
  check('a change on the new home lands on local', readRule(L) === 'changed on the new home\n', () => readRule(L));
  check('and the copy kept stands', kept(L).includes('copied onto the old home'), () => kept(L));
  check('a file only local has stays', sh(L, 'cat ~/.claude/rules/it-only-here.md', { ok: false }).stdout === 'only here\n', 'it went');

  putRule(L, 'copied from local');
  const copied = windowCall(R, 'machines.copySetupFrom', { machine: ids.local });
  check('the one-shot copy lands on the new home', !copied.error && readRule(R) === 'copied from local\n', () => `${brief(copied)} ${readRule(R)}`);
  check('which keeps what it replaced', kept(R).includes('changed on the new home'), () => kept(R));
  const seeded = windowCall(R, 'machines.copySetupFrom', { machine: ids.local, seed: true });
  check('a home that holds a setup is never seeded', seeded.error?.code === 'refused', () => brief(seeded));
}

// the same on the home that came back, whose worker it dials
function cameBackSetup(ids) {
  putRule(L, 'changed on the home that came back');
  pushed(L, ids.remote);
  check('a change on the home that came back lands on remote', readRule(R) === 'changed on the home that came back\n', () => readRule(R));
  putRule(R, 'copied from remote');
  const copied = windowCall(L, 'machines.copySetupFrom', { machine: ids.remote });
  check('the one-shot copy lands on the home that came back', !copied.error && readRule(L) === 'copied from remote\n', () => `${brief(copied)} ${readRule(L)}`);
  check('which keeps what it replaced, by a record of its own', kept(L).includes('changed on the home that came back'), () => kept(L));
  for (const m of [L, R]) sh(m, `rm -f ${RULE} ~/.claude/rules/it-only-here.md`);
}

function homeBack(ids, again = true) {
  const before = { L: windows(L), R: windows(R) };
  namePaths(R, 'it-nowhere-back');
  // the Mac drives it, whatever else there is to reach
  const steps = setHome(L, 'local');
  check('the steps ran', steps.some((e) => e.step === 'join' && e.status === 'ok'), () => brief(steps));
  oneHome(L, ids);
  saysLacking('coming back', steps, 'it-nowhere-back', 'this machine');
  for (const m of [L, R]) dropPaths(m);
  if (ctx.noted) check("the repo's notes go by its path here again", sh(L, `cat ${repoNotes(HOMES[L])}/${NOTE}`, { ok: false }).stdout === 'notes of the repo\n', () => sh(L, 'ls ~/.svall/docs/repos', { ok: false }).stdout);
  check("remote's windows stay, but for what came home", windows(R).split('\n').filter(Boolean).every((w) => before.R.includes(w)), () => `${windows(R)} vs ${before.R}`);
  check("local's windows stay", before.L.split('\n').filter(Boolean).every((w) => windows(L).includes(w)), () => `${windows(L)} vs ${before.L}`);
  check('remote takes local as its home', JSON.parse(sh(R, 'cat ~/.svall/worker.json').stdout).homeMachineId === ids.local, 'remote names another');
  check('nothing staged stays on either', sh(L, 'ls -d ~/.svall/adopt-* 2>/dev/null', { ok: false }).stdout === '' && sh(R, 'ls -d ~/.svall/adopt-* 2>/dev/null', { ok: false }).stdout === '', 'an adopt folder stays');
  ctx.home = 'local';
  if (!again) return;
  cameBackSetup(ids);
  // a move each way on the home that came back
  reposition(ids, ctx.at === 'remote' ? 'local' : 'remote');
  reposition(ids, ctx.at === 'remote' ? 'local' : 'remote');
}

// a process dies at each boundary; whatever is left, one home answers once a person has retried or called it off
const JOIN = ['join.kept', 'join.state', 'join.docs', 'join.worker', 'join.done'];
const INSTALL = ['adopt.stopped', 'adopt.installing', 'adopt.file', 'adopt.dropped', 'adopt.registry', 'adopt.installed', 'adopt.started', 'adopt.committed'];
// where each runs: `out` from the home on local to remote, `back` from remote to local, which only local can drive
// the new home's daemon re-enrolling a worker, past the commit: only with a Linux worker to re-enrol
const REJOIN = ['rejoin.enrolling', 'rejoin.enrolled', 'rejoin.done'];
const POINTS = {
  out: [
    ['adopt.staging', 'far'], ['adopt.staged', 'far'], ...INSTALL.map((p) => [p, 'far']),
    ['mark.written', 'near'], ['move.marked', 'near'], ['enrol.written', 'near'], ...JOIN.map((p) => [p, 'near']),
    ['move.paused', 'near'], ['move.joined', 'near'],
    ...REJOIN.map((p) => [p, 'far']),
  ],
  back: [
    ['deliver.owed', 'near'], ['move.marked', 'near'], ['adopt.staging', 'near'], ['adopt.staged', 'near'], ...INSTALL.map((p) => [p, 'near']), ['deliver.told', 'near'],
    ['mark.written', 'far'], ['enrol.written', 'far'], ...JOIN.map((p) => [p, 'far']),
    ...REJOIN.map((p) => [p, 'near']),
  ],
};

// reached only in the recovery of a kill before them: each, after which kill, ended how, and whether a person starts the units:
// a daemon started by hand restores a cut install itself and needs no restart after it
const RECOVERY = [['restore.restarting', 'adopt.dropped', 'abort', false], ['restore.file', 'adopt.dropped', 'abort'], ['restore.done', 'adopt.dropped', 'retry'], ['abort.recorded', 'adopt.stopped', 'abort']];

const revive = (m) => sh(m, `systemctl --user is-active ${UNIT} || systemctl --user start ${UNIT}`, { ok: false });
const tryHome = (m) => { try { return JSON.parse(sh(m, 'svall --json fleet home', { ok: false }).stdout); } catch { return undefined; } };
const moveLeft = (m) => sh(m, 'ls -d ~/.svall/home-moving.json ~/.svall/home-deliver.json ~/.svall/adopt-* 2>/dev/null', { ok: false }).stdout.trim();
const settledHomes = () => {
  const [a, b] = [tryHome(L), tryHome(R)];
  return a && b && a.mine !== b.mine && !moveLeft(L) && !moveLeft(R);
};
const homeAt = () => (tryHome(L)?.mine ? 'local' : 'remote');
function placeHome(where) {
  if (homeAt() !== where) setHome(L, where);
  if (homeAt() !== where) throw new Error(`the home did not move to ${where}`);
  ctx.home = where;
  // the link a move's end closed comes back on its own backoff, and until then a check refuses, as it does a person
  const to = JSON.parse(sh(where === 'local' ? R : L, 'svall version --json').stdout).machineId;
  for (let i = 0; i < 90 && !call(L, 'fleet.homeCheck', { to }).ok; i++) sh(L, 'sleep 1');
}

// each move this machine has a part in ended, and none stands between: `released` is the old home's alone, whose journal holds nothing else
function journalsEnded(label, m) {
  const said = sh(m, 'for f in ~/.svall/journal/home/hm_*.ndjson; do case $f in *.driver.ndjson) ;; *) echo "$f $(grep -vc \'"phase":"served"\' "$f") $(grep -v \'"phase":"served"\' "$f" | tail -n 1)" ;; esac; done', { ok: false }).stdout;
  for (const line of said.split('\n').filter((l) => l.includes('{'))) {
    const phase = JSON.parse(line.slice(line.indexOf('{'))).phase;
    const lone = / 1 \{/.test(line);
    check(`${label}: journal on ${m}`, phase === 'done' || phase === 'aborted' || (phase === 'released' && lone), () => line);
  }
}

// each robot as the home holds it: the machine it runs on and its note, which a rollback past a write would lose
const robotsHeld = (on) => {
  const { machine } = homeOf(on);
  return Object.fromEntries(Object.values(call(on, 'state.get').robots).map((r) => [r.id, `${r.machine ?? machine}: ${r.note}`]));
};
const sameRobots = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

const homeView = () => ({ L: windows(L), R: windows(R), robots: robotsHeld(tryHome(L)?.mine ? L : R) });

// where a fault ends. Before the old home's mark nothing can be adopted; past the new home's answer a call-off comes too late, and it goes through
const BEFORE_MARK = { out: ['adopt.staging', 'adopt.staged', 'mark.written', 'move.paused'], back: ['deliver.owed', 'adopt.staging', 'adopt.staged', 'mark.written'] };
const PAST_ANSWER = ['adopt.installed', 'adopt.started', 'adopt.committed', 'enrol.written', 'deliver.told', 'move.joined', ...JOIN];
const endsOn = (dir, ending) => (ending === 'retry') === (dir === 'out') ? 'remote' : 'local';
const faultEnds = (dir, point, ending) => {
  if (BEFORE_MARK[dir].includes(point)) return endsOn(dir, 'abort');
  if (PAST_ANSWER.includes(point) || REJOIN.includes(point)) return endsOn(dir, 'retry');
  return endsOn(dir, ending);
};

// one home takes writes, what ran where it ran still runs, nothing of the move stays on either machine, and the home holds what the fleet held
function afterMove(label, ids, before, want) {
  for (let i = 0; i < 40 && !settledHomes(); i++) sh(L, 'sleep 3');
  const home = homeAt();
  const on = home === 'local' ? L : R;
  oneHome(on, ids);
  if (want) check(`${label}: where it ended`, home === want, () => `the home is on ${home}, not ${want}`);
  check(`${label}: nothing of the move stays`, !moveLeft(L) && !moveLeft(R), () => `${moveLeft(L)} ${moveLeft(R)}`);
  if (ctx.box) boxFollows(label, ids);
  journalsEnded(label, L);
  journalsEnded(label, R);
  const kept = (was, is) => was.split('\n').filter(Boolean).every((w) => is.includes(w));
  check(`${label}: local's windows stay`, kept(before.L, windows(L)), () => `${windows(L)} vs ${before.L}`);
  check(`${label}: remote's windows stay`, kept(before.R, windows(R)), () => `${windows(R)} vs ${before.R}`);
  check(`${label}: the home holds the push keys`, sh(on, 'cat ~/.svall/push.json', { ok: false }).stdout === ctx.push && sh(on, 'cat ~/.svall/mobile-pass').stdout === ctx.pass, 'they differ');
  const served = (m) => sh(m, 'test -f ~/.tailscale-double.json', { ok: false }).code === 0;
  const off = on === L ? R : L;
  for (let i = 0; i < 40 && !(served(on) && !served(off)); i++) sh(L, 'sleep 0.5');
  check(`${label}: one origin serves the phone, the home`, served(on) && !served(off), () => `home ${served(on)}, the other ${served(off)}`);
  const held = robotsHeld(on);
  check(`${label}: every robot where it ran, with its note`, sameRobots(held, before.robots), () => `${brief(held)} vs ${brief(before.robots)}`);
  // a frozen home answers `mine` too, so only a write says it takes them
  const [first] = Object.keys(held);
  const note = `after ${label}`;
  const wrote = sh(on, `/opt/it/node/bin/node /opt/it/machine.mjs call robot.update '${JSON.stringify({ id: first, note })}'`, { ok: false });
  check(`${label}: the home takes a write`, wrote.code === 0 && call(on, 'state.get').robots[first]?.note === note, () => `${wrote.code}: ${wrote.stderr.slice(0, 300)}`);
  let heard;
  for (let i = 0; i < 120 && heard !== note; i++) { if (i) sh(L, 'sleep 0.5'); heard = call(off, 'state.get').robots[first]?.note; }
  check(`${label}: the worker hears it from that home`, heard === note, () => `the worker holds ${heard}`);
  ctx.home = home;
}

// what a person does: at the first answer that says the move is over they stop
function person(ending, revives = true) {
  for (let i = 0; i < 40; i++) {
    if (revives) {
      revive(L);
      revive(R);
    }
    if (settledHomes()) return;
    sh(L, `svall --json fleet home ${ending} </dev/null`, { ok: false });
    if (settledHomes()) return;
    sh(L, 'sleep 3');
  }
}

function homeFault(ids, dir, point, where, ending, revives = true) {
  placeHome(dir === 'out' ? 'local' : 'remote');
  const machine = where === 'near' ? L : R;
  const before = homeView();
  sh(machine, `echo ${point} > ${FAULT}`);
  const r = sh(L, `svall --json fleet home set ${dir === 'out' ? 'remote' : 'local'} </dev/null`, { ok: false });
  const fired = sh(machine, `test -e ${FAULT}`, { ok: false }).code !== 0;
  sh(machine, `rm -f ${FAULT}`);
  check(`${point}: the run reached it`, fired, 'the point was never reached');
  say(`   ${point}, on ${machine}: ${r.code === 0 ? 'went through' : 'stopped'}, ${ending}`);
  person(ending, revives);
  if (!revives) for (const m of [L, R]) check(`${point}: ${m}'s unit is up with no one starting it`, sh(m, `systemctl --user is-active ${UNIT}`, { ok: false }).code === 0, () => sh(m, `systemctl --user status ${UNIT} | tail -n 5`, { ok: false }).stdout);
  afterMove(point, ids, before, faultEnds(dir, point, ending));
}

// the driver killed past its copy, the phone on: nothing is marked, so its daemon thaws and serves again by itself, and what it staged waits there, closed to a typed adopt, for a later move to end for good
function driverGone(ids) {
  placeHome('local');
  const before = homeView();
  sh(L, `echo move.copied > ${FAULT}`);
  const r = sh(L, 'svall --json fleet home set remote </dev/null', { ok: false });
  check('move.copied: the run reached it', r.code === 137 && sh(L, `test -e ${FAULT}`, { ok: false }).code !== 0, () => `exit ${r.code}: ${r.stdout.slice(-300)}`);
  sh(L, `rm -f ${FAULT}`);
  const up = (m) => sh(m, 'test -f ~/.tailscale-double.json', { ok: false }).code === 0;
  for (let i = 0; i < 40 && !up(L); i++) sh(L, 'sleep 0.5');
  check('move.copied: the phone serves again with no one asking', up(L), 'it stays off');
  check('move.copied: the old home holds no marker', !moveLeft(L).includes('moving'), () => moveLeft(L));
  const [stale] = sh(R, 'ls -d ~/.svall/adopt-hm_*', { ok: false }).stdout.trim().split('\n');
  const id = /adopt-(hm_[0-9a-z]{10})$/.exec(stale ?? '')?.[1];
  check('move.copied: what it staged stands there', id !== undefined, () => stale);
  const typed = sh(R, `svall --json fleet adopt ${id}`, { ok: false });
  check('move.copied: a typed adopt installs nothing', typed.code !== 0 && tryHome(R)?.mine === false, () => `${typed.code}: ${typed.stdout} ${typed.stderr.slice(0, 300)}`);
  for (let i = 0; i < 90 && !call(L, 'fleet.homeCheck', { to: ids.remote }).ok; i++) sh(L, 'sleep 1');
  setHome(L, 'remote');
  afterMove('move.copied', ids, before, 'remote');
}

// a kill, then another in the recovery of what the first left
function recoveryFault(ids, dir, point, after, ending, revives) {
  placeHome(dir === 'out' ? 'local' : 'remote');
  const before = homeView();
  const taking = dir === 'out' ? R : L;
  // both at once, as a driver going out asks after its kill and recovers at once
  sh(taking, `printf '${after}\\n${point}\\n' > ${FAULT}`);
  const r = sh(L, `svall --json fleet home set ${dir === 'out' ? 'remote' : 'local'} </dev/null`, { ok: false });
  person(ending, revives);
  if (!revives) for (const m of [L, R]) check(`${point}: ${m}'s unit is up with no one starting it`, sh(m, `systemctl --user is-active ${UNIT}`, { ok: false }).code === 0, () => sh(m, `systemctl --user status ${UNIT} | tail -n 5`, { ok: false }).stdout);
  check(`${after}, then ${point}: the run reached both`, sh(taking, `test -e ${FAULT}`, { ok: false }).code !== 0, () => `left: ${sh(taking, `cat ${FAULT}`, { ok: false }).stdout} ${r.stdout.slice(-300)}`);
  sh(taking, `rm -f ${FAULT}`);
  afterMove(point, ids, before, endsOn(dir, ending));
}

// mission control's robot goes ahead, the move stops and is called off: it stays where it went until a person brings it back, its pane the same
function crewBack(ids, dir) {
  placeHome(dir === 'out' ? 'local' : 'remote');
  const [home, taking] = dir === 'out' ? [L, R] : [R, L];
  const crew = JSON.parse(sh(home, 'svall --json robot new --island home --cwd ~/.svall/home --name crew --claude').stdout).id;
  sh(home, `svall robot wait ${crew} --until idle --timeout 60`);
  // a conversation to carry: one that has had no turn starts anew wherever it lands
  sh(home, `svall robot run ${crew} 'hello' && svall robot wait ${crew} --until done,idle --timeout 60`);
  const session = (m) => JSON.parse(sh(m, 'svall --json status').stdout).robots[crew];
  const before = session(home).agent?.sessionId;
  sh(taking, `echo adopt.stopped > ${FAULT}`);
  sh(L, `svall --json fleet home set ${dir === 'out' ? 'remote' : 'local'} </dev/null`, { ok: false });
  sh(taking, `rm -f ${FAULT}`);
  person('abort');
  const there = session(home);
  check('the move is off, with the crew where it went', there?.machine === (dir === 'out' ? ids.remote : ids.local), () => brief(there));
  const r = sh(L, 'svall --json fleet home crew-back </dev/null', { ok: false });
  check('crew-back runs', r.code === 0, () => `${r.code}: ${brief(moveSteps(r.stdout))}`);
  const home2 = session(home);
  check('it runs on the home again, the same conversation', home2?.machine === undefined && home2?.tmux !== undefined && home2?.agent?.sessionId === before, () => brief({ machine: home2?.machine, tmux: home2?.tmux, was: before, is: home2?.agent?.sessionId, there: there?.agent?.sessionId }));
  sh(home, `svall robot close ${crew}`, { ok: false });
}

function homeFaults(ids) {
  const picked = (name) => !o.points || new RegExp(o.points).test(name);
  const crew = Object.values(JSON.parse(sh(L, 'svall --json status').stdout).robots).find((r) => r.name === 'crew');
  if (crew) sh(tryHome(L)?.mine ? L : R, `svall robot close ${crew.id}`, { ok: false });
  ctx.pass = sh(tryHome(L)?.mine ? L : R, 'cat ~/.svall/mobile-pass').stdout;
  ctx.push = sh(tryHome(L)?.mine ? L : R, 'cat ~/.svall/push.json', { ok: false }).stdout;
  check('the phone serves on the home', call(tryHome(L)?.mine ? L : R, 'mobile.set', { enabled: true }).serving === true, 'it does not');
  for (const dir of ['out', 'back']) {
    POINTS[dir].forEach(([point, where], i) => {
      if (!picked(`${dir} ${point}`) || (REJOIN.includes(point) && !ctx.box)) return;
      // the same point takes the other ending the other way
      const ending = (i + (dir === 'back' ? 1 : 0)) % 2 ? 'abort' : 'retry';
      step(`${point}, ${dir === 'out' ? 'local -> remote' : 'remote -> local'}, ${where}, then ${ending}`, () => homeFault(ids, dir, point, where, ending));
    });
  }
  if (picked('out move.copied')) step('move.copied, local -> remote, near, then a later move', () => driverGone(ids));
  for (const dir of ['out', 'back']) {
    for (const [point, after, ending, revives = true] of RECOVERY) {
      if (picked(`${dir} ${point}`)) step(`${point}, past ${after}, ${dir === 'out' ? 'local -> remote' : 'remote -> local'}, then ${ending}${revives ? '' : ', no unit started by hand'}`, () => recoveryFault(ids, dir, point, after, ending, revives));
    }
    if (picked(`${dir} crew`)) step(`mission control comes back from a move called off, ${dir === 'out' ? 'local -> remote' : 'remote -> local'}`, () => crewBack(ids, dir));
  }
  // what a person sees with no unit started for them: the recovery's own starts are all that bring a daemon back
  for (const dir of ['out', 'back']) {
    if (picked(`${dir} units adopt.stopped`)) step(`adopt.stopped, then abort, no unit started by hand, ${dir === 'out' ? 'local -> remote' : 'remote -> local'}`, () => homeFault(ids, dir, 'adopt.stopped', dir === 'out' ? 'far' : 'near', 'abort', false));
    if (picked(`${dir} units adopt.installed`)) step(`adopt.installed, then retry, no unit started by hand, ${dir === 'out' ? 'local -> remote' : 'remote -> local'}`, () => homeFault(ids, dir, 'adopt.installed', dir === 'out' ? 'far' : 'near', 'retry', false));
  }
  for (const dir of ['out', 'back']) {
    if (picked(`${dir} link`)) for (const ending of ['retry', 'abort']) step(`the link drops between mark and adopt, ${dir === 'out' ? 'local -> remote' : 'remote -> local'}, then ${ending}`, () => linkDrop(ids, dir, ending));
    if (picked(`${dir} tar`)) step(`a kill inside the tar's extraction, ${dir === 'out' ? 'local -> remote' : 'remote -> local'}`, () => tarKill(ids, dir));
  }
  // a delayed adopt against an abort: the abort answered, the staged archive refused for good
  step('a delayed adopt against an abort', () => {
    placeHome('local');
    const id = 'hm_delayedabc';
    const nameless = JSON.parse(sh(R, `svall --json fleet status ${id}`).stdout);
    check('an id never heard of, asked by no home named, waits and writes nothing', nameless.status === 'pending' && sh(R, `test -e ~/.svall/journal/home/${id}.ndjson`, { ok: false }).code !== 0, () => brief(nameless));
    const answered = JSON.parse(sh(R, `svall --json fleet status ${id} --asker ${ids.local} --fleet ${ids.fleet}`).stdout);
    check('an id never heard of is refused to the home this machine serves', answered.status === 'not-adopted', () => brief(answered));
    const late = JSON.parse(sh(R, `svall --json fleet adopt ${id}`).stdout);
    check('the adopt that comes late is refused', late.status === 'not-adopted', () => brief(late));
    // the same with a real archive staged there, and the key a driver would send
    const real = 'hm_stagedabrt';
    const key = crypto.randomBytes(32).toString('base64url');
    const { arch, svallBase } = JSON.parse(sh(L, 'cat ~/.config/svall/machines.json').stdout).machines[ids.remote];
    const manifest = {
      id: real, fleetId: ids.fleet, from: ids.local, to: ids.remote, toName: 'remote', toHome: HOMES[R], record: { name: L, platform: 'linux', arch, home: HOMES[L], svallBase, dial: 'worker' },
      phone: { serving: false, logins: [] }, adoptKeySha256: crypto.createHash('sha256').update(key).digest('hex'),
    };
    const packed = JSON.parse(sh(L, `svall fleet export ${real}`, { input: JSON.stringify(manifest) }).stdout);
    const stage = () => JSON.parse(sh(R, `svall --json fleet adopt ${real} --stage --sha256 ${packed.sha256}`, { input: packed.archive }).stdout);
    const staged = stage();
    check('a real archive stages', staged.status === 'pending' && staged.phase === 'staged' && sh(R, `test -d ~/.svall/adopt-${real}`, { ok: false }).code === 0, () => brief(staged));
    const abort = JSON.parse(sh(R, `svall --json fleet abort ${real} --asker ${ids.local} --fleet ${ids.fleet}`).stdout);
    check('the abort answers, and its archive goes', abort.status === 'not-adopted' && sh(R, `test -e ~/.svall/adopt-${real}`, { ok: false }).code !== 0, () => brief(abort));
    const keyed = JSON.parse(sh(R, `svall --json fleet adopt ${real} --home-ssh svall@${R}`, { input: key }).stdout);
    check('an adopt with its key comes late, and is refused', keyed.status === 'not-adopted' && tryHome(R)?.mine === false, () => brief({ ...keyed, enrol: undefined }));
    const again = stage();
    check('so is a stage', again.status === 'not-adopted' && sh(R, `test -e ~/.svall/adopt-${real}`, { ok: false }).code !== 0, () => brief(again));
    oneHome(L, ids);
  });
}

// the driver stands still right after the old home's mark; the link goes, it goes on, and it cannot reach the far side
function linkDrop(ids, dir, ending) {
  placeHome(dir === 'out' ? 'local' : 'remote');
  const before = homeView();
  const [old, taking] = dir === 'out' ? [L, R] : [R, L];
  sh(L, `echo 'move.marked stop' > ${FAULT}`);
  sh(L, `nohup svall --json fleet home set ${dir === 'out' ? 'remote' : 'local'} > /tmp/drive.ndjson 2>&1 </dev/null &`);
  const stopped = () => sh(L, "ps -eo stat=,args= | grep 'fleet home [s]et' | grep -q '^T'", { ok: false }).code === 0;
  for (let i = 0; i < 240 && !stopped(); i++) sh(L, 'sleep 0.5');
  check('the driver stands still after the mark', stopped(), () => sh(L, 'cat /tmp/drive.ndjson').stdout.slice(-600));
  const block = `-p tcp -d ${ipOf(R)} --dport 22 -j DROP`;
  sh(L, `iptables -I OUTPUT ${block}`, { root: true });
  sh(L, "pkill -CONT -f 'fleet home [s]et'", { ok: false });
  for (let i = 0; i < 300 && sh(L, "pgrep -f 'fleet home [s]et'", { ok: false }).code === 0; i++) sh(L, 'sleep 1');
  check('the driver ends, saying so', sh(L, "pgrep -f 'fleet home [s]et'", { ok: false }).code !== 0, 'it never returned');
  // cut off: the old home has not thawed, and only the machine that could take the fleet can take writes
  const [o, t] = [tryHome(old), tryHome(taking)];
  say(`   driver: ${brief(moveSteps(sh(L, 'cat /tmp/drive.ndjson').stdout).filter((e) => e.status === 'fail'))}`);
  check('the old home is frozen under its marker', sh(old, 'test -f ~/.svall/home-moving.json', { ok: false }).code === 0, () => brief({ o, t }));
  // what it says of its own move would read as the machine holding the fleet's answer
  const { id } = JSON.parse(sh(old, 'cat ~/.svall/home-moving.json').stdout);
  for (const op of ['status', 'abort']) {
    const said = sh(old, `svall --json fleet ${op} ${id}`, { ok: false });
    check(`fleet ${op} on the old home refuses`, said.code !== 0 && /fleet home abort/.test(said.stderr), () => `${said.code}: ${said.stdout} ${said.stderr}`);
  }
  check('its marker stands, and its journal says nothing of the move', sh(old, 'test -f ~/.svall/home-moving.json', { ok: false }).code === 0 && sh(old, `test -e ~/.svall/journal/home/${id}.ndjson`, { ok: false }).code !== 0, 'it was written');
  if (dir === 'out') check('remote did not take it', t?.mine === false, () => brief(t));
  else check('local took it, and owes remote the outcome', t?.mine === true && sh(L, 'test -f ~/.svall/home-deliver.json', { ok: false }).code === 0, () => brief(t));
  sh(L, `iptables -D OUTPUT ${block}`, { root: true });
  person(ending);
  // coming back this machine has gone on and taken the fleet by the time it is called off
  afterMove(`link drop ${dir} ${ending}`, ids, before, dir === 'back' ? 'local' : endsOn(dir, ending));
}

// the tar killed with the first file out, and the process that ran it: on the far machine a stage over ssh, on this one the driver itself
function tarKill(ids, dir) {
  placeHome(dir === 'out' ? 'local' : 'remote');
  const before = homeView();
  const taking = dir === 'out' ? R : L;
  const old = dir === 'out' ? L : R;
  const shim = '#!/bin/sh\ncase "$1" in\n  -x) /usr/bin/tar "$@" fleet.json; touch /tmp/tar-killed; kill -9 $PPID $$ ;;\n  *) exec /usr/bin/tar "$@" ;;\nesac\n';
  sh(taking, 'rm -f /tmp/tar-killed; cat > /usr/local/bin/tar && chmod 755 /usr/local/bin/tar', { root: true, input: shim });
  const r = sh(L, `svall --json fleet home set ${dir === 'out' ? 'remote' : 'local'} </dev/null`, { ok: false });
  const fired = sh(taking, 'test -e /tmp/tar-killed', { ok: false }).code === 0;
  sh(taking, 'rm -f /usr/local/bin/tar /tmp/tar-killed', { root: true });
  check('the tar was killed inside its extraction', fired, () => `it never ran: ${r.stdout.slice(-400)}`);
  check('the driver did not go on', r.code !== 0, () => r.stdout.slice(-400));
  // nothing has been marked, so its daemon goes on as the home, and no marker stands
  for (let i = 0; i < 20 && sh(old, 'test -f ~/.svall/home-moving.json', { ok: false }).code === 0; i++) sh(L, 'sleep 1');
  check('the old home holds no marker', sh(old, 'test -f ~/.svall/home-moving.json', { ok: false }).code !== 0, 'a marker stands');
  const takes = call(old, 'mobile.get');
  check('the old home answers', takes !== undefined, 'no answer');
  // a driver that died with its tar leaves what it staged for a person, who finds the old home never frozen
  if (dir === 'back') check('the half unpacked archive is where Files refuses it', sh(L, 'ls -d ~/.svall/adopt-*/unpacked', { ok: false }).code === 0, 'nothing staged');
  person('retry');
  afterMove(`tar kill ${dir}`, ids, before, dir === 'out' ? 'local' : 'remote');
}

// three terminals on the far home, the way the app attaches them: the master goes, every terminal comes back to its pane, and a copy in a far pane reaches this machine's terminal
function terminalsAcross(ids) {
  placeHome('remote');
  const robots = ['t1', 't2', 't3'].map((name) => JSON.parse(sh(R, `svall --json robot new --island home --cwd ~/.svall/home --name ${name} --claude`).stdout).id);
  for (const id of robots) sh(R, `svall robot wait ${id} --until idle --timeout 60`);
  const onTerm = (args) => sh(L, `tmux -L term ${args}`, { ok: false });
  const panes = () => sh(R, "~/.local/share/svall/current/bin/tmux -S ~/.svall/tmux.sock list-windows -a -F '#{session_name} #{pane_pid} #{pane_tty}'", { ok: false }).stdout;
  const clients = () => sh(R, "~/.local/share/svall/current/bin/tmux -S ~/.svall/tmux.sock list-clients -F '#{session_name}'", { ok: false }).stdout.split('\n').filter((c) => c.startsWith('v-'));
  const pidsOf = () => new Set(panes().split('\n').filter(Boolean).map((p) => p.split(' ').slice(1).join(' ')));
  const pidsBefore = pidsOf();
  onTerm('kill-server');
  check('the terminal starts', onTerm('new-session -d -s holder').code === 0, 'tmux');
  onTerm('set -s set-clipboard on');
  const attach = () => {
    const a = window(L, `${opens}
      const c = (await here.call('home.connection', { retry: true })).result;
      if (c.state !== 'connected') { console.log(JSON.stringify({ state: c.state, detail: c.detail })); process.exit(0); }
      const far = await open(c.port, c.token);
      const attached = [];
      for (const id of ${JSON.stringify(robots)}) attached.push((await far.call('term.attach', { id })).result);
      console.log(JSON.stringify({ state: c.state, ssh: c.ssh, controlSocket: c.controlSocket, attached }));
      process.exit(0);`);
    return a;
  };
  const line = (c, a) => `env TERM=xterm-256color ssh -S ${shq(c.controlSocket)} -o ControlMaster=no -o BatchMode=yes -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes -o RemoteCommand=none -tt -- ${shq(c.ssh)} ${shq(shq(a.tmux))} -S ${shq(shq(a.socket))} attach -t ${shq(shq(`=${a.session}`))}`;
  const openAll = (c) => { for (const a of c.attached) onTerm(`new-window -d ${shq(line(c, a))}`); };
  const waitFor = (label, f, seconds = 60) => {
    for (let i = 0; i < seconds * 2; i++) { if (f()) return true; sh(L, 'sleep 0.5'); }
    check(label, false, 'it did not happen');
    return false;
  };
  let c = attach();
  check('the window reaches the home', c.state === 'connected' && c.attached?.length === 3 && c.attached.every((a) => a.socket && a.session), () => brief(c));
  openAll(c);
  waitFor('three terminals attach', () => clients().length >= 3);
  check('each attached to its own session', new Set(clients()).size >= 3, () => brief(clients()));

  sh(L, `pkill -9 -f ${shq(`ssh .*-M -S ${c.controlSocket}`)}`, { ok: false });
  waitFor('the terminals end with the master', () => clients().length === 0, 90);
  const tries = [];
  waitFor('the master comes back', () => { c = attach(); tries.push(c.state); return c.state === 'connected'; }, 90);
  say(`   back after ${tries.length} tries: ${[...new Set(tries)].join(', ')}`);
  openAll(c);
  waitFor('every terminal comes back', () => clients().length >= 3);
  check('the same panes, the agents never restarted', [...pidsOf()].every((p) => pidsBefore.has(p)), () => `${panes()} vs ${[...pidsBefore].join(', ')}`);

  const tty = panes().split('\n').find((l) => l.includes(c.attached[0].session))?.split(' ')[2];
  check('a pane has a tty', tty?.startsWith('/dev/'), () => panes());
  sh(R, `printf '\\033]52;c;YnktZmFy\\a' > ${tty}`);
  waitFor('a copy in a far pane reaches this terminal', () => onTerm('show-buffer').stdout.trim() === 'by-far');
  onTerm('kill-server');
  for (const id of robots) sh(R, `svall robot close ${id}`, { ok: false });
}

// a machine set up first, then joined
function freshJoin(ids) {
  if (ctx.home === 'remote') homeBack(ids, false);
  if (ctx.blocked) sh(L, `iptables -D INPUT ${blockSsh(R)}`, { root: true });
  // a joiner dials the home, which takes its key as Add machine's ssh would
  sh(L, 'cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys', { input: sh(R, 'cat ~/.ssh/id_ed25519.pub').stdout });
  sh(R, `ssh-keyscan -t ed25519 ${L} 2>/dev/null >> ~/.ssh/known_hosts`);
  // a first start, stopped again, leaves the fleet an id of its own, and it holds nothing yet
  sh(R, 'SVALL_HOME=~/.svall-joined ~/.local/share/svall/current/bin/svalld >/dev/null 2>&1 & p=$!; for i in $(seq 60); do [ -f ~/.svall-joined/port ] && break; sleep 0.5; done; kill $p; wait $p; true');
  const prior = JSON.parse(sh(R, 'cat ~/.svall-joined/fleet.json').stdout).id;
  check('the fleet starts under an id of its own', prior && prior !== ids.fleet, () => prior);
  const r = sh(R, `SHELL=/bin/bash svall -p joined --json fleet join svall@${L} --name remote-joined </dev/null`, { ok: false });
  const steps = moveSteps(r.stdout);
  check('the join ran', r.code === 0, () => `${r.code}: ${brief(steps.filter((s) => s.status === 'fail'))} ${r.stderr.slice(0, 400)}`);
  check('it ended on its snapshot', steps.some((e) => e.step === 'snapshot' && e.status === 'ok'), () => brief(steps));
  check('a home that holds a setup is offered none', steps.some((e) => e.step === 'seed' && e.status === 'ok' && /of its own|no agent setup here/.test(e.detail ?? '')), () => brief(steps.filter((e) => e.step === 'seed')));
  const worker = JSON.parse(sh(R, 'cat ~/.svall-joined/worker.json').stdout);
  check('it names the home and the fleet', worker.homeMachineId === ids.local && worker.fleetId === ids.fleet, () => brief({ ...worker, token: undefined }));
  check('it goes by the fleet\'s id', JSON.parse(sh(R, 'cat ~/.svall-joined/fleet.json').stdout).id === ids.fleet, 'another id');
  check('a fleet that holds something is refused', sh(L, `svall --json fleet join svall@${R} </dev/null`, { ok: false }).code !== 0, 'it joined');
  serverFirst();
}

// a machine of no fleet yet, made a home from here with host add --as-home, and this machine's empty fleet its worker by a join
function serverFirst() {
  HOMES[S] = '/home/svall';
  const r0 = docker(['run', '-d', '--name', S, '--hostname', S, '--network', NET, '--privileged', '--cgroupns=private', '--tmpfs', '/run', '--tmpfs', '/run/lock', image]);
  if (r0.code !== 0) throw new Error(`${S} did not start: ${r0.stderr}`);
  provision(S);
  sh(S, 'mkdir -m 700 -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys', { input: sh(L, 'cat ~/.ssh/id_ed25519.pub').stdout });
  sh(L, `ssh-keyscan -t ed25519 ${S} 2>/dev/null >> ~/.ssh/known_hosts`);
  const add = sh(L, `svall -p mac2 host add server --ssh svall@${S} --release /opt/it/svall-companion-*.tar.gz --allow-unsigned --as-home --json </dev/null`, { ok: false });
  const steps = lines(add.stdout).filter((e) => e.step && e.status !== 'start');
  check('host add --as-home ran to its registry step', steps.some((e) => e.step === 'registry' && e.status === 'ok'), () => `${add.code}: ${brief(steps)} ${add.stderr.slice(0, 400)}`);
  check('it enrolled no one and failed nothing', !steps.some((e) => e.step === 'enrol' || e.status === 'fail'), () => brief(steps));
  check('the server is no worker', sh(S, 'test -f ~/.svall/worker.json', { ok: false }).code !== 0, 'worker.json stands');
  const server = JSON.parse(sh(S, 'cat ~/.svall/fleet.json').stdout).id;
  const serverMachine = JSON.parse(sh(S, 'svall version --json').stdout).machineId;
  // nothing of a person's on a server as a real setup leaves it, so its first push goes over nothing here
  check('a server set up first holds no agent setup', call(S, 'machines.holdsSetup').holds === false, 'it holds one');
  putRule(L, 'from the joining machine');
  const settingsBefore = sh(L, 'cat ~/.claude/settings.json', { ok: false }).stdout;
  const join = sh(L, `SHELL=/bin/bash svall -p mac2 --json fleet join svall@${S} --name mac2-joined </dev/null`, { ok: false });
  const joined = moveSteps(join.stdout);
  check('this machine joined it', join.code === 0 && joined.some((e) => e.step === 'snapshot' && e.status === 'ok'), () => `${join.code}: ${brief(joined.filter((e) => e.status === 'fail'))} ${join.stderr.slice(0, 400)}`);
  const worker = JSON.parse(sh(L, 'cat ~/.svall-mac2/worker.json').stdout);
  check('it names the server as its home', worker.homeMachineId === serverMachine && worker.fleetId === server && worker.homeSsh === `svall@${S}`, () => brief({ ...worker, token: undefined }));
  check('it goes by the server\'s fleet id', JSON.parse(sh(L, 'cat ~/.svall-mac2/fleet.json').stdout).id === server, 'another id');
  let seen;
  for (let i = 0; i < 60 && !seen?.reachable; i++) { if (i) sh(S, 'sleep 1'); seen = call(S, 'machines.list').machines.find((m) => m.name === 'mac2-joined'); }
  check('the server reaches it over its dial', seen?.reachable === true, () => brief(seen));
  check('it holds the profile the fleet has on the server', worker.homeProfile === 'private', () => brief({ ...worker, token: undefined }));
  check('the join says the server has no setup yet, and copies nothing by itself', joined.some((e) => e.step === 'seed' && e.status === 'warn') && sh(S, `cat ${RULE}`, { ok: false }).code !== 0, () => brief(joined.filter((e) => e.step === 'seed')));
  check('the server pushes nothing over this machine before its seed', sh(L, 'cat ~/.claude/settings.json', { ok: false }).stdout === settingsBefore && readRule(L) === 'from the joining machine\n' && sh(L, 'ls ~/.svall-mac2/mirror-backup', { ok: false }).stdout === '', 'it wrote here');
  const me = JSON.parse(sh(L, 'svall version --json').stdout).machineId;
  const seed = call(S, 'machines.copySetupFrom', { machine: me, seed: true });
  check('the seed goes through the Copy', seed.sent > 0 && readRule(S) === 'from the joining machine\n', () => `${brief(seed)} ${readRule(S)}`);
  check('and the server holds a setup from there', call(S, 'machines.holdsSetup').holds === true, 'it holds none');
  sh(L, `rm -f ${RULE}`);
  secondDialer();
  namedApart(serverMachine);
}

// two machines dial one home: each link stands, and comes back past the home's restart. The second goes after, as a move refuses another worker
function secondDialer() {
  sh(S, 'cat >> ~/.ssh/authorized_keys', { input: sh(R, 'cat ~/.ssh/id_ed25519.pub').stdout });
  sh(R, `ssh-keyscan -t ed25519 ${S} 2>/dev/null >> ~/.ssh/known_hosts`);
  const join = sh(R, `SHELL=/bin/bash svall -p dial2 --json fleet join svall@${S} --name dial2 </dev/null`, { ok: false });
  check('a second machine joins the same home', join.code === 0, () => `${join.code}: ${brief(moveSteps(join.stdout).filter((e) => e.status === 'fail'))} ${join.stderr.slice(0, 400)}`);
  const dialing = (seconds) => {
    let seen;
    for (let i = 0; i < seconds && seen?.length !== 2; i++) { if (i) sh(S, 'sleep 1'); seen = call(S, 'machines.list').machines?.filter((m) => m.reachable && ['mac2-joined', 'dial2'].includes(m.name)); }
    return seen?.length === 2;
  };
  check('the home reaches both over their dials', dialing(60), () => brief(call(S, 'machines.list')));
  sh(S, `systemctl --user restart ${UNIT}`);
  sh(S, 'sleep 2');
  check('and both again past its restart', dialing(90), () => brief(call(S, 'machines.list')));
  sh(S, 'svall host remove dial2 --forget --json </dev/null');
  sh(R, 'systemctl --user disable --now svall-svalld@dial2.service');
}

// mac2 here and private on the server: the fleet comes to mac2, which reaches the server's fleet by its own name, and goes out again
function namedApart(serverMachine) {
  const mine = JSON.parse(sh(L, 'svall version --json').stdout).machineId;
  const back = sh(L, 'svall -p mac2 --json fleet home set local </dev/null', { ok: false });
  check('mac2 takes the fleet back from a server fleet named apart', back.code === 0, () => `${back.code}: ${brief(moveSteps(back.stdout).filter((e) => e.status === 'fail'))}`);
  check('the server is its worker', JSON.parse(sh(S, 'cat ~/.svall/worker.json').stdout).homeMachineId === mine, 'it names another home');
  const held = JSON.parse(sh(L, 'cat ~/.svall-mac2/workers.json').stdout)[serverMachine];
  check('mac2 holds the server\'s fleet by its name there', held?.profile === 'private', () => brief({ ...held, token: undefined }));
  // the check waits on mac2's own link to the server, which dials `worker link` under that name
  let out;
  for (let i = 0; i < 12; i++) {
    out = sh(L, `svall -p mac2 --json fleet home set ${serverMachine} </dev/null`, { ok: false });
    if (out.code === 0 || moveSteps(out.stdout).find((e) => e.status === 'fail')?.step !== 'check') break;
    sh(L, 'sleep 10');
  }
  check('and sends it out again', out.code === 0, () => `${out.code}: ${brief(moveSteps(out.stdout).filter((e) => e.status === 'fail'))}`);
  check('the server is the home again', sh(S, 'test -f ~/.svall/worker.json', { ok: false }).code !== 0, 'worker.json stands');
  check('mac2 is its worker under that name', JSON.parse(sh(L, 'cat ~/.svall-mac2/worker.json').stdout).homeProfile === 'private', 'another profile');
}

// ---------------------------------------------------------------------- a Linux worker of a home that moves

const homeIdOf = (ids, where) => (where === 'local' ? ids.local : ids.remote);
const boxFile = () => JSON.parse(sh(B, 'cat ~/.svall/worker.json').stdout);
const heldToken = (m, id) => JSON.parse(sh(m, 'cat ~/.svall/workers.json', { ok: false }).stdout || '{}')[id]?.token;
// a check ends in a report of many lines, after its steps of one each
const carriedSteps = (r) => r.stdout.split('\n').filter((l) => l.startsWith('{"')).map((l) => JSON.parse(l)).filter((e) => e.step && e.status !== 'start');

// the worker names exactly the machine that holds the fleet, under the token that machine holds, and is linked
function boxFollows(label, ids) {
  const where = homeAt();
  const on = where === 'local' ? L : R;
  let file, link;
  for (let i = 0; i < 180; i++) {
    if (i) sh(L, 'sleep 1');
    file = boxFile();
    link = call(on, 'state.get').machines?.[ids.box];
    if (file.homeMachineId === homeIdOf(ids, where) && file.token === heldToken(on, ids.box) && link?.reachable) break;
  }
  check(`${label}: box names ${where}, and holds its token`, file.homeMachineId === homeIdOf(ids, where) && file.token === heldToken(on, ids.box), () => brief({ home: file.homeMachineId, same: file.token === heldToken(on, ids.box) }));
  check(`${label}: box is linked to ${where}`, link?.reachable === true, () => brief(link));
}

function boxUp() {
  HOMES[B] = '/home/svall';
  const r0 = docker(['run', '-d', '--name', B, '--hostname', B, '--network', NET, '--privileged', '--cgroupns=private', '--tmpfs', '/run', '--tmpfs', '/run/lock', image]);
  if (r0.code !== 0) throw new Error(`${B} did not start: ${r0.stderr}`);
  provision(B);
  sh(B, 'mkdir -p ~/.local/bin && printf \'#!/bin/sh\\nexec /opt/it/node/bin/node /opt/it/claude.mjs "$@"\\n\' > ~/.local/bin/claude && chmod 755 ~/.local/bin/claude');
  sh(B, 'mkdir -p ~/.local/bin && printf \'#!/bin/bash\\nexec -a opencode /opt/it/node/bin/node /opt/it/opencode.mjs "$@"\\n\' > ~/.local/bin/opencode && chmod 755 ~/.local/bin/opencode');
  sh(B, 'mkdir -m 700 -p ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys');
}

const letIn = (m) => {
  sh(B, 'cat >> ~/.ssh/authorized_keys', { input: sh(m, 'cat ~/.ssh/id_ed25519.pub').stdout });
  sh(m, `ssh-keyscan -t ed25519 ${B} 2>/dev/null >> ~/.ssh/known_hosts && ssh -o BatchMode=yes svall@${B} true`);
};

// with remote as the fleet's home, its workers are added and looked after from local's Machines through remote's own ssh
function workerFromHome(ids) {
  placeHome('remote');
  boxUp();
  const refused = sh(L, `svall --json host add box --ssh svall@${B} </dev/null`, { ok: false });
  const first = carriedSteps(refused).find((e) => e.status === 'fail');
  check('remote has no login there, and says so', refused.code !== 0 && first?.step === 'ssh' && /cannot log in/.test(first.detail) && /^remote|remote/.test(first.detail) && /ssh-copy-id/.test(first.run ?? ''), () => brief(first));
  check('nothing was installed there', sh(B, 'test -e ~/.local/share/svall/current', { ok: false }).code !== 0, 'it was');
  letIn(R);
  const add = sh(L, `svall --json host add box --ssh svall@${B} </dev/null`, { ok: false });
  const steps = carriedSteps(add);
  check('it comes from remote\'s own release', / from remote's own release \(/.test(steps.find((e) => e.step === 'release' && e.status !== 'start')?.raw ?? ''), () => brief(steps.find((e) => e.step === 'release')));
  check('the add ran, each step on the way back to local', steps.some((e) => e.step === 'registry' && e.status === 'ok') && !steps.some((e) => e.status === 'fail'), () => `${add.code}: ${brief(steps.filter((e) => e.status === 'fail'))} ${add.stderr.slice(0, 400)}`);
  ids.box = JSON.parse(sh(B, 'svall version --json').stdout).machineId;
  const file = boxFile();
  check('box serves remote, by name', file.homeMachineId === ids.remote && file.homePlatform === 'linux' && file.fleetId === ids.fleet, () => brief({ ...file, token: undefined }));
  check('remote holds its route and token', JSON.parse(sh(R, 'cat ~/.config/svall/machines.json').stdout).machines[ids.box]?.ssh === `svall@${B}` && heldToken(R, ids.box) === file.token, 'it does not');
  check('local\'s registry stays out of it', JSON.parse(sh(L, 'cat ~/.config/svall/machines.json').stdout).machines[ids.box] === undefined, 'it holds box');
  const listed = JSON.parse(sh(L, 'svall host list --json').stdout).find((r) => r.id === ids.box);
  check('local lists it from remote', listed?.far === true && listed.ssh === `svall@${B}`, () => brief(listed));
  boxFollows('added', ids);
  const doctor = sh(L, 'svall --json host doctor box --steps </dev/null', { ok: false });
  check('a check of it runs there', carriedSteps(doctor).some((e) => e.step === 'worker' && e.status === 'ok' && e.detail === 'worker of this fleet'), () => brief(carriedSteps(doctor).filter((e) => e.step === 'worker' || e.status === 'fail')));
  // an archive a relay leaves where the far run removes it, as one the Mac carries for another architecture
  const carried = sh(R, 'echo "$HOME/.svall/cache/carried/copied.tar.gz"').stdout.trim();
  sh(R, `mkdir -p "$(dirname ${carried})" && cp /opt/it/svall-companion-*.tar.gz ${carried}`);
  const up = sh(L, `svall --json host upgrade box --release ${carried} --allow-unsigned </dev/null`, { ok: false });
  check('an upgrade of it runs there', !carriedSteps(up).some((e) => e.status === 'fail'), () => brief(carriedSteps(up).filter((e) => e.status === 'fail')));
  check('and the far run removes the archive left for it', sh(R, `test -e ${carried}`, { ok: false }).code !== 0, 'it stays');
  // a home that answers as no home of this fleet takes no run, as a window on the same route says mismatch
  sh(L, `cp -p ~/.svall/worker.json /tmp/it-worker.json && sed -i 's/"fleetId": *"[^"]*"/"fleetId":"00000000-0000-4000-8000-000000000000"/' ~/.svall/worker.json`);
  const other = sh(L, 'svall --json host doctor box --steps </dev/null', { ok: false });
  sh(L, 'cp -p /tmp/it-worker.json ~/.svall/worker.json');
  check('a relay to another fleet runs nothing there', other.code !== 0 && carriedSteps(other).some((e) => e.step === 'relay' && /not this fleet's home/.test(e.detail ?? '')) && !carriedSteps(other).some((e) => e.step === 'worker'), () => brief(carriedSteps(other)));
  // a run the window loses goes with its connection, in place of running on with no one to hear it
  sh(L, `(svall --json host upgrade box --release /opt/it/svall-companion-*.tar.gz --allow-unsigned </dev/null >/dev/null 2>&1 & echo $! > /tmp/it-relay)`);
  let far = false;
  for (let i = 0; i < 40 && !far; i++) { sh(L, 'sleep 0.25'); far = sh(R, "pgrep -f 'host upgrade box.*--relayed'", { ok: false }).code === 0; }
  check('the run is there', far, 'it never started');
  sh(L, 'kill -9 $(cat /tmp/it-relay); pkill -9 -f "ssh .*host.*upgrade.*box" || true', { ok: false });
  for (let i = 0; i < 60 && far; i++) { sh(R, 'sleep 1'); far = sh(R, "pgrep -f 'host upgrade box.*--relayed'", { ok: false }).code === 0; }
  check('and stops with its connection', !far, 'it runs on');
  boxFollows('a lost run', ids);
  // a robot there, and its last screen on local once remote is out of its reach
  ids.onbox = JSON.parse(sh(R, `svall --json robot new --island ${ctx.fx.island} --cwd ~ --name onbox --claude`).stdout).id;
  sh(R, `svall robot wait ${ids.onbox} --until idle --timeout 60`);
  const moved = sh(R, `svall robot move ${ids.onbox} --machine box --json </dev/null`, { ok: false });
  check('a robot moves there', moved.code === 0, () => `${moved.code}: ${moved.stdout.slice(-300)} ${moved.stderr.slice(0, 300)}`);
  const pane = call(B, 'state.get').robots[ids.onbox]?.tmux?.paneId;
  check('it runs in a pane there', pane !== undefined, 'no pane');
  sh(B, `T=~/.local/share/svall/current/bin/tmux; $T -S ~/.svall/tmux.sock send-keys -t '${pane}' -l 'a line for the last screen' && $T -S ~/.svall/tmux.sock send-keys -t '${pane}' Enter`);
  let shot = '';
  for (let i = 0; i < 90 && !shot; i++) { if (i) sh(L, 'sleep 1'); shot = call(L, 'term.lastScreen', { id: ids.onbox }).text; }
  check('local holds its last screen, relayed by remote', shot !== '', 'none came');
  const refusedRemove = sh(L, 'svall --json host remove box </dev/null', { ok: false });
  check('a machine with a robot on it stays', refusedRemove.code !== 0 && carriedSteps(refusedRemove).some((e) => e.status === 'fail' && /onbox/.test(e.detail)), () => brief(carriedSteps(refusedRemove)));
  ctx.box = true;
  letIn(L);
}

// the home goes to local and back with box its worker: it follows each way, and what stands in its way is said, never undoes the move
function moveWithWorker(ids) {
  const moves = (target, label) => {
    const before = windows(B);
    const steps = setHome(L, target, label);
    check(`${label}: ran through to the workers`, steps.some((e) => e.step === 'workers' && e.status === 'ok'), () => brief(steps.filter((e) => e.step === 'workers')));
    boxFollows(label, ids);
    check(`${label}: box's windows stay`, before.split('\n').filter(Boolean).every((w) => windows(B).includes(w)), () => `${windows(B)} vs ${before}`);
    check(`${label}: its robot stays there`, call(target === 'local' ? L : R, 'state.get').robots[ids.onbox]?.machine === ids.box, 'it moved');
  };
  moves('local', 'the way back');
  // the machine the fleet left holds box's route and, stale, its old token, and takes and removes nothing by them
  const named = boxFile();
  const upgrade = sh(R, 'svall --json host upgrade box --release /opt/it/svall-companion-*.tar.gz --allow-unsigned </dev/null', { ok: false });
  check('the old home takes no worker by an upgrade', upgrade.code !== 0 && carriedSteps(upgrade).some((e) => e.status === 'fail' && /only it takes or removes a worker/.test(e.detail ?? '')), () => brief(carriedSteps(upgrade)));
  check('nor removes one', sh(R, 'svall --json host remove box </dev/null', { ok: false }).code !== 0, 'it removed it');
  check('box goes on as it was', boxFile().homeMachineId === named.homeMachineId && boxFile().token === named.token && sh(B, 'test -e ~/.local/share/svall/current', { ok: false }).code === 0, 'it changed');
  const was = heldToken(L, ids.box);
  placeHome('local');
  moves('remote', 'the way out');
  check('the new home took a token of its own', heldToken(R, ids.box) !== was, 'the same token');
  // cut off from both before the check, as a machine that is off: the move goes through, and it joins when it answers
  const cut = `iptables -I INPUT -p tcp --dport 22 -j DROP && iptables -I OUTPUT -p tcp --sport 22 -j DROP`;
  const open = `iptables -D INPUT -p tcp --dport 22 -j DROP; iptables -D OUTPUT -p tcp --sport 22 -j DROP`;
  sh(B, cut, { root: true });
  for (let i = 0; i < 80 && call(R, 'state.get').machines?.[ids.box]?.reachable; i++) sh(L, 'sleep 1');
  placeLink(L);
  const sheet = call(L, 'fleet.homeCheck', { to: ids.local });
  check('the check passes, and names it', sheet.ok === true && sheet.sheet.waits?.some((w) => w.id === ids.box), () => brief(sheet));
  // box closes its side only after three beats, and takes a change for its outbox from then on
  for (let i = 0; i < 90 && call(B, 'state.get').machines?.[ids.remote]?.reachable !== false; i++) sh(L, 'sleep 1');
  const wrote = sh(B, `/opt/it/node/bin/node /opt/it/machine.mjs call robot.update '${JSON.stringify({ id: ids.onbox, note: 'written while cut off' })}'`, { ok: false });
  check('box takes a change while cut off', wrote.code === 0 && !/error/i.test(wrote.stdout), () => `${wrote.code}: ${wrote.stdout.slice(0, 300)} ${wrote.stderr.slice(0, 300)}`);
  const steps = setHome(L, 'local', 'box off');
  check('the move stands, and says box has not joined', steps.some((e) => e.step === 'workers' && e.status === 'warn' && /box/.test(e.detail)), () => brief(steps.filter((e) => e.step === 'workers')));
  const row = call(L, 'machines.list').machines.find((m) => m.id === ids.box);
  check('its row says why', row?.joining !== undefined && row.reachable === false, () => brief(row));
  check('box still names the old home', boxFile().homeMachineId === ids.remote, 'it moved with no one reaching it');
  // and off across the way back too: it names this home again, under a token this home has since replaced
  const out = setHome(L, 'remote', 'box off, and back');
  check('the second move stands', out.some((e) => e.step === 'workers' && e.status === 'warn'), () => brief(out.filter((e) => e.step === 'workers')));
  const stale = boxFile().token;
  check('it names this home under an older token', boxFile().homeMachineId === ids.remote && stale !== heldToken(R, ids.box), 'its token is current');
  sh(B, open, { root: true, ok: false });
  sh(R, 'svall host doctor box --json </dev/null >/dev/null', { ok: false });
  boxFollows('back on, naming this home with an older token', ids);
  let heard;
  for (let i = 0; i < 90 && heard !== 'written while cut off'; i++) { if (i) sh(L, 'sleep 1'); heard = call(R, 'state.get').robots[ids.onbox]?.note; }
  check('what it wrote while cut off reached the home', heard === 'written while cut off', () => `the home holds ${heard}`);
  check('nothing is owed', call(R, 'machines.list').machines.find((m) => m.id === ids.box)?.joining === undefined, 'still owed');
  // a home it refuses: the retries stop, its row says why, and a Check tries again once the key is back
  const keys = sh(B, 'cat ~/.ssh/authorized_keys').stdout;
  sh(B, cut, { root: true });
  for (let i = 0; i < 80 && call(R, 'state.get').machines?.[ids.box]?.reachable; i++) sh(L, 'sleep 1');
  placeLink(L);
  const leaving = setHome(L, 'local', 'box refusing');
  check('a third move stands', leaving.some((e) => e.step === 'workers' && e.status === 'warn'), () => brief(leaving));
  sh(B, ': > ~/.ssh/authorized_keys');
  sh(B, open, { root: true, ok: false });
  // the row says the login was refused, and what ssh said waits behind it
  let listed;
  for (let i = 0; i < 120 && !/cannot log in/.test(listed?.joining ?? ''); i++) { if (i) sh(L, 'sleep 1'); listed = call(L, 'machines.list').machines.find((m) => m.id === ids.box); }
  check('its row names the refused login', /cannot log in to box;/.test(listed?.joining ?? '') && /denied|refused/i.test(listed?.raw ?? ''), () => brief(listed));
  sh(B, 'cat >> ~/.ssh/authorized_keys', { input: keys });
  sh(L, 'svall --json host doctor box </dev/null >/dev/null', { ok: false });
  boxFollows('the key back, and a Check', ids);
}

const placeLink = (m) => { for (let i = 0; i < 60 && !call(m, 'home.connection').state?.match?.(/connected/); i++) sh(m, 'sleep 1'); };

// ---------------------------------------------------------------------------------------------- the run

const STEPS = {
  1: 'move the dirty robot', 2: 'move the robot on main', 3: 'worker restart', 4: 'home down during work', 5: 'fault matrix', 6: 'return through a dirty Mac worktree',
  7: 'a reviewer started while the Mac sleeps', 8: 'the scribe over a robot on the worker', 9: 'a docs conflict', 10: 'files over the link', 11: 'a delete while the worker is down',
  12: 'agent setup mirror', 13: "the user's ssh config", 14: 'a robot started on the worker comes home', 15: 'a dial-out worker',
  16: 'the home moves to remote', 17: "the home move's fault matrix", 18: 'the home comes back', 19: 'a machine set up first takes a join, and a fleet named apart moves both ways', 20: 'terminals across a dropped master', 21: 'a Linux worker added and looked after from the home', 22: 'a move with a Linux worker, both ways',
  23: "what the fleet may use of remote", 24: 'a machine added with its limit, kept through an upgrade',
};
const steps = o.steps === undefined || o.steps === 'all' ? Object.keys(STEPS).map(Number) : String(o.steps).split(',').map(Number);
if (steps.some((s) => !STEPS[s])) throw new Error(`--steps takes all or numbers from 1 to 24, not ${o.steps}`);
// the home's stop and the return work with the robot the first move placed, 7 to 11 with the one the second placed, and
// the scribe and the delete with the robots 7 starts
if ((steps.includes(4) || steps.includes(6)) && !steps.includes(1)) steps.unshift(1);
if (steps.some((s) => s >= 7 && s <= 11) && !steps.includes(2)) steps.unshift(2);
if ((steps.includes(8) || steps.includes(11)) && !steps.includes(7)) steps.push(7);
// the way back starts from a home on remote
if (steps.includes(18) && !steps.includes(16)) steps.push(16);
if (steps.includes(22) && !steps.includes(21)) steps.push(21);
if (steps.includes(21) && !steps.includes(16)) steps.push(16);
// 14 starts its robot in the clone the second move makes there
if (steps.includes(14) && !steps.includes(2)) steps.unshift(2);

let code = 0;
try {
  const scenarios = chosen(o.scenarios);
  say(`logs in ${out}`);
  step('two machines', up);
  const ids = step('install on local, host add remote', install);
  say(`   fleet ${ids.fleet}; local ${ids.local}; remote ${ids.remote}`);
  const fx = step('fixture', () => fixture(ids));
  ctx.fx = fx;
  ctx.origin = originRefs();
  say(`   robots: agent ${fx.agent}, kanban ${fx.kanban}, faults ${fx.faults}`);
  if (steps.includes(1)) step(`1. ${STEPS[1]}`, () => moveDirty(ids, fx));
  if (steps.includes(2)) step(`2. ${STEPS[2]}`, () => moveMain(ids, fx));
  if (steps.includes(3)) step(`3. ${STEPS[3]}`, () => workerRestart(ids, fx));
  if (steps.includes(4)) step(`4. ${STEPS[4]}`, () => homeDown(ids, fx));
  if (steps.includes(5)) faults(ids, scenarios);
  if (steps.includes(6)) step(`6. ${STEPS[6]}`, () => returnDirty(ids, fx));
  if (steps.includes(7)) step(`7. ${STEPS[7]}`, () => reviewerAsleep(ids, fx));
  if (steps.includes(8)) step(`8. ${STEPS[8]}`, () => scribeFar(ids, fx));
  if (steps.includes(9)) step(`9. ${STEPS[9]}`, () => docsConflict(ids, fx));
  if (steps.includes(10)) step(`10. ${STEPS[10]}`, () => filesFar(ids, fx));
  if (steps.includes(11)) step(`11. ${STEPS[11]}`, () => deleteWorkerDown(ids, fx));
  if (steps.includes(12)) step(`12. ${STEPS[12]}`, () => agentSetup(ids, fx));
  if (steps.includes(13)) step(`13. ${STEPS[13]}`, () => sshConfig(ids, fx));
  if (steps.includes(14)) step(`14. ${STEPS[14]}`, () => bornOnWorker(ids, fx));
  if (steps.includes(23)) step(`23. ${STEPS[23]}`, () => limits(ids, fx));
  if (steps.includes(24)) step(`24. ${STEPS[24]}`, addedLimited);
  if (steps.includes(15)) step(`15. ${STEPS[15]}`, () => dialOut(ids));
  if (steps.includes(16)) step(`16. ${STEPS[16]}`, () => { homeMoves(ids, fx); if (ctx.limited) limitsHold('once remote is the home'); });
  if (steps.includes(18)) step(`18. ${STEPS[18]}`, () => { homeBack(ids); if (ctx.limited) limitsHold('once remote is a worker again'); });
  if (steps.includes(21)) step(`21. ${STEPS[21]}`, () => workerFromHome(ids));
  if (steps.includes(22)) step(`22. ${STEPS[22]}`, () => moveWithWorker(ids));
  if (steps.includes(17)) homeFaults(ids);
  if (steps.includes(20)) step(`20. ${STEPS[20]}`, () => terminalsAcross(ids));
  // last: its join takes remote's record from the fleet the others link
  if (steps.includes(19)) step(`19. ${STEPS[19]}`, () => freshJoin(ids));
  say('ALL PASS');
} catch (e) {
  say(`FAILED: ${e.message}`);
  code = 1;
} finally {
  for (const m of [L, R]) {
    const logs = sh(m, 'tail -n 600 ~/.svall/svalld.log ~/.local/share/svall/log/*.log 2>/dev/null', { ok: false }).stdout;
    fs.writeFileSync(path.join(out, `${m}.daemon.log`), logs);
  }
  if (!o.keep) {
    for (const m of [L, R, S, B]) docker(['rm', '-f', m]);
    docker(['network', 'rm', NET]);
  }
  if (companions) fs.rmSync(companions, { recursive: true, force: true });
}
process.exitCode = code;
