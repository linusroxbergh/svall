import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';

const SPIKES = path.join(import.meta.dirname, '../scripts/spikes');
const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

test.each(['probe-claude-handover.mjs', 'probe-codex-handover.mjs', 'probe-worktree-handover.mjs'])('%s runs when it is started through a link to the checkout', (name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-spikes-'));
  made.push(dir);
  fs.symlinkSync(SPIKES, path.join(dir, 'spikes'));
  const r = spawnSync(process.execPath, [path.join(dir, 'spikes', name)], { encoding: 'utf8' });
  expect(r.stderr).toContain(`Usage: node scripts/spikes/${name}`);
  expect(r.status).toBe(2);
});
