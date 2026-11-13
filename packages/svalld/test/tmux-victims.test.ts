import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Tmux } from '../src/tmux/tmux.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

// panes 41 and 42 under the tmux server 10, 43 under 41 and 44 under 43; 50 is the daemon. 43 named itself with parentheses
const PROCS: [number, number, string][] = [[1, 0, 'systemd'], [10, 1, 'tmux: server'], [41, 10, 'bash'], [42, 10, 'sh'], [43, 41, 'x) S 9 (y'], [44, 43, 'node'], [50, 1, 'svalld']];

/** A tmux that opens a window on pane process 41 and lists panes 41 and 42, 41 again as a viewer's session links its window, and a /proc of PROCS. */
function machine(): { tmux: Tmux; marked(): number[] } {
  const root = makeHome();
  const proc = path.join(root, 'proc');
  for (const [pid, ppid, comm] of PROCS) {
    fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
    fs.writeFileSync(path.join(proc, String(pid), 'stat'), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560\n`);
    fs.writeFileSync(path.join(proc, String(pid), 'oom_score_adj'), '0\n');
  }
  fs.writeFileSync(path.join(proc, 'stat'), 'cpu 1 2 3\n');
  const binary = path.join(root, 'tmux');
  fs.writeFileSync(binary, "#!/bin/sh\ncase \"$*\" in\n  *new-window*) echo '@3 %3 41' ;;\n  *list-panes*) printf '41\\n42\\n41\\n' ;;\n  *) exit 1 ;;\nesac\n", { mode: 0o755 });
  return {
    tmux: new Tmux(path.join(root, 'sock'), path.join(root, 'tmux.conf'), binary, proc),
    marked: () => PROCS.map(([pid]) => pid).filter((pid) => fs.readFileSync(path.join(proc, String(pid), 'oom_score_adj'), 'utf8').trim() === '500'),
  };
}

async function on<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const was = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...was, value: platform });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', was); }
}

describe('the processes the kernel stops first at the memory limit', () => {
  it('are a new window\'s pane process on Linux, and none elsewhere', async () => {
    const linux = machine();
    await on('linux', () => linux.tmux.newWindow('c_a', '/', {}));
    expect(linux.marked()).toEqual([41]);
    const mac = machine();
    await on('darwin', () => mac.tmux.newWindow('c_a', '/', {}));
    expect(mac.marked()).toEqual([]);
  });

  it('are every pane\'s processes and all that runs under them on Linux, never tmux or the daemon, and none elsewhere', async () => {
    const linux = machine();
    await on('linux', () => linux.tmux.preferPanes());
    expect(linux.marked()).toEqual([41, 42, 43, 44]);
    const mac = machine();
    await on('darwin', () => mac.tmux.preferPanes());
    expect(mac.marked()).toEqual([]);
  });

  it('are none while no tmux server answers', async () => {
    const m = machine();
    const gone = new Tmux(m.tmux.socket, '/dev/null', '/usr/bin/false', path.join(path.dirname(m.tmux.binary), 'proc'));
    await on('linux', () => gone.preferPanes());
    expect(m.marked()).toEqual([]);
  });
});
