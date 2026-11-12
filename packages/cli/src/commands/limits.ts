import os from 'node:os';
import { Command, Option } from 'commander';
import type { Limits, LimitsReport } from '@svall/protocol';
import { gb, readLimits, setLimits, type LimitsTarget } from '@svall/svalld/linux/limits';
import { realRun } from '@svall/svalld/linux/service';
import { unitDirOf } from '@svall/svalld/linux/setup';
import { resolvePaths } from '@svall/svalld/paths';
import { Tmux } from '@svall/svalld/tmux';
import { Client, withClient } from '../client.js';
import { limitsLine, parseCpus, parseLimits, parseMemory, sizeWords, type LimitsAsk, type LimitsChoice } from '../controller/limits.js';
import { printResult } from '../format.js';
import { ask } from '../prompt.js';
import type { Target } from '../target.js';

type SetFlags = { cpus?: string; memory?: string; none?: boolean };

/** What `--cpus`, `--memory` and `--none` ask for; undefined with none of them. */
export function flagLimits(o: SetFlags): Limits | undefined {
  if (o.none && (o.cpus || o.memory)) throw new Error('--none goes with neither --cpus nor --memory');
  if (o.none) return {};
  if (!o.cpus && !o.memory) return undefined;
  return { ...(o.cpus && { cpus: parseCpus(o.cpus) }), ...(o.memory && { memoryMb: parseMemory(o.memory) }) };
}

const setFlags = (cmd: Command): Command => cmd
  .option('--cpus <n>', 'the cores the fleet may use')
  .option('--memory <amount>', 'the memory it may use, such as 8G')
  .option('--none', 'no limit');

/** `--limits` and `--no-limits` of a command that connects a machine. */
export const connectFlags = (cmd: Command): Command => cmd
  .addOption(new Option('--limits <cores,memory>', 'what the fleet may use of the machine, such as 11,93G, set without asking'))
  .addOption(new Option('--no-limits', 'leave the fleet all of the machine, without asking'));

const suggestion = (r: LimitsReport): string => [r.suggested.cpus && `${r.suggested.cpus} cores`, r.suggested.memoryMb && gb(r.suggested.memoryMb)].filter(Boolean).join(', ');

/** Asks in a terminal with the default filled in: Return takes it, `none` leaves no limit, `11,93G` names another. */
export const askLimits = (question: (q: string) => Promise<string> = ask): LimitsAsk => async ({ name, report }) => {
  const offered = suggestion(report);
  if (!offered) return undefined;
  for (;;) {
    const said = (await question(`${name} has ${sizeWords(report)}. This fleet may use [${offered}], or none: `)).trim();
    if (!said) return report.suggested;
    if (/^none$/i.test(said)) return {};
    try { return parseLimits(said); } catch (e) { process.stderr.write(`${(e as Error).message}\n`); }
  }
};

/** What a connect's flags and terminal say of its limits. */
export const connectChoice = (o: { limits?: string | false }, askable: boolean): LimitsChoice => ({
  ...(o.limits === false ? { limits: {} } : o.limits !== undefined && { limits: parseLimits(o.limits) }),
  ...(askable && { ask: askLimits() }),
});

/** The flags that carry a connect's answer to the machine that runs it for this one. */
export const connectArgs = (o: { limits?: string | false }): string[] => (o.limits === false ? ['--no-limits'] : o.limits !== undefined ? ['--limits', o.limits] : []);

const here = (t: Target): LimitsTarget => {
  const paths = resolvePaths(t.home);
  return { fleet: t.name, home: t.home, unitDir: unitDirOf(os.homedir()), run: realRun, tmuxPid: () => new Tmux(paths.tmuxSock, paths.tmuxConf).serverPid() };
};

/** `svall fleet limits`: what this fleet may use of this machine, read and set here. */
export function fleetLimits(target: () => Target, json: () => boolean): Command {
  const linux = (): void => { if (process.platform !== 'linux') throw new Error('a limit is for a Linux machine'); };
  const cmd = new Command('limits').description('the cores and memory this fleet may use of this Linux machine').action(async () => {
    linux();
    const r = await readLimits(here(target()));
    printResult(r, json(), () => limitsLine(r, 'this machine'));
  });
  setFlags(cmd.command('set').description('set them on the fleet\'s unit as it runs; nothing restarts')).action(async (o: SetFlags) => {
    linux();
    const limits = flagLimits(o);
    if (!limits) throw new Error('name --cpus, --memory or --none');
    const r = await setLimits(limits, here(target()));
    printResult(r, json(), () => limitsLine(r, 'this machine'));
  });
  return cmd;
}

/** `svall host limits <name>`: the same of any Linux machine of the fleet, through this fleet's daemon. */
export function hostLimits(target: () => Target, json: () => boolean): Command {
  return setFlags(new Command('limits').description('the cores and memory the fleet may use of a Linux machine, shown, or set with --cpus, --memory or --none')
    .argument('<name>', 'the machine, as svall host list names it'))
    .action(async (name: string, o: SetFlags) => {
      const limits = flagLimits(o);
      const r = await withClient(() => Client.connect(target().home), async (c) => {
        const machine = (await c.call('machines.list', {})).machines.find((m) => m.name === name)?.id;
        if (!machine) throw new Error(`no machine ${name} in this fleet`);
        return limits ? c.call('machines.setLimits', { machine, cpus: limits.cpus ?? null, memoryMb: limits.memoryMb ?? null }) : c.call('machines.limits', { machine });
      });
      printResult(r, json(), () => limitsLine(r, name));
    });
}
