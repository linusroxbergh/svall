import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';

const ROOT = path.join(import.meta.dirname, '..');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

// a docker that records each command and cannot make a network or copy into a machine, so a run stops at its first step
function host() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-bench-names-'));
  dirs.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(root, 'docker.log');
  fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
echo "$*" >> '${log}'
case "$1 $2" in
  'info --format') case "$3" in '{{.Architecture}}') echo aarch64 ;; *) echo 2 2053644288 aarch64 ;; esac ;;
  'network create' | cp\\ *) exit 1 ;;
esac
exit 0
`, { mode: 0o755 });
  const archive = path.join(root, 'svall-companion-0-linux-arm64.tar.gz');
  fs.writeFileSync(archive, '');
  const run = (script: string, ...args: string[]) => spawnSync(script.endsWith('.sh') ? 'bash' : process.execPath, [path.join(ROOT, script), ...args], {
    env: { ...process.env, PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}` }, encoding: 'utf8', timeout: 60_000,
  });
  const removed = (): string[] => fs.readFileSync(log, 'utf8').split('\n').filter((l) => /^(rm -f|network rm) /.test(l));
  return { root, archive, run, removed };
}

test('the benchmark makes and removes machines of its own, never the integration run\'s', () => {
  const h = host();
  expect(h.run('scripts/bench/handover.sh', '--archive', h.archive, '--out', path.join(h.root, 'setup'), '--repos', 'none').status).not.toBe(0);
  expect(h.run('scripts/bench/handover.sh', '--reuse', '--out', path.join(h.root, 'reuse'), '--repos', 'none').status).not.toBe(0);
  const mine = ['rm -f svall-bench-local', 'rm -f svall-bench-remote', 'network rm svall-bench-it'];
  expect(h.removed()).toEqual([...mine, ...mine]);
});

test('the integration run keeps its own names unless given a prefix', () => {
  const h = host();
  expect(h.run('scripts/integration/fleet-handover.mjs', '--archive', h.archive, '--out', path.join(h.root, 'one')).status).not.toBe(0);
  expect(h.run('scripts/integration/fleet-handover.mjs', '--archive', h.archive, '--out', path.join(h.root, 'two'), '--prefix', 'side').status).not.toBe(0);
  const named = (p: string) => [`rm -f ${p}-local`, `rm -f ${p}-remote`, `network rm ${p}-it`];
  // each run clears the names before it starts and removes its machines once it ends
  expect(h.removed()).toEqual([...named('svall'), ...named('svall'), ...named('side'), ...named('side')]);
});
