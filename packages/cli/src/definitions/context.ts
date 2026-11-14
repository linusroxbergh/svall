import type { Command } from 'commander';

const repeat = (v: string, acc: string[]) => [...acc, v];

export function contextOptions(cmd: Command): Command {
  return cmd
    .option('--context <spec>', '<ref>[ label]..., repeatable; each URL or absolute path starts a new item; replaces the manual items', repeat, [] as string[])
    .option('--pin <ref>', 'mark an item to read before starting, repeatable', repeat, [] as string[])
    .option('--unpin <ref>', 'unmark a pinned item, repeatable', repeat, [] as string[])
    .option('--drop <ref>', 'remove an item, repeatable', repeat, [] as string[])
    .option('--instructions <text>', 'agent-only instructions');
}
