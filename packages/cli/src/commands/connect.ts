import { Command } from 'commander';
import { runConnect, type ConnectEvent } from '../controller/connect.js';
import { MachineRegistry } from '../controller/registry.js';
import { closeMastersOnSignal, SshMaster } from '../controller/ssh.js';

/**
 * What tells this helper to let go: the controller closed its input. A signal ends it at once, even
 * mid-open, and takes its masters with it.
 */
function shutdown(): { stopped: Promise<void>; release: () => void } {
  let done!: () => void;
  const stopped = new Promise<void>((resolve) => { done = () => { resolve(); }; });
  closeMastersOnSignal();
  const held: [NodeJS.EventEmitter, string][] = [
    [process.stdin, 'end'], [process.stdin, 'close'], [process.stdin, 'error'],
  ];
  for (const [target, event] of held) target.on(event, done);
  process.stdin.resume();
  return {
    stopped,
    release: () => {
      for (const [target, event] of held) target.removeListener(event, done);
      process.stdin.pause();
    },
  };
}

const waitOr = (ms: number, stopped: Promise<void>): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  void stopped.then(() => { clearTimeout(timer); resolve(); });
});

export function connectCommand(home: () => string, profile: () => string | undefined): Command {
  return new Command('connect')
    .description('hold the connection to whichever machine owns this fleet, one JSON object per line')
    .action(async () => {
      const { stopped, release } = shutdown();
      try {
        process.exitCode = await runConnect({
          fleetHome: home(),
          profile: profile(),
          emit: (event: ConnectEvent) => { process.stdout.write(`${JSON.stringify(event)}\n`); },
          log: (line) => { process.stderr.write(`svall connect: ${line}\n`); },
          loadRegistry: () => MachineRegistry.load(),
          openMaster: (destination) => SshMaster.open({ destination }),
          stopped,
          sleep: (ms) => waitOr(ms, stopped),
          now: () => new Date(),
        });
      } finally {
        release();
      }
    });
}
