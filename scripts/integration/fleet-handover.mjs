// The fleet handover integration run, driven from the host through docker:
//
//   node scripts/integration/fleet-handover.mjs --archive <companion.tar.gz> [--image <tag>] [--out <dir>]
//                                               [--scenarios all|none|kill|drop|<fault>@<boundary>,...] [--keep]
//                                               [--prefix <name>]
//
// Two Ubuntu 24.04 containers on one network: `svall-local` runs the controller from the companion release built from
// this checkout, and `svall-remote` is provisioned from the same archive by `svall host add`. `--prefix` replaces
// `svall` in their names and the network's, so another run can share the docker host. The run builds a small
// fleet on local, hands it local -> remote -> local, then kills the controller or drops the ssh link at each boundary
// in both directions and takes the action `svall handover status` offers. Every check that fails is printed; the run
// exits 1 on the first step that has one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brief, flags, harness, last, lines, same } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const o = flags(process.argv.slice(2));
const prefix = o.prefix ?? 'svall';
const L = `${prefix}-local`;
const R = `${prefix}-remote`;
const NET = `${prefix}-it`;
const HOME = '/home/svall';
// each agent character: the flag its revive names its session with, and where it works
const AGENTS = [
  { key: 'agent', kind: 'claude', resume: '--resume', cwd: `${HOME}/src/app-wt` },
  { key: 'oc', kind: 'opencode', resume: '-s', cwd: `${HOME}/src/app` },
];
const USER_ENV = ['HOME=/home/svall', 'USER=svall', 'LOGNAME=svall', 'XDG_RUNTIME_DIR=/run/user/1000',
  'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus', 'LANG=C.UTF-8'].flatMap((e) => ['-e', e]);
// pre-commit boundaries abort back to the source; post-commit ones resume onto the destination
const POST = new Set(['commit', 'activate']);

if (!o.archive || !fs.existsSync(o.archive)) throw new Error('--archive <companion.tar.gz> is required');
const archive = path.resolve(o.archive);
const image = o.image ?? 'svall-it:latest';
const out = o.out ? path.resolve(o.out) : fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-handover-'));
const { say, docker, check, step, booted } = harness(out);

/** A login shell on a machine, as svall unless `root`; throws on a nonzero exit unless `ok: false`. */
function sh(machine, script, opts = {}) {
  const who = opts.root ? [] : ['-u', 'svall', '-w', HOME, ...USER_ENV];
  const r = docker(['exec', '-i', ...who, machine, 'bash', '-lc', script], { input: opts.input ?? '' });
  if (opts.ok !== false && r.code !== 0) throw new Error(`${machine}: ${script.slice(0, 120)} exited ${r.code}: ${r.stderr.trim().slice(-800)}`);
  return r;
}

// ---------------------------------------------------------------------------------------------- machines

function up() {
  for (const m of [L, R]) docker(['rm', '-f', m]);
  docker(['network', 'rm', NET]);
  if (docker(['network', 'create', NET]).code !== 0) throw new Error('docker network create failed');
  for (const m of [L, R]) {
    const r = docker(['run', '-d', '--name', m, '--hostname', m, '--network', NET, '--privileged', '--cgroupns=private',
      '--tmpfs', '/run', '--tmpfs', '/run/lock', image]);
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
    // a wrapper that execs node on the mock, so ps shows `node …/claude.mjs` as the rest classifier reads a Claude
    sh(m, 'mkdir -p ~/.local/bin && printf \'#!/bin/sh\\nexec /opt/it/node/bin/node /opt/it/claude.mjs "$@"\\n\' > ~/.local/bin/claude && chmod 755 ~/.local/bin/claude');
    // OpenCode's is a native binary, so its mock runs under that name and retitles itself to drop the script's path
    sh(m, 'printf \'#!/bin/bash\\nexec -a opencode /opt/it/node/bin/node /opt/it/opencode.mjs "$@"\\n\' > ~/.local/bin/opencode && chmod 755 ~/.local/bin/opencode');
  }
  sh(L, 'mkdir -m 700 -p ~/.ssh && ssh-keygen -q -t ed25519 -N "" -f ~/.ssh/id_ed25519');
  const key = sh(L, 'cat ~/.ssh/id_ed25519.pub').stdout;
  sh(R, 'mkdir -m 700 -p ~/.ssh && cat > ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys', { input: key });
  sh(L, `ssh-keyscan -t ed25519 ${R} 2>/dev/null > ~/.ssh/known_hosts && test -s ~/.ssh/known_hosts`);
  sh(L, `ssh -o BatchMode=yes svall@${R} true`);
  if (docker(['exec', '-d', R, '/opt/it/node/bin/node', '/opt/it/machine.mjs', 'link', '7070']).code !== 0) throw new Error('the link agent did not start');
}

function install() {
  const setup = sh(L, 'rm -rf /tmp/it-release && mkdir /tmp/it-release && tar -xzf /opt/it/svall-companion-*.tar.gz -C /tmp/it-release'
    + ' && /tmp/it-release/releases/*/bin/svall setup --release /opt/it/svall-companion-*.tar.gz --allow-unsigned --json');
  const done = JSON.parse(setup.stdout).done.join('\n');
  check('setup', /enable --now svall-svalld@private\.service/.test(done), `setup did not start the daemon unit: ${done}`);
  sh(L, 'systemctl --user is-active svall-svalld@private.service');

  const add = sh(L, `svall host add remote --ssh svall@${R} --release /opt/it/svall-companion-*.tar.gz --allow-unsigned --json </dev/null`, { ok: false });
  const steps = lines(add.stdout).filter((e) => e.step && e.status !== 'start');
  for (const s of steps) {
    // Ubuntu 24.04's tmux is 3.4, and there is no Codex on the machine: both are advice, not failures
    const advice = s.status === 'warn' && (s.step === 'tmux' || s.step === 'codex');
    check(`host add ${s.step}`, s.status === 'ok' || advice, `${s.status}: ${s.detail ?? ''} ${s.action ?? ''}`);
  }
  for (const want of ['os', 'home', 'tools', 'linger', 'release', 'upload', 'install', 'service', 'identity', 'claude', 'opencode', 'probe', 'registry']) {
    check(`host add ${want}`, steps.some((s) => s.step === want), 'step missing');
  }

  // the harness turns the feature on for its fleet; the daemon reads fleet.json when it starts
  sh(L, `/opt/it/node/bin/node -e '
    const fs = require("fs"); const f = process.env.HOME + "/.svall/fleet.json";
    const j = JSON.parse(fs.readFileSync(f, "utf8")); j.handover = { ...j.handover, enabled: true };
    fs.writeFileSync(f + ".tmp", JSON.stringify(j, null, 2) + "\\n", { mode: 0o600 }); fs.renameSync(f + ".tmp", f);' &&
    systemctl --user restart svall-svalld@private.service &&
    for i in $(seq 100); do svall char list >/dev/null 2>&1 && break; sleep 0.2; done && svall char list >/dev/null`);
  const enable = sh(L, 'svall host enable remote --fleet private --json </dev/null', { ok: false });
  check('host enable', last(enable.stdout)?.result === 'ready', () => enable.stdout.trim());
  const ids = {
    fleet: JSON.parse(sh(L, 'cat ~/.svall/fleet.json').stdout).id,
    local: sh(L, 'svall version --json').stdout,
    remote: sh(R, 'svall version --json').stdout,
  };
  ids.local = JSON.parse(ids.local).machineId;
  ids.remote = JSON.parse(ids.remote).machineId;
  return ids;
}

// a repo with a linked worktree, staged, unstaged, untracked and ignored changes, a stash, and a default-excluded folder
const GIT_FIXTURE = String.raw`set -eu
git config --global user.name Integration
git config --global user.email integration@example.invalid
git config --global init.defaultBranch main
mkdir -p ~/src && cd ~/src && git init -q app && cd app
printf 'one\n' > a.txt && printf 'two\n' > b.txt && mkdir lib && printf 'three\n' > lib/c.txt
printf 'data/\nnode_modules/\n' > .gitignore
git add -A && git commit -qm 'first commit'
printf 'stashed\n' >> a.txt && git stash push -q -m 'fixture stash'
git worktree add -q -b feature ../app-wt
printf 'staged\n' >> a.txt && git add a.txt
printf 'unstaged\n' >> b.txt
printf 'untracked\n' > untracked.txt
mkdir -p data node_modules/pkg && printf 'module.exports = 1;\n' > node_modules/pkg/index.js
for i in 1 2 3 4 5 6 7 8; do head -c 2097152 /dev/urandom > data/blob-$i.bin; done
cd ../app-wt
printf 'wt staged\n' >> lib/c.txt && git add lib/c.txt
printf 'wt unstaged\n' >> a.txt
printf 'wt untracked\n' > wt-untracked.txt
`;

function fixture(ids) {
  sh(L, GIT_FIXTURE);
  const island = JSON.parse(sh(L, 'svall --json island create integration').stdout).id;
  const agent = JSON.parse(sh(L, `svall --json char new --island ${island} --cwd ~/src/app-wt --name agent --claude`).stdout).id;
  const oc = JSON.parse(sh(L, `svall --json char new --island ${island} --cwd ~/src/app --name oc --opencode`).stdout).id;
  const shell = JSON.parse(sh(L, `svall --json char new --island ${island} --cwd ~/src/app --name shell`).stdout).id;
  for (const id of [agent, oc]) sh(L, `svall char wait ${id} --until idle --timeout 60`);
  const fx = { island, agent, oc, shell };
  turn(ids, fx, 'first turn on local');
  return fx;
}

// the sessions of one agent kind on a machine: Claude's transcripts by file, and OpenCode's by id, each with a count
// of its records
const held = (s, kind) => Object.fromEntries(Object.entries(kind === 'claude' ? s.sessions : s.opencode)
  .map(([k, v]) => [k, v.lines ?? v.messages]));

/**
 * One prompt to each agent through the controller's `svall`, which reaches whichever machine owns the fleet, and the
 * two records it appends to the one session that agent keeps there.
 */
function turn(ids, fx, text) {
  const owner = ctx.owner === 'remote' ? R : L;
  for (const a of AGENTS) {
    const before = held(snap(owner, ids), a.kind);
    sh(L, `svall char run ${fx[a.key]} '${text}' && svall char wait ${fx[a.key]} --until done,idle --timeout 60`);
    const after = held(snap(owner, ids), a.kind);
    const [id] = Object.keys(after);
    check(`same ${a.kind} session`, Object.keys(after).length === 1 && Object.keys(before).every((k) => k === id)
      && after[id] === (before[id] ?? 0) + 2, () => `${brief(before)} -> ${brief(after)}`);
  }
}

function snap(machine, ids) {
  const r = sh(machine, `/opt/it/node/bin/node /opt/it/machine.mjs snap${machine === R ? ` --gateway ${ids.fleet}` : ''}`);
  return JSON.parse(r.stdout);
}

// ---------------------------------------------------------------------------------------------- assertions

const withoutExcluded = (tree) => (tree ? Object.fromEntries(Object.entries(tree).filter(([k]) => !/^node_modules(\/|$)/.test(k))) : tree);

function gatewayIs(label, remote, owner, generation) {
  const rec = remote.gateway?.result?.record;
  check(`${label} gateway`, rec?.ownerMachineId === owner && rec.generation === generation && !rec.transaction,
    () => `expected ${owner} at ${generation} with no transaction, got ${brief(remote.gateway)}`);
}

function noJournals(label, local, remote) {
  check(`${label} controller journal`, local.controllerJournal === null, () => brief(local.controllerJournal));
  for (const [side, s] of [['local', local], ['remote', remote]]) {
    check(`${label} ${side} handover journal`, !s.handover?.transaction && !s.handover?.quarantined && !s.handover?.error, () => brief(s.handover));
  }
}

/** The machine that runs the fleet: its record, and every character up as the baseline had it, each agent on its session. */
function runsFleet(label, s, base, owner, generation, fx) {
  check(`${label} ownership`, s.ownership.ownerMachineId === owner && s.ownership.generation === generation && s.ownership.frozen === false,
    () => brief(s.ownership));
  const names = s.windows.map((w) => w.name);
  check(`${label} windows`, [fx.agent, fx.oc, fx.shell].every((id) => names.includes(id)), () => brief(s.windows));
  check(`${label} shell`, s.windows.find((w) => w.name === fx.shell)?.command === 'bash', () => brief(s.windows));
  check(`${label} agent processes`, s.agents.length === AGENTS.length, () => brief(s.agents));
  for (const { key, kind, resume, cwd } of AGENTS) {
    const a = s.characters.find((c) => c.id === fx[key]);
    const b = base.characters.find((c) => c.id === fx[key]);
    check(`${label} ${kind} session id`, a?.agent?.sessionId && a.agent.sessionId === b?.agent?.sessionId, () => `${a?.agent?.sessionId} vs ${b?.agent?.sessionId}`);
    check(`${label} ${kind} up`, a?.agent && ['idle', 'done'].includes(a.agent.status), () => brief(a?.agent));
    const procs = s.agents.filter((p) => p.kind === kind && p.cwd === cwd);
    check(`${label} one ${kind} process`, procs.length === 1, () => brief(s.agents));
    check(`${label} ${kind} pid`, procs[0] && a?.agent?.pid === procs[0].pid, () => `state ${a?.agent?.pid}, running ${brief(procs)}`);
    const args = procs[0]?.args ?? [];
    check(`${label} ${kind} resumed`, args.includes(resume) && args[args.indexOf(resume) + 1] === b?.agent?.sessionId, () => brief(args));
    if (kind === 'opencode') {
      // ps reads the flags right after the binary's name, as the resume's launch flags are read
      check(`${label} opencode command line`, args[0] === 'opencode' && args[1]?.startsWith('-'), () => brief(args));
      check(`${label} opencode server`, s.servers.length === 1 && s.servers[0].ppid === procs[0]?.pid, () => brief(s.servers));
      // an import lands in the terminal's folder, and never as an empty session a resume made up
      check(`${label} opencode session`, same(s.opencode[b?.agent?.sessionId], base.opencode[b?.agent?.sessionId])
        && s.opencode[b?.agent?.sessionId]?.directory === cwd && s.opencode[b?.agent?.sessionId]?.messages > 0,
      () => `${brief(s.opencode)} vs ${brief(base.opencode)}`);
    }
  }
  check(`${label} characters`, same(s.characters.map((c) => [c.id, c.name, c.cwd, c.islandId]), base.characters.map((c) => [c.id, c.name, c.cwd, c.islandId])),
    () => brief(s.characters));
  for (const repo of Object.keys(base.git)) {
    for (const k of Object.keys(base.git[repo])) check(`${label} git ${repo} ${k}`, same(s.git[repo]?.[k], base.git[repo][k]), () => `${brief(s.git[repo]?.[k])} vs ${brief(base.git[repo][k])}`);
    check(`${label} git ${repo} fsck`, s.git[repo]?.fsck === '', () => s.git[repo]?.fsck);
    check(`${label} tree ${repo}`, same(withoutExcluded(s.trees[repo]), withoutExcluded(base.trees[repo])), () => treeDiff(s.trees[repo], base.trees[repo]));
  }
  check(`${label} sessions`, same(s.sessions, base.sessions), () => `${brief(s.sessions)} vs ${brief(base.sessions)}`);
}

function treeDiff(a = {}, b = {}) {
  const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter((k) => !/^node_modules(\/|$)/.test(k));
  return keys.filter((k) => !same(a?.[k], b?.[k])).slice(0, 8).map((k) => `${k}: ${brief(a?.[k])} vs ${brief(b?.[k])}`).join('; ');
}

/** The machine the fleet is not on: fenced to the owner, and not one terminal or agent of it running. */
function holdsNothing(label, s, owner, generation) {
  check(`${label} ownership`, s.ownership.ownerMachineId === owner && s.ownership.generation === generation, () => brief(s.ownership));
  check(`${label} windows`, s.windows.every((w) => w.name === '_keep'), () => brief(s.windows));
  check(`${label} agents`, s.agents.length === 0 && s.servers.length === 0, () => brief([s.agents, s.servers]));
}

const MANIFEST_ROOTS = ['.svall/agent-profiles', '.svall/home', 'src/app', 'src/app-wt'].map((r) => `${HOME}/${r}`);

/** The preflight manifest: the four carried roots, a session for each agent, and nothing that blocks. */
function manifestIs(label, driven) {
  const pre = lines(driven.log).find((e) => e.event === 'handover.preflight')?.data;
  check(`${label} preflight`, pre && pre.blockers.length === 0, () => brief(pre?.blockers));
  check(`${label} manifest roots`, same(Object.values(pre?.names?.roots ?? {}).sort(), MANIFEST_ROOTS), () => brief(pre?.names?.roots));
  check(`${label} manifest sessions`, pre?.summary?.sessions === AGENTS.length
    && same(Object.values(pre?.names?.sessions ?? {}).sort(), AGENTS.map((a) => a.key).sort()), () => brief([pre?.summary, pre?.names?.sessions]));
  // every root and session the manifest carries was verified in full
  const verified = new Set(lines(driven.log).filter((e) => e.event === 'handover.entity' && e.data.phase === 'verify' && e.data.done === e.data.total && e.data.total > 0)
    .map((e) => e.data.id));
  const carried = [...Object.keys(pre?.names?.roots ?? {}), ...Object.keys(pre?.names?.sessions ?? {})];
  check(`${label} verified`, carried.length === MANIFEST_ROOTS.length + AGENTS.length && carried.every((id) => verified.has(id)), () => `verified ${[...verified]} of ${carried}`);
}

// ---------------------------------------------------------------------------------------------- handovers

let n = 0;
/** One handover from the controller on local, with an optional fault; returns its summary and its NDJSON. */
function drive(to, fault, at) {
  const label = `${String(++n).padStart(2, '0')}-${fault ?? 'clean'}${at ? `-${at}` : ''}-to-${to}`;
  const f = fault ? ` --fault ${fault} --at ${at}` : '';
  const r = sh(L, `mkdir -p /tmp/it && IT_LINK=${R}:7070 /opt/it/node/bin/node /opt/it/machine.mjs drive ${to}${f} --log /tmp/it/${label}.ndjson`);
  const summary = JSON.parse(r.stdout.trim().split('\n').at(-1));
  const log = sh(L, `cat /tmp/it/${label}.ndjson`).stdout;
  fs.writeFileSync(path.join(out, `${label}.ndjson`), log);
  const stderr = sh(L, `cat /tmp/it/${label}.ndjson.stderr`, { ok: false }).stdout;
  if (stderr) fs.writeFileSync(path.join(out, `${label}.stderr`), stderr);
  fs.writeFileSync(path.join(out, `${label}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
  say(`   ${label}: ${summary.result?.status ?? 'no result'} in ${summary.ms} ms${summary.trigger ? `, ${fault} at ${summary.trigger.ms} ms` : ''}${summary.retries ? `, ${summary.retries} retries` : ''}${summary.capped ? ', capped' : ''}`);
  return { label, summary, log };
}

function handoverCmd(args) {
  const r = sh(L, `svall handover ${args} --json </dev/null`, { ok: false });
  return { code: r.code, events: lines(r.stdout), text: r.stdout };
}

const ctx = { owner: 'local', generation: 0 };

/** A handover that nothing interrupts, checked end to end. */
function clean(ids, fx, to) {
  const [from, dest] = to === 'remote' ? [L, R] : [R, L];
  const destId = to === 'remote' ? ids.remote : ids.local;
  const base = snap(from, ids);
  const d = drive(to);
  check('result', d.summary.result?.status === 'complete' && d.summary.exit.code === 0, () => brief(d.summary.result));
  check('characters ok', d.summary.result?.characters?.length === 3 && d.summary.result.characters.every((c) => c.ok), () => brief(d.summary.result?.characters));
  manifestIs('clean', d);
  ctx.owner = to;
  ctx.generation += 1;
  const [l, r] = [snap(L, ids), snap(R, ids)];
  const [now, left] = dest === L ? [l, r] : [r, l];
  runsFleet(to, now, base, destId, ctx.generation, fx);
  holdsNothing(from === L ? 'local' : 'remote', left, destId, ctx.generation);
  check('fleet config', left.fleet.id === ids.fleet && now.fleet.id === ids.fleet
    && left.fleet.gatewayMachineId === ids.remote && now.fleet.gatewayMachineId === ids.remote, () => brief([left.fleet, now.fleet]));
  gatewayIs('clean', r, destId, ctx.generation);
  noJournals('clean', l, r);
  if (dest === R) check('remote excludes', !Object.keys(r.trees['src/app'] ?? {}).some((k) => k.startsWith('node_modules')), 'node_modules reached the remote');
  return { base, now };
}

function scenario(ids, fx, fault, at, to) {
  const post = POST.has(at);
  const [src, dst] = to === 'remote' ? [L, R] : [R, L];
  const [srcId, dstId] = to === 'remote' ? [ids.local, ids.remote] : [ids.remote, ids.local];
  const g = ctx.generation;
  const base = snap(src, ids);
  const agentsBefore = base.agents.map((p) => p.pid).sort();
  const untouched = (s) => same(s.agents.map((p) => p.pid).sort(), agentsBefore);
  const d = drive(to, fault, at);
  check('fault landed', d.summary.trigger !== null, () => `the ${at} boundary was never reached: ${brief(d.summary)}`);

  // where the fault left the machines, before anyone acts on it
  const [ml, mr] = [snap(L, ids), snap(R, ids)];
  const [mSrc, mDst] = src === L ? [ml, mr] : [mr, ml];
  fs.writeFileSync(path.join(out, `${d.label}.stopped.json`), `${JSON.stringify({ local: ml, remote: mr }, null, 1)}\n`);
  const rec = mr.gateway?.result?.record;
  const phase = rec?.transaction?.phase;
  say(`   stopped: gateway ${rec?.ownerMachineId === dstId ? 'destination' : 'source'} at ${rec?.generation}${phase ? ` (${phase})` : ''}; source ${mSrc.ownership.frozen ? 'frozen' : 'not frozen'}, ${mSrc.agents.length} agent(s); destination ${mDst.agents.length} agent(s)`);
  if (post) {
    check('committed', rec?.ownerMachineId === dstId && rec.generation === g + 1, () => brief(rec));
    check('source stays down', mSrc.agents.length === 0 && mSrc.servers.length === 0 && mSrc.windows.every((w) => w.name === '_keep'), () => brief([mSrc.agents, mSrc.servers, mSrc.windows]));
    // with its controller gone, nothing but a resume activates the destination
    if (at === 'commit') check('destination waits', mDst.agents.length === 0 && mDst.windows.every((w) => w.name === '_keep'), () => brief([mDst.agents, mDst.windows]));
  } else {
    check('not committed', rec?.ownerMachineId === srcId && rec.generation === g, () => brief(rec));
    check('destination not started', mDst.agents.length === 0 && mDst.windows.every((w) => w.name === '_keep'), () => brief([mDst.agents, mDst.windows]));
    if (fault === 'kill' && at === 'begin') check('Begin landed', phase === 'preparing', () => brief(rec));
    if (at === 'begin') check('source never froze', !mSrc.ownership.frozen && untouched(mSrc), () => `${brief(mSrc.ownership)} agents ${brief(mSrc.agents)} were ${agentsBefore}`);
    if (at === 'transfer' || at === 'ready') check('source frozen', mSrc.ownership.frozen === true && mSrc.agents.length === 0 && mSrc.servers.length === 0, () => brief([mSrc.ownership, mSrc.agents, mSrc.servers]));
    if (fault === 'kill' && at === 'ready') check('Ready landed', phase === 'ready-to-commit', () => brief(rec));
  }
  if (fault === 'drop') check('controller gave up', ['interrupted', 'complete', 'blocked'].includes(d.summary.result?.status) && !d.summary.capped, () => brief(d.summary));

  const status = handoverCmd('status');
  const verdict = status.events.find((e) => e.event === 'handover.status')?.data;
  say(`   status: ${verdict?.standing}, safe ${JSON.stringify(verdict?.safe)}`);
  let action;
  if (post) {
    check('status offers resume', same(verdict?.safe, ['resume']), () => brief(verdict));
    action = handoverCmd('--resume');
    check('resume completes', action.code === 0 && action.events.at(-1)?.data?.status === 'complete', () => brief(action.events.at(-1)));
    ctx.owner = to;
    ctx.generation = g + 1;
  } else {
    check('status offers abort', verdict?.safe?.includes('abort'), () => brief(verdict));
    action = handoverCmd('--abort');
    check('abort aborts', action.code === 0 && action.events.at(-1)?.data?.status === 'aborted', () => brief(action.events.at(-1)));
  }
  fs.writeFileSync(path.join(out, `${d.label}.recovery.ndjson`), `${status.text}${action.text}`);
  say(`   ${post ? 'resume' : 'abort'}: ${action.events.at(-1)?.data?.status}`);

  const [l, r] = [snap(L, ids), snap(R, ids)];
  const [owner, other] = (post ? dst : src) === L ? [l, r] : [r, l];
  const ownerId = post ? dstId : srcId;
  runsFleet(post ? 'destination' : 'source', owner, base, ownerId, ctx.generation, fx);
  holdsNothing(post ? 'source' : 'destination', other, ownerId, ctx.generation);
  gatewayIs('after', r, ownerId, ctx.generation);
  noJournals('after', l, r);
  if (at === 'begin') check('agents untouched', untouched(owner), () => `${brief(owner.agents)} were ${agentsBefore}`);
}

// ---------------------------------------------------------------------------------------------- the run

const ORDER = [
  ...['begin', 'transfer', 'ready'].flatMap((at) => [['kill', at], ['drop', at]]).map(([f, at]) => [f, at, 'remote']), ['kill', 'commit', 'remote'],
  ...['begin', 'transfer', 'ready'].flatMap((at) => [['kill', at], ['drop', at]]).map(([f, at]) => [f, at, 'local']), ['kill', 'commit', 'local'],
  ['kill', 'activate', 'remote'], ['kill', 'activate', 'local'], ['drop', 'activate', 'remote'], ['drop', 'activate', 'local'],
];

function chosen(spec = 'all') {
  if (spec === 'none') return [];
  if (spec === 'all') return ORDER;
  const want = spec.split(',');
  const known = new Set(['kill', 'drop', ...ORDER.map(([f, at]) => `${f}@${at}`)]);
  const odd = want.filter((w) => !known.has(w));
  if (odd.length) throw new Error(`unknown scenario ${odd.join(', ')}: use all, none, kill, drop or one of ${ORDER.map(([f, at]) => `${f}@${at}`).filter((x, i, a) => a.indexOf(x) === i).join(', ')}`);
  return ORDER.filter(([f, at]) => want.includes(f) || want.includes(`${f}@${at}`));
}

let code = 0;
try {
  const scenarios = chosen(o.scenarios);
  say(`logs in ${out}`);
  step('two machines', up);
  const ids = step('install on local, host add remote, host enable', install);
  say(`   fleet ${ids.fleet}; local ${ids.local}; remote ${ids.remote}`);
  const fx = step('fixture', () => fixture(ids));
  step('local -> remote', () => clean(ids, fx, 'remote'));
  step('a turn on remote', () => turn(ids, fx, 'a turn on remote'));
  step('remote -> local', () => clean(ids, fx, 'local'));
  step('a turn on local', () => turn(ids, fx, 'a turn back on local'));
  for (const [fault, at, to] of scenarios) {
    if (ctx.owner === to) step(`reposition -> ${to === 'remote' ? 'local' : 'remote'}`, () => clean(ids, fx, to === 'remote' ? 'local' : 'remote'));
    step(`${fault} at ${at}, ${to === 'remote' ? 'local -> remote' : 'remote -> local'} (${POST.has(at) ? 'post' : 'pre'}-commit)`, () => scenario(ids, fx, fault, at, to));
  }
  say('ALL PASS');
} catch (e) {
  say(`FAILED: ${e.message}`);
  code = 1;
} finally {
  for (const m of [L, R]) {
    const logs = sh(m, 'tail -n 400 ~/.svall/svalld.log ~/.local/share/svall/log/*.log 2>/dev/null', { ok: false }).stdout;
    fs.writeFileSync(path.join(out, `${m}.daemon.log`), logs);
  }
  if (!o.keep) {
    for (const m of [L, R]) docker(['rm', '-f', m]);
    docker(['network', 'rm', NET]);
  }
}
process.exitCode = code;
