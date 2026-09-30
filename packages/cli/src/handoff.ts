import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { userPaths } from '@svall/svalld/paths';
import { OTHER_SHIM, variantOf } from '@svall/svalld/profile';
import { variant } from '@svall/svalld/runtime';

// a character's agent types `svall` whichever build runs its fleet; the fleet's own build answers it
export const handoffTarget = (env: NodeJS.ProcessEnv, shimDir: string): string | undefined => {
  const owner = env.SVALL_HOME ? variantOf(env.SVALL_HOME) : undefined;
  return owner && owner !== variant ? path.join(shimDir, OTHER_SHIM) : undefined;
};

export function handoff(argv: string[]): void {
  const other = handoffTarget(process.env, userPaths().shimDir);
  if (!other) return;
  // Svall Dev's own `svall`, with no release installed, would hand the run straight back
  if (process.env.SVALL_HANDOFF || !fs.existsSync(other)) throw new Error(`${process.env.SVALL_HOME} belongs to the other Svall build, which is not installed`);
  const r = spawnSync(other, argv.slice(2), { stdio: 'inherit', env: { ...process.env, SVALL_HANDOFF: '1' } });
  process.exit(r.status ?? 1);
}
