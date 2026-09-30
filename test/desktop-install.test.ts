import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';

// the step that closes every open window before the app is replaced, run on its own
const SCRIPT = fs.readFileSync(path.join(import.meta.dirname, '../scripts/desktop-install.sh'), 'utf8');
const STEP = SCRIPT.slice(SCRIPT.indexOf("# app.pid outlives a crash"), SCRIPT.indexOf('step "Installing to'));

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
const PRELUDE = SCRIPT.slice(SCRIPT.indexOf('# one column'), SCRIPT.indexOf('step "Checking your Mac"'));
const CHECKS = SCRIPT.slice(SCRIPT.indexOf('# GhosttyKit is downloaded'), SCRIPT.indexOf('if [ -n "$BUILD_GHOSTTY" ]'));
const CHECK_OK = 'case "$*" in *"setup --check"*) echo "│  ✓ tmux  tmux 3.5a" ;; esac';

function checks(stubs: Record<string, string>, setUp = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-desktop-install-'));
  dirs.push(root);
  const files = {
    'bin/pnpm': CHECK_OK, 'bin/git': '', 'bin/xcodebuild': '', 'bin/launchctl': '',
    'scripts/ghostty-kit.sh': '[ "$1" = current ]', 'scripts/ghostty-build.sh': '',
    ...(setUp ? { '.svall-dev/config.json': '', 'Library/LaunchAgents/io.github.linusroxbergh.svall.dev.svalld.plist': '', '.local/bin/svall-dev': '' } : {}),
    ...stubs,
  };
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  fs.mkdirSync(path.join(root, 'tmp'));
  return spawnSync('sh', ['-c', `set -eu\nHOME_DIR="$HOME/.svall-dev"\n${PRELUDE}\n${CHECKS}\necho "build ghostty: $BUILD_GHOSTTY, setup: $SETUP"`], {
    cwd: root, env: { ...process.env, HOME: root, TMPDIR: path.join(root, 'tmp'), PATH: `${path.join(root, 'bin')}:${process.env.PATH}` }, encoding: 'utf8', timeout: 30_000,
  });
}

test('builds GhosttyKit from source when the download fails, and says why it failed', () => {
  const r = checks({ 'scripts/ghostty-kit.sh': '[ "$1" = fetch ] && echo "gh: not signed in" >&2; exit 1' });
  expect(r.status).toBe(0);
  expect(r.stderr).toContain('gh: not signed in');
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
