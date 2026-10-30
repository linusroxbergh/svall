import { spawn } from 'node:child_process';
import type { Socket } from 'node:net';

// Once the process that handed it dirs is gone, however it ended (Ctrl-C, vitest's SIGTERM, a stopped run's SIGKILL), the
// reaper removes each dir still there, so a tmux client still starting cannot put a server in it, then ends what names one
const REAPER = `
dirs=$(cat)
left=
for d in $dirs; do [ -e "$d" ] && left="$left $d"; done
[ -n "$left" ] || exit 0
rm -rf $left
ps -axo pid=,args= | while read -r pid args; do
  for d in $left; do case "$args" in *"$d"*) kill "$pid" 2>/dev/null;; esac; done
done`;

let reaper: Socket | undefined;

/** Removes `dir` once this process is gone, if it is still there, and ends every process whose argv names it. */
export function sweepAtExit(dir: string): string {
  if (!reaper) {
    // its shell leaves it behind at once, so a stop that kills this process's tree misses it. Dirs come in on fd 3:
    // node closes a child's stdin once the child exits, which would end the list as soon as it began
    const sh = spawn('/bin/sh', ['-c', `(${REAPER}) <&3 &`], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    sh.unref();
    reaper = sh.stdio[3] as Socket;
    reaper.on('error', () => { /* a reaper that is gone has nothing to say */ });
    reaper.unref();
  }
  reaper.write(`${dir}\n`);
  return dir;
}
