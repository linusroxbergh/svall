// The robot placement integration run, driven from the host through docker:
//
//   node scripts/integration/robot-placement.mjs [--archive <companion.tar.gz>] [--image <tag>] [--out <dir>]
//                                                [--steps all|<n>,...] [--scenarios all|none|kill|drop|<fault>@<phase>,...]
//                                                [--keep] [--prefix <name>]
//
// Two Ubuntu 24.04 containers: `svall-local`, the home, set up from the companion built from this checkout, and
// `svall-remote`, made its worker by `svall host add`; their accounts have different homes, as a Mac's and a Linux
// machine's do. Three Claude robots (`agent`, `kanban`, `faults`) are moved between them through the STEPS below.
// With no `--archive` the companion is built for the docker host's architecture, with no `--image` the Dockerfile here.
// `--steps` picks steps by number (the fixture always runs); `--prefix` replaces `svall` in the machines' and network's
// names. Every failed check is printed; the run exits 1 on the first step that has one.
import { spawnSync } from 'node:child_process';
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

function up() {
  for (const m of [L, R]) docker(['rm', '-f', m]);
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
    booted(m);
    sh(m, 'mkdir -p /opt/it', { root: true });
    for (const f of [archive, path.join(HERE, 'claude.mjs'), path.join(HERE, 'opencode.mjs'), path.join(HERE, 'machine.mjs')]) {
      if (docker(['cp', f, `${m}:/opt/it/`]).code !== 0) throw new Error(`docker cp ${f} to ${m} failed`);
    }
    // the harness's own node, from the release under test: the mocked agent and the in-machine checks run on it
    sh(m, 'cd /opt/it && tar -xzf svall-companion-*.tar.gz --wildcards "releases/*/node" && mv releases/*/node node && rm -rf releases && chmod -R a+rX /opt/it', { root: true });
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
  // there is no Codex or gh on the machine, and a mirror not yet checked, which are advice, not failures
  const isAdvice = (s) => s.status === 'warn' && (/codex/i.test(`${s.step} ${s.detail ?? ''}`) || (s.step === 'gh' && !s.action) || s.step === 'mirror:unchecked');
  for (const s of steps) {
    check(`host add ${s.step}`, s.status === 'ok' || s.status === 'skip' || isAdvice(s), `${s.status}: ${s.detail ?? ''} ${s.action ?? ''}`);
  }
  for (const want of ['os', 'home', 'tools', 'linger', 'release', 'upload', 'install', 'service', 'identity', 'enrol', 'probe', 'registry']) {
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
  // a reboot ends tmux and every agent in it: the robots come back dormant, and the home revives them there
  const since2 = linksOf()[ids.remote]?.since;
  sh(R, `systemctl --user stop ${UNIT} && ~/.local/share/svall/current/bin/tmux -S ~/.svall/tmux.sock kill-server; sleep 1; systemctl --user start ${UNIT}`);
  linked(ids, since2);
  const l = until(L, (s) => placed.every((id) => !robotIn(s, id)?.tmux && robotIn(s, id)?.revive?.command?.includes('--resume')), 60);
  for (const id of placed) check(`${id} dormant`, !robotIn(l, id)?.tmux && robotIn(l, id)?.revive?.command?.includes(`--resume ${robotIn(before, id)?.agent?.sessionId}`), () => brief(robotIn(l, id)));
  check('no agents', placed.every((id) => agentsOf(snap(R), id).length === 0), 'an agent survived the reboot');
  for (const id of placed) sh(L, `svall robot revive ${id} && svall robot wait ${id} --until idle,done --timeout 60`);
  const [l2, w2] = [snap(L), snap(R)];
  for (const id of placed) runsOn(`${id} revived`, ids, l2, w2, id, 'remote', robotIn(before, id)?.agent?.sessionId);
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
  check('refused', refused.code === 2 && refused.stderr === `refused: changes on this Mac in ${HOMES[L]}/src/app-wt since the move\n  → stash or commit them\n`,
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

const SLEPT = 'started on remote while this Mac slept';
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
  check('sixth refused', sixth.code !== 0 && sixth.stderr.includes('remote has started 5 robots since this Mac last answered; wait for it'), () => `exit ${sixth.code}: ${JSON.stringify(sixth.stderr)}`);
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
  check('kanban note', note.includes(`${rel} changed on both remote and this Mac; remote's version is kept as ${name}`), () => brief(note));
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
  const rows = mirrorRows(checks);
  const unticked = (k) => rows[k]?.status === 'warn' && rows[k].tick?.on === false;
  const gamma = rows['var:GAMMA_TOKEN'];
  const todo = checks.filter((c) => c.status === 'warn' && c.action);
  check('unticked rows', unticked('claude:mcp:alpha') && unticked('claude:mcp:beta') && gamma?.status === 'warn' && gamma.run === 'svall worker env GAMMA_TOKEN' && todo.length === 3,
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

// ---------------------------------------------------------------------------------------------- the run

const STEPS = {
  1: 'move the dirty robot', 2: 'move the robot on main', 3: 'worker restart', 4: 'home down during work', 5: 'fault matrix', 6: 'return through a dirty Mac worktree',
  7: 'a reviewer started while the Mac sleeps', 8: 'the scribe over a robot on the worker', 9: 'a docs conflict', 10: 'files over the link', 11: 'a delete while the worker is down',
  12: 'agent setup mirror', 13: "the user's ssh config", 14: 'a robot started on the worker comes home',
};
const steps = o.steps === undefined || o.steps === 'all' ? Object.keys(STEPS).map(Number) : String(o.steps).split(',').map(Number);
if (steps.some((s) => !STEPS[s])) throw new Error(`--steps takes all or numbers from 1 to 14, not ${o.steps}`);
// the home's stop and the return work with the robot the first move placed, 7 to 11 with the one the second placed, and
// the scribe and the delete with the robots 7 starts
if ((steps.includes(4) || steps.includes(6)) && !steps.includes(1)) steps.unshift(1);
if (steps.some((s) => s >= 7 && s <= 11) && !steps.includes(2)) steps.unshift(2);
if ((steps.includes(8) || steps.includes(11)) && !steps.includes(7)) steps.push(7);
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
    for (const m of [L, R]) docker(['rm', '-f', m]);
    docker(['network', 'rm', NET]);
  }
  if (companions) fs.rmSync(companions, { recursive: true, force: true });
}
process.exitCode = code;
