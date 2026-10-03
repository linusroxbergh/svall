import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { CODEX_TRUST } from '../packages/svalld/src/agent-hooks.js';

const SCRIPT = fs.readFileSync(path.join(import.meta.dirname, '../scripts/desktop-install.sh'), 'utf8');
/** The script from the line of code `from` up to the one `to`, to run a part of it on its own. */
const part = (from: string, to: string): string => {
  const at = (code: string): number => {
    const i = SCRIPT.indexOf(code);
    if (i < 0) throw new Error(`desktop-install.sh no longer holds ${code}`);
    return i;
  };
  return SCRIPT.slice(at(from), at(to));
};
// the step that closes every open window before the app is replaced
const STEP = part('is_app() {', 'step "Installing to');

const dirs: string[] = [];
const procs: ChildProcess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function machine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-desktop-install-'));
  dirs.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  // a process ps names Svall, as the app's is
  fs.copyFileSync(process.execPath, path.join(bin, 'Svall'), fs.constants.COPYFILE_FICLONE);
  const log = path.join(root, 'quits');
  // records each quit's pid and whether a window quit before it is still open, then closes the window a second later
  fs.writeFileSync(path.join(bin, 'osascript'), `#!/bin/sh
pid=$(printf '%s' "$*" | sed -n 's/.*Identifier(\\([0-9]*\\)).*/\\1/p')
[ -f ${log}.refuse ] && { echo 'Not authorized to send Apple events to Svall. (-1743)' >&2; exit 1; }
open=no
[ -f ${log} ] && for p in $(cut -d' ' -f1 ${log}); do case "$(ps -p "$p" -o comm= 2>/dev/null)" in */Svall) open=yes ;; esac; done
echo "$pid $open" >> ${log}
[ -f ${log}.cancel ] || (sleep 1; kill "$pid") >/dev/null 2>&1 &
`, { mode: 0o755 });
  const window = (home: string, command = path.join(bin, 'Svall')): number => {
    const p = spawn(command, command.endsWith('Svall') ? ['-e', 'setTimeout(() => {}, 600_000)'] : ['600']);
    procs.push(p);
    fs.mkdirSync(path.join(root, home), { recursive: true });
    fs.writeFileSync(path.join(root, home, 'app.pid'), `${p.pid}\t${path.join(root, home)}\n`);
    return p.pid!;
  };
  const run = (env: Record<string, string> = {}) => spawnSync('sh', ['-c', `set -eu\nC= D= R= N=\nfail() { echo "$*" >&2; exit 1; }\nstep() { printf '%s◇%s  %s\\n' "$C" "$N" "$*"; }\nbar() { printf '%s│%s\\n' "$D" "$N"; }\n${STEP}\necho installed`], {
    env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, ...env }, encoding: 'utf8', timeout: 30_000,
  });
  const quits = (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  return { root, bin, log, window, run, quits };
}

test('asks each open window to quit by its pid, once, and the next only after it is gone', () => {
  const m = machine();
  const first = m.window('.svall-dev');
  const second = m.window('.svall-dev-work');
  // a crashed window's pid, since taken by another process
  m.window('.svall-dev-old', 'sleep');
  const r = m.run();
  expect(r.stderr).toBe('');
  expect(r.stdout).toBe('◇  Closing open windows\ninstalled\n');
  expect(m.quits()).toEqual([`${first} no`, `${second} no`]);
});

test('stops before anything is installed when a window stays open or macOS will not pass the quit on', () => {
  const m = machine();
  const pid = m.window('.svall-dev');
  fs.writeFileSync(`${m.log}.cancel`, '');
  // the wait counts from seq, cut short here
  fs.writeFileSync(path.join(m.bin, 'seq'), '#!/bin/sh\necho 1; echo 2\n', { mode: 0o755 });
  const cancelled = m.run();
  expect(cancelled.status).toBe(1);
  expect(cancelled.stdout).not.toContain('installed');
  expect(cancelled.stderr).toBe('Svall did not quit within 60 s, so nothing was installed; quit it, then run pnpm desktop:install again\n');
  expect(m.quits()).toEqual([`${pid} no`]);

  fs.writeFileSync(`${m.log}.refuse`, '');
  const refused = m.run();
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('could not ask Svall to quit, so nothing was installed');
});

// the script's own step, quiet and fail, then everything from GhosttyKit to the setup checks, run with stubbed tools
const PRELUDE = part('if [ -t 1 ] && [ -z "${NO_COLOR', 'step "Checking your Mac"');
const CHECKS = part('BUILD_GHOSTTY=', 'if [ -n "$BUILD_GHOSTTY" ]');
const CHECK_OK = 'case "$*" in *"setup --check"*) echo "│  ✓ tmux  tmux 3.5a" ;; esac';

function checks(stubs: Record<string, string>, setUp = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-desktop-install-'));
  dirs.push(root);
  const files = {
    'bin/pnpm': CHECK_OK, 'bin/git': '', 'bin/xcodebuild': '', 'bin/launchctl': '',
    'scripts/ghostty-kit.sh': '[ "$1" = current ]', 'scripts/ghostty-build.sh': '',
    ...(setUp ? { '.svall-dev/fleet.json': '', 'Library/LaunchAgents/io.github.linusroxbergh.svall.dev.svalld.plist': '', '.local/bin/svall-dev': '' } : {}),
    ...stubs,
  };
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  fs.mkdirSync(path.join(root, 'tmp'));
  return spawnSync('sh', ['-c', `set -eu\nDEST="$HOME/Applications"\nHOME_DIR="$HOME/.svall-dev"\n${PRELUDE}\n${CHECKS}\necho "build ghostty: $BUILD_GHOSTTY, setup: $SETUP"`], {
    cwd: root, env: { ...process.env, HOME: root, TMPDIR: path.join(root, 'tmp'), PATH: `${path.join(root, 'bin')}:${process.env.PATH}` }, encoding: 'utf8', timeout: 30_000,
  });
}

test('builds GhosttyKit from source when the download fails, and says why it failed', () => {
  const r = checks({ 'scripts/ghostty-kit.sh': '[ "$1" = fetch ] && echo "curl: (6) Could not resolve host: github.com" >&2; exit 1' });
  expect(r.status).toBe(0);
  expect(r.stderr).toContain('Could not resolve host');
  expect(r.stdout).toContain('◇  Terminal engine: building it from source instead');
  expect(r.stdout).toMatch(/build ghostty: 1, setup: 1\n$/);
});

test('stops before any build on a failed check or a missing tool, showing each', () => {
  const failed = checks({ 'bin/pnpm': 'case "$*" in *"setup --check"*) echo "│  ✗ agents  neither claude nor codex is on PATH"; exit 1 ;; esac' });
  expect(failed.status).toBe(1);
  expect(failed.stdout).toContain('✗ agents  neither claude nor codex is on PATH');
  expect(failed.stderr).toContain('Nothing was changed. Fix the ✗ items above');
  expect(failed.stdout).not.toContain('build ghostty:');

  const noKit = checks({ 'scripts/ghostty-kit.sh': 'exit 1', 'bin/xcodebuild': 'exit 1' });
  expect(noKit.status).toBe(1);
  expect(noKit.stderr).toContain('✗ ghostty  no GhosttyKit could be downloaded');
  expect(noKit.stderr).toContain('Nothing was changed.');
});

test("shows the end of a quiet step's log when the step fails", () => {
  const r = checks({ 'bin/pnpm': '[ "$1" = install ] && { echo "ERR_PNPM_FETCH_404 left-pad"; exit 1; }; exit 0' });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('ERR_PNPM_FETCH_404 left-pad');
  expect(r.stderr).toContain('pnpm install --silent failed; the whole log is');
});

test('sets up again only when a check asks for svall setup', () => {
  expect(checks({}, true).stdout).toMatch(/build ghostty: , setup: \n$/);
  const stale = 'case "$*" in *"setup --check"*) echo "│  ! hooks  missing or out of date: run svall-dev setup" ;; esac';
  const asked = checks({ 'bin/pnpm': stale }, true);
  expect(asked.stdout).toMatch(/build ghostty: , setup: 1\n$/);
  expect(asked.stdout).toContain('│  → hooks  out of date, will be updated after the build');
  expect(asked.stdout).not.toContain('run svall-dev setup');
  expect(checks({ 'bin/pnpm': stale }).stdout).toContain('│  → hooks  will be set up after the build');
});

// the install and setup steps, run with stubbed tools on a machine that has an older Svall Dev at `old`
function install(stubs: Record<string, string>, old = 'Applications/Svall Dev.app') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-desktop-install-'));
  dirs.push(root);
  for (const [file, body] of Object.entries({ 'bin/launchctl': '', ...stubs })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  for (const [app, build] of [[old, 'old'], ['apps/desktop/mac/build/Svall Dev.app', 'new']]) {
    fs.mkdirSync(path.join(root, app, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(root, app, 'Contents/build'), build);
  }
  fs.mkdirSync(path.join(root, 'tmp'));
  const r = spawnSync('sh', ['-c', `set -eu\nDEST="$HOME/Applications"\nSETUP=1\n${PRELUDE}\n${part('step "Installing to', 'step "$(pnpm')}`], {
    cwd: root, env: { ...process.env, HOME: root, TMPDIR: path.join(root, 'tmp'), PATH: `${path.join(root, 'bin')}:${process.env.PATH}` }, encoding: 'utf8', timeout: 30_000,
  });
  const installed = (): string | undefined => {
    try { return fs.readFileSync(path.join(root, 'Applications/Svall Dev.app/Contents/build'), 'utf8'); } catch { return undefined; }
  };
  return { r, root, installed };
}

test('replaces the installed app only once the new copy is whole', () => {
  const ok = install({ 'bin/pnpm': '' });
  expect(ok.r.status).toBe(0);
  expect(ok.installed()).toBe('new');
  expect(fs.readdirSync(path.join(ok.root, 'Applications'))).toEqual(['Svall Dev.app']);

  const full = install({ 'bin/pnpm': '', 'bin/ditto': 'mkdir -p "$2"; echo "ditto: No space left on device" >&2; exit 1' });
  expect(full.r.status).toBe(1);
  expect(full.r.stderr).toContain('No space left on device');
  expect(full.installed()).toBe('old');
  expect(fs.readdirSync(path.join(full.root, 'Applications'))).toEqual(['Svall Dev.app']);

  // a copy a killed install left behind is not merged into the new one
  const killed = install({ 'bin/pnpm': '', 'Applications/.Svall Dev.app.new/Contents/stale': '' });
  expect(killed.r.status).toBe(0);
  expect(fs.readdirSync(path.join(killed.root, 'Applications/Svall Dev.app/Contents'))).toEqual(['build']);
});

test('never takes the installed app apart in place, and says so when macOS refuses to move it', () => {
  // an rm of the installed app that stops partway, as on a ^C
  const halfRm = install({ 'bin/pnpm': '', 'bin/rm': 'for a; do case "$a" in */"Svall Dev.app") /bin/rm "$a/Contents/build"; exit 1 ;; esac; done; exec /bin/rm "$@"' });
  expect(halfRm.r.status).toBe(0);
  expect(halfRm.installed()).toBe('new');

  const refused = install({ 'bin/pnpm': '', 'bin/mv': 'case "$1" in */"Svall Dev.app") echo "mv: Operation not permitted" >&2; exit 1 ;; esac; exec /bin/mv "$@"' });
  expect(refused.r.status).toBe(1);
  expect(refused.r.stderr).toContain('could not replace');
  expect(refused.installed()).toBe('old');

  // the old app goes back when the new one cannot move in, and a run that stopped between the moves is undone first
  const stuck = install({ 'bin/pnpm': '', 'bin/mv': 'case "$1" in *.new) exit 1 ;; esac; exec /bin/mv "$@"' });
  expect(stuck.r.status).toBe(1);
  expect(stuck.installed()).toBe('old');
  const stopped = install({ 'bin/pnpm': '', 'bin/ditto': 'exit 1' }, 'Applications/.Svall Dev.app.old');
  expect(stopped.r.status).toBe(1);
  expect(stopped.installed()).toBe('old');
});

test("shows setup's warnings and Codex's ask to trust the hooks it rewrote, and nothing else of its output", () => {
  const lines = ['hook script -> /h', '! path  ~/.local/bin is not on PATH', CODEX_TRUST];
  const r = install({ 'bin/pnpm': `[ "$2" = svall ] && printf '%s\\n' ${lines.map((l) => `'${l}'`).join(' ')}` }).r;
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(`│  ! path  ~/.local/bin is not on PATH\n│  ${CODEX_TRUST}`);
  expect(r.stdout).not.toContain('hook script');
});
