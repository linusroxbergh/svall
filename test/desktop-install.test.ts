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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archi-desktop-install-'));
  dirs.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  // a process ps names Archipelago, as the app's is
  fs.copyFileSync(process.execPath, path.join(bin, 'Archipelago'), fs.constants.COPYFILE_FICLONE);
  const log = path.join(root, 'quits');
  // records each quit's pid and whether a window quit before it is still open, then closes the window a second later
  fs.writeFileSync(path.join(bin, 'osascript'), `#!/bin/sh
pid=$(printf '%s' "$*" | sed -n 's/.*Identifier(\\([0-9]*\\)).*/\\1/p')
[ -f ${log}.refuse ] && { echo 'Not authorized to send Apple events to Archipelago. (-1743)' >&2; exit 1; }
open=no
[ -f ${log} ] && for p in $(cut -d' ' -f1 ${log}); do case "$(ps -p "$p" -o comm= 2>/dev/null)" in */Archipelago) open=yes ;; esac; done
echo "$pid $open" >> ${log}
[ -f ${log}.cancel ] || (sleep 1; kill "$pid") >/dev/null 2>&1 &
`, { mode: 0o755 });
  const window = (home: string, command = path.join(bin, 'Archipelago')): number => {
    const p = spawn(command, command.endsWith('Archipelago') ? ['-e', 'setTimeout(() => {}, 600_000)'] : ['600']);
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
  const first = m.window('.archipelago');
  const second = m.window('.archipelago-work');
  // a crashed window's pid, since taken by another process
  m.window('.archipelago-old', 'sleep');
  const r = m.run();
  expect(r.stderr).toBe('');
  expect(r.stdout).toBe('◇  Closing open windows\ninstalled\n');
  expect(m.quits()).toEqual([`${first} no`, `${second} no`]);
});

test('stops before anything is installed when a window stays open or macOS will not pass the quit on', () => {
  const m = machine();
  const pid = m.window('.archipelago');
  fs.writeFileSync(`${m.log}.cancel`, '');
  // the wait counts from seq, cut short here
  fs.writeFileSync(path.join(m.bin, 'seq'), '#!/bin/sh\necho 1; echo 2\n', { mode: 0o755 });
  const cancelled = m.run();
  expect(cancelled.status).toBe(1);
  expect(cancelled.stdout).not.toContain('installed');
  expect(cancelled.stderr).toBe('Archipelago did not quit within 60 s, so nothing was installed; quit it, then run pnpm desktop:install again\n');
  expect(m.quits()).toEqual([`${pid} no`]);

  fs.writeFileSync(`${m.log}.refuse`, '');
  const refused = m.run();
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('could not ask Archipelago to quit, so nothing was installed');
});
