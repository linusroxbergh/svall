import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { userPaths } from '@svall/svalld/paths';
import { OTHER_SHIM, variantOf } from '@svall/svalld/profile';
import { variant } from '@svall/svalld/runtime';

// a robot's agent types `svall` whichever build runs its fleet, so the release hands a Svall Dev fleet's runs to
// `svall-dev`; Svall Dev answers to `svall` only while no release is installed, so it has none to hand on
export const handoffTarget = (env: NodeJS.ProcessEnv, shimDir: string): string | undefined =>
  variant === 'release' && env.SVALL_HOME && variantOf(env.SVALL_HOME) === 'dev' ? path.join(shimDir, OTHER_SHIM) : undefined;

export function handoff(argv: string[], program: Command): void {
  // a release robot's $SVALL_HOME is not Svall Dev's to touch, so `svall-dev` there works on its own fleets
  if (variant === 'dev' && process.env.SVALL_HOME && variantOf(process.env.SVALL_HOME) === 'release') { delete process.env.SVALL_HOME; return; }
  // -p or a profile in a command's place beats $SVALL_HOME: a run that names its fleet is this build's to resolve; after `--` it is text
  const args = argv.slice(2);
  const end = args.indexOf('--');
  const head = args.slice(0, end < 0 ? args.length : end);
  if (head.some((a) => a.startsWith('-p') || a === '--profile' || a.startsWith('--profile='))) return;
  const first = head.find((a, i) => !a.startsWith('-') && head[i - 1] !== '--host');
  if (first !== undefined && first !== 'help' && !program.commands.some((c) => c.name() === first || c.aliases().includes(first))) return;
  const other = handoffTarget(process.env, userPaths().shimDir);
  if (!other) return;
  // a run handed over once is never handed on again
  if (process.env.SVALL_HANDOFF || !fs.existsSync(other)) throw new Error(`${process.env.SVALL_HOME} belongs to the other Svall build, which is not installed`);
  const r = spawnSync(other, argv.slice(2), { stdio: 'inherit', env: { ...process.env, SVALL_HANDOFF: '1' } });
  process.exit(r.status ?? 1);
}
